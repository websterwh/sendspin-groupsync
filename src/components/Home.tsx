import { useAppStore, usePlayersStore, useConnectionStore } from '../store';
import { maClient } from '../ma-client';

export function Home() {
  const setScreen = useAppStore((s) => s.setScreen);
  const resetPlayers = usePlayersStore((s) => s.reset);
  const resetConnection = useConnectionStore((s) => s.reset);

  const disconnect = () => {
    maClient.disconnect();
    resetConnection();
    resetPlayers();
  };

  const card = 'w-full text-left p-4 bg-surface hover:bg-gray-700 rounded-lg border border-gray-600 transition-colors';

  return (
    <div className="space-y-4">
      <h2 className="text-2xl font-bold text-center">GroupSync</h2>

      <button className={card} onClick={() => setScreen('click')}>
        <div className="font-medium">Click test</div>
        <div className="text-sm text-text-muted">Measure each speaker against the lead and get the delay to set.</div>
      </button>

      {import.meta.env.DEV && (
        <button className={card} onClick={() => setScreen('song')}>
          <div className="font-medium">Song test</div>
          <div className="text-sm text-text-muted">Play a long song from your music folder; shows which speaker is later and by how much.</div>
        </button>
      )}

      {import.meta.env.DEV && (
        <button className={card} onClick={() => setScreen('live')}>
          <div className="font-medium">Live drift test</div>
          <div className="text-sm text-text-muted">Watch the gap between two speakers while your own music plays.</div>
        </button>
      )}

      <button onClick={disconnect} className="w-full py-3 text-sm text-text-muted hover:text-white">
        Disconnect
      </button>
    </div>
  );
}
