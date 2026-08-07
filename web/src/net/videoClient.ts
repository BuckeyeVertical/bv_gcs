import { useGcsStore } from '../store/useGcsStore';

/**
 * Video rides its own WebSocket, deliberately separate from the control socket
 * in net/client.ts. A backlog of H.264 must never delay an approval verdict.
 *
 * Nothing in here touches the control client: a video failure closes this socket,
 * sets the stream state back to 'off' and stops there. The approval path — the
 * pending card, the countdown, [A]/[R] and the decision round trip — is unaffected.
 */
const VIDEO_PATH = '/video';
const MIME = 'video/mp4; codecs="avc1.42E01E"';

let socket: WebSocket | null = null;
let mediaSource: MediaSource | null = null;
let sourceBuffer: SourceBuffer | null = null;
let objectUrl: string | null = null;
const pending: ArrayBuffer[] = [];

function videoUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}${VIDEO_PATH}`;
}

function drain() {
  if (!sourceBuffer || sourceBuffer.updating || pending.length === 0) return;
  try {
    sourceBuffer.appendBuffer(pending.shift()!);
  } catch {
    // QuotaExceeded or a bad segment — drop what we have and resync.
    pending.length = 0;
  }
}

/** Trim played-back data and jump forward if we have fallen behind live. */
function keepLive(video: HTMLVideoElement) {
  if (!sourceBuffer || sourceBuffer.updating) return;
  const buffered = sourceBuffer.buffered;
  if (buffered.length === 0) return;
  const end = buffered.end(buffered.length - 1);
  if (end - video.currentTime > 2) video.currentTime = end - 0.1;
  const start = buffered.start(0);
  if (video.currentTime - start > 8) {
    try {
      sourceBuffer.remove(start, video.currentTime - 4);
    } catch {
      /* removal is best-effort */
    }
  }
}

export function startVideo(video: HTMLVideoElement) {
  stopVideo();
  useGcsStore.getState().setStreamState('connecting');

  const ms = new MediaSource();
  mediaSource = ms;
  objectUrl = URL.createObjectURL(ms);
  video.src = objectUrl;

  ms.addEventListener('sourceopen', () => {
    // A MediaSource from a previous, already-stopped session can still open;
    // ignore it rather than letting it install a source buffer on the live one.
    if (mediaSource !== ms) return;
    sourceBuffer = ms.addSourceBuffer(MIME);
    sourceBuffer.mode = 'sequence';
    sourceBuffer.addEventListener('updateend', () => {
      drain();
      keepLive(video);
    });
    drain();
  });

  const ws = new WebSocket(videoUrl());
  socket = ws;
  ws.binaryType = 'arraybuffer';
  ws.onmessage = (ev) => {
    if (socket !== ws) return;
    if (!(ev.data instanceof ArrayBuffer)) return;
    if (useGcsStore.getState().streamState !== 'live') {
      useGcsStore.getState().setStreamState('live');
    }
    pending.push(ev.data);
    if (pending.length > 60) pending.splice(0, pending.length - 30);
    drain();
  };
  // Guarded on identity so a socket closing from an earlier session cannot knock
  // the current one back to 'off'.
  ws.onclose = () => {
    if (socket !== ws) return;
    useGcsStore.getState().setStreamState('off');
  };
  ws.onerror = () => ws.close();
}

export function stopVideo() {
  socket?.close();
  socket = null;
  sourceBuffer = null;
  mediaSource = null;
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = null;
  pending.length = 0;
  useGcsStore.getState().setStreamState('off');
}
