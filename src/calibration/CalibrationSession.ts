/**
 * Calibration Session
 *
 * One continuous recording while the whole sync group plays a long click
 * track. The user walks to each room and taps "measure here"; the first room
 * is measured again at the end so clock drift can be removed. All rooms are
 * compared inside the same recording on the same track timeline, so the
 * (unknown) delay between "play" and sound cancels out. See ClickAnalyzer.
 *
 * Any room can be re-measured at any time; a new measurement only replaces the
 * old one if it actually heard clicks.
 */

import { MicRecorder } from './MicRecorder';
import { analyzeRooms, detectClicks, indexClicks, qualityWarnings, MAX_NORMAL_WIDTH_MS } from './ClickAnalyzer';
import type { DetectedClick, RoomAnalysis } from './ClickAnalyzer';
import type { CalibrationConfig, CalibrationResult } from '../types';
import { DEFAULT_CALIBRATION_CONFIG } from '../types';
import { maClient, resolveClickTrackUrl, getDevServerInfo } from '../ma-client';
import { findDelaySetting, suggestValue } from '../sync-push/delaySettings';
import { MuteController } from './muting';

export interface CalibrationRoom {
  playerId: string;
  name: string;
  /** Mute state before calibration; restored afterwards */
  muted?: boolean;
}

export type CalibrationEventType =
  | 'started'
  | 'playback_started'
  | 'clicks_heard'
  | 'room_measuring'
  | 'room_progress'
  | 'room_measured'
  | 'mute_problems'
  | 'analyzing'
  | 'completed'
  | 'error';

export interface CalibrationEvent {
  type: CalibrationEventType;
  data?: unknown;
}

/** Why nothing may be audible yet: did MA fetch the track, and what does MA say the player is doing */
export interface PlaybackDiagnostics {
  /** Times Music Assistant requested the click track from this computer; null if unknown */
  trackRequests: number | null;
  lastRequestAgoS: number | null;
  lastRequestIp: string;
  playbackState: string | null;
  playerName: string;
}

/** What was heard in one room, available right after it is measured */
export interface RoomReading {
  playerId: string;
  clicks: number;
  /** Arrival relative to the reference room (ms); null if it can't be computed yet */
  arrivalMs: number | null;
  spreadMs: number | null;
  warnings: string[];
}

type CalibrationEventCallback = (event: CalibrationEvent) => void;

export type MeasurementKind = 'primary' | 'closing';

/** Seconds of settling time after the other players are muted before clicks count */
const GUARD_S = 1.5;
/** A room's measurement ends as soon as it is stable, but never before this many seconds... */
const MIN_WINDOW_S = 6;
/** ...and never goes on longer than this */
const MAX_WINDOW_S = 15;
/** Sendspin/MA can take a while to start the stream; give up waiting after this */
const HEAR_TIMEOUT_S = 40;
interface Measurement {
  playerId: string;
  kind: MeasurementKind;
  startTime: number;
  endTime: number;
  clicks: DetectedClick[];
}

export class CalibrationSession {
  private recorder = new MicRecorder();
  private config: CalibrationConfig;
  private eventCallback: CalibrationEventCallback | null = null;
  private liveTimer: ReturnType<typeof setInterval> | null = null;
  private windowTimer: ReturnType<typeof setInterval> | null = null;
  private measurements: Measurement[] = [];
  private playing = false;
  private measuring = false;
  private isRunning = false;
  private heardTimes = new Set<number>();
  private lastHeardCount = 0;
  private mutes: MuteController;
  private diag: PlaybackDiagnostics | null = null;
  private latestClick: { at: number; snr: number } | null = null;
  private stopDiagnostics: (() => void) | null = null;

  private queueId: string;
  private rooms: CalibrationRoom[];
  /** Group members that aren't measured but play along; muted during every measurement */
  private others: CalibrationRoom[];
  private serverUrl: string;

