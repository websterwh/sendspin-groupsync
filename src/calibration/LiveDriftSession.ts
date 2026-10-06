/**
 * Live drift test: watch the gap between two speakers while ordinary music plays (no click track).
 *
 * Stages:
 *  1. waiting   - until music is heard
 *  2. learn A   - only speaker A plays (everything else muted): records how the room echoes A
 *  3. learn B   - only speaker B plays
 *  4. live      - A and B play (others stay muted); every few seconds the last ~30 s are analysed and the
 *                 room echoes learned in 2-3 are subtracted, leaving the gap between A and B.
 *
 * The result is the SIZE of the gap (a recording of an unknown song can't say which speaker is ahead).
 * Dev-only tool; see LiveDelay.ts for the method.
 */

import { MicRecorder } from './MicRecorder';
import {
  LagCurveTracker,
  curveCorrelation,
  maxStrength,
  subtractBaselines,
  bestPeak,
  type DelayPeak,
  type LagCurve,
} from './LiveDelay';
import { MuteController } from './muting';
import { maClient } from '../ma-client';

export interface LiveRoom {
  playerId: string;
  name: string;
  /** Mute state before the test; restored afterwards */
  muted?: boolean;
  /** Volume (0-100) before the test, used by volume matching and restored afterwards */
  volume?: number;
}

export type LiveStage = 'waiting' | 'learn_a' | 'learn_b' | 'live';

export interface LiveReading {
  /** Seconds since the live stage began */
  t: number;
  /** The gap in ms, or null if no gap stood out */
  delayMs: number | null;
  strength: number;
  /** Other candidate gaps (room reflections or a third speaker) */
  others: DelayPeak[];
  /** Three readings in a row agreed */
  locked: boolean;
  /** Whether room echoes were subtracted */
  usedBaseline: boolean;
  /** Strongest candidates whether or not they passed the threshold */
  candidates: DelayPeak[];
  /** A small gap that was seen but not clear enough to report (null if none) */
  weakSmall: DelayPeak | null;
  /** The gap curve behind this reading (strength per delay), coarsely sampled for display */
  curve: { startMs: number; endMs: number; values: number[]; raw: number[] };
}

export type LiveEventType = 'stage' | 'reading' | 'mute_problems' | 'level' | 'levels' | 'volume' | 'learn' | 'error';
export interface LiveEvent {
  type: LiveEventType;
  data?: unknown;
}

export interface LiveOptions {
  /** The longest to keep listening to one speaker while learning the room (it stops sooner once the picture is stable) */
  learnMaxS?: number;
  /** Roughly how many seconds of recent audio count towards a reading (shorter = faster, noisier) */
  memoryS?: number;
  /** Seconds between readings */
  readingEveryS?: number;
  /** Settling time after muting before audio counts */
  guardS?: number;
  /** Weakest peak that counts as a gap (in noise units) */
  minStrength?: number;
  /** Adjust the two speakers' volumes so they reach the microphone equally loud (default true) */
  matchVolume?: boolean;
}

/** Levels of the two speakers at the microphone, in dB (relative) */
export interface LiveLevels {
  aDb: number;
  bDb: number;
}

/** How the room learning is going for one speaker */
export interface LearnProgress {
  speaker: 'A' | 'B';
  /** Seconds listened so far */
  seconds: number;
  /** How well two independent halves of the audio agree on the echo pattern (0 to 1) */
  agreement: number;
  /** listening: still going; stable/flat: understood; loose: gave up waiting for a clean picture; failed: not enough music */
  state: 'listening' | 'stable' | 'flat' | 'loose' | 'failed';
}

export interface VolumeNote {
  text: string;
  /** Matching is finished (successfully or not) */
  done: boolean;
}

/** What the session needs from the microphone (the real MicRecorder, or a stand-in in tests) */
export interface RecorderLike {
  start(): Promise<void>;
  stop(): void;
  readonly sampleRate: number;
  readonly elapsed: number;
  readonly level: number;
  getSamples(fromS: number, toS: number): Float32Array;
}

