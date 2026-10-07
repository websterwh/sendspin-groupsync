/**
 * Song test screen (dev only): GroupSync plays a song from ./groupsync-music and measures two speakers
 * against it, so the screen shows which one is later and by how much.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useConnectionStore, usePlayersStore } from '../store';
import { analyzeGroups, otherGroupMembers } from '../calibration/grouping';
import { SongSession, type SongLearn, type SongReading, type SongStage } from '../calibration/SongSession';
import { LiveLog } from '../calibration/liveLog';
import { listSongs } from '../ma-client';
import { PlayerList } from './PlayerList';
import { MuteWarning } from './MuteWarning';
import type { MuteProblem } from '../calibration/muting';

export default function SongTest({ onBack }: { onBack: () => void }) {
  const { players, selectedPlayerIds, setSelection } = usePlayersStore();
  const [phase, setPhase] = useState<'pick' | 'song' | 'run'>('pick');
  const [song, setSong] = useState<string | null>(null);
  const cleared = useRef(false);
  useEffect(() => {
    if (cleared.current) return;
    cleared.current = true;
    setSelection([]);
  }, [setSelection]);

  if (phase === 'pick') return <PlayerList variant="live" onBack={onBack} onStart={() => setPhase('song')} />;
  const [a, b] = selectedPlayerIds.map((id) => players.find((p) => p.player_id === id));
  if (!a || !b) return <PlayerList variant="live" onBack={onBack} onStart={() => setPhase('song')} />;
  if (phase === 'song' || !song)
    return <SongPicker onBack={() => setPhase('pick')} onPick={(name) => { setSong(name); setPhase('run'); }} />;
  return <Run aId={a.player_id} bId={b.player_id} song={song} onExit={() => setPhase('song')} />;
}

function SongPicker({ onBack, onPick }: { onBack: () => void; onPick: (name: string) => void }) {
  const [songs, setSongs] = useState<string[] | null>(null);
  useEffect(() => {
    void listSongs().then(setSongs);
  }, []);
  return (
    <div className="space-y-4">
      <h2 className="text-2xl font-bold">Pick a song</h2>
      <p className="text-sm text-text-muted">
        Songs come from the <code>groupsync-music</code> folder next to the project. Use a long song (8+ minutes) with steady,
        full sound from the first second.
      </p>
      {songs === null ? (
        <p className="text-text-muted">Loading…</p>
      ) : songs.length === 0 ? (
        <div className="p-3 bg-surface rounded-lg text-sm">No songs yet. Put an audio file in <code>groupsync-music/</code> and reopen this screen.</div>
      ) : (
        songs.map((s) => (
          <button key={s} onClick={() => onPick(s)} className="w-full text-left p-3 bg-surface hover:bg-gray-700 rounded-lg">
            {s}
          </button>
        ))
      )}
      <button onClick={onBack} className="w-full py-3 text-sm text-text-muted hover:text-white">
        Back
      </button>
    </div>
  );
}

const STAGE_TEXT: Record<SongStage, string> = {
  starting: 'Starting the song…',
  finding: 'Listening for the song…',
  learn_a: 'Measuring the first speaker alone…',
  learn_b: 'Measuring the second speaker alone…',
  live: '',
};

function Run({ aId, bId, song, onExit }: { aId: string; bId: string; song: string; onExit: () => void }) {
  const players = usePlayersStore((st) => st.players);
  const serverUrl = useConnectionStore((s) => s.serverUrl);
  const a = players.find((p) => p.player_id === aId)!;
  const b = players.find((p) => p.player_id === bId)!;
  const [stage, setStage] = useState<SongStage>('starting');
  const [reading, setReading] = useState<SongReading | null>(null);
  const [history, setHistory] = useState<{ t: number; gap: number | null }[]>([]);
  const [learn, setLearn] = useState<SongLearn | null>(null);
  const [learned, setLearned] = useState<{ A?: number; B?: number }>({});
  const [info, setInfo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [muteProblems, setMuteProblems] = useState<MuteProblem[]>([]);
  const [speed, setSpeed] = useState(8);
  const [copied, setCopied] = useState<string | null>(null);
  const [stopped, setStopped] = useState(false);
  const sessionRef = useRef<SongSession | null>(null);
  const logRef = useRef<LiveLog | null>(null);
  if (!logRef.current) logRef.current = new LiveLog({ mode: 'song', song, a: a.name, b: b.name, userAgent: navigator.userAgent }, { speedS: 8, sensitivity: 12, keepVolumes: false });
  const log = logRef.current;
  const readingCount = useRef(0);
  const speedRef = useRef(8);

  const others = useMemo(() => {
    const target = analyzeGroups(players, [aId, bId]).targets[0] ?? aId;
    return otherGroupMembers(players, target, [aId, bId]);
  }, [players, aId, bId]);

  useEffect(() => {
    const target = analyzeGroups(players, [aId, bId]).targets[0] ?? aId;
    const room = (p: typeof a) => ({ playerId: p.player_id, name: p.name, muted: p.volume_muted ?? p.muted });
    const session = new SongSession(target, room(a), room(b), others.map(room), serverUrl, song);
    sessionRef.current = session;
    void session.run((e) => {
      if (e.type === 'stage') {
        setStage(e.data as SongStage);
        log.event('stage', { stage: e.data });
      } else if (e.type === 'reading') {
        const r = e.data as SongReading;
        setReading(r);
        setHistory((h) => [...h.slice(-400), { t: r.t, gap: r.gapMs }]);
        const n = readingCount.current++;
        log.event('reading', {
          t: Math.round(r.t * 10) / 10,
          gapMs: r.gapMs === null ? null : Math.round(r.gapMs * 100) / 100,
          aMs: r.aMs === null ? null : Math.round(r.aMs * 100) / 100,
          bMs: r.bMs === null ? null : Math.round(r.bMs * 100) / 100,
          strengthA: Math.round(r.strengthA),
          strengthB: Math.round(r.strengthB),
          locked: r.locked,
          peaks: r.peaks.map((p) => [Math.round(p.ms * 100) / 100, Math.round(p.strength)]),
          memoryS: speedRef.current,
          curve: n % 10 === 0 ? r.curve : undefined,
        });
      } else if (e.type === 'learn') {
        const l = e.data as SongLearn;
        setLearn(l);
        if (l.stable && l.ms !== null) setLearned((x) => ({ ...x, [l.speaker]: l.ms! }));
        log.event('learn', { ...l });
      } else if (e.type === 'mute_problems') {
        setMuteProblems(e.data as MuteProblem[]);
        log.event('mute_problems', { problems: e.data });
      } else if (e.type === 'info') {
        setInfo(e.data as string);
        log.event('info', { text: e.data });
      } else if (e.type === 'error') {
        setError(e.data as string);
        log.event('error', { message: e.data });
      }
    });
    return () => session.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const gap = reading?.gapMs ?? null;
  const later = gap === null ? null : gap > 0 ? b.name : a.name;
  const earlier = gap === null ? null : gap > 0 ? a.name : b.name;
  const abs = gap === null ? null : Math.abs(gap);

  return (
    <div className="space-y-4 pb-8">
      <h2 className="text-2xl font-bold text-center">
        {a.name} ↔ {b.name}
      </h2>
      {error && <div className="p-3 bg-red-900/30 border border-red-700 rounded-lg text-red-300 text-sm">{error}</div>}
      <MuteWarning problems={muteProblems} />

      {stage !== 'live' && (
        <div className="p-4 bg-surface rounded-lg text-center space-y-1">
          <p>{STAGE_TEXT[stage]}</p>
          {learn && (stage === 'learn_a' || stage === 'learn_b') && learn.speaker === (stage === 'learn_a' ? 'A' : 'B') && (
            <p className="text-xs text-text-muted">
              {learn.stable ? 'Got it' : `Listening ${learn.seconds.toFixed(0)} s…`}
              {learn.ms !== null && ` (peak ${learn.strength.toFixed(0)})`}
              {learn.levelDb !== null && ` · ${learn.levelDb.toFixed(0)} dB above room noise`}
            </p>
          )}
          {info && <p className="text-xs text-text-muted">{info}</p>}
        </div>
      )}

      {stage === 'live' && (
        <div className="p-6 bg-surface rounded-lg text-center">
          {abs === null ? (
            <>
              <p className="text-xl">Can't see both speakers</p>
              <p className="text-xs text-text-muted mt-1">
                {reading ? `Strongest peaks: ${reading.peaks.slice(0, 3).map((p) => `${p.ms.toFixed(1)} ms (${p.strength.toFixed(0)})`).join(', ')}` : 'Collecting audio…'}
              </p>
            </>
          ) : abs < 1 ? (
            <p className="text-3xl font-bold text-secondary">In sync (under 1 ms)</p>
          ) : (
            <>
              <p className={`text-4xl font-bold ${reading?.locked ? 'text-secondary' : 'text-yellow-400'}`}>{abs.toFixed(1)} ms</p>
              <p className="text-sm text-text-muted mt-1">
                {later} is later than {earlier}
              </p>
            </>
          )}
          {reading && <p className="text-xs text-text-muted mt-2">{reading.locked ? 'steady' : 'settling'}</p>}
        </div>
      )}

      {(learned.A !== undefined || learned.B !== undefined) && (
        <p className="text-sm text-center">
          Alone: {a.name} {learned.A?.toFixed(2) ?? '–'} ms · {b.name} {learned.B?.toFixed(2) ?? '–'} ms
          {learned.A !== undefined && learned.B !== undefined && ` · gap ${(learned.B - learned.A).toFixed(2)} ms`}
        </p>
      )}

      {reading && <CurveChart reading={reading} />}
      {history.length > 2 && <GapHistory history={history} />}

      {stage === 'live' && (
        <div className="flex items-center gap-2 text-xs">
          <span className="w-20 text-text-muted">Speed</span>
          {([[3, 'Instant'], [8, 'Fast'], [20, 'Steady']] as [number, string][]).map(([v, name]) => (
            <button
              key={v}
              onClick={() => {
                setSpeed(v);
                speedRef.current = v;
                log.setting('speedS', v);
                sessionRef.current?.setMemory(v);
              }}
              className={`px-3 py-1 rounded ${speed === v ? 'bg-primary' : 'bg-surface hover:bg-gray-700'}`}
            >
              {name}
            </button>
          ))}
        </div>
      )}

      <div className="flex gap-3 text-xs">
        <button onClick={() => log.download()} className="flex-1 py-2 px-3 bg-surface hover:bg-gray-700 rounded-lg">
          Download log
        </button>
        <button onClick={async () => {
            setCopied((await log.copy()) ? 'Copied' : 'Copy failed');
            setTimeout(() => setCopied(null), 2000);
          }} className="flex-1 py-2 px-3 bg-surface hover:bg-gray-700 rounded-lg">
          {copied ?? 'Copy log'}
        </button>
      </div>
      {stopped || error ? (
        <div className="space-y-3">
          {stopped && !error && <p className="text-sm text-text-muted text-center">Stopped. The graph and the log stay here until you go back.</p>}
          <button onClick={onExit} className="w-full py-3 px-4 bg-secondary hover:bg-secondary/80 rounded-lg font-medium">
            Back
          </button>
        </div>
      ) : (
        <div className="flex gap-3">
          <button
            onClick={() => {
              sessionRef.current?.learnAgain();
              log.event('relearn');
              setHistory([]);
            }}
            disabled={stage !== 'live'}
            className="flex-1 py-3 px-4 bg-surface hover:bg-gray-700 disabled:opacity-40 rounded-lg font-medium"
          >
            Measure again
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

function CurveChart({ reading }: { reading: SongReading }) {
  const { values, startMs, endMs } = reading.curve;
  const max = Math.max(10, ...values);
  const x = (ms: number) => ((ms - startMs) / (endMs - startMs)) * 100;
  return (
    <div>
      <svg viewBox="0 0 100 30" className="w-full h-24 bg-surface rounded" preserveAspectRatio="none">
        <polyline
          fill="none"
          stroke="currentColor"
          className="text-primary"
          strokeWidth="0.4"
          vectorEffect="non-scaling-stroke"
          points={values.map((v, i) => `${(i / (values.length - 1)) * 100},${30 - (v / max) * 28}`).join(' ')}
        />
        {reading.aMs !== null && <line x1={x(reading.aMs)} x2={x(reading.aMs)} y1="0" y2="30" stroke="#38bdf8" strokeWidth="0.6" vectorEffect="non-scaling-stroke" />}
        {reading.bMs !== null && <line x1={x(reading.bMs)} x2={x(reading.bMs)} y1="0" y2="30" stroke="#f59e0b" strokeWidth="0.6" vectorEffect="non-scaling-stroke" />}
      </svg>
      <p className="text-xs text-text-muted text-center">
        Each peak is one speaker (blue first, orange second) · {startMs.toFixed(0)} to {endMs.toFixed(0)} ms
      </p>
    </div>
  );
}

function GapHistory({ history }: { history: { t: number; gap: number | null }[] }) {
  const vals = history.filter((h) => h.gap !== null).map((h) => h.gap as number);
  if (vals.length < 2) return null;
  const lo = Math.min(...vals, 0);
  const hi = Math.max(...vals, 0.5);
  const t0 = history[0].t;
  const t1 = history[history.length - 1].t;
  const px = (t: number) => ((t - t0) / Math.max(1, t1 - t0)) * 100;
  const py = (g: number) => 28 - ((g - lo) / (hi - lo || 1)) * 26;
  return (
    <div>
      <svg viewBox="0 0 100 30" className="w-full h-20 bg-surface rounded" preserveAspectRatio="none">
        <line x1="0" x2="100" y1={py(0)} y2={py(0)} stroke="#6b7280" strokeWidth="0.4" vectorEffect="non-scaling-stroke" />
        {history.map((h, i) => (h.gap === null ? null : <circle key={i} cx={px(h.t)} cy={py(h.gap)} r="0.7" fill="#38bdf8" />))}
      </svg>
      <p className="text-xs text-text-muted text-center">Gap over time (above the line: second speaker later)</p>
    </div>
  );
}