  /**
   * @param queueId Player or sync-group leader the track is played on (the whole group plays it)
   * @param rooms Rooms to measure, in order; the first is the reference
   */
  constructor(
    queueId: string,
    rooms: CalibrationRoom[],
    serverUrl: string,
    config?: Partial<CalibrationConfig>,
    others: CalibrationRoom[] = []
  ) {
    this.queueId = queueId;
    this.rooms = rooms;
    this.others = others;
    this.mutes = new MuteController([...rooms, ...others], (problems) =>
      this.emit({ type: 'mute_problems', data: problems })
    );
    this.serverUrl = serverUrl;
    this.config = { ...DEFAULT_CALIBRATION_CONFIG, ...config };
  }

  /**
   * Track length. It doesn't have to play in full (it stops at Finish), so be generous:
   * room for startup, every room plus the closing check, and several retries.
   */
  get trackSeconds(): number {
    return Math.min(300, 100 + (this.rooms.length + 1) * 40);
  }

  async start(callback: CalibrationEventCallback): Promise<void> {
    if (this.isRunning) throw new Error('Calibration already running');
    this.eventCallback = callback;
    this.isRunning = true;
    this.measurements = [];
    this.heardTimes.clear();

    try {
      await this.recorder.start();
      this.emit({ type: 'started' });

      // Let the mic settle so the noise floor is recorded before the first click
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Plain-HTTP URL on this machine's LAN IP (served by the dev server) so MA can fetch it
      const clickTrackUrl = await resolveClickTrackUrl(this.serverUrl, this.trackSeconds);

      await maClient.playMedia(this.queueId, clickTrackUrl, 'replace');
      this.playing = true;
      this.emit({ type: 'playback_started', data: { url: clickTrackUrl } });

      this.startLiveDetection();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Calibration failed';
      this.emit({ type: 'error', data: message });
      await this.cleanup();
      throw error;
    }
  }

  /**
   * Begin the measurement window for a room (the user is standing there now).
   * Every other room is muted for the window so only this player is heard
   * (speakers sharing a room play the same clicks and can't be told apart),
   * then mute states are restored. Measuring a room again replaces the earlier
   * sample, but only if the new one heard clicks.
   */
  async measureRoom(playerId: string, kind: MeasurementKind = 'primary'): Promise<void> {
    if (!this.isRunning || this.windowTimer || this.measuring) return;
    this.measuring = true;
    this.emit({ type: 'room_measuring', data: { playerId, kind } });

    await this.applyMutes(playerId);
    if (!this.isRunning) {
      // Cancelled while muting: don't leave the players muted
      await this.restoreMutes();
      return;
    }

    const startTime = this.recorder.elapsed + GUARD_S;
    let finalizing = false;
    // Check once a second; stop as soon as the clicks agree with each other
    this.windowTimer = setInterval(async () => {
      if (!this.isRunning || finalizing) return;
      const length = Math.min(this.recorder.elapsed - startTime, MAX_WINDOW_S);
      if (length < 1) return;
      const endTime = startTime + length;
      const clicks = this.clicksBetween(startTime, endTime);
      this.emit({ type: 'room_progress', data: { playerId, kind, clicks: clicks.length } });
      if (!(length >= MAX_WINDOW_S || (length >= MIN_WINDOW_S && this.isStable(clicks)))) return;

      finalizing = true;
      if (this.windowTimer) clearInterval(this.windowTimer);
      this.windowTimer = null;
      await this.restoreMutes();
      if (clicks.length > 0) {
        this.measurements = this.measurements.filter((m) => !(m.playerId === playerId && m.kind === kind));
        this.measurements.push({ playerId, kind, startTime, endTime, clicks });
      }
      this.measuring = false;
      this.emit({
        type: 'room_measured',
        data: { playerId, kind, clicks: clicks.length, readings: this.readings() },
      });
    }, 1000);
  }

  private clicksBetween(startTime: number, endTime: number): DetectedClick[] {
    const samples = this.recorder.getSamples(startTime - 0.3, endTime + 0.3);
    return detectClicks(samples, this.recorder.sampleRate, this.config.frequencies, startTime - 0.3).filter(
      (c) => c.time >= startTime && c.time <= endTime
    );
  }

