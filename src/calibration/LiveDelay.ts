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
}

export interface DelayPeak {
  delayMs: number;
  /** Peak height relative to the noise in the lag curve */
  strength: number;
}

export interface LiveDelayResult {
  /** Strongest peak (the offset between the two speakers), or null if nothing stands out */
  best: DelayPeak | null;
  peaks: DelayPeak[];
  frames: number;
}

export function estimateDelay(samples: Float32Array, sampleRate: number, options: LiveDelayOptions = {}): LiveDelayResult {
  const N = options.frameSize ?? 32768;
  const minMs = options.minMs ?? 2;
  const maxMs = options.maxMs ?? 250;
  const [loHz, hiHz] = options.bandHz ?? [300, 8000];
  const smoothHz = options.smoothHz ?? 600;
  const hop = N / 2;
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

  for (let start = 0; start + N <= samples.length; start += hop) {
    let energy = 0;
    for (let i = 0; i < N; i++) {
      const v = samples[start + i] * hann[i];
      re[i] = v;
      im[i] = 0;
      energy += v * v;
    }
    if (energy < 1e-9) continue; // silence
    fft(re, im);
    for (let k = 0; k <= N / 2; k++) power[k] = re[k] * re[k] + im[k] * im[k];
    prefix[0] = 0;
    for (let k = 0; k <= N / 2; k++) prefix[k + 1] = prefix[k] + power[k];
    for (let k = kLo; k <= kHi; k++) {
      const a = Math.max(0, k - halfWin);
      const b = Math.min(N / 2, k + halfWin);
      const smooth = (prefix[b + 1] - prefix[a]) / (b - a + 1);
      acc[k] += power[k] / (smooth + 1e-18);
    }
    frames++;
  }
  if (frames < 4) return { best: null, peaks: [], frames };

  // Average whitened spectrum minus its expected value (1) = the comb ripple; back to the lag domain
  for (let i = 0; i < N; i++) {
    re[i] = 0;
    im[i] = 0;
  }
  for (let k = kLo; k <= kHi; k++) {
    const d = acc[k] / frames - 1;
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

  const peaks: DelayPeak[] = [];
  const guard = Math.max(2, Math.round(0.0005 * sampleRate)); // local-maximum neighbourhood, 0.5 ms
  for (let i = guard; i < curve.length - guard; i++) {
    let isMax = curve[i] > 0;
    for (let j = 1; isMax && j <= guard; j++) if (curve[i - j] >= curve[i] || curve[i + j] > curve[i]) isMax = false;
    if (!isMax) continue;
    const y0 = curve[i - 1];
    const y1 = curve[i];
    const y2 = curve[i + 1];
    const denom = y0 - 2 * y1 + y2;
    const frac = denom < 0 ? Math.max(-1, Math.min(1, (0.5 * (y0 - y2)) / denom)) : 0;
    peaks.push({
      delayMs: (((i + lagLo + frac) / sampleRate) * 1000),
      strength: (y1 - median) / noise,
    });
  }
  peaks.sort((a, b) => b.strength - a.strength);
  const best = peaks.length > 0 && peaks[0].strength >= 5 ? peaks[0] : null;
  return { best, peaks: peaks.slice(0, 5), frames };
}
