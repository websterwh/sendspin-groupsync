import { useEffect, useMemo, useRef, useState } from 'react';
import { useCalibrationStore, usePlayersStore, useConnectionStore } from '../store';
import { createCalibrationSession, CalibrationSession } from '../calibration';
import type { RoomReading, MeasurementKind, PlaybackDiagnostics } from '../calibration/CalibrationSession';
import { analyzeGroups, otherGroupMembers } from '../calibration/grouping';
import { MuteWarning } from './MuteWarning';
import type { MuteProblem } from '../calibration/muting';
import { pushSyncOffsets } from '../sync-push';
import type { PushResult } from '../sync-push';
import type { CalibrationResult } from '../types';

/**
 * Differences below this are inside what a phone-microphone measurement can tell apart: moving the
 * phone 1 m shifts one speaker's arrival by ~3 ms, and devices re-sync with some jitter. It is also
 * far below what is audible (~10-20 ms between speakers).
 */
const IN_SYNC_MS = 8;

export function CalibrationWizard() {
  const { phase, setPhase, results, setResult, clearResults, updateOffset, setError, error } =
    useCalibrationStore();
  const { players, selectedPlayerIds, makeReference } = usePlayersStore();
  const { serverUrl } = useConnectionStore();

  // In selection order (the first one is the reference room); "Make reference" reorders
  const selectedPlayers = selectedPlayerIds
    .map((id) => players.find((p) => p.player_id === id))
    .filter((p): p is NonNullable<typeof p> => !!p);

  // The track must be played on the sync group's leader so every member plays the same stream
  const groups = useMemo(
    () => analyzeGroups(players, selectedPlayerIds),
    [players, selectedPlayerIds]
  );
  const leaders = groups.targets;
  const [playOn, setPlayOn] = useState<string>('');
  const playTarget = playOn || leaders[0] || '';

  // Default the reference (baseline) to the group leader, once per selection, so results read as
  // "how far is each speaker from the lead". The user can still change it with "Make reference".
  const autoOrdered = useRef('');
  useEffect(() => {
    if (phase !== 'instructions') return;
    const key = selectedPlayerIds.join(',') + '|' + playTarget;
    if (autoOrdered.current === key) return;
    autoOrdered.current = key;
    if (selectedPlayerIds.includes(playTarget) && selectedPlayerIds[0] !== playTarget) makeReference(playTarget);
  }, [phase, playTarget, selectedPlayerIds, makeReference]);
  // Group members that play along but aren't being measured: they're muted during each measurement
  const unselectedMembers = useMemo(
    () => otherGroupMembers(players, playTarget, selectedPlayerIds),
    [players, playTarget, selectedPlayerIds]
  );
  const nameOf = (id: string) => players.find((p) => p.player_id === id)?.name ?? id;

  // Room order: selected order, then the first room again at the end to measure clock drift
  // Latest reading per room (what was heard, relative to the reference); a room is "done" once it has one
  const [readings, setReadings] = useState<Record<string, RoomReading>>({});
  const [closingDone, setClosingDone] = useState(false);
  // Which measurement is in progress ('closing' = the reference room's drift check), and the last outcome
  const [measuringId, setMeasuringId] = useState<string | null>(null);
  const [lastOutcome, setLastOutcome] = useState<{ id: string; clicks: number } | null>(null);
  const [progressClicks, setProgressClicks] = useState(0);
  const [live, setLive] = useState({ total: 0, timedOut: false, remaining: 0 });
  const [playing, setPlaying] = useState(false);
  const [signal, setSignal] = useState<{ ageS: number; snr: number } | null>(null);
  const [waitedS, setWaitedS] = useState(0);
  const [diagnostics, setDiagnostics] = useState<PlaybackDiagnostics | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [driftPpm, setDriftPpm] = useState<number | null>(null);
  const [audioGaps, setAudioGaps] = useState(0);
  const [muteProblems, setMuteProblems] = useState<MuteProblem[]>([]);
  // Speakers whose value the user changed by hand; pushed even when they're within the in-sync margin
  const [edited, setEdited] = useState<Set<string>>(new Set());

  // Auto-push is opt-in: by default we only show the value so the user enters it themselves
  const [autoPush, setAutoPush] = useState(() => {
    try {
      return localStorage.getItem('groupsync_auto_push') === '1';
    } catch {
      return false;
    }
  });
  const autoPushRef = useRef(autoPush);
  autoPushRef.current = autoPush;
  const [isPushing, setIsPushing] = useState(false);
  const [pushResults, setPushResults] = useState<PushResult[] | null>(null);
  const sessionRef = useRef<CalibrationSession | null>(null);

  useEffect(() => {
    return () => sessionRef.current?.stop();
  }, []);

  const firstRoom = selectedPlayers[0];
  const referenceResult = Object.values(results).find((r) => r.isReference);
  const isDone = (id: string) => (readings[id]?.clicks ?? 0) > 0;
  const allRoomsDone = selectedPlayers.length > 0 && selectedPlayers.every((p) => isDone(p.player_id));
  const nextRoom = selectedPlayers.find((p) => !isDone(p.player_id));
  const measuring = measuringId !== null;

  const handleStart = async () => {
    if (!firstRoom || !playTarget) return;
    setError(null);
    setReadings({});
    setEdited(new Set());
    setMeasuringId(null);
    setLastOutcome(null);
    setMuteProblems([]);
    setClosingDone(false);
    setPlaying(false);
    setWaitedS(0);
    setProgressClicks(0);
    setDiagnostics(null);
    setLive({ total: 0, timedOut: false, remaining: 0 });
    setSignal(null);
    setPhase('listening');

    const session = createCalibrationSession(
      playTarget,
      selectedPlayers.map((p) => ({ playerId: p.player_id, name: p.name, muted: p.volume_muted ?? p.muted })),
      serverUrl,
      undefined,
      unselectedMembers.map((p) => ({ playerId: p.player_id, name: p.name, muted: p.volume_muted ?? p.muted }))
    );
    sessionRef.current = session;

    try {
      await session.start((event) => {
        switch (event.type) {
          case 'playback_started':
            setPlaying(true);
            break;
          case 'clicks_heard': {
            const d = event.data as {
              total: number;
              timedOut: boolean;
              remainingSeconds: number;
              diagnostics: PlaybackDiagnostics | null;
              latest: { ageS: number; snr: number } | null;
            };
            setLive({ total: d.total, timedOut: d.timedOut, remaining: d.remainingSeconds });
            setSignal(d.latest);
            setDiagnostics(d.diagnostics);
            setWaitedS((w) => (d.total === 0 ? w + 0.5 : 0));
            break;
          }
          case 'room_measured': {
            const d = event.data as {
              playerId: string;
              kind: MeasurementKind;
              clicks: number;
              readings: RoomReading[];
            };
            // A measurement that heard nothing never replaces an earlier good one
            setReadings(Object.fromEntries(d.readings.map((r) => [r.playerId, r])));
            if (d.kind === 'closing' && d.clicks > 0) setClosingDone(true);
            setLastOutcome({ id: d.kind === 'closing' ? 'closing' : d.playerId, clicks: d.clicks });
            setMeasuringId(null);
            break;
          }
          case 'room_progress':
            setProgressClicks((event.data as { clicks: number }).clicks);
            break;
          case 'mute_problems':
            setMuteProblems(event.data as MuteProblem[]);
            break;
          case 'analyzing':
            setAnalyzing(true);
            break;
          case 'completed': {
            const d = event.data as { results: CalibrationResult[]; driftPpm: number | null; audioGaps: number };
            clearResults();
            d.results.forEach((r) => setResult(r.playerId, r));
            setDriftPpm(d.driftPpm);
            setAudioGaps(d.audioGaps);
            setAnalyzing(false);
            setPhase('results');
            if (autoPushRef.current) {
              const map: Record<string, CalibrationResult> = {};
              d.results.forEach((r) => (map[r.playerId] = r));
              pushSyncOffsets(pushable(map)).then(setPushResults).catch((e) => {
                setError(e instanceof Error ? e.message : 'Auto-push failed');
              });
            }
            break;
          }
          case 'error':
            setError(event.data as string);
            setAnalyzing(false);
            setPhase('instructions');
            break;
        }
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Calibration failed');
      setPhase('instructions');
    }
  };

  // Measure (or re-measure) a room; the reference room's drift check uses kind 'closing'.
  // The session ends the measurement by itself once the clicks agree.
  const startMeasurement = (playerId: string, kind: MeasurementKind) => {
    const session = sessionRef.current;
    if (!session || measuring) return;
    setMeasuringId(kind === 'closing' ? 'closing' : playerId);
    setProgressClicks(0);
    setLastOutcome(null);
    void session.measureRoom(playerId, kind);
  };

  const handleCancelCalibration = () => {
    sessionRef.current?.stop();
    sessionRef.current = null;
    setPhase('instructions');
  };

  const handleBack = () => {
    if (phase === 'instructions') {
      setPhase('selecting');
    } else if (phase === 'listening') {
      handleCancelCalibration();
    } else if (phase === 'results') {
      setPhase('idle');
    }
  };

  // Push speakers that are out of sync, plus any in-sync one whose value the user edited by hand.
  // Speakers with no known delay setting can't be pushed.
  const pushable = (all: Record<string, CalibrationResult>) =>
    Object.fromEntries(
      Object.entries(all).filter(
        ([id, r]) =>
          !r.isReference &&
          r.arrivalMs !== undefined &&
          !!r.setting &&
          (Math.abs(r.arrivalMs) > IN_SYNC_MS || edited.has(id))
      )
    );

  const handleApplyOffsets = async () => {
    if (Object.keys(pushable(results)).length === 0) {
      setError('Nothing to push. Everything is in sync; edit a value to push it anyway.');
      return;
    }

    setIsPushing(true);
    setPushResults(null);
    setError(null);

    try {
      setPushResults(await pushSyncOffsets(pushable(results)));
    } catch (err) {
      console.error('[CalibrationWizard] Failed to apply offsets:', err);
      setError(err instanceof Error ? err.message : 'Failed to apply offsets');
    } finally {
      setIsPushing(false);
    }
  };

  const card = 'p-3 bg-surface rounded-lg';
  const btn = 'px-3 py-2 bg-primary hover:bg-primary-dark disabled:opacity-40 rounded text-sm whitespace-nowrap';
  const wide = 'w-full py-3 px-4 rounded-lg font-medium transition-colors';

  const statusTitle = analyzing
    ? 'Analyzing…'
    : !playing
      ? 'Starting…'
      : live.total === 0
        ? 'Waiting for clicks…'
        : !allRoomsDone
          ? `Go to ${nextRoom?.name}`
          : closingDone
            ? 'All done'
            : `Back to ${firstRoom?.name}`;

  const signalQuality = (() => {
    const fresh = signal !== null && signal.ageS < 5;
    if (!fresh) return { label: 'No click yet', color: 'bg-gray-500', width: 0 };
    const q = signal.snr >= 40 ? 'Good' : signal.snr >= 15 ? 'OK' : 'Weak: turn it up or move closer';
    const color = signal.snr >= 40 ? 'bg-green-500' : signal.snr >= 15 ? 'bg-yellow-500' : 'bg-red-500';
    return { label: q, color, width: Math.max(8, Math.min(100, (Math.log10(Math.max(signal.snr, 1)) / 2.5) * 100)) };
  })();

  return (
    <div className="space-y-4 pb-20">
      {error && <div className="p-3 bg-red-900/30 border border-red-700 rounded-lg text-red-300 text-sm">{error}</div>}

      {/* Ready */}
      {phase === 'instructions' && (
        <>
          <h2 className="text-2xl font-bold text-center">Ready</h2>

          {leaders.length > 1 && (
            <div className="p-3 bg-red-900/20 border border-red-700/50 rounded-lg text-red-300 text-sm space-y-2">
              <p className="font-medium">These speakers aren&apos;t in one sync group.</p>
              <select
                value={playTarget}
                onChange={(e) => setPlayOn(e.target.value)}
                className="w-full px-3 py-2 bg-surface border border-gray-600 rounded"
              >
                {leaders.map((id) => (
                  <option key={id} value={id}>
                    Play on {nameOf(id)}
                  </option>
                ))}
              </select>
              <details className="text-xs text-red-300/70">
                <summary className="cursor-pointer">What MA reports</summary>
                <div className="mt-1 space-y-1 font-mono break-all">
                  {selectedPlayers.map((p) => (
                    <div key={p.player_id}>
                      {p.name}: synced_to={String(p.synced_to ?? null)}, active_group={String(p.active_group ?? null)},
                      group_members={JSON.stringify(p.group_members ?? null)}
                    </div>
                  ))}
                </div>
              </details>
            </div>
          )}

          <div className={`${card} space-y-2`}>
            {selectedPlayers.map((p, i) => (
              <div key={p.player_id} className="flex items-center gap-2">
                <span className="flex-1 font-medium">
                  {p.name}
                  {i === 0 && <span className="ml-2 text-xs px-1.5 py-0.5 bg-primary/30 rounded">Reference</span>}
                  {p.player_id === playTarget && (
                    <span className="ml-2 text-xs px-1.5 py-0.5 bg-gray-700 rounded">Leader</span>
                  )}
                </span>
                {i > 0 && (
                  <button
                    onClick={() => makeReference(p.player_id)}
                    className="text-xs px-2 py-1 bg-gray-700 hover:bg-gray-600 rounded"
                  >
                    Make reference
                  </button>
                )}
              </div>
            ))}
            {unselectedMembers.length > 0 && (
              <div className="text-xs text-text-muted">
                Muted while measuring: {unselectedMembers.map((p) => p.name).join(', ')}
              </div>
            )}
          </div>

          <p className="text-sm text-text-muted text-center">Keep the phone about 1 m from each speaker.</p>

          <button
            onClick={handleStart}
            disabled={selectedPlayers.length < 2}
            className={`${wide} bg-primary hover:bg-primary-dark disabled:opacity-50`}
          >
            {selectedPlayers.length < 2 ? 'Select at least 2 speakers' : 'Start'}
          </button>
          {Object.keys(results).length > 0 && (
            <button onClick={() => setPhase('results')} className={`${wide} bg-secondary hover:bg-secondary/80`}>
              Last results
            </button>
          )}
          <button onClick={handleBack} className={`${wide} bg-surface hover:bg-gray-700`}>
            Back
          </button>
        </>
      )}

      {/* Measuring */}
      {phase === 'listening' && (
        <>
          <h2 className="text-2xl font-bold text-center">{statusTitle}</h2>

          {live.total > 0 && (
            <div>
              <div className="flex justify-between text-xs text-text-muted mb-1">
                <span>Signal</span>
                <span>{signalQuality.label}</span>
              </div>
              <div className="h-2 bg-gray-700 rounded-full overflow-hidden">
                <div
                  className={`h-full ${signalQuality.color}`}
                  style={{ width: `${signalQuality.width}%`, transition: 'width 300ms ease-out' }}
                />
              </div>
            </div>
          )}

          {live.total === 0 && playing && waitedS >= 8 && (
            <div className={`${card} text-sm text-text-muted space-y-1`}>
              {diagnostics === null ? (
                <p>Checking…</p>
              ) : (
                <>
                  {diagnostics.trackRequests === 0 && (
                    <p>MA hasn&apos;t fetched the click track. Allow Node through your firewall on port 5174.</p>
                  )}
                  {diagnostics.trackRequests !== null && diagnostics.trackRequests > 0 && (
                    <p>MA fetched the track. Some players take 10-30 s to start. Check volume and mute.</p>
                  )}
                  {diagnostics.playbackState && (
                    <p>
                      {diagnostics.playerName}: {diagnostics.playbackState}
                    </p>
                  )}
                </>
              )}
            </div>
          )}

          <MuteWarning problems={muteProblems} />

          <div className="space-y-2">
            {selectedPlayers.map((player, i) => {
              const reading = readings[player.player_id];
              const done = (reading?.clicks ?? 0) > 0;
              const isMeasuring = measuringId === player.player_id;
              const heardNothing = lastOutcome?.id === player.player_id && lastOutcome.clicks === 0;
              const warnings = reading?.warnings ?? [];
              return (
                <div key={player.player_id} className={`${card} space-y-1`}>
                  <div className="flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="font-medium truncate">
                        {done ? (warnings.length ? '⚠️ ' : '✅ ') : ''}
                        {player.name}
                        {i === 0 && <span className="ml-2 text-xs text-text-muted">reference</span>}
                      </div>
                      {done && (
                        <div className="text-xs text-text-muted font-mono">
                          {i === 0
                            ? 'baseline'
                            : reading.arrivalMs === null
                              ? 'needs reference'
                              : `${reading.arrivalMs > 0 ? '+' : ''}${reading.arrivalMs.toFixed(0)} ms`}
                          {` · ${reading.clicks} clicks`}
                        </div>
                      )}
                    </div>
                    <button
                      onClick={() => startMeasurement(player.player_id, 'primary')}
                      disabled={!playing || live.total === 0 || measuring}
                      className={btn}
                    >
                      {isMeasuring ? `${progressClicks} clicks…` : done ? 'Redo' : 'Measure'}
                    </button>
                  </div>
                  {warnings.length > 0 && <div className="text-xs text-yellow-300">{warnings.join(' · ')}</div>}
                  {heardNothing && <div className="text-xs text-red-300">Heard nothing. Move closer and retry.</div>}
                </div>
              );
            })}

            {firstRoom && selectedPlayers.length > 1 && (
              <div className={card}>
                <div className="flex items-center gap-3">
                  <div className="flex-1">
                    <div className="font-medium">
                      {closingDone ? '✅ ' : ''}
                      {firstRoom.name} again
                    </div>
                    <div className="text-xs text-text-muted">Drift check</div>
                  </div>
                  <button
                    onClick={() => startMeasurement(firstRoom.player_id, 'closing')}
                    disabled={!allRoomsDone || measuring}
                    className={btn}
                  >
                    {measuringId === 'closing' ? `${progressClicks} clicks…` : closingDone ? 'Redo' : 'Measure'}
                  </button>
                </div>
                {lastOutcome?.id === 'closing' && lastOutcome.clicks === 0 && (
                  <div className="text-xs text-red-300 mt-1">Heard nothing. Retry.</div>
                )}
              </div>
            )}
          </div>

          <button
            onClick={() => sessionRef.current?.finish()}
            disabled={!allRoomsDone || measuring || analyzing}
            className={`${wide} bg-secondary hover:bg-secondary/80 disabled:opacity-40`}
          >
            Finish
          </button>
          <button onClick={handleCancelCalibration} className={`${wide} bg-surface hover:bg-gray-700`}>
            Cancel
          </button>
        </>
      )}

      {/* Results */}
      {phase === 'results' && (
        <>
          <h2 className="text-2xl font-bold text-center">vs {referenceResult?.playerName ?? 'reference'}</h2>

          {referenceResult?.warnings && referenceResult.warnings.length > 0 && (
            <div className="p-3 bg-yellow-900/20 border border-yellow-700/50 rounded-lg text-yellow-300 text-sm">
              Reference was shaky ({referenceResult.warnings.join(' · ')}), so everything below is less certain.
              Redo it, or pick a steadier reference.
            </div>
          )}

          {Object.keys(results).length === 0 ? (
            <div className="p-3 text-center text-text-muted">No results.</div>
          ) : (
            <div className="space-y-3">
              {Object.entries(results).map(([playerId, result]) => {
                const arrival = result.arrivalMs;
                const ms = arrival === undefined ? 0 : Math.round(Math.abs(arrival));
                const inSync = arrival !== undefined && ms <= IN_SYNC_MS;
                return (
                  <div key={playerId} className={`${card} space-y-1`}>
                    <div className="font-medium">
                      {result.playerName}
                      {result.isReference && <span className="ml-2 text-xs text-text-muted">reference</span>}
                    </div>

                    {result.isReference ? null : arrival === undefined ? (
                      <p className="text-red-300">No clicks heard. Measure again.</p>
                    ) : (
                      <>
                        <p
                          className={`text-2xl font-bold ${
                            inSync ? 'text-green-300' : arrival > 0 ? 'text-orange-300' : 'text-blue-300'
                          }`}
                        >
                          {ms} ms {arrival > 0 ? 'late' : 'early'}
                          {inSync && <span className="ml-2 text-sm font-normal">in sync (±{IN_SYNC_MS})</span>}
                        </p>
                        <p className="text-sm text-text-muted">
                          {inSync ? 'Optional: play' : 'Play'} {ms} ms {arrival > 0 ? 'earlier' : 'later'}
                        </p>
                        {result.setting ? (
                          <>
                            <div className="flex items-center gap-2 text-sm pt-1">
                              <span className="text-text-muted">
                                {result.setting.label}: {result.setting.current} →
                              </span>
                              <input
                                type="number"
                                step="1"
                                value={result.offsetMs}
                                onChange={(e) => {
                                  updateOffset(playerId, parseFloat(e.target.value) || 0);
                                  setEdited((prev) => new Set(prev).add(playerId));
                                }}
                                className="w-20 px-2 py-1 bg-background border border-gray-600 rounded font-mono"
                              />
                              <button
                                onClick={() => navigator.clipboard?.writeText(String(Math.round(result.offsetMs)))}
                                className="ml-auto text-xs px-2 py-1 bg-gray-700 hover:bg-gray-600 rounded"
                              >
                                Copy
                              </button>
                            </div>
                            <p className="text-xs text-text-muted">
                              Higher = plays {result.setting.higherIsEarlier ? 'earlier' : 'later (unverified)'}
                              {result.clamped && ` · limit ${result.setting.min} to ${result.setting.max}`}
                              {inSync && !edited.has(playerId) && ' · not pushed unless you edit it'}
                            </p>
                          </>
                        ) : (
                          <p className="text-xs text-text-muted">No delay setting found in MA for this speaker.</p>
                        )}
                      </>
                    )}

                    {result.warnings && result.warnings.length > 0 && (
                      <p className="text-xs text-yellow-300">{result.warnings.join(' · ')}</p>
                    )}
                  </div>
                );
              })}
              {((driftPpm !== null && Math.abs(driftPpm) > 100) || audioGaps > 0) && (
                <p className="text-sm text-yellow-300">
                  {audioGaps > 0 ? 'Mic dropouts' : `High clock drift (${driftPpm?.toFixed(0)} ppm)`}: results are
                  approximate. Measure again.
                </p>
              )}
              <p className="text-xs text-text-muted">Values are changes from your current settings.</p>
            </div>
          )}

          <label className="flex items-center gap-2 text-sm text-text-muted">
            <input
              type="checkbox"
              checked={autoPush}
              onChange={(e) => {
                setAutoPush(e.target.checked);
                try {
                  localStorage.setItem('groupsync_auto_push', e.target.checked ? '1' : '0');
                } catch {
                  // ignore
                }
              }}
            />
            Push to Music Assistant automatically
          </label>

          {pushResults && (
            <div className="space-y-1">
              {pushResults.map((result) => (
                <div
                  key={result.playerId}
                  className={`p-2 rounded text-sm flex gap-2 ${
                    result.success ? 'bg-green-900/20 text-green-300' : 'bg-red-900/20 text-red-300'
                  }`}
                >
                  <span>{result.success ? '✓' : '✗'}</span>
                  <span className="flex-1">{result.playerName}</span>
                  {!result.success && <span className="text-xs opacity-75">{result.error}</span>}
                </div>
              ))}
            </div>
          )}

          <div className="flex gap-3">
            <button
              onClick={() => {
                setPhase('instructions');
                setPushResults(null);
              }}
              disabled={isPushing}
              className="flex-1 py-3 px-4 bg-surface hover:bg-gray-700 disabled:opacity-50 rounded-lg font-medium"
            >
              Measure again
            </button>
            <button
              onClick={handleApplyOffsets}
              disabled={Object.keys(results).length === 0 || isPushing}
              className="flex-1 py-3 px-4 bg-primary hover:bg-primary-dark disabled:opacity-50 rounded-lg font-medium"
            >
              {isPushing ? 'Pushing…' : 'Push to MA'}
            </button>
          </div>
          <button
            onClick={() => {
              setPhase('idle');
              setPushResults(null);
            }}
            className={`${wide} bg-secondary hover:bg-secondary/80`}
          >
            Done
          </button>
        </>
      )}
    </div>
  );
}
