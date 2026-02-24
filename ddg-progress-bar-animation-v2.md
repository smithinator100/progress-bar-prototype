# DDG Progress Bar — Current Implementation
DuckDuckGo Android Browser · February 2026

---

## How the Progress Bar Works

The current DDG Android browser renders loading progress using a chain that starts with Android's WebView callbacks and ends with an ObjectAnimator driving a standard horizontal ProgressBar. The bar is entirely self-contained within the `progressChanged()` path — no other WebView lifecycle callback participates in showing, updating, or dismissing it.

### Flow

```
WebView.onProgressChanged()
    ↓
BrowserChromeClient.onProgressChanged()    ← drops progress == 0
    ↓
BrowserTabViewModel.progressChanged()      ← applies FIXED_PROGRESS clamp
    ↓
LoadingViewState updated                   ← isLoading + visualProgress
    ↓
BrowserTabFragment.renderLoadingIndicator()
    ↓
Omnibar.renderLoadingViewState()
    ↓
OmnibarLayout.renderBrowserMode()
    ↓
SmoothProgressAnimator.onNewProgress()     ← ObjectAnimator
    ↓
ProgressBar.progress updated
```

### The UI Widget

Defined in `view_omnibar.xml` (lines 95–106). A standard `Widget.AppCompat.ProgressBar.Horizontal`, 2dp tall, pinned to the bottom of the omnibar, initially invisible. Fill colour comes from `loading_progress.xml` via `?daxColorAccentBlue`.

---

## Three Key Moments

### 1. When the progress bar is SHOWN

- **Trigger:** The first `onProgressChanged` callback from WebView where `webView.progress > 0`.
- BrowserChromeClient explicitly drops any call where `webView.progress == 0` (line 84). The first value that gets through flows to `BrowserTabViewModel.progressChanged()`, which sets `isLoading = true` (because `newProgress < 100`).
- That state flows into `loadingViewState`, which reaches `OmnibarLayout.renderBrowserMode()`. The bar becomes visible when `isLoading` is true.
- **The bar immediately jumps to at least 50% visually** — the `FIXED_PROGRESS` clamp means no value below 50 is ever animated to.

### 2. When the progress bar reaches 100%

- **Trigger:** `webView.progress` reaches 100, which causes `BrowserChromeClient.onProgressChanged()` to call `progressChanged(100)`.
- When `newProgress == 100` and `isProcessingTrackingLink == false`: `isLoading = false`, `visualProgress = 100`. This kicks off the final ObjectAnimator run to 100%.
- **Tracking link edge case:** If `isProcessingTrackingLink == true` when `newProgress == 100`, the visual progress is clamped back to 50 (not 100), and `isLoading` stays true. The bar never reaches 100% visually until that flag clears.

### 3. When the progress bar is DISMISSED

- **Trigger:** The ObjectAnimator animation completes (its `onEnd` callback fires), provided the `isLoading` snapshot captured at render time is false.
- The `viewState` captured in the `onEnd` lambda is a snapshot from the moment `renderBrowserMode` was called. Since `progressChanged(100)` produces `isLoading=false`, the lambda correctly calls `hide()` — but only after the animation finishes.
- **Animation duration:** 1500ms if progress was below 75% when the 100 arrived. 200ms if progress was at or above 75%.
- **No external event dismisses the bar.** `onPageFinished` does not participate. The sole gating condition is the animation's `onEnd` callback + `isLoading == false` in the snapshot.

---

## Event Definitions

### onProgressChanged
*Layer: Android OS → BrowserChromeClient*

