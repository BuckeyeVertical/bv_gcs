import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { useGcsStore } from '../store/useGcsStore';

const TICK_MS = 250;

function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

/**
 * Countdown to mission_node's auto-approve deadline.
 *
 * The wording matters as much as the bar: the timeout fails *open*, so letting it
 * run out deploys a payload. An operator who assumes inaction is the safe choice
 * would be wrong, so the label says so explicitly.
 *
 * Nothing here enforces the deadline — mission_node owns it. This is display only.
 */
export function ApprovalCountdown() {
  const deadline = useGcsStore((s) => s.pendingDeadline);
  const pending = useGcsStore((s) => s.activePending);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (deadline === null) return;
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, [deadline]);

  if (deadline === null || !pending) return null;

  const remainingMs = deadline - now;
  const totalMs = pending.timeout_sec * 1000;
  const fraction = Math.max(0, Math.min(1, remainingMs / totalMs));
  const expired = remainingMs <= 0;

  const tone = expired || fraction < 0.15
    ? 'bg-accent-red'
    : fraction < 0.4
      ? 'bg-accent-amber'
      : 'bg-accent-blue';

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-dim">
          {expired ? 'Deploying anyway' : 'Auto-deploys in'}
        </span>
        <span
          className={clsx(
            'font-mono text-sm tabular-nums',
            expired || fraction < 0.15 ? 'text-accent-red' : 'text-ink-primary',
          )}
        >
          {formatRemaining(remainingMs)}
        </span>
      </div>
      <div className="h-1 w-full overflow-hidden rounded-sm bg-bg-border">
        <div
          className={clsx('h-full transition-[width] duration-200', tone)}
          style={{ width: `${fraction * 100}%` }}
        />
      </div>
      <div className="font-mono text-[10px] text-ink-dim">
        No response = deploy, not skip.
      </div>
    </div>
  );
}
