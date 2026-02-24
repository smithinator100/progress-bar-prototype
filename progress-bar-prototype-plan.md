# Progress Bar Prototype — Build Plan

## Overview

A split-panel browser mockup for testing experimental loading progress bar concepts against real page loads. The left panel simulates a mobile browser viewport with a live progress bar under test. The right panel streams every captured event in real time, giving full visibility into what data signals are driving the animation.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  URL input ________________________________  Speed [Dropdown] ▼ │
├──────────────────────────────┬──────────────────────────────────┤
│                              │                                  │
│     BROWSER MOCKUP           │       EVENT STREAM               │
│                              │                                  │
│  ┌────────────────────────┐  │  ● navigation-start      0ms    │
│  │ ← address bar         │  │  ● mutation (+12 nodes)  120ms  │
│  ├────────────────────────┤  │  ● resource img          145ms  │
│  │ [progress bar]         │  │  ● first-paint           210ms  │
│  ├────────────────────────┤  │  ● mutation (+8 nodes)   280ms  │
│  │                        │  │  ● resource script       310ms  │
│  │     iframe / page      │  │  ● fcp                   390ms  │
│  │                        │  │  ● dom-ready             540ms  │
│  │                        │  │  ● resource img          620ms  │
│  │                        │  │  ● lcp                   780ms  │
│  └────────────────────────┘  │  ● window-load           1240ms │
│                              │                                  │
└──────────────────────────────┴──────────────────────────────────┘
```

---

## Tech Stack

| Layer | Choice | Reason |
|---|---|---|
| Frontend | Vanilla HTML/CSS/JS | No build step, fully portable, easy to share |
| Proxy server | Node.js + Express | Strips CORS headers, injects observer script into responses |
| Script injection | `express-http-proxy` + string replace on `<head>` | Inserts the event capture script before any page JS runs |
| Throttling | `tc` / proxy delay middleware | Simulates network conditions server-side |

---

## File Structure

```
/prototype
  index.html              ← main harness UI
  style.css               ← layout, browser chrome mockup, event panel
  progress-bar.js         ← progress bar component (the thing under test)
  event-bus.js            ← normalises all events into a standard shape
  event-panel.js          ← renders the right-hand event stream
  injected-observer.js    ← script injected into proxied pages to capture events
  server.js               ← Node proxy server
  package.json
