import clsx from 'clsx';
import type { ConfirmClass } from '../net/types';
import { useGcsStore } from '../store/useGcsStore';

/**
 * Live view of filtering_node's M-of-N confirmation window.
 *
 * Shows the window itself rather than a progress bar, because the shape of the
 * misses is the diagnostic: `[on][off][on]` is a flickering detector, while
 * `[off][off][off]` on an object you can plainly see in the feed is a detector that
 * is not firing at all. A 1/3-2/3-3/3 counter would hide that distinction.
 *
 * Hits do not have to be consecutive — three anywhere in the window confirm — so
 * the boxes are deliberately not drawn as a sequence that "resets".
 */
export function ConfirmationPanel() {
  const win = useGcsStore((s) => s.confirmWindow);
  const missionState = useGcsStore((s) => s.missionState);

  // filtering_node only advances the window during scan, so anything shown outside
  // it is a leftover. Say that rather than display a frozen window as if it were live.
  const scanning = missionState?.toLowerCase() === 'scan';

  return (
    <section className="border border-bg-border bg-bg-panel p-4 space-y-3">
      <header className="flex items-baseline justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-dim">
          Confirmation
        </span>
        {win && (
          <span className="font-mono text-[10px] text-ink-dim">
            {win.required} of {win.window}
          </span>
        )}
      </header>

      {!win || win.classes.length === 0 ? (
        <p className="font-mono text-xs text-ink-dim">
          {scanning ? 'No detections in window' : 'Idle — runs during scan'}
        </p>
      ) : (
        <div className="space-y-2">
          {win.classes.map((c) => (
            <ClassRow key={c.class_id} cls={c} slots={win.window}
                      required={win.required} stale={!scanning} />
          ))}
        </div>
      )}
    </section>
  );
}

function ClassRow({ cls, slots, required, stale }: {
  cls: ConfirmClass;
  slots: number;
  required: number;
  stale: boolean;
}) {
  const hits = cls.hits.filter(Boolean).length;
  // Pad to the full window so the row does not change width as it fills.
  const boxes = Array.from({ length: slots }, (_, i) => cls.hits[i] ?? null);

  return (
    <div className={clsx('space-y-1', stale && 'opacity-50')}>
      <div className="flex items-baseline justify-between font-mono text-xs">
        <span className="uppercase text-ink-primary">{cls.name}</span>
        <span
          className={clsx(
            'font-bold',
            cls.confirmed
              ? 'text-accent-green'
              : hits >= required
                ? 'text-accent-amber'
                : 'text-ink-primary',
          )}
        >
          {cls.confirmed ? 'confirmed' : `${hits}/${required}`}
        </span>
      </div>
      <div className="flex gap-1" aria-label={`${cls.name} confirmation window`}>
        {boxes.map((hit, i) => (
          <div
            key={i}
            className={clsx(
              'h-5 flex-1 border',
              hit === null
                // Frame slot the window has not reached yet.
                ? 'border-dashed border-bg-border'
                : hit
                  ? 'border-accent-green bg-accent-green/70'
                  : 'border-bg-border bg-transparent',
            )}
          />
        ))}
      </div>
    </div>
  );
}
