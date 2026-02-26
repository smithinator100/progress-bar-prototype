# Progress Bar Prototype

A split-panel browser mockup for testing experimental loading progress bar concepts against real page loads.

**Live demo:** [GitHub Pages](https://smithinator100.github.io/progress-bar-prototype/) — use the **Demo** button (proxy not available on static hosting).

## Quick Start

```bash
cd prototype
npm install
npm start
```

Then open http://localhost:3001 in your browser.

## Features

- **Browser Mockup**: Mobile viewport (390px) with realistic browser chrome
- **Progress Bar Testing**: Swap between standard and pipeline/bulge progress bar implementations
- **Event Stream**: Real-time visualization of all page load events
- **Network Throttling**: Simulate various network conditions (WiFi, 4G, 3G)
- **Event Weighting**: Progress based on content significance, not raw timing

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  URL input ________________________________  Speed [▼]      │
├──────────────────────────────┬──────────────────────────────┤
│     BROWSER MOCKUP           │       EVENT STREAM           │
│  ┌────────────────────────┐  │  ● navigation-start    0ms   │
│  │ ← address bar          │  │  ● mutation (+12)    120ms   │
│  ├────────────────────────┤  │  ● first-paint       210ms   │
│  │ [progress bar]         │  │  ● lcp               780ms   │
│  ├────────────────────────┤  │  ● window-load      1240ms   │
│  │     iframe / page      │  │                              │
│  └────────────────────────┘  │                              │
└──────────────────────────────┴──────────────────────────────┘
```

## Event Categories

| Category | Color | Events |
|----------|-------|--------|
| Navigation | Blue | `navigation-start`, `spa-navigate` |
| DOM | Green | `mutation-nodes`, `dom-ready` |
| Paint | Purple | `first-paint`, `first-contentful-paint`, `lcp` |
| Resources | Orange | `resource-img`, `resource-script`, `resource-css` |
| Load | Teal | `window-load` |
| Error | Red | `resource-error`, `navigation-error` |

## Throttle Profiles

| Profile | Latency | Bandwidth |
|---------|---------|-----------|
| No throttle | 0ms | Unlimited |
| Fast WiFi | 10ms | 40 Mbps |
| Average 4G | 50ms | 10 Mbps |
| Slow 4G | 100ms | 4 Mbps |
| 3G | 200ms | 1.5 Mbps |
| Slow 3G | 400ms | 400 Kbps |

## Test URLs

Some sites work better than others due to iframe restrictions:

- `https://example.com` - Simple, always works
- `https://en.wikipedia.org/wiki/Main_Page` - Good for text content
- `https://httpbin.org/html` - Simple HTML test page

## Progress Bar Implementations

### Standard
A thin progress bar that smoothly advances based on event weights.

### Pipeline/Bulge
An experimental design with animated "bulges" that flow through the bar, representing data packets being loaded. Bulge colors indicate event categories.

## How It Works

1. The proxy server fetches pages server-side to avoid CORS
2. Security headers (CSP, X-Frame-Options) are stripped
3. An observer script is injected to capture page load events
4. Events are posted to the parent frame via postMessage
5. The event bus normalizes events and assigns weights
6. Both the progress bar and event panel receive normalized events
