import { useCallback, useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import type { DetectionMarker } from '../net/types';
import { useGcsStore } from '../store/useGcsStore';

const MARKER = '#54dc40';

/**
 * Markers are normalised against the source frame, so they belong in the rectangle
 * the video is actually painted in — not the panel. The video is letterboxed inside
 * the panel (max-h/max-w), and the two rects differ whenever the feed's aspect ratio
 * does not match the column's, which is the normal case.
 */
function draw(
  canvas: HTMLCanvasElement,
  video: HTMLVideoElement,
  dets: DetectionMarker[],
) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  canvas.width = canvas.clientWidth;
  canvas.height = canvas.clientHeight;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // No frames means no rect to place markers in — an empty <video> still occupies
  // a default 300x150 box, and drawing into it would put markers somewhere the
  // operator could mistake for a position in a picture that isn't there.
  if (!video.videoWidth || !video.videoHeight) return;

  const cr = canvas.getBoundingClientRect();
  const vr = video.getBoundingClientRect();
  const ox = vr.left - cr.left;
  const oy = vr.top - cr.top;

  for (const d of dets) {
    const x = ox + d.x * vr.width;
    const y = oy + d.y * vr.height;
    ctx.strokeStyle = MARKER;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, 14, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x - 22, y);
    ctx.lineTo(x - 6, y);
    ctx.moveTo(x + 6, y);
    ctx.lineTo(x + 22, y);
    ctx.moveTo(x, y - 22);
    ctx.lineTo(x, y - 6);
    ctx.moveTo(x, y + 6);
    ctx.lineTo(x, y + 22);
    ctx.stroke();
    ctx.font = '12px ui-monospace, monospace';
    ctx.fillStyle = MARKER;
    ctx.fillText(d.class_name, x + 20, y - 20);
  }
}

/**
 * Live feed with detection markers drawn on a canvas overlay.
 *
 * Markers are drawn browser-side rather than baked into the video: detection
 * runs at 0.67 Hz while video runs at 8 fps, so compositing them server-side
 * would make the video stutter down to the detector's rate. They persist between
 * updates instead.
 */
export function VideoPanel({ videoRef }: {
  videoRef: RefObject<HTMLVideoElement>;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dets = useGcsStore((s) => s.detections);
  const state = useGcsStore((s) => s.streamState);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (canvas && video) draw(canvas, video, dets);
  }, [dets, videoRef]);

  useEffect(() => {
    redraw();
    const video = videoRef.current;
    const canvas = canvasRef.current;
    // The painted rect moves when the panel resizes — including when the approval
    // column appears, which is not a window resize — when the first frame gives the
    // video its intrinsic size, and when the source resolution changes.
    const observer = new ResizeObserver(redraw);
    if (canvas) observer.observe(canvas);
    video?.addEventListener('loadedmetadata', redraw);
    video?.addEventListener('resize', redraw);
    return () => {
      observer.disconnect();
      video?.removeEventListener('loadedmetadata', redraw);
      video?.removeEventListener('resize', redraw);
    };
  }, [redraw, videoRef]);

  return (
    <div className="relative flex h-full w-full items-center justify-center
                    border border-bg-border bg-black/40">
      {/* tabIndex -1 so the video can never take focus and swallow [A]/[R]. */}
      <video ref={videoRef} tabIndex={-1} autoPlay muted playsInline
             className="max-h-full max-w-full" />
      <canvas ref={canvasRef}
              className="pointer-events-none absolute inset-0 h-full w-full" />
      {state !== 'live' && (
        <div className="absolute font-mono text-[10px] uppercase
                        tracking-[0.2em] text-ink-dim">
          {state === 'connecting' ? 'Connecting…' : 'Stream off'}
        </div>
      )}
    </div>
  );
}
