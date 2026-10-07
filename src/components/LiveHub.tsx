/**
 * Live sync test (dev only): one entry for both ways of watching two speakers while they play.
 */
import { lazy, Suspense, useState } from 'react';

const SongTest = lazy(() => import('./SongTest'));
const LiveTest = lazy(() => import('./LiveTest'));

export default function LiveHub({ onBack }: { onBack: () => void }) {
  const [mode, setMode] = useState<'choose' | 'song' | 'blind'>('choose');
  const back = () => setMode('choose');

  if (mode === 'song')
    return (
      <Suspense fallback={<p className="text-text-muted">Loading…</p>}>
        <SongTest onBack={back} />
      </Suspense>
    );
  if (mode === 'blind')
    return (
      <Suspense fallback={<p className="text-text-muted">Loading…</p>}>
        <LiveTest onBack={back} />
      </Suspense>
    );

  const card = 'w-full text-left p-4 bg-surface hover:bg-gray-700 rounded-lg border border-gray-600 transition-colors';
  return (
    <div className="space-y-4">
      <h2 className="text-2xl font-bold text-center">Live sync test</h2>
      <p className="text-sm text-text-muted text-center">What should the speakers play?</p>
      <button className={card} onClick={() => setMode('song')}>
        <div className="font-medium">A song from my music folder</div>
        <div className="text-sm text-text-muted">
          GroupSync plays it. Accurate to a fraction of a millisecond, shows which speaker is later, and you can change the delays right
          there.
        </div>
      </button>
      <button className={card} onClick={() => setMode('blind')}>
        <div className="font-medium">Whatever is playing now</div>
        <div className="text-sm text-text-muted">
          Use your own music (Spotify Connect, anything). Only shows the size of a bigger gap, not which speaker is later.
        </div>
      </button>
      <button onClick={onBack} className="w-full py-3 text-sm text-text-muted hover:text-white">
        Back
      </button>
    </div>
  );
}
