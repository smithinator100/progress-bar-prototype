/**
 * Experimental Progress Bar
 * Milestone-driven progress with variable-size bulges representing data importance.
 */
class ExperimentalProgressBar {
  constructor(element) {
    this.element = element;
    this.progress = 0;
    this.targetProgress = 0;
    this.isLoading = false;
    this.isComplete = false;
    this.animationFrame = null;

    this.bulges = [];
    this.maxBulges = 5;
    this.lastBulgeTime = 0;
    this.minBulgeInterval = 150;

    this.smoothingFactor = 0.12;
    this.bulgeSpeed = 0.02;

    this.milestones = {
      'nav-response-start':        { weight: 10, fired: false },
      'first-paint':               { weight: 15, fired: false },
      'dom-ready':                 { weight: 15, fired: false },
      'lcp':                       { weight: 20, fired: false },
      'text-settled':              { weight: 20, fired: false },
      'above-fold-images-loaded':  { weight: 20, fired: false },
    };
    this.totalMilestoneWeight = 100;

    this.creepCeiling = 0;
    this.recalcCreepCeiling();

    this.initializeElement();
  }

  initializeElement() {
    this.element.classList.add('experimental');
    this.element.style.width = '100%';
    this.element.innerHTML = '';

    this.track = document.createElement('div');
    this.track.className = 'experimental-track';
    this.track.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      height: 100%;
      width: 0%;
      background: var(--progress-fill, #4a9eff);
      transition: width 0.15s ease-out;
    `;
    this.element.appendChild(this.track);

    this.bulgeContainer = document.createElement('div');
    this.bulgeContainer.className = 'bulge-container';
    this.bulgeContainer.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      height: 100%;
      width: 100%;
      overflow: visible;
      pointer-events: none;
    `;
    this.element.appendChild(this.bulgeContainer);
  }

  start() {
    this.reset();
    this.isLoading = true;
    this.element.classList.add('loading');
    this.element.classList.remove('complete', 'error');

    this.targetProgress = 10;

    this.spawnBulge('#4a9eff', 0.15);
    this.startAnimation();
  }

  update(event) {
    if (!this.isLoading || this.isComplete) return;

    const milestone = this.milestones[event.type];
    if (milestone && !milestone.fired) {
      milestone.fired = true;
      this.recalcTargetFromMilestones();
      this.recalcCreepCeiling();

      const now = performance.now();
      this.spawnBulge(this.getEventColor(event), milestone.weight / this.totalMilestoneWeight);
      this.lastBulgeTime = now;

      if (this.allMilestonesFired()) {
        this.complete();
        return;
      }
    }

    const weight = event.weight || 0;
    if (weight > 0.05) {
      const now = performance.now();
      if (now - this.lastBulgeTime > this.minBulgeInterval) {
        this.spawnBulge(this.getEventColor(event), weight);
        this.lastBulgeTime = now;
      }
    }
  }

  recalcTargetFromMilestones() {
    let firedWeight = 0;
    for (const m of Object.values(this.milestones)) {
      if (m.fired) firedWeight += m.weight;
    }
    const milestoneProgress = 10 + (firedWeight / this.totalMilestoneWeight) * 90;
    if (milestoneProgress > this.targetProgress) {
      this.targetProgress = milestoneProgress;
    }
  }

  recalcCreepCeiling() {
    let firedWeight = 0;
    let nextUnfiredWeight = Infinity;

    for (const m of Object.values(this.milestones)) {
      if (m.fired) {
        firedWeight += m.weight;
      } else if (m.weight < nextUnfiredWeight) {
        nextUnfiredWeight = m.weight;
      }
    }

    if (nextUnfiredWeight === Infinity) {
      this.creepCeiling = 100;
    } else {
      const nextThreshold = 10 + ((firedWeight + nextUnfiredWeight) / this.totalMilestoneWeight) * 90;
      this.creepCeiling = nextThreshold - 2;
    }
  }

  allMilestonesFired() {
    return Object.values(this.milestones).every(m => m.fired);
  }

  getEventColor() {
    return '#4a9eff';
  }

  /**
   * @param {string} color
   * @param {number} importance - 0 to 1, drives bulge size
   */
  spawnBulge(color = '#4a9eff', importance = 0.1) {
    if (this.bulges.length >= this.maxBulges) {
      const oldest = this.bulges.shift();
      if (oldest.element.parentNode) {
        oldest.element.parentNode.removeChild(oldest.element);
      }
    }

    let w, h;
    if (importance >= 0.25) {
      w = 20; h = 12;
    } else if (importance >= 0.1) {
      w = 14; h = 9;
    } else {
      w = 8; h = 6;
    }

    const bulge = document.createElement('div');
    bulge.className = 'bulge';
    bulge.style.cssText = `
      position: absolute;
      top: 50%;
      left: 100%;
      width: ${w}px;
      height: ${h}px;
      background: ${color};
      border-radius: ${h / 2}px;
      opacity: 0.9;
    `;

    this.bulgeContainer.appendChild(bulge);

    this.bulges.push({
      element: bulge,
      position: 1,
      speed: this.bulgeSpeed + Math.random() * 0.01,
      color
    });
  }

  complete() {
    if (this.isComplete) return;
    this.isComplete = true;
    this.isLoading = false;
    this.targetProgress = 100;

    for (const bulge of this.bulges) {
      bulge.element.style.opacity = '0';
    }

    setTimeout(() => {
      this.element.classList.remove('loading');
      this.element.classList.add('complete');
      this.track.style.background = 'var(--accent-green, #4ade80)';

      this.bulgeContainer.innerHTML = '';
      this.bulges = [];

      setTimeout(() => {
        this.element.style.opacity = '0';
        setTimeout(() => {
          this.track.style.transition = 'none';
          this.track.style.width = '0%';
          this.progress = 0;
          void this.track.offsetWidth;
          this.track.style.transition = '';
          this.element.style.opacity = '1';
        }, 300);
      }, 500);
    }, 200);
  }

  reset() {
    this.stopAnimation();
    this.progress = 0;
    this.targetProgress = 0;
    this.isLoading = false;
    this.isComplete = false;
    this.bulges = [];
    this.lastBulgeTime = 0;

    for (const m of Object.values(this.milestones)) {
      m.fired = false;
    }
    this.recalcCreepCeiling();

    this.element.style.width = '100%';
    this.track.style.width = '0%';
    this.track.style.background = 'var(--progress-fill, #4a9eff)';
    this.element.style.opacity = '1';
    this.bulgeContainer.innerHTML = '';
    this.element.classList.remove('loading', 'complete', 'error');
  }

  error() {
    this.isLoading = false;
    this.element.classList.remove('loading');
    this.element.classList.add('error');
    this.track.style.width = '100%';
    this.track.style.background = 'var(--accent-red, #f87171)';

    this.bulgeContainer.innerHTML = '';
    this.bulges = [];

    setTimeout(() => {
      this.element.style.opacity = '0';
      setTimeout(() => {
        this.reset();
      }, 300);
    }, 2000);
  }

  startAnimation() {
    if (this.animationFrame) return;

    const animate = () => {
      const diff = this.targetProgress - this.progress;

      if (Math.abs(diff) > 0.1) {
        let increment = diff * this.smoothingFactor;
        if (this.isLoading && increment < 0.3 && diff > 0) {
          increment = Math.min(0.3, diff);
        }
        this.progress += increment;
        this.track.style.width = `${this.progress}%`;
      }

      if (this.isLoading && this.targetProgress < this.creepCeiling) {
        this.targetProgress += 0.02;
      }

      for (let i = this.bulges.length - 1; i >= 0; i--) {
        const bulge = this.bulges[i];
        bulge.position -= bulge.speed;

        const displayPos = bulge.position * this.progress;
        bulge.element.style.left = `${displayPos}%`;

        if (bulge.position <= 0) {
          bulge.element.style.opacity = '0';
          setTimeout(() => {
            if (bulge.element.parentNode) {
              bulge.element.parentNode.removeChild(bulge.element);
            }
          }, 300);
          this.bulges.splice(i, 1);
        }
      }

      if (this.isLoading || Math.abs(this.targetProgress - this.progress) > 0.5 || this.bulges.length > 0) {
        this.animationFrame = requestAnimationFrame(animate);
      } else {
        this.animationFrame = null;
      }
    };

    this.animationFrame = requestAnimationFrame(animate);
  }

  stopAnimation() {
    if (this.animationFrame) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
    }
  }

  getProgress() {
    return this.progress;
  }
}

if (typeof window !== 'undefined') {
  window.ExperimentalProgressBar = ExperimentalProgressBar;
}
