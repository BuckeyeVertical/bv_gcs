import { useGcsStore } from '../store/useGcsStore';
import { bearingDeg, haversineMeters } from '../lib/geo';
import { ApprovalCountdown } from './ApprovalCountdown';
import { DecisionButtons } from './DecisionButtons';

/**
 * Detail strip beneath the image: what was detected, where, and the approve/reject
 * controls. The coordinates are a sanity check (is this localized somewhere absurd?),
 * not the primary evidence — that's the image.
 */
export function PendingDetectionPanel() {
  const active = useGcsStore((s) => s.activePending);
  const fix = useGcsStore((s) => s.droneFix);
  const message = useGcsStore((s) => s.lastMessage);

  if (!active) {
    return (
      <section className="border border-bg-border bg-bg-panel p-4">
        <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-dim">
          Awaiting detection
        </div>
        {message && (
          <div className="mt-2 font-mono text-[10px] text-ink-muted">
            last: {message}
          </div>
        )}
      </section>
    );
  }

  const baseLat = fix?.latitude ?? active.drone_latitude;
  const baseLon = fix?.longitude ?? active.drone_longitude;
  const distance = haversineMeters(
    baseLat,
    baseLon,
    active.latitude,
    active.longitude,
  );
  const bearing = bearingDeg(baseLat, baseLon, active.latitude, active.longitude);

  return (
    <section className="border border-accent-amber/60 bg-bg-panel p-4">
      {/* Stacked, not side by side: this panel now lives in a 360px column beside
          the live feed, which is too narrow for two columns of detail. */}
      <div className="flex flex-col gap-4">
        <div className="min-w-0 space-y-3">
          <div className="flex items-baseline gap-3">
            <span className="text-2xl font-bold uppercase tracking-wider text-ink-primary">
              {active.class_name}
            </span>
            <span className="font-mono text-xs text-accent-amber">
              {(active.confidence * 100).toFixed(0)}%
            </span>
            <span className="font-mono text-[10px] text-ink-dim">
              {active.detection_id.slice(0, 8)}
            </span>
          </div>

          <div className="grid grid-cols-3 gap-x-4 gap-y-2 font-mono text-xs">
            <Field label="Lat" value={active.latitude.toFixed(6)} />
            <Field label="Lon" value={active.longitude.toFixed(6)} />
            <Field label="Alt" value={`${active.altitude.toFixed(1)} m`} />
            <Field label="Dist" value={`${distance.toFixed(1)} m`} />
            <Field label="Bearing" value={`${bearing.toFixed(0)}°`} />
          </div>

          {message && (
            <div className="border-t border-bg-border pt-2 font-mono text-[10px] text-ink-muted">
              {message}
            </div>
          )}
        </div>

        <div className="w-full space-y-3">
          <ApprovalCountdown />
          <DecisionButtons />
        </div>
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
