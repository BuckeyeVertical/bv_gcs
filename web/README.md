# bv-gcs web

Browser-based Palantir-style frontend for the [bv_gcs](../README.md) human-in-the-loop ground control station.

This is the operator-facing dashboard. It connects to a `rosbridge_websocket` running on the drone, subscribes to mission state and pending detections, and lets the operator approve or reject each detection from a dark map view before the drone acts on it. Everything in this folder runs on the **ground laptop's browser**, not on the drone.

## Stack

| Concern | Choice |
| --- | --- |
| Build | Vite 5 |
| Framework | React 18 + TypeScript (strict) |
| State | Zustand |
| Styling | Tailwind CSS 3 with a custom dark palette + JetBrains Mono / Inter |
| Map | MapLibre GL JS, CARTO `dark-matter` style |
| ROS transport | roslibjs over `rosbridge_websocket` |

## Layout

```
web/
├── index.html
├── package.json, vite.config.ts, tsconfig.json
├── tailwind.config.ts, postcss.config.js
└── src/
    ├── main.tsx, App.tsx, index.css
    ├── ros/
    │   ├── client.ts       # roslib.Ros singleton, reconnect loop, topic + service wrappers
    │   └── types.ts        # TypeScript mirrors of bv_msgs interfaces
    ├── store/useGcsStore.ts
    ├── lib/geo.ts          # haversine distance + bearing
    └── components/
        ├── ConnectionStatus.tsx
        ├── MissionStatePanel.tsx
        ├── MapView.tsx
        ├── PendingDetectionPanel.tsx
        ├── DecisionButtons.tsx
        └── ui/Button.tsx
```

## UI

Three-column layout, top header is the connection indicator:

- **Left sidebar** — `MissionStatePanel`. Shows the mission FSM state (`scan`, `localize`, ...) in an accent color matching the phase, and the drone's live GPS.
- **Center** — `MapView`. CARTO dark map, drone pin (blue), pending detection pin (pulsing amber). Auto-flies to a new detection.
- **Right sidebar** — `PendingDetectionPanel`. Class name, lat/lon, altitude, distance, bearing, confidence, decision id, and two big Approve / Reject buttons. Keyboard shortcuts: **A** to approve, **R** to reject.

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `VITE_ROS_URL` | `ws://localhost:9090` | WebSocket URL of `rosbridge_websocket`. Set this when the drone isn't on `localhost`. |

The map style is hard-coded to CARTO `dark-matter` in `src/components/MapView.tsx`. For offline operation, swap that URL for a locally-hosted `tileserver-gl` style. The required OSM + CARTO attribution is rendered automatically by MapLibre — don't remove the attribution control.

## ROS contract (what the frontend talks to)

All topics/services come from the [bv_gcs](../README.md) ROS package via `rosbridge_websocket`.

| Direction | Name | Type | Used by |
| --- | --- | --- | --- |
| subscribe | `/pending_obj_dets_active` | `bv_msgs/PendingDetection` (latched) | `MapView`, `PendingDetectionPanel` |
| subscribe | `/mission_state` | `std_msgs/String` | `MissionStatePanel` |
| subscribe | `/mavros/global_position/global` | `sensor_msgs/NavSatFix` | `MissionStatePanel`, `MapView` |
| call | `/detection_decision` | `bv_msgs/DetectionDecision` | `DecisionButtons` |

An empty `detection_id` on `/pending_obj_dets_active` means "no pending"; `approval_node` publishes that whenever a decision is finalized.

## Prerequisites

- Node.js 20 or newer on the ground laptop.
- A `rosbridge_websocket` reachable from the laptop. Usually this comes from launching `bv_core` with `human_approval_required:=true` on the drone — see the [bv_gcs README](../README.md#how-to-run).

## How to run

### First time

```bash
cd ~/bv_ws/src/bv_gcs/web
npm install
```

### Dev server (every time)

```bash
# Drone on the LAN at, say, 192.168.4.1
cd ~/bv_ws/src/bv_gcs/web
VITE_ROS_URL=ws://192.168.4.1:9090 npm run dev
# → http://localhost:5173
```

If you're testing against `localhost` (drone stack and browser on the same machine), `VITE_ROS_URL` can be omitted — the client defaults to `ws://localhost:9090`.

The dev server binds to `0.0.0.0:5173` so other devices on the LAN can hit it too — useful for a tablet operator.

### Production build

```bash
npm run build
npm run preview   # local preview of the built bundle on http://localhost:4173
```

The build output lands in `dist/`. To deploy, copy `dist/` to any static host (nginx, Caddy, S3, GitHub Pages). At build time `VITE_ROS_URL` is **not** baked in unless you set it during `npm run build`; for runtime configuration, re-build with the right URL or replace `client.ts` with one that reads from a runtime `window.__BV_GCS_CONFIG__` global.

## Bring-up checklist

1. On the drone: `ros2 launch bv_core mission.launch.py human_approval_required:=true`.
2. Confirm `ros2 node list` shows `/rosbridge_websocket` and `/approval_node`.
3. On the ground laptop: `npm run dev` (with `VITE_ROS_URL` if needed).
4. Open `http://localhost:5173` — the top-right indicator should read `ROSBRIDGE` in green.
5. `MissionStatePanel` should display the current FSM state (e.g. `SCAN`) and live drone GPS.
6. Trigger a detection. The right panel pops up with class + lat/lon, the map pin pulses.
7. Press **A** or click **APPROVE** — `mission_node` logs `OBJECT CONFIRMED!` and transitions to `localize`.

## Tips

- **Slow LAN / dropped frames:** the dev server hot-reloads on file change, which can fight a slow link. For demos use `npm run build && npm run preview`.
- **Map shows blank tiles:** the laptop needs internet access for the default CARTO tiles. Hot-swap to `https://demotiles.maplibre.org/style.json` to verify everything except tile delivery, then arrange offline tiles for the AO.
- **Late join:** opening the browser after a detection has fired still works — `/pending_obj_dets_active` is latched.
- **Stale detection:** `approval_node` answers with `accepted: false` and `message: "detection_id mismatch ..."` if you decide on a detection that's already been resolved (e.g. you double-clicked Approve and the second call arrived after the topic was cleared). The store treats `accepted: false` as a soft failure and surfaces the message.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Indicator stays red | `rosbridge_websocket` not running, wrong `VITE_ROS_URL`, or firewall blocking 9090. |
| Indicator green, no popup | `/pending_obj_dets_active` not publishing — check `approval_node` logs on the drone, or filtering hasn't fired a confirmation. |
| Popup appears, buttons grayed out | A decision is in-flight (`inFlightDecisionId`). Wait for the service to return; check browser console for service errors. |
| APPROVE returns `accepted: false` | The detection was already decided. Common if the browser was disconnected mid-flight; just wait for the next pending. |
| Drone pin missing | No NavSatFix yet — confirm MAVROS is publishing `/mavros/global_position/global`. |
