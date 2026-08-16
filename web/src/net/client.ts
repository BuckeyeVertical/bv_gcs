import { useGcsStore } from '../store/useGcsStore';
import type { DecisionAck, ServerMessage } from './types';

const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 5000;
// If the drone hasn't acknowledged a verdict by now, tell the operator rather than
// leaving the buttons disabled forever.
const ACK_TIMEOUT_MS = 8000;

/**
 * Where the bridge lives.
 *
 * Unset in both normal cases: served from approval_node (same origin), or the vite
 * dev server proxying /ws and /frame to the drone. VITE_GCS_URL is only needed to
 * point a standalone build at a different host.
 */
function resolveWsUrl(): string {
  const configured = import.meta.env.VITE_GCS_URL as string | undefined;
  if (configured) return configured;
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws`;
}

export const WS_URL = resolveWsUrl();

/** HTTP origin for /frame/<id>, derived from the WebSocket URL. */
const HTTP_ORIGIN = WS_URL.replace(/^ws/, 'http').replace(/\/ws$/, '');

export const frameUrl = (path: string): string => `${HTTP_ORIGIN}${path}`;

let socket: WebSocket | null = null;
let backoffMs = RECONNECT_MIN_MS;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

interface Waiter {
  resolve: (ack: DecisionAck) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const waiters = new Map<string, Waiter>();

function settleWaiter(detectionId: string, ack: DecisionAck) {
  const waiter = waiters.get(detectionId);
  if (!waiter) return;
  clearTimeout(waiter.timer);
  waiters.delete(detectionId);
  waiter.resolve(ack);
}

function failAllWaiters(reason: string) {
  for (const [id, waiter] of waiters) {
    clearTimeout(waiter.timer);
    waiter.reject(new Error(reason));
    waiters.delete(id);
  }
}

function handleMessage(raw: string) {
  let msg: ServerMessage;
  try {
    msg = JSON.parse(raw) as ServerMessage;
  } catch {
    console.warn('[gcs] non-JSON frame from bridge');
    return;
  }

  const store = useGcsStore.getState();

  switch (msg.type) {
    case 'snapshot':
      store.setMissionState(msg.mission_state);
      store.setDroneFix(msg.drone_fix);
      store.setActivePending(msg.pending);
      store.setConfirmWindow(msg.confirm_window);
      store.setSahiProgress(msg.sahi_progress);
      break;
    case 'confirm_window':
      store.setConfirmWindow(msg.window);
      break;
    case 'sahi_progress':
      store.setSahiProgress(msg.progress);
      break;
    case 'pending':
      store.setActivePending(msg.pending);
      break;
    case 'mission_state':
      store.setMissionState(msg.data);
      break;
    case 'drone_fix':
      store.setDroneFix({
        latitude: msg.latitude,
        longitude: msg.longitude,
      });
      break;
    case 'decision_ack':
      settleWaiter(msg.detection_id, {
        accepted: msg.accepted,
        message: msg.message,
      });
      break;
    case 'preview_state':
      store.setPreviewEnabled(msg.enabled);
      break;
  }
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, backoffMs);
  backoffMs = Math.min(backoffMs * 2, RECONNECT_MAX_MS);
}

export function connect() {
  if (
    socket &&
    (socket.readyState === WebSocket.OPEN ||
      socket.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }

  socket = new WebSocket(WS_URL);

  socket.onopen = () => {
    backoffMs = RECONNECT_MIN_MS;
    useGcsStore.getState().setConnected(true);
  };

  socket.onmessage = (event) => handleMessage(event.data as string);

  socket.onclose = () => {
    useGcsStore.getState().setConnected(false);
    // A pending shown while disconnected is not trustworthy — the drone may have
    // timed out and moved on without us.
    useGcsStore.getState().setActivePending(null);
    failAllWaiters('link dropped before the drone acknowledged');
    scheduleReconnect();
  };

  socket.onerror = () => {
    // onclose always follows, which is where reconnect is handled.
    socket?.close();
  };
}

/**
 * Ask the drone to start or stop the debug preview encoder.
 *
 * Fire-and-forget: the drone answers with a `preview_state` message, which is what
 * actually moves the toggle. A dropped request just means the toggle does not move.
 */
export function setPreview(enabled: boolean) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'preview', enabled }));
  }
}

export function sendDecision(
  detectionId: string,
  approved: boolean,
  reason = '',
): Promise<DecisionAck> {
  return new Promise((resolve, reject) => {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      reject(new Error('link is down'));
      return;
    }

    const timer = setTimeout(() => {
      waiters.delete(detectionId);
      reject(new Error('no acknowledgement from the drone'));
    }, ACK_TIMEOUT_MS);

    waiters.set(detectionId, { resolve, reject, timer });

    socket.send(
      JSON.stringify({
        type: 'decision',
        detection_id: detectionId,
        approved,
        reason,
      }),
    );
  });
}
