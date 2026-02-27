/**
 * DDG v2 Progress Bar
 * Spring-physics-driven progress bar that chases `progress-update` values
 * reported by the WebView, with fast-start, creep, stall shimmer, and
 * configurable completion behaviour.
 */

const V2_DEFAULTS = {
  visibilityEnabled: true,
  fastStartEnabled: true,
  smoothEnabled: false,
  completionEnabled: false,
  indeterminateEnabled: false,

  fastStartTarget: 30,
  fastStartDuration: 300,
  fastStartCurve: 'easeOut',

  springStiffness: 4.0,
  dampingRatio: 2.5,
  creepVelocity: 0.002,
  overshootClamp: true,

  earlyCompletionThreshold: 80,
  completionTrigger: 'onPageFinished',
  completionDelay: 0,
  snapVelocity: 3.0,
  fadeOutDuration: 200,

  stallTimeout: 5,
  shimmerSpeed: 1.5,

  barStartTrigger: 'onPageStarted',
  minDisplayPct: 0,
  fadeInDuration: 150,
};

const CURVE_FNS = {
  'linear': (t) => t,
  'easeOut': (t) => 1 - Math.pow(1 - t, 3),
  'easeOutQuad': (t) => 1 - (1 - t) * (1 - t),
  'easeOutCubic': (t) => 1 - Math.pow(1 - t, 3),
  'easeOutQuint': (t) => 1 - Math.pow(1 - t, 5),
  'easeInOutQuad': (t) => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2,
  'easeInOutCubic': (t) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2,
  'easeInOutQuint': (t) => t < 0.5 ? 16 * t * t * t * t * t : 1 - Math.pow(-2 * t + 2, 5) / 2,
  'logarithmic': (t) => Math.log(1 + t * 9) / Math.log(10),
};

class ProgressBar {
  /**
   * @param {HTMLElement} element
   * @param {Object} [config]
   */
  constructor(element, config = {}) {
    this.element = element;
    this.config = { ...V2_DEFAULTS, ...config };
    this.onCompleteCallback = config.onComplete || null;

    this.realProgress = 0;
    this.displayProgress = 0;
    this.velocity = 0;
    this.phase = 'idle';

    this.isLoading = false;
    this.isComplete = false;
    this.animationFrame = null;
    this.lastFrameTime = 0;

    this.fastStartStart = 0;
    this.stallTimer = null;
    this.completionDelayTimer = null;
    this.isShimmering = false;
    this.isIndeterminate = false;
  }

  /**
   * Reconfigure with new parameters (does not restart).
   */
  updateConfig(config) {
    this.config = { ...V2_DEFAULTS, ...config };
  }

  start() {
    this.reset();
    this.isLoading = true;
    this.element.classList.add('loading');
    this.element.classList.remove('complete', 'error');

    if (this.config.indeterminateEnabled) {
      this.startIndeterminate();
      return;
    }

    const fadeIn = this.config.visibilityEnabled ? this.config.fadeInDuration : 0;
    this.element.style.transition = fadeIn > 0 ? `opacity ${fadeIn}ms ease-out` : '';
    this.element.style.opacity = '1';
    this.element.style.width = '0%';

    if (this.config.fastStartEnabled) {
      this.phase = 'fast-start';
      this.fastStartStart = performance.now();
    } else {
      this.phase = 'tracking';
      this.velocity = 0;
    }

    this.startAnimation();
    this.resetStallTimer();
  }

  startIndeterminate() {
    this.isIndeterminate = true;
    this.clearStallTimer();
    this.clearShimmer();

    const fadeIn = this.config.visibilityEnabled ? this.config.fadeInDuration : 0;
    this.element.style.opacity = '1';

    const needsAnimation = this.displayProgress < 100;
    this.displayProgress = 100;
    this.realProgress = 100;

    if (needsAnimation) {
      const parts = ['width 300ms cubic-bezier(0.22, 1, 0.36, 1)'];
      if (fadeIn > 0) parts.push(`opacity ${fadeIn}ms ease-out`);
      this.element.style.transition = parts.join(', ');
      this.element.style.width = '100%';

      setTimeout(() => {
        if (!this.isIndeterminate) return;
        this.element.style.transition = '';
        this.element.classList.add('indeterminate');
        if (!this.element.classList.contains('banding')) {
          this.element.classList.add('banding');
        }
      }, 300);
    } else {
      this.element.style.transition = fadeIn > 0 ? `opacity ${fadeIn}ms ease-out` : '';
      this.element.style.width = '100%';
      this.element.classList.add('indeterminate');
      if (!this.element.classList.contains('banding')) {
        this.element.classList.add('banding');
      }
    }
  }

