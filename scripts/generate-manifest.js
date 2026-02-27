#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const CAPTURES_DIR = path.resolve(__dirname, '..', 'captures');
const OUTPUT_PATH = path.resolve(__dirname, '..', 'captures-manifest.json');

const SCREENSHOT_PATTERN = /^(first-paint|first-contentful-paint|lcp|above-fold-images-loaded|text-settled)-(\d+)ms\.png$/;

function buildManifest() {
  const entries = fs.readdirSync(CAPTURES_DIR, { withFileTypes: true });
  const manifest = {};

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const hostname = entry.name;
    const dirPath = path.join(CAPTURES_DIR, hostname);
    const files = fs.readdirSync(dirPath);

    const screenshots = [];
    let hasVideo = false;
    let hasEvents = false;

    for (const file of files) {
      if (file === 'video.mp4') {
        hasVideo = true;
        continue;
      }
      if (file === 'events.json') {
        hasEvents = true;
        continue;
      }

      const match = file.match(SCREENSHOT_PATTERN);
      if (match) {
        screenshots.push({
          type: match[1],
          timeMs: parseInt(match[2], 10),
          file: `captures/${hostname}/${file}`,
        });
      }
    }

    screenshots.sort((a, b) => a.timeMs - b.timeMs);

    manifest[hostname] = { screenshots, hasVideo, hasEvents };
  }

  return manifest;
}

const manifest = buildManifest();
fs.writeFileSync(OUTPUT_PATH, JSON.stringify(manifest, null, 2), 'utf8');

const hostnames = Object.keys(manifest);
const withScreenshots = hostnames.filter(h => manifest[h].screenshots.length > 0);
console.log(`Generated manifest: ${hostnames.length} sites, ${withScreenshots.length} with screenshots`);
console.log(`Output: ${OUTPUT_PATH}`);