/** Two independent halves of the audio must agree at least this well on the room's echo pattern */
export const LEARN_AGREEMENT = 0.7;
const MUSIC_LEVEL = 0.002;
/**
 * Gaps below this are hard to tell from room reflections and the music's own bass notes, which make
 * similar bumps at small delays. They are only reported as a number when the peak is strong and clearly
 * stands above everything else; otherwise the reading says "no clear gap" (in sync, or unclear).
 */
const SMALL_GAP_MS = 10;
const SMALL_GAP_MIN_STRENGTH = 20;
const SMALL_GAP_CLEARANCE = 1.4;
/** Portion of a speaker's echo pattern that remains in the mix once both play (they share the power) */
const BASELINE_SHARE = 0.5;

const energy = (x: Float32Array) => {
  let e = 0;
  for (let i = 0; i < x.length; i++) e += x[i] * x[i];
  return e / Math.max(1, x.length);
};

export class LiveDriftSession {
  private a: LiveRoom;
  private b: LiveRoom;
  private others: LiveRoom[];
  private recorder: RecorderLike;
  private callback: ((e: LiveEvent) => void) | null = null;
  private running = false;
  private skipBaseline = false;
  private mutes: MuteController;
  private recent: number[] = [];
  private opts: Required<LiveOptions>;
  private curveA: LagCurve | null = null;
  private curveB: LagCurve | null = null;
  private weights: number[] = [0.5, 0.5];
  private liveStart = 0;
  private relearn = false;
  private resetWindow = false;
  private tracker: LagCurveTracker | null = null;
  private volumes = new Map<string, { orig: number; current: number }>();
  private keepVolume = false;

  constructor(
    a: LiveRoom,
    b: LiveRoom,
    others: LiveRoom[],
    options: LiveOptions = {},
    recorder: RecorderLike = new MicRecorder()
  ) {
    this.a = a;
    this.b = b;
    this.others = others;
    this.mutes = new MuteController([a, b, ...others], (problems) =>
      this.emit({ type: 'mute_problems', data: problems })
    );
    this.recorder = recorder;
    this.opts = {
      learnMaxS: options.learnMaxS ?? 45,
      memoryS: options.memoryS ?? 20,
      readingEveryS: options.readingEveryS ?? 0.5,
      guardS: options.guardS ?? 2.5,
      minStrength: options.minStrength ?? 12,
      matchVolume: options.matchVolume ?? true,
    };
    for (const room of [a, b, ...others]) {
      if (typeof room.volume === 'number') this.volumes.set(room.playerId, { orig: room.volume, current: room.volume });
    }
  }

  /** Start without learning the room's echoes (faster, but reflections can show up as false gaps). */
  skipLearning(): void {
    this.skipBaseline = true;
  }

  /** Change how strong a peak must be to count as a gap (takes effect on the next reading). */
  setMinStrength(strength: number): void {
    this.opts.minStrength = strength;
  }

  /** How fast the live reading follows changes: seconds of recent audio that count (about 6 fast, 12 normal, 25 steady). */
  setMemory(seconds: number): void {
    this.opts.memoryS = seconds;
    this.tracker?.setMemory(seconds);
  }

  /** Forget the readings and the audio so far; the next reading uses only audio from now on. */
  resetReadings(): void {
    this.resetWindow = true;
  }

  /** Leave the volumes as matched instead of restoring them when the test ends. */
  keepVolumes(keep: boolean): void {
    this.keepVolume = keep;
  }

  /** Learn the room's echoes again (e.g. after moving the phone). */
  learnAgain(): void {
    this.skipBaseline = false;
    this.relearn = true;
  }

  async run(callback: (e: LiveEvent) => void): Promise<void> {
    this.callback = callback;
    this.running = true;
    try {
      await this.recorder.start();
      await this.waitForMusic();
      if (this.running && !this.skipBaseline) await this.learnRoom();
      while (this.running) {
        await this.liveLoop();
        if (this.running && this.relearn) {
          this.relearn = false;
          this.recent = [];
          await this.learnRoom();
        }
      }
    } catch (error) {
      this.emit({ type: 'error', data: error instanceof Error ? error.message : String(error) });
    } finally {
      await this.cleanup();
    }
  }

  stop(): void {
    this.running = false;
  }

  // ==================== stages ====================