The system callback Android fires repeatedly as a WebView loads a page. It receives a `newProgress` argument (the current main-frame request's progress), but the app ignores `newProgress` and instead reads `webView.progress` directly — because `webView.progress` reflects the overall composite progress across redirects, not just the current request. Any call where `webView.progress == 0` is silently dropped. Everything else is forwarded into `progressChanged()`.

### webView.progress
*Layer: Android WebView internal state*

An integer 0–100 representing the overall page load progress as Android synthesises it across all resource loads and redirects. It is not the same as the `newProgress` argument delivered to `onProgressChanged`. Using `webView.progress` instead is the deliberate design choice — it smooths over multi-redirect navigations where `newProgress` would reset to low values mid-load.

### progressChanged(100)
*Layer: BrowserTabViewModel*

The specific call that ends the loading state. When `webView.progress` hits 100 and `isProcessingTrackingLink == false`: `isLoading` is set to false, `visualProgress` is set to 100, and `loadingViewState` is updated and pushed to the UI. This is the single event that sets up bar dismissal. It also fires a `RefreshUserAgent` command and notifies `NavigationAwareLoginDetector` of `PageFinished`, but neither of those touches the progress bar.

### ObjectAnimator.onEnd
*Layer: SmoothProgressAnimator → OmnibarLayout*

The callback registered on the ObjectAnimator that drives the `ProgressBar.progress` property. It fires after the animation fully completes — 1500ms for progress below 75%, 200ms for progress ≥ 75% (including the final run to 100%). This is the only gate for bar dismissal. When it fires, it checks the `isLoading` value captured in the snapshot of ViewState at the time `renderBrowserMode` was last called. If `isLoading == false` in that snapshot, `pageLoadingIndicator.hide()` is called.

### isLoading
*Layer: LoadingViewState (ViewModel) → OmnibarLayoutViewModel.ViewState (UI)*

A boolean that answers: "should the progress bar be present on screen right now?" Computed in `BrowserTabViewModel.progressChanged()` as: `newProgress < 100 || isProcessingTrackingLink`. It becomes true on the first `onProgressChanged` call and becomes false only when `newProgress == 100` AND no tracking link is being processed. It is never set by `onPageStarted`, `onPageFinished`, or any other WebView lifecycle callback — only by `progressChanged()`.

### onPageFinished
*Layer: Android OS → BrowserWebViewClient*

The system callback Android fires when the WebView's main frame has finished loading. It is not connected to the progress bar in any way. In this codebase it triggers: JS plugin injection (only if `webView.progress == 100`), cookie flushing, print injector, internal tester verification, favicon prefetch, DuckAI mode evaluation, and SERP logo state. None of these touch `loadingViewState` or `isLoading`. It fires independently of and after `onProgressChanged(100)`.

### onPageStarted
*Layer: Android OS → BrowserWebViewClient*

The system callback Android fires when the WebView begins loading a new page. It is also not connected to the progress bar. In this codebase it: records the load start timestamp, increments the request counter, triggers `requestInterceptor`, injects autoconsent, detects ad domains, injects JS plugins, and calls `pageStarted()` on the ViewModel — which resets the privacy shield, fires and disables the browser/fire buttons, and posts a `Command.PageStarted` event. None of this touches `loadingViewState`. The progress bar show is driven by the first `onProgressChanged` call, not by `onPageStarted`.

---

## Smooth Animation

- `SmoothProgressAnimator.kt` drives motion via an ObjectAnimator on the `progress` property.
- **Progress < 75%:** 1500ms animation duration (`ANIM_DURATION_PROGRESS_LONG`)
- **Progress ≥ 75%:** 200ms animation duration (`ANIM_DURATION_PROGRESS_SHORT`)
- **Interpolator:** `AccelerateDecelerateInterpolator` (symmetric ease-in/ease-out). Switching to `DecelerateInterpolator` would feel perceptually faster.
- **Mid-animation update:** If a new progress value arrives mid-animation, the current animation is paused before the new one starts.
- **New page load:** If the new value is lower than the current animated value (i.e. a new page load began), the bar resets to 0 before animating forward.

---

## Key Constants

- `FIXED_PROGRESS = 50` — Minimum visual progress shown. The bar never appears below 50%.
- `SHOW_CONTENT_MIN_PROGRESS = 50` — Minimum progress to reveal web content after hiding it (spoofing protection).
- `MIN_PROGRESS_BAR = 75` — Threshold for switching from 1500ms to 200ms animation duration.
- `MAX_PROGRESS = 100` — Completion value.

---

## Key Problems

- **Symmetric interpolator:** `AccelerateDecelerateInterpolator` decelerates into the final value, making the tail of every animation feel sluggish — especially the final run to 100%.
- **1500ms tail on large jumps:** If progress jumps from below 75% straight to 100%, the animator uses the 1500ms duration for that entire run. The bar visibly crawls through the last stretch while the page is already loaded.
- **No indeterminate fallback:** If WebView stops reporting progress, the bar freezes. No shimmer or pulse animation fills the gap.
- **No early confidence:** Although the bar jumps to 50%, there's no animation before the first `onProgressChanged`. Users see nothing during the initial ~300–500ms after tapping a link.
- **50% clamp is blunt:** All progress below 50% is invisible to the user. Fast early progress looks the same as slow early progress.
