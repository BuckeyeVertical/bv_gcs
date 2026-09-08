import type { RefObject } from 'react';
import { setPreview } from '../net/client';
import { startVideo, stopVideo } from '../net/videoClient';
import { useGcsStore } from '../store/useGcsStore';
import { startRecording, stopRecording, useRecording } from '../net/recording';
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

  const recording = useRecording();

  const toggle = () => {
    const next = !enabled;
    setPreview(next);
    if (next && videoRef.current) startVideo(videoRef.current);
    else { stopRecording(); stopVideo(); }
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
      <Button variant={recording.state === 'recording' ? 'reject' : 'ghost'}
              className="w-full"
              disabled={recording.state === 'choosing' || recording.state === 'saving' || (recording.state === 'idle' && state !== 'live')}
              onClick={() => recording.state === 'recording' ? stopRecording() : void startRecording()}>
        {recording.state === 'recording' ? 'Stop recording' : recording.state === 'saving' ? 'Saving…' : recording.state === 'choosing' ? 'Choose file…' : 'Record to Mac'}
      </Button>
      <div role="status" className="break-words font-mono text-[10px] text-ink-dim">{recording.message}</div>
    </section>
  );
}
