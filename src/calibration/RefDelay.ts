/**
 * Reference-song delay analysis (dev-only song test).
 *
 * GroupSync plays a song it also holds, so the microphone can be compared against the exact source.
 * Whitened cross-correlation (GCC-PHAT) of the recording with the song shows one sharp peak per speaker:
 * where the peak sits is when that speaker's sound arrives. Unlike listening to unknown music blind, the
 * song's own pitch and rhythm cannot produce peaks here, because they are divided out.
 *
 *  - findOffset():  where in the recording the song starts (coarse search, done once)
 *  - RefTracker:    running PHAT cross-spectrum with forgetting, giving a lag curve at any moment
 *  - pickPeaks():   the peaks of a lag curve, with sub-sample position
 */
import { fft } from './LiveDelay';

export const REF_FRAME = 32768;
/** Lags examined around the aligned position, in ms (sound can only arrive after it left, plus a margin) */
export const LAG_MIN_MS = -40;
export const LAG_MAX_MS = 260;
const BAND_LO_HZ = 150;
const BAND_HI_HZ = 9000;

export interface RefPeak {
  /** Arrival time in ms relative to the alignment (only differences between peaks matter) */
  ms: number;
  /** Peak height divided by the typical background level of the curve */
  strength: number;
}

export interface RefCurve {
  startMs: number;
  /** Curve value per lag sample, starting at startMs, sampleRate spacing */
  values: Float64Array;
  sampleRate: number;
  frames: number;
}

const nextPow2 = (n: number) => 1 << Math.ceil(Math.log2(Math.max(2, n)));

/** Mono copy of an AudioBuffer-like set of channels */
export function toMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0];
  const out = new Float32Array(channels[0].length);
  for (const ch of channels) for (let i = 0; i < out.length; i++) out[i] += ch[i] / channels.length;
  return out;
}

/** Average groups of `factor` samples (crude low-pass plus decimation, enough for a coarse search) */
function decimate(x: Float32Array, factor: number): Float32Array {
  const out = new Float32Array(Math.floor(x.length / factor));
  for (let i = 0; i < out.length; i++) {
    let s = 0;
    for (let k = 0; k < factor; k++) s += x[i * factor + k];
    out[i] = s / factor;
  }
  return out;
}

function spectrum(x: Float32Array, start: number, n: number): { re: Float64Array; im: Float64Array } {
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const len = Math.min(n, Math.max(0, x.length - start));
  // Hann window so frame edges don't leak
  for (let i = 0; i < len; i++) re[i] = x[start + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / Math.max(1, len - 1)));
  fft(re, im);
  return { re, im };
}

/**
 * Find where the song sits inside the recording: returns the number of samples by which the recording is
 * later than the song (recording index = song index + offset), or null if the song isn't heard.
 *
 * `mic` is a stretch of the recording starting at `micStart` (samples); the song is searched from its
 * start to `maxSongSamples`. Done at a reduced rate so a long song stays fast.
 */
export function findOffset(
  song: Float32Array,
  mic: Float32Array,
  micStart: number,
  sampleRate: number,
  maxSongSamples: number
): { offset: number; quality: number } | null {
  const D = 8;
  const m = decimate(mic, D);
  const head = decimate(song.subarray(0, Math.min(song.length, maxSongSamples)), D);
  if (m.length < 2048 || head.length < m.length / 4) return null;
  // Silence in front of the song: the recording may begin before the song starts
  const s = new Float32Array(m.length + head.length);
  s.set(head, m.length);

  const N = nextPow2(m.length * 2);
  const hop = N - m.length;
  const M = spectrum(m, 0, N);
  const mMag = Array.from(M.re, (r, i) => Math.hypot(r, M.im[i]) + 1e-12);

  let best = { idx: -1, val: 0 };
  let sum = 0;
  let count = 0;
  for (let b = 0; b * hop < s.length; b++) {
    const S = spectrum(s, b * hop, N);
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    for (let k = 1; k < N / 2; k++) {
      // cross-spectrum  S * conj(M), whitened: peaks where the mic stretch begins inside the song block
      const cr = S.re[k] * M.re[k] + S.im[k] * M.im[k];
      const ci = S.im[k] * M.re[k] - S.re[k] * M.im[k];
      const mag = mMag[k] * (Math.hypot(S.re[k], S.im[k]) + 1e-12);
      re[k] = cr / mag;
      im[k] = ci / mag;
      re[N - k] = re[k];
      im[N - k] = -im[k];
    }
    fft(re, im, true);
    // lag l (song block start b*hop) -> recording index = song index + lag; only non-negative, valid lags
    for (let l = 0; l < hop; l++) {
      const v = re[l];
      sum += Math.abs(v);
      count++;
      if (v > best.val) best = { idx: b * hop + l, val: v };
    }
  }
  if (best.idx < 0) return null;
  const meanAbs = sum / Math.max(1, count);
  const quality = best.val / (meanAbs + 1e-12);
  // lag is "recording later than song" in decimated samples, relative to the mic stretch's own start
  // best.idx = song position where the mic stretch begins  =>  mic start corresponds to song sample best.idx*D
  const offset = micStart - (best.idx - m.length) * D;
  void sampleRate;
  return quality > 8 ? { offset, quality } : null;
}

