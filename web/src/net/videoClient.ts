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

/** Top-level MP4 boxes that begin a fragmented-MP4 initialisation segment. */
const INIT_BOXES = ['ftyp', 'moov'];

let socket: WebSocket | null = null;
let mediaSource: MediaSource | null = null;
let sourceBuffer: SourceBuffer | null = null;
let objectUrl: string | null = null;
let sawInit = false;
let sawFragment = false;
const pending: ArrayBuffer[] = [];

function videoUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}${VIDEO_PATH}`;
}

/** The four-character type of the first top-level box in a chunk, or ''. */
function boxType(data: ArrayBuffer): string {
  if (data.byteLength < 8) return '';
  const t = new Uint8Array(data, 4, 4);
  let s = '';
  for (const c of t) {
    if (c < 0x20 || c > 0x7e) return '';
    s += String.fromCharCode(c);
  }
  return s;
}

/** Whether the source buffer is still usable — i.e. still attached and open. */
function live(): boolean {
  return (
    sourceBuffer !== null &&
    mediaSource !== null &&
    mediaSource.readyState === 'open'
  );
}

function drain() {
  if (!live() || sourceBuffer!.updating || pending.length === 0) return;
  try {
    sourceBuffer!.appendBuffer(pending.shift()!);
  } catch {
    // QuotaExceeded or a bad segment — drop what we have and resync.
    pending.length = 0;
  }
}

/** Trim played-back data and jump forward if we have fallen behind live. */
function keepLive(video: HTMLVideoElement) {
  // Every read below can throw once the buffer has been detached from its parent
  // media source, which happens on teardown while an updateend is still queued.
  // A stale event must not surface as an uncaught error.
  if (!live() || sourceBuffer!.updating) return;
  try {
    const buffered = sourceBuffer!.buffered;
    if (buffered.length === 0) return;
    const end = buffered.end(buffered.length - 1);
    if (end - video.currentTime > 2) video.currentTime = end - 0.1;
    const start = buffered.start(0);
    if (video.currentTime - start > 8) {
      sourceBuffer!.remove(start, video.currentTime - 4);
    }
  } catch {
    /* trimming and seeking are both best-effort */
  }
}

export function startVideo(video: HTMLVideoElement) {
  stopVideo();
  useGcsStore.getState().setStreamState('connecting');

  const ms = new MediaSource();
  mediaSource = ms;
  sawInit = false;
  sawFragment = false;
  objectUrl = URL.createObjectURL(ms);
  video.src = objectUrl;
  // Autoplay is set on the element, but a src swapped in after mount does not
  // re-trigger it in every browser; ask explicitly and ignore the rejection.
  video.play().catch(() => {});

  ms.addEventListener('sourceopen', () => {
    // A MediaSource from a previous, already-stopped session can still open;
    // ignore it rather than letting it install a source buffer on the live one.
    // readyState is checked as well as identity: Chrome delivers a late
    // 'sourceopen' for the *current* MediaSource after it has already been
    // closed by a decode error, and addSourceBuffer then throws.
    if (mediaSource !== ms || ms.readyState !== 'open') return;
    if (sourceBuffer) return;
    try {
      sourceBuffer = ms.addSourceBuffer(MIME);
    } catch {
      failVideo();
      return;
    }
    sourceBuffer.mode = 'sequence';
    sourceBuffer.addEventListener('updateend', () => {
      drain();
      keepLive(video);
    });
    // A SourceBuffer error means the bytes cannot be decoded. Stop rather than
    // append into a media source the browser is about to close underneath us.
    sourceBuffer.addEventListener('error', () => failVideo());
    drain();
  });

  // MEDIA_ERR_SRC_NOT_SUPPORTED and friends. Surface as 'off' instead of leaving
  // the operator staring at "Connecting…" forever.
  video.addEventListener('error', onVideoError);

  const ws = new WebSocket(videoUrl());
  socket = ws;
  ws.binaryType = 'arraybuffer';
  ws.onmessage = (ev) => {
    if (socket !== ws) return;
    if (!(ev.data instanceof ArrayBuffer)) return;
    // Nothing is decodable before the initialisation segment, and a fragment
    // must start at its `moof`: chunks are arbitrary slices of the byte stream,
    // so joining mid-`mdat` feeds the parser the tail of a fragment whose header
    // it never saw. The server aligns both for us, but appending either kind of
    // rubbish permanently closes the MediaSource, so drop until we are sure
    // rather than trusting it.
    const box = boxType(ev.data);
    if (!sawInit) {
      if (!INIT_BOXES.includes(box)) return;
      sawInit = true;
    } else if (!sawFragment) {
      if (INIT_BOXES.includes(box)) {
        // still inside the init segment
      } else if (box === 'moof') {
        sawFragment = true;
      } else {
        return;
      }
    }
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

function onVideoError() {
  failVideo();
}

/**
 * Give up on the picture without touching anything else.
 *
 * Video is expendable; the control socket and the approval flow are not, and
 * neither is reachable from here.
 */
function failVideo() {
  stopVideo();
}

export function stopVideo() {
  socket?.close();
  socket = null;
  sourceBuffer = null;
  mediaSource = null;
  sawInit = false;
  sawFragment = false;
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = null;
  pending.length = 0;
  useGcsStore.getState().setStreamState('off');
}
