/**
 * Proxy Server
 * Fetches pages server-side, strips security headers, injects observer script,
 * and applies network throttling simulation.
 */

const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

// Throttle profiles (latency in ms, bandwidth in bytes per second)
const THROTTLE_PROFILES = {
  'none': { latency: 0, bandwidth: Infinity },
  'fast-wifi': { latency: 10, bandwidth: 5 * 1024 * 1024 }, // 40 Mbps
  '4g': { latency: 50, bandwidth: 1.25 * 1024 * 1024 }, // 10 Mbps
  'slow-4g': { latency: 100, bandwidth: 512 * 1024 }, // 4 Mbps
  '3g': { latency: 200, bandwidth: 192 * 1024 }, // 1.5 Mbps
  'slow-3g': { latency: 400, bandwidth: 50 * 1024 } // 400 Kbps
};

// Security headers to strip
const HEADERS_TO_STRIP = [
  'content-security-policy',
  'content-security-policy-report-only',
  'x-frame-options',
  'x-content-type-options',
  'x-xss-protection',
  'cross-origin-embedder-policy',
  'cross-origin-opener-policy',
  'cross-origin-resource-policy'
];

// Allow all cross-origin requests — required so proxied pages can load
// sub-resources back through this server without CORS blocks
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Serve static files
app.use(express.static(path.join(__dirname)));

// Request coalescing cache for /proxy — ensures both iframes receive the same
// fetched+processed HTML without a double round-trip to the origin server.
// Key: `${url}|${throttle}`. Entries expire after PROXY_CACHE_TTL ms so that
// reloading the same URL later re-fetches fresh content.
const proxyCache = new Map();
const PROXY_CACHE_TTL = 10000; // ms

function getOrFetchProxy(key, fetchFn) {
  const cached = proxyCache.get(key);
  if (cached?.result && Date.now() - cached.timestamp < PROXY_CACHE_TTL) {
    return Promise.resolve(cached.result);
  }
  if (cached?.pending) return cached.pending;

  const pending = fetchFn().then(result => {
    proxyCache.set(key, { result, timestamp: Date.now(), pending: null });
    return result;
  }).catch(err => {
    proxyCache.delete(key);
    throw err;
  });

  proxyCache.set(key, { pending });
  return pending;
}

