#!/usr/bin/env node
/**
 * capture-events.js
 *
 * Loads each website through the prototype proxy server at 3G speed,
 * captures all injected-observer webview events, records a 60fps WebM
 * video of each page load, and extracts PNG screenshots at significant
 * paint event timestamps using ffmpeg.
 *
 * How it works:
 *   - Puppeteer navigates directly to /proxy?url=...&throttle=3g
 *   - The server injects injected-observer.js into the proxied page
 *   - The observer calls window.parent.postMessage(...) for each event
 *     (when the page is top-level, window.parent === window, so messages
 *     fire on the same window and are picked up by our injected listener)
 *   - Events are forwarded to Node via page.exposeFunction in real-time
 *   - Each event is stamped with videoTimeMs (wall-clock offset from
 *     recording start) so timestamps align with the video file
 *   - After each recording, ffmpeg extracts a PNG at each paint event
 *   - Results are saved to a JSON file after all URLs complete
 *
 * Prerequisites:
 *   - Start the server first:  cd prototype && npm start
 *   - ffmpeg must be installed and in PATH
 *
 * Usage:
 *   node scripts/capture-events.js [options]
 *
 * Options:
 *   --urls      <comma-separated URLs | path to JSON file>
 *               Override the default URL list. JSON file should be an array of
 *               URL strings, or an object with a "urls" array property.
 *   --output    <path>    Output JSON file path (default: events-capture.json)
 *   --video-dir <path>    Directory for videos and screenshots (default: captures)
 *   --timeout   <ms>      Per-URL timeout in milliseconds (default: 60000)
 *   --throttle  <profile> Throttle profile to use (default: 3g)
 *               Profiles: none, fast-wifi, 4g, slow-4g, 3g, slow-3g
 *   --grace     <ms>      Extra wait after window-load for late events like LCP
 *               (default: 2000)
 *   --headed              Run browser in headed (visible) mode for debugging
 *   --server    <url>     Proxy server base URL (default: http://localhost:3001)
 *   --no-video            Skip video recording (events only)
 *   --no-screenshots      Skip screenshot extraction (video only, no ffmpeg pass)
 */

'use strict';

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

// Default URL list — mirrors the dropdown in prototype/index.html
const DEFAULT_URLS = [
  'https://apnews.com',
  'https://theguardian.com',
  'https://bbc.com',
  'https://foxnews.com',
  'https://ikea.com',
  'https://ebay.com',
  'https://target.com',
  'https://costco.com',
  'https://reddit.com',
  'https://github.com',
  'https://bsky.app',
  'https://linktr.ee',
  'https://imdb.com',
  'https://rottentomatoes.com',
  'https://justwatch.com',
  'https://wikipedia.org',
  'https://wikihow.com',
  'https://es.wikipedia.org',
  'https://google.com',
  'https://duckduckgo.com',
  'https://bing.com',
  'https://healthline.com',
  'https://mayoclinic.org',
  'https://webmd.com',
  'https://medicalnewstoday.com',
  'https://weather.com',
  'https://archive.org',
  'https://timeanddate.com',
  'https://speedtest.net',
  'https://apple.com',
  'https://tomsguide.com',
  'https://geeksforgeeks.org',
  'https://finance.yahoo.com',
  'https://goodrx.com',
  'https://kitco.com',
];

// Event types that represent significant visual milestones.
// A PNG screenshot will be extracted at each of these events.
const PAINT_EVENT_TYPES = new Set([
  'first-paint',
  'first-contentful-paint',
  'lcp',
  'above-fold-images-loaded',
  'text-settled',
]);

// ─── CLI Argument Parsing ─────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    urls: null,
    output: 'events-capture.json',
    videoDir: 'captures',
    timeout: 60000,
    throttle: '3g',
    grace: 2000,
    headed: false,
    server: 'http://localhost:3001',
    video: true,
    screenshots: true,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--urls':           opts.urls       = args[++i]; break;
      case '--output':         opts.output     = args[++i]; break;
      case '--video-dir':      opts.videoDir   = args[++i]; break;
      case '--timeout':        opts.timeout    = parseInt(args[++i], 10); break;
      case '--throttle':       opts.throttle   = args[++i]; break;
      case '--grace':          opts.grace      = parseInt(args[++i], 10); break;
      case '--server':         opts.server     = args[++i]; break;
      case '--headed':         opts.headed     = true; break;
      case '--no-video':       opts.video      = false; break;
      case '--no-screenshots': opts.screenshots = false; break;
    }
  }

  return opts;
}

