import { useGcsStore } from '../store/useGcsStore';
import { className } from '../ros/types';
import { bearingDeg, haversineMeters } from '../lib/geo';
import { DecisionButtons } from './DecisionButtons';

export function PendingDetectionPanel() {
  const active = useGcsStore((s) => s.activePending);
  const fix = useGcsStore((s) => s.droneFix);
  const message = useGcsStore((s) => s.lastMessage);

  if (!active) {
    return (
      <section className="border border-bg-border bg-bg-panel p-4">
        <header className="text-[10px] font-mono uppercase tracking-[0.2em] text-ink-dim">
          Pending Detection
        </header>
        <div className="mt-6 text-center text-ink-dim font-mono text-xs">
          NO ACTIVE DETECTION
        </div>
        {message && (
          <div className="mt-4 text-[10px] font-mono text-ink-muted">
            last: {message}
          </div>
        )}
      </section>
    );
  }

  const baselat = fix?.latitude ?? active.drone_latitude;
  const baselon = fix?.longitude ?? active.drone_longitude;
  const distance = haversineMeters(
    baselat,
    baselon,
    active.latitude,
    active.longitude,
  );
  const bearing = bearingDeg(
    baselat,
    baselon,
    active.latitude,
    active.longitude,
  );

  return (
    <section className="border border-accent-amber/60 bg-bg-panel p-4 space-y-4">
      <header className="flex items-center justify-between">
        <div className="text-[10px] font-mono uppercase tracking-[0.2em] text-accent-amber">
          ▲ Pending Detection
        </div>
        <span className="font-mono text-[10px] text-ink-dim">
          {active.detection_id.slice(0, 8)}
        </span>
      </header>

      <div>
        <div className="text-[10px] font-mono uppercase text-ink-dim">Class</div>
        <div className="text-2xl font-bold uppercase tracking-wider text-ink-primary">
          {className(active.class_id)}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-3 font-mono text-xs">
        <Field label="Lat" value={active.latitude.toFixed(6)} />
        <Field label="Lon" value={active.longitude.toFixed(6)} />
        <Field label="Alt" value={`${active.altitude.toFixed(1)} m`} />
        <Field label="Conf" value={active.confidence.toFixed(2)} />
        <Field label="Dist" value={`${distance.toFixed(1)} m`} />
        <Field label="Bearing" value={`${bearing.toFixed(0)}°`} />
      </div>

      <DecisionButtons />

      {message && (
        <div className="text-[10px] font-mono text-ink-muted border-t border-bg-border pt-2">
          {message}
        </div>
      )}
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