// Proxy endpoint
app.get('/proxy', async (req, res) => {
  const targetUrl = req.query.url;
  const throttleProfile = req.query.throttle || 'none';

  if (!targetUrl) {
    return res.status(400).json({ error: 'Missing url parameter' });
  }

  try {
    const profile = THROTTLE_PROFILES[throttleProfile] || THROTTLE_PROFILES['none'];
    const serverOrigin = `${req.protocol}://${req.get('host')}`;
    const cacheKey = `${targetUrl}|${throttleProfile}`;

    const result = await getOrFetchProxy(cacheKey, async () => {
      // Apply latency once (only the first requester pays it)
      if (profile.latency > 0) {
        await delay(profile.latency);
      }

      const response = await fetch(targetUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Linux; Android 10; SM-G960U) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'Accept-Encoding': 'identity'
        },
        redirect: 'follow'
      });

      if (!response.ok) {
        return { error: true, status: response.status, statusText: response.statusText };
      }

      const contentType = response.headers.get('content-type') || '';

      if (contentType.includes('text/html')) {
        let html = await response.text();
        const finalUrl = new URL(response.url);
        html = injectObserverScript(html, finalUrl, throttleProfile, serverOrigin);
        return { error: false, contentType: 'text/html; charset=utf-8', data: html };
      } else {
        const buffer = await response.arrayBuffer();
        return { error: false, contentType, data: Buffer.from(buffer) };
      }
    });

    if (result.error) {
      return res.status(result.status).json({ error: `Failed to fetch: ${result.status} ${result.statusText}` });
    }

    res.setHeader('Content-Type', result.contentType);

    if (profile.bandwidth !== Infinity && profile.bandwidth > 0) {
      await sendThrottled(res, result.data, profile.bandwidth);
    } else {
      res.send(result.data);
    }
  } catch (error) {
    console.error('Proxy error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Proxy for sub-resources (CSS, JS, images, etc.)
app.get('/proxy-resource', async (req, res) => {
  const targetUrl = req.query.url;
  const throttleProfile = req.query.throttle || 'none';

  if (!targetUrl) {
    return res.status(400).json({ error: 'Missing url parameter' });
  }

  try {
    const profile = THROTTLE_PROFILES[throttleProfile] || THROTTLE_PROFILES['none'];

    // Apply latency
    if (profile.latency > 0) {
      await delay(profile.latency);
    }

    const response = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 10; SM-G960U) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
        'Accept': '*/*',
        'Accept-Encoding': 'identity'
      }
    });

    if (!response.ok) {
      return res.status(response.status).send();
    }

    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    const buffer = await response.arrayBuffer();

    res.setHeader('Content-Type', contentType);

    if (profile.bandwidth !== Infinity && profile.bandwidth > 0) {
      await sendThrottled(res, Buffer.from(buffer), profile.bandwidth);
    } else {
      res.send(Buffer.from(buffer));
    }
  } catch (error) {
    console.error('Resource proxy error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Inject the observer script and rewrite resource URLs to proxy.
 *
 * Uses pure string manipulation instead of cheerio to preserve the
 * original HTML byte-for-byte — cheerio's re-serialization subtly alters
 * whitespace, attribute order, entity encoding, and self-closing tag
 * format, which causes React hydration mismatches (error #423) on
 * sites like BBC that use Next.js SSR.
 *
 * @param {string} html - Original HTML
 * @param {URL} baseUrl - Base URL for resolving relative URLs
 * @param {string} throttleProfile - Throttle profile for proxy-resource
 * @returns {string} Modified HTML
 */
function injectObserverScript(html, baseUrl, throttleProfile = 'none', serverOrigin = 'http://localhost:3001') {
  try {
    const base = baseUrl.origin + '/';

    const proxyUrl = (url) => {
      try {
        const absolute = new URL(url, base).href;
        if (absolute.startsWith('data:') || absolute.startsWith('blob:') || absolute.startsWith('javascript:')) return url;
        return `${serverOrigin}/proxy-resource?url=${encodeURIComponent(absolute)}&throttle=${encodeURIComponent(throttleProfile)}`;
      } catch (e) { return url; }
    };

    // 1. Build head injection (style + observer + base tag)
    const resetStyle = `<style id="proxy-reset">html,body{margin:0}img[src*="grey-placeholder"]{display:none!important}html,body,*{-ms-overflow-style:none!important;scrollbar-width:none!important}html::-webkit-scrollbar,body::-webkit-scrollbar,*::-webkit-scrollbar{display:none!important}</style>`;
    const observerScript = `<script src="${serverOrigin}/injected-observer.js"></script>`;
    const baseTag = /<base\s/i.test(html) ? '' : `<base href="${base}">`;
    const injection = resetStyle + observerScript + baseTag;

    const headMatch = html.match(/<head(\s[^>]*)?>/i);
    if (headMatch) {
      const pos = headMatch.index + headMatch[0].length;
      html = html.slice(0, pos) + injection + html.slice(pos);
    } else {
      html = injection + html;
    }

    // 2. Split at </head> — only rewrite URLs in the <head> section.
    //    Body content is left byte-identical to preserve React/Next.js
    //    hydration (any attribute change inside the React root causes
    //    error #423). Body resources load cross-origin from their
    //    original servers, which works fine for images and scripts.
    const headEnd = html.search(/<\/head\s*>/i);
    let headSection, bodySection;
    if (headEnd !== -1) {
      headSection = html.slice(0, headEnd);
      bodySection = html.slice(headEnd);
    } else {
      headSection = html;
      bodySection = '';
    }

    // 3. Rewrite script src in HEAD only (skip our injected observer)
    headSection = headSection.replace(
      /(<script\s[^>]*?)src=(["'])((?:(?!\2).)+)\2/gi,
      (match, before, q, src) => {
        if (src.includes('injected-observer')) return match;
        return `${before}src=${q}${proxyUrl(src)}${q}`;
      }
    );

    // 4. Rewrite link href in HEAD only
    headSection = headSection.replace(
      /(<link\s[^>]*?)href=(["'])((?:(?!\2).)+)\2/gi,
      (match, before, q, href) => {
        const relMatch = match.match(/rel=(["'])(.*?)\1/i);
        const rel = relMatch ? relMatch[2].toLowerCase() : '';
        if (['stylesheet','icon','shortcut icon','preload','prefetch','modulepreload'].includes(rel)) {
          return `${before}href=${q}${proxyUrl(href)}${q}`;
        }
        return match;
      }
    );

    // 5. Remove native lazy loading from images in body
    bodySection = bodySection.replace(
      /(<img\s[^>]*?)\s+loading=(["'])(?:(?!\2).)*\2/gi,
      '$1'
    );

    html = headSection + bodySection;

    return html;
  } catch (error) {
    console.error('HTML injection error:', error);
    return `<script src="/injected-observer.js"></script>${html}`;
  }
}

/**
 * Send response with bandwidth throttling
 * @param {Response} res - Express response
 * @param {string|Buffer} data - Data to send
 * @param {number} bytesPerSecond - Bandwidth limit
 */
async function sendThrottled(res, data, bytesPerSecond) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const chunkSize = Math.max(1024, Math.floor(bytesPerSecond / 10)); // 10 chunks per second
  const delayMs = 100; // 100ms between chunks

  for (let i = 0; i < buffer.length; i += chunkSize) {
    const chunk = buffer.slice(i, Math.min(i + chunkSize, buffer.length));
    res.write(chunk);
    
    if (i + chunkSize < buffer.length) {
      await delay(delayMs);
    }
  }
  
  res.end();
}

/**
 * Delay helper
 * @param {number} ms - Milliseconds to delay
 * @returns {Promise}
 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Start server
app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║                 Progress Bar Prototype                     ║
╠═══════════════════════════════════════════════════════════╣
║  Server running at: http://localhost:${PORT}                 ║
║                                                           ║
║  Open the URL above in your browser to start testing.     ║
║                                                           ║
║  Throttle profiles:                                       ║
║    • none       - No throttle                             ║
║    • fast-wifi  - 10ms latency, 40 Mbps                   ║
║    • 4g         - 50ms latency, 10 Mbps                   ║
║    • slow-4g    - 100ms latency, 4 Mbps                   ║
║    • 3g         - 200ms latency, 1.5 Mbps                 ║
║    • slow-3g    - 400ms latency, 400 Kbps                 ║
╚═══════════════════════════════════════════════════════════╝
  `);
});
