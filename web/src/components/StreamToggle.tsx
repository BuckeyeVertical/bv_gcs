import type { RefObject } from 'react';
import { setPreview } from '../net/client';
import { startVideo, stopVideo } from '../net/videoClient';
import { useGcsStore } from '../store/useGcsStore';
import { Button } from './ui/Button';

/**
 * Operator control for the debug feed. Off by default and off after a reload —
 * the stream costs bandwidth on the link, so it is never on unless asked for.
 */
export function StreamToggle({ videoRef }: {
  videoRef: RefObject<HTMLVideoElement>;
}) {
  const enabled = useGcsStore((s) => s.previewEnabled);
  const state = useGcsStore((s) => s.streamState);

  const toggle = () => {
    const next = !enabled;
    setPreview(next);
    if (next && videoRef.current) startVideo(videoRef.current);
    else stopVideo();
  };

  return (
    <section className="border border-bg-border bg-bg-panel p-4 space-y-2">
      <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-dim">
        Debug stream
      </div>
      <Button variant={enabled ? 'reject' : 'ghost'} className="w-full"
              onClick={toggle}>
        {enabled ? 'Stop stream' : 'Start stream'}
      </Button>
      <div className="font-mono text-[10px] text-ink-dim">{state}</div>
    </section>
  );
}
