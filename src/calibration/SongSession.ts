/**
 * Song test (dev only): measures two speakers against a song GroupSync plays itself.
 *
 * Because the app holds the same audio the speakers play, every speaker shows up as its own sharp peak
 * when the recording is compared with the song (see RefDelay.ts). That gives the signed gap (which
 * speaker is later) without any guessing about the music.
 *
 * Stages:
 *  1. starting    - mute B and the others, start the song on the group
 *  2. finding     - locate the song in the recording
 *  3. learn_a/b   - each speaker alone: where its peak sits
 *  4. live        - both play; the two peaks are followed every half second
 */
import { MicRecorder } from './MicRecorder';
import { MuteController, type MuteProblem } from './muting';
import { maClient, fetchSong, resolveSongUrl, getSongStats } from '../ma-client';
import { RefTracker, findOffset, pickPeaks, toMono, REF_FRAME, type RefCurve, type RefPeak } from './RefDelay';
import type { RecorderLike } from './LiveDriftSession';

export interface SongRoom {
  playerId: string;
  name: string;
  muted?: boolean;
}

export type SongStage = 'starting' | 'finding' | 'learn_a' | 'learn_b' | 'live';

export interface SongReading {
  /** Seconds since the live stage began */
  t: number;
  /** Signed gap in ms: positive = B arrives later than A. null if one of the two couldn't be found */
  gapMs: number | null;
  aMs: number | null;
  bMs: number | null;
  strengthA: number;
  strengthB: number;
  locked: boolean;
  peaks: RefPeak[];
  curve: { startMs: number; endMs: number; values: number[] };
}

export interface SongLearn {
  speaker: 'A' | 'B';
  seconds: number;
  /** Where this speaker's peak sits (ms) and how strong, once there is one */
  ms: number | null;
  strength: number;
  stable: boolean;
  /** How far above the room's background noise this speaker is at the phone, in dB */
  levelDb: number | null;
}

export type SongEventType = 'stage' | 'reading' | 'learn' | 'mute_problems' | 'level' | 'info' | 'error';
export interface SongEvent {
  type: SongEventType;
  data?: unknown;
}

const ALIGN_MARGIN = 2400; // song frames start 50 ms later than the estimate so early lags are in range
const LEARN_MIN_FRAMES = 5;
const LEARN_MAX_S = 25;
const MUTE_GUARD_S = 3;
const MIN_PEAK_STRENGTH = 12;
/** A speaker's own peak must reach this before it is accepted while learning (noise peaks stay lower) */
const LEARN_STRENGTH = 18;
/** Quieter than this above the room noise and the speaker can't be measured */
const MIN_LEVEL_DB = 6;
/** A real match shows a peak far above this in the detailed comparison (simulated ones are 100+, noise stays below 20) */
const CONFIRM_STRENGTH = 30;
const LABEL_WINDOW_MS = 20;
const RECENTRE_MS = 25;
const FIND_TIMEOUT_S = 60;

