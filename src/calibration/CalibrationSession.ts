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
import { analyzeRooms, detectClicks, qualityWarnings, MAX_NORMAL_WIDTH_MS } from './ClickAnalyzer';
import type { DetectedClick, RoomAnalysis } from './ClickAnalyzer';
import type { CalibrationConfig, CalibrationResult } from '../types';
import { DEFAULT_CALIBRATION_CONFIG } from '../types';
import { maClient, resolveClickTrackUrl } from '../ma-client';

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
  | 'room_measured'
  | 'mute_problems'
  | 'analyzing'
  | 'completed'
  | 'error';

export interface CalibrationEvent {
  type: CalibrationEventType;
  data?: unknown;
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
/** Seconds of recording that count for one room */
const WINDOW_S = 10;
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
  private windowTimer: ReturnType<typeof setTimeout> | null = null;
  private measurements: Measurement[] = [];
  private playing = false;
  private measuring = false;
  private mutesChanged = false;
  private isRunning = false;
  private heardTimes = new Set<number>();
  private lastHeardCount = 0;
  private muteProblems = new Map<string, string>();

  private queueId: string;
  private rooms: CalibrationRoom[];
  private serverUrl: string;

  /**
   * @param queueId Player or sync-group leader the track is played on (the whole group plays it)
   * @param rooms Rooms to measure, in order; the first is the reference
   */
  constructor(
    queueId: string,
    rooms: CalibrationRoom[],
    serverUrl: string,
    config?: Partial<CalibrationConfig>
  ) {
    this.queueId = queueId;
    this.rooms = rooms;
    this.serverUrl = serverUrl;
    this.config = { ...DEFAULT_CALIBRATION_CONFIG, ...config };
  }

  /**
   * Track length. It doesn't have to play in full (it stops at Finish), so be generous:
   * room for startup, every room plus the closing check, and several retries.
   */
  get trackSeconds(): number {
    return Math.min(600, 120 + (this.rooms.length + 1) * 75);
  }

