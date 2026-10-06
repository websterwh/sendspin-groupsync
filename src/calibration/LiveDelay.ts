/**
 * Live delay estimation from ordinary music or speech (no click track).
 *
 * Two speakers playing the same audio with a small offset d make the microphone hear the signal plus a
 * delayed copy of itself. In the frequency domain that is a "comb": the power spectrum gets a ripple whose
 * period is 1/d. The music's own spectrum swamps that ripple in any single moment, so:
 *   1. each short frame's power spectrum is divided by its own smoothed spectrum (whitening), which makes
 *      music look like noise and leaves the ripple,
 *   2. many frames are averaged (the music's own structure changes from frame to frame and averages
 *      out, the speakers' comb stays put),
 *   3. the inverse transform of that average has a peak at lag d.
 * The result is the SIZE of the offset between two speakers, not which one is ahead (a recording of an
 * unknown signal can't tell), so it is used to watch an offset change over time.
 */

/** In-place iterative radix-2 FFT (re/im length must be a power of two). */
export function fft(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

export interface LiveDelayOptions {
  /** FFT frame length in samples (power of two); must exceed the largest delay by a wide margin */
  frameSize?: number;
  minMs?: number;
  maxMs?: number;
  /** Frequency band used (speakers and phone mics are weak outside it) */
  bandHz?: [number, number];
  /** Width of the smoothing used for whitening */
  smoothHz?: number;
  /** Frames advance by this fraction of the frame length (1 = no overlap) */
  hopFraction?: number;
  /** Called every few frames; await it to let the UI breathe during a long estimate */
  yieldToUi?: () => Promise<void>;
}

export interface DelayPeak {
  delayMs: number;
  /** Peak height relative to the noise in the lag curve */
  strength: number;
}

/** The lag curve behind an estimate: strength (in noise units) of an echo at each lag */
export interface LagCurve {
  /** Strength per lag, starting at lagLo samples */
  strength: Float64Array;
  lagLo: number;
  sampleRate: number;
  frames: number;
}

export interface LiveDelayResult {
  /** Strongest peak (the offset between the two speakers), or null if nothing stands out */
  best: DelayPeak | null;
  peaks: DelayPeak[];
  frames: number;
}

export async function computeLagCurve(
  samples: Float32Array,
  sampleRate: number,
  options: LiveDelayOptions = {}
): Promise<LagCurve | null> {
  const N = options.frameSize ?? 32768;
  const minMs = options.minMs ?? 1.5;
  const maxMs = options.maxMs ?? 250;
  const [loHz, hiHz] = options.bandHz ?? [300, 8000];
  const smoothHz = options.smoothHz ?? 800;
  const hop = Math.max(1, Math.round(N * (options.hopFraction ?? 1)));
  const binHz = sampleRate / N;
  const kLo = Math.max(1, Math.round(loHz / binHz));
  const kHi = Math.min(N / 2 - 1, Math.round(hiHz / binHz));
  const halfWin = Math.max(2, Math.round(smoothHz / binHz / 2));

  const hann = new Float64Array(N);
  for (let i = 0; i < N; i++) hann[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / N));

  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const acc = new Float64Array(N / 2 + 1);
  const power = new Float64Array(N / 2 + 1);
  const prefix = new Float64Array(N / 2 + 2);
  let frames = 0;

  const accumulate = () => {
    prefix[0] = 0;
    for (let k = 0; k <= N / 2; k++) prefix[k + 1] = prefix[k] + power[k];
    for (let k = kLo; k <= kHi; k++) {
      const a = Math.max(0, k - halfWin);
      const b = Math.min(N / 2, k + halfWin);
      const smooth = (prefix[b + 1] - prefix[a]) / (b - a + 1);
      acc[k] += power[k] / (smooth + 1e-18);
    }
    frames++;
  };

  // Two real frames share one complex FFT (one in the real part, one in the imaginary part)
  const starts: number[] = [];
  for (let start = 0; start + N <= samples.length; start += hop) starts.push(start);
  for (let f = 0; f < starts.length; f += 2) {
    const s1 = starts[f];
    const s2 = f + 1 < starts.length ? starts[f + 1] : -1;
    let e1 = 0;
    let e2 = 0;
    for (let i = 0; i < N; i++) {
      const v1 = samples[s1 + i] * hann[i];
      const v2 = s2 >= 0 ? samples[s2 + i] * hann[i] : 0;
      re[i] = v1;
      im[i] = v2;
      e1 += v1 * v1;
      e2 += v2 * v2;
    }
    fft(re, im);
    // Separate the two spectra: X1 = (Z[k] + conj(Z[N-k])) / 2, X2 = (Z[k] - conj(Z[N-k])) / 2j
    if (e1 >= 1e-9) {
      for (let k = 0; k <= N / 2; k++) {
        const nk = (N - k) % N;
        const xr = 0.5 * (re[k] + re[nk]);
        const xi = 0.5 * (im[k] - im[nk]);
        power[k] = xr * xr + xi * xi;
      }
      accumulate();
    }
    if (s2 >= 0 && e2 >= 1e-9) {
      for (let k = 0; k <= N / 2; k++) {
        const nk = (N - k) % N;
        const xr = 0.5 * (im[k] + im[nk]);
        const xi = -0.5 * (re[k] - re[nk]);
        power[k] = xr * xr + xi * xi;
      }
      accumulate();
    }
    if (options.yieldToUi && (f / 2) % 6 === 5) await options.yieldToUi();
  }
  if (frames < 4) return null;

  const avg = new Float64Array(N / 2 + 1);
  for (let k = kLo; k <= kHi; k++) avg[k] = acc[k] / frames;
  return lagCurveFromAverage(avg, N, sampleRate, kLo, kHi, minMs, maxMs, frames);
}