  private async waitForMusic(): Promise<void> {
    this.setStage('waiting');
    let loudFor = 0;
    while (this.running) {
      await sleep(500);
      this.emit({ type: 'level', data: this.recorder.level });
      loudFor = this.recorder.level > MUSIC_LEVEL ? loudFor + 0.5 : 0;
      if (loudFor >= 2) return;
      if (this.skipBaseline) return;
    }
  }

  private async learnRoom(): Promise<void> {
    this.curveA = this.curveB = null;

    this.setStage('learn_a');
    const failA = await this.setMutes([this.b, ...this.others]);
    const a = await this.learnSpeaker('A');
    if (!a || !this.running || this.skipBaseline) return;

    this.setStage('learn_b');
    const failB = await this.setMutes([this.a, ...this.others]);
    const b = await this.learnSpeaker('B');
    if (!b || !this.running || this.skipBaseline) return;

    // If a speaker that should have been silent was still playing, its "alone" recording contains the
    // gap itself, and subtracting it would hide the real gap. Better to run without the correction.
    if (failA.length > 0 || failB.length > 0 || !a.curve || !b.curve) return;

    this.curveA = a.curve;
    this.curveB = b.curve;
    let eA = a.energy;
    let eB = b.energy;
    this.emit({ type: 'levels', data: { aDb: 10 * Math.log10(eA + 1e-12), bDb: 10 * Math.log10(eB + 1e-12) } satisfies LiveLevels });
    if (this.opts.matchVolume && !this.skipBaseline) {
      [eA, eB] = await this.matchVolumes(eA, eB);
    }
    this.weights = [(BASELINE_SHARE * eA) / (eA + eB || 1), (BASELINE_SHARE * eB) / (eA + eB || 1)];
  }

  /**
   * Listen to one speaker alone until its room echo pattern is understood. Alternate 2 s blocks feed two
   * independent estimates; when they agree the pattern is stable, and when both are flat there is nothing
   * to learn. Otherwise keep listening, up to learnMaxS, and say so if it never settles.
   */
  private async learnSpeaker(speaker: 'A' | 'B'): Promise<{ curve: LagCurve | null; energy: number } | null> {
    const sr = this.recorder.sampleRate;
    const onSample = (t: number) => Math.floor(t * sr) / sr;
    const BLOCK_S = 2;
    const full = new LagCurveTracker(sr, { memoryS: 1e6 });
    const halves = [new LagCurveTracker(sr, { memoryS: 1e6 }), new LagCurveTracker(sr, { memoryS: 1e6 })];
    const start = onSample(this.recorder.elapsed + this.opts.guardS);
    let processed = start;
    let sumSq = 0;
    let count = 0;
    let lastCheck = 0;
    let agreement = 0;
    const began = Date.now();
    const emitProgress = (state: LearnProgress['state']) =>
      this.emit({
        type: 'learn',
        data: { speaker, seconds: (Date.now() - began) / 1000, agreement: Math.max(0, agreement), state } satisfies LearnProgress,
      });

    while (this.running && !this.skipBaseline) {
      await sleep(500);
      this.emit({ type: 'level', data: this.recorder.level });
      const now = onSample(this.recorder.elapsed);
      if (now - processed >= 0.25) {
        // Split on block boundaries so each half only ever sees whole blocks
        let from = processed;
        while (from < now) {
          const blockIndex = Math.floor((from - start) / BLOCK_S);
          const blockEnd = Math.min(now, onSample(start + (blockIndex + 1) * BLOCK_S));
          if (blockEnd <= from) break;
          const chunk = this.recorder.getSamples(from, blockEnd);
          for (let i = 0; i < chunk.length; i++) sumSq += chunk[i] * chunk[i];
          count += chunk.length;
          await full.push(chunk);
          await halves[blockIndex % 2].push(chunk);
          if (blockEnd >= onSample(start + (blockIndex + 1) * BLOCK_S)) halves[blockIndex % 2].endBlock();
          from = blockEnd;
        }
        processed = now;
      }

      if (now - lastCheck >= 1) {
        lastCheck = now;
        const f = full.curve(14);
        const h0 = halves[0].curve(6);
        const h1 = halves[1].curve(6);
        if (f && h0 && h1) {
          agreement = curveCorrelation(h0.strength, h1.strength);
          const flat = full.frames >= 24 && maxStrength(f) < 6.5 && maxStrength(h0) < 8 && maxStrength(h1) < 8;
          if (agreement >= LEARN_AGREEMENT || flat) {
            emitProgress(flat && agreement < LEARN_AGREEMENT ? 'flat' : 'stable');
            return { curve: f, energy: count ? sumSq / count : 0 };
          }
        }
        emitProgress('listening');
      }

      if ((Date.now() - began) / 1000 >= this.opts.learnMaxS) {
        // Never settled: use what we have if there was enough audio, otherwise give up on correcting
        const f = full.curve(14);
        emitProgress(f ? 'loose' : 'failed');
        return { curve: f, energy: count ? sumSq / count : 0 };
      }
    }
    return null;
  }

