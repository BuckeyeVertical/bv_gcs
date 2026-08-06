import { useEffect } from 'react';
import { ConnectionStatus } from './components/ConnectionStatus';
import { MissionStatePanel } from './components/MissionStatePanel';
import { PendingDetectionPanel } from './components/PendingDetectionPanel';
import { DetectionImage } from './components/DetectionImage';
import { connect } from './net/client';

export default function App() {
  useEffect(() => {
    connect();
  }, []);

  return (
    <div className="grid h-full grid-cols-[260px_1fr] grid-rows-[44px_1fr] bg-bg-base">
      <header className="col-span-2 row-start-1 flex items-center justify-between border-b border-bg-border bg-bg-panel px-4">
        <div className="flex items-center gap-3">
          <span className="font-mono text-sm font-bold tracking-[0.3em] text-ink-primary">
            BV·GCS
          </span>
          <span className="font-mono text-[10px] uppercase text-ink-dim">
            Human-in-the-loop
          </span>
        </div>
        <ConnectionStatus />
      </header>

      <aside className="col-start-1 row-start-2 space-y-3 overflow-y-auto border-r border-bg-border p-3">
        <MissionStatePanel />
      </aside>

      {/* min-h-0 so the image region shrinks instead of pushing the controls
          off-screen when the viewport is short. */}
      <main className="col-start-2 row-start-2 flex min-h-0 flex-col gap-3 p-3">
        <div className="min-h-0 flex-1">
          <DetectionImage />
        </div>
        <PendingDetectionPanel />
      </main>
    </div>
  );
}
