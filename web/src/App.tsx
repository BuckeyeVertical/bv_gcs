import { useEffect } from 'react';
import { ConnectionStatus } from './components/ConnectionStatus';
import { MissionStatePanel } from './components/MissionStatePanel';
import { PendingDetectionPanel } from './components/PendingDetectionPanel';
import { MapView } from './components/MapView';
import './ros/client';

export default function App() {
  useEffect(() => {
    document.title = 'bv-gcs';
  }, []);

  return (
    <div className="h-full grid grid-cols-[280px_1fr_320px] grid-rows-[44px_1fr] bg-bg-base">
      <header className="col-span-3 row-start-1 flex items-center justify-between px-4 border-b border-bg-border bg-bg-panel">
        <div className="flex items-center gap-3">
          <span className="font-mono font-bold tracking-[0.3em] text-ink-primary text-sm">
            BV·GCS
          </span>
          <span className="text-[10px] font-mono uppercase text-ink-dim">
            Human-in-the-loop
          </span>
        </div>
        <ConnectionStatus />
      </header>

      <aside className="row-start-2 col-start-1 p-3 space-y-3 border-r border-bg-border overflow-y-auto">
        <MissionStatePanel />
      </aside>

      <main className="row-start-2 col-start-2 relative">
        <MapView />
      </main>

      <aside className="row-start-2 col-start-3 p-3 space-y-3 border-l border-bg-border overflow-y-auto">
        <PendingDetectionPanel />
      </aside>
    </div>
  );
}
