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

The debug video relay rides alongside, on its own WebSocket at `/video`:

    vision_node --/preview_stream--> approval_node --binary WS /video--> browser
                <--/preview_enabled--                <--JSON WS /ws (toggle)--

`/video` is deliberately *not* `/ws`. Sharing one socket would let a backlog of
H.264 delay an approval verdict — the aircraft would still be safe, since
mission_node owns the timeout, but the operator would be clicking Approve into a
stalled pipe. For the same reason video sends drop rather than queue.
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
from std_msgs.msg import Bool, String, UInt8MultiArray


# Mirrors CLASS_NAMES in bv_core. Resolved here so the browser stays dumb and there
# is one fewer copy of this list to drift.
CLASS_NAMES = ("person", "tent")

# How long to wait for mission_node to answer a decision before telling the operator
# it did not land. Generous: the service handler itself is trivial, so exceeding this
# means the link or the node is in trouble.
DECISION_CALL_TIMEOUT_S = 5.0

# Socket backlog past which a video chunk is dropped instead of sent. Video is
# expendable and a verdict is not, so a client whose transport is already backed up
# loses this chunk rather than accumulating an unbounded queue of them in the kernel
# and in suspended send tasks. The next keyframe recovers the picture.
VIDEO_BACKLOG_DROP_BYTES = 512_000


def class_name(class_id: int) -> str:
    """Human-readable name for a semantic class id."""
    if 0 <= class_id < len(CLASS_NAMES):
        return CLASS_NAMES[class_id]
    return f"class_{class_id}"


def video_backlog_bytes(ws: web.WebSocketResponse) -> int:
    """Bytes still queued in this socket's transport, or 0 if unknowable.

    Reaches for aiohttp internals, so every step is guarded: an unexpected shape
    means "no measurable backlog", which degrades to always sending rather than
    never sending. A stuck client is then bounded by the transport's own flow
    control instead of by us, which is worse but not broken.
    """
    writer = getattr(ws, '_writer', None)
    transport = getattr(writer, 'transport', None)
    if transport is None:
        return 0
    try:
        return int(transport.get_write_buffer_size())
    except Exception:  # noqa: BLE001 - closing transports raise assorted things
        return 0


def should_send_video(backlog_bytes: int) -> bool:
    """Whether to send a chunk given the client's current transport backlog."""
    return backlog_bytes <= VIDEO_BACKLOG_DROP_BYTES


# Top-level MP4 boxes that make up a fragmented-MP4 *initialisation segment*.
# Everything else on /preview_stream is media (`moof`/`mdat`) and is useless to a
# decoder that has not seen these first.
INIT_SEGMENT_BOXES = (b'ftyp', b'moov')

# Ceiling on the remembered init segment. Ours is under 1 KiB (32 B ftyp + ~861 B
# moov); the cap only exists so a malformed length field can never make this grow
# without bound.
MAX_INIT_SEGMENT_BYTES = 256 * 1024

# Every top-level box this encoder can emit. Anything else at what we believe is a
# box boundary means we are not on one, and the parser resynchronises.
TOP_LEVEL_BOXES = (b'ftyp', b'moov', b'moof', b'mdat', b'styp', b'sidx',
                   b'free', b'skip', b'mfra')

# Largest plausible top-level box. The preview runs at 400 kbps in 200 ms
# fragments, so a real one is kilobytes; a length read out of H.264 payload by a
# desynchronised parser is routinely hundreds of megabytes.
MAX_BOX_BYTES = 32 * 1024 * 1024


