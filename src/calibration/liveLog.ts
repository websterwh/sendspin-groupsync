/**
 * Event log for the live drift test: every reading together with the settings in force when it was
 * taken, plus the changes that were made while running. Downloadable so a session can be reviewed later.
 */
import type { LiveReading } from './LiveDriftSession';

export interface LogSettings {
  speedS: number;
  sensitivity: number;
  keepVolumes: boolean;
}

export interface LogEntry {
  /** Wall clock, ms since the log started */
  at: number;
  type: string;
  [key: string]: unknown;
}

const r1 = (v: number) => Math.round(v * 10) / 10;

export class LiveLog {
  private readonly started = Date.now();
  private entries: LogEntry[] = [];
  private readonly info: Record<string, unknown>;
  private settings: LogSettings;
  private readings = 0;

  constructor(info: Record<string, unknown>, settings: LogSettings) {
    this.info = info;
    this.settings = { ...settings };
  }

  event(type: string, data: Record<string, unknown> = {}): void {
    this.entries.push({ at: Date.now() - this.started, type, ...data });
    if (this.entries.length > 20000) this.entries.splice(0, 2000);
  }

  setting<K extends keyof LogSettings>(key: K, value: LogSettings[K]): void {
    const from = this.settings[key];
    if (from === value) return;
    this.settings[key] = value;
    this.event('setting', { key, from, to: value });
  }

  reading(r: LiveReading): void {
    const n = this.readings++;
    this.entries.push({
      at: Date.now() - this.started,
      type: 'reading',
      t: r1(r.t),
      gapMs: r.delayMs === null ? null : Math.round(r.delayMs * 100) / 100,
      strength: r1(r.strength),
      locked: r.locked,
      baseline: r.usedBaseline,
      candidates: r.candidates.map((p) => [Math.round(p.delayMs * 100) / 100, r1(p.strength)]),
      weakSmall: r.weakSmall ? [Math.round(r.weakSmall.delayMs * 100) / 100, r1(r.weakSmall.strength)] : null,
      // settings in force for this reading, so rows can be compared across changes
      speedS: this.settings.speedS,
      sensitivity: this.settings.sensitivity,
      // the full curve every 10th reading only (keeps the file small)
      curve: n % 10 === 0 ? { startMs: r1(r.curve.startMs), endMs: r1(r.curve.endMs), values: r.curve.values.map(r1) } : undefined,
    });
  }

  toJson(): string {
    return JSON.stringify({ ...this.info, startedAt: new Date(this.started).toISOString(), settings: this.settings, entries: this.entries }, null, 1);
  }

  download(): void {
    const blob = new Blob([this.toJson()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `groupsync-live-${new Date(this.started).toISOString().replace(/[:.]/g, '-')}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  async copy(): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(this.toJson());
      return true;
    } catch {
      return false;
    }
  }
}
