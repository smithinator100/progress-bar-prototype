/**
 * Event Panel
 * Renders the live event feed with categories, timestamps, and density visualization.
 */
class EventPanel {
  constructor(listElementId, densityElementId) {
    this.listElement = document.getElementById(listElementId);
    this.densityElement = document.getElementById(densityElementId);
    this.events = [];
    this.activeFilter = 'all';
    this.densityBuckets = new Array(20).fill(0);
    this.densityMaxTime = 5000;
  }

  /**
   * Add an event to the panel
   * @param {Object} event - Normalized event
   */
  addEvent(event) {
    this.events.unshift(event);
    this.renderEvent(event);
    this.updateDensity(event);
  }

  /**
   * Render a single event to the list.
   * @param {Object} event - Event to render
   */
  renderEvent(event) {
    // Remove placeholder if present
    const placeholder = this.listElement.querySelector('.event-placeholder');
    if (placeholder) {
      placeholder.remove();
    }

    const item = document.createElement('div');
    item.className = 'event-item';
    item.dataset.category = event.category;

    if (this.activeFilter !== 'all' && this.activeFilter !== event.category) {
      item.classList.add('hidden');
    }

    const dot = document.createElement('div');
    dot.className = `event-dot ${event.category}`;
    item.appendChild(dot);

    const name = document.createElement('span');
    name.className = 'event-name';
    name.textContent = event.type;
    item.appendChild(name);

    const time = document.createElement('span');
    time.className = 'event-time';
    time.textContent = this.formatTime(event.time);
    item.appendChild(time);

    const delta = document.createElement('span');
    delta.className = `event-delta ${this.getDeltaClass(event.delta)}`;
    delta.textContent = event.delta > 0 ? `+${event.delta}ms` : '';
    item.appendChild(delta);

    if (event.data && Object.keys(event.data).length > 0) {
      const data = document.createElement('div');
      data.className = 'event-data';
      data.textContent = this.formatData(event.data);
      item.appendChild(data);
    }

    this.listElement.insertBefore(item, this.listElement.firstChild);
  }

  /**
   * Format time for display
   * @param {number} ms - Time in milliseconds
   * @returns {string} Formatted time
   */
  formatTime(ms) {
    if (ms >= 1000) {
      return `${(ms / 1000).toFixed(2)}s`;
    }
    return `${Math.round(ms)}ms`;
  }

  /**
   * Get CSS class for delta based on speed
   * @param {number} delta - Delta in ms
   * @returns {string} CSS class
   */
  getDeltaClass(delta) {
    if (delta < 50) return 'fast';
    if (delta < 200) return 'medium';
    return 'slow';
  }

  /**
   * Format event data for display
   * @param {Object} data - Event data
   * @returns {string} Formatted string
   */
  formatData(data) {
    const parts = [];
    
    for (const [key, value] of Object.entries(data)) {
      if (value === undefined || value === null || value === '') continue;
      
      let displayValue = value;
      
      // Format specific fields
      if (key === 'transferSize' && typeof value === 'number') {
        displayValue = this.formatBytes(value);
      } else if (key === 'duration' && typeof value === 'number') {
        displayValue = `${value}ms`;
      } else if (typeof value === 'string' && value.length > 50) {
        displayValue = value.slice(0, 47) + '...';
      }
      
      parts.push(`${key}: ${displayValue}`);
    }
    
    return parts.join(' | ');
  }

  /**
   * Format bytes to human readable
   * @param {number} bytes - Bytes
   * @returns {string} Formatted string
   */
  formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  /**
   * Update density visualization
   * @param {Object} event - Event with time
   */
  updateDensity(event) {
    // Expand max time if needed
    if (event.time > this.densityMaxTime) {
      this.densityMaxTime = Math.ceil(event.time / 5000) * 5000;
      this.recalculateDensity();
    }

    const bucketIndex = Math.min(
      Math.floor((event.time / this.densityMaxTime) * this.densityBuckets.length),
      this.densityBuckets.length - 1
    );
    this.densityBuckets[bucketIndex]++;
    
    this.renderDensity();
  }

  /**
   * Recalculate density buckets from all events
   */
  recalculateDensity() {
    this.densityBuckets = new Array(20).fill(0);
    
    for (const event of this.events) {
      const bucketIndex = Math.min(
        Math.floor((event.time / this.densityMaxTime) * this.densityBuckets.length),
        this.densityBuckets.length - 1
      );
      this.densityBuckets[bucketIndex]++;
    }
    
    this.renderDensity();
  }

  /**
   * Render density sparkline
   */
  renderDensity() {
    if (!this.densityElement) return;
    
    const maxCount = Math.max(...this.densityBuckets, 1);
    
    this.densityElement.innerHTML = this.densityBuckets
      .map(count => {
        const height = Math.max(2, (count / maxCount) * 20);
        return `<div class="bar" style="height: ${height}px"></div>`;
      })
      .join('');
  }

  /**
   * Filter events by category
   * @param {string} category - Category to show, or 'all'
   */
  filterByCategory(category) {
    this.activeFilter = category;
    
    const items = this.listElement.querySelectorAll('.event-item');
    items.forEach(item => {
      if (category === 'all' || item.dataset.category === category) {
        item.classList.remove('hidden');
      } else {
        item.classList.add('hidden');
      }
    });
  }

  /**
   * Clear all events
   */
  clear() {
    this.events = [];
    this.densityBuckets = new Array(20).fill(0);
    this.densityMaxTime = 5000;
    
    this.listElement.innerHTML = `
      <div class="event-placeholder">
        Enter a URL and click Go to start capturing events
      </div>
    `;
    
    if (this.densityElement) {
      this.densityElement.innerHTML = '';
    }
  }

  /**
   * Get event count
   * @returns {number} Total events
   */
  getCount() {
    return this.events.length;
  }
}

// Export for use in browser
if (typeof window !== 'undefined') {
  window.EventPanel = EventPanel;
}