  /**
   * Enough clicks that agree with each other (spread between clicks under ~1 ms), or a few more
   * that agree a little less. Clicks come one per second, so this takes about 6-8 s when the
   * signal is clean and longer when it is weak.
   */
  private isStable(clicks: DetectedClick[]): boolean {
    const { clicks: indexed } = indexClicks(clicks, this.config.frequencies.length, this.config.clickIntervalMs / 1000);
    if (indexed.length < 6) return false;
    const res = indexed.map((c) => c.residual * 1000).sort((a, b) => a - b);
    const med = res[Math.floor(res.length / 2)];
    const dev = res.map((r) => Math.abs(r - med)).sort((a, b) => a - b);
    const spread = 1.4826 * dev[Math.floor(dev.length / 2)];
    return spread < 1 || (indexed.length >= 8 && spread < 2.5);
  }

  getLevel(): number {
    return this.recorder.level;
  }

  /** Seconds of recording left before the track (or buffer) runs out */
  get remainingSeconds(): number {
    return Math.max(0, Math.min(this.trackSeconds, MicRecorder.MAX_SECONDS) - this.recorder.elapsed);
  }

  /** Combine everything measured so far into the final per-room results. */
  async finish(): Promise<void> {
    if (!this.isRunning) return;
    this.stopTimers();
    this.emit({ type: 'analyzing' });
    // Let the UI paint the spinner before the analysis
    await new Promise((resolve) => setTimeout(resolve, 50));

    try {
      await this.stopPlayback();
      const analysis = this.analyze();

      const results: CalibrationResult[] = [];
      for (const room of analysis.rooms) {
        const info = this.rooms.find((r) => r.playerId === room.playerId);
        const isReference = room.playerId === this.rooms[0]?.playerId;
        const setting = await findDelaySetting(room.playerId);
        // Everything is lined up to the reference room, which stays as it is. A room that arrives
        // `arrivalMs` late must play that much earlier; one that arrives early, later. This was
        // measured with the current settings already applied, so the new value is current +/- that.
        const earlierBy = room.arrivalMs === null || isReference ? 0 : room.arrivalMs;
        const suggestion = setting ? suggestValue(setting, earlierBy) : null;
        results.push({
          playerId: room.playerId,
          playerName: info?.name ?? room.playerId,
          offsetMs: suggestion?.value ?? 0,
          arrivalMs: room.arrivalMs ?? undefined,
          currentSyncAdjustMs: setting?.current ?? null,
          setting,
          clamped: suggestion?.clamped,
          spreadMs: room.spreadMs ?? undefined,
          isReference,
          confidence: this.confidence(room),
          detectedClicks: room.clicks,
          totalClicks: room.clicks,
          warnings: qualityWarnings(room),
        });
      }

      this.emit({
        type: 'completed',
        data: {
          results,
          driftPpm: analysis.driftPpm,
          usableClicks: analysis.usableClicks,
          audioGaps: this.recorder.gapCount,
        },
      });
    } catch (error) {
      this.emit({ type: 'error', data: error instanceof Error ? error.message : 'Analysis failed' });
    } finally {
      await this.cleanup();
    }
  }

  /** Abort without analysing */
  stop(): void {
    void this.cleanup();
  }

  // ==================== Private Methods ====================

  private analyze() {
    const referenceId = this.rooms[0]?.playerId ?? '';
    return analyzeRooms(
      this.measurements.flatMap((m) => m.clicks),
      this.measurements.map(({ playerId, kind, startTime, endTime }) => ({ playerId, kind, startTime, endTime })),
      referenceId,
      this.config.frequencies.length,
      this.config.clickIntervalMs / 1000
    );
  }

  /** Current reading for every room measured so far (relative to the reference once it exists) */
  private readings(): RoomReading[] {
    const analysis = this.analyze();
    return analysis.rooms.map((room) => ({
      playerId: room.playerId,
      clicks: room.clicks,
      arrivalMs: room.arrivalMs,
      spreadMs: room.spreadMs,
      warnings: qualityWarnings(room),
    }));
  }

  private confidence(room: RoomAnalysis): number {
    if (room.clicks === 0 || room.spreadMs === null) return 0;
    const countScore = Math.min(1, room.clicks / 8);
    const spreadScore = Math.max(0, 1 - room.spreadMs / 5);
    const shapePenalty = room.widthMs !== null && room.widthMs > MAX_NORMAL_WIDTH_MS ? 0.5 : 1;
    return Math.round(countScore * spreadScore * shapePenalty * 100) / 100;
  }

