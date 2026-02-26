/**
 * CapturePlayer
 * Replays captured page-load events from per-site events.json files and
 * screenshot data from captures-manifest.json.
 *
 * When a site has real captured events (events.json), those are replayed
 * directly so the event panel, timeline, and progress bar see the exact
 * same event stream as a live page load. Screenshot files are attached
 * to matching paint events for visual playback.
 *
 * Falls back to synthetic event generation from screenshot timings when
 * no events.json is available.
 */
class CapturePlayer {
  constructor() {
    this._manifest = null;
    this._eventsCache = {};
    this._timers = [];
    this._playing = false;
  }

  async _loadManifest() {
    if (this._manifest) return this._manifest;
    const res = await fetch('captures-manifest.json');
    this._manifest = await res.json();
    return this._manifest;
  }

  /**
   * Load per-site events.json. Returns the array of captured events or null.
   */
  async _loadSiteEvents(hostname) {
    if (hostname in this._eventsCache) return this._eventsCache[hostname];
    try {
      const res = await fetch(`captures/${hostname}/events.json`);
      if (!res.ok) { this._eventsCache[hostname] = null; return null; }
      const events = await res.json();
      this._eventsCache[hostname] = events;
      return events;
    } catch {
      this._eventsCache[hostname] = null;
      return null;
    }
  }

  /**
   * List hostnames that have captured data (events or screenshots).
   * @returns {Promise<string[]>}
   */
  async getAvailableHostnames() {
    const manifest = await this._loadManifest();
    return Object.keys(manifest).filter(h =>
      manifest[h].hasEvents || manifest[h].screenshots.length > 0
    );
  }

  /**
   * Check whether a hostname has captured data.
   * @param {string} hostname
   * @returns {Promise<boolean>}
   */
  async hasCapture(hostname) {
    const manifest = await this._loadManifest();
    const entry = manifest[hostname];
    if (!entry) return false;
    return entry.hasEvents || entry.screenshots.length > 0;
  }

  /**
   * Build a playback sequence from real captured events, attaching screenshot
   * files to matching paint events from the manifest.
   */
  _buildFromRealEvents(capturedEvents, entry) {
    const screenshotMap = {};
    for (const shot of (entry.screenshots || [])) {
      screenshotMap[shot.type] = shot.file;
    }

    const events = [];
    for (const evt of capturedEvents) {
      const timeMs = evt.videoTimeMs ?? evt.time ?? 0;
      events.push({
        type: evt.type,
        timeMs: Math.round(timeMs),
        data: evt.data || {},
        screenshotFile: screenshotMap[evt.type] || null,
      });
    }

    events.sort((a, b) => a.timeMs - b.timeMs);
    return events;
  }