function resolveUrls(urlsArg) {
  if (!urlsArg) return DEFAULT_URLS;

  if (fs.existsSync(urlsArg)) {
    const parsed = JSON.parse(fs.readFileSync(urlsArg, 'utf8'));
    return Array.isArray(parsed) ? parsed : (parsed.urls || DEFAULT_URLS);
  }

  return urlsArg.split(',').map(u => u.trim()).filter(Boolean);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function checkServerRunning(serverUrl) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(serverUrl, { signal: ctrl.signal });
    clearTimeout(timer);
    return res.status < 500;
  } catch {
    return false;
  }
}

/** Derive a safe directory name from a URL hostname. */
function hostDir(url, videoDir) {
  try {
    const hostname = new URL(url).hostname;
    return path.join(videoDir, hostname);
  } catch {
    const safe = url.replace(/[^a-z0-9.-]/gi, '_').slice(0, 80);
    return path.join(videoDir, safe);
  }
}

/**
 * Probe a video for total frame count and container fps using ffprobe.
 * Returns { frameCount, fps }.
 */
async function probeVideo(videoPath) {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error',
    '-count_frames',
    '-show_entries', 'stream=nb_read_frames,r_frame_rate',
    '-of', 'csv=p=0',
    videoPath,
  ]);
  const parts = stdout.trim().split(',');
  const [num, den] = (parts[0] || '25/1').split('/').map(Number);
  const fps = den ? num / den : 25;
  const frameCount = parseInt(parts[parts.length - 1], 10) || 0;
  return { frameCount, fps };
}

/**
 * Extract a single PNG frame from a video by frame number.
 * Uses select filter to pick the exact frame.
 */
async function extractFrameByNumber(videoPath, frameNumber, outputPath) {
  await execFileAsync('ffmpeg', [
    '-i', videoPath,
    '-vf', `select=eq(n\\,${frameNumber})`,
    '-frames:v', '1',
    '-vsync', 'vfr',
    '-y',
    outputPath,
  ]);
}

/**
 * Extract screenshots for all significant paint events found in an events array.
 *
 * Puppeteer's screencast encodes frames at a fixed container fps that may
 * differ from the wall-clock recording rate. We map wall-clock videoTimeMs
 * to frame numbers proportionally: frame = (videoTimeMs / wallClockDuration) * totalFrames.
 *
 * @param {Array} events         Captured events with videoTimeMs
 * @param {string} videoPath     Path to the WebM video
 * @param {string} outputDir     Directory for output PNGs
 * @param {number} wallClockMs   Wall-clock recording duration in ms
 * @returns {Promise<Array>}     Screenshot results
 */
async function extractPaintScreenshots(events, videoPath, outputDir, wallClockMs) {
  const seen = new Set();
  const paintEvents = [];
  for (const event of events) {
    if (PAINT_EVENT_TYPES.has(event.type) && !seen.has(event.type)) {
      seen.add(event.type);
      paintEvents.push(event);
    }
  }

  if (paintEvents.length === 0) return [];

  const { frameCount } = await probeVideo(videoPath);
  if (frameCount === 0) return [];

  const screenshots = [];
  for (const event of paintEvents) {
    const ms = event.videoTimeMs ?? 0;
    const proportion = wallClockMs > 0 ? ms / wallClockMs : 0;
    const frameNum = Math.min(Math.round(proportion * frameCount), frameCount - 1);
    const filename = `${event.type}-${ms}ms.png`;
    const outputFilePath = path.join(outputDir, filename);
    try {
      await extractFrameByNumber(videoPath, frameNum, outputFilePath);
      screenshots.push({ type: event.type, videoTimeMs: ms, path: outputFilePath });
    } catch (e) {
      screenshots.push({ type: event.type, videoTimeMs: ms, path: null, error: e.message });
    }
  }

  return screenshots;
}

// ─── Per-URL Capture ──────────────────────────────────────────────────────────

/**
 * Load a single URL through the proxy, record a 60fps video, capture all
 * observer events, then extract paint-event screenshots from the video.
 *
 * @param {import('puppeteer').Browser} browser
 * @param {string} url    Target URL
 * @param {object} opts   Capture options
 * @returns {Promise<object>} Result object
 */
