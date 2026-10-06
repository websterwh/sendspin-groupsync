import { useEffect, useMemo, useRef, useState } from 'react';
import { useCalibrationStore, usePlayersStore, useConnectionStore } from '../store';
import { createCalibrationSession, CalibrationSession } from '../calibration';
import type { RoomReading, MeasurementKind, PlaybackDiagnostics } from '../calibration/CalibrationSession';
import { analyzeGroups, otherGroupMembers } from '../calibration/grouping';
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
  const [measuringLeft, setMeasuringLeft] = useState(0);
  const [measuringName, setMeasuringName] = useState('');
  const [live, setLive] = useState({ total: 0, timedOut: false, remaining: 0 });
  const [playing, setPlaying] = useState(false);
  const [signal, setSignal] = useState<{ ageS: number; snr: number } | null>(null);
  const [waitedS, setWaitedS] = useState(0);
  const [diagnostics, setDiagnostics] = useState<PlaybackDiagnostics | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [driftPpm, setDriftPpm] = useState<number | null>(null);
  const [audioGaps, setAudioGaps] = useState(0);
  const [muteProblems, setMuteProblems] = useState<{ name: string; reason: string }[]>([]);

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
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      sessionRef.current?.stop();
      if (countdownRef.current) clearInterval(countdownRef.current);
    };
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
    setMeasuringId(null);
    setLastOutcome(null);
    setMuteProblems([]);
    setClosingDone(false);
    setPlaying(false);
    setWaitedS(0);
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
            setMeasuringLeft(0);
            break;
          }
          case 'mute_problems':
            setMuteProblems(event.data as { name: string; reason: string }[]);
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

  // Measure (or re-measure) a room; the reference room's closing check uses kind 'closing'
  const startMeasurement = (playerId: string, kind: MeasurementKind) => {
    const session = sessionRef.current;
    if (!session || measuring) return;
    setMeasuringName(nameOf(playerId));
    setMeasuringId(kind === 'closing' ? 'closing' : playerId);
    setLastOutcome(null);
    setMeasuringLeft(session.windowSeconds + 3);
    void session.measureRoom(playerId, kind);
    if (countdownRef.current) clearInterval(countdownRef.current);
    countdownRef.current = setInterval(() => {
      setMeasuringLeft((n) => {
        if (n <= 1 && countdownRef.current) clearInterval(countdownRef.current);
        return Math.max(0, n - 1);
      });
    }, 1000);
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

  // Only push speakers that need a change and whose current MA value is known (never overwrite blindly)
  const pushable = (all: Record<string, CalibrationResult>) =>
    Object.fromEntries(
      Object.entries(all).filter(
        ([, r]) => !r.isReference && r.arrivalMs !== undefined && Math.abs(r.arrivalMs) > IN_SYNC_MS && !!r.setting
      )
    );

  const handleApplyOffsets = async () => {
    if (Object.keys(pushable(results)).length === 0) {
      setError('Nothing to push: either every speaker is already in sync, or no delay setting was found in Music Assistant for the ones that are out.');
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

  return (
    <div className="space-y-6 pb-20">
      {error && (
        <div className="p-3 bg-red-900/30 border border-red-700 rounded-lg text-red-300 text-sm">{error}</div>
      )}

      {/* Instructions Phase */}
      {phase === 'instructions' && (
        <>
          <div className="text-center">
            <div className="text-6xl mb-4">📱</div>
            <h2 className="text-2xl font-bold mb-2">How this works</h2>
            <p className="text-text-muted">
              A click track plays on the whole group while your phone records. All speakers keep
              playing the whole time (that&apos;s what keeps them in sync); when you tap <b>Measure here</b> the others are
              muted briefly so only the one next to you is heard. Rooms are compared inside one recording, so
              nothing needs to be lined up in advance.
            </p>
          </div>

          <div className="p-4 bg-blue-900/20 border border-blue-700/50 rounded-lg text-blue-300 text-sm">
            <ul className="list-disc list-inside text-blue-300/70 space-y-1">
              <li>The players must be in one sync group in Music Assistant (so they play the same stream)</li>
              <li>Hold the phone at the same distance (about 1 m) from each speaker. 1 m closer makes a speaker arrive about 3 ms earlier, so in a shared room keep the phone centred between them</li>
              <li>About 12 seconds per room, plus a return to the first room at the end to correct clock drift</li>
              <li>Keep the rooms quiet; keep the phone still while measuring. The other players are muted automatically while each room is measured (and restored after), so speakers sharing a room are fine.</li>
            </ul>
          </div>

          {leaders.length > 1 && (
            <div className="p-4 bg-red-900/20 border border-red-700/50 rounded-lg text-red-300 text-sm space-y-2">
              <p className="font-medium">These players are not in the same sync group.</p>
              <p className="text-red-300/70">
                Players that aren&apos;t grouped start the track at different times, so the numbers
                would be meaningless. Group them in Music Assistant first, or choose the group to play on:
              </p>
              <details className="text-xs text-red-300/70">
                <summary className="cursor-pointer">What Music Assistant reports</summary>
                <div className="mt-1 space-y-1 font-mono break-all">
                  {selectedPlayers.map((p) => (
                    <div key={p.player_id}>
                      {p.name} (id {p.player_id}, type {p.type}): synced_to={String(p.synced_to ?? null)},
                      active_group={String(p.active_group ?? null)}, group_members=
                      {JSON.stringify(p.group_members ?? null)} &rarr; group #{groups.groupIndex[p.player_id] + 1}
                    </div>
                  ))}
                </div>
              </details>
              <select
                value={playTarget}
                onChange={(e) => setPlayOn(e.target.value)}
                className="w-full px-3 py-2 bg-surface border border-gray-600 rounded"
              >
                {leaders.map((id) => (
                  <option key={id} value={id}>
                    {nameOf(id)}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="p-3 bg-surface rounded-lg text-sm space-y-3">
            <div>
              <div className="text-text-muted">Track plays on (sync group leader):</div>
              <div className="font-medium">
                {nameOf(playTarget)}
                {!selectedPlayers.some((p) => p.player_id === playTarget) && (
                  <span className="text-xs text-text-muted ml-2">not one of the measured rooms</span>
                )}
              </div>
              <div className="text-xs text-text-muted">Chosen automatically from the group in Music Assistant.</div>
            </div>
            <div>
              <div className="text-text-muted mb-1">Rooms, in measuring order:</div>
              <div className="space-y-2">
                {selectedPlayers.map((p, i) => (
                  <div key={p.player_id} className="flex items-center gap-2">
                    <span className="flex-1 font-medium">
                      {p.name}
                      {i === 0 && <span className="ml-2 text-xs px-1.5 py-0.5 bg-primary/30 rounded">Reference</span>}
                      {p.player_id === playTarget && (
                        <span className="ml-2 text-xs px-1.5 py-0.5 bg-gray-700 rounded">Group leader</span>
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
              </div>
              {unselectedMembers.length > 0 && (
                <div className="text-xs text-yellow-300 mt-2">
                  Also in this group, so it plays along: {unselectedMembers.map((p) => p.name).join(', ')}. It is
                  muted automatically while each room is measured and restored after, but isn&apos;t measured. To
                  measure it too, select it.
                </div>
              )}
              <div className="text-xs text-text-muted mt-2">
                The reference is measured first and last, and is the baseline the others are compared to.
                While one room is measured, the other players are muted automatically and restored after.
              </div>
            </div>
          </div>

          <button
            onClick={handleStart}
            disabled={selectedPlayers.length < 2}
            className="w-full py-3 px-4 bg-primary hover:bg-primary-dark disabled:opacity-50
                       rounded-lg font-medium transition-colors"
          >
            {selectedPlayers.length < 2 ? 'Select at least 2 players' : 'Start - stand in the first room'}
          </button>

          {Object.keys(results).length > 0 && (
            <button
              onClick={() => setPhase('results')}
              className="w-full py-3 px-4 bg-secondary hover:bg-secondary/80 rounded-lg font-medium transition-colors"
            >
              View last results
            </button>
          )}

          <button
            onClick={handleBack}
            className="w-full py-3 px-4 bg-surface hover:bg-gray-700 rounded-lg font-medium transition-colors"
          >
            Back to Player Selection
          </button>
        </>
      )}

      {/* Listening Phase */}
      {phase === 'listening' && (
        <>
          <div className="text-center">
            <div className="text-6xl mb-4 animate-pulse">🎤</div>
            <h2 className="text-2xl font-bold mb-2">
              {analyzing ? 'Analyzing...' : !playing ? 'Starting playback...' : live.total === 0 ? 'Waiting for the clicks...' : allRoomsDone && !closingDone ? 'Go back to the first room' : nextRoom ? `Go to ${nextRoom.name}` : 'All done'}
            </h2>
            <p className="text-text-muted text-sm">
              {live.total === 0 && playing
                ? 'Some players take a few seconds to start. Stay in the first room.'
                : `Heard ${live.total} click${live.total === 1 ? '' : 's'} so far. ${Math.round(live.remaining)} s of track left.`}
            </p>
          </div>

          {live.total === 0 && playing && waitedS >= 8 && (
            <div className="p-3 bg-surface border border-gray-600 rounded-lg text-sm space-y-1">
              <p className="font-medium">Still waiting ({Math.round(waitedS)} s). What&apos;s happening:</p>
              {diagnostics === null ? (
                <p className="text-text-muted">Checking...</p>
              ) : (
                <ul className="list-disc list-inside text-text-muted space-y-1">
                  <li>
                    {diagnostics.trackRequests === null
                      ? 'Could not check whether Music Assistant fetched the click track (not running through the GroupSync dev server).'
                      : diagnostics.trackRequests === 0
                        ? 'Music Assistant has NOT requested the click track from this computer. It probably can\'t reach it: allow incoming connections for Node on port 5174 in your computer\'s firewall, and check MA and this computer are on the same network.'
                        : `Music Assistant fetched the click track ${diagnostics.trackRequests} time(s)${diagnostics.lastRequestAgoS !== null ? `, last ${diagnostics.lastRequestAgoS} s ago` : ''}${diagnostics.lastRequestIp ? ` from ${diagnostics.lastRequestIp}` : ''}. So it is playing or about to; some players take 10-30 s to start.`}
                  </li>
                  <li>
                    {diagnostics.playbackState
                      ? `${diagnostics.playerName} is "${diagnostics.playbackState}" in Music Assistant.`
                      : `Music Assistant doesn't report a playback state for ${diagnostics.playerName}.`}
                  </li>
                  {diagnostics.trackRequests !== null && diagnostics.trackRequests > 0 && (
                    <li>If it says playing but you hear nothing: check the volume and that nothing in the group is muted.</li>
                  )}
                </ul>
              )}
            </div>
          )}

          {live.timedOut && (
            <div className="p-3 bg-red-900/20 border border-red-700/50 rounded-lg text-red-300 text-sm">
              No clicks heard after 40 s. Check that the speakers are playing, the volume is up, and the
              phone is close. If MA reports a playback error, the click track URL may not be reachable
              from your Music Assistant server.
            </div>
          )}

          {measuringLeft > 0 && (
            <div className="p-3 bg-primary/20 border border-primary rounded-lg text-sm text-center">
              Measuring <b>{measuringName}</b>. All speakers keep playing in sync; the others are muted for
              these few seconds so only this one is heard. Hold the phone still.
            </div>
          )}

          {muteProblems.length > 0 && (
            <div className="p-3 bg-yellow-900/20 border border-yellow-700/50 rounded-lg text-yellow-300 text-sm space-y-1">
              <p className="font-medium">Couldn&apos;t mute every other player while measuring:</p>
              <ul className="list-disc list-inside text-yellow-300/70">
                {muteProblems.map((m) => (
                  <li key={m.name}>
                    {m.name}: {m.reason}
                  </li>
                ))}
              </ul>
              <p className="text-yellow-300/70">
                Those players will still be audible in other rooms, which can blur results if they share a
                room with the one being measured. Mute them by hand (on the device or in MA) before tapping
                Measure here.
              </p>
            </div>
          )}

          {/* Signal strength of the clicks being heard, not raw room noise: updates when a click lands */}
          {live.total > 0 && (
            <div>
              {(() => {
                const fresh = signal !== null && signal.ageS < 5;
                const quality = !fresh ? 'none' : signal.snr >= 40 ? 'good' : signal.snr >= 15 ? 'ok' : 'weak';
                const color = { none: 'bg-gray-500', good: 'bg-green-500', ok: 'bg-yellow-500', weak: 'bg-red-500' }[quality];
                const width = fresh ? Math.max(8, Math.min(100, (Math.log10(Math.max(signal.snr, 1)) / 2.5) * 100)) : 0;
                const text = {
                  none: 'No click heard in the last few seconds',
                  good: 'Good signal',
                  ok: 'OK signal',
                  weak: 'Weak signal: turn that speaker up or move the phone closer',
                }[quality];
                return (
                  <>
                    <div className="flex justify-between text-xs text-text-muted mb-1">
                      <span>Click signal</span>
                      <span>{text}</span>
                    </div>
                    <div className="h-3 bg-gray-700 rounded-full overflow-hidden">
                      <div className={`h-full ${color}`} style={{ width: `${width}%`, transition: 'width 300ms ease-out' }} />
                    </div>
                  </>
                );
              })()}
            </div>
          )}

          <div className="space-y-2">
            {selectedPlayers.map((player, i) => {
              const reading = readings[player.player_id];
              const done = (reading?.clicks ?? 0) > 0;
              const isMeasuring = measuringId === player.player_id;
              const heardNothing = lastOutcome?.id === player.player_id && lastOutcome.clicks === 0;
              const warnings = reading?.warnings ?? [];
              return (
                <div key={player.player_id} className="p-3 bg-surface rounded-lg space-y-2">
                  <div className="flex items-center gap-3">
                    <div className="text-xl">{done ? (warnings.length ? '⚠️' : '✅') : isMeasuring ? '⏺' : '🔊'}</div>
                    <div className="flex-1">
                      <div className="font-medium">{player.name}</div>
                      <div className="text-xs text-text-muted">
                        {[i === 0 ? 'Reference room' : '', player.player_id === playTarget ? 'Group leader' : '']
                          .filter(Boolean)
                          .join(' · ')}
                      </div>
                    </div>
                    <button
                      onClick={() => startMeasurement(player.player_id, 'primary')}
                      disabled={!playing || live.total === 0 || measuring}
                      className="px-3 py-2 bg-primary hover:bg-primary-dark disabled:opacity-40 rounded text-sm"
                    >
                      {isMeasuring ? `Hold still ${measuringLeft}s` : done ? 'Measure again' : 'Measure here'}
                    </button>
                  </div>
                  {done && (
                    <div className="text-xs text-text-muted font-mono">
                      {i === 0
                        ? 'baseline'
                        : reading.arrivalMs === null
                          ? 'measure the reference room first'
                          : `${reading.arrivalMs > 0 ? '+' : ''}${reading.arrivalMs.toFixed(1)} ms vs reference`}
                      {' · '}
                      {reading.clicks} clicks
                      {reading.spreadMs !== null && ` · ±${reading.spreadMs.toFixed(1)} ms`}
                    </div>
                  )}
                  {warnings.length > 0 && (
                    <ul className="text-xs text-yellow-300 list-disc list-inside">
                      {warnings.map((w) => (
                        <li key={w}>{w}</li>
                      ))}
                      <li className="list-none text-yellow-300/70">Tap Measure again to redo this room.</li>
                    </ul>
                  )}
                  {heardNothing && (
                    <div className="text-xs text-red-300">
                      Heard nothing that time{done ? ' (the earlier measurement was kept)' : ''}. Move closer to this
                      speaker, check it isn&apos;t muted or paused, and try again.
                    </div>
                  )}
                </div>
              );
            })}

            {firstRoom && selectedPlayers.length > 1 && (
              <div className="p-3 bg-surface rounded-lg space-y-2">
                <div className="flex items-center gap-3">
                  <div className="text-xl">{closingDone ? '✅' : '🔁'}</div>
                  <div className="flex-1">
                    <div className="font-medium">{firstRoom.name} again</div>
                    <div className="text-xs text-text-muted">Corrects clock drift (recommended)</div>
                  </div>
                  <button
                    onClick={() => startMeasurement(firstRoom.player_id, 'closing')}
                    disabled={!allRoomsDone || measuring}
                    className="px-3 py-2 bg-primary hover:bg-primary-dark disabled:opacity-40 rounded text-sm"
                  >
                    {measuringId === 'closing' ? `Hold still ${measuringLeft}s` : closingDone ? 'Measure again' : 'Measure here'}
                  </button>
                </div>
                {lastOutcome?.id === 'closing' && lastOutcome.clicks === 0 && (
                  <div className="text-xs text-red-300">Heard nothing that time. Try again.</div>
                )}
              </div>
            )}
          </div>

          <button
            onClick={() => sessionRef.current?.finish()}
            disabled={!allRoomsDone || measuring || analyzing}
            className="w-full py-3 px-4 bg-secondary hover:bg-secondary/80 disabled:opacity-40
                       rounded-lg font-medium transition-colors"
          >
            {closingDone ? 'Finish' : 'Finish without drift check'}
          </button>

          <button
            onClick={handleCancelCalibration}
            className="w-full py-3 px-4 bg-surface hover:bg-gray-700 rounded-lg font-medium transition-colors"
          >
            Cancel
          </button>
        </>
      )}

      {/* Results Phase */}
      {phase === 'results' && (
        <>
          <div className="text-center">
            <div className="text-6xl mb-4">✅</div>
            <h2 className="text-2xl font-bold mb-2">
              How far each speaker is from {referenceResult?.playerName ?? 'the reference'}
            </h2>
            <p className="text-text-muted">
              {referenceResult?.playerName ?? 'The reference'} is the baseline and stays as it is. Everything
              else is compared to it.
            </p>
          </div>

          {referenceResult?.warnings && referenceResult.warnings.length > 0 && (
            <div className="p-3 bg-yellow-900/20 border border-yellow-700/50 rounded-lg text-yellow-300 text-sm">
              <p className="font-medium">The baseline ({referenceResult.playerName}) was shaky:</p>
              <ul className="list-disc list-inside text-yellow-300/70">
                {referenceResult.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
              <p className="text-yellow-300/70">
                Every number below is measured against it, so it inherits that uncertainty. Measure it again, or
                choose a steadier speaker with <b>Make reference</b> and run the test again.
              </p>
            </div>
          )}

          {Object.keys(results).length === 0 ? (
            <div className="p-4 bg-yellow-900/20 border border-yellow-700/50 rounded-lg text-yellow-300 text-sm text-center">
              No results yet.
            </div>
          ) : (
            <div className="space-y-4">
              {Object.entries(results).map(([playerId, result]) => {
                const arrival = result.arrivalMs;
                const ms = arrival === undefined ? 0 : Math.round(Math.abs(arrival));
                const inSync = arrival !== undefined && ms <= IN_SYNC_MS;
                return (
                  <div key={playerId} className="p-4 bg-surface rounded-lg space-y-2">
                    <div className="flex justify-between items-baseline">
                      <span className="font-medium">
                        {result.playerName}
                        {result.isReference && (
                          <span className="text-xs ml-2 px-1.5 py-0.5 bg-primary/30 rounded">Baseline</span>
                        )}
                      </span>
                    </div>

                    {result.isReference ? (
                      <p className="text-text-muted">The others are compared to this speaker.</p>
                    ) : arrival === undefined ? (
                      <p className="text-red-300">No clicks heard. Measure this room again.</p>
                    ) : inSync ? (
                      <>
                        <p className="text-lg font-semibold text-green-300">
                          In sync with {referenceResult?.playerName}
                        </p>
                        <p className="text-xs text-text-muted">
                          Measured {ms} ms {arrival > 0 ? 'late' : 'early'}, which is within what this method can
                          reliably measure (about ±5 ms) and too small to hear. Leave it as it is; chasing it can make
                          the next test read the other way.
                        </p>
                      </>
                    ) : (
                      <>
                        <p className={`text-2xl font-bold ${arrival > 0 ? 'text-orange-300' : 'text-blue-300'}`}>
                          {ms} ms {arrival > 0 ? 'late' : 'early'}
                        </p>
                        <p className="text-sm">
                          Plays {ms} ms {arrival > 0 ? 'after' : 'before'} {referenceResult?.playerName}. To fix it,
                          make it play <b>{ms} ms {arrival > 0 ? 'earlier' : 'later'}</b>.
                        </p>
                      </>
                    )}

                    {!result.isReference && arrival !== undefined && !inSync && (
                      <div className="text-sm space-y-1">
                        {result.setting ? (
                          <>
                            <div className="text-text-muted">{result.setting.label} in Music Assistant:</div>
                            <div className="flex items-center gap-2">
                              <span className="text-text-muted">Now {result.setting.current} &rarr;</span>
                              <input
                                type="number"
                                step="1"
                                value={result.offsetMs}
                                onChange={(e) => updateOffset(playerId, parseFloat(e.target.value) || 0)}
                                className="w-24 px-2 py-1 bg-background border border-gray-600 rounded font-mono"
                              />
                              <span className="text-text-muted">ms</span>
                              <button
                                onClick={() => navigator.clipboard?.writeText(String(Math.round(result.offsetMs)))}
                                className="ml-auto text-xs px-2 py-1 bg-gray-700 hover:bg-gray-600 rounded"
                              >
                                Copy
                              </button>
                            </div>
                            <p className="text-xs text-text-muted">
                              {result.setting.higherIsEarlier
                                ? 'A higher value makes this speaker play earlier, a lower one later.'
                                : 'Assumed: a higher value makes this speaker play later. Not verified for this setting, so check the direction on one speaker first.'}
                              {result.setting.configPlayerId !== playerId &&
                                ' (This setting lives on the device\'s Sendspin protocol player under Output protocols.)'}
                            </p>
                            {result.clamped && (
                              <p className="text-xs text-yellow-300">
                                That is as far as this setting goes ({result.setting.min} to {result.setting.max} ms), so
                                it can&apos;t fully correct this speaker. Move the other speakers instead.
                              </p>
                            )}
                          </>
                        ) : (
                          <p className="text-xs text-text-muted">
                            No delay setting was found for this speaker in Music Assistant. Apply the change
                            ({arrival > 0 ? 'earlier' : 'later'} by {ms} ms) wherever you set its delay.
                          </p>
                        )}
                      </div>
                    )}

                    <div className="text-xs text-text-muted">
                      {result.detectedClicks} clicks used
                      {result.spreadMs !== undefined && ` · ±${result.spreadMs.toFixed(1)} ms between clicks`}
                    </div>
                    {result.warnings && result.warnings.length > 0 && (
                      <ul className="text-xs text-yellow-300 list-disc list-inside">
                        {result.warnings.map((w) => (
                          <li key={w}>{w}</li>
                        ))}
                        <li className="list-none text-yellow-300/70">
                          Consider measuring this one again before trusting the value.
                        </li>
                      </ul>
                    )}
                  </div>
                );
              })}
              {((driftPpm !== null && Math.abs(driftPpm) > 100) || audioGaps > 0) && (
                <div className="p-3 bg-yellow-900/20 border border-yellow-700/50 rounded-lg text-yellow-300 text-sm">
                  {audioGaps > 0
                    ? `The microphone stream had ${audioGaps} dropout(s), which shifts the timing. `
                    : `Clock drift of ${driftPpm?.toFixed(0)} ppm is unusually high (normal is under ~50). `}
                  Treat these numbers as approximate and measure again.
                </div>
              )}
              <p className="text-xs text-text-muted">
                Measured with whatever delays are set right now, so these are changes from your current setup, not new absolute values.
                {driftPpm !== null && ` Clock drift corrected: ${driftPpm.toFixed(0)} ppm.`}
              </p>
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
            Automatically push each result to Music Assistant
          </label>

          {/* Push Results */}
          {pushResults && (
            <div className="space-y-2">
              <h3 className="font-medium text-sm text-text-muted">Push Results</h3>
              {pushResults.map((result) => (
                <div
                  key={result.playerId}
                  className={`p-3 rounded-lg text-sm flex items-center gap-2 ${
                    result.success
                      ? 'bg-green-900/20 border border-green-700/50 text-green-300'
                      : 'bg-red-900/20 border border-red-700/50 text-red-300'
                  }`}
                >
                  <span>{result.success ? '✓' : '✗'}</span>
                  <span className="flex-1">{result.playerName}</span>
                  {result.success ? (
                    <span className="text-xs opacity-75">via {result.method}</span>
                  ) : (
                    <span className="text-xs opacity-75">{result.error}</span>
                  )}
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
              className="flex-1 py-3 px-4 bg-surface hover:bg-gray-700 disabled:opacity-50
                         rounded-lg font-medium transition-colors"
            >
              Measure Again
            </button>
            <button
              onClick={handleApplyOffsets}
              disabled={Object.keys(results).length === 0 || isPushing}
              className="flex-1 py-3 px-4 bg-primary hover:bg-primary-dark disabled:opacity-50
                         rounded-lg font-medium transition-colors flex items-center justify-center gap-2"
            >
              {isPushing ? (
                <>
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  Applying...
                </>
              ) : pushResults?.every((r) => r.success) ? (
                'Done!'
              ) : (
                'Push to Music Assistant'
              )}
            </button>
          </div>

          {pushResults?.every((r) => r.success) && (
            <button
              onClick={() => {
                setPhase('idle');
                setPushResults(null);
              }}
              className="w-full py-3 px-4 bg-secondary hover:bg-secondary/80
                         rounded-lg font-medium transition-colors"
            >
              Finish
            </button>
          )}
        </>
      )}
    </div>
  );
}
