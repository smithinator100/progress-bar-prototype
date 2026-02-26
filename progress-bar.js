/**
 * Standard Progress Bar
 * A thin progress bar driven by weighted events.
 */
const DEFAULT_INITIAL_PROGRESS = 10;
const SLOW_DURATION_MS = 1500;
const FAST_DURATION_MS = 200;
const SPEED_THRESHOLD = 75;

class ProgressBar {
  /**
   * @param {HTMLElement} element
   * @param {Object} [options]
   * @param {Function} [options.getInitialProgress] - Returns 0-100, the percentage to animate to at start (same as DDG v1, but configurable)
   */
  constructor(element, options = {}) {
    this.element = element;
    this.getInitialProgress = options.getInitialProgress || (() => DEFAULT_INITIAL_PROGRESS);
    this.onCompleteCallback = options.onComplete || null;
    this.progress = 0;
    this.targetProgress = 0;
    this.isLoading = false;
    this.isComplete = false;
    this.animationFrame = null;
    
    // Progress tracking
    this.accumulatedWeight = 0;
    this.maxExpectedWeight = 2.0;
    
    // Animation settings
    this.smoothingFactor = 0.15;
    this.minIncrement = 0.5;
  }

  /**
   * Start the progress bar (first onProgressChanged where progress > 0).
   * Same as DDG v1: bar at 0%, then animates to the configured percentage.
   */
  start() {
    this.reset();
    this.isLoading = true;
    this.element.classList.add('loading');
    this.element.classList.remove('complete', 'error');
    
    const initialProgress = Math.min(100, Math.max(0, this.getInitialProgress()));
    this.targetProgress = initialProgress;
    this.progress = 0;
    
    // Bar visible at 0%, animates to target (same as DDG v1)
    this.element.style.opacity = '1';
    this.element.style.width = '0%';
    
    this.startAnimation();
  }

  /**
   * Update progress based on an event
   * @param {Object} event - Normalized event from event bus
   */
  update(event) {
    if (!this.isLoading || this.isComplete) return;
    
    const weight = event.weight || 0;
    this.accumulatedWeight += weight;
    
    // Calculate progress as percentage of expected total weight
    let newProgress = (this.accumulatedWeight / this.maxExpectedWeight) * 100;
    
    // Cap at 95% until complete - never reach 100% from events alone
    newProgress = Math.min(newProgress, 95);
    
    // Clamp to initial progress minimum (set at start)
    const minProgress = Math.min(100, Math.max(0, this.getInitialProgress()));
    newProgress = Math.max(newProgress, minProgress);
    
    // Only move forward
    if (newProgress > this.targetProgress) {
      this.targetProgress = newProgress;
    }
    
    // Dynamically adjust max expected weight if we're accumulating more than expected
    if (this.accumulatedWeight > this.maxExpectedWeight * 0.7) {
      this.maxExpectedWeight = this.accumulatedWeight * 1.5;
    }
  }

  /**
   * Mark loading as complete (window load fired).
   * Animates to 100%, then dismisses when the animation finishes.
   */
  complete() {
    if (this.isComplete) return;
    this.isComplete = true;
    this.isLoading = false;
    this.targetProgress = 100;
    this.stopAnimation();

    const currentWidth = parseFloat(this.element.style.width) || this.progress;

    const dismiss = () => {
      this.element.classList.remove('loading');
      this.element.classList.add('complete');
      this.element.style.transition = 'none';
      this.element.style.opacity = '0';
      this.element.style.width = '0%';
      this.progress = 0;
      void this.element.offsetWidth; // force reflow to commit instant reset
      this.element.style.transition = '';
      if (this.onCompleteCallback) {
        this.onCompleteCallback();
      } else {
        this.element.style.opacity = '1';
      }
    };

    if (currentWidth >= 100) {
      dismiss();
    } else {
      const duration = currentWidth < SPEED_THRESHOLD ? SLOW_DURATION_MS : FAST_DURATION_MS;
      this.element.style.transition = `width ${duration}ms ease-in-out`;
      this.element.style.width = '100%';
      this.element.addEventListener('transitionend', dismiss, { once: true });
    }
  }

  /**
   * Show bar at a specific percentage (no loading state).
   * Used for default/idle display.
   */
  showAt(percent) {
    this.stopAnimation();
    this.progress = Math.min(100, Math.max(0, percent));
    this.targetProgress = this.progress;
    this.isLoading = false;
    this.isComplete = false;
    this.element.style.width = `${this.progress}%`;
    this.element.style.opacity = '1';
    this.element.classList.remove('loading', 'complete', 'error');
  }

  /**
   * Start loading from a specific percentage (e.g. 50), animates to 100 on complete.
   */
  startFrom(percent) {
    this.reset();
    this.isLoading = true;
    this.element.classList.add('loading');
    this.element.classList.remove('complete', 'error');
    this.progress = Math.min(100, Math.max(0, percent));
    this.targetProgress = this.progress;
    this.element.style.opacity = '1';
    this.element.style.width = `${this.progress}%`;
    this.startAnimation();
  }

  /**
   * Reset to initial state
   */
  reset() {
    this.stopAnimation();
    this.progress = 0;
    this.targetProgress = 0;
    this.accumulatedWeight = 0;
    this.maxExpectedWeight = 2.0;
    this.isLoading = false;
    this.isComplete = false;
    
    this.element.style.width = '0%';
    this.element.style.opacity = '1';
    this.element.classList.remove('loading', 'complete', 'error');
  }

  /**
   * Handle navigation error
   */
  error() {
    this.isLoading = false;
    this.element.classList.remove('loading');
    this.element.classList.add('error');
    this.element.style.width = '100%';
    
    setTimeout(() => {
      this.element.style.opacity = '0';
      setTimeout(() => {
        this.reset();
      }, 300);
    }, 2000);
  }

  /**
   * Start the animation loop
   */
  startAnimation() {
    if (this.animationFrame) return;
    
    const animate = () => {
      const diff = this.targetProgress - this.progress;
      
      if (Math.abs(diff) > 0.1) {
        let increment = diff * this.smoothingFactor;
        
        if (this.isLoading && increment < this.minIncrement && diff > 0) {
          increment = Math.min(this.minIncrement, diff);
        }
        
        this.progress += increment;
        this.element.style.width = `${this.progress}%`;
      } else if (this.isComplete && this.progress !== this.targetProgress) {
        this.progress = this.targetProgress;
        this.element.style.width = `${this.progress}%`;
      }
      
      if (this.isLoading || Math.abs(this.targetProgress - this.progress) > 0.5) {
        this.animationFrame = requestAnimationFrame(animate);
      } else {
        this.animationFrame = null;
      }
    };
    
    this.animationFrame = requestAnimationFrame(animate);
  }

  /**
   * Stop the animation loop
   */
  stopAnimation() {
    if (this.animationFrame) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
    }
  }

  /**
   * Get current progress percentage
   * @returns {number} Progress 0-100
   */
  getProgress() {
    return this.progress;
  }
}

// Export for use in browser
if (typeof window !== 'undefined') {
  window.ProgressBar = ProgressBar;
}
