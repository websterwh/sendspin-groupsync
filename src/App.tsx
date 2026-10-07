import { lazy, Suspense } from 'react';
import { useConnectionStore, useCalibrationStore, useAppStore } from './store';
import { ConnectionPanel } from './components/ConnectionPanel';
import { Home } from './components/Home';
import { PlayerList } from './components/PlayerList';
import { CalibrationWizard } from './components/CalibrationWizard';

// Dev-only tool: not part of production builds (and so not in the Home Assistant add-on)
const LiveHub = import.meta.env.DEV ? lazy(() => import('./components/LiveHub')) : null;

function App() {
  const { connected } = useConnectionStore();
  const { phase } = useCalibrationStore();
  const { screen, setScreen } = useAppStore();

  return (
    <div className="min-h-screen bg-background text-text">
      {/* Header */}
      <header className="bg-surface border-b border-gray-700 px-4 py-3">
        <div className="max-w-lg mx-auto flex items-center justify-between">
          <h1 className="text-xl font-bold text-primary">GroupSync</h1>
          {connected && (
            <span className="text-xs text-secondary flex items-center gap-1">
              <span className="w-2 h-2 bg-secondary rounded-full animate-pulse" />
              Connected
            </span>
          )}
        </div>
      </header>

      {/* Main content */}
      <main className="max-w-lg mx-auto p-4">
        {!connected ? (
          <ConnectionPanel />
        ) : screen === 'home' ? (
          <Home />
        ) : screen === 'live' && LiveHub ? (
          <Suspense fallback={<p className="text-text-muted">Loading…</p>}>
            <LiveHub onBack={() => setScreen('home')} />
          </Suspense>
        ) : phase === 'idle' || phase === 'selecting' ? (
          <PlayerList onBack={() => setScreen('home')} />
        ) : (
          <CalibrationWizard />
        )}
      </main>
    </div>
  );
}

export default App;