/**
 * From the average whitened spectrum to the lag curve: the average minus its expected value (1) is the
 * comb ripple, and its inverse transform has a peak at each echo delay.
 */
function lagCurveFromAverage(
  avg: Float64Array,
  N: number,
  sampleRate: number,
  kLo: number,
  kHi: number,
  minMs: number,
  maxMs: number,
  frames: number
): LagCurve {
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let k = kLo; k <= kHi; k++) {
    const d = avg[k] - 1;
    re[k] = d;
    re[N - k] = d;
  }
  fft(re, im, true);

  const lagLo = Math.max(2, Math.round((minMs / 1000) * sampleRate));
  const lagHi = Math.min(N / 2 - 2, Math.round((maxMs / 1000) * sampleRate));
  const curve = new Float64Array(lagHi - lagLo + 1);
  for (let n = lagLo; n <= lagHi; n++) curve[n - lagLo] = re[n] / N;

  // Noise level of the curve: robust spread of its values
  const sorted = Float64Array.from(curve).sort();
  const median = sorted[Math.floor(sorted.length / 2)];
  const dev = Float64Array.from(curve, (v) => Math.abs(v - median)).sort();
  const noise = Math.max(1.4826 * dev[Math.floor(dev.length / 2)], 1e-12);

  const strength = Float64Array.from(curve, (v) => (v - median) / noise);
  return { strength, lagLo, sampleRate, frames };
}

/**
 * Streaming version: feed audio as it arrives and read the current estimate at any time. Each new frame is
 * added to a running average in which older frames fade out (memoryS is roughly how long they count), so a
 * change in the gap shows up within a few seconds instead of after a whole fixed window.
 */
export class LagCurveTracker {
  private readonly N: number;
  private readonly hop: number;
  private readonly sampleRate: number;
  private readonly kLo: number;
  private readonly kHi: number;
  private readonly halfWin: number;
  private readonly minMs: number;
  private readonly maxMs: number;
  private readonly hann: Float64Array;
  private readonly re: Float64Array;
  private readonly im: Float64Array;
  private readonly power: Float64Array;
  private readonly prefix: Float64Array;
  private acc: Float64Array;
  private weight = 0;
  private buffer = new Float32Array(0);
  private decay: number;
  /** Frames folded into the running average since the last reset (not faded) */
  frames = 0;

