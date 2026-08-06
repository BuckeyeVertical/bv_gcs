# bv-gcs web

Operator dashboard for [bv_gcs](../README.md). Runs entirely in the browser on the
ground laptop — nothing in this folder executes on the drone.

## Stack

| Concern | Choice |
| --- | --- |
| Build | Vite 5 |
| Framework | React 18 + TypeScript (strict) |
| State | Zustand |
| Styling | Tailwind CSS 3, custom dark palette, **system font stack** |
| Transport | Native `WebSocket` + `fetch` |

No map library, no roslib, no webfont CDN. The ground laptop rides a Herelink link with
no route to the internet, so anything remote would simply stall. The whole bundle is
~51 KB gzipped.

## Layout

```
src/
├── main.tsx, App.tsx, index.css, vite-env.d.ts
├── net/
│   ├── client.ts     # WebSocket, backoff reconnect, sendDecision() -> ack promise
│   └── types.ts      # mirrors approval_node's JSON protocol
├── store/useGcsStore.ts
├── lib/geo.ts        # haversine distance + bearing
└── components/
    ├── DetectionImage.tsx      # the annotated crop — the primary evidence
    ├── ApprovalCountdown.tsx   # auto-deploy countdown
    ├── PendingDetectionPanel.tsx
    ├── DecisionButtons.tsx     # Approve/Reject, [A]/[R] shortcuts
    ├── MissionStatePanel.tsx
    ├── ConnectionStatus.tsx
    └── ui/Button.tsx
```

## Development

```bash
npm install
GCS_TARGET=http://<drone-ip>:8765 npm run dev    # defaults to 127.0.0.1:8765
```

`vite.config.ts` proxies `/ws`, `/frame`, and `/healthz` to `GCS_TARGET`, so the dev
server and the production bundle run identical client code — the URL is resolved from
`window.location` in both cases. `VITE_GCS_URL` exists only for pointing a standalone
build at a different host.

## Build

```bash
npm run build      # tsc -b && vite build -> dist/
```

`bv_gcs/setup.py` installs `dist/` into the package share, and `approval_node` serves it
at `/`. Rebuild the ROS package after building the frontend, or the drone keeps serving
the old bundle — `approval_node` logs the `dist/` build timestamp at startup so this is
visible rather than silent.

## Design notes

- **The image is the evidence.** It gets the largest region of the screen, with explicit
  loading and error states — a blank panel would read as "the detector found nothing",
  which is precisely the wrong impression.
- **The countdown says what inaction means.** The timeout fails open, so letting it
  expire deploys a payload. The label says "No response = deploy, not skip" because an
  operator who assumes silence is safe would be wrong.
- **The panel clears only when the drone says so.** `DecisionButtons` never clears
  locally; it waits for `mission_node` to publish a cleared pending. A UI that dismissed
  itself optimistically could show a decision that never reached the aircraft.
- **A dropped link clears the pending.** A detection displayed while disconnected isn't
  trustworthy — the drone may have timed out and moved on.