const rms = (x: Float32Array) => {
  let e = 0;
  for (let i = 0; i < x.length; i++) e += x[i] * x[i];
  return Math.sqrt(e / Math.max(1, x.length));
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class SongSession {
  private readonly a: SongRoom;
  private readonly b: SongRoom;
  private readonly others: SongRoom[];
  private readonly queueId: string;
  private readonly serverUrl: string;
  private readonly songName: string;
  private recorder: RecorderLike;
  private mutes: MuteController;
  private callback: ((e: SongEvent) => void) | null = null;
  private running = false;
  private relearn = false;
  private playing = false;
  private memoryS = 8;
  private tracker: RefTracker | null = null;
  private song: Float32Array = new Float32Array(0);
  /** recording sample = song sample + offset */
  private offset = 0;
  private pA = 0;
  private pB = 0;
  /** Where A's room echoes sit relative to its direct sound (learned with A alone) */
  private patternA: number[] = [];
  private recent: number[] = [];
  private songUrl = '';
  private noiseRms = 0;
  private nudges = 0;
  private requestsBefore = 0;

  constructor(
    queueId: string,
    a: SongRoom,
    b: SongRoom,
    others: SongRoom[],
    serverUrl: string,
    songName: string,
    recorder: RecorderLike = new MicRecorder()
  ) {
    this.queueId = queueId;
    this.a = a;
    this.b = b;
    this.others = others;
    this.serverUrl = serverUrl;
    this.songName = songName;
    this.recorder = recorder;
    this.mutes = new MuteController([a, b, ...others], (p: MuteProblem[]) => this.emit({ type: 'mute_problems', data: p }));
  }

  setMemory(seconds: number): void {
    this.memoryS = seconds;
    this.tracker?.setMemory(seconds);
  }

  /** Measure both speakers alone again (e.g. after moving the phone or a big delay change) */
  learnAgain(): void {
    this.relearn = true;
  }

  stop(): void {
    this.running = false;
  }

  async run(callback: (e: SongEvent) => void): Promise<void> {
    this.callback = callback;
    this.running = true;
    try {
      this.setStage('starting');
      await this.recorder.start();
      const sr = this.recorder.sampleRate;
      // Room noise before anything plays: speakers must stand clearly above it
      await sleep(1600);
      this.noiseRms = rms(this.recorder.getSamples(0.4, 1.5));
      const decoded = await new OfflineAudioContext(1, 1, sr).decodeAudioData(await fetchSong(this.songName));
      this.song = toMono(Array.from({ length: decoded.numberOfChannels }, (_, i) => decoded.getChannelData(i)));
      this.emit({ type: 'info', data: `Song loaded: ${(this.song.length / sr / 60).toFixed(1)} min` });

      await this.mutes.set(new Set([this.b, ...this.others].map((r) => r.playerId)));
      const url = await resolveSongUrl(this.serverUrl, this.songName);
      this.songUrl = url;
      this.requestsBefore = (await getSongStats(this.serverUrl))?.requests ?? 0;
      await maClient.playMedia(this.queueId, url, 'replace');
      this.playing = true;
      const playedAt = this.recorder.elapsed;

      await this.findSong(playedAt);
      while (this.running) {
        await this.learnBoth();
        if (!this.running) break;
        await this.liveLoop();
      }
    } catch (error) {
      this.emit({ type: 'error', data: error instanceof Error ? error.message : String(error) });
    } finally {
      await this.cleanup();
    }
  }

  // ==================== stages ====================

  /** Explain, from what Music Assistant did, why the song may not be playing */
  private async diagnose(): Promise<string> {
    const stats = await getSongStats(this.serverUrl);
    let state = '';
    try {
      const p = await maClient.getPlayer(this.queueId);
      state = p.playback_state ?? p.state ?? '';
    } catch {
      // ignore
    }
    const asked = (stats?.requests ?? 0) - this.requestsBefore;
    const parts: string[] = [];
    if (asked <= 0) {
      parts.push(`Music Assistant never fetched the song from ${this.songUrl}. It must be able to reach this computer on that port (firewall?).`);
    } else {
      parts.push(`Music Assistant fetched the song ${asked} time${asked === 1 ? '' : 's'}.`);
    }
    if (state) parts.push(`The player says it is "${state}".`);
    return parts.join(' ');
  }

  /**
   * Music Assistant sometimes loads the song and then sits idle (the Shield shows the title for a second
   * and stops). Pressing play by hand fixes it, so do the same when the player isn't playing.
   */
  private async nudgePlayback(): Promise<void> {
    if (this.nudges >= 4) return;
    let state = '';
    try {
      const p = await maClient.getPlayer(this.queueId);
      state = p.playback_state ?? p.state ?? '';
    } catch {
      return;
    }
    if (state === 'playing') return;
    this.nudges++;
    this.emit({ type: 'info', data: `The player is "${state || 'not playing'}", pressing play…` });
    try {
      await maClient.sendCommand('player_queues/play', { queue_id: this.queueId });
    } catch {
      try {
        await maClient.playerCommand(this.queueId, 'play');
      } catch (error) {
        console.warn('[SongSession] Could not press play:', error);
      }
    }
  }

  /** Wait until the song is audible, then locate it in the recording */
  private async findSong(playedAt: number): Promise<void> {
    this.setStage('finding');
    const sr = this.recorder.sampleRate;
    const window = 8;
    let lastNote = 0;
    while (this.running) {
      await sleep(1000);
      this.emit({ type: 'level', data: this.recorder.level });
      const now = this.recorder.elapsed;
      if (now - lastNote >= 5) {
        lastNote = now;
        this.emit({ type: 'info', data: `Waiting for the song… ${await this.diagnose()}` });
        await this.nudgePlayback();
      }
      if (now - playedAt > FIND_TIMEOUT_S) {
        throw new Error(`Couldn't hear the song. ${await this.diagnose()}`);
      }
      if (now < window + 2) continue;
      const startS = now - window;
      const mic = this.recorder.getSamples(startS, now);
      const found = findOffset(this.song, mic, Math.round(startS * sr), sr, Math.floor(now * sr));
      if (found && this.confirm(found.offset, now)) {
        this.offset = found.offset;
        this.emit({ type: 'info', data: `Found the song (match ${found.quality.toFixed(0)}, it starts ${(found.offset / sr).toFixed(3)} s into the recording).` });
        return;
      }
    }
  }

  /** A real match gives a sharp peak when the last few seconds are compared in detail; a chance one doesn't */
  private confirm(offset: number, now: number): boolean {
    const prev = this.offset;
    this.offset = offset;
    try {
      const tracker = new RefTracker(this.recorder.sampleRate, 1e6);
      const frameS = REF_FRAME / this.recorder.sampleRate;
      for (let k = 1; k <= 3; k++) {
        const f = this.frame(now - k * frameS);
        tracker.push(f.mic, f.song);
      }
      const curve = tracker.curve(2);
      const top = curve ? pickPeaks(curve, 1)[0] : undefined;
      return !!top && top.strength >= CONFIRM_STRENGTH;
    } finally {
      this.offset = prev;
    }
  }

  private frame(micStartS: number): { mic: Float32Array; song: Float32Array } {
    const sr = this.recorder.sampleRate;
    const start = Math.round(micStartS * sr);
    const mic = this.recorder.getSamples(start / sr, (start + REF_FRAME) / sr);
    const from = start - this.offset + ALIGN_MARGIN;
    const song = new Float32Array(REF_FRAME);
    for (let i = 0; i < REF_FRAME; i++) song[i] = this.song[from + i] ?? 0;
    return { mic: mic.length === REF_FRAME ? mic : Float32Array.from({ length: REF_FRAME }, (_, i) => mic[i] ?? 0), song };
  }

  private async learnBoth(): Promise<void> {
    const a = await this.learnOne('A');
    this.pA = a.ms;
    this.patternA = a.pattern;
    if (!this.running) return;
    this.pB = (await this.learnOne('B')).ms;
  }

  /** Play one speaker alone and return where its (strongest) peak sits */
  private async learnOne(which: 'A' | 'B'): Promise<{ ms: number; pattern: number[] }> {
    this.setStage(which === 'A' ? 'learn_a' : 'learn_b');
    const mine = which === 'A' ? this.a : this.b;
    const rest = [which === 'A' ? this.b : this.a, ...this.others];
    await this.mutes.set(new Set(rest.map((r) => r.playerId)));
    const tracker = new RefTracker(this.recorder.sampleRate, 1e6);
    const began = this.recorder.elapsed;
    // The mute takes a moment to reach the speakers: ignore audio until it has
    let at = began + MUTE_GUARD_S;
    const frameS = REF_FRAME / this.recorder.sampleRate;
    const tops: number[] = [];
    let last: { ms: number; strength: number; pattern: number[] } | null = null;
    let levelDb: number | null = null;
    while (this.running) {
      await sleep(400);
      this.emit({ type: 'level', data: this.recorder.level });
      const now = this.recorder.elapsed;
      let added = false;
      while (at + frameS <= now) {
        const f = this.frame(at);
        tracker.push(f.mic, f.song);
        at += frameS;
        added = true;
      }
      const heard = now - (began + MUTE_GUARD_S);
      if (heard > 1.5) {
        const r = rms(this.recorder.getSamples(now - 1.5, now));
        levelDb = 20 * Math.log10((r + 1e-9) / (this.noiseRms + 1e-9));
      }
      const curve = added ? tracker.curve(2) : null;
      const found = curve ? pickPeaks(curve, 8) : [];
      const top = found[0];
      if (top) {
        const pattern = found.slice(1).filter((p) => p.strength >= MIN_PEAK_STRENGTH * 0.6).map((p) => p.ms - top.ms);
        last = { ms: top.ms, strength: top.strength, pattern };
        tops.push(top.ms);
      }
      // Settled: the same peak, strong, over the last four frames
      const recentTops = tops.slice(-4);
      const settled =
        tracker.frames >= LEARN_MIN_FRAMES &&
        recentTops.length === 4 &&
        Math.max(...recentTops) - Math.min(...recentTops) < 0.3 &&
        (last?.strength ?? 0) >= LEARN_STRENGTH;
      this.emit({
        type: 'learn',
        data: { speaker: which, seconds: Math.max(0, heard), ms: last?.ms ?? null, strength: last?.strength ?? 0, stable: settled, levelDb } satisfies SongLearn,
      });
      if (settled && last) return { ms: last.ms, pattern: last.pattern };
      const quiet = levelDb !== null && levelDb < MIN_LEVEL_DB;
      if ((quiet && heard > 8) || heard > LEARN_MAX_S) {
        if (quiet) {
          throw new Error(
            `${mine.name} is barely audible at the phone (${levelDb!.toFixed(0)} dB above the room noise). Turn its volume up or move the phone closer, then try again.`
          );
        }
        throw new Error(`Couldn't get a clear reading of ${mine.name} (best peak ${last ? last.strength.toFixed(0) : 0}, needs ${LEARN_STRENGTH}). ${await this.diagnose()}`);
      }
    }
    return { ms: 0, pattern: [] };
  }

  private async liveLoop(): Promise<void> {
    this.setStage('live');
    await this.mutes.set(new Set(this.others.map((r) => r.playerId)));
    const sr = this.recorder.sampleRate;
    const frameS = REF_FRAME / sr;
    const tracker = new RefTracker(sr, this.memoryS);
    this.tracker = tracker;
    this.recent = [];
    const began = this.recorder.elapsed;
    let at = began + MUTE_GUARD_S;
    while (this.running && !this.relearn) {
      await sleep(250);
      this.emit({ type: 'level', data: this.recorder.level });
      const now = this.recorder.elapsed;
      let pushed = false;
      while (at + frameS <= now) {
        const f = this.frame(at);
        tracker.push(f.mic, f.song);
        at += frameS;
        pushed = true;
      }
      if (!pushed) continue;
      const curve = tracker.curve(2);
      if (curve) this.emit({ type: 'reading', data: this.reading(curve, now - began - MUTE_GUARD_S) });
    }
    this.relearn = false;
  }

  /**
   * Match the curve's peaks to the two speakers. A is the peak nearest where it was learned. B is the
   * strongest of the remaining peaks that isn't one of A's own room echoes, so B can be found wherever
   * its delay has been moved to.
   */
  private reading(curve: RefCurve, t: number): SongReading {
    const peaks = pickPeaks(curve, 10).filter((p) => p.strength >= MIN_PEAK_STRENGTH * 0.6);
    const pa = peaks
      .filter((p) => Math.abs(p.ms - this.pA) <= LABEL_WINDOW_MS)
      .sort((x, y) => Math.abs(x.ms - this.pA) - Math.abs(y.ms - this.pA) || y.strength - x.strength)[0];
    const isEcho = (p: RefPeak) => !!pa && this.patternA.some((o) => Math.abs(p.ms - pa.ms - o) < 0.35);
    const pb = peaks.filter((p) => p !== pa && !isEcho(p)).sort((x, y) => y.strength - x.strength)[0];
    const gapMs = pa && pb && pa !== pb ? pb.ms - pa.ms : null;
    this.recent = gapMs === null ? [] : [...this.recent, gapMs].slice(-4);
    const locked = this.recent.length === 4 && Math.max(...this.recent) - Math.min(...this.recent) <= 0.3;

    // The recording clock and the speakers' clock slowly drift apart: keep the two peaks centred
    if (pa && Math.abs(pa.ms - this.pA) > RECENTRE_MS) {
      const shift = pa.ms - this.pA;
      this.offset += Math.round((shift / 1000) * this.recorder.sampleRate);
      this.pA += shift;
      this.pB += shift;
      this.tracker?.reset();
    }

    const bins = 220;
    const values = new Array<number>(bins).fill(0);
    const total = curve.values.length;
    const noise = [...curve.values].map(Math.abs).sort((x, y) => x - y)[Math.floor(total / 2)] + 1e-12;
    for (let i = 0; i < total; i++) {
      const bin = Math.min(bins - 1, Math.floor((i / total) * bins));
      values[bin] = Math.max(values[bin], Math.max(0, curve.values[i]) / noise);
    }
    return {
      t,
      gapMs,
      aMs: pa?.ms ?? null,
      bMs: pb?.ms ?? null,
      strengthA: pa?.strength ?? 0,
      strengthB: pb?.strength ?? 0,
      locked,
      peaks: peaks.slice(0, 5),
      curve: { startMs: curve.startMs, endMs: curve.startMs + (total / curve.sampleRate) * 1000, values },
    };
  }

  private async cleanup(): Promise<void> {
    this.running = false;
    if (this.playing) {
      this.playing = false;
      try {
        await maClient.playerCommand(this.queueId, 'stop');
      } catch (error) {
        console.warn('[SongSession] Could not stop playback:', error);
      }
    }
    await this.mutes.restore();
    this.recorder.stop();
  }

  private setStage(stage: SongStage): void {
    this.emit({ type: 'stage', data: stage });
  }

  private emit(event: SongEvent): void {
    this.callback?.(event);
  }
}
