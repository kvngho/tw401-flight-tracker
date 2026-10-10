#!/usr/bin/env node
'use strict';

// Dependency-free execution/regression checks. This is a deliberately small
// DOM contract stub, not a substitute for visual or genuine-browser PWA QA.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '..');
const DEPARTURE = Date.parse('2026-10-10T18:30:00Z');
const ARRIVAL = Date.parse('2026-10-11T06:40:00Z');
const DURATION = 730 * 60 * 1000;
let passed = 0;
let failed = 0;
async function check(name, run) {
  try { await run(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}: ${error.message}`); }
}
function makeNode(tag = 'div', attributes = {}) {
  const listeners = new Map();
  const classes = new Set((attributes.class || '').split(/\s+/).filter(Boolean));
  const style = {};
  style.setProperty = (name, value) => { style[name] = String(value); };
  const node = {
    tagName: tag.toUpperCase(), attributes: { ...attributes }, dataset: {},
    style, children: [], textContent: '', value: attributes.value || '',
    classList: {
      toggle(name, force) { const add = force === undefined ? !classes.has(name) : force; if (add) classes.add(name); else classes.delete(name); return add; },
      contains(name) { return classes.has(name); }
    },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return this.attributes[name] ?? null; },
    append(...children) { this.children.push(...children); },
    addEventListener(type, callback) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(callback); },
    dispatch(type, data = {}) { for (const callback of listeners.get(type) || []) callback({ target: this, ...data }); }
  };
  for (const [key, value] of Object.entries(attributes)) if (key.startsWith('data-')) node.dataset[key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
  return node;
}
function loadTracker(relative, now = DEPARTURE - 3600000) {
  const filename = path.join(ROOT, relative);
  const html = fs.readFileSync(filename, 'utf8');
  const nodes = new Map();
  const presets = [];
  for (const match of html.matchAll(/<([a-z][\w:-]*)\b([^>]*)>/gi)) {
    const attributes = {};
    for (const attribute of match[2].matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attributes[attribute[1]] = attribute[2] ?? attribute[3];
    if (!attributes.id && !attributes['data-preset']) continue;
    const node = makeNode(match[1], attributes);
    if (attributes.id) { assert(!nodes.has(attributes.id), `duplicate id ${attributes.id}`); nodes.set(attributes.id, node); }
    if (attributes['data-preset']) presets.push(node);
  }
  const document = {
    ...makeNode('document'), readyState: 'complete', body: makeNode('body'),
    getElementById(id) { assert(nodes.has(id), `script requested missing DOM id ${id}`); return nodes.get(id); },
    querySelectorAll(selector) { assert.equal(selector, '[data-preset]'); return presets; },
    createElementNS(namespace, tag) { assert.equal(namespace, 'http://www.w3.org/2000/svg'); return makeNode(tag); }
  };
  let clock = now;
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock])); }
    static now() { return clock; }
  }
  const navigator = { onLine: true };
  const intervals = [];
  const window = makeNode('window');
  Object.assign(window, { navigator, isSecureContext: true, matchMedia: () => ({ matches: false }), setInterval(callback, delay) { intervals.push({ callback, delay }); return intervals.length; } });
  const location = { protocol: 'file:', href: `file://${filename}` };
  const errors = [];
  class TestMessageChannel {
    constructor() {
      this.port1 = { onmessage: null, close() {} };
      this.port2 = { postMessage: data => queueMicrotask(() => this.port1.onmessage?.({ data })) };
    }
  }
  const context = vm.createContext({ document, window, navigator, location, Date: ClockDate, Intl, URL, MessageChannel: TestMessageChannel, setTimeout, clearTimeout, console: { ...console, error: (...args) => errors.push(args) } });
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  assert.equal(scripts.length, 1, 'single standalone script');
  assert(!/\bsrc\s*=/.test(scripts[0][1]), 'no external JavaScript dependency');
  vm.runInContext(scripts[0][2], context, { filename, timeout: 10000 });
  return { html, window, document, navigator, location, nodes, presets, intervals, errors, api: window.__flightTracker, setClock: value => { clock = value; } };
}
function near(actual, expected, tolerance = 1e-6) { assert(Math.abs(actual - expected) <= tolerance, `${actual} ≉ ${expected}`); }
function node(app, id) { return app.nodes.get(id); }
function slider(app, time) { node(app, 'timeSlider').value = String(time); node(app, 'timeSlider').dispatch('input'); }
function click(app, preset) { const button = app.presets.find(n => n.dataset.preset === preset); assert(button, `missing ${preset} button`); button.dispatch('click'); }

(async () => {
  const app = loadTracker('tw402/TW402-flight-tracker.html');
  const { api } = app;
  await check('Welcome uses only device clock, never simulation, and resumes offline', () => {
    const start = ARRIVAL - 30 * 60 * 1000;
    assert.equal(start, Date.parse('2026-10-11T15:10:00+09:00'));
    assert.equal(app.api.constants.WELCOME_START_MS, start);
    assert.equal(app.presets.some(button => button.dataset.preset === 'welcome'), false);
    assert.equal(app.nodes.has('welcomePreview'), false);
    assert.equal(app.nodes.has('welcomeDeviceTime'), false);
    for (const [time, hidden] of [[start - 1, true], [start, false], [start + 1, false], [ARRIVAL, false], [ARRIVAL + 86400000, false]]) {
      app.setClock(time);
      click(app, 'device');
      assert.equal(node(app, 'welcomeHome').hidden, hidden);
      for (const preset of ['before', '25', '50', '75', 'after']) {
        click(app, preset);
        assert.equal(node(app, 'welcomeHome').hidden, true, `hidden for ${preset}`);
      }
      for (const simulatedTime of [start, ARRIVAL, ARRIVAL + 3600000]) {
        slider(app, simulatedTime);
        assert.equal(node(app, 'welcomeHome').hidden, true);
      }
      click(app, 'device');
      assert.equal(node(app, 'welcomeHome').hidden, hidden);
    }
    app.setClock(start - 1);
    app.api.render(ARRIVAL);
    assert.equal(node(app, 'welcomeHome').hidden, true, 'render argument cannot reveal greeting');
    app.setClock(start);
    app.navigator.onLine = false;
    app.window.dispatch('pageshow');
    assert.equal(node(app, 'welcomeHome').hidden, false);
    click(app, 'after');
    app.document.dispatch('visibilitychange');
    assert.equal(node(app, 'welcomeHome').hidden, true);
    click(app, 'device');
    assert.equal(node(app, 'welcomeHome').hidden, false);
    app.setClock(DEPARTURE - 3600000);
    app.navigator.onLine = true;
    app.api.render();
  });
  await check('TW402 built-in self-tests: 39/39', () => {
    const result = app.window.__TW402_SELF_TEST__;
    assert.equal(result.total, 39);
    assert.equal(result.passed, result.total, result.tests.filter(t => !t.pass).map(t => t.name).join(', '));
    assert.equal(node(app, 'testResult').textContent, 'SELF-TEST 39/39 PASS');
    assert(Object.isFrozen(result));
  });
  await check('outbound TW401 remains 23/23', () => {
    const original = loadTracker('TW401-flight-tracker.html');
    const result = original.window.__TW401_SELF_TEST__;
    assert.equal(result.total, 23);
    assert.equal(result.passed, 23, result.tests.filter(t => !t.pass).map(t => t.name).join(', '));
    assert.equal(original.api.constants.DEPARTURE_MS, Date.parse('2026-10-03T01:10:00Z'));
    assert.equal(original.api.constants.ARRIVAL_MS, Date.parse('2026-10-03T16:10:00Z'));
  });
  await check('absolute UTC schedule and 12h10 duration', () => {
    assert.equal(api.constants.DEPARTURE_MS, DEPARTURE);
    assert.equal(api.constants.ARRIVAL_MS, ARRIVAL);
    assert.equal(api.constants.DURATION_MS, DURATION);
    assert.equal(api.formatDuration(DURATION), '12시간 10분 00초');
    assert.equal(node(app, 'timeSlider').min, String(DEPARTURE - 3600000));
    assert.equal(node(app, 'timeSlider').max, String(ARRIVAL + 3600000));
  });
  await check('return route starts at CDG and ends at ICN, including clamps', () => {
    for (const progress of [-1, 0]) { near(api.routePointAt(progress).lat, 49.0097); near(api.routePointAt(progress).lon, 2.5479); }
    for (const progress of [1, 2]) { near(api.routePointAt(progress).lat, 37.4602); near(api.routePointAt(progress).lon, 126.4407); }
    assert.equal(api.nearestRouteCity(api.routePointAt(0)).city, '파리');
    assert.equal(api.nearestRouteCity(api.routePointAt(1)).city, '인천');
  });
  await check('schedule clamps and quarter boundaries', () => {
    for (const [time, progress] of [[DEPARTURE - 1, 0], [DEPARTURE, 0], [DEPARTURE + DURATION / 4, .25], [DEPARTURE + DURATION / 2, .5], [DEPARTURE + DURATION * .75, .75], [ARRIVAL, 1], [ARRIVAL + 1, 1]]) assert.equal(api.progressAt(time), progress);
    near(api.progressAt(Date.parse('2026-10-11T00:00:00Z')), 330 / 730);
  });
  await check('Paris/Seoul dates, midnight rollover, and Paris DST', () => {
    assert.equal(api.zonedParts(DEPARTURE, 'Europe/Paris').time, '20:30:00');
    assert.equal(api.zonedParts(DEPARTURE, 'Europe/Paris').date, '10월 10일 · 토');
    assert.equal(api.zonedParts(DEPARTURE, 'Asia/Seoul').time, '03:30:00');
    assert.equal(api.zonedParts(DEPARTURE, 'Asia/Seoul').date, '10월 11일 · 일');
    assert.equal(api.zonedParts(ARRIVAL, 'Europe/Paris').time, '08:40:00');
    assert.equal(api.zonedParts(ARRIVAL, 'Europe/Paris').date, '10월 11일 · 일');
    assert.equal(api.zonedParts(ARRIVAL, 'Asia/Seoul').time, '15:40:00');
    assert.equal(api.zonedParts(ARRIVAL, 'Asia/Seoul').date, '10월 11일 · 일');
    assert.equal(api.zonedParts(Date.parse('2026-10-10T22:00:00Z'), 'Europe/Paris').time, '00:00:00');
    assert.equal(api.zonedParts(Date.parse('2026-10-10T22:00:00Z'), 'Europe/Paris').date, '10월 11일 · 일');
    assert.equal(api.zonedParts(Date.parse('2026-11-01T12:00:00Z'), 'Europe/Paris').time, '13:00:00');
  });
  await check('initial mode uses device clock and one-second timer', () => {
    assert.equal(api.getState().mode, 'device');
    assert.equal(api.getState().timeMs, DEPARTURE - 3600000);
    assert.equal(app.document.body.dataset.phase, 'before');
    assert.equal(node(app, 'mapMode').textContent, 'DEVICE TIME');
    assert.equal(app.intervals.length, 1);
    assert.equal(app.intervals[0].delay, 1000);
    app.setClock(DEPARTURE + DURATION / 2);
    app.intervals[0].callback();
    assert.equal(node(app, 'progressValue').textContent, '50.0');
  });
  await check('all preset buttons enter expected simulation and report state', () => {
    for (const [preset, progress, phase] of [['before', '0.0', 'before'], ['25', '25.0', 'inflight'], ['50', '50.0', 'inflight'], ['75', '75.0', 'inflight'], ['after', '100.0', 'arrived']]) {
      click(app, preset);
      assert.equal(api.getState().mode, 'simulated');
      assert.equal(node(app, 'progressValue').textContent, progress);
      assert.equal(app.document.body.dataset.phase, phase);
      assert.equal(node(app, 'mapMode').textContent, 'SIMULATED');
      assert(node(app, 'app').classList.contains('is-simulating'));
      assert.equal(app.presets.filter(button => button.getAttribute('aria-pressed') === 'true').length, 1);
      assert.equal(app.presets.find(button => button.getAttribute('aria-pressed') === 'true').dataset.preset, preset);
      const simulatedTime = api.getState().timeMs;
      app.setClock(ARRIVAL + 86400000);
      app.intervals[0].callback();
      assert.equal(api.getState().timeMs, simulatedTime, 'simulation must not advance with device time');
    }
  });
  await check('slider exact departure/arrival renders clamped state and endpoint dates', () => {
    slider(app, DEPARTURE - 1); assert.equal(app.document.body.dataset.phase, 'before');
    slider(app, DEPARTURE);
    assert.equal(app.document.body.dataset.phase, 'inflight');
    assert.equal(node(app, 'elapsedValue').textContent, '0시간 00분 00초');
    assert.equal(node(app, 'remainingValue').textContent, '12시간 10분 00초');
    assert.equal(node(app, 'locationReadout').textContent, '프랑스 · 파리');
    assert.equal(node(app, 'parisTime').textContent, '20:30:00');
    assert.equal(node(app, 'parisDate').textContent, '10월 10일 · 토');
    assert.equal(node(app, 'seoulTime').textContent, '03:30:00');
    assert.equal(node(app, 'seoulDate').textContent, '10월 11일 · 일');
    slider(app, ARRIVAL - 1); assert.equal(app.document.body.dataset.phase, 'inflight');
    slider(app, ARRIVAL);
    assert.equal(app.document.body.dataset.phase, 'arrived');
    assert.equal(node(app, 'elapsedValue').textContent, '12시간 10분 00초');
    assert.equal(node(app, 'remainingValue').textContent, '0시간 00분 00초');
    assert.equal(node(app, 'locationReadout').textContent, '대한민국 · 인천');
    assert.equal(node(app, 'seoulTime').textContent, '15:40:00');
    assert.equal(node(app, 'seoulDate').textContent, '10월 11일 · 일');
    assert.equal(node(app, 'parisTime').textContent, '08:40:00');
    assert.equal(node(app, 'parisDate').textContent, '10월 11일 · 일');
    assert.equal(app.presets.filter(button => button.getAttribute('aria-pressed') === 'true').length, 0);
  });
  await check('repeated simulation/device transitions and device clock refresh', () => {
    for (let repeat = 0; repeat < 3; repeat++) {
      click(app, '25');
      app.setClock(DEPARTURE + DURATION * .75);
      click(app, 'device');
      assert.equal(api.getState().mode, 'device');
      assert.equal(node(app, 'progressValue').textContent, '75.0');
      assert.equal(node(app, 'mapMode').textContent, 'DEVICE TIME');
      assert(node(app, 'app').classList.contains('is-live'));
      assert(!node(app, 'app').classList.contains('is-simulating'));
      assert.equal(app.presets.find(button => button.getAttribute('aria-pressed') === 'true').dataset.preset, 'device');
      app.setClock(ARRIVAL + 1); app.intervals[0].callback();
      assert.equal(app.document.body.dataset.phase, 'arrived');
    }
  });
  await check('map renders finite SVG paths and progress accessibility values', () => {
    assert(node(app, 'landLayer').children.length > 0);
    assert(node(app, 'graticuleLayer').children.length > 0);
    assert.equal(node(app, 'cityLayer').children.length, 6);
    const route = node(app, 'routeBase').getAttribute('d');
    assert(route.startsWith('M'));
    assert(!/NaN|Infinity|undefined/.test(route));
    assert.equal(node(app, 'routeFlown').getAttribute('d'), route);
    slider(app, DEPARTURE + DURATION / 2);
    assert.equal(node(app, 'progressOrb').getAttribute('aria-valuenow'), '50.0');
    assert.equal(node(app, 'routeFlown').getAttribute('stroke-dasharray'), '0.500000 1');
    assert.equal(node(app, 'progressOrb').style['--progress-deg'], '180deg');
    assert(!/NaN|Infinity|undefined/.test(node(app, 'planeGroup').getAttribute('transform')));
    for (let i = 0; i <= 500; i++) {
      const point = api.routePointAt(i / 500);
      assert(Number.isFinite(point.lat) && Number.isFinite(point.lon));
      assert(Math.abs(point.lat) <= 90 && Math.abs(point.lon) <= 180);
      assert(point.lon < 124 || point.lat < 38, 'reference route enters conservative DPRK exclusion box');
    }
  });
  await check('single-file offline status and network-change messaging', () => {
    assert.equal(node(app, 'offlinePill').dataset.state, 'ready');
    assert.equal(node(app, 'installStatusTitle').textContent, '단일 HTML은 오프라인으로 열림');
    app.navigator.onLine = false; app.window.dispatch('offline');
    assert.equal(node(app, 'offlinePill').textContent, '오프라인 작동 중');
    app.navigator.onLine = true; app.window.dispatch('online');
    assert.equal(node(app, 'offlinePill').textContent, '오프라인 준비 완료');
  });
  await check('HTTPS service-worker registration uses only return subdirectory scope', async () => {
    const registrations = [];
    app.location.protocol = 'https:';
    app.navigator.serviceWorker = {
      ready: Promise.resolve({}),
      register: async (script, options) => { registrations.push({ script, scope: options.scope }); return { active: { state: 'activated', postMessage(message, ports) { assert.equal(message.type, 'GET_CACHE_STATUS'); ports[0].postMessage({ type: 'CACHE_STATUS', ready: true, version: 'tw402-return-flight-test' }); } }, addEventListener() {} }; }
    };
    await api.setupOfflineApp();
    assert.deepEqual(registrations, [{ script: './sw.js', scope: './' }]);
    assert.equal(node(app, 'offlinePill').dataset.state, 'ready');
  });
  await check('wrong worker or missing cache cannot produce offline-ready status', async () => {
    for (const data of [
      { type: 'CACHE_STATUS', ready: true, version: 'tw401-flight-tracker-old' },
      { type: 'CACHE_STATUS', ready: false, version: 'tw402-return-flight-test' }
    ]) {
      app.navigator.serviceWorker = { register: async () => ({ active: { state: 'activated', postMessage(message, ports) { ports[0].postMessage(data); } }, addEventListener() {} }) };
      await api.setupOfflineApp();
      assert.equal(node(app, 'offlinePill').dataset.state, 'error');
    }
    app.errors.length = 0;
  });
  await check('unsupported browser and failed registration disclose offline failure', async () => {
    delete app.navigator.serviceWorker;
    await api.setupOfflineApp();
    assert.equal(node(app, 'offlinePill').dataset.state, 'error');
    app.navigator.serviceWorker = { register: async () => { throw new Error('intentional test failure'); } };
    await api.setupOfflineApp();
    assert.equal(node(app, 'offlinePill').dataset.state, 'error');
    assert.equal(app.errors.length, 1);
  });
  await check('return PWA manifest, icons, and HTML remain self-contained', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'tw402/manifest.webmanifest'), 'utf8'));
    assert.equal(manifest.scope, './');
    assert.match(manifest.start_url, /^\.\/TW402-flight-tracker\.html(?:\?|$)/);
    assert.equal(manifest.display, 'standalone');
    assert(manifest.name.includes('TW402'));
    for (const icon of manifest.icons) assert(fs.existsSync(path.resolve(ROOT, 'tw402', icon.src)));
    assert(!/<(?:script|link)\b[^>]*(?:src|href)=["']https?:\/\//i.test(app.html), 'app shell must not depend on external scripts/styles');
    assert(!/\b(?:fetch\s*\(|XMLHttpRequest\b|WebSocket\s*\(|geolocation\.)/.test(app.html), 'tracker must not require live location/network APIs');
  });
  console.log(`\nDOM/VM regression groups: ${passed} passed, ${failed} failed`);
  console.log('Coverage note: no visual rendering, browser storage, or real service-worker lifecycle was simulated by these checks.');
  process.exitCode = failed ? 1 : 0;
})().catch(error => { console.error(error.stack); process.exitCode = 1; });

