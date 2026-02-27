/**
 * Automated sync test for comparison webviews.
 * Verifies that both iframes (DDG v1 and DDG v2) load content
 * in sync by measuring timing gaps at key lifecycle events.
 *
 * Usage: node test-sync.js [--threshold=100] [--sites=foxnews.com,bbc.com]
 */
const puppeteer = require('puppeteer');

const DEFAULT_SITES = [
  'https://foxnews.com',
  'https://bbc.com',
  'https://apnews.com',
  'https://theguardian.com',
];

const VISUAL_EVENTS = [
  'navigation-start',
  'first-paint',
  'first-contentful-paint',
];

const INFO_EVENTS = [
  'dom-ready',
  'window-load',
];

const TRACKED_EVENTS = [...VISUAL_EVENTS, ...INFO_EVENTS];

const args = process.argv.slice(2);
const thresholdArg = args.find(a => a.startsWith('--threshold='));
const sitesArg = args.find(a => a.startsWith('--sites='));
const MAX_GAP_MS = thresholdArg ? parseInt(thresholdArg.split('=')[1], 10) : 100;
const SITES = sitesArg
  ? sitesArg.split('=')[1].split(',').map(s => s.startsWith('http') ? s : `https://${s}`)
  : DEFAULT_SITES;

const SERVER_URL = 'http://localhost:3001';
const PAGE_LOAD_TIMEOUT = 30000;

async function waitForServer(maxWait = 10000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      const res = await fetch(SERVER_URL);
      if (res.ok) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`Server not reachable at ${SERVER_URL} after ${maxWait}ms`);
}

async function runTest() {
  await waitForServer();
  console.log(`\n  Sync Test — max allowed gap: ${MAX_GAP_MS}ms\n`);

  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  await setupPage(page);

  let allPassed = true;
  const results = [];

  for (let i = 0; i < SITES.length; i++) {
    const site = SITES[i];
    const hostname = new URL(site).hostname;
    const isSequential = i > 0;
    const label = isSequential ? `${hostname} (seq)` : hostname;
    process.stdout.write(`  ${label.padEnd(25)}`);

    try {
      const result = await testSite(page, site);
      results.push(result);

      const visualEvents = result.events.filter(e => VISUAL_EVENTS.includes(e.type));
      const infoEvents = result.events.filter(e => INFO_EVENTS.includes(e.type));
      const failedVisual = visualEvents.filter(e => e.gap > MAX_GAP_MS);

      if (failedVisual.length > 0) {
        allPassed = false;
        console.log(`FAIL`);
      } else if (visualEvents.length === 0) {
        allPassed = false;
        console.log(`FAIL (no visual events captured)`);
      } else {
        const maxVisualGap = Math.max(...visualEvents.map(e => e.gap));
        console.log(`PASS (max visual gap: ${maxVisualGap.toFixed(1)}ms)`);
      }
      for (const e of visualEvents) {
        const ok = e.gap <= MAX_GAP_MS;
        console.log(`    ${ok ? '✓' : '✗'} ${e.type.padEnd(28)} gap: ${e.gap.toFixed(1)}ms${ok ? '' : ` (limit: ${MAX_GAP_MS}ms)`}`);
      }
      for (const e of infoEvents) {
        console.log(`    · ${e.type.padEnd(28)} gap: ${e.gap.toFixed(1)}ms (info)`);
      }
    } catch (err) {
      allPassed = false;
      console.log(`ERROR: ${err.message}`);
      results.push({ site, error: err.message, events: [] });
    }
  }

  await browser.close();

  console.log(`\n  ${allPassed ? '✓ ALL PASSED' : '✗ SOME FAILED'}\n`);
  process.exit(allPassed ? 0 : 1);
}

async function setupPage(page) {
  await page.goto(SERVER_URL, { waitUntil: 'networkidle2', timeout: 15000 });

  await page.evaluate(() => {
    window.__syncTestEvents = { ddg: {}, improved: {} };
    window.__syncTestLoadStart = 0;
    window.__syncTestListenerReady = true;

    const ddgIframe = document.getElementById('page-iframe-ddg');
    const improvedIframe = document.getElementById('page-iframe-improved');

    window.addEventListener('message', (e) => {
      if (!e.data || e.data.source !== 'progress-bar-observer') return;
      const evt = e.data.event;
      const fromDDG = e.source === ddgIframe.contentWindow;
      const fromImproved = e.source === improvedIframe.contentWindow;
      const bucket = fromDDG ? 'ddg' : fromImproved ? 'improved' : null;
      if (!bucket) return;
      if (!window.__syncTestEvents[bucket][evt.type]) {
        window.__syncTestEvents[bucket][evt.type] = performance.now();
      }
    });
  });
}

async function testSite(page, siteUrl) {
  await page.evaluate(() => {
    window.__syncTestEvents = { ddg: {}, improved: {} };
    window.__syncTestLoadStart = 0;
  });

  const urlInput = await page.$('#url-input');
  await urlInput.click({ clickCount: 3 });
  await urlInput.type(siteUrl, { delay: 0 });

  await page.evaluate(() => {
    window.__syncTestLoadStart = performance.now();
  });

  await page.click('#go-btn');

  await page.waitForFunction(
    () => {
      const e = window.__syncTestEvents;
      return e.ddg['window-load'] && e.improved['window-load'];
    },
    { timeout: PAGE_LOAD_TIMEOUT }
  ).catch(() => {});

  await new Promise(r => setTimeout(r, 1000));

  const data = await page.evaluate(() => {
    return {
      events: window.__syncTestEvents,
      loadStart: window.__syncTestLoadStart,
    };
  });

  const events = [];
  for (const type of TRACKED_EVENTS) {
    const ddgTime = data.events.ddg[type];
    const improvedTime = data.events.improved[type];
    if (ddgTime != null && improvedTime != null) {
      events.push({
        type,
        ddg: ddgTime - data.loadStart,
        improved: improvedTime - data.loadStart,
        gap: Math.abs(ddgTime - improvedTime),
      });
    } else if (ddgTime != null || improvedTime != null) {
      events.push({
        type,
        ddg: ddgTime ? ddgTime - data.loadStart : null,
        improved: improvedTime ? improvedTime - data.loadStart : null,
        gap: Infinity,
        note: `only fired in ${ddgTime ? 'ddg' : 'improved'}`,
      });
    }
  }

  return { site: siteUrl, events };
}

runTest().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
