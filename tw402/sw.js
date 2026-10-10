'use strict';

// A return-only scope and cache: never remove or serve TW401 outbound files.
const CACHE_PREFIX = 'tw402-return-flight-';
const CACHE_NAME = `${CACHE_PREFIX}v4-welcome-30min-20261010`;
const APP_SHELL = [
  './', './index.html', './TW402-flight-tracker.html', './manifest.webmanifest',
  './apple-touch-icon.png', './icon-192.png', './icon-512.png'
];
const SCOPE_URL = new URL('./', self.location.href);
const SHELL_URLS = APP_SHELL.map(path => new URL(path, SCOPE_URL).href);
const APP_URL = new URL('./TW402-flight-tracker.html', SCOPE_URL).href;
const ENTRY_URLS = new Set([SCOPE_URL.href, new URL('./index.html', SCOPE_URL).href, APP_URL]);

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(SHELL_URLS.map(url => new Request(url, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
      .map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== SCOPE_URL.origin || !url.pathname.startsWith(SCOPE_URL.pathname)) return;
  url.search = '';
  url.hash = '';
  // Cache only this explicit app shell. Source links and other pages stay network-only.
  if (!SHELL_URLS.includes(url.href)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(url.href);
    if (cached) return cached;
    try {
      const response = await fetch(request);
      if (response.ok && response.type === 'basic') await cache.put(url.href, response.clone());
      return response;
    } catch (error) {
      if (request.mode === 'navigate' && ENTRY_URLS.has(url.href)) {
        const fallback = await cache.match(APP_URL);
        if (fallback) return fallback;
      }
      throw error;
    }
  })());
});

self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
  if (event.data?.type === 'GET_CACHE_STATUS') {
    event.waitUntil((async () => {
      const cache = await caches.open(CACHE_NAME);
      const present = await Promise.all(SHELL_URLS.map(url => cache.match(url)));
      event.ports?.[0]?.postMessage({ type: 'CACHE_STATUS', ready: present.every(Boolean), version: CACHE_NAME });
    })());
  }
});

