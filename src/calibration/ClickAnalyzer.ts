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
  /** Peak amplitude relative to the noise floor for that frequency */
  snr: number;
  /** Width of the burst at half its peak (ms). A single speaker gives ~25 ms; two overlapping speakers give more. */
  widthMs: number;
}

export interface RoomWindow {
  playerId: string;
  /** 'primary' = the room's measurement; 'closing' = the reference room measured again to estimate drift */
  kind: 'primary' | 'closing';
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
  /** Median click width at half peak (ms); well above ~33 suggests more than one speaker was audible */
  widthMs: number | null;
  /** Median signal-to-noise ratio of the clicks */
  snr: number | null;
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
    // Relative to the room's noise, with only a tiny absolute floor so quiet speakers (e.g. a Chromecast
    // at modest volume) still register
    const threshold = Math.max(noise * 6, 0.0004);

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
        const riseFrame = k + frac;
        // Falling edge: first crossing of 50% after the peak
        let j = peakFrame;
        while (j < end && env[j] > half) j++;
        let fallFrame = j;
        if (j > 0 && j < frames && env[j - 1] > half && env[j] <= half) {
          fallFrame = j - 1 + (env[j - 1] - half) / (env[j - 1] - env[j]);
        }
        const centerSample = riseFrame * H + W / 2;
        clicks.push({
          time: startTime + centerSample / sampleRate,
          freqIndex,
          strength: peak,
          snr: peak / Math.max(noise, 1e-6),
          widthMs: ((fallFrame - riseFrame) * H * 1000) / sampleRate,
        });
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

interface Anchor {
  time: number;
  index: number;
}

function wrap(i: number, n: number): number {
  return ((i % n) + n) % n;
}

/**
 * Index of the click in the track that best explains `click`, given an anchor,
 * restricted to indices with the right frequency. With `maxOffsetS` below half
 * an interval this is just rounding; above that, the frequency disambiguates
 * (indices repeat every frequencyCount intervals).
 */
function nearestIndex(
  click: DetectedClick,
  anchor: Anchor,
  frequencyCount: number,
  intervalS: number
): { index: number; error: number } | null {
  const base = anchor.index + (click.time - anchor.time) / intervalS;
  // candidate indices with matching frequency nearest to base
  const first = Math.floor(base) - frequencyCount;
  let best: { index: number; error: number } | null = null;
  for (let i = first; i <= first + 2 * frequencyCount + 1; i++) {
    if (wrap(i, frequencyCount) !== click.freqIndex) continue;
    const expected = anchor.time + (i - anchor.index) * intervalS;
    const error = Math.abs(click.time - expected);
    if (!best || error < best.error) best = { index: i, error };
  }
  return best;
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
): { clicks: IndexedClick[]; anchor: Anchor | null } {
  if (clicks.length === 0) return { clicks: [], anchor: null };

  let best: IndexedClick[] = [];
  let bestAnchor: Anchor | null = null;
  // Any of the loudest clicks could be the real anchor; keep the anchor that explains most clicks.
  const anchors = [...clicks].sort((a, b) => b.strength - a.strength).slice(0, 8);

  for (const c0 of anchors) {
    const anchor: Anchor = { time: c0.time, index: c0.freqIndex };
    const candidate: IndexedClick[] = [];
    for (const c of clicks) {
      const m = nearestIndex(c, anchor, frequencyCount, intervalS);
      if (m && m.error <= toleranceS) {
        candidate.push({ ...c, index: m.index, residual: c.time - m.index * intervalS });
      }
    }
    if (candidate.length > best.length) {
      best = candidate;
      bestAnchor = anchor;
    }
  }

  // Remove clicks whose residual is far from the bulk (a different index with the same freq)
  if (best.length > 3) {
    const med = median(best.map((c) => c.residual));
    best = best.filter((c) => Math.abs(c.residual - med) <= toleranceS);
  }
  return { clicks: best, anchor: bestAnchor };
}

interface WindowStats {
  win: RoomWindow;
  n: number;
  med: number;
  spread: number;
  meanTime: number;
  width: number;
  snr: number;
}

/**
 * Combine detected clicks and measurement windows into per-room offsets.
 * The reference room's primary window is the baseline. A closing window on the
 * reference room, if present, is used to remove linear clock drift.
 */
export function analyzeRooms(
  clicks: DetectedClick[],
  windows: RoomWindow[],
  referenceId: string,
  frequencyCount: number,
  intervalS: number
): AnalysisResult {
  const { clicks: indexed, anchor } = indexClicks(clicks, frequencyCount, intervalS);
  // indexClicks copies clicks, so identify them by their (unique) arrival time
  const indexedTimes = new Set(indexed.map((c) => c.time));

  const statsFor = (win: RoomWindow): WindowStats => {
    const inWin = (c: DetectedClick) => c.time >= win.startTime && c.time <= win.endTime;
    let inside: IndexedClick[] = indexed.filter(inWin);

    // A room offset by more than half an interval gets mis-indexed by plain rounding. If this window
    // has few clicks, retry using each click's frequency to pick its index, and accept the result
    // only if the per-click values agree tightly (random noise can't do that by chance).
    if (inside.length < 4 && anchor) {
      const raw = clicks.filter((c) => inWin(c) && !indexedTimes.has(c.time));
      const wide: IndexedClick[] = [];
      for (const c of raw) {
        const m = nearestIndex(c, anchor, frequencyCount, intervalS);
        if (m && m.error < (intervalS * frequencyCount) / 2) {
          wide.push({ ...c, index: m.index, residual: c.time - m.index * intervalS });
        }
      }
      if (wide.length >= 4) {
        const res = wide.map((c) => c.residual);
        if (mad(res, median(res)) < 0.003) inside = wide;
      }
    }

    if (inside.length === 0) {
      return { win, n: 0, med: NaN, spread: NaN, meanTime: NaN, width: NaN, snr: NaN };
    }
    const res = inside.map((c) => c.residual);
    const med = median(res);
    // Drop outliers beyond 3 sigma of the robust spread (min 1 ms so tight data isn't over-trimmed)
    const sigma = Math.max(mad(res, med), 0.001);
    const kept = inside.filter((c) => Math.abs(c.residual - med) <= 3 * sigma);
    const trimmed = kept.map((c) => c.residual);
    const tMed = median(trimmed);
    return {
      win,
      n: kept.length,
      med: tMed,
      spread: mad(trimmed, tMed),
      meanTime: kept.reduce((sum, c) => sum + c.time, 0) / kept.length,
      width: median(kept.map((c) => c.widthMs)),
      snr: median(kept.map((c) => c.snr)),
    };
  };

  const primaries = windows.filter((w) => w.kind === 'primary').map(statsFor);
  const closing = windows.filter((w) => w.kind === 'closing').map(statsFor).find((s) => s.n > 0);
  const ref = primaries.find((s) => s.win.playerId === referenceId && s.n > 0);

  let slope = 0; // seconds of residual drift per second of recording
  let driftPpm: number | null = null;
  if (ref && closing && Math.abs(closing.meanTime - ref.meanTime) > 5) {
    slope = (closing.med - ref.med) / (closing.meanTime - ref.meanTime);
    driftPpm = slope * 1e6;
  }

  const rooms: RoomAnalysis[] = primaries.map((s) => {
    if (s.n === 0 || !ref) {
      return { playerId: s.win.playerId, clicks: 0, arrivalMs: null, spreadMs: null, widthMs: null, snr: null };
    }
    const corrected = s.med - slope * (s.meanTime - ref.meanTime);
    return {
      playerId: s.win.playerId,
      clicks: s.n,
      arrivalMs: (corrected - ref.med) * 1000,
      spreadMs: s.spread * 1000,
      widthMs: s.width,
      snr: s.snr,
    };
  });

  return { rooms, driftPpm, usableClicks: indexed.length };
}

/** A single speaker's click is ~25 ms wide at half height; much wider means overlapping sources */
export const MAX_NORMAL_WIDTH_MS = 33;

/** Human-readable problems with a measurement */
export function qualityWarnings(room: RoomAnalysis): string[] {
  const warnings: string[] = [];
  if (room.clicks === 0) return ['No usable clicks heard'];
  if (room.clicks < 6) warnings.push(`Only ${room.clicks} usable clicks (aim for 8+)`);
  if (room.spreadMs !== null && room.spreadMs > 3) {
    warnings.push(`Unsteady (±${room.spreadMs.toFixed(1)} ms between clicks)`);
  }
  if (room.widthMs !== null && room.widthMs > MAX_NORMAL_WIDTH_MS) {
    warnings.push('Clicks look smeared: more than one speaker may be audible here. Move closer to this speaker.');
  }
  if (room.snr !== null && room.snr < 15) warnings.push('Weak signal: move closer or raise the volume');
  return warnings;
}