  constructor(sampleRate: number, options: LiveDelayOptions & { memoryS?: number } = {}) {
    this.sampleRate = sampleRate;
    this.N = options.frameSize ?? 32768;
    this.hop = Math.max(1, Math.round(this.N * (options.hopFraction ?? 0.5)));
    this.minMs = options.minMs ?? 1.5;
    this.maxMs = options.maxMs ?? 250;
    const [loHz, hiHz] = options.bandHz ?? [300, 8000];
    const binHz = sampleRate / this.N;
    this.kLo = Math.max(1, Math.round(loHz / binHz));
    this.kHi = Math.min(this.N / 2 - 1, Math.round(hiHz / binHz));
    this.halfWin = Math.max(2, Math.round((options.smoothHz ?? 800) / binHz / 2));
    this.hann = new Float64Array(this.N);
    for (let i = 0; i < this.N; i++) this.hann[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / this.N));
    this.re = new Float64Array(this.N);
    this.im = new Float64Array(this.N);
    this.power = new Float64Array(this.N / 2 + 1);
    this.prefix = new Float64Array(this.N / 2 + 2);
    this.acc = new Float64Array(this.N / 2 + 1);
    this.decay = 1;
    this.setMemory(options.memoryS ?? 15);
  }

  /** How long (seconds, roughly) audio keeps counting. Shorter reacts faster but is noisier. */
  setMemory(memoryS: number): void {
    this.decay = Math.exp(-(this.hop / this.sampleRate) / Math.max(1, memoryS / 2));
  }

  /** Forget everything heard so far */
  reset(): void {
    this.acc.fill(0);
    this.weight = 0;
    this.frames = 0;
    this.buffer = new Float32Array(0);
  }

  /** Mark a break in the audio: frames never span it (use between separate stretches of audio) */
  endBlock(): void {
    this.buffer = new Float32Array(0);
  }

  /** Add newly recorded audio; returns how many frames it completed */
  async push(samples: Float32Array): Promise<number> {
    const merged = new Float32Array(this.buffer.length + samples.length);
    merged.set(this.buffer, 0);
    merged.set(samples, this.buffer.length);
    this.buffer = merged;
    let done = 0;
    let offset = 0;
    while (offset + this.N <= this.buffer.length) {
      if (this.addFrame(offset)) done++;
      offset += this.hop;
    }
    this.buffer = this.buffer.slice(offset);
    return done;
  }

  private addFrame(offset: number): boolean {
    const { N, re, im, power, prefix, hann } = this;
    let energy = 0;
    for (let i = 0; i < N; i++) {
      const v = this.buffer[offset + i] * hann[i];
      re[i] = v;
      im[i] = 0;
      energy += v * v;
    }
    if (energy < 1e-9) return false; // silence
    fft(re, im);
    for (let k = 0; k <= N / 2; k++) power[k] = re[k] * re[k] + im[k] * im[k];
    prefix[0] = 0;
    for (let k = 0; k <= N / 2; k++) prefix[k + 1] = prefix[k] + power[k];
    const frame = new Float64Array(N / 2 + 1);
    for (let k = this.kLo; k <= this.kHi; k++) {
      const a = Math.max(0, k - this.halfWin);
      const b = Math.min(N / 2, k + this.halfWin);
      frame[k] = power[k] / ((prefix[b + 1] - prefix[a]) / (b - a + 1) + 1e-18);
    }
    for (let k = this.kLo; k <= this.kHi; k++) this.acc[k] = this.acc[k] * this.decay + frame[k];
    this.weight = this.weight * this.decay + 1;
    this.frames++;
    return true;
  }

  /** The current lag curve, or null until enough audio has been heard */
  curve(minFrames = 8): LagCurve | null {
    if (this.frames < minFrames || this.weight <= 0) return null;
    const avg = new Float64Array(this.N / 2 + 1);
    for (let k = this.kLo; k <= this.kHi; k++) avg[k] = this.acc[k] / this.weight;
    return lagCurveFromAverage(avg, this.N, this.sampleRate, this.kLo, this.kHi, this.minMs, this.maxMs, this.frames);
  }
}