  /**
   * Feed a normalised event. Only `progress-update` events update
   * the real progress value; everything else is ignored so that
   * DDG v2 tracks the same signal as DDG v1.
   */
  update(event) {
    if (!this.isLoading || this.isComplete) return;
    if (this.isIndeterminate) return;
    if (event.type !== 'progress-update') return;

    const value = event.data?.value;
    const raw = typeof value === 'number' ? value : 0;
    const clamped = Math.max(this.config.minDisplayPct, Math.min(100, raw));

    if (clamped > this.realProgress) {
      this.realProgress = clamped;
    }

    this.clearShimmer();
    this.resetStallTimer();

    if (this.config.completionEnabled &&
        this.config.completionTrigger === 'onprogressChanged(100)' &&
        this.realProgress >= this.config.earlyCompletionThreshold &&
        this.phase !== 'completing') {
      this.scheduleCompletion();
    }
  }

  complete() {
    if (this.isComplete) return;
    this.triggerCompletion();
  }

  scheduleCompletion() {
    if (this.completionDelayTimer) return;
    const delay = this.config.completionTrigger === 'onprogressChanged(100)' ? (this.config.completionDelay || 0) : 0;
    if (delay > 0) {
      this.completionDelayTimer = setTimeout(() => {
        this.completionDelayTimer = null;
        this.triggerCompletion();
      }, delay);
    } else {
      this.triggerCompletion();
    }
  }

  triggerCompletion() {
    if (this.isComplete) return;
    this.clearCompletionDelayTimer();
    this.isComplete = true;
    this.isLoading = false;
    this.phase = 'completing';
    this.realProgress = 100;
    this.displayProgress = 100;
    this.clearStallTimer();
    this.clearShimmer();
    if (this.isIndeterminate) {
      this.element.classList.remove('indeterminate');
      this.isIndeterminate = false;
      this.startAnimation();
    }
  }

  error() {
    this.isLoading = false;
    this.clearCompletionDelayTimer();
    this.clearStallTimer();
    this.clearShimmer();
    this.element.classList.remove('loading');
    this.element.classList.add('error');
    this.element.style.width = '100%';

    setTimeout(() => {
      this.element.style.opacity = '0';
      setTimeout(() => this.reset(), 300);
    }, 2000);
  }

  showAt(percent) {
    this.stopAnimation();
    this.displayProgress = Math.min(100, Math.max(0, percent));
    this.realProgress = this.displayProgress;
    this.isLoading = false;
    this.isComplete = false;
    this.phase = 'idle';
    this.element.style.width = `${this.displayProgress}%`;
    this.element.style.opacity = '1';
    this.element.classList.remove('loading', 'complete', 'error');
  }

  reset() {
    this.stopAnimation();
    this.clearCompletionDelayTimer();
    this.clearStallTimer();
    this.clearShimmer();
    this.realProgress = 0;
    this.displayProgress = 0;
    this.velocity = 0;
    this.phase = 'idle';
    this.isLoading = false;
    this.isComplete = false;
    this.isIndeterminate = false;

    this.element.style.transition = '';
    this.element.style.width = '0%';
    this.element.style.opacity = '1';
    this.element.classList.remove('loading', 'complete', 'error', 'indeterminate');
  }

  setIndeterminate(enabled) {
    if (enabled === this.isIndeterminate) return;
    if (this.config.indeterminateEnabled !== enabled) {
      this.config.indeterminateEnabled = enabled;
    }
    if (enabled) {
      this.stopAnimation();
      this.clearStallTimer();
      this.clearShimmer();
      this.startIndeterminate();
    } else {
      this.element.classList.remove('indeterminate');
      this.isIndeterminate = false;
      if (this.isLoading && !this.isComplete) {
        this.displayProgress = this.realProgress;
        this.element.style.width = `${this.displayProgress}%`;
        if (this.config.fastStartEnabled) {
          this.phase = 'fast-start';
          this.fastStartStart = performance.now();
        } else {
          this.phase = 'tracking';
          this.velocity = 0;
        }
        this.startAnimation();
        this.resetStallTimer();
      } else {
        this.element.style.width = `${this.displayProgress}%`;
      }
    }
  }

  getProgress() {
    return this.displayProgress;
  }

  // ── Animation loop ──

  startAnimation() {
    if (this.animationFrame) return;
    this.lastFrameTime = performance.now();

    const animate = (now) => {
      const dt = Math.min((now - this.lastFrameTime) / 1000, 0.1);
      this.lastFrameTime = now;

      if (this.phase === 'fast-start') {
        this.tickFastStart(now);
      } else if (this.phase === 'tracking') {
        this.tickTracking(dt);
      } else if (this.phase === 'completing') {
        this.tickCompleting(dt);
        if (this.phase === 'done') {
          this.dismiss();
          return;
        }
      }

      this.element.style.width = `${this.displayProgress}%`;

      if (this.phase !== 'idle' && this.phase !== 'done') {
        this.animationFrame = requestAnimationFrame(animate);
      } else {
        this.animationFrame = null;
      }
    };

    this.animationFrame = requestAnimationFrame(animate);
  }

