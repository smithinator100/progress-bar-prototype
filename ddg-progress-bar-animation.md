# DDG Android Progress Bar — Animation Behaviour

## Overview

DDG's progress bar has two layers: a visibility threshold that controls when the bar is shown, and a `SmoothProgressAnimator` that controls how it moves once visible.

---

## Layer 1 — Visibility Threshold (~50%)

The bar is hidden until `webView.progress` reaches approximately **50%**. Below that value, no bar is rendered regardless of how many `onProgressChanged` callbacks have fired.

This means:
- The bar never animates from zero — it materialises already partway across the screen
- There is a dead period at the start of every load with no visual feedback
- On fast connections the bar may appear at ~50% and complete almost immediately, resulting in a flash of a bar that was already nearly done

**CSS equivalent:**
```css
.progress-bar {
  display: none; /* until threshold */
}
.progress-bar.visible {
  display: block;
  opacity: 1; /* no fade in */
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
// On each new progress value from webView.progress
function updateBar(progress) {
  const THRESHOLD = 50

  if (progress < THRESHOLD) {
    // Hide — do nothing visually
    bar.style.display = 'none'
    return
  }

  // First appearance — no fade in, just show
  if (bar.style.display === 'none') {
    bar.style.display = 'block'
  }

  // Animate to new value with symmetric ease-in-out
  bar.style.transition = 'width 200ms ease-in-out'
  bar.style.width = progress + '%'
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
| Shows from 0% | ✗ Hidden until ~50% | ✓ Immediately |
| Fade in | ✗ Instant appear | ✓ 150ms fade |
| Animation curve | Symmetric ease-in-out | Fast-start, decelerate |
| Stall fallback | ✗ Bar freezes | ✓ Shimmer after 5s |
| Minimum crawl | ✗ Can freeze | ✓ Always creeps forward |
| Fade out | ✗ Instant disappear | ✓ 200ms fade |

---

## Prototype Implementation Notes

- The `~50%` threshold should be a named constant `VISIBILITY_THRESHOLD = 50` so it can be tuned during testing
- The `200ms ease-in-out` duration is an estimate — the actual value in `SmoothProgressAnimator.kt` should be confirmed and matched exactly
- Progress values below the threshold should still appear in the event panel as greyed-out rows, so the dead period is visible and measurable
- The bar should never animate from 0 when it first appears — it should snap to the current progress value and then ease from there on subsequent updates
