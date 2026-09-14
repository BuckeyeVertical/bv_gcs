import { useEffect, useRef } from 'react';
import { ConnectionStatus } from './components/ConnectionStatus';
import { ConfirmationPanel } from './components/ConfirmationPanel';
import { SahiProgressPanel } from './components/SahiProgressPanel';
import { MissionStatePanel } from './components/MissionStatePanel';
import { PathProgressPanel } from './components/PathProgressPanel';
import { ReturnHomeSlider } from './components/ReturnHomeSlider';
import { PendingDetectionPanel } from './components/PendingDetectionPanel';
import { DetectionImage } from './components/DetectionImage';
import { VideoPanel } from './components/VideoPanel';
import { StreamToggle } from './components/StreamToggle';
import { MosaicDownloadPanel } from './components/MosaicDownloadPanel';
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
        'grid h-full grid-rows-[72px_1fr] bg-bg-base ' +
        (pending ? 'grid-cols-[260px_1fr_360px]' : 'grid-cols-[260px_1fr]')
      }
    >
      <header className={
        'relative row-start-1 flex items-center justify-center border-b ' +
        'border-bg-border bg-black px-2 ' +
        (pending ? 'col-span-3' : 'col-span-2')
      }>
        <img
          src="/ohio-state-logo.png"
          alt="The Ohio State University"
          className="absolute left-2 h-12 w-auto object-contain"
        />
        <span className="font-mono text-xs font-bold uppercase tracking-[0.2em] text-ink-primary">
          Buckeye Vertical
        </span>
        <img
          src="/getsitelogo.jpg"
          alt="Buckeye Vertical at The Ohio State University"
          className="absolute right-2 h-16 w-auto object-contain"
        />
      </header>

      <aside className="col-start-1 row-start-2 space-y-3 overflow-y-auto
                        border-r border-bg-border p-3">
        <ConnectionStatus />
        <MissionStatePanel />
        <PathProgressPanel />
        <ReturnHomeSlider />
        <ConfirmationPanel />
        <SahiProgressPanel />
        <StreamToggle videoRef={videoRef} />
        <MosaicDownloadPanel />
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