  tickFastStart(now) {
    const elapsed = now - this.fastStartStart;
    const duration = this.config.fastStartDuration;
    const t = Math.min(elapsed / duration, 1);
    const curveFn = CURVE_FNS[this.config.fastStartCurve] || CURVE_FNS['easeOut'];
    const eased = curveFn(t);

    const target = Math.max(this.config.fastStartTarget, this.config.minDisplayPct);
    this.displayProgress = eased * target;

    if (t >= 1) {
      this.displayProgress = target;
      this.phase = 'tracking';
      this.velocity = 0;
    }
  }

  tickTracking(dt) {
    const fastStartFloor = this.config.fastStartEnabled ? this.config.fastStartTarget : 0;
    const floor = Math.max(this.config.minDisplayPct, fastStartFloor);
    const target = Math.min(this.realProgress, 95);
    const effectiveTarget = Math.max(target, floor);

    if (this.config.smoothEnabled) {
      const { springStiffness, dampingRatio, overshootClamp, creepVelocity } = this.config;

      const displacement = effectiveTarget - this.displayProgress;
      const springForce = springStiffness * displacement;
      this.velocity = (this.velocity + springForce * dt) * Math.max(0, 1 - dampingRatio * dt);
      this.displayProgress += this.velocity * dt;

      if (overshootClamp && this.displayProgress > effectiveTarget) {
        this.displayProgress = effectiveTarget;
        this.velocity = 0;
      }

      if (this.displayProgress < 95 && Math.abs(this.velocity) < 0.5 && creepVelocity > 0) {
        this.displayProgress += creepVelocity * dt * 100;
      }
    } else {
      this.displayProgress = effectiveTarget;
    }

    this.displayProgress = Math.max(floor, Math.min(95, this.displayProgress));

    if (this.config.completionEnabled &&
        this.realProgress >= this.config.earlyCompletionThreshold &&
        this.config.completionTrigger === 'onprogressChanged(100)') {
      this.scheduleCompletion();
    }
  }

  tickCompleting(dt) {
    const { snapVelocity } = this.config;
    this.displayProgress += snapVelocity * dt * 100;

    if (this.displayProgress >= 100) {
      this.displayProgress = 100;
      this.phase = 'done';
    }
  }

  dismiss() {
    this.stopAnimation();
    this.element.style.width = '100%';

    const fadeOut = () => {
      this.element.classList.remove('loading');
      this.element.classList.add('complete');
      const fadeMs = this.config.visibilityEnabled ? this.config.fadeOutDuration : 0;
      this.element.style.transition = fadeMs > 0 ? `opacity ${fadeMs}ms ease-out` : '';
      this.element.style.opacity = '0';

      const afterFade = () => {
        this.element.style.transition = 'none';
        this.element.style.width = '0%';
        this.displayProgress = 0;
        void this.element.offsetWidth;
        this.element.style.transition = '';
        if (this.onCompleteCallback) {
          this.onCompleteCallback();
        } else {
          this.element.style.opacity = '1';
        }
      };

      if (this.config.fadeOutDuration > 0) {
        this.element.addEventListener('transitionend', afterFade, { once: true });
      } else {
        afterFade();
      }
    };

    fadeOut();
  }

  stopAnimation() {
    if (this.animationFrame) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
    }
  }

  // ── Stall detection ──

  resetStallTimer() {
    this.clearStallTimer();
    const timeoutMs = this.config.stallTimeout * 1000;
    this.stallTimer = setTimeout(() => {
      if (this.isLoading && !this.isComplete) {
        this.applyShimmer();
      }
    }, timeoutMs);
  }

  clearStallTimer() {
    if (this.stallTimer) {
      clearTimeout(this.stallTimer);
      this.stallTimer = null;
    }
  }

  clearCompletionDelayTimer() {
    if (this.completionDelayTimer) {
      clearTimeout(this.completionDelayTimer);
      this.completionDelayTimer = null;
    }
  }

  applyShimmer() {
    if (this.isShimmering) return;
    this.isShimmering = true;
    this.element.classList.add('shimmer');
    this.element.style.animationDuration = `${this.config.shimmerSpeed}s`;
  }

  clearShimmer() {
    if (!this.isShimmering) return;
    this.isShimmering = false;
    this.element.classList.remove('shimmer');
    this.element.style.animationDuration = '';
  }
}

if (typeof window !== 'undefined') {
  window.ProgressBar = ProgressBar;
}
