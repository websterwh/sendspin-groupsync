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
import { computeLagCurve, subtractBaselines, bestPeak, type DelayPeak, type LagCurve } from './LiveDelay';
import { maClient } from '../ma-client';

export interface LiveRoom {
  playerId: string;
  name: string;
  /** Mute state before the test; restored afterwards */
  muted?: boolean;
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
}

export type LiveEventType = 'stage' | 'reading' | 'mute_problems' | 'level' | 'error';
export interface LiveEvent {
  type: LiveEventType;
  data?: unknown;
}

export interface LiveOptions {
  /** Seconds of audio learned per speaker */
  baselineS?: number;
  /** Seconds analysed per reading */
  windowS?: number;
  /** Seconds between readings */
  intervalS?: number;
  /** Settling time after muting before audio counts */
  guardS?: number;
  /** Weakest peak that counts as a gap (in noise units) */
  minStrength?: number;
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

const MUSIC_LEVEL = 0.002;
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
  private muteProblems = new Map<string, string>();
  private mutesChanged = false;
  private recent: number[] = [];
  private opts: Required<LiveOptions>;
  private curveA: LagCurve | null = null;
  private curveB: LagCurve | null = null;
  private weights: number[] = [0.5, 0.5];
  private liveStart = 0;
  private relearn = false;

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
    this.recorder = recorder;
    this.opts = {
      baselineS: options.baselineS ?? 20,
      windowS: options.windowS ?? 30,
      intervalS: options.intervalS ?? 5,
      guardS: options.guardS ?? 2.5,
      minStrength: options.minStrength ?? 12,
    };
  }

  /** Start without learning the room's echoes (faster, but reflections can show up as false gaps). */
  skipLearning(): void {
    this.skipBaseline = true;
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
    const { baselineS, guardS } = this.opts;
    this.curveA = this.curveB = null;

    this.setStage('learn_a');
    const failA = await this.setMutes([this.b, ...this.others]);
    const a = await this.record(guardS, baselineS);
    if (!a || !this.running || this.skipBaseline) return;
    const curveA = await computeLagCurve(a, this.recorder.sampleRate, { yieldToUi });

    this.setStage('learn_b');
    const failB = await this.setMutes([this.a, ...this.others]);
    const b = await this.record(guardS, baselineS);
    if (!b || !this.running || this.skipBaseline) return;
    const curveB = await computeLagCurve(b, this.recorder.sampleRate, { yieldToUi });

    // If a speaker that should have been silent was still playing, its "alone" recording contains the
    // gap itself, and subtracting it would hide the real gap. Better to run without the correction.
    if (failA.length > 0 || failB.length > 0) return;

    this.curveA = curveA;
    this.curveB = curveB;
    const eA = energy(a);
    const eB = energy(b);
    this.weights = [(BASELINE_SHARE * eA) / (eA + eB || 1), (BASELINE_SHARE * eB) / (eA + eB || 1)];
  }

  private async liveLoop(): Promise<void> {
    const { windowS, intervalS, guardS } = this.opts;
    this.setStage('live');
    await this.setMutes([...this.others]);
    this.liveStart = this.recorder.elapsed + guardS;
    // First reading once there is enough audio to analyse; then one every intervalS
    const minS = Math.min(windowS, 20);
    let next = this.liveStart + minS;
    while (this.running && !this.relearn) {
      await sleep(500);
      this.emit({ type: 'level', data: this.recorder.level });
      const now = this.recorder.elapsed;
      if (now < next) continue;
      next = now + intervalS;
      const from = Math.max(this.liveStart, now - windowS);
      const samples = this.recorder.getSamples(from, now);
      const mix = await computeLagCurve(samples, this.recorder.sampleRate, { yieldToUi });
      if (!mix || !this.running) continue;
      const learned = this.curveA && this.curveB;
      const curve = learned ? subtractBaselines(mix, [this.curveA!, this.curveB!], this.weights) : mix;
      const { best, peaks } = bestPeak(curve, this.opts.minStrength);
      const delayMs = best?.delayMs ?? null;
      // Locked: the last three readings agree within 0.5 ms (or 3%)
      this.recent = delayMs === null ? [] : [...this.recent, delayMs].slice(-3);
      const locked =
        this.recent.length === 3 &&
        Math.max(...this.recent) - Math.min(...this.recent) <= Math.max(0.5, 0.03 * delayMs!);
      this.emit({
        type: 'reading',
        data: {
          t: now - this.liveStart,
          delayMs,
          strength: best?.strength ?? peaks[0]?.strength ?? 0,
          others: peaks.filter((p) => p !== best).slice(0, 3),
          locked,
          usedBaseline: !!learned,
        } satisfies LiveReading,
      });
    }
  }

  /** Record `seconds` of audio after a settling time; null if cancelled */
  private async record(guardS: number, seconds: number): Promise<Float32Array | null> {
    const start = this.recorder.elapsed + guardS;
    while (this.running && !this.skipBaseline && this.recorder.elapsed < start + seconds) {
      await sleep(500);
      this.emit({ type: 'level', data: this.recorder.level });
    }
    return this.running && !this.skipBaseline ? this.recorder.getSamples(start, start + seconds) : null;
  }

  // ==================== muting ====================

  /** Mute exactly `muted` (and unmute the rest of A, B and the others), verifying each took effect */
  private async setMutes(muted: LiveRoom[]): Promise<string[]> {
    const all = [this.a, this.b, ...this.others];
    const mutedIds = new Set(muted.map((r) => r.playerId));
    const failed = new Map<string, string>();
    await Promise.all(
      all.map(async (room) => {
        const shouldMute = mutedIds.has(room.playerId);
        try {
          await maClient.playerCommand(room.playerId, 'volume_mute', { muted: shouldMute });
          this.mutesChanged = true;
        } catch (error) {
          if (shouldMute) failed.set(room.name, error instanceof Error ? error.message : String(error));
        }
      })
    );
    await sleep(600);
    await Promise.all(
      muted
        .filter((room) => !failed.has(room.name))
        .map(async (room) => {
          try {
            const p = await maClient.getPlayer(room.playerId);
            if ((p.volume_muted ?? p.muted) === false) failed.set(room.name, 'still unmuted');
          } catch {
            // can't verify
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
      this.emit({ type: 'mute_problems', data: Array.from(this.muteProblems, ([name, reason]) => ({ name, reason })) });
    }
    return Array.from(failed.keys());
  }

  private async cleanup(): Promise<void> {
    this.running = false;
    if (this.mutesChanged) {
      this.mutesChanged = false;
      await Promise.all(
        [this.a, this.b, ...this.others].map((room) =>
          maClient.playerCommand(room.playerId, 'volume_mute', { muted: room.muted ?? false }).catch(() => undefined)
        )
      );
    }
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
const yieldToUi = () => sleep(0);
