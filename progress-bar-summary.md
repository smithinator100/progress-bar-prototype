# Progress Bar — How It Works

- The progress bar taps into Android's WebView `onProgressChanged()` callback as a page loads, which feeds raw progress values up through the app's ViewModel layer before reaching the UI.

- Before any value hits the screen, it gets adjusted — if the raw progress is below 50%, it's clamped to 50% so the bar never looks nearly empty on slow-starting pages.

- The omnibar observes the resulting loading state and shows the bar whenever `isLoading` is true, hiding it only after the final animation to 100% completes.

- All motion is handled by `SmoothProgressAnimator`, which uses an `ObjectAnimator` with two speeds — a slower 1500ms animation below 75% progress, switching to a snappier 200ms above it.

- If a new page starts loading mid-animation, the bar resets to 0 and starts again.