/** Local maxima of a strength curve, strongest first */
export function findPeaks(curve: LagCurve, minStrength = 0): DelayPeak[] {
  const { strength, lagLo, sampleRate } = curve;
  const guard = Math.max(2, Math.round(0.0005 * sampleRate)); // local-maximum neighbourhood, 0.5 ms
  const peaks: DelayPeak[] = [];
  for (let i = guard; i < strength.length - guard; i++) {
    if (strength[i] <= minStrength) continue;
    let isMax = true;
    for (let j = 1; isMax && j <= guard; j++) if (strength[i - j] >= strength[i] || strength[i + j] > strength[i]) isMax = false;
    if (!isMax) continue;
    const y0 = strength[i - 1];
    const y1 = strength[i];
    const y2 = strength[i + 1];
    const denom = y0 - 2 * y1 + y2;
    const frac = denom < 0 ? Math.max(-1, Math.min(1, (0.5 * (y0 - y2)) / denom)) : 0;
    peaks.push({ delayMs: ((i + lagLo + frac) / sampleRate) * 1000, strength: y1 });
  }
  return peaks.sort((a, b) => b.strength - a.strength);
}

/**
 * Remove what the room does to each speaker on its own. `baselines` are curves recorded with only one
 * speaker playing; a reflection shows up in those too. In the mix each speaker supplies only its share of
 * the power, so each baseline is scaled by that share (`weights`, summing to 1) before it is subtracted
 * (with a little give for small shifts). What is left is the echo that only exists when both play.
 */
export function subtractBaselines(mix: LagCurve, baselines: LagCurve[], weights: number[], toleranceMs = 0.4): LagCurve {
  const tol = Math.max(1, Math.round((toleranceMs / 1000) * mix.sampleRate));
  const out = new Float64Array(mix.strength.length);
  for (let i = 0; i < out.length; i++) {
    let base = 0;
    baselines.forEach((b, n) => {
      if (b.lagLo !== mix.lagLo || b.sampleRate !== mix.sampleRate) return;
      let peak = 0;
      for (let j = Math.max(0, i - tol); j <= Math.min(b.strength.length - 1, i + tol); j++) peak = Math.max(peak, b.strength[j]);
      base += (weights[n] ?? 1 / baselines.length) * peak;
    });
    out[i] = mix.strength[i] - base;
  }
  return { ...mix, strength: out };
}

/** Pick the gap from a curve; null if nothing stands out */
export function bestPeak(curve: LagCurve, minStrength = 8): { best: DelayPeak | null; peaks: DelayPeak[] } {
  const peaks = findPeaks(curve, 0).slice(0, 5);
  const best = peaks.length > 0 && peaks[0].strength >= minStrength ? peaks[0] : null;
  return { best, peaks };
}

/** One-shot estimate with no baseline (reflections and the music's own pitch can show up as false gaps) */
export async function estimateDelay(
  samples: Float32Array,
  sampleRate: number,
  options: LiveDelayOptions = {}
): Promise<LiveDelayResult> {
  const curve = await computeLagCurve(samples, sampleRate, options);
  if (!curve) return { best: null, peaks: [], frames: 0 };
  return { ...bestPeak(curve), frames: curve.frames };
}

/** Pearson correlation of two equally long curves (how alike their shapes are, -1 to 1) */
export function curveCorrelation(a: Float64Array, b: Float64Array): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}

export function maxStrength(curve: LagCurve): number {
  let m = 0;
  for (let i = 0; i < curve.strength.length; i++) if (curve.strength[i] > m) m = curve.strength[i];
  return m;
}
