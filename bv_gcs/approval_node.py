#!/usr/bin/env python3
"""
approval_node — human-in-the-loop gate between filtering_node's confirmed
detections and mission_node's autonomous LOCALIZE/DELIVER pipeline.

Wiring:
    filtering_node --/pending_obj_dets--> approval_node --/approved_obj_dets--> mission_node
                                              ^   |
                              srv /detection_decision  /pending_obj_dets_active (latched)
"""

import uuid

import rclpy
from rclpy.node import Node
from rclpy.qos import DurabilityPolicy, QoSProfile, ReliabilityPolicy

from std_msgs.msg import Int8
from bv_msgs.msg import PendingDetection
from bv_msgs.srv import DetectionDecision


class ApprovalNode(Node):
    def __init__(self):
        super().__init__('approval_node')

        self.declare_parameter('decision_timeout_sec', 0.0)
        self.declare_parameter('auto_approve_on_timeout', False)
        self.timeout = float(self.get_parameter('decision_timeout_sec').value)
        self.auto_on_timeout = bool(
            self.get_parameter('auto_approve_on_timeout').value)

        reliable = QoSProfile(depth=10)
        reliable.reliability = ReliabilityPolicy.RELIABLE

        latched = QoSProfile(depth=1)
        latched.reliability = ReliabilityPolicy.RELIABLE
        latched.durability = DurabilityPolicy.TRANSIENT_LOCAL

        self.create_subscription(
            PendingDetection, '/pending_obj_dets', self.on_pending, reliable)
        self.active_pub = self.create_publisher(
            PendingDetection, '/pending_obj_dets_active', latched)
        self.approved_pub = self.create_publisher(
            Int8, '/approved_obj_dets', reliable)
        self.create_service(
            DetectionDecision, '/detection_decision', self.on_decision)

        self._active = None
        self._timer = None

        self.get_logger().info(
            f"approval_node ready (timeout={self.timeout}s, "
            f"auto_approve_on_timeout={self.auto_on_timeout})")

    def on_pending(self, msg: PendingDetection):
        if self._active is not None:
            self.get_logger().warn(
                f"new pending while {self._active.detection_id} is active "
                f"— ignoring")
            return

        if not msg.detection_id:
            msg.detection_id = str(uuid.uuid4())

        self._active = msg
        self.active_pub.publish(msg)
        self.get_logger().info(
            f"PENDING id={msg.detection_id} class={msg.class_id} "
            f"lat={msg.latitude:.6f} lon={msg.longitude:.6f}")

        if self.timeout > 0:
            self._timer = self.create_timer(self.timeout, self._on_timeout)

    def on_decision(self, request, response):
        if self._active is None:
            response.accepted = False
            response.message = "no active pending detection"
            return response

        if request.detection_id != self._active.detection_id:
            response.accepted = False
            response.message = (
                f"detection_id mismatch (active={self._active.detection_id})")
            return response

        if request.approved:
            self.approved_pub.publish(
                Int8(data=int(self._active.class_id)))
            response.message = "approved — published to /approved_obj_dets"
            self.get_logger().info(
                f"APPROVED id={self._active.detection_id} "
                f"class={self._active.class_id}")
        else:
            response.message = (
                f"rejected: {request.reason}" if request.reason else "rejected")
            self.get_logger().info(
                f"REJECTED id={self._active.detection_id} "
                f"class={self._active.class_id} reason={request.reason!r}")

        self._clear_active()
        response.accepted = True
        return response

    def _on_timeout(self):
        if self._active is None:
            return
        if self.auto_on_timeout:
            self.approved_pub.publish(
                Int8(data=int(self._active.class_id)))
            self.get_logger().warn(
                f"decision timeout — auto-APPROVED id={self._active.detection_id}")
        else:
            self.get_logger().warn(
                f"decision timeout — auto-REJECTED id={self._active.detection_id}")
        self._clear_active()

    def _clear_active(self):
        self._active = None
        if self._timer is not None:
            self._timer.cancel()
            self._timer = None
        # Publish an empty PendingDetection so the latched topic reflects "no
        # pending" — a freshly-connected browser sees the cleared state, not
        # a stale already-decided detection.
        self.active_pub.publish(PendingDetection())


def main(args=None):
    rclpy.init(args=args)
    node = ApprovalNode()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == '__main__':
    main()
