# DDG Android Progress Bar — Animation Behaviour

## Overview

DDG's progress bar has two layers: a `FIXED_PROGRESS` clamp that ensures the bar always appears at least 50% wide, and a `SmoothProgressAnimator` that controls how it moves once visible.

---

## Layer 1 — Show + FIXED_PROGRESS Clamp (50%)

The bar is shown on the **first `onProgressChanged` callback** from WebView where `webView.progress > 0`. Calls where `webView.progress == 0` are dropped.

When the bar appears, any raw progress value below 50% is clamped to 50% (`FIXED_PROGRESS`). This means:
- The bar is shown immediately when loading begins — there is no dead period
- On its first appearance, the bar animates from 0% to 50% straightaway, giving instant visual feedback
- All subsequent progress values below 50% are also clamped, so the bar never looks nearly empty

**CSS equivalent:**
```css
.progress-bar {
  display: none; /* until first onProgressChanged > 0 */
}
.progress-bar.visible {
  display: block;
  opacity: 1; /* no fade in */
  min-width: 50%; /* FIXED_PROGRESS clamp */
}
```

---

## Layer 2 — SmoothProgressAnimator

Once visible, transitions between progress values are animated using `AccelerateDecelerateInterpolator` — a **symmetric ease-in/ease-out** curve. The bar accelerates into each move and decelerates equally out of it.

This is not Chrome's `ProgressAnimationFastStart` curve (which favours fast early movement). DDG's curve is symmetric, meaning it does not create the fast-start feel that makes Chrome's bar feel immediately responsive.

**CSS equivalent:**
```css
.progress-bar {
  transition: width 200ms ease-in-out;
}
```

**JavaScript equivalent for the prototype:**
```javascript
const FIXED_PROGRESS = 50

function updateBar(progress) {
  if (progress <= 0) return

  // Show the bar on first callback with progress > 0
  if (bar.style.display === 'none') {
    bar.style.display = 'block'
  }

  // Clamp to FIXED_PROGRESS minimum
  const visual = Math.max(progress, FIXED_PROGRESS)

  // Animate to new value with symmetric ease-in-out
  bar.style.transition = 'width 200ms ease-in-out'
  bar.style.width = visual + '%'
}
```

---

## Layer 3 — Completion

When `window.load` fires (equivalent of `onPageFinished`):
- Bar disappears **instantly** — no animation to 100%, no fade out
- `display: none` is set directly

```javascript
function completeBar() {
  bar.style.transition = 'none'
  bar.style.display = 'none'
}
```

---

## What's Missing vs Chrome

| Behaviour | DDG | Chrome |
|---|---|---|
| Shows from 0% | ✓ On first progress > 0 (clamped to 50%) | ✓ Immediately |
| Fade in | ✗ Instant appear | ✓ 150ms fade |
| Animation curve | Symmetric ease-in-out | Fast-start, decelerate |
| Stall fallback | ✗ Bar freezes | ✓ Shimmer after 5s |
| Minimum crawl | ✗ Can freeze | ✓ Always creeps forward |
| Fade out | ✗ Instant disappear | ✓ 200ms fade |

---

## Prototype Implementation Notes

- The `FIXED_PROGRESS = 50` clamp should be a named constant so it can be tuned during testing
- The `200ms ease-in-out` duration is an estimate — the actual value in `SmoothProgressAnimator.kt` should be confirmed and matched exactly
- When the bar first appears it should animate from 0% to 50% (or to the current progress if already above 50%), giving immediate visual feedback