  /** Mute everyone except `playerId` (which is unmuted so it can be heard). */
  private async applyMutes(playerId: string): Promise<void> {
    const everyone = [...this.rooms, ...this.others];
    await this.mutes.set(new Set(everyone.filter((r) => r.playerId !== playerId).map((r) => r.playerId)));
  }

  /** Put every room back to the mute state it had before calibration. */
  private async restoreMutes(): Promise<void> {
    await this.mutes.restore();
  }

  /** Once a second, scan the last few seconds so the UI can show clicks arriving. */
  private startLiveDetection(): void {
    const startedAt = Date.now();
    // While nothing has been heard, poll what MA and the track server report (no console on a phone)
    const pollDiagnostics = async () => {
      if (this.heardTimes.size > 0 || !this.isRunning) return;
      const info = await getDevServerInfo(this.serverUrl);
      let playbackState: string | null = null;
      let playerName = this.queueId;
      try {
        const p = await maClient.getPlayer(this.queueId);
        playbackState = p.playback_state ?? p.state ?? null;
        playerName = p.name ?? this.queueId;
      } catch {
        // ignore
      }
      this.diag = {
        trackRequests: info?.trackStats?.requests ?? null,
        lastRequestAgoS: info?.trackStats?.lastAgoS ?? null,
        lastRequestIp: info?.trackStats?.lastIp ?? '',
        playbackState,
        playerName,
      };
    };
    const diagTimer = setInterval(() => void pollDiagnostics(), 3000);
    const stopDiag = () => clearInterval(diagTimer);
    this.stopDiagnostics = stopDiag;
    this.liveTimer = setInterval(() => {
      const end = this.recorder.elapsed;
      const from = Math.max(0, end - 4);
      const clicks = detectClicks(
        this.recorder.getSamples(from, end),
        this.recorder.sampleRate,
        this.config.frequencies,
        from
      );
      for (const c of clicks) this.heardTimes.add(Math.round(c.time));
      // The newest click in view tells the user how strong the signal is right now
      const newest = clicks[clicks.length - 1];
      if (newest) this.latestClick = { at: newest.time, snr: newest.snr };
      const waitedS = (Date.now() - startedAt) / 1000;
      this.emit({
        type: 'clicks_heard',
        data: {
          total: this.heardTimes.size,
          newClicks: this.heardTimes.size - this.lastHeardCount,
          timedOut: this.heardTimes.size === 0 && waitedS > HEAR_TIMEOUT_S,
          remainingSeconds: this.remainingSeconds,
          diagnostics: this.diag,
          latest: this.latestClick ? { ageS: end - this.latestClick.at, snr: this.latestClick.snr } : null,
        },
      });
      this.lastHeardCount = this.heardTimes.size;
    }, 500);
  }

  private stopTimers(): void {
    this.stopDiagnostics?.();
    this.stopDiagnostics = null;
    if (this.liveTimer) clearInterval(this.liveTimer);
    this.liveTimer = null;
    if (this.windowTimer) clearInterval(this.windowTimer);
    this.windowTimer = null;
  }

  private async stopPlayback(): Promise<void> {
    if (!this.playing) return;
    this.playing = false;
    try {
      await maClient.playerCommand(this.queueId, 'stop');
    } catch (error) {
      console.warn('[CalibrationSession] Could not stop playback:', error);
    }
  }

  private emit(event: CalibrationEvent): void {
    this.eventCallback?.(event);
  }

  private async cleanup(): Promise<void> {
    this.isRunning = false;
    this.stopTimers();
    this.measuring = false;
    await this.restoreMutes();
    await this.stopPlayback();
    this.recorder.stop();
  }
}

export function createCalibrationSession(
  queueId: string,
  rooms: CalibrationRoom[],
  serverUrl: string,
  config?: Partial<CalibrationConfig>,
  others: CalibrationRoom[] = []
): CalibrationSession {
  return new CalibrationSession(queueId, rooms, serverUrl, config, others);
}
