import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { useGcsStore } from '../store/useGcsStore';

export function SahiProgressPanel() {
  const progress = useGcsStore((s) => s.sahiProgress);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const initial = progress?.elapsed_sec ?? 0;
    setElapsed(initial);
    if (!progress?.active) return;

    const started = Date.now() - initial * 1000;
    const timer = window.setInterval(
      () => setElapsed((Date.now() - started) / 1000),
      100,
    );
    return () => window.clearInterval(timer);
  }, [progress?.run_id, progress?.active, progress?.elapsed_sec]);

  const status = progress?.status ?? 'idle';
  const complete = progress && progress.total > 0
    ? progress.completed / progress.total
    : 0;

  return (
    <section className="border border-bg-border bg-bg-panel p-4 space-y-3">
      <header className="flex items-baseline justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-dim">
          SAHI Progress
        </span>
        <span className={clsx(
          'font-mono text-[10px] font-bold uppercase',
          status === 'running' && 'text-accent-blue',
          status === 'complete' && 'text-accent-green',
          status === 'error' && 'text-accent-red',
          status === 'idle' && 'text-ink-dim',
        )}>
          {status}
        </span>
      </header>

      {!progress ? (
        <p className="font-mono text-xs text-ink-dim">Waiting for inference</p>
      ) : (
        <div className="space-y-2 font-mono text-xs">
          <div className="h-2 overflow-hidden border border-bg-border bg-bg-base">
            <div
              className={clsx(
                'h-full transition-all',
                progress.active
                  ? 'w-1/3 animate-pulse bg-accent-blue'
                  : progress.status === 'error'
                    ? 'bg-accent-red'
                    : 'bg-accent-green',
              )}
              style={progress.active ? undefined : { width: `${complete * 100}%` }}
            />
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-ink-dim">
            <span>Views</span>
            <span className="text-right text-ink-primary">
              {progress.active ? progress.total : `${progress.completed}/${progress.total}`}
            </span>
            <span>Local slices</span>
            <span className="text-right text-ink-primary">{progress.local_slices}</span>
            <span>Slice</span>
            <span className="text-right text-ink-primary">
              {progress.slice_width}×{progress.slice_height}
            </span>
            <span>Overlap</span>
            <span className="text-right text-ink-primary">
              {Math.round(progress.overlap * 100)}%
            </span>
            <span>Elapsed</span>
            <span className="text-right text-ink-primary">{elapsed.toFixed(1)}s</span>
          </div>
          {progress.error && (
            <p className="text-accent-red">{progress.error}</p>
          )}
        </div>
      )}
    </section>
  );
}
