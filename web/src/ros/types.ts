// Mirrors bv_msgs interfaces. Keep field names exactly aligned with the .msg files.

export interface RosHeader {
  stamp: { sec: number; nanosec: number };
  frame_id: string;
}

export interface PendingDetection {
  header: RosHeader;
  detection_id: string;
  class_id: number;
  latitude: number;
  longitude: number;
  altitude: number;
  confidence: number;
  drone_latitude: number;
  drone_longitude: number;
}

export interface DetectionDecisionRequest {
  detection_id: string;
  approved: boolean;
  reason: string;
}

export interface DetectionDecisionResponse {
  accepted: boolean;
  message: string;
}

export interface NavSatFix {
  header: RosHeader;
  latitude: number;
  longitude: number;
  altitude: number;
}

export interface ObjectLocation {
  latitude: number;
  longitude: number;
  class_id: number;
}

// COCO-ish class names mirroring CLASS_NAMES in bv_core/filtering_node.py.
export const CLASS_NAMES = ['person', 'tent'] as const;

export const className = (id: number): string =>
  CLASS_NAMES[id] ?? `class_${id}`;
