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

/** Coarse matches weaker than this (peak over the average level) are not even tried */
const MIN_MATCH_QUALITY = 9;

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

const decimatedSongs = new WeakMap<Float32Array, Float32Array>();

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
): { offset: number; quality: number }[] {
  const D = 8;
  const m = decimate(mic, D);
  let full = decimatedSongs.get(song);
  if (!full) {
    full = decimate(song, D);
    decimatedSongs.set(song, full);
  }
  const head = full.subarray(0, Math.min(full.length, Math.ceil(maxSongSamples / D)));
  if (m.length < 2048 || head.length < m.length / 4) return [];
  // Silence in front of the song: the recording may begin before the song starts
  const s = new Float32Array(m.length + head.length);
  s.set(head, m.length);

  const N = nextPow2(m.length * 2);
  const hop = N - m.length;
  const M = spectrum(m, 0, N);
  const mMag = Array.from(M.re, (r, i) => Math.hypot(r, M.im[i]) + 1e-12);

  const blockBest: { idx: number; val: number }[] = [];
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
    let top = { idx: -1, val: 0 };
    for (let l = 0; l < hop; l++) {
      const v = re[l];
      sum += Math.abs(v);
      count++;
      if (v > top.val) top = { idx: b * hop + l, val: v };
    }
    if (top.idx >= 0) blockBest.push(top);
  }
  const meanAbs = sum / Math.max(1, count);
  // The best few matches (one per stretch of the song, strongest first): the caller confirms them in detail
  // best.idx = song position where the mic stretch begins  =>  mic start corresponds to song sample best.idx*D
  void sampleRate;
  return blockBest
    .sort((x, y) => y.val - x.val)
    .slice(0, 3)
    .map((c) => ({ offset: micStart - (c.idx - m.length) * D, quality: c.val / (meanAbs + 1e-12) }))
    .filter((c) => c.quality > MIN_MATCH_QUALITY);
}

/**
 * Running whitened cross-spectrum between recording frames and the aligned song frames. Frames are
 * accumulated with exponential forgetting, so the curve follows changes within about `memoryS` seconds.
 */
