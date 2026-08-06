// Mirrors the JSON protocol served by bv_gcs/approval_node.py. Keep field names
// aligned with the payloads built there — approval_node resolves class names, so the
// browser never needs its own copy of CLASS_NAMES.

export interface PendingDetection {
  detection_id: string;
  class_id: number;
  class_name: string;
  latitude: number;
  longitude: number;
  altitude: number;
  confidence: number;
  drone_latitude: number;
  drone_longitude: number;
  /** Seconds the operator has before mission_node auto-approves. 0 = no limit. */
  timeout_sec: number;
  /** How long ago this detection arrived at approval_node, recomputed on every send
   *  so a late-joining client gets the correct remaining time without clock sync. */
  age_sec: number;
  /** Path to the annotated crop, or null if the detection carried no image. */
  image_url: string | null;
}

export interface DroneFix {
  latitude: number;
  longitude: number;
}

export interface DecisionAck {
  accepted: boolean;
  message: string;
}

export type ServerMessage =
  | {
      type: 'snapshot';
      pending: PendingDetection | null;
      mission_state: string | null;
      drone_fix: DroneFix | null;
    }
  | { type: 'pending'; pending: PendingDetection | null }
  | { type: 'mission_state'; data: string }
  | { type: 'drone_fix'; latitude: number; longitude: number }
  | {
      type: 'decision_ack';
      detection_id: string;
      accepted: boolean;
      message: string;
    };
