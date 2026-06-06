import clsx from 'clsx';
import { useGcsStore } from '../store/useGcsStore';

export function ConnectionStatus() {
  const connected = useGcsStore((s) => s.connected);
  const url = (import.meta.env.VITE_ROS_URL as string) ?? 'ws://localhost:9090';
  return (
    <div className="flex items-center gap-2 text-xs font-mono">
      <span
        className={clsx(
          'h-2 w-2 rounded-full',
          connected ? 'bg-accent-green shadow-[0_0_8px_#3fb950]' : 'bg-accent-red',
        )}
      />
      <span className="text-ink-muted">
        {connected ? 'ROSBRIDGE' : 'DISCONNECTED'}
      </span>
      <span className="text-ink-dim">{url}</span>
    </div>
  );
}
