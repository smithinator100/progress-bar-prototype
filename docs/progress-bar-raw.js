/**
 * Raw Mode Progress Bar (DDG Android Behaviour)
 *
 * Replicates Android's WebView + SmoothProgressAnimator:
 *  1. Bar is visible whenever isLoading is true (shows immediately on navigation)
 *  2. Raw progress below 50% is clamped TO 50%
 *  3. SmoothProgressAnimator uses two speeds based on CURRENT bar position:
 *     - 1500ms (ease-in-out) when current position < 75%
 *     - 200ms  (ease-in-out) when current position >= 75%
 *  4. On complete: animate to 100%, then hide after animation finishes
 *     (duration depends on current position per rule 3)
 *  5. New navigation: reset to 0 and start again
 *
 * Lifecycle events emitted via optional onEvent(type, data) callback:
 *
 *  'bar-shown'          — bar becomes visible, isLoading = true, first onProgressChanged
 *                         clamped to 50% and animation begins
 *  'progress-changed-100' — complete() called (window.load fired); isLoading set to false,
 *                           visualProgress = 100, final animation begins.
 *                           Analogous to Android's progressChanged(100).
 *  'animator-on-end'    — CSS transitionend fires after animation to 100% finishes.
 *                         Analogous to Android's ObjectAnimator.onEnd.
 *  'bar-dismissed'      — bar is actually hidden (opacity → 0, removed from view).
 *                         Separate from animator-on-end: only fires after onEnd confirms
 *                         isLoading == false in the snapshot, matching Android's
 *                         pageLoadingIndicator.hide() call.
 */
const PROGRESS_CLAMP_MIN = 50;
const SLOW_DURATION_MS = 1500;
const FAST_DURATION_MS = 200;
const SPEED_THRESHOLD = 75;

class RawModeProgressBar {
  /**
   * @param {HTMLElement} element
   * @param {Function} [onEvent] - Optional callback(type: string, data: object)
   *   called at each DDG lifecycle event.
   */
  constructor(element, onEvent) {
    this.element = element;
    this.onEvent = onEvent || null;
    this.isLoading = false;
    this.isComplete = false;
    // Snapshot of isLoading at the time complete() is called — mirrors the
    // ViewState snapshot captured by Android's renderBrowserMode lambda.
    this._isLoadingSnapshot = true;
  }

  _emit(type, data) {
    if (this.onEvent) {
      try { this.onEvent(type, data || {}); } catch (e) {}
    }
  }

  start() {
    this.reset();
    this.isLoading = true;
    this._isLoadingSnapshot = true;
    this.element.classList.add('loading');
    this.element.classList.remove('complete', 'error');

    // Bar appears at 0% and immediately begins animating to the clamped
    // minimum (50%). In Android, onProgressChanged(1) fires almost instantly
    // after navigation begins — the value is clamped to 50% and fed to
    // SmoothProgressAnimator, so the bar starts moving right away.
    this.element.style.transition = 'none';
    this.element.style.width = '0%';
    this.element.style.opacity = '1';
    void this.element.offsetWidth;

    this.element.style.transition = `width ${SLOW_DURATION_MS}ms ease-in-out`;
    this.element.style.width = PROGRESS_CLAMP_MIN + '%';

    // isLoading = true, bar visible, first value clamped to 50%
    this._emit('bar-shown', { isLoading: true, visualProgress: PROGRESS_CLAMP_MIN });
  }

  update(event) {
    if (!this.isLoading || this.isComplete) return;
    if (event.type !== 'progress-update') return;

    const value = event.data?.value;
    const raw = typeof value === 'number' ? value : 0;
    const clamped = Math.min(100, Math.max(PROGRESS_CLAMP_MIN, raw));

    // v2 doc: SmoothProgressAnimator selects duration based on the bar's
    // CURRENT position, not the target. When current < 75% the slow
    // 1500ms duration is used — even if the target is 100%. This is the
    // source of the "1500ms tail on large jumps" problem noted in the doc.
    const currentProgress = parseFloat(this.element.style.width) || 0;
    const duration = currentProgress < SPEED_THRESHOLD ? SLOW_DURATION_MS : FAST_DURATION_MS;

    this.element.style.transition = `width ${duration}ms ease-in-out`;
    this.element.style.width = clamped + '%';
  }

  complete() {
    if (this.isComplete) return;
    this.isComplete = true;
    this.isLoading = false;

    // Snapshot captured at render time — isLoading is now false.
    // Mirrors Android's ViewState snapshot in the renderBrowserMode lambda.
    this._isLoadingSnapshot = false;

    // progressChanged(100): isLoading = false, visualProgress = 100,
    // final ObjectAnimator run begins.
    this._emit('progress-changed-100', { isLoading: false, visualProgress: 100 });

    const currentWidth = parseFloat(this.element.style.width) || 0;
    const isLoadingSnapshot = this._isLoadingSnapshot;

    const onAnimationEnd = () => {
      // ObjectAnimator.onEnd — animation to 100% has fully completed.
      this._emit('animator-on-end', { isLoadingSnapshot });

      // Dismiss only if isLoading was false in the snapshot — matches
      // Android's onEnd gate: if (isLoading == false) pageLoadingIndicator.hide()
      if (!isLoadingSnapshot) {
        this.element.classList.remove('loading');
        this.element.classList.add('complete');
        this.element.style.transition = 'none';
        this.element.style.opacity = '0';
        this.element.style.width = '0%';

        this._emit('bar-dismissed', { isLoadingSnapshot });
      }
    };

    if (currentWidth >= 100) {
      onAnimationEnd();
    } else {
      // v2 doc section 3: "1500ms if progress was below 75% when the 100
      // arrived. 200ms if progress was at or above 75%."
      const finalDuration = currentWidth < SPEED_THRESHOLD ? SLOW_DURATION_MS : FAST_DURATION_MS;
      this.element.style.transition = `width ${finalDuration}ms ease-in-out`;
      this.element.style.width = '100%';
      this.element.addEventListener('transitionend', onAnimationEnd, { once: true });
    }
  }

  reset() {
    this.isLoading = false;
    this.isComplete = false;
    this._isLoadingSnapshot = true;

    this.element.style.transition = 'none';
    this.element.style.width = '0%';
    this.element.style.opacity = '0';
    this.element.classList.remove('loading', 'complete', 'error');
  }

  error() {
    this.isLoading = false;
    this.element.classList.remove('loading');
    this.element.classList.add('error');
    this.element.style.transition = 'none';
    this.element.style.opacity = '1';
    this.element.style.width = '100%';

    setTimeout(() => {
      this.element.style.opacity = '0';
      this.element.style.width = '0%';
      setTimeout(() => this.reset(), 0);
    }, 2000);
  }

  getProgress() {
    const width = this.element.style.width;
    if (!width) return 0;
    return parseFloat(width) || 0;
  }
}

if (typeof window !== 'undefined') {
  window.RawModeProgressBar = RawModeProgressBar;
}