  get windowSeconds(): number {
    return WINDOW_S;
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
      console.log('[CalibrationSession] Click track URL:', clickTrackUrl);

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
    this.emit({ type: 'room_measuring', data: { playerId, kind, seconds: GUARD_S + WINDOW_S } });

    await this.applyMutes(playerId);
    if (!this.isRunning) {
      // Cancelled while muting: don't leave the players muted
      await this.restoreMutes();
      return;
    }

    const startTime = this.recorder.elapsed + GUARD_S;
    const endTime = startTime + WINDOW_S;
    this.windowTimer = setTimeout(async () => {
      this.windowTimer = null;
      await this.restoreMutes();
      const samples = this.recorder.getSamples(startTime - 0.3, endTime + 0.3);
      const clicks = detectClicks(samples, this.recorder.sampleRate, this.config.frequencies, startTime - 0.3).filter(
        (c) => c.time >= startTime && c.time <= endTime
      );
      if (clicks.length > 0) {
        this.measurements = this.measurements.filter((m) => !(m.playerId === playerId && m.kind === kind));
        this.measurements.push({ playerId, kind, startTime, endTime, clicks });
      }
      this.measuring = false;
      this.emit({
        type: 'room_measured',
        data: { playerId, kind, clicks: clicks.length, readings: this.readings() },
      });
    }, (GUARD_S + WINDOW_S) * 1000 + 300);
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
      console.log('[CalibrationSession] Analysis:', analysis);

      const arrivals = analysis.rooms
        .map((room) => room.arrivalMs)
        .filter((v): v is number => v !== null);
      const latest = arrivals.length > 0 ? Math.max(...arrivals) : 0;

      const results: CalibrationResult[] = [];
      for (const room of analysis.rooms) {
        const info = this.rooms.find((r) => r.playerId === room.playerId);
        const current = await maClient.getPlayerSyncAdjust(room.playerId);
        // What we measured already includes the delay currently set, so the new value is
        // current + extra delay needed to line up with the latest-arriving room.
        const extra = room.arrivalMs === null ? 0 : latest - room.arrivalMs;
        results.push({
          playerId: room.playerId,
          playerName: info?.name ?? room.playerId,
          offsetMs: Math.round((current ?? 0) + extra),
          arrivalMs: room.arrivalMs ?? undefined,
          currentSyncAdjustMs: current,
          spreadMs: room.spreadMs ?? undefined,
          isReference: room.playerId === this.rooms[0]?.playerId,
          confidence: this.confidence(room),
          detectedClicks: room.clicks,
          totalClicks: WINDOW_S,
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

  /** Mute everyone except `playerId` (which is unmuted so it can be heard), then verify it took effect. */
  private async applyMutes(playerId: string): Promise<void> {
    const failed = new Map<string, string>();
    await Promise.all(
      this.rooms.map(async (room) => {
        const shouldMute = room.playerId !== playerId;
        try {
          await maClient.playerCommand(room.playerId, 'volume_mute', { muted: shouldMute });
          this.mutesChanged = true;
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          console.warn('[CalibrationSession] Could not set mute for', room.name, reason);
          if (shouldMute) failed.set(room.name, reason);
        }
      })
    );

    // Commands can be accepted without effect (e.g. grouped players); read the state back
    await new Promise((resolve) => setTimeout(resolve, 600));
    await Promise.all(
      this.rooms
        .filter((room) => room.playerId !== playerId && !failed.has(room.name))
        .map(async (room) => {
          try {
            const p = await maClient.getPlayer(room.playerId);
            const muted = p.volume_muted ?? p.muted;
            if (muted === false) failed.set(room.name, 'mute command accepted but the player is still unmuted');
          } catch {
            // can't verify; assume ok
          }
        })
    );

    let changed = false;
    failed.forEach((reason, name) => {
      if (this.muteProblems.get(name) !== reason) {
        this.muteProblems.set(name, reason);
        changed = true;
      }
    });
    if (changed) {
      this.emit({
        type: 'mute_problems',
        data: Array.from(this.muteProblems, ([name, reason]) => ({ name, reason })),
      });
    }
  }

  /** Put every room back to the mute state it had before calibration. */
  private async restoreMutes(): Promise<void> {
    if (!this.mutesChanged) return;
    this.mutesChanged = false;
    await Promise.all(
      this.rooms.map(async (room) => {
        try {
          await maClient.playerCommand(room.playerId, 'volume_mute', { muted: room.muted ?? false });
        } catch (error) {
          console.warn('[CalibrationSession] Could not restore mute for', room.name, error);
        }
      })
    );
  }

  /** Once a second, scan the last few seconds so the UI can show clicks arriving. */
  private startLiveDetection(): void {
    const startedAt = Date.now();
    this.liveTimer = setInterval(() => {
      const end = this.recorder.elapsed;
      const from = Math.max(0, end - 6);
      const clicks = detectClicks(
        this.recorder.getSamples(from, end),
        this.recorder.sampleRate,
        this.config.frequencies,
        from
      );
      for (const c of clicks) this.heardTimes.add(Math.round(c.time));
      const waitedS = (Date.now() - startedAt) / 1000;
      this.emit({
        type: 'clicks_heard',
        data: {
          total: this.heardTimes.size,
          newClicks: this.heardTimes.size - this.lastHeardCount,
          level: this.recorder.level,
          timedOut: this.heardTimes.size === 0 && waitedS > HEAR_TIMEOUT_S,
          remainingSeconds: this.remainingSeconds,
        },
      });
      this.lastHeardCount = this.heardTimes.size;
    }, 1000);
  }

  private stopTimers(): void {
    if (this.liveTimer) clearInterval(this.liveTimer);
    this.liveTimer = null;
    if (this.windowTimer) clearTimeout(this.windowTimer);
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
  config?: Partial<CalibrationConfig>
): CalibrationSession {
  return new CalibrationSession(queueId, rooms, serverUrl, config);
}
