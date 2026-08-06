import { useCallback, useEffect } from 'react';
import { sendDecision } from '../net/client';
import { useGcsStore } from '../store/useGcsStore';
import { Button } from './ui/Button';

export function DecisionButtons() {
  const active = useGcsStore((s) => s.activePending);
  const inFlight = useGcsStore((s) => s.inFlightDecisionId);
  const setInFlight = useGcsStore((s) => s.setInFlightDecisionId);
  const setLastMessage = useGcsStore((s) => s.setLastMessage);

  const detectionId = active?.detection_id ?? null;

  const submit = useCallback(
    async (approved: boolean) => {
      if (!detectionId || inFlight) return;
      setInFlight(detectionId);
      try {
        const ack = await sendDecision(detectionId, approved);
        setLastMessage(ack.message);
        // On success the drone publishes a cleared pending, which is what actually
        // dismisses this panel. Clearing locally would show the operator a decision
        // that may not have reached the aircraft.
        if (!ack.accepted) setInFlight(null);
      } catch (err) {
        setLastMessage((err as Error).message);
        setInFlight(null);
      }
    },
    [detectionId, inFlight, setInFlight, setLastMessage],
  );

  useEffect(() => {
    if (!detectionId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.repeat) return;
      if (e.key === 'a' || e.key === 'A') void submit(true);
      if (e.key === 'r' || e.key === 'R') void submit(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [detectionId, submit]);

  if (!active) return null;

  const disabled = inFlight !== null;

  return (
    <div className="flex gap-2">
      <Button
        variant="approve"
        className="flex-1"
        disabled={disabled}
        onClick={() => void submit(true)}
      >
        Approve <span className="font-mono text-ink-dim">[A]</span>
      </Button>
      <Button
        variant="reject"
        className="flex-1"
        disabled={disabled}
        onClick={() => void submit(false)}
      >
        Reject <span className="font-mono text-ink-dim">[R]</span>
      </Button>
    </div>
  );
}