/**
 * Running whitened cross-spectrum between recording frames and the aligned song frames. Frames are
 * accumulated with exponential forgetting, so the curve follows changes within about `memoryS` seconds.
 */
export class RefTracker {
  private readonly sr: number;
  private readonly N = REF_FRAME;
  private acc: { re: Float64Array; im: Float64Array } | null = null;
  private weight = 0;
  private memoryS: number;
  private readonly kLo: number;
  private readonly kHi: number;
  frames = 0;

  constructor(sampleRate: number, memoryS: number) {
    this.sr = sampleRate;
    this.memoryS = memoryS;
    this.kLo = Math.ceil((BAND_LO_HZ * this.N) / sampleRate);
    this.kHi = Math.floor((BAND_HI_HZ * this.N) / sampleRate);
  }

  setMemory(s: number): void {
    this.memoryS = s;
  }

  reset(): void {
    this.acc = null;
    this.weight = 0;
    this.frames = 0;
  }

  /**
   * Add one frame. `mic` and `song` are the same length (REF_FRAME) and already aligned, i.e. `song`
   * is the part of the song that should be playing during `mic`, with a margin for the lags examined.
   */
  push(mic: Float32Array, song: Float32Array): void {
    const N = this.N;
    const M = spectrum(mic, 0, N);
    const S = spectrum(song, 0, N);
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    for (let k = this.kLo; k <= this.kHi; k++) {
      const cr = M.re[k] * S.re[k] + M.im[k] * S.im[k];
      const ci = M.im[k] * S.re[k] - M.re[k] * S.im[k];
      const mag = Math.hypot(M.re[k], M.im[k]) * Math.hypot(S.re[k], S.im[k]) + 1e-12;
      re[k] = cr / mag;
      im[k] = ci / mag;
    }
    const frameS = N / this.sr;
    const keep = this.acc ? Math.exp(-frameS / this.memoryS) : 0;
    if (!this.acc) this.acc = { re: new Float64Array(N), im: new Float64Array(N) };
    for (let k = this.kLo; k <= this.kHi; k++) {
      this.acc.re[k] = this.acc.re[k] * keep + re[k];
      this.acc.im[k] = this.acc.im[k] * keep + im[k];
    }
    this.weight = this.weight * keep + 1;
    this.frames++;
  }

  curve(minFrames = 3): RefCurve | null {
    if (!this.acc || this.frames < minFrames) return null;
    const N = this.N;
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    for (let k = this.kLo; k <= this.kHi; k++) {
      re[k] = this.acc.re[k] / this.weight;
      im[k] = this.acc.im[k] / this.weight;
      re[N - k] = re[k];
      im[N - k] = -im[k];
    }
    fft(re, im, true);
    const lo = Math.round((LAG_MIN_MS / 1000) * this.sr);
    const hi = Math.round((LAG_MAX_MS / 1000) * this.sr);
    const values = new Float64Array(hi - lo + 1);
    for (let l = lo; l <= hi; l++) values[l - lo] = re[(l + N) % N];
    return { startMs: (lo / this.sr) * 1000, values, sampleRate: this.sr, frames: this.frames };
  }
}

/** Peaks of a lag curve, strongest first, each at least `minSepMs` from a stronger one */
export function pickPeaks(curve: RefCurve, count = 6, minSepMs = 0.6): RefPeak[] {
  const v = curve.values;
  // Background level: median of the absolute values
  const sorted = Float64Array.from(v, Math.abs).sort();
  const noise = sorted[Math.floor(sorted.length / 2)] + 1e-12;
  const cand: { i: number; h: number }[] = [];
  for (let i = 1; i < v.length - 1; i++) if (v[i] > v[i - 1] && v[i] >= v[i + 1] && v[i] > 0) cand.push({ i, h: v[i] });
  cand.sort((a, b) => b.h - a.h);
  const out: RefPeak[] = [];
  const sepSamples = (minSepMs / 1000) * curve.sampleRate;
  for (const c of cand) {
    if (out.length >= count) break;
    if (out.some((p) => Math.abs(((p.ms - curve.startMs) / 1000) * curve.sampleRate - c.i) < sepSamples)) continue;
    // parabolic refinement
    const a = v[c.i - 1];
    const b = v[c.i];
    const g = v[c.i + 1];
    const d = a - 2 * b + g;
    const frac = d !== 0 ? (0.5 * (a - g)) / d : 0;
    out.push({ ms: curve.startMs + ((c.i + frac) / curve.sampleRate) * 1000, strength: c.h / noise });
  }
  return out;
}