  private async liveLoop(): Promise<void> {
    const { guardS } = this.opts;
    const sr = this.recorder.sampleRate;
    this.setStage('live');
    await this.setMutes([...this.others]);
    const tracker = new LagCurveTracker(sr, { memoryS: this.opts.memoryS });
    this.tracker = tracker;
    // Audio is fed in as it arrives; times are kept on whole samples so chunks join up exactly
    const onSample = (t: number) => Math.floor(t * sr) / sr;
    this.liveStart = onSample(this.recorder.elapsed + guardS);
    let processed = this.liveStart;
    let nextReading = 0;
    while (this.running && !this.relearn) {
      await sleep(250);
      this.emit({ type: 'level', data: this.recorder.level });
      const now = onSample(this.recorder.elapsed);
      if (this.resetWindow) {
        // e.g. a delay was just changed: only audio from now on should count
        this.resetWindow = false;
        tracker.reset();
        this.recent = [];
        this.liveStart = onSample(now + guardS);
        processed = this.liveStart;
        nextReading = 0;
        continue;
      }
      if (now - processed < 0.2) continue;
      await tracker.push(this.recorder.getSamples(processed, now));
      processed = now;
      if (now < nextReading) continue;
      nextReading = now + this.opts.readingEveryS;

      const mix = tracker.curve();
      if (!mix || !this.running) continue;
      const learned = this.curveA && this.curveB;
      const curve = learned ? subtractBaselines(mix, [this.curveA!, this.curveB!], this.weights) : mix;
      const { peaks } = bestPeak(curve, this.opts.minStrength);
      // Strongest peak that is convincing: small gaps need to be strong and stand clear of the rest
      let best: DelayPeak | null = null;
      let weakSmall: DelayPeak | null = null;
      for (const p of peaks) {
        if (p.strength < this.opts.minStrength) break;
        if (p.delayMs < SMALL_GAP_MS) {
          const other = peaks.reduce((m, q) => (q !== p ? Math.max(m, q.strength) : m), 0);
          if (p.strength < SMALL_GAP_MIN_STRENGTH || p.strength < SMALL_GAP_CLEARANCE * other) {
            weakSmall = weakSmall ?? p;
            continue;
          }
        }
        best = p;
        break;
      }
      const lagMs = (i: number) => ((curve.lagLo + i) / curve.sampleRate) * 1000;
      const bins = 200;
      const values = new Array<number>(bins).fill(0);
      const raw = new Array<number>(bins).fill(0);
      for (let i = 0; i < curve.strength.length; i++) {
        const bin = Math.min(bins - 1, Math.floor((i / curve.strength.length) * bins));
        values[bin] = Math.max(values[bin], curve.strength[i]);
        raw[bin] = Math.max(raw[bin], mix.strength[i]);
      }
      const delayMs = best?.delayMs ?? null;
      // Steady: the last four readings agree within 0.5 ms (or 3%)
      this.recent = delayMs === null ? [] : [...this.recent, delayMs].slice(-4);
      const locked =
        this.recent.length === 4 && Math.max(...this.recent) - Math.min(...this.recent) <= Math.max(0.5, 0.03 * delayMs!);
      this.emit({
        type: 'reading',
        data: {
          t: now - this.liveStart,
          delayMs,
          strength: best?.strength ?? peaks[0]?.strength ?? 0,
          others: peaks.filter((p) => p !== best).slice(0, 3),
          locked,
          usedBaseline: !!learned,
          candidates: peaks.slice(0, 3),
          weakSmall,
          curve: { startMs: lagMs(0), endMs: lagMs(curve.strength.length - 1), values, raw },
        } satisfies LiveReading,
      });
    }
  }

