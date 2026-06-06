import clsx from 'clsx';
import { useGcsStore } from '../store/useGcsStore';

const STATE_TONE: Record<string, string> = {
  takeoff: 'text-accent-cyan',
  lap: 'text-accent-blue',
  scan: 'text-accent-amber',
  localize: 'text-accent-amber',
  deliver: 'text-accent-amber',
  deploy: 'text-accent-red',
  return: 'text-accent-green',
};

export function MissionStatePanel() {
  const state = useGcsStore((s) => s.missionState);
  const fix = useGcsStore((s) => s.droneFix);

  return (
    <section className="border border-bg-border bg-bg-panel p-4 space-y-3">
      <header className="text-[10px] font-mono uppercase tracking-[0.2em] text-ink-dim">
        Mission
      </header>
      <div>
        <div className="text-[10px] font-mono uppercase text-ink-dim">State</div>
        <div
          className={clsx(
            'text-xl font-bold uppercase tracking-wider',
            (state && STATE_TONE[state]) ?? 'text-ink-muted',
          )}
        >
          {state ?? '—'}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 font-mono text-xs">
        <Field label="Drone Lat" value={fix?.latitude.toFixed(6) ?? '—'} />
        <Field label="Drone Lon" value={fix?.longitude.toFixed(6) ?? '—'} />
      </div>
    </section>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase text-ink-dim">{label}</div>
      <div className="text-ink-primary">{value}</div>
    </div>
  );
}
