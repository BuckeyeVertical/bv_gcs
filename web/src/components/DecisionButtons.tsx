import { useEffect } from 'react';
import { sendDecision } from '../ros/client';
import { useGcsStore } from '../store/useGcsStore';
import { Button } from './ui/Button';

export function DecisionButtons() {
  const active = useGcsStore((s) => s.activePending);
  const inFlight = useGcsStore((s) => s.inFlightDecisionId);
  const setInFlight = useGcsStore((s) => s.setInFlightDecisionId);
  const clearActive = useGcsStore((s) => s.clearActivePending);
  const setLastMessage = useGcsStore((s) => s.setLastMessage);

  const submit = async (approved: boolean) => {
    if (!active || inFlight) return;
    setInFlight(active.detection_id);
    try {
      const resp = await sendDecision(active.detection_id, approved);
      setLastMessage(resp.message);
      if (resp.accepted) clearActive();
    } catch (err) {
      setLastMessage(`service error: ${(err as Error).message}`);
    } finally {
      setInFlight(null);
    }
  };

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === 'a' || e.key === 'A') submit(true);
      if (e.key === 'r' || e.key === 'R') submit(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.detection_id, inFlight]);

  if (!active) return null;

  const disabled = !!inFlight;
  return (
    <div className="flex gap-2">
      <Button
        variant="approve"
        className="flex-1"
        disabled={disabled}
        onClick={() => submit(true)}
      >
        Approve <span className="font-mono text-ink-dim">[A]</span>
      </Button>
      <Button
        variant="reject"
        className="flex-1"
        disabled={disabled}
        onClick={() => submit(false)}
      >
        Reject <span className="font-mono text-ink-dim">[R]</span>
      </Button>
    </div>
  );
}
