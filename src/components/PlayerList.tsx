import { usePlayersStore, useCalibrationStore } from '../store';
import { useState } from 'react';
import { maClient } from '../ma-client';

interface Props {
  /** 'click' picks any number of speakers; 'live' picks exactly two */
  variant?: 'click' | 'live';
  onBack: () => void;
  /** Called by the Start button (default: open the click-test instructions) */
  onStart?: () => void;
}

export function PlayerList({ variant = 'click', onBack, onStart }: Props) {
  const { players, setPlayers, selectedPlayerIds, togglePlayerSelection, setSelection, loading } = usePlayersStore();
  const [cleaning, setCleaning] = useState(false);
  // Leftovers from older GroupSync versions that registered a Sendspin player on every run
  const ghostPlayers = players.filter((p) => p.name === 'GroupSync');

  const handleCleanup = async () => {
    if (!window.confirm(`Remove ${ghostPlayers.length} "GroupSync" player(s) from Music Assistant? Other players are not touched.`)) return;
    setCleaning(true);
    for (const ghost of ghostPlayers) {
      try {
        await maClient.removePlayerConfig(ghost.player_id);
      } catch (e) {
        console.warn('[UI] Could not remove', ghost.player_id, e);
      }
    }
    try {
      setPlayers(await maClient.getAllPlayers());
    } finally {
      setCleaning(false);
    }
  };
  const { setPhase } = useCalibrationStore();
  const live = variant === 'live';
  const canStart = live ? selectedPlayerIds.length === 2 : selectedPlayerIds.length > 0;

  const handleStart = () => {
    if (!canStart) return;
    if (onStart) onStart();
    else setPhase('instructions');
  };

  // The live test compares exactly two speakers: picking a third replaces the oldest pick
  const handleToggle = (id: string) => {
    if (live && !selectedPlayerIds.includes(id) && selectedPlayerIds.length >= 2) {
      setSelection([selectedPlayerIds[1], id]);
    } else {
      togglePlayerSelection(id);
    }
  };

  const noPlayersFound = players.length === 0 && !loading;

  return (
    <div className="space-y-6 pb-24">
      <div>
        <h2 className="text-2xl font-bold">{live ? 'Pick two speakers' : 'Speakers'}</h2>
        <p className="text-text-muted text-sm">
          {live
            ? 'They need to share a sync group in Music Assistant.'
            : 'Pick the speakers to compare. They need to share a sync group in Music Assistant.'}
        </p>
      </div>

      {loading ? (
        <div className="flex flex-col items-center justify-center py-8 gap-3">
          <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          <p className="text-text-muted text-sm">Discovering players...</p>
        </div>
      ) : (
        <>
          {noPlayersFound && (
            <div className="p-4 bg-yellow-900/20 border border-yellow-700/50 rounded-lg text-yellow-300 text-sm">
              No players found.
            </div>
          )}

          {ghostPlayers.length > 0 && (
            <div className="p-3 bg-yellow-900/20 border border-yellow-700/50 rounded-lg text-yellow-300 text-sm flex items-center gap-3">
              <span className="flex-1">
                {ghostPlayers.length} leftover &quot;GroupSync&quot; player(s).
              </span>
              <button
                onClick={handleCleanup}
                disabled={cleaning}
                className="px-3 py-1 bg-yellow-700/40 hover:bg-yellow-700/60 rounded disabled:opacity-50"
              >
                {cleaning ? 'Removing...' : 'Remove'}
              </button>
            </div>
          )}

          <div className="space-y-3">
            {players.filter((p) => p.name !== 'GroupSync').map((player) => {
              // A group player is one entity; its members are the rooms to measure
              const isGroup = player.type === 'group';
              const isAvailable = player.available !== false && player.powered !== false && !isGroup;
              const isSelected = selectedPlayerIds.includes(player.player_id);

              return (
                <button
                  key={player.player_id}
                  onClick={() => {
                    console.log('[UI] Tapped player:', player.player_id, player.name);
                    handleToggle(player.player_id);
                  }}
                  disabled={!isAvailable}
                  className={`w-full flex items-center gap-3 p-4 rounded-lg border transition-colors touch-manipulation
                    ${isSelected
                      ? 'bg-primary/20 border-primary'
                      : 'bg-surface border-gray-600 hover:border-gray-500'
                    }
                    ${!isAvailable && 'opacity-50 cursor-not-allowed'}
                  `}
                >
                  <div className={`w-5 h-5 rounded border-2 flex items-center justify-center shrink-0
                    ${isSelected
                      ? 'bg-primary border-primary'
                      : 'border-gray-500'
                    }
                  `}>
                    {isSelected && (
                      <svg className="w-3 h-3 text-white" fill="currentColor" viewBox="0 0 20 20">
                        <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                      </svg>
                    )}
                  </div>
                  <div className="flex-1 text-left min-w-0">
                    <div className="font-medium truncate">{player.name}</div>
                    <div className="text-sm text-text-muted">
                      {isGroup ? 'Group: pick its speakers instead' : isAvailable ? 'Available' : 'Offline'}
                    </div>
                  </div>
                  <div className={`w-2 h-2 rounded-full shrink-0 ${isAvailable ? 'bg-secondary' : 'bg-gray-500'}`} />
                </button>
              );
            })}
          </div>
        </>
      )}

      <div className="fixed bottom-0 left-0 right-0 p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] bg-background border-t border-gray-700">
        <div className="max-w-lg mx-auto flex gap-3">
          <button
            onClick={onBack}
            className="px-4 py-3 bg-surface hover:bg-gray-700 rounded-lg font-medium transition-colors"
          >
            Back
          </button>
          <button
            onClick={handleStart}
            disabled={!canStart}
            className="flex-1 py-3 px-4 bg-primary hover:bg-primary-dark disabled:opacity-50
                       rounded-lg font-medium transition-colors"
          >
            {live ? `Next (${selectedPlayerIds.length}/2)` : `Start (${selectedPlayerIds.length})`}
          </button>
        </div>
      </div>
    </div>
  );
}
