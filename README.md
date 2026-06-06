# bv_gcs

Human-in-the-loop ground control station for the [bv_core](https://github.com/BuckeyeVertical/bv_core) drone stack.

When the drone is running autonomously, every confirmed detection flows straight into the mission FSM and the drone immediately localizes, flies to the object, and deploys a payload. `bv_gcs` inserts a human approval gate into that flow: each confirmed detection pops up in a browser dashboard showing its class and geolocated lat/lon on a dark map, and the operator must click **APPROVE** (or **REJECT**) before the drone acts on it.

The package ships two pieces:

| Component | Path | Runs on | Role |
| --- | --- | --- | --- |
| `approval_node` (ROS 2 Python) | `bv_gcs/approval_node.py` | drone companion computer | Holds pending detections and gates the FSM. |
| Web frontend (Vite + React + TS) | `web/` | ground laptop browser | Palantir-style dark UI + map + Approve/Reject. |

## Architecture

```
[ Browser on ground laptop :5173 ]
                 |  WebSocket via roslibjs
                 v
[ Drone companion computer ]    rosbridge_websocket :9090
                                         |
filtering_node --/pending_obj_dets--> approval_node --/approved_obj_dets--> mission_node
                                         ^   |
                       srv /detection_decision  /pending_obj_dets_active (latched)
```

Only `rosbridge_websocket` (~100–160 MB RSS) and the small `approval_node` (~20–40 MB RSS) run on the drone. Everything else — the React app, the map tiles, the keyboard shortcuts — runs in the browser on the ground laptop. Net onboard overhead is **~120–200 MB**.

When the gate is disabled (`human_approval_required:=false`), neither `approval_node` nor `rosbridge_websocket` is launched; `mission_node` subscribes directly to `/global_obj_dets` and the original autonomous behavior is preserved bit-for-bit.

## Topic / service contract

| Direction | Name | Type | QoS | Purpose |
| --- | --- | --- | --- | --- |
| filtering → approval | `/pending_obj_dets` | `bv_msgs/PendingDetection` | RELIABLE | New confirmed detection with coarse lat/lon. |
| approval → GCS | `/pending_obj_dets_active` | `bv_msgs/PendingDetection` | RELIABLE, TRANSIENT_LOCAL, depth 1 | Latched current pending; late-joining browsers see it. Empty `detection_id` means no pending. |
| approval → mission | `/approved_obj_dets` | `std_msgs/Int8` | RELIABLE | Class ID — only published after APPROVE. |
| GCS → approval | `/detection_decision` | `bv_msgs/DetectionDecision` | service | Operator's decision. Response `accepted=false` if the `detection_id` is stale. |

`approval_node` parameters (see `config/approval_params.yaml`):

| Parameter | Type | Default | Purpose |
| --- | --- | --- | --- |
| `decision_timeout_sec` | double | `0.0` | If `> 0`, auto-resolve after this many seconds with no operator input. `0` = wait forever. |
| `auto_approve_on_timeout` | bool | `false` | When the timer fires, approve (`true`) or reject (`false`). |

## Dependencies

- ROS 2 Humble.
- `bv_msgs` with the two new interfaces added (see *Add new bv_msgs interfaces* below).
- `ros-humble-rosbridge-suite` on the drone (also added to `bv_core/container/Dockerfile.{arm,x86}`).
- Node.js 20+ on the ground laptop (for the web frontend; not on the drone).

## One-time setup

### 1. Add the new bv_msgs interfaces

`bv_gcs` adds two new ROS interfaces. They live in your existing [bv_msgs](https://github.com/BuckeyeVertical/bv_msgs) repo. Copy them in:

```bash
# From a checkout of this repo:
cp -r /path/to/bv_gcs_msgs_scaffold/msg/PendingDetection.msg  ~/bv_ws/src/bv_msgs/msg/
cp -r /path/to/bv_gcs_msgs_scaffold/srv/DetectionDecision.srv ~/bv_ws/src/bv_msgs/srv/
```

Then add them to `bv_msgs/CMakeLists.txt`:

```cmake
rosidl_generate_interfaces(${PROJECT_NAME}
  # ...existing entries...
  "msg/PendingDetection.msg"
  "srv/DetectionDecision.srv"
  DEPENDENCIES std_msgs
)
```

`std_msgs` is already a build dep in `bv_msgs/package.xml` (used by the existing `ObjectDetections.msg`), so no `package.xml` change is needed.

### 2. Clone bv_gcs into your workspace

```bash
cd ~/bv_ws/src
git clone https://github.com/BuckeyeVertical/bv_gcs.git
```

### 3. Install rosbridge_suite on the drone

If you're using the Docker images from `bv_core/container/`, this is already added. Otherwise:

```bash
sudo apt install ros-humble-rosbridge-suite
```

### 4. Build

```bash
cd ~/bv_ws
colcon build --packages-select bv_msgs bv_gcs bv_core
source install/local_setup.bash

# Sanity check:
ros2 interface show bv_msgs/msg/PendingDetection
ros2 interface show bv_msgs/srv/DetectionDecision
```

### 5. Install web frontend dependencies (ground laptop only)

```bash
cd ~/bv_ws/src/bv_gcs/web
npm install
```

See [`web/README.md`](web/README.md) for the full frontend story.

## How to run

The approval gate is wired into `bv_core`'s `mission.launch.py`. There are three useful invocations.

### A. Full stack with human approval (typical)

On the drone:

```bash
ros2 launch bv_core mission.launch.py human_approval_required:=true
```

This launches everything `mission.launch.py` normally does **plus**:
- `approval_node` (`bv_gcs`) — the gate node.
- `rosbridge_websocket` on port `9090` (customizable via `rosbridge_port:=...`).
- `mission_node` configured to listen to `/approved_obj_dets` instead of `/global_obj_dets`.

`true` is the default for `human_approval_required`, so just `ros2 launch bv_core mission.launch.py` also works.

On the ground laptop:

```bash
cd ~/bv_ws/src/bv_gcs/web
VITE_ROS_URL=ws://<drone-ip>:9090 npm run dev
# Open http://localhost:5173
```

Wait for `ConnectionStatus` to turn green, then trigger a scan. When filtering's 3-frame confirmation fires, the right panel will show the pending detection and the map will fly to the detection pin. Press **A** to approve or **R** to reject.

### B. Autonomous (no human in the loop)

```bash
ros2 launch bv_core mission.launch.py human_approval_required:=false
```

`approval_node` and `rosbridge_websocket` are skipped. `mission_node` subscribes directly to `/global_obj_dets`. Original behavior — useful for full-auto regression testing.

### C. GCS pieces only (bag replay / frontend dev)

If you're replaying a bag or otherwise running `mission_node` / `filtering_node` separately and only want the approval gate + bridge:

```bash
ros2 launch bv_gcs gcs.launch.py rosbridge_port:=9090
```

This launches just `approval_node` and `rosbridge_websocket`.

## Smoke-testing approval_node from the CLI

You can drive the gate without the browser to verify the wiring before bringing up the frontend:

```bash
# Terminal 1 — gate only
ros2 launch bv_gcs gcs.launch.py

# Terminal 2 — simulate filtering's confirmation
ros2 topic pub --once /pending_obj_dets bv_msgs/msg/PendingDetection \
  "{header: {frame_id: 'map'}, detection_id: '', class_id: 1,
    latitude: 38.387634, longitude: -76.419021, altitude: 25.0,
    confidence: 0.0, drone_latitude: 38.3876, drone_longitude: -76.4190}"

# Terminal 3 — verify the latched topic shows the pending
ros2 topic echo /pending_obj_dets_active --once
# (detection_id will be a UUID assigned by approval_node)

# Terminal 4 — approve it (use the detection_id from terminal 3)
ros2 service call /detection_decision bv_msgs/srv/DetectionDecision \
  "{detection_id: '<uuid-from-echo>', approved: true, reason: ''}"

# Terminal 5 — verify the class_id flows through
ros2 topic echo /approved_obj_dets
# Should print: data: 1
```

A stale `detection_id` returns `accepted: false` with `message: "detection_id mismatch ..."`.

## Package layout

```
bv_gcs/
├── package.xml, setup.py, setup.cfg, resource/bv_gcs
├── bv_gcs/
│   ├── __init__.py
│   └── approval_node.py
├── launch/gcs.launch.py
├── config/approval_params.yaml
└── web/                          # Vite + React + TS frontend — see web/README.md
```

## Troubleshooting

- **Browser says DISCONNECTED.** Confirm `rosbridge_websocket` is running (`ros2 node list | grep rosbridge`) and that `VITE_ROS_URL` points at the right host/port. The bridge defaults to `0.0.0.0:9090` and is reachable from any host on the LAN.
- **Detection arrives but no popup.** Check `ros2 topic echo /pending_obj_dets_active` on the drone — if the topic is silent, the publish side is the problem (filtering didn't fire confirmation, or `approval_node` is dropping it because another pending is still active). If the topic is publishing but the browser doesn't react, check the browser console for `roslib` errors and confirm `bv_msgs` is built so the message type is resolvable.
- **APPROVE clicked but mission doesn't transition.** Verify `mission_node` is subscribed to `/approved_obj_dets`, not `/global_obj_dets`. The launch arg `human_approval_required:=true` handles this; running `mission_node` standalone needs `--ros-args -p confirmed_topic:=/approved_obj_dets`.
- **Late-joining browser misses a detection.** The latched `/pending_obj_dets_active` topic should deliver it on subscribe. If it doesn't, confirm `rosbridge_suite` is recent enough to forward `TRANSIENT_LOCAL` durability (Humble's packaged version does).
# bv_gcs
