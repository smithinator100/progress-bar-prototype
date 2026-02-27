/**
 * Event Timeline
 * 4-lane horizontal timeline showing events as blobs grouped by phase:
 *   Lane 0 — DDG Progress (simulated webView.progress values)
 *   Lane 1 — HTML Streaming (MutationObserver)
 *   Lane 2 — Subresource Fetching (Resource Timing)
 *   Lane 3 — JS Execution & Rendering (Paint / Load)
 */
class EventTimeline {
  static LANES = [
    { label: 'DDG Progress',   color: 'var(--accent-grey)' },
    { label: 'HTML Streaming', color: 'var(--accent-green)' },
    { label: 'Subresources',   color: 'var(--accent-orange)' },
    { label: 'JS / Rendering', color: 'var(--accent-purple)' },
  ];

  static TYPE_TO_LANE = {
    'progress-update':         0,
    'progress-complete':       0,
    'bar-shown':               0,
    'progress-changed-100':    0,
    'animator-on-end':         0,
    'bar-dismissed':           0,
    'mutation-nodes':          1,
    'mutation-text':           1,
    'nav-fetch-start':         1,
    'nav-response-start':      1,
    'nav-response-end':        1,
    'redirect-chain':          1,
    'resource-script':         2,
    'resource-css':            2,
    'resource-img':            2,
    'resource-fetch':          2,
    'resource-media':          2,
    'resource-other':          2,
    'resource-error':          2,
    'resource-start':          2,
    'resource-complete':       2,
    'first-paint':             3,
    'first-contentful-paint':  3,
    'lcp':                     3,
    'dom-ready':               3,
    'window-load':             3,
  };

  constructor(containerId) {
    this.container = document.getElementById(containerId);
    this.events = [];
    this.maxTime = 2000;
    this.reflowScheduled = false;

    this.tracks = [];
    this.buildDOM();
  }

  buildDOM() {
    this.container.innerHTML = '';

    for (const lane of EventTimeline.LANES) {
      const row = document.createElement('div');
      row.className = 'timeline-lane';

      const label = document.createElement('span');
      label.className = 'timeline-label';
      label.textContent = lane.label;
      row.appendChild(label);

      const track = document.createElement('div');
      track.className = 'timeline-track';
      row.appendChild(track);

      this.container.appendChild(row);
      this.tracks.push(track);
    }
  }

  addEvent(event) {
    const laneIndex = EventTimeline.TYPE_TO_LANE[event.type];
    if (laneIndex === undefined) return;

    const entry = { event, laneIndex };
    this.events.push(entry);

    const needsReflow = event.time > this.maxTime;
    if (needsReflow) {
      this.maxTime = Math.ceil(event.time / 1000) * 1000;
    }

    if (needsReflow) {
      this.scheduleReflow();
    } else {
      this.renderBlob(entry, true);
    }
  }

  static DDG_LIFECYCLE_TYPES = new Set([
    'bar-shown', 'progress-changed-100', 'animator-on-end', 'bar-dismissed'
  ]);

  renderBlob(entry, animate) {
    const { event, laneIndex } = entry;
    const track = this.tracks[laneIndex];
    const lane = EventTimeline.LANES[laneIndex];

    const pct = (event.time / this.maxTime) * 100;

    const isLifecycle = EventTimeline.DDG_LIFECYCLE_TYPES.has(event.type);
    const belowThreshold = event.type === 'progress-update' && typeof event.data?.value === 'number' && event.data.value < 50;

    // Lifecycle markers are taller diamonds; progress-update dots are small circles
    const size = isLifecycle ? 10 : Math.min(12, 6 + event.weight * 10);

    const blob = document.createElement('div');
    blob.className = 'timeline-blob' + (animate ? ' appear' : '') + (belowThreshold ? ' below-threshold' : '') + (isLifecycle ? ' ddg-lifecycle' : '');
    blob.style.left = `${pct}%`;
    blob.style.width = `${size}px`;
    blob.style.height = `${size}px`;
    blob.style.background = isLifecycle ? 'var(--accent-blue)' : lane.color;

    const titleExtra = event.type === 'progress-update' && event.data?.value !== undefined
      ? ` — ${event.data.value}%`
      : '';
    blob.title = `${event.type} @ ${Math.round(event.time)}ms${titleExtra}`;

    entry.el = blob;
    track.appendChild(blob);
  }

  scheduleReflow() {
    if (this.reflowScheduled) return;
    this.reflowScheduled = true;

    requestAnimationFrame(() => {
      this.reflowScheduled = false;
      this.reflowAll();
    });
  }

  reflowAll() {
    for (const track of this.tracks) {
      track.innerHTML = '';
    }

    for (const entry of this.events) {
      this.renderBlob(entry, false);
    }
  }

  clear() {
    this.events = [];
    this.maxTime = 2000;
    for (const track of this.tracks) {
      track.innerHTML = '';
    }
  }
}

if (typeof window !== 'undefined') {
  window.EventTimeline = EventTimeline;
}