async function captureUrl(browser, url, opts) {
  const { server, throttle, timeout, grace, video, screenshots, videoDir } = opts;
  const events = [];
  const startTime = Date.now();
  let completed = false;
  let navigationError = null;
  let recorder = null;
  let recordingStartTime = null;

  const dir = hostDir(url, videoDir);
  const webmPath = path.join(dir, 'video.webm');
  const videoPath = path.join(dir, 'video.mp4');

  fs.mkdirSync(dir, { recursive: true });

  // Clean stale screenshots and video from previous runs
  try {
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.png') || f === 'video.webm' || f === 'video.mp4') {
        fs.unlinkSync(path.join(dir, f));
      }
    }
  } catch (_) {}

  const page = await browser.newPage();

  await page.setViewport({ width: 412, height: 917, deviceScaleFactor: 2.625 });

  page.on('console', () => {});
  page.on('pageerror', () => {});

  try {
    let resolveLoad;
    const loadPromise = new Promise(resolve => { resolveLoad = resolve; });

    // Expose __captureEvent so the in-page script can send events to Node.
    // Puppeteer guarantees this binding is available before any page scripts run.
    await page.exposeFunction('__captureEvent', (event) => {
      // Stamp with wall-clock offset from recording start for video alignment.
      // Falls back to page time if recording hasn't started yet (shouldn't happen).
      event.videoTimeMs = recordingStartTime !== null
        ? Date.now() - recordingStartTime
        : event.time;

      events.push(event);

      if (event.type === 'window-load') {
        completed = true;
        setTimeout(() => resolveLoad('window-load'), grace);
      } else if (event.type === 'navigation-error') {
        navigationError = event.data;
        resolveLoad('navigation-error');
      }
    });

    // Bridge postMessage → __captureEvent for direct navigation.
    // The injected observer posts events via window.parent.postMessage();
    // when top-level, window.parent === window, so messages arrive on the
    // same window. This listener forwards them to the exposed function.
    await page.evaluateOnNewDocument(() => {
      window.addEventListener('message', (e) => {
        if (
          e.data &&
          e.data.source === 'progress-bar-observer' &&
          typeof window.__captureEvent === 'function'
        ) {
          window.__captureEvent(e.data.event);
        }
      });
    });

    // Start screencast BEFORE navigation so the video captures the full load,
    // including the initial blank state and first paint.
    if (video) {
      recorder = await page.screencast({
        path: webmPath,
        fps: 60,
        quality: 20,
      });
      recordingStartTime = Date.now();
    }

    // Navigate directly to the proxied page. The server injects
    // injected-observer.js which posts events via postMessage; our
    // evaluateOnNewDocument listener above forwards them to __captureEvent.
    // Previous approach used capture-frame.html with an iframe, but
    // Puppeteer's screencast cannot composite iframe content in headless mode.
    const proxyUrl = `${server}/proxy` +
      `?url=${encodeURIComponent(url)}&throttle=${encodeURIComponent(throttle)}`;

    try {
      await page.goto(proxyUrl, { waitUntil: 'domcontentloaded', timeout });
    } catch (navErr) {
      if (recorder) await recorder.stop().catch(() => {});
      return buildResult(url, events, startTime, false, `Navigation failed: ${navErr.message}`, null, []);
    }

    // Wait for window-load + grace period, or the timeout
    await Promise.race([
      loadPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), timeout)),
    ]).catch(() => {});

    // Stop recording before closing the page
    let recordingWallClockMs = 0;
    if (recorder) {
      recordingWallClockMs = Date.now() - recordingStartTime;
      await recorder.stop().catch(() => {});
    }

    // Extract paint-event screenshots from the raw WebM (before conversion).
    // Frame-number extraction works reliably on the original screencast output.
    let screenshotResults = [];
    if (video && screenshots && fs.existsSync(webmPath)) {
      screenshotResults = await extractPaintScreenshots(events, webmPath, dir, recordingWallClockMs);
    }

    // Convert WebM → MP4 with corrected timestamps. Puppeteer's screencast
    // encodes at a container fps that doesn't match wall-clock time, so we
    // use setpts to scale timestamps during the transcode.
    if (fs.existsSync(webmPath) && recordingWallClockMs > 0) {
      try {
        const { frameCount, fps: containerFps } = await probeVideo(webmPath);
        if (frameCount > 0 && containerFps > 0) {
          const containerDuration = frameCount / containerFps;
          const wallClockSec = recordingWallClockMs / 1000;
          const ptsScale = (wallClockSec / containerDuration).toFixed(6);
          await execFileAsync('ffmpeg', [
            '-i', webmPath,
            '-filter:v', `setpts=PTS*${ptsScale},pad=ceil(iw/2)*2:ceil(ih/2)*2`,
            '-c:v', 'libx264',
            '-preset', 'fast',
            '-crf', '23',
            '-pix_fmt', 'yuv420p',
            '-movflags', '+faststart',
            '-y',
            videoPath,
          ]);
          fs.unlinkSync(webmPath);
        }
      } catch (e) {
        // Fallback: keep the WebM if MP4 conversion fails
        const mp4Size = fs.existsSync(videoPath) ? fs.statSync(videoPath).size : 0;
        if (mp4Size === 0 && fs.existsSync(webmPath)) {
          try { fs.unlinkSync(videoPath); } catch (_) {}
          fs.renameSync(webmPath, videoPath);
        }
      }
    }

    // Save per-site events.json for capture playback
    if (events.length > 0) {
      const eventsPath = path.join(dir, 'events.json');
      fs.writeFileSync(eventsPath, JSON.stringify(events, null, 2), 'utf8');
    }

    return buildResult(url, events, startTime, completed, navigationError, video ? videoPath : null, screenshotResults);

  } finally {
    await page.close();
  }
}

