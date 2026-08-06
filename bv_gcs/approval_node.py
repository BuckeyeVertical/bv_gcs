#!/usr/bin/env python3
"""
approval_node — ground-station bridge for the human-in-the-loop detection gate.

    mission_node --/pending_obj_dets--> approval_node <--WebSocket JSON--> browser
          ^                                    |
          └────── srv /detection_decision ─────┘

This node is a *relay*, not an authority. mission_node assigns detection IDs, owns
the approval timeout, and decides what the aircraft actually does. All this process
does is forward pending detections to whatever browsers are connected and forward
their verdicts back. Nothing here is safety-critical: if this process dies, or the
link drops, mission_node still times out on its own and continues the mission.

The annotated crop travels over plain HTTP (`GET /frame/<detection_id>`) rather than
base64 inside the WebSocket frame. That keeps the control channel responsive on a
constrained link, avoids base64's 1.33x overhead, and lets the browser retry a failed
image without disturbing the decision path.
"""

import asyncio
import json
import os
import threading
import time
from collections import OrderedDict

import rclpy
from aiohttp import WSMsgType, web
from ament_index_python.packages import get_package_share_directory
from rclpy.callback_groups import ReentrantCallbackGroup
from rclpy.executors import MultiThreadedExecutor
from rclpy.node import Node
from rclpy.qos import DurabilityPolicy, HistoryPolicy, QoSProfile, ReliabilityPolicy

from bv_msgs.msg import PendingDetection
from bv_msgs.srv import DetectionDecision
from sensor_msgs.msg import NavSatFix
from std_msgs.msg import String


# Mirrors CLASS_NAMES in bv_core. Resolved here so the browser stays dumb and there
# is one fewer copy of this list to drift.
CLASS_NAMES = ("person", "tent")

# How long to wait for mission_node to answer a decision before telling the operator
# it did not land. Generous: the service handler itself is trivial, so exceeding this
# means the link or the node is in trouble.
DECISION_CALL_TIMEOUT_S = 5.0


def class_name(class_id: int) -> str:
    """Human-readable name for a semantic class id."""
    if 0 <= class_id < len(CLASS_NAMES):
        return CLASS_NAMES[class_id]
    return f"class_{class_id}"


def find_frontend_dist() -> str | None:
    """Locate the built frontend, preferring the installed copy.

    Returns None when the frontend has not been built, which is a normal state
    during development (the vite dev server serves it instead).
    """
    candidates = []
    try:
        candidates.append(
            os.path.join(get_package_share_directory('bv_gcs'), 'web', 'dist'))
    except Exception:
        pass
    # Source-tree fallback: bv_gcs/bv_gcs/approval_node.py -> bv_gcs/web/dist
    candidates.append(
        os.path.normpath(
            os.path.join(os.path.dirname(__file__), '..', 'web', 'dist')))

    for path in candidates:
        if os.path.isfile(os.path.join(path, 'index.html')):
            return path
    return None


