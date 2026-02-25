/**
 * Injected Observer Script
 * This script is injected into proxied pages to capture page load events
 * and post them to the parent frame via postMessage.
 */
(function() {
  'use strict';

  // Prevent double initialization
  if (window.__progressBarObserverInitialized) return;
  window.__progressBarObserverInitialized = true;

  // Hide scrollbar in webview (runs at inject time to override page styles)
  try {
    const style = document.createElement('style');
    style.id = 'progress-bar-hide-scrollbar';
    style.textContent = 'html,body,*{-ms-overflow-style:none!important;scrollbar-width:none!important}html::-webkit-scrollbar,body::-webkit-scrollbar,*::-webkit-scrollbar{display:none!important}';
    (document.head || document.documentElement).appendChild(style);
  } catch (e) {}

  // Preserve SSR content for Next.js / React sites. When hydration fails
  // (e.g. because window.location differs from the SSR origin), React tears
  // down all server-rendered DOM. We snapshot the SSR HTML at DOMContentLoaded
  // (which fires BEFORE the teardown) and restore it when we detect the
  // innerHTML has shrunk dramatically.
  try {
    document.addEventListener('DOMContentLoaded', () => {
      const nextRoot = document.getElementById('__next');
      if (!nextRoot) return;
      const ssrSnapshot = nextRoot.innerHTML;
      if (ssrSnapshot.length < 500) return;
      let restored = false;
      const watcher = new MutationObserver(() => {
        if (restored) return;
        const currentLen = nextRoot.innerHTML.length;
        if (currentLen < ssrSnapshot.length * 0.3) {
          restored = true;
          watcher.disconnect();
          nextRoot.innerHTML = ssrSnapshot;
        }
      });
      watcher.observe(nextRoot, { childList: true, subtree: true });
    });
  } catch (e) {}

  // Fix: Override IntersectionObserver so lazy-loaded images fire immediately on observe().
  // BBC uses IntersectionObserver with a custom root div that doesn't correctly intersect
  // inside a scaled iframe, so images never auto-load without this override.
  // Note: callback is deferred via setTimeout to avoid firing synchronously during a
  // React/Next.js render cycle, which would cause "client-side exception" errors.
  try {
    const _NativeIO = window.IntersectionObserver;
    window.IntersectionObserver = function(cb, opts) {
      const io = new _NativeIO(cb, opts);
      const _origObserve = io.observe.bind(io);
      io.observe = function(target) {
        _origObserve(target);
        // Only fire synthetic intersection for image elements — prevents
        // interference with React/framework IntersectionObserver usage
        // (Suspense, lazy components) which would cause hydration errors.
        if (target.tagName === 'IMG' || (target.querySelector && target.querySelector('img'))) {
          setTimeout(() => {
            try {
              const rect = target.getBoundingClientRect();
              cb([{
                target,
                isIntersecting: true,
                intersectionRatio: 1,
                boundingClientRect: rect,
                intersectionRect: rect,
                rootBounds: null,
                time: performance.now()
              }], io);
            } catch(e) {}
          }, 0);
        }
      };
      return io;
    };
    Object.setPrototypeOf(window.IntersectionObserver, _NativeIO);
  } catch(e) {}

  const navigationStart = performance.timing.navigationStart || performance.timeOrigin || Date.now();
  let lastEventTime = 0;

  // Raw mode: WebView progress simulation state
  let resourcesDiscovered = 0;
  let resourcesCompleted = 0;
  let lastEmittedProgress = 0;
  let progressPollingActive = false;
  let progressRafId = null;
  const progressStartTime = performance.now();

  // Mutation batching state
  let mutationBatchTimeout = null;
  let pendingMutations = {
    nodesAdded: 0,
    textNodes: 0,
    headingNodes: 0
  };
  const MUTATION_BATCH_DELAY = 100;

  // Text-settled detection state
  let textSettledTimeout = null;
  let textSettledEmitted = false;
  let domReady = false;
  const TEXT_SETTLE_DELAY = 500;

  // Above-fold image tracking state
  let aboveFoldEmitted = false;

  // Paint event fallback state (Paint Timing API doesn't fire inside iframes)
  let firstPaintEmitted = false;
  let fcpEmitted = false;
  let lcpEmitted = false;
  let firstElementSeen = false;
  let firstContentSeen = false;
  let lcpCandidate = null;

  function getRelativeTime() {
    return Math.round(performance.now());
  }

  function postEvent(type, data = {}, timeOverride) {
    const time = timeOverride !== undefined ? timeOverride : getRelativeTime();
    const delta = time - lastEventTime;
    lastEventTime = time;

    const event = {
      type,
      time,
      delta,
      data
    };

    try {
      window.parent.postMessage({
        source: 'progress-bar-observer',
        event
      }, '*');
    } catch (e) {
      try {
        window.parent.postMessage({
          source: 'progress-bar-observer',
          event: JSON.parse(JSON.stringify(event))
        }, '*');
      } catch (e2) {}
    }
  }

  // Navigation start
  postEvent('navigation-start', {
    url: window.location.href
  });

  // Early first-byte detection via Navigation Timing
  try {
    const responseStart = performance.timing?.responseStart;
    if (responseStart > 0) {
      postEvent('nav-response-start', {}, Math.round(responseStart - navigationStart));
    }
  } catch (e) {}

  // DOM Content Loaded
  function onDomReady() {
    postEvent('dom-ready');
    domReady = true;

    // Kick off text-settled timer (will be reset by incoming text mutations)
    if (!textSettledEmitted) {
      textSettledTimeout = setTimeout(() => {
        if (!textSettledEmitted) {
          textSettledEmitted = true;
          postEvent('text-settled');
        }
      }, TEXT_SETTLE_DELAY);
    }

    // Above-fold image tracking
    if (!aboveFoldEmitted) {
      trackAboveFoldImages();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', onDomReady);
  } else {
    onDomReady();
  }

  function trackAboveFoldImages() {
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    const imgs = Array.from(document.querySelectorAll('img')).filter(img => {
      const rect = img.getBoundingClientRect();
      return rect.top < viewportHeight;
    });

    if (imgs.length === 0) {
      aboveFoldEmitted = true;
      postEvent('above-fold-images-loaded', { count: 0 });
      return;
    }

    let remaining = imgs.filter(img => !img.complete).length;

    if (remaining === 0) {
      aboveFoldEmitted = true;
      postEvent('above-fold-images-loaded', { count: imgs.length });
      return;
    }

    function onImageDone() {
      remaining--;
      if (remaining <= 0 && !aboveFoldEmitted) {
        aboveFoldEmitted = true;
        postEvent('above-fold-images-loaded', { count: imgs.length });
      }
    }

    for (const img of imgs) {
      if (img.complete) continue;
      img.addEventListener('load', onImageDone, { once: true });
      img.addEventListener('error', onImageDone, { once: true });
    }
  }

  // Simulates Android's webView.progress — an integer 0-100 that increases
  // gradually as the main document and subresources load. Two components:
  //
  //  1. Main doc phase (0-50%): time-based exponential approach curve.
  //     The real webView.progress tracks response streaming internally;
  //     since our observer runs inside the page we approximate this with
  //     a time curve that ramps quickly at first, then decelerates.
  //
  //  2. Subresource phase (0-40%): logarithmic growth driven by completed
  //     resource count. Produces diminishing increments per resource —
  //     early resources push progress significantly, later ones less so.
  //     Capped at 40% so total never exceeds 90% before window.load.
  //
  // The bar's FIXED_PROGRESS clamp (50%) is applied by the progress bar
  // itself, so we report raw 0-100 values here. The bar typically stalls
  // around 85-90%, matching the real Android behaviour.
  function calculateWebViewProgress() {
    const elapsed = performance.now() - progressStartTime;

    const timePct = 50 * (1 - Math.exp(-elapsed / 500));

    const resPct = resourcesCompleted > 0
      ? Math.min(40, 15 * Math.log2(resourcesCompleted + 1))
      : 0;

    return Math.min(Math.round(timePct + resPct), 90);
  }

  function tickProgress() {
    if (!progressPollingActive) return;

    const progress = calculateWebViewProgress();

    if (progress !== lastEmittedProgress) {
      const delta = progress - lastEmittedProgress;
      postEvent('progress-update', {
        value: progress,
        delta
      });
      lastEmittedProgress = progress;
    }

    progressRafId = requestAnimationFrame(tickProgress);
  }

  function startProgressPolling() {
    progressPollingActive = true;
    lastEmittedProgress = 0;
    tickProgress();
  }

  function stopProgressPolling() {
    progressPollingActive = false;
    if (progressRafId) {
      cancelAnimationFrame(progressRafId);
      progressRafId = null;
    }
  }

  // Start progress polling immediately (navigation started)
  startProgressPolling();

  // Window Load
  window.addEventListener('load', () => {
    // Fallback LCP: emit best candidate if native observer never fired
    if (!lcpEmitted && lcpCandidate) {
      lcpEmitted = true;
      postEvent('lcp', {
        startTime: lcpCandidate.startTime,
        size: lcpCandidate.size,
        element: lcpCandidate.element,
        synthetic: true
      });
    }

    // Emit navigation timing events for DDG default mode event panel
    try {
      const navEntries = performance.getEntriesByType('navigation');
      const nav = navEntries[0];
      if (nav) {
        postEvent('nav-fetch-start', { value: 0 }, nav.fetchStart);
        postEvent('nav-response-start', {}, nav.responseStart);
        postEvent('nav-response-end', {}, nav.responseEnd);
        if (nav.redirectCount > 0) {
          postEvent('redirect-chain', {
            count: nav.redirectCount,
            totalRedirectTime: nav.redirectEnd - nav.redirectStart
          });
        }
      }
    } catch (e) {}

    stopProgressPolling();

    // webView.progress reaching 100 — emit the value that triggers
    // progressChanged(100) on the DDG bar side.
    if (lastEmittedProgress < 100) {
      postEvent('progress-update', {
        value: 100,
        delta: 100 - lastEmittedProgress
      });
      lastEmittedProgress = 100;
    }

    postEvent('progress-complete', {});
    postEvent('window-load');
  });

  // Paint Observer (first-paint, first-contentful-paint)
  try {
    const paintObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.name === 'first-paint' && !firstPaintEmitted) {
          firstPaintEmitted = true;
          postEvent('first-paint', {
            startTime: Math.round(entry.startTime)
          });
        } else if (entry.name === 'first-contentful-paint' && !fcpEmitted) {
          fcpEmitted = true;
          postEvent('first-contentful-paint', {
            startTime: Math.round(entry.startTime)
          });
        }
      }
    });
    paintObserver.observe({ type: 'paint', buffered: true });
  } catch (e) {
    console.warn('[ProgressBar Observer] Paint observer not supported:', e);
  }

  // Largest Contentful Paint Observer
  try {
    const lcpObserver = new PerformanceObserver((list) => {
      const entries = list.getEntries();
      const lastEntry = entries[entries.length - 1];
      if (lastEntry) {
        lcpEmitted = true;
        postEvent('lcp', {
          startTime: Math.round(lastEntry.startTime),
          size: lastEntry.size,
          element: lastEntry.element?.tagName || 'unknown'
        });
      }
    });
    lcpObserver.observe({ type: 'largest-contentful-paint', buffered: true });
  } catch (e) {
    console.warn('[ProgressBar Observer] LCP observer not supported:', e);
  }

  // Resource Observer
  try {
    const resourceObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        resourcesDiscovered++;
        const resourceType = getResourceType(entry);
        postEvent('resource-start', {
          resourceType: entry.initiatorType,
          name: truncateUrl(entry.name)
        });
        postEvent(`resource-${resourceType}`, {
          name: truncateUrl(entry.name),
          duration: Math.round(entry.duration),
          transferSize: entry.transferSize || 0,
          initiatorType: entry.initiatorType
        });
        postEvent('resource-complete', {
          resourceType: entry.initiatorType,
          transferSize: entry.transferSize || 0,
          duration: Math.round(entry.duration)
        });
        resourcesCompleted++;
      }
    });
    resourceObserver.observe({ type: 'resource', buffered: true });
  } catch (e) {
    console.warn('[ProgressBar Observer] Resource observer not supported:', e);
  }

  function getResourceType(entry) {
    const initiator = entry.initiatorType;
    if (initiator === 'img' || initiator === 'image') return 'img';
    if (initiator === 'script') return 'script';
    if (initiator === 'css' || initiator === 'link') return 'css';
    if (initiator === 'fetch' || initiator === 'xmlhttprequest') return 'fetch';
    if (initiator === 'video' || initiator === 'audio') return 'media';
    return 'other';
  }

  function truncateUrl(url) {
    try {
      const parsed = new URL(url);
      const path = parsed.pathname;
      if (path.length > 40) {
        return '...' + path.slice(-37);
      }
      return parsed.pathname + parsed.search.slice(0, 20);
    } catch (e) {
      return url.slice(-40);
    }
  }

  // Mutation Observer with batching
  function flushMutationBatch() {
    const hadText = pendingMutations.textNodes > 0;
    if (pendingMutations.nodesAdded > 0) {
      postEvent('mutation-nodes', {
        nodesAdded: pendingMutations.nodesAdded,
        textNodes: pendingMutations.textNodes,
        headingNodes: pendingMutations.headingNodes
      });
    }
    pendingMutations = { nodesAdded: 0, textNodes: 0, headingNodes: 0 };
    mutationBatchTimeout = null;

    // Reset text-settled timer whenever text nodes arrive after DOM ready
    if (hadText && domReady && !textSettledEmitted) {
      if (textSettledTimeout) clearTimeout(textSettledTimeout);
      textSettledTimeout = setTimeout(() => {
        if (!textSettledEmitted) {
          textSettledEmitted = true;
          postEvent('text-settled');
        }
      }, TEXT_SETTLE_DELAY);
    }
  }

  try {
    const mutationObserver = new MutationObserver((mutations) => {
      let nodesAdded = 0;
      let textNodes = 0;
      let headingNodes = 0;
      let hasImageNode = false;

      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          for (const node of mutation.addedNodes) {
            nodesAdded++;
            
            if (node.nodeType === Node.TEXT_NODE && node.textContent.trim().length > 0) {
              textNodes++;
            } else if (node.nodeType === Node.ELEMENT_NODE) {
              const tagName = node.tagName?.toLowerCase() || '';
              if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'article', 'main'].includes(tagName)) {
                headingNodes++;
              }
              const textContent = node.textContent?.trim() || '';
              if (textContent.length > 20) {
                textNodes++;
              }

              // Track images for LCP fallback
              const images = tagName === 'img' ? [node] : Array.from(node.querySelectorAll?.('img') || []);
              for (const img of images) {
                hasImageNode = true;
                img.addEventListener('load', () => {
                  const size = (img.naturalWidth || 0) * (img.naturalHeight || 0);
                  if (size > 0 && (!lcpCandidate || size > lcpCandidate.size)) {
                    lcpCandidate = {
                      startTime: Math.round(performance.now()),
                      size,
                      element: 'IMG'
                    };
                  }
                });
              }

              // Track large text blocks as LCP candidates
              if (textContent.length > 100) {
                const rect = node.getBoundingClientRect?.();
                const size = rect ? rect.width * rect.height : textContent.length * 100;
                if (size > 0 && (!lcpCandidate || size > lcpCandidate.size)) {
                  lcpCandidate = {
                    startTime: Math.round(performance.now()),
                    size: Math.round(size),
                    element: node.tagName || 'TEXT'
                  };
                }
              }
            }
          }
        }
      }

      // Fallback first-paint: first visible element added to DOM
      if (!firstElementSeen && nodesAdded > 0) {
        firstElementSeen = true;
        requestAnimationFrame(() => requestAnimationFrame(() => {
          if (!firstPaintEmitted) {
            firstPaintEmitted = true;
            postEvent('first-paint', {
              startTime: Math.round(performance.now()),
              synthetic: true
            });
          }
        }));
      }

      // Fallback first-contentful-paint: first text or image content added
      if (!firstContentSeen && (textNodes > 0 || hasImageNode)) {
        firstContentSeen = true;
        requestAnimationFrame(() => requestAnimationFrame(() => {
          if (!fcpEmitted) {
            fcpEmitted = true;
            postEvent('first-contentful-paint', {
              startTime: Math.round(performance.now()),
              synthetic: true
            });
          }
        }));
      }

      pendingMutations.nodesAdded += nodesAdded;
      pendingMutations.textNodes += textNodes;
      pendingMutations.headingNodes += headingNodes;

      // Debounce mutation events
      if (!mutationBatchTimeout) {
        mutationBatchTimeout = setTimeout(flushMutationBatch, MUTATION_BATCH_DELAY);
      }
    });

    mutationObserver.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  } catch (e) {
    console.warn('[ProgressBar Observer] Mutation observer failed:', e);
  }

  // SPA Navigation (History API interception)
  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;

  history.pushState = function(...args) {
    let result;
    try {
      result = originalPushState.apply(this, args);
    } catch(e) {
      // SecurityError: site passed a cross-origin absolute URL (e.g. while proxied) — ignore
    }
    postEvent('spa-navigate', {
      type: 'pushState',
      url: window.location.href
    });
    return result;
  };

  history.replaceState = function(...args) {
    let result;
    try {
      result = originalReplaceState.apply(this, args);
    } catch(e) {
      // SecurityError: site passed a cross-origin absolute URL (e.g. while proxied) — ignore
    }
    postEvent('spa-navigate', {
      type: 'replaceState',
      url: window.location.href
    });
    return result;
  };

  window.addEventListener('popstate', () => {
    postEvent('spa-navigate', {
      type: 'popstate',
      url: window.location.href
    });
  });

  // Rewrite all external resource URLs to go through the proxy.
  // Uses prototype-level overrides so every script/link element is covered
  // regardless of how it was created (createElement, innerHTML, etc.).
  try {
    const _proxyOrigin = window.location.origin;
    const _proxyThrottle = new URLSearchParams(window.location.search).get('throttle') || 'none';

    function _rewriteToProxy(url) {
      try {
        const abs = new URL(url, document.baseURI).href;
        if (abs.startsWith('data:') || abs.startsWith('blob:') || abs.startsWith('javascript:')) return url;
        if (abs.startsWith(_proxyOrigin)) return url;
        return _proxyOrigin + '/proxy-resource?url=' + encodeURIComponent(abs) + '&throttle=' + encodeURIComponent(_proxyThrottle);
      } catch(e) { return url; }
    }

    function _needsRewrite(url) {
      if (!url || typeof url !== 'string') return false;
      return !url.startsWith(_proxyOrigin) && !url.includes('/proxy-resource') && !url.includes('localhost') && !url.includes('127.0.0.1') && !url.startsWith('data:') && !url.startsWith('blob:') && !url.startsWith('javascript:');
    }

    // Override HTMLScriptElement.prototype.src at the prototype level
    const _scriptSrcDesc = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, 'src');
    if (_scriptSrcDesc && _scriptSrcDesc.set) {
      Object.defineProperty(HTMLScriptElement.prototype, 'src', {
        set(v) {
          if (_needsRewrite(v)) {
            v = _rewriteToProxy(v);
          }
          _scriptSrcDesc.set.call(this, v);
        },
        get() { return _scriptSrcDesc.get.call(this); },
        configurable: true, enumerable: true
      });
    }

    // Override HTMLLinkElement.prototype.href at the prototype level
    const _linkHrefDesc = Object.getOwnPropertyDescriptor(HTMLLinkElement.prototype, 'href');
    if (_linkHrefDesc && _linkHrefDesc.set) {
      Object.defineProperty(HTMLLinkElement.prototype, 'href', {
        set(v) {
          if (_needsRewrite(v)) {
            v = _rewriteToProxy(v);
          }
          _linkHrefDesc.set.call(this, v);
        },
        get() { return _linkHrefDesc.get.call(this); },
        configurable: true, enumerable: true
      });
    }

    // Override setAttribute for script src and link href
    const _origSetAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function(name, value) {
      if ((this instanceof HTMLScriptElement && name === 'src' && _needsRewrite(value)) ||
          (this instanceof HTMLLinkElement && name === 'href' && _needsRewrite(value))) {
        value = _rewriteToProxy(value);
      }
      return _origSetAttribute.call(this, name, value);
    };

    // Intercept fetch() to rewrite external URLs through the proxy
    const _origFetch = window.fetch;
    window.fetch = function(input, init) {
      try {
        let url = typeof input === 'string' ? input : (input instanceof Request ? input.url : '');
        if (_needsRewrite(url)) {
          const rewritten = _rewriteToProxy(url);
          if (typeof input === 'string') {
            input = rewritten;
          } else if (input instanceof Request) {
            input = new Request(rewritten, input);
          }
        }
      } catch(e) {}
      return _origFetch.call(this, input, init);
    };
  } catch(e) {}

  // Error handling
  window.addEventListener('error', (e) => {
    if (e.target !== window) {
      const target = e.target;
      const src = target.src || target.href || 'unknown';
      postEvent('resource-error', {
        element: target.tagName?.toLowerCase() || 'unknown',
        src
      });
    }
  }, true);


  // Unhandled rejection (for fetch errors etc.)
  window.addEventListener('unhandledrejection', (e) => {
    postEvent('resource-error', {
      type: 'promise',
      reason: String(e.reason).slice(0, 100)
    });
  });


})();