export class RefTracker {
  private readonly sr: number;
  private readonly N = REF_FRAME;
  private acc: { re: Float64Array; im: Float64Array; pm: Float64Array; ps: Float64Array } | null = null;
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
    const frameS = N / this.sr;
    const keep = this.acc ? Math.exp(-frameS / this.memoryS) : 0;
    if (!this.acc) this.acc = { re: new Float64Array(N), im: new Float64Array(N), pm: new Float64Array(N), ps: new Float64Array(N) };
    const a = this.acc;
    // Cross-spectrum and the two power spectra, summed over frames. Normalising once at the end by the
    // summed powers (instead of each frame on its own) lets loud passages count for more than quiet ones
    // and silence, which only carries noise.
    for (let k = this.kLo; k <= this.kHi; k++) {
      a.re[k] = a.re[k] * keep + (M.re[k] * S.re[k] + M.im[k] * S.im[k]);
      a.im[k] = a.im[k] * keep + (M.im[k] * S.re[k] - M.re[k] * S.im[k]);
      a.pm[k] = a.pm[k] * keep + (M.re[k] * M.re[k] + M.im[k] * M.im[k]);
      a.ps[k] = a.ps[k] * keep + (S.re[k] * S.re[k] + S.im[k] * S.im[k]);
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
      const norm = Math.sqrt(this.acc.pm[k] * this.acc.ps[k]) + 1e-12;
      re[k] = this.acc.re[k] / norm;
      im[k] = this.acc.im[k] / norm;
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


// ==================== following two speakers by their learned echo patterns ====================

export interface SpeakerFit {
  /** Where each speaker's direct sound is now, in ms on the curve's axis */
  aMs: number;
  bMs: number;
  /** How clearly each one stands out (correlation peak over its background) */
  strengthA: number;
  strengthB: number;
}

const FIT_N = 32768;

/**
 * Each speaker alone leaves a characteristic pattern on the lag curve: a direct peak followed by its room's
 * echoes. With both playing, the curve is the two patterns added, each shifted by that speaker's delay. So
 * instead of guessing which peak is which, slide each learned pattern along the curve and take the shift
 * that matches best (A first, take it out, then B, and once more to refine). This copes with a quiet speaker
 * hiding under a loud one's echoes and with the two peaks sitting on top of each other.
 */
export function fitSpeakers(
  live: RefCurve,
  tplA: RefCurve,
  tplB: RefCurve,
  limitAMs = 30,
  limitBMs = 200
): SpeakerFit {
  const n = live.values.length;
  const sr = live.sampleRate;
  const centre = (v: Float64Array) => {
    const sorted = Float64Array.from(v).sort();
    const med = sorted[Math.floor(sorted.length / 2)];
    return Float64Array.from(v, (x) => x - med);
  };
  const L = centre(live.values);
  /** Template: the learned curve around its strongest peak (direct sound plus the echoes after it) */
  const makeTemplate = (c: RefCurve) => {
    const t = centre(c.values);
    let pk = 0;
    for (let i = 1; i < t.length; i++) if (t[i] > t[pk]) pk = i;
    const lo = Math.max(0, pk - Math.round(0.01 * sr));
    const hi = Math.min(t.length - 1, pk + Math.round(0.06 * sr));
    const out = new Float64Array(t.length);
    let energy = 0;
    for (let i = lo; i <= hi; i++) {
      out[i] = t[i];
      energy += t[i] * t[i];
    }
    return { t: out, energy: energy || 1, peak: pk };
  };
  const A = makeTemplate(tplA);
  const B = makeTemplate(tplB);

  const re = new Float64Array(FIT_N);
  const im = new Float64Array(FIT_N);
  /** Correlation of x with template t at shifts -S..S (returned as a map from shift to value) */
  const correlate = (x: Float64Array, t: Float64Array, S: number) => {
    re.fill(0);
    im.fill(0);
    re.set(x.subarray(0, Math.min(n, FIT_N)));
    fft(re, im);
    const fr = Float64Array.from(re);
    const fi = Float64Array.from(im);
    re.fill(0);
    im.fill(0);
    re.set(t.subarray(0, Math.min(n, FIT_N)));
    fft(re, im);
    const cr = new Float64Array(FIT_N);
    const ci = new Float64Array(FIT_N);
    for (let k = 0; k < FIT_N; k++) {
      cr[k] = fr[k] * re[k] + fi[k] * im[k];
      ci[k] = fi[k] * re[k] - fr[k] * im[k];
    }
    fft(cr, ci, true);
    const out = new Float64Array(2 * S + 1);
    for (let s = -S; s <= S; s++) out[s + S] = cr[(s + FIT_N) % FIT_N] / FIT_N;
    return out;
  };
  const best = (c: Float64Array, S: number, energy: number) => {
    let bi = 0;
    for (let i = 1; i < c.length; i++) if (c[i] > c[bi]) bi = i;
    // parabolic refinement
    let frac = 0;
    if (bi > 0 && bi < c.length - 1) {
      const d = c[bi - 1] - 2 * c[bi] + c[bi + 1];
      if (d !== 0) frac = (0.5 * (c[bi - 1] - c[bi + 1])) / d;
    }
    const abs = Float64Array.from(c, Math.abs).sort();
    const noise = abs[Math.floor(abs.length / 2)] + 1e-12;
    return { shift: bi - S + frac, gain: c[bi] / energy, strength: c[bi] / noise };
  };
  const shifted = (t: Float64Array, s: number, gain: number) => {
    const out = new Float64Array(n);
    const k = Math.round(s);
    for (let i = 0; i < n; i++) {
      const j = i - k;
      if (j >= 0 && j < n) out[i] = gain * t[j];
    }
    return out;
  };
  const SA = Math.round((limitAMs / 1000) * sr);
  const SB = Math.round((limitBMs / 1000) * sr);
  let fa = { shift: 0, gain: 0, strength: 0 };
  let fb = { shift: 0, gain: 0, strength: 0 };
  for (let iter = 0; iter < 3; iter++) {
    const bPart = fb.gain ? shifted(B.t, fb.shift, fb.gain) : null;
    const withoutB = bPart ? Float64Array.from(L, (x, i) => x - bPart[i]) : L;
    fa = best(correlate(withoutB, A.t, SA), SA, A.energy);
    const aPart = shifted(A.t, fa.shift, fa.gain);
    const withoutA = Float64Array.from(L, (x, i) => x - aPart[i]);
    fb = best(correlate(withoutA, B.t, SB), SB, B.energy);
  }
  const ms = (idx: number) => live.startMs + (idx / sr) * 1000;
  return {
    aMs: ms(A.peak + fa.shift),
    bMs: ms(B.peak + fb.shift),
    strengthA: fa.strength,
    strengthB: fb.strength,
  };
}