function buildResult(url, events, startTime, completed, error, videoPath, screenshots) {
  return {
    url,
    events,
    eventCount: events.length,
    durationMs: Date.now() - startTime,
    completed,
    error: error
      ? (typeof error === 'string' ? error : JSON.stringify(error))
      : null,
    videoPath: videoPath || null,
    screenshots: screenshots || [],
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv);
  const urls = resolveUrls(opts.urls);
  const outputPath = path.resolve(opts.output);
  const videoDir = path.resolve(opts.videoDir);

  if (opts.video) fs.mkdirSync(videoDir, { recursive: true });

  console.log('╔═══════════════════════════════════════════════╗');
  console.log('║       Progress Bar Event Capture              ║');
  console.log('╚═══════════════════════════════════════════════╝');
  console.log(`  Throttle    : ${opts.throttle}`);
  console.log(`  URLs        : ${urls.length}`);
  console.log(`  Output      : ${outputPath}`);
  console.log(`  Video dir   : ${opts.video ? videoDir : '(disabled)'}`);
  console.log(`  Screenshots : ${opts.screenshots && opts.video ? 'yes (paint events)' : 'no'}`);
  console.log(`  Timeout     : ${opts.timeout}ms per URL`);
  console.log(`  Grace       : ${opts.grace}ms after window-load`);
  console.log(`  Server      : ${opts.server}`);
  console.log(`  Mode        : ${opts.headed ? 'headed' : 'headless'}`);
  console.log('');

  console.log('Checking server...');
  if (!(await checkServerRunning(opts.server))) {
    console.error(`\nError: Server not reachable at ${opts.server}`);
    console.error('Start it first:  cd prototype && npm start\n');
    process.exit(1);
  }
  console.log('Server OK\n');

  const browser = await puppeteer.launch({
    headless: !opts.headed,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const results = [];
  let pass = 0;
  let fail = 0;

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const prefix = `[${String(i + 1).padStart(2)}/${urls.length}]`;
    process.stdout.write(`${prefix} ${url} ... `);

    try {
      const result = await captureUrl(browser, url, opts);
      results.push(result);

      const shots = result.screenshots.filter(s => s.path).length;
      const shotStr = opts.video && opts.screenshots ? `  ${shots} screenshots` : '';

      if (result.completed) {
        console.log(`✓  ${result.eventCount} events  ${result.durationMs}ms${shotStr}`);
        pass++;
      } else {
        const reason = result.error || 'timeout';
        console.log(`✗  ${result.eventCount} events  ${result.durationMs}ms${shotStr}  (${reason})`);
        fail++;
      }
    } catch (e) {
      console.log(`✗  failed (${e.message})`);
      results.push({
        url,
        events: [],
        eventCount: 0,
        durationMs: 0,
        completed: false,
        error: e.message,
        videoPath: null,
        screenshots: [],
      });
      fail++;
    }
  }

  await browser.close();

  const output = {
    capturedAt: new Date().toISOString(),
    throttle: opts.throttle,
    urlCount: urls.length,
    passCount: pass,
    failCount: fail,
    results,
  };

  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2), 'utf8');

  // Auto-regenerate the captures manifest so browser-preview stays in sync
  try {
    const manifestScript = path.resolve(__dirname, 'generate-manifest.js');
    await execFileAsync('node', [manifestScript]);
    console.log('\nManifest regenerated.');
  } catch (e) {
    console.warn('\nWarning: could not regenerate manifest:', e.message);
  }

  console.log('');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Complete:  ${pass} passed, ${fail} failed`);
  console.log(`  Output:    ${outputPath}`);
  if (opts.video) console.log(`  Videos:    ${videoDir}`);
  console.log('═══════════════════════════════════════════════\n');
}

main().catch(err => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});
