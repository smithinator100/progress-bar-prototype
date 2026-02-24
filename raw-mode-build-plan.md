# Raw Mode — Build Plan

## What Raw Mode Is

Raw mode replicates exactly what DDG's Android browser currently does with no additions, no logic layer, and no polish. It is the baseline that all other modes will be compared against.

DDG's implementation in `BrowserChromeClient.kt` is three lines of meaningful code:

```kotlin
override fun onProgressChanged(webView: WebView, newProgress: Int) {
    // Use webView.progress, not newProgress, to get overall progress
    // across redirect chains rather than per-request progress
    webViewClientListener?.progressChanged(webView.progress, ...)
}
```

That integer — `webView.progress` — is rendered directly to the progress bar. No smoothing, no easing, no animation, no stall fallback, no fade in, no fade out. The bar jumps to whatever value arrives and freezes until the next value arrives.

---

## The 50% Jump — What It Is and Why It Happens

This is the most recognisable visual artefact of raw WebView progress and the primary reason the bar feels broken rather than informative.

WebView's internal progress calculation is heavily weighted toward the main document. The moment the main HTML document response begins streaming — the first bytes of HTML arrive from the server — WebView internally considers roughly **half the work done** and emits a progress value in the **40–60% range** almost immediately.

The sequence looks like this in practice:

```
0ms    → navigation starts        → 0%
~50ms  → DNS resolved, TCP open   → 0%   (no callback yet)
~200ms → first bytes of HTML      → 47%  ← the jump
~800ms → HTML fully received      → 55%
~1200ms → CSS parsed              → 62%
~2000ms → images loading          → 71%
~3500ms → images complete         → 88%
~4000ms → window.load             → 100%
```

The bar shows nothing, then suddenly appears more than halfway complete before the user sees any content. This creates two perceptual problems: the early phase feels dead (nothing happening), and the jump feels dishonest (too much progress claimed too early). Both need to be visible in the prototype's event panel so the difference between raw mode and improved modes can be clearly seen.

**Why `webView.progress` instead of `newProgress`**

DDG deliberately uses `webView.progress` (the property on the WebView object) rather than the `newProgress` parameter passed into `onProgressChanged`. The parameter reflects progress of the current individual request, which resets to 0 on each redirect. The property reflects accumulated progress across the entire navigation including all redirects. For a page with two redirects, `newProgress` would count to 100 three times; `webView.progress` counts to 100 once. DDG's choice is correct — but the prototype needs to simulate this cross-redirect accumulation behaviour.

---

## Events to Capture in the Prototype

Raw mode uses only what DDG currently uses. That means a single input signal reproduced in the browser environment.

### The One Signal: Simulated `webView.progress`

In a browser there is no direct equivalent to `webView.progress`. It must be constructed from available APIs to produce the same characteristic shape — specifically the early 40–60% jump followed by a slow crawl.

**Construction method:**

```javascript
function calculateWebViewProgress(state) {
  // WebView weights main document at ~50% of total progress.
  // Subresources share the remaining 50%.

  const MAIN_DOC_WEIGHT = 0.50
  const SUBRESOURCE_WEIGHT = 0.50

  // Main document phase: 0% → 50%
  // Triggered by navigation timing — starts at fetchStart, 
  // completes at responseEnd for the document itself
  const navEntry = performance.getEntriesByType('navigation')[0]
  let mainDocProgress = 0
  if (navEntry) {
    const docDuration = navEntry.responseEnd - navEntry.fetchStart
    const elapsed = performance.now() - navEntry.fetchStart
    mainDocProgress = Math.min(elapsed / docDuration, 1.0)
  }

  // Subresource phase: 0% → 50% of remaining
  // Ratio of completed resources to total discovered resources
  const totalResources = state.resourcesDiscovered
  const completedResources = state.resourcesCompleted
  const subresourceProgress = totalResources > 0
    ? completedResources / totalResources
    : 0

  // Combine — matches WebView's approximate internal weighting
  const rawProgress = (
    (mainDocProgress * MAIN_DOC_WEIGHT) +
    (subresourceProgress * SUBRESOURCE_WEIGHT)
  ) * 100

  return Math.round(rawProgress)
}
```

