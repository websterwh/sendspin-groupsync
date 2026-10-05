/**
 * Click Analyzer
 *
 * Offline analysis of a continuous microphone recording of the click track.
 *
 * Why offline: timing taken from performance.now() in audio callbacks is
 * quantised to the callback size (~43 ms) and jittery. Here every time is
 * derived from the recording's own sample clock, so resolution is ~1 ms.
 *
 * How the offset maths works:
 *  - The track is one continuous stream with a click every `intervalS`, cycling
 *    through the tone frequencies, so a click's frequency identifies its index
 *    (mod the number of frequencies) and its arrival time identifies the rest.
 *  - For every click: r = arrivalTime - index * intervalS. This equals
 *    (unknown start delay) + (that room's playout offset).
 *  - The unknown start delay is identical for every room (same stream, same
 *    recording), so it cancels when comparing rooms. Nothing about when the
 *    music server actually started playback is needed.
 *  - The phone's clock and the players' clocks differ by some ppm, which adds a
 *    slow linear drift. The first room is measured again at the end and the
 *    drift is removed linearly between the two measurements.
 */

export interface DetectedClick {
  /** Arrival time in seconds on the recording's timeline */
  time: number;
  /** Index into the frequency list */
  freqIndex: number;
  /** Peak envelope amplitude */
  strength: number;
}

export interface RoomWindow {
  playerId: string;
  /** Recording time (s) when the measurement window opens */
  startTime: number;
  /** Recording time (s) when it closes */
  endTime: number;
}

export interface RoomAnalysis {
  playerId: string;
  /** Number of usable clicks inside this window */
  clicks: number;
  /** Median of (arrival - nominal) after drift correction, in ms (relative to the first room) */
  arrivalMs: number | null;
  /** Robust spread (scaled MAD) of the per-click values, ms */
  spreadMs: number | null;
}

export interface AnalysisResult {
  rooms: RoomAnalysis[];
  /** Estimated clock drift between phone and players in ppm (null without a closing measurement) */
  driftPpm: number | null;
  /** Total clicks that were consistent with the track */
  usableClicks: number;
}

const ENVELOPE_WINDOW_S = 0.004; // 4 ms = whole periods of 500/1000/2000/3000 Hz at 48 kHz
const ENVELOPE_HOP_S = 0.001;

/**
 * Detect click bursts of the given frequencies in a recording.
 * `samples[0]` is at time `startTime` seconds.
 */
