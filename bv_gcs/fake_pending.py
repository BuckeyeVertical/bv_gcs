#!/usr/bin/env python3
"""
fake_pending — stand-in for mission_node, so the GCS can be exercised without a drone.

Publishes a synthetic PendingDetection carrying a real JPEG and serves
/detection_decision, logging whatever verdict the operator sends. This lets the whole
approval path (approval_node -> browser -> approval_node -> service) be tested with no
sim, no aircraft, and no bv_core changes.

    ros2 launch bv_gcs gcs.launch.py
    ros2 run bv_gcs fake_pending

By default it publishes a fresh detection a few seconds after each decision so you can
click through repeatedly. Override the countdown with:

    ros2 run bv_gcs fake_pending --ros-args -p timeout_sec:=20.0
"""

import uuid

import cv2
import numpy as np
import rclpy
from rclpy.node import Node
from rclpy.qos import DurabilityPolicy, HistoryPolicy, QoSProfile, ReliabilityPolicy

from bv_msgs.msg import PendingDetection
from bv_msgs.srv import DetectionDecision

CLASS_NAMES = ("person", "tent")

# Roughly the field the sim flies over, so the coordinates look plausible.
BASE_LAT = 38.387611
BASE_LON = -76.419054


def render_fake_crop(label: str, size: int = 640) -> bytes:
    """Draw something that looks like an annotated native-resolution crop."""
    rng = np.random.default_rng(seed=abs(hash(label)) % (2**32))

    # Grass-ish background with noise so JPEG size is realistic rather than trivial.
    img = np.full((size, size, 3), (58, 82, 54), dtype=np.uint8)
    img = np.clip(
        img.astype(np.int16) + rng.integers(-18, 18, img.shape), 0, 255
    ).astype(np.uint8)

    # A blob standing in for the target, roughly centred.
    cx, cy = size // 2, size // 2
    cv2.ellipse(img, (cx, cy), (46, 92), 0, 0, 360, (140, 120, 105), -1)
    cv2.circle(img, (cx, cy - 104), 30, (150, 132, 118), -1)

    # Detection box + label, matching what supervision draws in vision_node.
    x1, y1, x2, y2 = cx - 86, cy - 148, cx + 86, cy + 118
    cv2.rectangle(img, (x1, y1), (x2, y2), (64, 220, 84), 3)
    (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.7, 2)
    cv2.rectangle(img, (x1, y1 - th - 12), (x1 + tw + 10, y1), (64, 220, 84), -1)
    cv2.putText(img, label, (x1 + 5, y1 - 6),
                cv2.FONT_HERSHEY_SIMPLEX, 0.7, (12, 24, 12), 2, cv2.LINE_AA)

    ok, buf = cv2.imencode('.jpg', img, [int(cv2.IMWRITE_JPEG_QUALITY), 85])
    if not ok:
        raise RuntimeError("failed to encode fake crop")
    return buf.tobytes()


class FakePending(Node):

    def __init__(self):
        super().__init__('fake_pending')

        self.declare_parameter('timeout_sec', 180.0)
        self.declare_parameter('class_id', 0)
        self.declare_parameter('auto_repeat', True)
        self.declare_parameter('repeat_delay_sec', 4.0)

        self.timeout_sec = float(self.get_parameter('timeout_sec').value)
        self.class_id = int(self.get_parameter('class_id').value)
        self.auto_repeat = bool(self.get_parameter('auto_repeat').value)
        self.repeat_delay = float(self.get_parameter('repeat_delay_sec').value)

        # Must mirror mission_node's latched publisher, which is what this node
        # stands in for. approval_node subscribes TRANSIENT_LOCAL so a restarted
        # ground station picks up a decision already in progress; a VOLATILE
        # publisher here is simply incompatible and delivers nothing at all.
        latched = QoSProfile(depth=1)
        latched.reliability = ReliabilityPolicy.RELIABLE
        latched.history = HistoryPolicy.KEEP_LAST
        latched.durability = DurabilityPolicy.TRANSIENT_LOCAL

        self.pub = self.create_publisher(PendingDetection, '/pending_obj_dets', latched)
        self.create_service(
            DetectionDecision, '/detection_decision', self._on_decision)

        self._active_id = None
        self._counter = 0
        self._repeat_timer = None

        # Give approval_node a moment to finish subscribing before the first publish.
        self._startup_timer = self.create_timer(1.5, self._publish_once)

        self.get_logger().info(
            f"fake_pending ready (timeout_sec={self.timeout_sec}, "
            f"class={self._class_name()}, auto_repeat={self.auto_repeat})")

    def _class_name(self) -> str:
        if 0 <= self.class_id < len(CLASS_NAMES):
            return CLASS_NAMES[self.class_id]
        return f"class_{self.class_id}"

    def _publish_once(self):
        if self._startup_timer is not None:
            self._startup_timer.cancel()
            self._startup_timer = None
        if self._repeat_timer is not None:
            self._repeat_timer.cancel()
            self._repeat_timer = None

        self._counter += 1
        name = self._class_name()
        confidence = 0.94

        msg = PendingDetection()
        msg.header.stamp = self.get_clock().now().to_msg()
        msg.header.frame_id = 'map'
        msg.detection_id = str(uuid.uuid4())
        msg.class_id = self.class_id
        msg.latitude = BASE_LAT + 0.0003 * self._counter
        msg.longitude = BASE_LON + 0.0002 * self._counter
        msg.altitude = 15.2
        msg.confidence = confidence
        msg.drone_latitude = BASE_LAT
        msg.drone_longitude = BASE_LON
        msg.timeout_sec = self.timeout_sec
        msg.annotated_crop.header = msg.header
        msg.annotated_crop.format = 'jpeg'
        msg.annotated_crop.data = render_fake_crop(f"{name} {confidence:.2f}")

        self._active_id = msg.detection_id
        self.pub.publish(msg)
        self.get_logger().info(
            f"published pending #{self._counter} id={msg.detection_id} "
            f"class={name} crop={len(msg.annotated_crop.data)} bytes")

    def _clear(self):
        msg = PendingDetection()
        msg.header.stamp = self.get_clock().now().to_msg()
        self.pub.publish(msg)
        self._active_id = None

    def _on_decision(self, request, response):
        if self._active_id is None:
            response.accepted = False
            response.message = "no active pending detection"
            self.get_logger().warn("decision with nothing pending")
            return response

        if request.detection_id != self._active_id:
            response.accepted = False
            response.message = f"detection_id mismatch (active={self._active_id})"
            self.get_logger().warn(
                f"stale decision id={request.detection_id}")
            return response

        verdict = 'APPROVED' if request.approved else 'REJECTED'
        self.get_logger().info(
            f"{verdict} id={request.detection_id}"
            + (f" reason={request.reason!r}" if request.reason else ""))

        response.accepted = True
        response.message = (
            "approved — would fly to object and deploy" if request.approved
            else "rejected — would suppress this location and resume scan")

        self._clear()

        if self.auto_repeat:
            self._repeat_timer = self.create_timer(
                self.repeat_delay, self._publish_once)

        return response


def main(args=None):
    rclpy.init(args=args)
    node = FakePending()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()


if __name__ == '__main__':
    main()
