import { useGcsStore } from '../store/useGcsStore';
import { segmentFraction } from '../lib/geo';

export function PathProgressPanel() {
  const progress = useGcsStore((s) => s.pathProgress);
  const fix = useGcsStore((s) => s.droneFix);
  const state = useGcsStore((s) => s.missionState);
  const canInterpolate = progress?.target !== null && fix &&
    progress?.segment_start && progress.segment_end &&
    state !== 'deliver' && state !== 'deploy' && state !== 'return';
  const between = canInterpolate
    ? segmentFraction(
        fix.latitude,
        fix.longitude,
        progress.segment_start!,
        progress.segment_end!,
      )
    : 0;
  const percent = progress && progress.total > 0
    ? Math.round(((progress.completed + between) / progress.total) * 100)
    : 0;
  const segmentPercent = Math.round(between * 100);

  return (
    <section className="space-y-3 border border-bg-border bg-bg-panel p-4">
      <header className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-dim">
        Path progress
      </header>

      {progress ? (
        <>
          <div className="flex items-end justify-between">
            <div>
              <div className="font-mono text-[10px] uppercase text-ink-dim">
                {progress.phase} path
              </div>
              <div className="text-xl font-bold uppercase tracking-wider text-accent-cyan">
                {progress.target === null
                  ? 'Complete'
                  : progress.target > 1
                    ? `${progress.target - 1} → ${progress.target}`
                    : `Heading to point ${progress.target}`}
              </div>
            </div>
            <div className="font-mono text-xs text-ink-muted">{percent}%</div>
          </div>

          <div className="h-1.5 overflow-hidden bg-bg-border">
            <div
              className="h-full bg-accent-cyan transition-[width] duration-300"
              style={{ width: `${percent}%` }}
            />
          </div>
          <div className="font-mono text-[10px] uppercase text-ink-dim">
            {progress.target === null
              ? `${progress.total} of ${progress.total} points reached`
              : `${segmentPercent}% to point ${progress.target} · ` +
                `${progress.completed} of ${progress.total} reached`}
          </div>
        </>
      ) : (
        <div className="font-mono text-sm text-ink-muted">Waiting for mission…</div>
      )}
    </section>
  );
}
