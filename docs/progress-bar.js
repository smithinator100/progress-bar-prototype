/**
 * Standard Progress Bar
 * A thin progress bar driven by weighted events.
 */
const FIXED_PROGRESS = 50;

class ProgressBar {
  constructor(element) {
    this.element = element;
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
   * Start the progress bar (first onProgressChanged where progress > 0)
   */
  start() {
    this.reset();
    this.isLoading = true;
    this.element.classList.add('loading');
    this.element.classList.remove('complete', 'error');
    
    this.targetProgress = FIXED_PROGRESS;
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
    
    // Clamp to FIXED_PROGRESS minimum
    newProgress = Math.max(newProgress, FIXED_PROGRESS);
    
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
   * Mark loading as complete (window load fired)
   */
  complete() {
    if (this.isComplete) return;
    this.isComplete = true;
    this.isLoading = false;
    this.targetProgress = 100;
    this.startAnimation();
    
    // Let animation finish, then apply complete styling
    setTimeout(() => {
      this.element.classList.remove('loading');
      this.element.classList.add('complete');
      
      // Fade out after a moment
      setTimeout(() => {
        this.element.style.opacity = '0';
        setTimeout(() => {
          this.element.style.transition = 'none';
          this.element.style.width = '0%';
          this.progress = 0;
          void this.element.offsetWidth; // force reflow to commit instant reset
          this.element.style.transition = '';
          this.element.style.opacity = '1';
        }, 300);
      }, 500);
    }, 200);
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
