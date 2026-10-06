import type { MuteProblem } from '../calibration/muting';

/** Shows why a speaker may not have been muted: rejected by MA, or just not confirmed yet */
export function MuteWarning({ problems }: { problems: MuteProblem[] }) {
  if (problems.length === 0) return null;
  const hard = problems.filter((p) => p.hard);
  const soft = problems.filter((p) => !p.hard);
  return (
    <div className="p-3 bg-yellow-900/20 border border-yellow-700/50 rounded-lg text-yellow-300 text-sm space-y-1">
      {hard.length > 0 && (
        <p>
          Couldn&apos;t mute: {hard.map((p) => `${p.name} (${p.reason})`).join('; ')}. Mute by hand.
        </p>
      )}
      {soft.length > 0 && (
        <p className={hard.length > 0 ? 'text-yellow-300/70' : ''}>
          Mute not confirmed: {soft.map((p) => p.name).join(', ')}. MA can be slow to show it; ignore if they are silent.
        </p>
      )}
    </div>
  );
}
