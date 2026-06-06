import ROSLIB from 'roslib';
import { useGcsStore } from '../store/useGcsStore';
import type {
  DetectionDecisionRequest,
  DetectionDecisionResponse,
  NavSatFix,
  PendingDetection,
} from './types';

const DEFAULT_URL = 'ws://localhost:9090';
const url = (import.meta.env.VITE_ROS_URL as string | undefined) ?? DEFAULT_URL;

export const ros = new ROSLIB.Ros({ url });

const { setConnected, setActivePending, clearActivePending, setMissionState, setDroneFix } =
  useGcsStore.getState();

ros.on('connection', () => setConnected(true));
ros.on('close', () => setConnected(false));
ros.on('error', () => setConnected(false));

// Reconnect loop — roslib doesn't auto-reconnect after a close event.
setInterval(() => {
  if (!useGcsStore.getState().connected) {
    try {
      ros.connect(url);
    } catch {
      /* swallow — next tick retries */
    }
  }
}, 2000);

// Topic: /pending_obj_dets_active (latched) — current detection awaiting decision.
const pendingTopic = new ROSLIB.Topic({
  ros,
  name: '/pending_obj_dets_active',
  messageType: 'bv_msgs/PendingDetection',
});
pendingTopic.subscribe((msg) => {
  const detection = msg as unknown as PendingDetection;
  if (detection.detection_id) {
    setActivePending(detection);
  } else {
    clearActivePending();
  }
});

// Topic: /mission_state — drives the left sidebar status.
const missionStateTopic = new ROSLIB.Topic({
  ros,
  name: '/mission_state',
  messageType: 'std_msgs/String',
});
missionStateTopic.subscribe((msg) => {
  setMissionState((msg as unknown as { data: string }).data);
});

// Topic: /mavros/global_position/global — drone pin on the map.
const gpsTopic = new ROSLIB.Topic({
  ros,
  name: '/mavros/global_position/global',
  messageType: 'sensor_msgs/NavSatFix',
});
gpsTopic.subscribe((msg) => {
  const fix = msg as unknown as NavSatFix;
  setDroneFix({ latitude: fix.latitude, longitude: fix.longitude });
});

// Service: /detection_decision — approve/reject.
const decisionService = new ROSLIB.Service({
  ros,
  name: '/detection_decision',
  serviceType: 'bv_msgs/DetectionDecision',
});

export function sendDecision(
  detectionId: string,
  approved: boolean,
  reason = '',
): Promise<DetectionDecisionResponse> {
  return new Promise((resolve, reject) => {
    const request = new ROSLIB.ServiceRequest({
      detection_id: detectionId,
      approved,
      reason,
    } satisfies DetectionDecisionRequest);
    decisionService.callService(
      request,
      (response) => resolve(response as unknown as DetectionDecisionResponse),
      (err) => reject(new Error(err)),
    );
  });
}