export function detectClicks(
  samples: Float32Array,
  sampleRate: number,
  frequencies: number[],
  startTime = 0
): DetectedClick[] {
  const clicks: DetectedClick[] = [];
  const W = Math.max(8, Math.round(ENVELOPE_WINDOW_S * sampleRate));
  const H = Math.max(1, Math.round(ENVELOPE_HOP_S * sampleRate));
  const frames = Math.floor((samples.length - W) / H);
  if (frames < 10) return clicks;

  const cosT = new Float64Array(W);
  const sinT = new Float64Array(W);
  const env = new Float32Array(frames);

  frequencies.forEach((freq, freqIndex) => {
    const w = (2 * Math.PI * freq) / sampleRate;
    for (let m = 0; m < W; m++) {
      cosT[m] = Math.cos(w * m);
      sinT[m] = Math.sin(w * m);
    }

    for (let f = 0; f < frames; f++) {
      const base = f * H;
      let i = 0;
      let q = 0;
      for (let m = 0; m < W; m++) {
        const x = samples[base + m];
        i += x * cosT[m];
        q += x * sinT[m];
      }
      env[f] = (2 * Math.sqrt(i * i + q * q)) / W;
    }

    // Noise floor: bursts occupy ~1% of the time for one frequency, so the median is noise
    const sorted = Float32Array.from(env).sort();
    const noise = sorted[Math.floor(sorted.length / 2)];
    const threshold = Math.max(noise * 8, 0.002);

    let f = 0;
    while (f < frames) {
      if (env[f] <= threshold) {
        f++;
        continue;
      }
      // Segment above threshold
      let end = f;
      let peakFrame = f;
      while (end < frames && env[end] > threshold * 0.5) {
        if (env[end] > env[peakFrame]) peakFrame = end;
        end++;
        // A burst is ~50 ms plus reverb; stop runaway segments (continuous tones)
        if (end - f > 400) break;
      }
      const peak = env[peakFrame];
      const length = end - f;
      if (peak >= threshold && length >= 15 && length <= 400) {
        // Rising edge: first crossing of 50% of the peak, linearly interpolated
        const half = peak * 0.5;
        let k = peakFrame;
        while (k > f && env[k - 1] > half) k--;
        let frac = 0;
        if (k > 0 && env[k] > half && env[k - 1] <= half) {
          frac = (half - env[k - 1]) / (env[k] - env[k - 1]);
          k -= 1;
        }
        const centerSample = (k + frac) * H + W / 2;
        clicks.push({ time: startTime + centerSample / sampleRate, freqIndex, strength: peak });
      }
      f = Math.max(end, f + 1);
    }
  });

  clicks.sort((a, b) => a.time - b.time);

  // Same-frequency clicks repeat every F*interval; anything much closer is a duplicate.
  // Cross-frequency leakage (a strong 1 kHz click showing up weakly at 2 kHz) is
  // removed by keeping only the strongest click inside a 100 ms neighbourhood.
  const kept: DetectedClick[] = [];
  for (const c of clicks) {
    const last = kept[kept.length - 1];
    if (last && c.time - last.time < 0.1) {
      if (c.strength > last.strength) kept[kept.length - 1] = c;
    } else {
      kept.push(c);
    }
  }
  return kept;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function mad(values: number[], med: number): number {
  return 1.4826 * median(values.map((v) => Math.abs(v - med)));
}

interface IndexedClick extends DetectedClick {
  index: number;
  residual: number; // arrival - index * interval (s)
}

/**
 * Assign each click its index in the track, dropping clicks that don't fit
 * the 1-click-per-interval pattern (noise, claps, speech).
 */
export function indexClicks(
  clicks: DetectedClick[],
  frequencyCount: number,
  intervalS: number,
  toleranceS = 0.4
): IndexedClick[] {
  if (clicks.length === 0) return [];

  let best: IndexedClick[] = [];
  // Any of the loudest early clicks could be the real anchor; keep the anchor that explains most clicks.
  const anchors = [...clicks].sort((a, b) => b.strength - a.strength).slice(0, 8);

  for (const anchor of anchors) {
    const candidate: IndexedClick[] = [];
    for (const c of clicks) {
      const steps = Math.round((c.time - anchor.time) / intervalS);
      const index = anchor.freqIndex + steps;
      const expectedTime = anchor.time + steps * intervalS;
      const freqOk = ((index % frequencyCount) + frequencyCount) % frequencyCount === c.freqIndex;
      if (freqOk && Math.abs(c.time - expectedTime) <= toleranceS) {
        candidate.push({ ...c, index, residual: c.time - index * intervalS });
      }
    }
    if (candidate.length > best.length) best = candidate;
  }

  // Remove clicks whose residual is far from the bulk (a different index with the same freq)
  if (best.length > 3) {
    const med = median(best.map((c) => c.residual));
    best = best.filter((c) => Math.abs(c.residual - med) <= toleranceS);
  }
  return best;
}

/**
 * Combine detected clicks and measurement windows into per-room offsets.
 * Windows are in measurement order; the first window is the reference. If a
 * later window uses the same player as the first, it is used to remove drift.
 */
export function analyzeRooms(
  clicks: DetectedClick[],
  windows: RoomWindow[],
  frequencyCount: number,
  intervalS: number
): AnalysisResult {
  const indexed = indexClicks(clicks, frequencyCount, intervalS);

  const stats = windows.map((win) => {
    const inside = indexed.filter((c) => c.time >= win.startTime && c.time <= win.endTime);
    if (inside.length === 0) {
      return { win, n: 0, med: NaN, spread: NaN, meanTime: NaN };
    }
    const res = inside.map((c) => c.residual);
    const med = median(res);
    // Drop outliers beyond 3 sigma of the robust spread (min 1 ms so tight data isn't over-trimmed)
    const sigma = Math.max(mad(res, med), 0.001);
    const trimmed = res.filter((r) => Math.abs(r - med) <= 3 * sigma);
    const tMed = median(trimmed);
    return {
      win,
      n: trimmed.length,
      med: tMed,
      spread: mad(trimmed, tMed),
      meanTime: inside.reduce((s, c) => s + c.time, 0) / inside.length,
    };
  });

  const ref = stats[0];
  let slope = 0; // seconds of residual drift per second of recording
  let driftPpm: number | null = null;
  if (ref && ref.n > 0) {
    const closing = stats.slice(1).find((s) => s.win.playerId === ref.win.playerId && s.n > 0);
    if (closing && closing.meanTime - ref.meanTime > 5) {
      slope = (closing.med - ref.med) / (closing.meanTime - ref.meanTime);
      driftPpm = slope * 1e6;
    }
  }

  const rooms: RoomAnalysis[] = stats.map((s) => {
    if (s.n === 0 || !ref || ref.n === 0) {
      return { playerId: s.win.playerId, clicks: 0, arrivalMs: null, spreadMs: null };
    }
    const corrected = s.med - slope * (s.meanTime - ref.meanTime);
    return {
      playerId: s.win.playerId,
      clicks: s.n,
      arrivalMs: (corrected - ref.med) * 1000,
      spreadMs: s.spread * 1000,
    };
  });

  return { rooms, driftPpm, usableClicks: indexed.length };
}