class VideoInitCache:
    """Remembers the fMP4 initialisation segment so late joiners can decode.

    vision_node's encoder is `mp4mux ... streamable=true`, which emits `ftyp` and
    `moov` exactly once, when the pipeline starts, and nothing but `moof`/`mdat`
    after that. The relay is otherwise stateless, so a browser that opens /video
    while the encoder is already running never sees those two chunks: its first
    appendBuffer is a `moof`, MSE rejects a media segment with no init segment,
    the SourceBuffer errors, the MediaSource closes and the <video> ends up with
    error code 4 and a permanently black frame. Since the operator normally opens
    the page *after* the mission is up, that is the common case, not the corner.

    So we watch the chunk stream, keep whatever belongs to the init segment, and
    replay it to each new client before the live chunks. A fresh `ftyp` means the
    encoder rebuilt (a tier change or a resolution change), so the old init is
    dropped rather than added to.

    Chunk boundaries do not line up with box boundaries — a `mdat` arrives as an
    8-byte header chunk followed by its payload — so this tracks how many bytes of
    the current top-level box are still outstanding instead of trying to parse
    every chunk from its first byte. Without that, a payload chunk that happened
    to begin with the bytes 'moov' would be mistaken for an init segment.

    Thread-safe: observe() runs on the ROS executor thread, snapshot() on the
    aiohttp event loop.
    """

    def __init__(self):
        self._lock = threading.Lock()
        self._chunks: list[bytes] = []
        self._bytes = 0
        self._remaining = 0       # unconsumed bytes of the box currently in flight
        self._collecting = False  # ...and whether that box is part of the init segment
        self._seen_any = False    # has anything at all come down /preview_stream

    def observe(self, chunk: bytes) -> bool:
        """Classify one outbound chunk, remembering it if it is init data.

        Returns whether this chunk *begins* a media fragment (`moof`), which is
        the only point at which a new client can be handed the live stream
        without receiving the tail of a fragment whose header it never saw.
        """
        with self._lock:
            self._seen_any = True
            keep = False
            starts_fragment = (
                self._remaining == 0
                and len(chunk) >= 8
                and chunk[4:8] == b'moof'
            )
            i = 0
            while i < len(chunk):
                if self._remaining > 0:
                    take = min(self._remaining, len(chunk) - i)
                    keep = keep or self._collecting
                    self._remaining -= take
                    i += take
                    continue
                if len(chunk) - i < 8:
                    # A box header split across chunks. Never happens with this
                    # encoder; resync rather than guess.
                    self._collecting = False
                    break
                size = int.from_bytes(chunk[i:i + 4], 'big')
                box = chunk[i + 4:i + 8]
                if box not in TOP_LEVEL_BOXES or not 8 <= size <= MAX_BOX_BYTES:
                    # We are not on a box boundary after all — the relay started
                    # mid-stream, so the first chunk it ever saw was the middle of
                    # a `mdat` and everything since has been parsed against a
                    # length read out of H.264 payload. Give up on this chunk and
                    # start again from byte 0 of the next one: chunks do begin on
                    # box boundaries, so the next `moof` or `ftyp` resynchronises
                    # us. Without this, one bogus length (they are easily hundreds
                    # of megabytes) swallows the stream for hours, no boundary is
                    # ever reported and no client is ever admitted.
                    self._remaining = 0
                    self._collecting = False
                    break
                if box == b'ftyp':
                    # Encoder restarted: this init supersedes the one we hold.
                    self._chunks = []
                    self._bytes = 0
                self._collecting = box in INIT_SEGMENT_BOXES
                self._remaining = size
            if keep and self._bytes + len(chunk) <= MAX_INIT_SEGMENT_BYTES:
                self._chunks.append(chunk)
                self._bytes += len(chunk)
            return starts_fragment

    def snapshot(self) -> list[bytes]:
        """The init chunks to replay to a client that has just connected."""
        with self._lock:
            return list(self._chunks)

    def missed_the_header(self) -> bool:
        """Chunks have flowed but their header was emitted before we existed.

        Distinguishes "the encoder has not started yet, wait for it" — the normal
        state when the operator has just clicked Start stream — from "the encoder
        is running and its one-and-only header is unrecoverable".
        """
        with self._lock:
            return self._seen_any and not self._chunks


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
        index_path = os.path.join(path, 'index.html')
        if os.path.isfile(index_path):
            return os.path.dirname(os.path.realpath(index_path))
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
        # filtering_node's live confirmation window, latched so a GCS that connects
        # mid-scan sees it at once. Purely informational: nothing here feeds back
        # into what the aircraft confirms.
        window_qos = QoSProfile(depth=1)
        window_qos.reliability = ReliabilityPolicy.RELIABLE
        window_qos.durability = DurabilityPolicy.TRANSIENT_LOCAL
        window_qos.history = HistoryPolicy.KEEP_LAST
        self.create_subscription(
            String, '/confirmation_window', self._on_confirm_window, window_qos,
            callback_group=self._cb_group)
        self.create_subscription(
            String, '/sahi_progress', self._on_sahi_progress, window_qos,
            callback_group=self._cb_group)
        self.create_subscription(
            String, '/mission_state', self._on_mission_state, reliable,
            callback_group=self._cb_group)
        self.create_subscription(
            NavSatFix, '/mavros/global_position/global', self._on_gps, best_effort,
            callback_group=self._cb_group)

        # Matches vision_node's /preview_stream publisher (RELIABLE, KEEP_LAST,
        # depth 10). Deliberately not BEST_EFFORT: both nodes sit on the drone with
        # no radio between them, and fragmented-MP4 chunks are not independently
        # droppable — losing one stalls the browser's MSE decoder rather than
        # merely skipping a frame. Dropping is done later, per client, where we
        # can see which client is actually struggling.
        preview_qos = QoSProfile(depth=10)
        preview_qos.reliability = ReliabilityPolicy.RELIABLE
        preview_qos.history = HistoryPolicy.KEEP_LAST

        self.create_subscription(
            UInt8MultiArray, '/preview_stream', self._on_preview_chunk,
            preview_qos, callback_group=self._cb_group)

        # Latched so vision_node picks up the operator's current choice even if it
        # (re)starts after the toggle was flipped.
        self.preview_pub = self.create_publisher(Bool, '/preview_enabled', latched)

        self.decision_client = self.create_client(
            DetectionDecision, '/detection_decision', callback_group=self._cb_group)

        # Shared state, read by the asyncio thread when building a snapshot.
        self._active: dict | None = None
        self._active_received_mono: float = 0.0
        # How much of the timeout had already elapsed when this arrived. Nonzero
        # only when we joined a decision already in progress (see _initial_age).
        self._active_initial_age: float = 0.0
        self._mission_state: str | None = None
        self._confirm_window: dict | None = None
        self._sahi_progress: dict | None = None
        self._drone_fix: dict | None = None
        self._frames: OrderedDict[str, tuple[str, bytes]] = OrderedDict()
        self._last_gps_emit = 0.0
        self._lock = threading.Lock()

        # Set by GcsServer once its event loop is running.
        self.emit = None
        self.emit_video = None

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

    def _on_confirm_window(self, msg: String):
        """Relay filtering_node's confirmation window to the browser.

        Malformed JSON is dropped rather than raised: this is a debug view, and a
        parse error must not take out the callback group that also carries pending
        detections.
        """
        try:
            window = json.loads(msg.data)
        except (ValueError, TypeError):
            return
        with self._lock:
            if window == self._confirm_window:
                return
            self._confirm_window = window
        self._emit({'type': 'confirm_window', 'window': window})

    def _on_sahi_progress(self, msg: String):
        """Relay vision_node's current inference batch state."""
        try:
            progress = json.loads(msg.data)
        except (ValueError, TypeError):
            return
        if not isinstance(progress, dict):
            return
        with self._lock:
            if progress == self._sahi_progress:
                return
            self._sahi_progress = progress
        self._emit({'type': 'sahi_progress', 'progress': progress})

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

    def _on_preview_chunk(self, msg: UInt8MultiArray):
        """Forward one fragmented-MP4 chunk to the video socket.

        With no video client connected this costs one attribute test and a call
        that returns immediately — nothing is copied, cached or queued here.
        """
        if self.emit_video is not None:
            self.emit_video(bytes(msg.data))

    def set_preview_enabled(self, enabled: bool):
        """Publish the operator's toggle to vision_node."""
        self.preview_pub.publish(Bool(data=bool(enabled)))
        self.get_logger().info(f"debug preview {'ON' if enabled else 'OFF'}")

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
            confirm_window = self._confirm_window
            sahi_progress = self._sahi_progress
        return {
            'type': 'snapshot',
            'pending': self.pending_for_send(),
            'mission_state': mission_state,
            'drone_fix': drone_fix,
            'confirm_window': confirm_window,
            'sahi_progress': sahi_progress,
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
        # Video rides a *separate* endpoint and a separate client set from control.
        # Sharing one socket would let a backlog of H.264 delay an approval verdict:
        # the aircraft would still be safe (mission_node owns the timeout) but the
        # operator would be clicking Approve into a stalled pipe at exactly the
        # moment it matters. Keep the two sets and the two paths strictly apart.
        self.video_clients: set[web.WebSocketResponse] = set()
        # Clients that have had the init segment replayed and are waiting for the
        # next fragment boundary before they join the live set.
        self.video_waiting: set[web.WebSocketResponse] = set()
        # Replayed to each new video client so a browser joining an already-running
        # encoder gets a decodable stream. See VideoInitCache.
        self.video_init = VideoInitCache()
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

    def emit_video_threadsafe(self, chunk: bytes):
        """Called from the ROS executor thread.

        Returns without scheduling anything when nobody is watching, so an
        unwatched stream is dropped here rather than buffered anywhere.
        """
        # Before the early return, deliberately: the init segment is emitted the
        # moment the encoder starts, which is normally *before* anyone is
        # watching. Missing it here is exactly the bug this cache exists to fix.
        starts_fragment = self.video_init.observe(chunk)
        if self.loop is None or self.loop.is_closed():
            return
        # Schedule for waiting clients too, not only for the boundary chunk that
        # admits them. Promotion happens on the event loop, so between scheduling
        # the boundary chunk and that coroutine actually running, this thread sees
        # video_clients still empty — and would drop the chunks in between. The
        # `mdat` header is an 8-byte chunk of its own and sits exactly there, so
        # the client received the `moof`, no `mdat` header, then the payload, and
        # died with MEDIA_ERR_DECODE. Let the loop decide who gets what.
        if not self.video_clients and not self.video_waiting:
            return
        asyncio.run_coroutine_threadsafe(
            self._broadcast_video(chunk, starts_fragment), self.loop)

    async def _broadcast_video(self, chunk: bytes, starts_fragment: bool = False):
        """Send to video clients, dropping rather than queueing.

        A client whose transport is already backed up loses this chunk instead of
        piling up suspended sends that each pin a chunk in memory. Video is
        expendable; the next keyframe recovers the picture. A verdict is not.

        A client that has had the init segment replayed waits here until a chunk
        that starts a `moof`. Handing it the live stream at any other point would
        begin it with the tail of a fragment whose header it never saw, which the
        browser's byte-stream parser rejects just as hard as a missing init.
        """
        if starts_fragment and self.video_waiting:
            self.video_clients |= self.video_waiting
            self.video_waiting = set()

        if not self.video_clients:
            return

        for ws in list(self.video_clients):
            try:
                if ws.closed:
                    self.video_clients.discard(ws)
                    continue
                if not should_send_video(video_backlog_bytes(ws)):
                    continue
                await ws.send_bytes(chunk)
            except (ConnectionResetError, RuntimeError):
                self.video_clients.discard(ws)

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
                elif data.get('type') == 'preview':
                    enabled = bool(data.get('enabled'))
                    self.node.set_preview_enabled(enabled)
                    await ws.send_str(json.dumps({
                        'type': 'preview_state',
                        'enabled': enabled,
                    }))
        finally:
            self.clients.discard(ws)
            self.node.get_logger().info(
                f"GCS client {peer} disconnected ({len(self.clients)} left)")
        return ws

    async def video_handler(self, request: web.Request) -> web.WebSocketResponse:
        """Dedicated video socket, separate from /ws.

        max_msg_size=0 lifts aiohttp's inbound cap, which is irrelevant for the
        outbound chunks but would otherwise apply to this socket too.
        """
        ws = web.WebSocketResponse(heartbeat=20, max_msg_size=0)
        await ws.prepare(request)
        # Init segment first, and before the socket joins the live set, so the
        # client cannot receive a media fragment ahead of the header that makes it
        # decodable. Failing to send it is not fatal to the relay: log and carry on
        # rather than refusing the connection.
        init = self.video_init.snapshot()
        try:
            for chunk in init:
                await ws.send_bytes(chunk)
        except (ConnectionResetError, RuntimeError):
            self.node.get_logger().warn('video client dropped during init replay')
            return ws
        # With no init cached (nothing has streamed yet) there is nothing to align
        # to, so join the live set directly and take the encoder's own header when
        # it starts. Otherwise wait for the next fragment boundary.
        if init:
            self.video_waiting.add(ws)
        else:
            self.video_clients.add(ws)
            if self.video_init.missed_the_header():
                # The encoder emits its header once, at start. If it started
                # before this process did, that header is simply gone and no
                # browser can decode the stream until the encoder is rebuilt.
                # Toggling the preview off and on from the GCS does exactly that,
                # so say so instead of leaving the operator on "Connecting…".
                self.node.get_logger().warn(
                    'video client connected but no initialisation segment has '
                    'been seen — the encoder was already running before this '
                    'relay started. Toggle the debug stream off and on again to '
                    'make it emit a new one.')
        self.node.get_logger().info(
            f"video client connected from {request.remote} "
            f"({len(self.video_clients) + len(self.video_waiting)} total, "
            f"{len(init)} init chunk(s) replayed)")
        try:
            async for _ in ws:
                pass          # clients never send on this socket
        finally:
            self.video_clients.discard(ws)
            self.video_waiting.discard(ws)
            self.node.get_logger().info(
                f"video client disconnected ({len(self.video_clients)} left)")
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
            'video_clients': len(self.video_clients) + len(self.video_waiting),
            'pending': self.node.pending_for_send(),
            'mission_state': self.node.snapshot()['mission_state'],
            'frontend': self.dist_dir or 'not built',
        })

    async def index_handler(self, _request: web.Request) -> web.FileResponse:
        # no-cache means "you may keep it, but revalidate before use" — not
        # no-store. Without it a browser holds index.html indefinitely and keeps
        # requesting the content-hashed bundle it named when it was cached. That
        # bundle is almost always still on disk, because colcon copies into the
        # install space without ever cleaning it, so the stale request succeeds
        # and a rebuilt frontend silently changes nothing. The hashed assets
        # themselves stay cacheable forever; that is what the hash is for.
        return web.FileResponse(
            os.path.join(self.dist_dir, 'index.html'),
            headers={'Cache-Control': 'no-cache'})

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
        app.router.add_get('/video', self.video_handler)
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
        self.node.emit_video = self.emit_video_threadsafe

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
            f"  (ws://.../ws, video on ws://.../video)")

        try:
            await asyncio.Event().wait()   # run until cancelled
        finally:
            for ws in (list(self.clients) + list(self.video_clients)
                       + list(self.video_waiting)):
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
