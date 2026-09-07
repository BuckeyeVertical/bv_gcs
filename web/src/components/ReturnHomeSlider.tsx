import { useRef, useState } from 'react';
import { requestReturnHome } from '../net/client';
import { useGcsStore } from '../store/useGcsStore';

const KNOB_PX = 40;
const COMPLETE_AT = 0.94;

export function ReturnHomeSlider() {
  const connected = useGcsStore((s) => s.connected);
  const trackRef = useRef<HTMLDivElement>(null);
  const progressRef = useRef(0);
  const [progress, setProgress] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const disabled = !connected || busy || accepted;

  function updateProgress(clientX: number) {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect) return 0;
    const usable = Math.max(1, rect.width - KNOB_PX);
    const next = Math.max(0, Math.min(1, (clientX - rect.left - KNOB_PX / 2) / usable));
    progressRef.current = next;
    setProgress(next);
    return next;
  }

  function reset() {
    progressRef.current = 0;
    setProgress(0);
  }

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (disabled) return;
    const rect = trackRef.current?.getBoundingClientRect();
    // A tap near the far end must not trigger an emergency action: the drag has
    // to begin on the handle at the left edge.
    if (!rect || event.clientX > rect.left + KNOB_PX + 10) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setMessage(null);
    setDragging(true);
    updateProgress(event.clientX);
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (dragging) updateProgress(event.clientX);
  }

  async function onPointerUp(event: React.PointerEvent<HTMLDivElement>) {
    if (!dragging) return;
    const completed = updateProgress(event.clientX) >= COMPLETE_AT;
    setDragging(false);
    if (!completed) {
      reset();
      return;
    }

    progressRef.current = 1;
    setProgress(1);
    setBusy(true);
    setMessage('Sending AUTO.RTL…');
    try {
      const ack = await requestReturnHome();
      if (!ack.accepted) throw new Error(ack.message);
      setAccepted(true);
      setMessage('PX4 accepted AUTO.RTL');
    } catch (error) {
      reset();
      setMessage(error instanceof Error ? error.message : 'RTL request failed');
    } finally {
      setBusy(false);
    }
  }

  function onPointerCancel() {
    setDragging(false);
    if (!busy && !accepted) reset();
  }

  return (
    <section className="space-y-3 border border-accent-red/40 bg-bg-panel p-4">
      <header className="font-mono text-[10px] uppercase tracking-[0.2em] text-accent-red">
        Return to home
      </header>
      <div
        ref={trackRef}
        role="slider"
        aria-label="Slide fully to command return to home"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress * 100)}
        className={
          'relative h-11 overflow-hidden border border-accent-red/60 bg-bg-base ' +
          (disabled ? 'cursor-not-allowed opacity-60' : 'cursor-grab touch-none select-none')
        }
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
      >
        <div
          className="absolute inset-y-0 left-0 bg-accent-red/25"
          style={{ width: `calc(${progress * 100}% + ${KNOB_PX * (1 - progress)}px)` }}
        />
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-11 font-mono text-[10px] font-bold uppercase tracking-wider text-ink-primary">
          {accepted ? 'Returning home' : busy ? 'Commanding RTL…' : connected ? 'Slide to RTL →' : 'Link unavailable'}
        </div>
        <div
          className="pointer-events-none absolute inset-y-0 flex w-10 items-center justify-center bg-accent-red text-lg font-bold text-white"
          style={{ left: `calc(${progress * 100}% - ${progress * KNOB_PX}px)` }}
        >
          {accepted ? '✓' : '›'}
        </div>
      </div>
      {message && (
        <div className={'font-mono text-[10px] ' + (accepted ? 'text-accent-green' : 'text-accent-amber')}>
          {message}
        </div>
      )}
    </section>
  );
}
