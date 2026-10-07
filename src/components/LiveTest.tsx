/**
 * Live drift test screen (dev only): shows the gap between two speakers while your own music plays.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useCalibrationStore, usePlayersStore } from '../store';
import { analyzeGroups, otherGroupMembers } from '../calibration/grouping';
import {
  LEARN_AGREEMENT,
  LiveDriftSession,
  type LearnProgress,
  type LiveLevels,
  type LiveReading,
  type LiveStage,
  type VolumeNote,
} from '../calibration/LiveDriftSession';
import { LiveLog } from '../calibration/liveLog';
import { PlayerList } from './PlayerList';
import { MuteWarning } from './MuteWarning';
import type { MuteProblem } from '../calibration/muting';

interface Props {
  onBack: () => void;
}

export default function LiveTest({ onBack }: Props) {
  const { players, selectedPlayerIds, setSelection } = usePlayersStore();
  const results = useCalibrationStore((s) => s.results);
  const [running, setRunning] = useState(false);

  // Start from a clean pick: this test needs exactly two speakers
  const cleared = useRef(false);
  useEffect(() => {
    if (cleared.current) return;
    cleared.current = true;
    setSelection([]);
  }, [setSelection]);

  if (!running) {
    return <PlayerList variant="live" onBack={onBack} onStart={() => setRunning(true)} />;
  }

  const [a, b] = selectedPlayerIds.map((id) => players.find((p) => p.player_id === id));
  if (!a || !b) return <PlayerList variant="live" onBack={onBack} onStart={() => setRunning(true)} />;

  return <Run aId={a.player_id} bId={b.player_id} results={results} onExit={() => setRunning(false)} />;
}

function Run({
  aId,
  bId,
  results,
  onExit,
}: {
  aId: string;
  bId: string;
  results: Record<string, { arrivalMs?: number; isReference?: boolean }>;
  onExit: () => void;
}) {
  const players = usePlayersStore((st) => st.players);
  const a = players.find((p) => p.player_id === aId)!;
  const b = players.find((p) => p.player_id === bId)!;

  const [stage, setStage] = useState<LiveStage>('waiting');
  const [readings, setReadings] = useState<LiveReading[]>([]);
  const [muteProblems, setMuteProblems] = useState<MuteProblem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [level, setLevel] = useState(0);
  const [levels, setLevels] = useState<LiveLevels | null>(null);
  const [learn, setLearn] = useState<LearnProgress | null>(null);
  const [volumeNote, setVolumeNote] = useState<VolumeNote | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [keepVolumes, setKeepVolumes] = useState(false);
  const [speed, setSpeed] = useState(20);
  const [sensitivity, setSensitivity] = useState(12);
  const [, tick] = useState(0);
  const sessionRef = useRef<LiveDriftSession | null>(null);
  const logRef = useRef<LiveLog | null>(null);
  if (!logRef.current) {
    logRef.current = new LiveLog(
      { a: a.name, b: b.name, userAgent: navigator.userAgent },
      { speedS: 20, sensitivity: 12, keepVolumes: false }
    );
  }
  const log = logRef.current;
  const [copied, setCopied] = useState<string | null>(null);
  const [stopped, setStopped] = useState(false);

  // Other members of the same sync group are muted for the whole test (they would add echoes)
  const others = useMemo(() => {
    const target = analyzeGroups(players, [aId, bId]).targets[0] ?? aId;
    return otherGroupMembers(players, target, [aId, bId]);
  }, [players, aId, bId]);

  useEffect(() => {
    const session = new LiveDriftSession(
      { playerId: a.player_id, name: a.name, muted: a.volume_muted ?? a.muted, volume: a.volume_level },
      { playerId: b.player_id, name: b.name, muted: b.volume_muted ?? b.muted, volume: b.volume_level },
      others.map((p) => ({ playerId: p.player_id, name: p.name, muted: p.volume_muted ?? p.muted, volume: p.volume_level }))
    );
    sessionRef.current = session;
    void session.run((event) => {
      if (event.type === 'stage') {
        setStage(event.data as LiveStage);
        log.event('stage', { stage: event.data });
      } else if (event.type === 'reading') {
        log.reading(event.data as LiveReading);
        setReadings((prev) => [...prev.slice(-1500), event.data as LiveReading]);
      } else if (event.type === 'mute_problems') {
        setMuteProblems(event.data as MuteProblem[]);
        log.event('mute_problems', { problems: event.data });
      } else if (event.type === 'level') {
        setLevel(event.data as number);
      } else if (event.type === 'learn') {
        setLearn(event.data as LearnProgress);
        log.event('learn', { progress: event.data });
      } else if (event.type === 'levels') {
        setLevels(event.data as LiveLevels);
        log.event('levels', { levels: event.data });
      } else if (event.type === 'volume') {
        setVolumeNote(event.data as VolumeNote);
        log.event('volume', { note: event.data });
      } else if (event.type === 'warning') {
        setWarning(event.data as string);
        log.event('warning', { text: event.data });
      } else if (event.type === 'error') {
        setError(event.data as string);
        log.event('error', { message: event.data });
      }
    });
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => {
      clearInterval(timer);
      session.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const last = readings[readings.length - 1];
  const locked = readings.filter((r) => r.locked);
  const first = locked[0];
  const lastGap = [...readings].reverse().find((r) => r.delayMs !== null);
  // Keep showing the last gap for a few seconds if one reading misses it
  const holding = last?.delayMs === null && lastGap !== undefined && last !== undefined && last.t - lastGap.t < 5;
  const shown = holding ? lastGap : last;
  const latest = shown?.delayMs ?? null;

  // How much the readings have been moving over the last ~20 s
  const recentGaps = readings
    .filter((r) => last !== undefined && last.t - r.t <= 20 && r.delayMs !== null)
    .map((r) => r.delayMs as number)
    .sort((x, y) => x - y);
  const median = recentGaps.length ? recentGaps[Math.floor(recentGaps.length / 2)] : null;
  const spread = recentGaps.length ? recentGaps[recentGaps.length - 1] - recentGaps[0] : 0;
  // Unsteady: plenty of readings found a gap, but not the same one
  const unsteady = !shown?.locked && recentGaps.length >= 6 && spread > Math.max(1, 0.1 * (median ?? 0));

  // What the click test said about this pair (if it has been run for both)
  const clickGap = (() => {
    const ra = results[aId];
    const rb = results[bId];
    if (!ra || !rb) return null;
    const va = ra.isReference ? 0 : ra.arrivalMs;
    const vb = rb.isReference ? 0 : rb.arrivalMs;
    return va === undefined || vb === undefined ? null : Math.abs(vb - va);
  })();

  const learning = stage === 'learn_a' || stage === 'learn_b';
  const stageText =
    stage === 'waiting'
      ? 'Play music on the speakers (Spotify Connect, a song, anything)'
      : stage === 'levels'
        ? 'Checking how loud each speaker is, and matching them…'
      : stage === 'learn_a'
        ? `Learning the room, 1 of 2: only ${a.name} plays`
        : stage === 'learn_b'
          ? `Learning the room, 2 of 2: only ${b.name} plays`
          : null;

  const change = first && last?.delayMs != null ? last.delayMs - first.delayMs! : null;
  const minutes = first && last ? Math.max(0.1, (last.t - first.t) / 60) : 0;

  return (
    <div className="space-y-4 pb-8">
      <h2 className="text-2xl font-bold text-center">
        {a.name} ↔ {b.name}
      </h2>

      {error && <div className="p-3 bg-red-900/30 border border-red-700 rounded-lg text-red-300 text-sm">{error}</div>}
      <MuteWarning problems={muteProblems} />
      {warning && <div className="p-3 bg-yellow-900/30 border border-yellow-700 rounded-lg text-yellow-200 text-sm">{warning}</div>}
      {last?.roomChanged && stage === 'live' && !stopped && (
        <div className="p-3 bg-yellow-900/30 border border-yellow-700 rounded-lg text-yellow-200 text-sm">
          The room sounds different from when it was learned (did the phone or a speaker move?). Press Relearn room.
        </div>
      )}

      {stageText && (
        <div className="p-4 bg-surface rounded-lg text-center space-y-2">
          <p>{stageText}</p>
          {learning && (
            <>
              <div className="h-1.5 bg-gray-700 rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary"
                  style={{
                    width: `${Math.round(Math.min(1, Math.max(0.05, (learn?.speaker === (stage === 'learn_a' ? 'A' : 'B') ? learn.agreement : 0) / LEARN_AGREEMENT)) * 100)}%`,
                    transition: 'width 1s linear',
                  }}
                />
              </div>
              <p className="text-xs text-text-muted">
                {learn && learn.speaker === (stage === 'learn_a' ? 'A' : 'B')
                  ? learn.state === 'listening'
                    ? `Listening ${learn.seconds.toFixed(0)} s, the picture is ${Math.round(Math.max(0, learn.agreement) * 100)}% settled`
                    : learn.state === 'stable'
                      ? 'Got it'
                      : learn.state === 'flat'
                        ? 'Got it (very little echo here)'
                        : learn.state === 'loose'
                          ? "Never fully settled, using what it heard (a quiet speaker or very plain music is the usual cause)"
                          : "Couldn't hear enough music to learn this"
                  : 'Starting…'}
              </p>
            </>
          )}
          {levels && learning && (
            <p className="text-xs text-text-muted">
              Level at the phone: {a.name} {levels.aDb.toFixed(0)} dB · {b.name} {levels.bDb.toFixed(0)} dB
            </p>
          )}
          {volumeNote && (learning || stage === 'levels') && <p className="text-xs text-text-muted">{volumeNote.text}</p>}
          {stage === 'waiting' && (
            <div className="h-1.5 bg-gray-700 rounded-full overflow-hidden">
              <div className="h-full bg-green-500" style={{ width: `${Math.min(100, level * 2000)}%`, transition: 'width 300ms' }} />
            </div>
          )}
          <button
            onClick={() => sessionRef.current?.skipLearning()}
            className="text-xs text-text-muted underline"
            hidden={stage === 'live'}
          >
            Skip learning (less reliable)
          </button>
        </div>
      )}

      {stage === 'live' && (
        <div className="p-4 bg-surface rounded-lg text-center space-y-1">
          {readings.length === 0 ? (
            <p className="text-text-muted">Collecting audio…</p>
          ) : latest === null ? (
            <>
              <p className="text-2xl font-bold text-text-muted">No clear gap</p>
              <p className="text-xs text-text-muted">
                {last.weakSmall || (last.candidates[0] && last.candidates[0].delayMs < 10)
                  ? 'Probably in sync (within about 10 ms). Gaps that small can\'t be told from room echoes.'
                  : 'In sync, music too quiet, or one speaker not heard.'}
              </p>
              {(last.weakSmall ?? last.candidates[0]) && (
                <p className="text-xs text-text-muted">
                  Weak candidate: {(last.weakSmall ?? last.candidates[0]).delayMs.toFixed(1)} ms (strength{' '}
                  {(last.weakSmall ?? last.candidates[0]).strength.toFixed(0)})
                </p>
              )}
            </>
          ) : (
            <>
              <p className={`text-5xl font-bold ${shown?.locked ? 'text-green-300' : 'text-yellow-300'}`}>
                {unsteady && median !== null ? '~' + median.toFixed(1) : latest.toFixed(1)} <span className="text-2xl">ms</span>
              </p>
              <p className="text-xs text-text-muted">
                {unsteady
                  ? `unsteady: ${recentGaps[0].toFixed(1)} to ${recentGaps[recentGaps.length - 1].toFixed(1)} ms over the last 20 s`
                  : holding
                    ? 'updating'
                    : shown?.locked
                      ? 'steady'
                      : 'measuring'}{' '}
                · strength {shown?.strength.toFixed(0)}
                {!shown?.usedBaseline && ' · room not learned'}
              </p>
              {unsteady && (
                <p className="text-xs text-text-muted">
                  Either the speakers really drift around, or this is noise: check the curve below and try Steady.
                </p>
              )}
            </>
          )}
          {clickGap !== null && (
            <p className="text-xs text-text-muted">Last click test: {clickGap.toFixed(1)} ms</p>
          )}
        </div>
      )}

      {readings.length > 1 && <Chart readings={readings} />}
      {last && <CurveChart reading={last} threshold={sensitivity} />}

      {change !== null && first && (
        <div className="grid grid-cols-3 gap-2 text-center text-sm">
          <Stat label="Start" value={`${first.delayMs!.toFixed(1)} ms`} />
          <Stat label="Now" value={latest === null ? '–' : `${latest.toFixed(1)} ms`} />
          <Stat
            label="Change"
            value={`${change >= 0 ? '+' : ''}${change.toFixed(1)} ms`}
            sub={minutes >= 0.5 ? `${(change / minutes).toFixed(1)} ms/min` : undefined}
          />
        </div>
      )}

      {last && last.others.length > 0 && (
        <p className="text-xs text-text-muted text-center">
          Other echoes: {last.others.map((p) => `${p.delayMs.toFixed(1)} ms (${p.strength.toFixed(0)})`).join(', ')}
        </p>
      )}

      {stage === 'live' && (
        <div className="space-y-2 text-xs">
          <Choice
            label="Speed"
            value={speed}
            options={[[4, 'Instant'], [8, 'Fast'], [20, 'Normal'], [40, 'Steady']]}
            onChange={(v) => {
              setSpeed(v);
              log.setting('speedS', v);
              sessionRef.current?.setMemory(v);
            }}
          />
          <Choice
            label="Sensitivity"
            value={sensitivity}
            options={[[12, 'Normal'], [8, 'High'], [6, 'Max']]}
            onChange={(v) => {
              setSensitivity(v);
              log.setting('sensitivity', v);
              sessionRef.current?.setMinStrength(v);
            }}
          />
          <label className="flex items-center gap-2 text-text-muted">
            <input
              type="checkbox"
              checked={keepVolumes}
              onChange={(e) => {
                setKeepVolumes(e.target.checked);
                log.setting('keepVolumes', e.target.checked);
                sessionRef.current?.keepVolumes(e.target.checked);
              }}
            />
            Keep the matched volumes when I stop
          </label>
          {volumeNote && <p className="text-text-muted">{volumeNote.text}</p>}
        </div>
      )}

      <div className="flex gap-3 text-xs">
        <button onClick={() => log.download()} className="flex-1 py-2 px-3 bg-surface hover:bg-gray-700 rounded-lg">
          Download log
        </button>
        <button
          onClick={async () => {
            setCopied((await log.copy()) ? 'Copied' : 'Copy failed');
            setTimeout(() => setCopied(null), 2000);
          }}
          className="flex-1 py-2 px-3 bg-surface hover:bg-gray-700 rounded-lg"
        >
          {copied ?? 'Copy log'}
        </button>
      </div>

      {stopped || error ? (
        <button onClick={onExit} className="w-full py-3 px-4 bg-secondary hover:bg-secondary/80 rounded-lg font-medium">
          Back
        </button>
      ) : (
        <div className="flex gap-3">
          <button
            onClick={() => {
              sessionRef.current?.resetReadings();
              log.event('clear');
              setReadings([]);
            }}
            disabled={stage !== 'live'}
            className="flex-1 py-3 px-4 bg-surface hover:bg-gray-700 disabled:opacity-40 rounded-lg font-medium"
          >
            Clear
          </button>
          <button
            onClick={() => {
              sessionRef.current?.learnAgain();
              log.event('relearn');
              setReadings([]);
            }}
            disabled={stage !== 'live'}
            className="flex-1 py-3 px-4 bg-surface hover:bg-gray-700 disabled:opacity-40 rounded-lg font-medium"
          >
            Relearn room
          </button>
          <button
            onClick={() => {
              sessionRef.current?.stop();
              log.event('stopped');
              setStopped(true);
            }}
            className="flex-1 py-3 px-4 bg-secondary hover:bg-secondary/80 rounded-lg font-medium"
          >
            Stop
          </button>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="p-2 bg-surface rounded-lg">
      <div className="text-xs text-text-muted">{label}</div>
      <div className="font-mono">{value}</div>
      {sub && <div className="text-xs text-text-muted">{sub}</div>}
    </div>
  );
}

/** Gap over time. Gaps with no reading are left as breaks in the line. */
function Chart({ readings }: { readings: LiveReading[] }) {
  const w = 340;
  const h = 130;
  const pad = { l: 34, r: 6, t: 8, b: 18 };
  const values = readings.map((r) => r.delayMs).filter((v): v is number => v !== null);
  if (values.length === 0) return null;
  const maxV = Math.max(10, Math.max(...values) * 1.15);
  const maxT = Math.max(...readings.map((r) => r.t), 30);
  const x = (t: number) => pad.l + (t / maxT) * (w - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - v / maxV) * (h - pad.t - pad.b);

  const segments: string[] = [];
  let current: string[] = [];
  for (const r of readings) {
    if (r.delayMs === null) {
      if (current.length) segments.push(current.join(' '));
      current = [];
    } else current.push(`${x(r.t).toFixed(1)},${y(r.delayMs).toFixed(1)}`);
  }
  if (current.length) segments.push(current.join(' '));

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full bg-surface rounded-lg">
      {[0, 0.5, 1].map((f) => (
        <g key={f}>
          <line x1={pad.l} x2={w - pad.r} y1={y(maxV * f)} y2={y(maxV * f)} stroke="#374151" strokeWidth="0.5" />
          <text x={pad.l - 4} y={y(maxV * f) + 3} textAnchor="end" fontSize="9" fill="#9ca3af">
            {(maxV * f).toFixed(0)}
          </text>
        </g>
      ))}
      <text x={w - pad.r} y={h - 4} textAnchor="end" fontSize="9" fill="#9ca3af">
        {Math.round(maxT / 60 * 10) / 10} min
      </text>
      {segments.map((pts, i) => (
        <polyline key={i} points={pts} fill="none" stroke="#60a5fa" strokeWidth="1.8" />
      ))}
      {readings.map(
        (r, i) =>
          r.delayMs !== null && (
            <circle key={i} cx={x(r.t)} cy={y(r.delayMs)} r="2.2" fill={r.locked ? '#4ade80' : '#facc15'} />
          )
      )}
    </svg>
  );
}

