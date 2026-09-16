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

### Why the stitched map comes down over HTTP too

The mosaic `stitching_node` writes (`<output_dir>/mosaic_<timestamp>.jpg`) is served
at `GET /mosaic/latest` rather than pulled with `scp`. The server is already running,
so it costs one route; the operator fetches it in the dashboard tab that is already
open, with no SSH key or hand-typed path at mission time; and aiohttp's `FileResponse`
honors Range requests, so a transfer interrupted by a radio dropout resumes with
`curl -C -`. `scp` cannot resume a partial file.

A stitch run writes up to two mosaics: the feature-matched `mosaic_<stamp>.jpg` and the
dead-reckoned `naive_mosaic_<stamp>.jpg` fallback. The dashboard's **Stitched map**
panel downloads a run's mosaics together, handing each URL to the browser's download
manager rather than buffering files in the tab. The panel also shows the `curl -C -`
form, one line per file, which stays the more dependable option on a link that drops
repeatedly.

A run is every mosaic sharing a `<stamp>`, never "the two most recent files": the naive
fallback is written *before* phase 1 (`stitching.py:662`), so a run whose feature stitch
fails leaves only a naive mosaic, and pairing by recency would marry it to the previous
scan's feature mosaic. `/mosaic/latest` resolves inside the newest run for the same
reason — feature mosaic first, naive only when the feature path produced nothing.

Two details decide which file "latest" means. Ordering is by **mtime, not filename**:
`stitching_node` stamps names `%m%d_%H%M` with no year, so a lexical sort would rank
December above January and serve last year's map on the first flight of the new year.
And a file only becomes eligible once it ends with its **end-of-image marker**, because
`cv2.imwrite` writes straight to the final name — for the length of that write the new
mosaic exists, holds the newest mtime, and is short. Serving it then would hand the
operator a truncated map inside a normal `200`, and `curl -C -` would treat the short
`Content-Length` as a finished download. Until the write completes, `/mosaic/latest`
returns the previous complete mosaic.

### Why the raw frames come down with it

The mosaic is a *derived* artifact. When a stitch comes out wrong the map is the one
thing that cannot be re-run, so the **Stitched map** button takes the stitcher's inputs
in the same click — the `row<N>_<M>.jpg` frames the run was built from, served as one
archive at `GET /raw_frames/archive/<token>`. An operator who has to remember a second
button is an operator who lands without them.

They come from `raw_frames/backup/<stamp>/`, **not** from the loose `raw_frames/`.
`stitching_node` *moves* its inputs into that subdirectory the moment a stitch succeeds
(`stitching.py:802`) and `vision_node` clears the loose directory at each `SCAN` entry
(`vision_node.py:296`), so the loose directory is empty exactly when there is a map to
download beside it. `backup/<stamp>/` is where a finished run's frames actually live —
and `<stamp>` is the same stamp that run's mosaics carry, because `stitching_node` names
both from one timestamp (`stitching.py:639`). The panel serves the **newest** archived
run, which in the ordinary case is precisely the inputs to the map downloading with it.

"Newest" is by **mtime, not name**, the same rule `/mosaic/latest` follows and for the
same reason: the stamp is `%m%d_%H%M` with no year, so a lexical sort would rank December
above January and serve last year's frames on the first flight of the new year.

Having none is normal rather than an error — before the first successful stitch there is
no `backup/` at all. `/raw_frames/list` answers `200` with `count: 0` instead of the `404`
the mosaic endpoints use, and the button falls back to downloading the maps alone.

Two cases where the frames are *not* the map's inputs, both visible rather than silent.
`/raw_frames/list` reports the run stamp and the panel prints it beside the mosaic
filenames, which carry theirs, so a mismatch can be read off the screen. The first is a
stitch that **failed**: `_restore_files` puts the frames back in the loose directory and
no `backup/<stamp>/` is ever created (`stitching.py:848`), so the naive fallback mosaic
downloads next to the *previous* run's frames. The second is a scan flown but not yet
stitched — its frames are still loose and not offered at all. In both, `rsync` is still
the way to get those particular frames.

The frames ride as one archive rather than one download each, which is the opposite of
the choice made for the mosaics above. A run is 24-36 files: that many sequential anchor
clicks costs more in operator time and Downloads-folder mess than the per-file resume it
would buy, and the archive itself still resumes, because it is built to a real file and
served with `FileResponse`.

