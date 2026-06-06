import { create } from 'zustand';
import type { PendingDetection } from '../ros/types';

interface DroneFix {
  latitude: number;
  longitude: number;
}

interface GcsState {
  connected: boolean;
  missionState: string | null;
  droneFix: DroneFix | null;
  activePending: PendingDetection | null;
  inFlightDecisionId: string | null;
  lastMessage: string | null;

  setConnected: (v: boolean) => void;
  setMissionState: (s: string) => void;
  setDroneFix: (fix: DroneFix) => void;
  setActivePending: (p: PendingDetection) => void;
  clearActivePending: () => void;
  setInFlightDecisionId: (id: string | null) => void;
  setLastMessage: (m: string | null) => void;
}

export const useGcsStore = create<GcsState>((set) => ({
  connected: false,
  missionState: null,
  droneFix: null,
  activePending: null,
  inFlightDecisionId: null,
  lastMessage: null,

  setConnected: (v) => set({ connected: v }),
  setMissionState: (s) => set({ missionState: s }),
  setDroneFix: (fix) => set({ droneFix: fix }),
  setActivePending: (p) => set({ activePending: p }),
  clearActivePending: () =>
    set({ activePending: null, inFlightDecisionId: null }),
  setInFlightDecisionId: (id) => set({ inFlightDecisionId: id }),
  setLastMessage: (m) => set({ lastMessage: m }),
}));
