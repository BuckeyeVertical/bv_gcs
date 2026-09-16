import { useRef, useState } from 'react';
import { requestEndLaps } from '../net/client';
import { useGcsStore } from '../store/useGcsStore';
import { Button } from './ui/Button';

export function EndLapsButton() {
  const connected = useGcsStore((s) => s.connected);
  const missionState = useGcsStore((s) => s.missionState);
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function endLaps() {
    if (inFlight.current || accepted || !connected || missionState !== 'lap') return;
    inFlight.current = true;
    setBusy(true);
    setMessage('Requesting LOITER and a 10-second hold before scan…');
    try {
      const ack = await requestEndLaps();
      setAccepted(ack.accepted);
      setMessage(ack.message);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'End laps request failed');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <section className="space-y-3 border border-bg-border bg-bg-panel p-4">
      <Button className="w-full" onClick={endLaps}
        disabled={!connected || missionState !== 'lap' || busy || accepted}>
        {busy ? 'Requesting…' : 'End Laps → Scan'}
      </Button>
      <p className="font-mono text-[10px] text-ink-muted">Hold for 10 seconds in LOITER, then transition to scan.</p>
      {message && <p role="status" className="font-mono text-[10px] text-ink-muted">{message}</p>}
    </section>
  );
}
