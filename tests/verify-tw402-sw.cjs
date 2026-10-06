#!/usr/bin/env node
'use strict';

// Dependency-free service-worker contract tests. The event/cache model is mocked;
// real browser installation, storage persistence and offline reload need browser QA.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '..');
const SCOPE = 'https://example.test/tw401-flight-tracker/tw402/';
const PREFIX = 'tw402-return-flight-';
const APP = new URL('TW402-flight-tracker.html', SCOPE).href;
const SHELL = ['./', './index.html', './TW402-flight-tracker.html', './manifest.webmanifest', './apple-touch-icon.png', './icon-192.png', './icon-512.png'].map(value => new URL(value, SCOPE).href);
let passed = 0;
let failed = 0;
async function check(name, run) {
  try { await run(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}: ${error.message}`); }
}
class MockRequest {
  constructor(value, options = {}) {
    this.url = typeof value === 'string' ? new URL(value, SCOPE).href : value.url;
    this.method = options.method || value.method || 'GET';
    this.mode = options.mode || value.mode || 'cors';
    this.cache = options.cache || value.cache || 'default';
  }
}
function response(body, options = {}) {
  return { body, ok: options.ok ?? true, type: options.type || 'basic', clone() { return response(body, options); } };
}
function urlKey(value) { return typeof value === 'string' ? new URL(value, SCOPE).href : value.url; }
function fixture(options = {}) {
  const listeners = new Map();
  const storage = new Map();
  const deleted = [];
  const networkCalls = [];
  const added = [];
  const opened = [];
  let network = async request => response(`network ${request.url}`);
  let skips = 0;
  let claims = 0;
  function cacheFor(name) {
    if (!storage.has(name)) storage.set(name, new Map());
    const data = storage.get(name);
    return {
      async addAll(requests) {
        added.push(...requests);
        if (options.failInstall) throw new Error('intentional incomplete download');
        for (const request of requests) data.set(urlKey(request), response(`cached ${urlKey(request)}`));
      },
      async match(request, matchOptions = {}) {
        const key = urlKey(request);
        if (!matchOptions.ignoreSearch) return data.get(key);
        const target = new URL(key); target.search = '';
        return [...data.entries()].find(([stored]) => { const candidate = new URL(stored); candidate.search = ''; return candidate.href === target.href; })?.[1];
      },
      async put(request, value) { data.set(urlKey(request), value); }
    };
  }
  const caches = {
    async open(name) { opened.push(name); return cacheFor(name); },
    async keys() { return [...storage.keys()]; },
    async delete(name) { deleted.push(name); return storage.delete(name); }
  };
  const self = {
    location: new URL('sw.js', SCOPE),
    addEventListener(type, callback) { assert(!listeners.has(type), `duplicate ${type} handler`); listeners.set(type, callback); },
    async skipWaiting() { skips++; },
    clients: { async claim() { claims++; } }
  };
  const context = vm.createContext({ self, caches, URL, Request: MockRequest, fetch: async request => { networkCalls.push(request); return network(request); } });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'tw402/sw.js'), 'utf8'), context, { filename: 'tw402/sw.js', timeout: 10000 });
  return {
    listeners, storage, deleted, added, opened, networkCalls,
    get currentName() { return opened.find(name => name.startsWith(PREFIX)); },
    get current() { return storage.get(this.currentName); },
    get skips() { return skips; }, get claims() { return claims; },
    setNetwork(callback) { network = callback; },
    async lifecycle(type, extra = {}) {
      const work = [];
      listeners.get(type)({ ...extra, waitUntil(promise) { work.push(Promise.resolve(promise)); } });
      await Promise.all(work);
    },
    async request(value, options = {}) {
      let result;
      let handled = false;
      const request = new MockRequest(value, options);
      listeners.get('fetch')({ request, respondWith(promise) { assert(!handled); handled = true; result = promise; } });
      return { handled, response: handled ? await result : undefined };
    }
  };
}

(async () => {
  const sw = fixture();
  await check('install caches all seven local assets with reload requests before skipWaiting', async () => {
    await sw.lifecycle('install');
    assert(sw.currentName.startsWith(PREFIX));
    assert.deepEqual(sw.added.map(request => request.url).sort(), [...SHELL].sort());
    assert(sw.added.every(request => request.cache === 'reload'));
    assert.equal(sw.current.size, SHELL.length);
    assert.equal(sw.skips, 1);
    for (const url of SHELL) {
      const relative = new URL(url).pathname.slice(new URL(SCOPE).pathname.length);
      assert(fs.existsSync(path.join(ROOT, 'tw402', relative)), `missing app-shell file ${relative}`);
    }
  });
  await check('failed install does not activate an incomplete shell', async () => {
    const broken = fixture({ failInstall: true });
    await assert.rejects(() => broken.lifecycle('install'), /incomplete download/);
    assert.equal(broken.skips, 0);
  });
  await check('activation removes only stale return caches and keeps TW401 and unrelated caches', async () => {
    const keep = ['tw401-flight-tracker-v2-20260926', 'unrelated-app-v1', 'tw402-return-flightish-v1'];
    for (const name of [...keep, `${PREFIX}old`, `${PREFIX}older`]) sw.storage.set(name, new Map());
    await sw.lifecycle('activate');
    assert.deepEqual(sw.deleted.sort(), [`${PREFIX}old`, `${PREFIX}older`].sort());
    assert(sw.storage.has(sw.currentName));
    assert(keep.every(name => sw.storage.has(name)));
    assert.equal(sw.claims, 1);
  });
  await check('offline app-shell hits work without a network call', async () => {
    sw.setNetwork(async () => { throw new Error('offline'); });
    const previousCalls = sw.networkCalls.length;
    for (const url of SHELL) {
      const result = await sw.request(url, { mode: url.endsWith('.html') || url.endsWith('/') ? 'navigate' : 'cors' });
      assert.equal(result.handled, true);
      assert.equal(result.response.body, `cached ${url}`);
    }
    assert.equal(sw.networkCalls.length, previousCalls);
  });
  await check('PWA start query and cache-busting queries reuse canonical cached app shell', async () => {
    for (const url of [APP + '?source=pwa', APP + '?v=123&source=homescreen', APP + '?x=1#map', SCOPE + '?source=pwa', new URL('icon-192.png?v=2', SCOPE).href]) {
      const result = await sw.request(url, { mode: 'navigate' });
      assert(result.handled);
      const canonical = new URL(url); canonical.search = ''; canonical.hash = '';
      assert.equal(result.response.body, `cached ${canonical.href}`);
    }
  });
  await check('TW401 outbound, sibling, cross-origin, unknown and non-GET requests are not intercepted', async () => {
    const urls = [
      new URL('../', SCOPE).href,
      new URL('../TW401-flight-tracker.html', SCOPE).href,
      new URL('../manifest.webmanifest', SCOPE).href,
      new URL('../icon-192.png', SCOPE).href,
      new URL('../tw402-evil/TW402-flight-tracker.html', SCOPE).href,
      new URL('unknown.html', SCOPE).href,
      new URL('sources.html', SCOPE).href,
      new URL('nested/TW402-flight-tracker.html', SCOPE).href,
      SCOPE.replace('example.test', 'foreign.test') + 'TW402-flight-tracker.html',
      'https://example.test/unrelated/'
    ];
    const previousCalls = sw.networkCalls.length;
    const previousOpens = sw.opened.length;
    for (const url of urls) assert.equal((await sw.request(url, { mode: 'navigate' })).handled, false, url);
    for (const method of ['POST', 'PUT', 'DELETE', 'HEAD']) assert.equal((await sw.request(APP, { method })).handled, false, method);
    assert.equal(sw.networkCalls.length, previousCalls);
    assert.equal(sw.opened.length, previousOpens);
  });
  await check('missing entry cache falls back to TW402 for scoped offline navigation', async () => {
    const index = new URL('index.html', SCOPE).href;
    const prior = sw.current.get(index);
    sw.current.delete(index);
    const result = await sw.request(index + '?source=pwa', { mode: 'navigate' });
    assert.equal(result.response.body, `cached ${APP}`);
    sw.current.set(index, prior);
  });
  await check('missing assets never receive an HTML navigation fallback', async () => {
    const icon = new URL('icon-192.png', SCOPE).href;
    const prior = sw.current.get(icon);
    sw.current.delete(icon);
    await assert.rejects(() => sw.request(icon), /offline/);
    await assert.rejects(() => sw.request(icon, { mode: 'navigate' }), /offline/);
    sw.current.set(icon, prior);
  });
  await check('successful basic network misses are cached with normalized URLs', async () => {
    const icon = new URL('icon-512.png', SCOPE).href;
    sw.current.delete(icon);
    sw.setNetwork(async () => response('fresh icon'));
    const result = await sw.request(icon + '?cache=bust');
    assert.equal(result.response.body, 'fresh icon');
    assert.equal(sw.current.get(icon).body, 'fresh icon');
    assert(!sw.current.has(icon + '?cache=bust'));
    sw.setNetwork(async () => { throw new Error('offline'); });
    assert.equal((await sw.request(icon + '?other=value')).response.body, 'fresh icon');
  });
  await check('HTTP errors and opaque responses are returned without poisoning cache', async () => {
    const icon = new URL('icon-512.png', SCOPE).href;
    const prior = sw.current.get(icon);
    for (const options of [{ ok: false, type: 'basic' }, { ok: true, type: 'opaque' }]) {
      sw.current.delete(icon);
      sw.setNetwork(async () => response('uncacheable', options));
      assert.equal((await sw.request(icon)).response.body, 'uncacheable');
      assert(!sw.current.has(icon));
    }
    sw.current.set(icon, prior);
  });
  await check('offline cache status verifies all seven assets and identifies return cache version', async () => {
    const messages = [];
    const ports = [{ postMessage: data => messages.push(data) }];
    await sw.lifecycle('message', { data: { type: 'GET_CACHE_STATUS' }, ports });
    assert.equal(messages[0].type, 'CACHE_STATUS');
    assert.equal(messages[0].ready, true);
    assert.equal(messages[0].version, sw.currentName);
    const icon = new URL('apple-touch-icon.png', SCOPE).href;
    const prior = sw.current.get(icon); sw.current.delete(icon);
    await sw.lifecycle('message', { data: { type: 'GET_CACHE_STATUS' }, ports });
    assert.equal(messages[1].ready, false);
    sw.current.set(icon, prior);
    await sw.lifecycle('message', { data: { type: 'GET_CACHE_STATUS' } });
  });
  await check('explicit skip-waiting message is supported and unrelated messages do nothing', async () => {
    const prior = sw.skips;
    await sw.lifecycle('message', { data: { type: 'UNKNOWN' } });
    assert.equal(sw.skips, prior);
    await sw.lifecycle('message', { data: { type: 'SKIP_WAITING' } });
    assert.equal(sw.skips, prior + 1);
  });
  console.log(`\nService-worker mock regression groups: ${passed} passed, ${failed} failed`);
  console.log('Coverage note: a real browser must still verify actual install, lifecycle, persistence, and offline reload.');
  process.exitCode = failed ? 1 : 0;
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