class ApprovalNode(Node):
    """ROS half of the bridge: tracks the active pending and calls the decision service."""

    def __init__(self):
        super().__init__('approval_node')

        self.declare_parameter('ws_host', '0.0.0.0')
        self.declare_parameter('ws_port', 8765)
        self.declare_parameter('gps_broadcast_hz', 1.0)
        self.declare_parameter('frame_cache_size', 8)

        self.ws_host = str(self.get_parameter('ws_host').value)
        self.ws_port = int(self.get_parameter('ws_port').value)
        gps_hz = float(self.get_parameter('gps_broadcast_hz').value)
        self.gps_min_interval = 1.0 / gps_hz if gps_hz > 0 else 0.0
        self.frame_cache_size = int(self.get_parameter('frame_cache_size').value)

        reliable = QoSProfile(depth=1)
        reliable.reliability = ReliabilityPolicy.RELIABLE
        reliable.history = HistoryPolicy.KEEP_LAST

        # TRANSIENT_LOCAL matches mission_node's latched publisher, so a
        # restarted approval_node or a recovered link immediately receives the
        # live pending instead of showing an empty dashboard.
        latched = QoSProfile(depth=1)
        latched.reliability = ReliabilityPolicy.RELIABLE
        latched.history = HistoryPolicy.KEEP_LAST
        latched.durability = DurabilityPolicy.TRANSIENT_LOCAL

        best_effort = QoSProfile(depth=1)
        best_effort.reliability = ReliabilityPolicy.BEST_EFFORT
        best_effort.history = HistoryPolicy.KEEP_LAST

        self._cb_group = ReentrantCallbackGroup()

        self.create_subscription(
            PendingDetection, '/pending_obj_dets', self._on_pending, latched,
            callback_group=self._cb_group)
        self.create_subscription(
            String, '/mission_state', self._on_mission_state, reliable,
            callback_group=self._cb_group)
        self.create_subscription(
            NavSatFix, '/mavros/global_position/global', self._on_gps, best_effort,
            callback_group=self._cb_group)

        self.decision_client = self.create_client(
            DetectionDecision, '/detection_decision', callback_group=self._cb_group)

        # Shared state, read by the asyncio thread when building a snapshot.
        self._active: dict | None = None
        self._active_received_mono: float = 0.0
        # How much of the timeout had already elapsed when this arrived. Nonzero
        # only when we joined a decision already in progress (see _initial_age).
        self._active_initial_age: float = 0.0
        self._mission_state: str | None = None
        self._drone_fix: dict | None = None
        self._frames: OrderedDict[str, tuple[str, bytes]] = OrderedDict()
        self._last_gps_emit = 0.0
        self._lock = threading.Lock()

        # Set by GcsServer once its event loop is running.
        self.emit = None

    # -- ROS callbacks ----------------------------------------------------------

    def _on_pending(self, msg: PendingDetection):
        """Handle a new pending detection, or an empty message meaning 'cleared'."""
        if not msg.detection_id:
            with self._lock:
                self._active = None
            self.get_logger().info("pending cleared")
            self._emit({'type': 'pending', 'pending': None})
            return

        image_bytes = bytes(msg.annotated_crop.data)
        if image_bytes:
            self._cache_frame(
                msg.detection_id, msg.annotated_crop.format or 'jpeg', image_bytes)

        payload = {
            'detection_id': msg.detection_id,
            'class_id': int(msg.class_id),
            'class_name': class_name(int(msg.class_id)),
            'latitude': float(msg.latitude),
            'longitude': float(msg.longitude),
            'altitude': float(msg.altitude),
            'confidence': float(msg.confidence),
            'drone_latitude': float(msg.drone_latitude),
            'drone_longitude': float(msg.drone_longitude),
            'timeout_sec': float(msg.timeout_sec),
            'image_url': f'/frame/{msg.detection_id}' if image_bytes else None,
        }

        with self._lock:
            previous = self._active
            already_tracking = (
                previous is not None
                and previous['detection_id'] == msg.detection_id)
            self._active = payload
            if not already_tracking:
                self._active_received_mono = time.monotonic()
                self._active_initial_age = self._initial_age(msg)

        if previous and previous['detection_id'] != msg.detection_id:
            # mission_node is authoritative and should never have two open at once.
            # If it does, follow it rather than ignoring — a UI showing a detection
            # the aircraft has moved on from is worse than a surprising swap.
            self.get_logger().warn(
                f"replacing active pending {previous['detection_id']} "
                f"with {msg.detection_id}")

        self.get_logger().info(
            f"PENDING id={msg.detection_id} class={payload['class_name']} "
            f"lat={payload['latitude']:.6f} lon={payload['longitude']:.6f} "
            f"timeout={payload['timeout_sec']:.0f}s "
            f"image={'yes' if image_bytes else 'MISSING'}")

        self._emit({'type': 'pending', 'pending': self.pending_for_send()})

    def _initial_age(self, msg: PendingDetection) -> float:
        """Seconds of the timeout already spent before this message reached us.

        Normally zero — the pending arrives the instant mission_node publishes
        it. But the latched (TRANSIENT_LOCAL) publisher exists precisely so a
        restarted approval_node picks up a decision already in progress, and
        there, treating arrival as t=0 renders a full countdown when the real
        deadline may be seconds away. The operator would deliberate against a
        false clock while the drone deploys underneath them.

        mission_node stamps the header, so the elapsed time is recoverable. It
        depends on the two machines' clocks agreeing, so it is only trusted when
        the result is plausible: a zero stamp (no stamp), a negative age (skew
        the wrong way) or an age past the deadline all fall back to 0.0, which
        is the previous behaviour and never shows a negative countdown.
        """
        stamp_sec = float(msg.header.stamp.sec) + msg.header.stamp.nanosec * 1e-9
        if stamp_sec <= 0.0:
            return 0.0
        now = self.get_clock().now()
        age = (now.nanoseconds * 1e-9) - stamp_sec
        timeout = float(msg.timeout_sec)
        if age < 0.0 or (timeout > 0.0 and age > timeout):
            self.get_logger().warn(
                f"implausible pending age {age:.1f}s from header stamp "
                f"(timeout={timeout:.0f}s) - counting down from arrival instead")
            return 0.0
        if age > 1.0:
            self.get_logger().info(
                f"joined a decision already {age:.0f}s old; "
                f"countdown starts from the real deadline")
        return age

    def _on_mission_state(self, msg: String):
        with self._lock:
            if msg.data == self._mission_state:
                return
            self._mission_state = msg.data
        self._emit({'type': 'mission_state', 'data': msg.data})

    def _on_gps(self, msg: NavSatFix):
        """Forward the drone position, throttled — MAVROS publishes far faster than
        a constrained link should carry."""
        now = time.monotonic()
        if self.gps_min_interval and (now - self._last_gps_emit) < self.gps_min_interval:
            # Still keep the latest value so a snapshot is never stale.
            with self._lock:
                self._drone_fix = {
                    'latitude': msg.latitude, 'longitude': msg.longitude}
            return
        self._last_gps_emit = now
        fix = {'latitude': msg.latitude, 'longitude': msg.longitude}
        with self._lock:
            self._drone_fix = fix
        self._emit({'type': 'drone_fix', **fix})

    # -- state helpers ----------------------------------------------------------

    def _cache_frame(self, detection_id: str, fmt: str, data: bytes):
        with self._lock:
            self._frames[detection_id] = (fmt, data)
            self._frames.move_to_end(detection_id)
            while len(self._frames) > self.frame_cache_size:
                self._frames.popitem(last=False)

    def get_frame(self, detection_id: str) -> tuple[str, bytes] | None:
        with self._lock:
            return self._frames.get(detection_id)

    def pending_for_send(self) -> dict | None:
        """The active pending, with a freshly computed age.

        `age_sec` is how much of the timeout has been spent, recomputed at send time.
        The browser derives its countdown deadline from `timeout_sec - age_sec`, so a
        late-joining client gets the right remaining time.

        The elapsed part is monotonic, so ticking never depends on the drone and the
        ground laptop agreeing on wall-clock time. Only the offset for a decision that
        was already running when we subscribed comes from the header stamp, and that
        falls back to zero whenever it looks wrong.
        """
        with self._lock:
            if self._active is None:
                return None
            payload = dict(self._active)
            payload['age_sec'] = (
                self._active_initial_age
                + (time.monotonic() - self._active_received_mono))
            return payload

    def snapshot(self) -> dict:
        with self._lock:
            mission_state = self._mission_state
            drone_fix = dict(self._drone_fix) if self._drone_fix else None
        return {
            'type': 'snapshot',
            'pending': self.pending_for_send(),
            'mission_state': mission_state,
            'drone_fix': drone_fix,
        }

    def _emit(self, payload: dict):
        if self.emit is not None:
            self.emit(payload)

    # -- service call -----------------------------------------------------------

    async def call_decision(self, detection_id: str, approved: bool, reason: str):
        """Forward an operator verdict to mission_node.

        Bridges rclpy's future (completed on the ROS executor thread) onto the
        asyncio loop this coroutine is running on.
        """
        if not self.decision_client.service_is_ready():
            return False, "mission_node is not offering /detection_decision"

        request = DetectionDecision.Request()
        request.detection_id = detection_id
        request.approved = approved
        request.reason = reason

        loop = asyncio.get_running_loop()
        aio_future = loop.create_future()
        ros_future = self.decision_client.call_async(request)

        def _on_done(fut):
            def _settle():
                if aio_future.done():
                    return
                try:
                    aio_future.set_result(fut.result())
                except Exception as exc:  # noqa: BLE001 - surfaced to the operator
                    aio_future.set_exception(exc)
            loop.call_soon_threadsafe(_settle)

        ros_future.add_done_callback(_on_done)

        try:
            response = await asyncio.wait_for(
                aio_future, timeout=DECISION_CALL_TIMEOUT_S)
        except asyncio.TimeoutError:
            return False, "mission_node did not respond"
        except Exception as exc:  # noqa: BLE001
            return False, f"service error: {exc}"

        return bool(response.accepted), str(response.message)