  /**
   * Fallback: build a sparse synthetic event sequence from screenshot timings
   * when no real captured events are available.
   */
  _buildSyntheticSequence(entry) {
    const screenshots = entry.screenshots;
    if (!screenshots.length) return [];

    const firstPaintTime = screenshots[0].timeMs;
    const lastTime = screenshots[screenshots.length - 1].timeMs;
    const windowLoadTime = lastTime + 200;

    const events = [];

    function add(type, timeMs, data, screenshotFile) {
      events.push({ type, timeMs: Math.round(timeMs), data: data || {}, screenshotFile: screenshotFile || null });
    }

    add('navigation-start', 0, { url: 'https://captured' });
    add('nav-fetch-start', firstPaintTime * 0.08);
    add('nav-response-start', firstPaintTime * 0.18);
    add('nav-response-end', firstPaintTime * 0.28);

    const earlyResourceEnd = firstPaintTime * 0.9;
    const earlyResourceStart = firstPaintTime * 0.25;
    add('resource-css', earlyResourceStart);
    add('resource-css', earlyResourceStart + (earlyResourceEnd - earlyResourceStart) * 0.15);
    add('resource-script', earlyResourceStart + (earlyResourceEnd - earlyResourceStart) * 0.2);
    add('resource-script', earlyResourceStart + (earlyResourceEnd - earlyResourceStart) * 0.35);
    add('resource-script', earlyResourceStart + (earlyResourceEnd - earlyResourceStart) * 0.5);
    add('dom-ready', firstPaintTime * 0.55);
    add('mutation-nodes', firstPaintTime * 0.6, { nodesAdded: 8, textNodes: 2, headingNodes: 1 });
    add('resource-script', firstPaintTime * 0.7);

    for (const shot of screenshots) {
      const data = {};
      if (shot.type === 'above-fold-images-loaded') data.count = 3;
      if (shot.type === 'lcp') data.element = 'img';
      add(shot.type, shot.timeMs, data, shot.file);
    }

    const postPaintStart = firstPaintTime * 1.05;
    const postPaintEnd = windowLoadTime - 100;
    const postPaintSpan = postPaintEnd - postPaintStart;

    if (postPaintSpan > 100) {
      const imgCount = 4 + Math.floor(Math.random() * 3);
      for (let i = 0; i < imgCount; i++) {
        add('resource-img', postPaintStart + postPaintSpan * ((i + 0.5) / (imgCount + 2)));
      }
      add('resource-script', postPaintStart + postPaintSpan * 0.1);
      add('resource-script', postPaintStart + postPaintSpan * 0.25);
      add('resource-fetch', postPaintStart + postPaintSpan * 0.3);
      add('resource-script', postPaintStart + postPaintSpan * 0.45);
      add('resource-fetch', postPaintStart + postPaintSpan * 0.5);
      add('resource-fetch', postPaintStart + postPaintSpan * 0.65);
      add('mutation-nodes', postPaintStart + postPaintSpan * 0.15, { nodesAdded: 15, textNodes: 6, headingNodes: 1 });
      add('mutation-nodes', postPaintStart + postPaintSpan * 0.35, { nodesAdded: 22, textNodes: 8, headingNodes: 2 });
      add('mutation-text', postPaintStart + postPaintSpan * 0.4);
      add('mutation-nodes', postPaintStart + postPaintSpan * 0.6, { nodesAdded: 10, textNodes: 4, headingNodes: 0 });
      add('mutation-nodes', postPaintStart + postPaintSpan * 0.75, { nodesAdded: 5, textNodes: 2, headingNodes: 0 });
      add('resource-img', postPaintStart + postPaintSpan * 0.8);
      add('resource-other', postPaintStart + postPaintSpan * 0.85);
      add('resource-css', postPaintStart + postPaintSpan * 0.88);
    }

    add('iframe-load-end', windowLoadTime - 50);
    add('window-load', windowLoadTime);

    events.sort((a, b) => a.timeMs - b.timeMs);
    return events;
  }

  /**
   * Play captured events for a hostname.
   *
   * Prefers real captured events from events.json; falls back to synthetic
   * events generated from screenshot timings.
   *
   * @param {string} hostname  - e.g. "reddit.com"
   * @param {object} callbacks
   * @param {function} callbacks.onEvent    - Called with { type, time, delta, data, screenshotFile }
   * @param {function} [callbacks.onDone]   - Called when all events have fired
   * @returns {Promise<boolean>} false if no capture data exists
   */
  async play(hostname, callbacks) {
    this.stop();

    const manifest = await this._loadManifest();
    const entry = manifest[hostname];
    if (!entry) return false;

    let events;

    if (entry.hasEvents) {
      const capturedEvents = await this._loadSiteEvents(hostname);
      if (capturedEvents && capturedEvents.length > 0) {
        events = this._buildFromRealEvents(capturedEvents, entry);
      }
    }

    if (!events || events.length === 0) {
      if (!entry.screenshots.length) return false;
      events = this._buildSyntheticSequence(entry);
    }

    if (!events.length) return false;

    this._playing = true;
    let prevTime = 0;

    for (let i = 0; i < events.length; i++) {
      const evt = events[i];
      const delay = evt.timeMs;

      const timer = setTimeout(() => {
        if (!this._playing) return;

        const delta = evt.timeMs - prevTime;
        prevTime = evt.timeMs;

        callbacks.onEvent({
          type: evt.type,
          time: evt.timeMs,
          delta,
          data: evt.data,
          screenshotFile: evt.screenshotFile,
        });

        if (i === events.length - 1) {
          this._playing = false;
          if (callbacks.onDone) callbacks.onDone();
        }
      }, delay);

      this._timers.push(timer);
    }

    return true;
  }

  /**
   * Cancel any in-progress playback.
   */
  stop() {
    this._playing = false;
    for (const t of this._timers) clearTimeout(t);
    this._timers = [];
  }
}

if (typeof window !== 'undefined') {
  window.CapturePlayer = CapturePlayer;
}