```

---

## Component Breakdown

### 1. Control Bar
- **URL input** — text field, submits on Enter or a Go button
- **Speed dropdown** — see throttle options below
- **Clear button** — resets event panel and progress bar state

### 2. Browser Mockup (left panel)
- Static browser chrome: back/forward buttons, address bar showing current URL
- Address bar updates as the page loads (reflecting redirects)
- **Progress bar sits below the address bar** — this is the component under test
- `<iframe>` below the chrome loads the proxied URL
- Mobile viewport dimensions (390px wide) to match Android context

### 3. Progress Bar Component
- Isolated JS class, receives events from `event-bus.js`
- Exposes a simple API: `start()`, `update(value, eventType)`, `complete()`, `reset()`
- Designed to be swappable — the pipeline/bulge concept and a standard bar can both implement the same interface
- Internally manages its own animation state, does not block on event timing

### 4. Event Panel (right panel)
- Scrollable live feed, newest events at the top
- Each event row shows:
  - Coloured dot by event category (see categories below)
  - Event name
  - Timestamp relative to navigation start (ms)
  - Delta from previous event (ms) — shows gaps and bursts clearly
  - Key data payload (node count, resource type, transfer size)
- Collapsible by event category
- A mini sparkline or bar at the top showing event density over time

### 5. Proxy Server (`server.js`)
- Receives URL from the harness
- Fetches the real page server-side to avoid CORS issues
- Injects `injected-observer.js` into `<head>` before returning HTML to the iframe
- Applies network throttling via configurable delay middleware
- Rewrites relative URLs and asset paths to route through proxy (so sub-resources load)

---

## Event Categories & Colours

| Category | Colour | Events |
|---|---|---|
| **Navigation** | Blue | `navigation-start`, `spa-navigate`, `redirect` |
| **DOM / Text** | Green | `mutation-text`, `mutation-nodes`, `dom-ready` |
| **Paint** | Purple | `first-paint`, `first-contentful-paint`, `lcp` |
| **Resources** | Orange | `resource-img`, `resource-script`, `resource-css`, `resource-fetch` |
| **Load** | Teal | `window-load` |
| **Error** | Red | `resource-error`, `navigation-error` |

---

## Events Captured

### In `injected-observer.js` (runs inside the iframe)

```
navigation-start        performance.timing.navigationStart
dom-ready               DOMContentLoaded
window-load             window load event
first-paint             PerformanceObserver paint entries
first-contentful-paint  PerformanceObserver paint entries
lcp                     PerformanceObserver largest-contentful-paint
mutation-nodes          MutationObserver — all added nodes count
mutation-text           MutationObserver — text/heading nodes specifically
resource                PerformanceObserver resource entries (type, size, duration)
spa-navigate            history.pushState intercept + popstate
```

### In `index.html` harness (iframe lifecycle)

```
iframe-load-start       iframe src set
iframe-load-end         iframe load event fires
```

---

## Speed Throttle Options

| Label | Latency | Bandwidth | Use case |
|---|---|---|---|
| No throttle | 0ms | Unlimited | Baseline |
| Fast WiFi | 10ms | 40 Mbps | Good connection |
| Average 4G | 50ms | 10 Mbps | Typical mobile |
| Slow 4G | 100ms | 4 Mbps | Weak signal |
| 3G | 200ms | 1.5 Mbps | Travelling / rural |
| Slow 3G | 400ms | 400 Kbps | Edge case stress test |

Throttling is applied at the proxy layer as a delay on each response, with bandwidth simulation via chunked response streaming.

---

## Event Bus Shape

All events are normalised to a common structure before reaching both the progress bar and the event panel:

```javascript
{
  type: 'mutation-text',      // event category + name
  time: 284,                  // ms since navigation start
  delta: 42,                  // ms since last event
  weight: 0.6,                // 0–1, significance for progress calculation
  data: {                     // event-specific payload
    nodesAdded: 8,
    textNodes: 3
  }
}
```

The `weight` field is what lets the progress bar treat a text mutation as more significant than a background image resource loading.

---

## Progress Bar Interface

Both the standard bar and the experimental pipeline/bulge concept implement this:

```javascript
class ProgressBar {
  start()                     // navigation began
  update(event)               // receives normalised event bus event
  complete()                  // window load fired
  reset()                     // new navigation starting
  error()                     // navigation failed
}
```

This means multiple progress bar implementations can be dropped in and compared against the same real event stream.

---

## Build Phases

### Phase 1 — Skeleton (day 1)
- Static layout: split panel, browser chrome mockup, placeholder iframe
- URL input and Go button wired to iframe src
- Basic event panel rendering hardcoded test events

### Phase 2 — Event capture (day 2)
- `injected-observer.js` capturing all events and posting to parent via `window.postMessage`
- `event-bus.js` receiving and normalising messages
- Event panel rendering live events from a real page load (no throttling yet)

### Phase 3 — Progress bar (day 3)
- Standard thin progress bar driven by event bus
- Verify the event weighting feels right against real pages
- Test a few different site types: news article, image gallery, SPA

### Phase 4 — Proxy + throttling (day 4)
- Node proxy server running locally
- Throttle dropdown wired up
- Test slow 3G loads to see how the event stream behaves under stress

### Phase 5 — Pipeline experiment (day 5+)
- Implement the bulge/pipeline progress bar as a second `ProgressBar` implementation
- A/B toggle to switch between standard and experimental
- Refine based on what the event stream actually looks like on real pages

---

## Open Questions to Resolve During Build

- **Cross-origin iframe restrictions** — even with a proxy, some sites use frame-busting scripts. A list of test URLs known to be iframe-friendly should be established early.
- **Script injection reliability** — some pages use CSP headers that block injected scripts. The proxy will need to strip `Content-Security-Policy` headers.
- **MutationObserver noise** — on JS-heavy pages mutations may fire hundreds of times a second. A debounce or batching strategy will be needed to keep the event panel readable.
- **Weight calibration** — the `weight` values on events are initial guesses. Real page testing will reveal if text mutations genuinely feel more progress-significant than resource loads or if the distinction is less clear in practice.
