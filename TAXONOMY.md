# Project Taxonomy

Shared terminology for the Android progress bar prototype and its capture pipeline.

---

## Core Concepts

| Term | Definition |
|------|------------|
| **Capture** | A single run of the capture script. Produces a capture manifest plus one load session per URL. |
| **Capture manifest** | The JSON output file (e.g. `events-capture.json`) containing metadata, throttle profile, and an array of load sessions. |
| **Load session** | The recorded data for one URL: webview events, recording, and paint frames. One load session per URL per capture. |
| **Webview event** | A single event emitted by the injected observer during a page load. Includes navigation, DOM, paint, resource, and load events. |
| **Paint event** | A webview event that marks a significant visual milestone. Used to extract paint frames from the recording. |
| **Paint frame** | A PNG screenshot extracted from a session recording at a paint event timestamp. |
| **Recording** | The 60fps WebM video of a load session (full page load from blank to window-load). |

---

## Webview Event Types

Events emitted by the injected observer. Categories align with the event panel filters.

### Navigation
- `navigation-start`, `nav-response-start`, `nav-response-end`, `nav-fetch-start`
- `spa-navigate`, `navigation-error`

### DOM
- `dom-ready`, `mutation-nodes`, `mutation-text`, `text-settled`

### Paint (significant milestones)
- `first-paint` — first pixels rendered
- `first-contentful-paint` — first text or image content
- `lcp` — largest contentful paint
- `above-fold-images-loaded` — all viewport images loaded
- `text-settled` — text content has stabilized

### Resource
- `resource-start`, `resource-complete`, `resource-script`, `resource-css`, `resource-img`, `resource-fetch`, `resource-media`, `resource-error`

### Load
- `window-load`, `progress-update`, `progress-complete`

---

## Event Object Shape

Each webview event has:

| Field | Type | Description |
|-------|------|-------------|
| `type` | string | Event type (e.g. `first-paint`) |
| `time` | number | Page-relative timestamp (ms, from `performance.now()`) |
| `delta` | number | Time since previous event (ms) |
| `data` | object | Type-specific payload |
| `videoTimeMs` | number | Wall-clock offset from recording start; aligns with video seek position (capture only) |

---

## File Layout

```
captures/                    # Captures directory (configurable via --video-dir)
  <hostname>/                 # Session directory (one per URL)
    video.mp4                 # Recording
    <event-type>-<ms>ms.png   # Paint frames (e.g. first-paint-1022ms.png)
events-capture.json           # Capture manifest
```

---

## Throttle Profiles

Network simulation profiles applied by the proxy:

| Profile | Latency | Bandwidth |
|---------|---------|-----------|
| `none` | 0ms | Unlimited |
| `fast-wifi` | 10ms | 40 Mbps |
| `4g` | 50ms | 10 Mbps |
| `slow-4g` | 100ms | 4 Mbps |
| `3g` | 200ms | 1.5 Mbps |
| `slow-3g` | 400ms | 400 Kbps |

---

## Prototype Pages

| Page | File | Description |
|------|------|-------------|
| **Compare page** | `index.html` | Side-by-side browser previews (DDG v1 vs DDG v2) for comparing progress bar implementations. |
| **Component page** | `browser-preview.html` | Isolated view of a single progress bar with detailed parameter controls for fine-tuning styles. |

---

## Related Terms

| Term | Definition |
|------|-------------|
| **Observer** | `injected-observer.js` — script injected into proxied pages to capture and post webview events. |
| **Proxy** | The Express server that fetches pages, injects the observer, and applies throttle profiles. |
| **Webview** | The simulated Android browser viewport (390px) where pages load in the prototype UI. |
| **Progress bar** | The thin loading indicator driven by weighted webview events. |