  /**
   * Make the two speakers equally loud at the microphone: they should be close already, but a mismatch
   * weakens the echo pattern this test relies on. Adjusts the quieter speaker's volume up (or, once that
   * is used up, the louder one down) in small steps, re-listening to the adjusted speaker each time.
   * Volumes are restored when the test ends unless keepVolumes(true) was called.
   */
  private async matchVolumes(eAIn: number, eBIn: number): Promise<[number, number]> {
    let eA = eAIn;
    let eB = eBIn;
    const MAX_STEPS = 15;
    let stepsPerDb = 2;
    const note = (text: string, done = false) => this.emit({ type: 'volume', data: { text, done } satisfies VolumeNote });

    if (!this.volumes.has(this.a.playerId) || !this.volumes.has(this.b.playerId)) {
      note("Volume matching skipped: Music Assistant didn't report the volumes.", true);
      return [eA, eB];
    }

    for (let attempt = 0; attempt < 3 && this.running && !this.skipBaseline; attempt++) {
      const diffDb = 10 * Math.log10((eB + 1e-12) / (eA + 1e-12)); // > 0: B is louder
      if (Math.abs(diffDb) < 1.5) {
        note(`Volumes match (${Math.abs(diffDb).toFixed(1)} dB apart).`, true);
        return [eA, eB];
      }
      const quiet = diffDb > 0 ? this.a : this.b;
      const loud = diffDb > 0 ? this.b : this.a;
      const q = this.volumes.get(quiet.playerId)!;
      const l = this.volumes.get(loud.playerId)!;
      const wantSteps = Math.max(1, Math.round(Math.abs(diffDb) * stepsPerDb));

      // Raise the quieter speaker within its allowance, otherwise lower the louder one
      let target = quiet;
      let newVol = Math.min(100, q.current + wantSteps, q.orig + MAX_STEPS);
      if (newVol <= q.current) {
        target = loud;
        newVol = Math.max(0, l.current - wantSteps, l.orig - MAX_STEPS);
        if (newVol >= l.current) {
          note(`Couldn't match the volumes (${Math.abs(diffDb).toFixed(1)} dB apart; adjustment limit reached).`, true);
          return [eA, eB];
        }
      }
      const entry = this.volumes.get(target.playerId)!;
      const before = entry.current;
      note(`Matching volume: ${target.name} ${before} → ${newVol} (${Math.abs(diffDb).toFixed(1)} dB apart)…`);

      if (!(await this.setVolume(target, newVol))) return [eA, eB];

      // Listen to the adjusted speaker alone to see what the change did
      const others = [this.a, this.b, ...this.others].filter((r) => r.playerId !== target.playerId);
      await this.setMutes(others);
      const eNew = await this.listenForLevel();
      if (eNew === null || !this.running) return [eA, eB];
      const oldE = target.playerId === this.a.playerId ? eA : eB;
      const changeDb = 10 * Math.log10((eNew + 1e-12) / (oldE + 1e-12));
      if (target.playerId === this.a.playerId) eA = eNew;
      else eB = eNew;
      // What a volume step is worth on this speaker, for the next round
      const stepsMoved = newVol - before;
      if (Math.abs(changeDb) > 0.3 && stepsMoved !== 0) {
        stepsPerDb = Math.max(0.5, Math.min(8, Math.abs(stepsMoved / changeDb)));
      } else if (attempt >= 1) {
        note(`Volume change on ${target.name} had no effect; leaving it.`, true);
        return [eA, eB];
      }
    }
    const finalDiff = 10 * Math.log10((eB + 1e-12) / (eA + 1e-12));
    note(`Volumes matched to within ${Math.abs(finalDiff).toFixed(1)} dB.`, true);
    return [eA, eB];
  }

