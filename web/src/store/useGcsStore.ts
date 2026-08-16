import { create } from 'zustand';
import type {
  DroneFix,
  PendingDetection,
  ConfirmWindow,
  SahiProgress,
  StreamState,
} from '../net/types';

interface GcsState {
  connected: boolean;
  missionState: string | null;
  droneFix: DroneFix | null;
  activePending: PendingDetection | null;
  /**
   * Wall-clock ms when mission_node will auto-approve, or null when there is no
   * deadline. Derived once from timeout_sec - age_sec so the countdown never
   * depends on the drone and this laptop agreeing on the time.
   */
  pendingDeadline: number | null;
  inFlightDecisionId: string | null;
  lastMessage: string | null;

  /** Operator's debug-video toggle, mirrored from the drone's preview_state. */
  previewEnabled: boolean;
  streamState: StreamState;

  /** filtering_node's live confirmation window; null until scan starts. */
  confirmWindow: ConfirmWindow | null;
  /** vision_node's current or most recently completed SAHI batch. */
  sahiProgress: SahiProgress | null;
  setConnected: (v: boolean) => void;
  setMissionState: (s: string | null) => void;
  setDroneFix: (fix: DroneFix | null) => void;
  setActivePending: (p: PendingDetection | null) => void;
  setInFlightDecisionId: (id: string | null) => void;
  setLastMessage: (m: string | null) => void;
  setPreviewEnabled: (v: boolean) => void;
  setStreamState: (s: StreamState) => void;
  setConfirmWindow: (w: ConfirmWindow | null) => void;
  setSahiProgress: (p: SahiProgress | null) => void;
}

export const useGcsStore = create<GcsState>((set) => ({
  connected: false,
  missionState: null,
  droneFix: null,
  activePending: null,
  pendingDeadline: null,
  inFlightDecisionId: null,
  lastMessage: null,
  previewEnabled: false,
  streamState: 'off',
  confirmWindow: null,
  sahiProgress: null,

  setConnected: (v) => set({ connected: v }),
  setMissionState: (s) => set({ missionState: s }),
  setDroneFix: (fix) => set({ droneFix: fix }),
  setActivePending: (p) =>
    set({
      activePending: p,
      pendingDeadline:
        p && p.timeout_sec > 0
          ? Date.now() + Math.max(0, p.timeout_sec - p.age_sec) * 1000
          : null,
      inFlightDecisionId: null,
    }),
  setInFlightDecisionId: (id) => set({ inFlightDecisionId: id }),
  setLastMessage: (m) => set({ lastMessage: m }),
  setPreviewEnabled: (v) => set({ previewEnabled: v }),
  setStreamState: (s) => set({ streamState: s }),
  setConfirmWindow: (w) => set({ confirmWindow: w }),
  setSahiProgress: (p) => set({ sahiProgress: p }),
}));