**The key artefact this produces:**

When `responseEnd` arrives for the main document, `mainDocProgress` jumps to 1.0, contributing the full 50% from the main document weight. Subresource progress adds on top of that as images and scripts complete. This replicates the characteristic jump.

---

## Events to Wire Up

Even though DDG only uses one input, the prototype needs to track several underlying browser events to construct it accurately and to show them in the event panel for comparison.

### Navigation Timing (main document phase)

```javascript
// Fired when the iframe navigation begins
// Analog: onPageStarted
window.addEventListener('load', () => {
  const nav = performance.getEntriesByType('navigation')[0]
  eventBus.emit({
    type: 'nav-fetch-start',
    time: nav.fetchStart,
    value: 0
  })
  eventBus.emit({
    type: 'nav-response-start',   // first byte received — triggers the jump
    time: nav.responseStart,
    value: null   // progress calculated at read time, not emission time
  })
  eventBus.emit({
    type: 'nav-response-end',     // main document fully received
    time: nav.responseEnd,
    value: null
  })
})
```

### Resource Timing (subresource phase)

```javascript
// Each resource discovered and completed
// Analog: onLoadResource (start) and resource completion
const resourceObserver = new PerformanceObserver((list) => {
  list.getEntries().forEach(entry => {
    state.resourcesDiscovered++
    eventBus.emit({
      type: 'resource-start',
      time: entry.startTime,
      resourceType: entry.initiatorType,  // 'img', 'script', 'css', 'fetch'
      name: entry.name
    })

    // completion fires when responseEnd is reached
    eventBus.emit({
      type: 'resource-complete',
      time: entry.responseEnd,
      resourceType: entry.initiatorType,
      transferSize: entry.transferSize,
      duration: entry.duration
    })
    state.resourcesCompleted++
  })
})
resourceObserver.observe({ entryTypes: ['resource'] })
```

### Load Completion

```javascript
// Analog: onPageFinished — bar jumps to 100 and disappears
window.addEventListener('load', () => {
  eventBus.emit({
    type: 'window-load',
    time: performance.now()
  })
})
```

### Redirect Detection

```javascript
// Analog: DDG's use of webView.progress spanning redirect chains
// Capture redirect count from navigation timing
window.addEventListener('load', () => {
  const nav = performance.getEntriesByType('navigation')[0]
  if (nav.redirectCount > 0) {
    eventBus.emit({
      type: 'redirect-chain',
      time: nav.fetchStart,
      count: nav.redirectCount,
      totalRedirectTime: nav.redirectEnd - nav.redirectStart
    })
  }
})
```

---

## Progress Calculation Loop

Raw mode drives the progress bar from a polling loop, recalculating on every animation frame. No smoothing — whatever the formula returns is what renders.

```javascript
class RawModeProgressBar {

  constructor(barElement) {
    this.bar = barElement
    this.state = {
      resourcesDiscovered: 0,
      resourcesCompleted: 0,
      isLoading: false,
      lastEmittedValue: 0
    }
  }

  start() {
    // Bar appears instantly with no animation — DDG behaviour
    this.state.isLoading = true
    this.bar.style.display = 'block'
    this.bar.style.opacity = '1'     // no fade in
    this.bar.style.width = '0%'
    this.tick()
  }

  tick() {
    if (!this.state.isLoading) return

    const progress = calculateWebViewProgress(this.state)

    // Raw: set width directly, no transition, no easing
    this.bar.style.transition = 'none'
    this.bar.style.width = progress + '%'

    // Log to event panel every time value changes
    if (progress !== this.state.lastEmittedValue) {
      eventBus.emit({
        type: 'progress-update',
        value: progress,
        delta: progress - this.state.lastEmittedValue,
        time: performance.now()
      })
      this.state.lastEmittedValue = progress
    }

    requestAnimationFrame(() => this.tick())
  }

  complete() {
    // Jump to 100 instantly — DDG behaviour
    this.bar.style.width = '100%'
    // Disappear instantly — DDG behaviour (no fade out)
    this.bar.style.display = 'none'
    this.state.isLoading = false

    eventBus.emit({
      type: 'progress-complete',
      time: performance.now()
    })
  }

  reset() {
    this.state.resourcesDiscovered = 0
    this.state.resourcesCompleted = 0
    this.state.lastEmittedValue = 0
    this.bar.style.width = '0%'
    this.bar.style.display = 'none'
  }
}
```

