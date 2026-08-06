import clsx from 'clsx';
import { WS_URL } from '../net/client';
import { useGcsStore } from '../store/useGcsStore';

export function ConnectionStatus() {
  const connected = useGcsStore((s) => s.connected);
  return (
    <div className="flex items-center gap-2 font-mono text-xs">
      <span
        className={clsx(
          'h-2 w-2 rounded-full',
          connected
            ? 'bg-accent-green shadow-[0_0_8px_#3fb950]'
            : 'bg-accent-red animate-pulse',
        )}
      />
      <span className={connected ? 'text-ink-muted' : 'text-accent-red'}>
        {connected ? 'GCS LINK' : 'DISCONNECTED'}
      </span>
      <span className="text-ink-dim">{WS_URL}</span>
    </div>
  );
}
