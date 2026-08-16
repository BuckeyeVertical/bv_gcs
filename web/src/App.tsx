import { useEffect, useRef } from 'react';
import { ConnectionStatus } from './components/ConnectionStatus';
import { ConfirmationPanel } from './components/ConfirmationPanel';
import { SahiProgressPanel } from './components/SahiProgressPanel';
import { MissionStatePanel } from './components/MissionStatePanel';
import { PendingDetectionPanel } from './components/PendingDetectionPanel';
import { DetectionImage } from './components/DetectionImage';
import { VideoPanel } from './components/VideoPanel';
import { StreamToggle } from './components/StreamToggle';
import { useGcsStore } from './store/useGcsStore';
import { connect } from './net/client';

export default function App() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const pending = useGcsStore((s) => s.activePending);

  useEffect(() => {
    connect();
  }, []);

  return (
    <div
      className={
        'grid h-full grid-rows-[44px_1fr] bg-bg-base ' +
        (pending ? 'grid-cols-[260px_1fr_360px]' : 'grid-cols-[260px_1fr]')
      }
    >
      <header className={
        'row-start-1 flex items-center justify-between border-b ' +
        'border-bg-border bg-bg-panel px-4 ' +
        (pending ? 'col-span-3' : 'col-span-2')
      }>
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

      <aside className="col-start-1 row-start-2 space-y-3 overflow-y-auto
                        border-r border-bg-border p-3">
        <MissionStatePanel />
        <ConfirmationPanel />
        <SahiProgressPanel />
        <StreamToggle videoRef={videoRef} />
      </aside>

      <main className="col-start-2 row-start-2 min-h-0 p-3">
        <VideoPanel videoRef={videoRef} />
      </main>

      {pending && (
        <aside className="col-start-3 row-start-2 flex min-h-0 flex-col gap-3
                          overflow-y-auto border-l border-bg-border p-3">
          <div className="min-h-0 flex-1">
            <DetectionImage />
          </div>
          <PendingDetectionPanel />
        </aside>
      )}
    </div>
  );
}
