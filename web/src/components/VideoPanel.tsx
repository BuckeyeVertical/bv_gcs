import type { RefObject } from 'react';
import { useGcsStore } from '../store/useGcsStore';

/**
 * Mission states in which vision_node keeps the camera pipeline running, and so the
 * only ones that can produce preview frames. Outside them the encoder is stopped and
 * the <video> element holds its last decoded frame indefinitely — a still picture
 * that is indistinguishable from a live one showing a stationary scene. Say so
 * explicitly rather than letting the operator trust a stale frame.
 */
const CAPTURE_STATES = ['scan', 'localize'];

/**
 * Live feed for debugging: is the camera alive, pointed where we think, and exposed
 * sanely.
 *
 * Deliberately *not* a detection display. Detections arrive at whatever rate the
 * detector manages (a few per second) and are delivered a full inference behind the
 * frame they came from, while the aircraft keeps moving — so any marker drawn here
 * trails the live picture and reads as "the object is here" when it means "it was
 * there a moment ago".
 * Detections are judged on the approval card instead, which shows a native-resolution
 * crop frozen at the instant of detection.
 */
export function VideoPanel({ videoRef }: {
  videoRef: RefObject<HTMLVideoElement>;
}) {
  const state = useGcsStore((s) => s.streamState);
  const missionState = useGcsStore((s) => s.missionState);

  // A frame is only current while the drone is in a capturing state. Treat an
  // unknown mission state as capturing: before the first /mission_state arrives we
  // have no evidence the feed is stale, and crying stale over a live picture would
  // train the operator to ignore the warning.
  const stale =
    state === 'live' &&
    missionState !== null &&
    !CAPTURE_STATES.includes(missionState.toLowerCase());

  return (
    <div className="relative flex h-full w-full items-center justify-center
                    border border-bg-border bg-black/40">
      {/* tabIndex -1 so the video can never take focus and swallow [A]/[R]. */}
      <video ref={videoRef} tabIndex={-1} autoPlay muted playsInline
             className={`max-h-full max-w-full ${stale ? 'opacity-40' : ''}`} />
      {/* Sized and weighted to be readable at a glance across the tent, and given
          its own dark backing so it stays legible over a paused frame of any
          brightness rather than only over the empty black panel. */}
      {state !== 'live' && (
        <div className="absolute rounded bg-black/75 px-5 py-3 font-mono text-2xl
                        font-bold uppercase tracking-[0.15em] text-white
                        shadow-lg ring-1 ring-white/25">
          {state === 'connecting' ? 'Connecting…' : 'Stream off'}
        </div>
      )}
      {/* Banner sits at the top edge rather than centred so it never covers the
          subject the operator is trying to judge. */}
      {stale && (
        <div className="pointer-events-none absolute inset-x-0 top-0 bg-amber-400
                        px-3 py-2 text-center font-mono text-base font-bold
                        uppercase tracking-[0.1em] text-black">
          Capture off in {missionState} — frame is frozen, not live
        </div>
      )}
    </div>
  );
}