class GcsServer:
    """aiohttp half of the bridge: WebSocket, frame endpoint, and static frontend."""

    def __init__(self, node: ApprovalNode):
        self.node = node
        self.clients: set[web.WebSocketResponse] = set()
        self.loop: asyncio.AbstractEventLoop | None = None
        self.dist_dir = find_frontend_dist()

    # -- broadcasting -----------------------------------------------------------

    def emit_threadsafe(self, payload: dict):
        """Called from the ROS executor thread."""
        if self.loop is None or self.loop.is_closed():
            return
        asyncio.run_coroutine_threadsafe(self._broadcast(payload), self.loop)

    async def _broadcast(self, payload: dict):
        if not self.clients:
            return
        text = json.dumps(payload)
        for ws in list(self.clients):
            try:
                await ws.send_str(text)
            except (ConnectionResetError, RuntimeError):
                self.clients.discard(ws)

    # -- handlers ---------------------------------------------------------------

    async def ws_handler(self, request: web.Request) -> web.WebSocketResponse:
        # heartbeat= makes aiohttp ping the client, so a silently dead link is
        # detected instead of leaving a zombie connection forever.
        ws = web.WebSocketResponse(heartbeat=20)
        await ws.prepare(request)
        self.clients.add(ws)
        peer = request.remote
        self.node.get_logger().info(
            f"GCS client connected from {peer} ({len(self.clients)} total)")

        try:
            await ws.send_str(json.dumps(self.node.snapshot()))

            async for msg in ws:
                if msg.type != WSMsgType.TEXT:
                    continue
                try:
                    data = json.loads(msg.data)
                except json.JSONDecodeError:
                    self.node.get_logger().warn(f"non-JSON from {peer}")
                    continue
                if data.get('type') == 'decision':
                    await self._handle_decision(ws, data)
        finally:
            self.clients.discard(ws)
            self.node.get_logger().info(
                f"GCS client {peer} disconnected ({len(self.clients)} left)")
        return ws

    async def _handle_decision(self, ws: web.WebSocketResponse, data: dict):
        detection_id = str(data.get('detection_id', ''))
        approved = bool(data.get('approved', False))
        reason = str(data.get('reason', ''))

        self.node.get_logger().info(
            f"operator {'APPROVED' if approved else 'REJECTED'} id={detection_id}"
            + (f" reason={reason!r}" if reason else ""))

        accepted, message = await self.node.call_decision(
            detection_id, approved, reason)

        if not accepted:
            self.node.get_logger().warn(f"decision not accepted: {message}")

        await ws.send_str(json.dumps({
            'type': 'decision_ack',
            'detection_id': detection_id,
            'accepted': accepted,
            'message': message,
        }))

    async def frame_handler(self, request: web.Request) -> web.StreamResponse:
        detection_id = request.match_info['detection_id']
        entry = self.node.get_frame(detection_id)
        if entry is None:
            raise web.HTTPNotFound(text=f"no cached frame for {detection_id}")
        fmt, data = entry
        content_type = 'image/png' if 'png' in fmt.lower() else 'image/jpeg'
        return web.Response(
            body=data,
            content_type=content_type,
            # Frames are immutable per detection_id, so let the browser keep them.
            headers={'Cache-Control': 'public, max-age=3600'},
        )

    async def health_handler(self, _request: web.Request) -> web.Response:
        return web.json_response({
            'clients': len(self.clients),
            'pending': self.node.pending_for_send(),
            'mission_state': self.node.snapshot()['mission_state'],
            'frontend': self.dist_dir or 'not built',
        })

    async def index_handler(self, _request: web.Request) -> web.FileResponse:
        return web.FileResponse(os.path.join(self.dist_dir, 'index.html'))

    async def no_frontend_handler(self, _request: web.Request) -> web.Response:
        return web.Response(
            text=(
                "bv_gcs frontend has not been built.\n\n"
                "Build it with:  cd src/bv_gcs/web && npm install && npm run build\n"
                "then rebuild the package so web/dist is installed.\n\n"
                "During development, run `npm run dev` and use the vite dev server "
                "instead — it proxies /ws and /frame back here.\n"
            ),
            content_type='text/plain',
        )

    # -- lifecycle --------------------------------------------------------------

    def build_app(self) -> web.Application:
        app = web.Application()
        app.router.add_get('/ws', self.ws_handler)
        app.router.add_get('/frame/{detection_id}', self.frame_handler)
        app.router.add_get('/healthz', self.health_handler)

        if self.dist_dir:
            stamp = time.strftime(
                '%Y-%m-%d %H:%M:%S',
                time.localtime(os.path.getmtime(
                    os.path.join(self.dist_dir, 'index.html'))))
            # Logged so a stale bundle is visible rather than silently served.
            self.node.get_logger().info(
                f"serving frontend from {self.dist_dir} (built {stamp})")
            app.router.add_get('/', self.index_handler)
            app.router.add_static('/', self.dist_dir)
        else:
            self.node.get_logger().warn(
                "frontend not built — serving a placeholder page at /")
            app.router.add_get('/', self.no_frontend_handler)

        return app

    async def run(self):
        self.loop = asyncio.get_running_loop()
        self.node.emit = self.emit_threadsafe

        runner = web.AppRunner(self.build_app())
        await runner.setup()
        site = web.TCPSite(runner, self.node.ws_host, self.node.ws_port)
        try:
            await site.start()
        except OSError as exc:
            # Overwhelmingly this is a second approval_node already holding the port.
            # A one-line cause beats a ten-frame asyncio traceback in the field.
            self.node.get_logger().error(
                f"cannot bind {self.node.ws_host}:{self.node.ws_port} ({exc.strerror}). "
                f"Another approval_node is probably already running — check with "
                f"`ros2 node list`, or pick a different port with -p ws_port:=...")
            await runner.cleanup()
            raise SystemExit(1)

        self.node.get_logger().info(
            f"approval_node listening on http://{self.node.ws_host}:{self.node.ws_port}"
            f"  (ws://.../ws)")

        try:
            await asyncio.Event().wait()   # run until cancelled
        finally:
            for ws in list(self.clients):
                await ws.close()
            await runner.cleanup()


def main(args=None):
    rclpy.init(args=args)
    node = ApprovalNode()

    executor = MultiThreadedExecutor()
    executor.add_node(node)
    ros_thread = threading.Thread(target=executor.spin, daemon=True)
    ros_thread.start()

    server = GcsServer(node)
    try:
        asyncio.run(server.run())
    except KeyboardInterrupt:
        pass
    finally:
        executor.shutdown()
        node.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()


if __name__ == '__main__':
    main()