function Choice({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: number;
  options: [number, string][];
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-20 text-text-muted">{label}</span>
      {options.map(([v, name]) => (
        <button
          key={v}
          onClick={() => onChange(v)}
          className={`px-3 py-1 rounded ${value === v ? 'bg-primary' : 'bg-surface hover:bg-gray-700'}`}
        >
          {name}
        </button>
      ))}
    </div>
  );
}

/** Strength of an echo at each delay, right now. A bump above the line is a candidate gap. */
function CurveChart({ reading, threshold }: { reading: LiveReading; threshold: number }) {
  const { startMs, endMs, values, raw } = reading.curve;
  const w = 340;
  const h = 90;
  const pad = { l: 28, r: 6, t: 6, b: 16 };
  const maxV = Math.max(threshold * 1.6, ...values, ...raw);
  const x = (ms: number) => pad.l + ((ms - startMs) / (endMs - startMs)) * (w - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - Math.max(0, v) / maxV) * (h - pad.t - pad.b);
  const at = (i: number) => x(startMs + ((i + 0.5) / values.length) * (endMs - startMs)).toFixed(1);
  const rawPts = raw.map((v, i) => `${at(i)},${y(v).toFixed(1)}`);
  const pts = values.map((v, i) => `${x(startMs + ((i + 0.5) / values.length) * (endMs - startMs)).toFixed(1)},${y(v).toFixed(1)}`);
  return (
    <div>
      <div className="text-xs text-text-muted mb-1">Echo strength by gap (ms). Blue: after room correction, grey: before. Bumps above the red line are candidates</div>
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full bg-surface rounded-lg">
        <line x1={pad.l} x2={w - pad.r} y1={y(threshold)} y2={y(threshold)} stroke="#f87171" strokeDasharray="3 3" strokeWidth="0.8" />
        <polyline points={rawPts.join(' ')} fill="none" stroke="#6b7280" strokeWidth="0.9" />
        <polyline points={pts.join(' ')} fill="none" stroke="#60a5fa" strokeWidth="1.2" />
        {[0, 50, 100, 150, 200, 250].map((ms) => (
          <text key={ms} x={x(Math.max(ms, startMs))} y={h - 3} fontSize="8" fill="#9ca3af" textAnchor="middle">
            {ms}
          </text>
        ))}
        <text x={pad.l - 3} y={y(threshold) + 3} fontSize="8" fill="#f87171" textAnchor="end">
          {threshold}
        </text>
      </svg>
    </div>
  );
}
