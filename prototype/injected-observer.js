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

  // Fix: Override IntersectionObserver so lazy-loaded images fire immediately on observe().
  // BBC uses IntersectionObserver with a custom root div that doesn't correctly intersect
  // inside a scaled iframe, so images never auto-load without this override.
  try {
    const _NativeIO = window.IntersectionObserver;
    window.IntersectionObserver = function(cb, opts) {
      const io = new _NativeIO(cb, opts);
      const _origObserve = io.observe.bind(io);
      io.observe = function(target) {
        _origObserve(target);
        // Immediately fire the callback as if this element is intersecting
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
      console.warn('[ProgressBar Observer] Failed to post event:', e);
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
    const result = originalPushState.apply(this, args);
    postEvent('spa-navigate', {
      type: 'pushState',
      url: window.location.href
    });
    return result;
  };

  history.replaceState = function(...args) {
    const result = originalReplaceState.apply(this, args);
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

  // Error handling
  window.addEventListener('error', (e) => {
    if (e.target !== window) {
      // Resource error
      const target = e.target;
      postEvent('resource-error', {
        element: target.tagName?.toLowerCase() || 'unknown',
        src: target.src || target.href || 'unknown'
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
