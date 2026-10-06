/**
 * Live drift test screen (dev only): shows the gap between two speakers while your own music plays.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useCalibrationStore, usePlayersStore } from '../store';
import { analyzeGroups, otherGroupMembers } from '../calibration/grouping';
import { LiveDriftSession, type LiveReading, type LiveStage } from '../calibration/LiveDriftSession';
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
  const [stageSince, setStageSince] = useState(Date.now());
  const [, tick] = useState(0);
  const sessionRef = useRef<LiveDriftSession | null>(null);

  // Other members of the same sync group are muted for the whole test (they would add echoes)
  const others = useMemo(() => {
    const target = analyzeGroups(players, [aId, bId]).targets[0] ?? aId;
    return otherGroupMembers(players, target, [aId, bId]);
  }, [players, aId, bId]);

  useEffect(() => {
    const session = new LiveDriftSession(
      { playerId: a.player_id, name: a.name, muted: a.volume_muted ?? a.muted },
      { playerId: b.player_id, name: b.name, muted: b.volume_muted ?? b.muted },
      others.map((p) => ({ playerId: p.player_id, name: p.name, muted: p.volume_muted ?? p.muted }))
    );
    sessionRef.current = session;
    void session.run((event) => {
      if (event.type === 'stage') {
        setStage(event.data as LiveStage);
        setStageSince(Date.now());
      } else if (event.type === 'reading') {
        setReadings((prev) => [...prev, event.data as LiveReading]);
      } else if (event.type === 'mute_problems') {
        setMuteProblems(event.data as MuteProblem[]);
      } else if (event.type === 'level') {
        setLevel(event.data as number);
      } else if (event.type === 'error') {
        setError(event.data as string);
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
  const latest = last?.delayMs ?? null;

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

      {stageText && (
        <div className="p-4 bg-surface rounded-lg text-center space-y-2">
          <p>{stageText}</p>
          {learning && (
            <div className="h-1.5 bg-gray-700 rounded-full overflow-hidden">
              <div
                className="h-full bg-primary"
                style={{ width: `${Math.min(100, ((Date.now() - stageSince) / 1000 / 22) * 100)}%`, transition: 'width 1s linear' }}
              />
            </div>
          )}
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
              <p className="text-2xl font-bold text-text-muted">No gap found</p>
              <p className="text-xs text-text-muted">In sync (under 1.5 ms), music too quiet, or one speaker not heard.</p>
            </>
          ) : (
            <>
              <p className={`text-5xl font-bold ${last.locked ? 'text-green-300' : 'text-yellow-300'}`}>
                {latest.toFixed(1)} <span className="text-2xl">ms</span>
              </p>
              <p className="text-xs text-text-muted">
                {last.locked ? 'steady' : 'measuring'} · strength {last.strength.toFixed(0)}
                {!last.usedBaseline && ' · room not learned'}
              </p>
            </>
          )}
          {clickGap !== null && (
            <p className="text-xs text-text-muted">Last click test: {clickGap.toFixed(1)} ms</p>
          )}
        </div>
      )}

      {readings.length > 1 && <Chart readings={readings} />}

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

      <div className="flex gap-3">
        <button
          onClick={() => {
            sessionRef.current?.learnAgain();
            setReadings([]);
          }}
          disabled={stage !== 'live'}
          className="flex-1 py-3 px-4 bg-surface hover:bg-gray-700 disabled:opacity-40 rounded-lg font-medium"
        >
          Learn room again
        </button>
        <button
          onClick={() => {
            sessionRef.current?.stop();
            onExit();
          }}
          className="flex-1 py-3 px-4 bg-secondary hover:bg-secondary/80 rounded-lg font-medium"
        >
          Stop
        </button>
      </div>
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