### Why the archive's URL carries a fingerprint

`/raw_frames/archive/<token>`, not a bare `/raw_frames/archive`, and the token is a hash
of every frame's name, size and mtime. The reason is resumption, the same concern that
shapes `/mosaic/latest`.

A stable URL over changing bytes cannot be resumed safely. `curl -C -` sends a bare
`Range` header with **no validator at all**, so the server has nothing to notice
staleness with, and aiohttp's `FileResponse` does not honor the `If-Range` a browser
*does* send — it answers `206` either way. A resume that straddled a rebuild would splice
two different archives into a zip that is corrupt without ever looking corrupt. Putting
the fingerprint in the path makes that resume a `404` instead, which is loud, and the
panel issues the current URL on its next poll. It also means the archive can be cached
indefinitely, exactly like a stamped mosaic.

The file is built once per frame set, under a `.partial` name renamed into place for the
same reason `/mosaic/latest` waits for an end-of-image marker, and zipped in a thread so
20 MB of archiving never stalls the WebSocket heartbeat. Only the newest one is kept —
the aircraft's disk is not big enough for one per scan. Stored, not deflated: the members
are JPEGs, so compression would only spend CPU. And it is always called `images.zip`
regardless of its URL — the mosaic beside it carries the run stamp, and a fixed filename
keeps the command that unzips it the same command every time.

`scp`/`rsync` remain the right tool for the *other* job — the post-mission bulk pull of
the whole `stitching_results/` tree and the rest of the `raw_frames/backup/` history,
which the panel never offers because it only ever serves the newest run. That is an
archival sync, not a browser job: `rsync -avP` handles it properly.

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
| vision → approval | `/sahi_progress` | `std_msgs/String` | Current SAHI batch size, state, and duration. |

`approval_node` parameters (`config/approval_params.yaml`):

| Parameter | Default | Purpose |
| --- | --- | --- |
| `ws_host` | `0.0.0.0` | Bind address, so any host on the Herelink WiFi can reach it. |
| `ws_port` | `8765` | HTTP + WebSocket port. |
| `gps_broadcast_hz` | `1.0` | Rate limit for drone position pushes. |
| `frame_cache_size` | `8` | Recent crops kept in memory for `GET /frame/<id>`. |
| `mosaic_dir` | `<bv_core>/stitching_results` | Where `stitching_node` writes mosaics. Override alongside its `output_dir`. |
| `raw_frames_dir` | `<bv_core>/raw_frames` | Where `vision_node` writes scan frames. Override alongside `stitching_node`'s `input_dir`. |

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
| `GET /healthz` | Client count, active pending, frontend path, mosaic dir, and the address the client reached us on. Handy over SSH. |
| `GET /mosaic/latest` | Newest *complete* stitched map, JPEG. Range-capable, so `curl -C -` resumes. |
| `GET /mosaic/list` | JSON index of mosaics: name, size, mtime, kind, run — plus `latest_run`. |
| `GET /mosaic/file/<name>` | A specific mosaic by name, as listed by `/mosaic/list`. |
| `GET /raw_frames/list` | JSON index of the newest archived run's frames, with its `run` stamp. `200` with `count: 0` before the first successful stitch — a normal state, not an error. |
| `GET /raw_frames/archive/<token>` | That run's frames as `images.zip`. `<token>` fingerprints the frame set — take it from `/raw_frames/list`. Range-capable, so `curl -C -` resumes. |

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

After syncing repository commits to the Jetson, build and deploy an updated GCS from
the development computer with:

```bash
./scripts/sync_jetson_gcs.sh
```

The script builds `web/dist` locally (the Jetson does not need npm), copies the bundle
to `~/bv_ws/src/bv_gcs/web/dist` over the first available Jetson link (USB-C first),
and runs `colcon build` for the full Jetson workspace. An alternate SSH host or remote
workspace can be passed as the first or second argument; run the script with `--help`
for details.

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

The panel is covered by `test/test_frames.py` (run selection, frame discovery, archive
contents, the pre-1980 clock a companion computer boots with) and `test/test_mosaic.py`:

```bash
python3 -m pytest src/bv_gcs/test/test_frames.py src/bv_gcs/test/test_mosaic.py
```

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
