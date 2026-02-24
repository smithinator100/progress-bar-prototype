/**
 * Proxy Server
 * Fetches pages server-side, strips security headers, injects observer script,
 * and applies network throttling simulation.
 */

const express = require('express');
const path = require('path');
const { load: cheerioLoad } = require('cheerio');

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

// Serve static files
app.use(express.static(path.join(__dirname)));

// Proxy endpoint
app.get('/proxy', async (req, res) => {
  const targetUrl = req.query.url;
  const throttleProfile = req.query.throttle || 'none';

  if (!targetUrl) {
    return res.status(400).json({ error: 'Missing url parameter' });
  }

  try {
    const parsedUrl = new URL(targetUrl);
    const profile = THROTTLE_PROFILES[throttleProfile] || THROTTLE_PROFILES['none'];

    // Apply latency
    if (profile.latency > 0) {
      await delay(profile.latency);
    }

    // Fetch the page
    const response = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 10; SM-G960U) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'identity' // Disable compression for easier processing
      },
      redirect: 'follow'
    });

    if (!response.ok) {
      return res.status(response.status).json({ 
        error: `Failed to fetch: ${response.status} ${response.statusText}` 
      });
    }

    const contentType = response.headers.get('content-type') || '';

    // Handle HTML responses
    if (contentType.includes('text/html')) {
      let html = await response.text();
      const finalUrl = new URL(response.url);

      // Parse and modify HTML
      const serverOrigin = `${req.protocol}://${req.get('host')}`;
      html = injectObserverScript(html, finalUrl, throttleProfile, serverOrigin);
      
      // Set response headers (strip security headers)
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      
      // Apply bandwidth throttling via chunked response
      if (profile.bandwidth !== Infinity && profile.bandwidth > 0) {
        await sendThrottled(res, html, profile.bandwidth);
      } else {
        res.send(html);
      }
    } else {
      // For non-HTML, just proxy through
      const buffer = await response.arrayBuffer();
      
      res.setHeader('Content-Type', contentType);
      
      if (profile.bandwidth !== Infinity && profile.bandwidth > 0) {
        await sendThrottled(res, Buffer.from(buffer), profile.bandwidth);
      } else {
        res.send(Buffer.from(buffer));
      }
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
    res.setHeader('Access-Control-Allow-Origin', '*');

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
 * Inject the observer script and rewrite resource URLs to proxy
 * @param {string} html - Original HTML
 * @param {URL} baseUrl - Base URL for resolving relative URLs
 * @param {string} throttleProfile - Throttle profile for proxy-resource
 * @returns {string} Modified HTML
 */
function injectObserverScript(html, baseUrl, throttleProfile = 'none', serverOrigin = 'http://localhost:3001') {
  try {
    const $ = cheerioLoad(html);
    const base = baseUrl.origin + '/';

    // Add base tag for relative URL resolution
    const existingBase = $('base').attr('href');
    if (!existingBase) {
      $('head').prepend(`<base href="${base}">`);
    }

    // Rewrite resource URLs to route through proxy
    const proxyUrl = (url) => {
      try {
        const absolute = new URL(url, base).href;
        if (absolute.startsWith('data:') || absolute.startsWith('blob:') || absolute.startsWith('javascript:')) {
          return url;
        }
        return `${serverOrigin}/proxy-resource?url=${encodeURIComponent(absolute)}&throttle=${encodeURIComponent(throttleProfile)}`;
      } catch (e) {
        return url;
      }
    };

    // Remove native lazy loading so images don't wait for viewport intersection
    $('img[loading]').removeAttr('loading');

    // Rewrite img src and srcset
    $('img[src]').each((_, el) => {
      $(el).attr('src', proxyUrl($(el).attr('src')));
    });
    $('img[srcset]').each((_, el) => {
      const srcset = $(el).attr('srcset');
      const rewritten = srcset.split(',').map(part => {
        const [url, ...rest] = part.trim().split(/\s+/);
        return url ? proxyUrl(url) + (rest.length ? ' ' + rest.join(' ') : '') : part;
      }).join(', ');
      $(el).attr('srcset', rewritten);
    });

    // Rewrite link href (CSS, favicon, etc.)
    $('link[href]').each((_, el) => {
      const rel = ($(el).attr('rel') || '').toLowerCase();
      if (rel === 'stylesheet' || rel === 'icon' || rel === 'shortcut icon' || rel === 'preload' || rel === 'prefetch') {
        $(el).attr('href', proxyUrl($(el).attr('href')));
      }
    });

    // Rewrite script src (except our injected observer)
    $('script[src]').each((_, el) => {
      const src = $(el).attr('src');
      if (!src.includes('injected-observer.js')) {
        $(el).attr('src', proxyUrl(src));
      }
    });

    // Rewrite source tags (picture, video, audio)
    $('source[src]').each((_, el) => {
      $(el).attr('src', proxyUrl($(el).attr('src')));
    });

    // Rewrite video poster, object data
    $('video[poster]').each((_, el) => {
      $(el).attr('poster', proxyUrl($(el).attr('poster')));
    });
    $('object[data]').each((_, el) => {
      $(el).attr('data', proxyUrl($(el).attr('data')));
    });

    // Inject reset + hide BBC grey placeholders + hide scrollbar in webview
    const resetStyle = `<style id="proxy-reset">html,body{margin:0}img[src*="grey-placeholder"]{display:none!important}html,body,*{-ms-overflow-style:none!important;scrollbar-width:none!important}html::-webkit-scrollbar,body::-webkit-scrollbar,*::-webkit-scrollbar{display:none!important}</style>`;

    // Inject observer script as first script in head (absolute URL unaffected by base tag)
    const observerScript = `<script src="${serverOrigin}/injected-observer.js"></script>`;

    const head = $('head');
    if (head.length > 0) {
      head.prepend(resetStyle + observerScript);
    } else {
      const htmlTag = $('html');
      if (htmlTag.length > 0) {
        htmlTag.prepend(`<head>${observerScript}</head>`);
      } else {
        return observerScript + html;
      }
    }

    return $.html();
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
