# bv_gcs

Human-in-the-loop ground control station for the [bv_core](https://github.com/BuckeyeVertical/bv_core) drone stack.

Flying autonomously, every confirmed detection goes straight into the mission FSM: the
drone localizes the object, flies to it, and drops a payload. `bv_gcs` inserts an
operator gate into that flow. After the drone has localized a detection — and while it
holds in `AUTO.LOITER` — an **annotated crop of the frame that produced the fix** appears
in a browser dashboard, and the operator approves or rejects before the drone acts.

The operator judges from the image. Coordinates are shown as a sanity check, not as the
primary evidence.

| Component | Path | Runs on | Role |
| --- | --- | --- | --- |
| `approval_node` | `bv_gcs/approval_node.py` | drone companion computer | Relays pendings to the browser and verdicts back to `mission_node`. Also serves the frontend. |
| Web frontend | `web/` | ground laptop browser | Dark image-first UI with Approve/Reject. |

## Architecture

```
    mission_node --/pending_obj_dets--> approval_node <--WebSocket JSON--> browser
          ^                                    |
          └────── srv /detection_decision ─────┘
```

`approval_node` is a **relay, not an authority**. `mission_node` assigns detection IDs,
owns the approval timeout, and decides what the aircraft does. If this node crashes or
the radio link drops, `mission_node` still times out on its own and continues the
mission. Nothing here is safety-critical.

Only `approval_node` (~40 MB RSS) runs on the drone — there is no rosbridge, no Node.js,
and no npm on the aircraft. It speaks plain JSON over an `aiohttp` WebSocket.

When the gate is disabled (`human_approval_required:=false`), `mission_node` never
publishes a pending and the original autonomous behavior is preserved exactly.

### Why images go over HTTP

The annotated crop is fetched with `GET /frame/<detection_id>`, not embedded as base64
in the WebSocket frame. On a constrained radio link that keeps the control channel
responsive, avoids base64's 1.33x overhead, and lets a failed image retry on its own
without disturbing the decision path.

### Why the crop is not a whole frame

The camera is 4640 px wide. Downscaling a full frame small enough to send over the link
renders a person roughly 10–15 px tall — too small for a human to judge, which defeats
the point of asking one. `vision_node` sends a native-resolution crop around the
bounding box instead: smaller payload *and* a legible target.

## Contract

| Direction | Name | Type | Purpose |
| --- | --- | --- | --- |
| mission → approval | `/pending_obj_dets` | `bv_msgs/PendingDetection` | Localized detection + annotated crop. Empty `detection_id` means "cleared". |
| approval → mission | `/detection_decision` | `bv_msgs/DetectionDecision` (service) | Operator verdict. `accepted=false` if the ID is stale. |
| mission → all | `/mission_state` | `std_msgs/String` | Displayed in the sidebar. |
| MAVROS → approval | `/mavros/global_position/global` | `sensor_msgs/NavSatFix` | Drone position, throttled before broadcast. |

`approval_node` parameters (`config/approval_params.yaml`):

| Parameter | Default | Purpose |
| --- | --- | --- |
| `ws_host` | `0.0.0.0` | Bind address, so any host on the Herelink WiFi can reach it. |
| `ws_port` | `8765` | HTTP + WebSocket port. |
| `gps_broadcast_hz` | `1.0` | Rate limit for drone position pushes. |
| `frame_cache_size` | `8` | Recent crops kept in memory for `GET /frame/<id>`. |

**The approval timeout is deliberately not configured here.** It lives in
`bv_core/config/mission_params.yaml` as `Approval_timeout_sec` (default 180 s), because
a timer inside the process that might crash is not a safety net. It **fails open** — on
expiry the drone deploys and continues, which is exactly what it does with no gate at
all. `approval_node` forwards the value so the UI can show a countdown, and never acts
on it.

## HTTP endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /` | The dashboard (or a placeholder if `web/dist` isn't built). |
| `GET /ws` | WebSocket, 20 s heartbeat so a dead link is detected. |
| `GET /frame/<detection_id>` | Annotated crop, JPEG. |
| `GET /healthz` | Client count, active pending, frontend path. Handy over SSH. |

## Setup

Requires ROS 2 Humble, `bv_msgs` (with `PendingDetection.msg` and
`DetectionDecision.srv`), and `python3-aiohttp`. Node.js 20+ is needed only on a
development machine to build the frontend — never on the drone.

```bash
cd ~/bv_ws/src/bv_gcs/web && npm install && npm run build   # once, on a dev machine
cd ~/bv_ws && colcon build --packages-select bv_msgs bv_gcs
source install/setup.bash
```

The `npm run build` step is optional but recommended: it produces `web/dist`, which
`setup.py` installs and `approval_node` serves. Skip it and `/` shows a placeholder
telling you what to do.

## Running

### On the drone

```bash
ros2 launch bv_core mission.launch.py human_approval_required:=true
```

### On the ground laptop

Open `http://<drone-ip>:8765`. That's the whole procedure — no Node, no npm, no vite.
Any device on the Herelink WiFi works, including a phone or a spare laptop.

### Frontend development

```bash
cd ~/bv_ws/src/bv_gcs/web
GCS_TARGET=http://<drone-ip>:8765 npm run dev    # defaults to 127.0.0.1:8765
```

`vite.config.ts` proxies `/ws`, `/frame`, and `/healthz` to that target, so the dev
server and the served bundle run identical client code. Remember to `npm run build` and
rebuild the package before flying — `approval_node` logs the `dist/` build timestamp at
startup so a stale bundle is visible in the logs.

## Testing without a drone

`fake_pending` stands in for `mission_node`: it publishes a synthetic detection with a
real JPEG and serves `/detection_decision`, logging whatever verdict arrives.

```bash
ros2 launch bv_gcs gcs.launch.py
ros2 run bv_gcs fake_pending --ros-args -p timeout_sec:=45.0
```

Open `http://localhost:8765`, press **A** or **R**, and watch the verdict land in the
`fake_pending` log. It publishes a fresh detection a few seconds after each decision so
you can click through repeatedly (`-p auto_repeat:=false` to stop that).

## Troubleshooting

- **Browser says DISCONNECTED.** Check `approval_node` is up (`ros2 node list`) and that
  port 8765 is reachable. The client reconnects on its own with backoff — no reload needed.
- **`address already in use` on startup.** A second `approval_node` is running. The node
  logs this explicitly; use `-p ws_port:=...` or stop the other one.
- **Detection arrives but no image.** The panel says so explicitly rather than showing
  blank. Check `ros2 topic echo /pending_obj_dets --field annotated_crop.format` — an
  empty crop means `vision_node` didn't populate it.
- **Approve clicked, nothing happens.** The UI only clears when `mission_node` publishes
  a cleared pending, so a stuck panel means the verdict didn't reach the FSM. Check
  `/healthz` and the `approval_node` log for the service response.
- **Stale UI after a frontend change.** `approval_node` logs the `dist/` build time at
  startup. Rebuild with `npm run build` and re-run `colcon build`.