  /** Set a player's volume and confirm that only that player changed (MA can apply it to a whole group) */
  private async setVolume(room: LiveRoom, volume: number): Promise<boolean> {
    const note = (text: string) => this.emit({ type: 'volume', data: { text, done: true } satisfies VolumeNote });
    const readVolume = async (id: string): Promise<number | undefined> => {
      try {
        const p = await maClient.getPlayer(id);
        return typeof p.volume_level === 'number' ? p.volume_level : undefined;
      } catch {
        return undefined;
      }
    };
    const others = [this.a, this.b, ...this.others].filter((r) => r.playerId !== room.playerId);
    // What every speaker is at right now, as Music Assistant reports it (not what we think we set earlier)
    const targetBefore = (await readVolume(room.playerId)) ?? this.volumes.get(room.playerId)?.current;
    const before = new Map<string, number | undefined>();
    for (const r of others) before.set(r.playerId, await readVolume(r.playerId));

    try {
      await maClient.sendCommand('players/cmd/volume_set', { player_id: room.playerId, volume_level: volume });
    } catch (error) {
      note(`Couldn't change ${room.name}'s volume: ${error instanceof Error ? error.message : error}`);
      return false;
    }

    // Wait for the target to show the new volume (some players update slowly)
    let applied = false;
    for (let i = 0; i < 6 && !applied; i++) {
      await sleep(500);
      const v = await readVolume(room.playerId);
      applied = v === undefined || Math.abs(v - volume) <= 1;
    }
    if (!applied) {
      note(`${room.name}'s volume didn't change. Volume matching turned off.`);
      return false;
    }
    this.volumes.get(room.playerId)!.current = volume;

    for (const r of others) {
      const expected = before.get(r.playerId);
      const now = await readVolume(r.playerId);
      if (expected !== undefined && now !== undefined && Math.abs(now - expected) > 1) {
        // The change spread to another speaker (group volume): put things back and stop
        await maClient.sendCommand('players/cmd/volume_set', { player_id: room.playerId, volume_level: targetBefore ?? volume }).catch(() => undefined);
        await maClient.sendCommand('players/cmd/volume_set', { player_id: r.playerId, volume_level: expected }).catch(() => undefined);
        this.volumes.get(room.playerId)!.current = targetBefore ?? volume;
        note(`Music Assistant applied the volume change to ${r.name} too (group volume). Volume matching turned off.`);
        return false;
      }
    }
    return true;
  }

  private async restoreVolumes(): Promise<void> {
    if (this.keepVolume) return;
    await Promise.all(
      Array.from(this.volumes, async ([id, v]) => {
        if (v.current === v.orig) return;
        await maClient.sendCommand('players/cmd/volume_set', { player_id: id, volume_level: v.orig }).catch(() => undefined);
        v.current = v.orig;
      })
    );
  }

  /** Listen until the level settles (two 1 s readings within 0.7 dB), 4 to 12 s; null if cancelled */
  private async listenForLevel(): Promise<number | null> {
    const start = this.recorder.elapsed + this.opts.guardS;
    const blocks: number[] = [];
    let next = start + 1;
    while (this.running && !this.skipBaseline) {
      await sleep(500);
      this.emit({ type: 'level', data: this.recorder.level });
      const now = this.recorder.elapsed;
      if (now < next) continue;
      blocks.push(energy(this.recorder.getSamples(next - 1, next)));
      next += 1;
      const n = blocks.length;
      if (n >= 4) {
        const dB = (e: number) => 10 * Math.log10(e + 1e-12);
        if (Math.abs(dB(blocks[n - 1]) - dB(blocks[n - 2])) < 0.7 || n >= 12) {
          const used = blocks.slice(-3);
          return used.reduce((a, b) => a + b, 0) / used.length;
        }
      }
    }
    return null;
  }

  // ==================== muting ====================

  /** Mute exactly `muted` (and unmute the rest of A, B and the others). Returns names MA refused to mute. */
  private async setMutes(muted: LiveRoom[]): Promise<string[]> {
    const hard = await this.mutes.set(new Set(muted.map((r) => r.playerId)));
    return hard.map((h) => h.name);
  }

  private async cleanup(): Promise<void> {
    this.running = false;
    await this.restoreVolumes();
    await this.mutes.restore();
    this.recorder.stop();
  }

  private setStage(stage: LiveStage): void {
    this.emit({ type: 'stage', data: stage });
  }

  private emit(event: LiveEvent): void {
    this.callback?.(event);
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