---

## What the Event Panel Should Show in Raw Mode

The event panel should surface every underlying signal so the gap between raw behaviour and perceived reality is visible. Alongside the single progress value DDG uses, show the events that DDG ignores entirely.

| Event | Colour | Shows in raw mode? | Notes |
|---|---|---|---|
| `nav-fetch-start` | Blue | ✓ | Navigation begins — bar should appear here but doesn't until first progress callback |
| `nav-response-start` | Blue | ✓ | First byte received — triggers the 50% jump |
| `nav-response-end` | Blue | ✓ | Main document fully received |
| `redirect-chain` | Blue | ✓ | Shows if any redirects occurred |
| `progress-update` | Grey | ✓ | Every raw value emitted, with delta from previous |
| `resource-start` | Orange | ✓ | Each sub-resource begins loading |
| `resource-complete` | Orange | ✓ | Each sub-resource finishes |
| `window-load` | Teal | ✓ | Bar disappears here |
| `first-paint` | Purple | ✗ | Captured but not used by raw mode — show greyed out |
| `first-contentful-paint` | Purple | ✗ | Captured but not used — show greyed out |
| `lcp` | Purple | ✗ | Captured but not used — show greyed out |
| `dom-ready` | Green | ✗ | Captured but not used — show greyed out |

The greyed-out events are important. They show what the user experienced visually (FCP, LCP, text appearing) relative to where the raw progress bar was at those moments. This is what makes the problem legible — you can see "the user was reading content at 38% progress, but the bar was already showing 55% from the main document jump."

---

## State Machine

Raw mode has three states. Each transition should be logged to the event panel.

```
IDLE
  │
  │ iframe src set / URL submitted
  ▼
LOADING ──────────────────────────────────────────────┐
  │                                                    │
  │ Progress polling loop running                      │ No stall
  │ Bar width = calculateWebViewProgress()             │ detection
  │ No minimum crawl                                   │ in raw mode
  │ Bar can freeze at any value                        │
  │                                                    │
  │ window.load fires                                  │
  ▼                                                    │
COMPLETE ◄───────────────────────────────────────────┘
  │
  │ Bar instantly hidden
  │ State reset for next navigation
  ▼
IDLE
```

Note: there is **no STALLED state** in raw mode. This is intentional and is one of the deficiencies raw mode is meant to expose. If the server is slow to respond, the bar sits at 0% or a low value indefinitely with no feedback. The event panel should make this visible by showing elapsed time since the last progress update.

---

## Acceptance Criteria for Raw Mode

Raw mode is correctly implemented when all of the following are true:

- Bar appears with no animation (instant show at 0%)
- First meaningful progress value is in the 40–60% range for a typical page, fired shortly after first bytes of HTML arrive
- Bar width updates are set with `transition: none` — there is no animation between values
- Bar can freeze at a value for multiple seconds with no movement (visible on slow connections)
- Bar jumps directly to 100% at `window.load` with no intermediate fill
- Bar disappears instantly at 100% with no fade
- The event panel shows the 50% jump as a large positive delta on the `progress-update` row at approximately the same time as `nav-response-start`
- FCP and LCP events in the event panel are visible and timestamped relative to progress values, showing where real user-perceived readiness sits on the raw progress curve

---

## Known Limitations of Raw Mode (document these in the UI)

Add a small info panel below the progress bar in raw mode that displays these notes, so the deficiencies are self-documenting during review:

- **No animation** — progress values are applied directly with no easing or interpolation
- **50% jump** — WebView weights the main document at ~50%, causing a large early jump before content is visible
- **Freezes on slow loads** — no minimum crawl rate; bar stalls until next WebView callback
- **No stall detection** — if the server stops responding, the bar shows no feedback
- **Abrupt show/hide** — bar appears and disappears with no transition
- **Single signal** — only `onProgressChanged` / `webView.progress` is used; paint events, DOM events, and resource events are available but ignored
