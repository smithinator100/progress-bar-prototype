/**
 * Event Bus
 * Normalizes page load events into a standard shape and distributes them to subscribers.
 */
class EventBus {
  constructor() {
    this.subscribers = [];
    this.events = [];
    this.navigationStartTime = 0;
  }

  /**
   * Subscribe to events
   * @param {Function} callback - Called with normalized event
   * @returns {Function} Unsubscribe function
   */
  subscribe(callback) {
    this.subscribers.push(callback);
    return () => {
      const index = this.subscribers.indexOf(callback);
      if (index > -1) this.subscribers.splice(index, 1);
    };
  }

  /**
   * Emit a raw event - normalizes it and distributes to subscribers
   * @param {Object} rawEvent - Raw event from observer or harness
   */
  emit(rawEvent) {
    const normalized = this.normalize(rawEvent);
    this.events.push(normalized);
    
    for (const callback of this.subscribers) {
      try {
        callback(normalized);
      } catch (e) {
        console.error('[EventBus] Subscriber error:', e);
      }
    }
  }

  /**
   * Normalize an event to the standard shape
   * @param {Object} raw - Raw event
   * @returns {Object} Normalized event
   */
  normalize(raw) {
    const type = raw.type;
    const time = raw.time || 0;
    const delta = raw.delta || this.calculateDelta(time);
    const weight = this.calculateWeight(type, raw.data);
    const category = this.getCategory(type);

    return {
      type,
      time,
      delta,
      weight,
      category,
      data: raw.data || {}
    };
  }

  /**
   * Calculate time delta from previous event
   * @param {number} time - Current event time
   * @returns {number} Delta in ms
   */
  calculateDelta(time) {
    if (this.events.length === 0) return 0;
    const lastEvent = this.events[this.events.length - 1];
    return Math.max(0, time - lastEvent.time);
  }

  /**
   * Calculate weight (0-1) for progress bar significance
   * Higher weights = more progress bar advancement
   * @param {string} type - Event type
   * @param {Object} data - Event data
   * @returns {number} Weight between 0 and 1
   */
  calculateWeight(type, data = {}) {
    const weights = {
      // Navigation events - moderate weight
      'navigation-start': 0.05,
      'spa-navigate': 0.3,
      'redirect': 0.1,
      'iframe-load-start': 0.02,
      'iframe-load-end': 0.1,

      // DOM events - text is more significant
      'dom-ready': 0.15,
      'mutation-nodes': this.calculateMutationWeight(data),
      'mutation-text': 0.4,

      // Paint events - high significance (user sees something)
      'first-paint': 0.2,
      'first-contentful-paint': 0.25,
      'lcp': 0.3,

      // Resource events - varies by type
      'resource-script': 0.08,
      'resource-css': 0.1,
      'resource-img': 0.05,
      'resource-fetch': 0.06,
      'resource-media': 0.04,
      'resource-other': 0.03,

      // Load events - completion indicators
      'window-load': 0.2,

      // Raw mode / DDG progress (not used for weighted bars)
      'progress-update': 0,
      'progress-complete': 0,
      'nav-fetch-start': 0.02,
      'nav-response-start': 0.05,
      'nav-response-end': 0.05,
      'redirect-chain': 0.1,
      'resource-start': 0.03,
      'resource-complete': 0.05,

      // DDG lifecycle events (emitted by RawModeProgressBar)
      'bar-shown': 0,
      'progress-changed-100': 0,
      'animator-on-end': 0,
      'bar-dismissed': 0,

      // Experimental milestone events
      'text-settled': 0.3,
      'above-fold-images-loaded': 0.25,

      // Errors - low weight, don't stall progress
      'resource-error': 0.02,
      'navigation-error': 0.1
    };

    return weights[type] ?? 0.05;
  }

  /**
   * Calculate weight for mutation events based on content significance
   * @param {Object} data - Mutation data
   * @returns {number} Weight
   */
  calculateMutationWeight(data) {
    if (!data) return 0.05;
    
    const { textNodes = 0, headingNodes = 0, nodesAdded = 0 } = data;
    
    // Text and heading nodes are more significant
    let weight = 0.05;
    weight += Math.min(textNodes * 0.08, 0.3);
    weight += Math.min(headingNodes * 0.1, 0.2);
    weight += Math.min(nodesAdded * 0.005, 0.1);
    
    return Math.min(weight, 0.6);
  }

  /**
   * Get event category for UI grouping and coloring
   * @param {string} type - Event type
   * @returns {string} Category
   */
  getCategory(type) {
    if (type.includes('navigation') || type === 'spa-navigate' || type === 'redirect' || type.includes('iframe') || type.startsWith('nav-') || type === 'redirect-chain') {
      return 'navigation';
    }
    if (type.includes('mutation') || type === 'dom-ready') {
      return 'dom';
    }
    if (type.includes('paint') || type === 'lcp') {
      return 'paint';
    }
    if (type === 'text-settled') {
      return 'dom';
    }
    if (type === 'above-fold-images-loaded') {
      return 'resource';
    }
    if (type.includes('resource')) {
      return 'resource';
    }
    if (type === 'progress-update' || type === 'progress-complete' ||
        type === 'bar-shown' || type === 'progress-changed-100' ||
        type === 'animator-on-end' || type === 'bar-dismissed') {
      return 'progress';
    }
    if (type === 'window-load') {
      return 'load';
    }
    if (type.includes('error')) {
      return 'error';
    }
    return 'other';
  }

  /**
   * Get all captured events
   * @returns {Array} All events
   */
  getEvents() {
    return [...this.events];
  }

  /**
   * Clear all events
   */
  clear() {
    this.events = [];
    this.navigationStartTime = 0;
  }

  /**
   * Get event statistics
   * @returns {Object} Stats
   */
  getStats() {
    const categories = {};
    let totalWeight = 0;
    
    for (const event of this.events) {
      categories[event.category] = (categories[event.category] || 0) + 1;
      totalWeight += event.weight;
    }
    
    return {
      count: this.events.length,
      categories,
      totalWeight,
      duration: this.events.length > 0 
        ? this.events[this.events.length - 1].time 
        : 0
    };
  }
}

// Export for use in browser
if (typeof window !== 'undefined') {
  window.EventBus = EventBus;
}
