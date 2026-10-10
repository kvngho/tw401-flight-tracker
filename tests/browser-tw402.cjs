'use strict';
// Playwright browser acceptance checks; run locally or on a GitHub-hosted runner.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const os = require('node:os');
const root = path.resolve(__dirname, '..');
const artifacts = path.join(root, 'artifacts');
fs.mkdirSync(artifacts, { recursive: true });
const report = [];
const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.webmanifest':'application/manifest+json', '.png':'image/png', '.svg':'image/svg+xml' };
function startServer() {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      let file = path.resolve(root, '.' + pathname);
      if ((file !== root && !file.startsWith(root + path.sep)) || pathname.includes('/.')) { res.writeHead(403); return res.end(); }
      try {
        if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
        res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Cache-Control':'no-cache' });
        fs.createReadStream(file).pipe(res);
      } catch { res.writeHead(404); res.end('Not found'); }
    }).listen(4173, '127.0.0.1', () => resolve(server));
  });
}
async function check(name, fn) {
  await fn(); report.push({ name, pass: true }); console.log('PASS', name);
}
function capturePageErrors(context, errors) {
  const watch = page => page.on('pageerror', error => errors.push(`${page.url()}: ${error.message}`));
  context.on('page', watch);
  for (const page of context.pages()) watch(page);
}
async function assertOfflineUsable(page) {
  // navigator.onLine is a browser/OS hint, not proof of internet reachability.
  // A blocked, uncached fetch proves emulation really cuts off the network.
  const networkBlocked = await page.evaluate(async () => {
    try { await fetch('./offline-network-probe-' + Date.now(), { cache: 'no-store' }); return false; }
    catch { return true; }
  });
  assert.equal(networkBlocked, true, 'uncached network must be unreachable');
  assert.equal(await page.locator('#offlinePill').getAttribute('data-state'), 'ready');
  assert.equal(await page.locator('#flightTitle').innerText(), 'TW0402');
}
async function tests(browser, base, label) {
  const context = await browser.newContext({ viewport:{width:390,height:844}, deviceScaleFactor:2, isMobile:true, hasTouch:true, locale:'ko-KR', timezoneId:'America/Los_Angeles', reducedMotion:'reduce' });
  const errors = [];
  capturePageErrors(context, errors);
  const page = await context.newPage();
  await page.goto(base + 'TW401-flight-tracker.html');
  await check(`${label}: outbound baseline 23/23`, async () => {
    await page.waitForFunction(() => window.__TW401_SELF_TEST__?.passed === 23);
    await page.waitForFunction(() => document.getElementById('offlinePill').dataset.state === 'ready');
    await page.reload();
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    assert.equal(await page.locator('#flightTitle').innerText(), 'TW401');
  });
  await page.goto(base + 'tw402/');
  await check(`${label}: return install under existing outbound worker`, async () => {
    await page.waitForFunction(() => window.__TW402_SELF_TEST__?.passed === 39 && window.__TW402_SELF_TEST__?.total === 39);
    await page.waitForFunction(() => document.getElementById('offlinePill').dataset.state === 'ready', null, {timeout:45000});
    await page.waitForFunction(() => navigator.serviceWorker.controller?.scriptURL.includes('/tw402/sw.js'));
    assert.equal(await page.locator('#flightTitle').innerText(), 'TW0402');
    const state = await page.evaluate(() => ({ tests:window.__TW402_SELF_TEST__, constants:window.__flightTracker.constants }));
    assert.equal(state.tests.total, 39);
    assert.equal(state.constants.DURATION_MS, 730 * 60000);
    assert.equal(state.constants.DEPARTURE_MS, Date.UTC(2026,9,10,18,30));
    assert.equal(state.constants.ARRIVAL_MS, Date.UTC(2026,9,11,6,40));
    const caches = await page.evaluate(() => window.caches.keys());
    assert(caches.some(n => n.startsWith('tw401-flight-tracker-')));
    assert(caches.some(n => n.startsWith('tw402-return-flight-')));
  });
  await check(`${label}: source links and no external app dependency`, async () => {
    assert.equal(await page.locator('script[src], link[rel=stylesheet]').count(), 0);
    assert(await page.locator('a[href*="flightaware.com"]').count() > 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  });
  await page.locator('#simulator summary').click();
  await check(`${label}: repeated simulator changes and date crossing`, async () => {
    for (const fraction of [25,50,75,25,75,50]) {
      await page.locator(`[data-preset="${fraction}"]`).click();
      assert.equal(await page.locator('#progressValue').innerText(), `${fraction}.0`);
      assert.equal(await page.locator('#mapMode').innerText(), 'SIMULATED');
    }
    assert.equal(await page.locator('#parisTime').innerText(), '02:35:00');
    assert.equal(await page.locator('#seoulTime').innerText(), '09:35:00');
    assert.equal(await page.locator('#parisDate').innerText(), '10월 11일 · 일');
    assert.equal(await page.locator('#seoulDate').innerText(), '10월 11일 · 일');
  });
  await page.screenshot({path:path.join(artifacts, `${label}-mobile-50.png`),fullPage:true});
  await check(`${label}: before and after phases do not claim actual arrival`, async () => {
    await page.locator('[data-preset=before]').click();
    assert.equal(await page.locator('#progressValue').innerText(), '0.0');
    assert.equal(await page.locator('#remainingValue').innerText(), '12시간 10분 00초');
    await page.locator('[data-preset=after]').click();
    assert.equal(await page.locator('#progressValue').innerText(), '100.0');
    assert.equal(await page.locator('#remainingValue').innerText(), '0시간 00분 00초');
    assert.equal(await page.locator('#phaseTitle').innerText(), '예정 도착 시각이 지났어요');
    await page.locator('[data-preset=device]').click();
    assert.equal(await page.locator('#mapMode').innerText(), 'DEVICE TIME');
  });
  await check(`${label}: actual offline reload and PWA launch query`, async () => {
    await context.setOffline(true);
    await page.reload();
    await page.waitForFunction(() => document.getElementById('offlinePill').dataset.state === 'ready');
    assert.equal(await page.locator('#flightTitle').innerText(), 'TW0402');
    await page.goto(base + 'tw402/TW402-flight-tracker.html?source=pwa');
    await page.waitForFunction(() => document.getElementById('offlinePill').dataset.state === 'ready');
    await assertOfflineUsable(page);
    await page.locator('#simulator summary').click();
    await page.locator('[data-preset="50"]').click();
    assert.equal(await page.locator('#progressValue').innerText(), '50.0');
  });
  await check(`${label}: offline tab close/reopen and directory entry`, async () => {
    await page.close();
    const reopened = await context.newPage();
    await reopened.goto(base + 'tw402/');
    await reopened.waitForFunction(() => window.__TW402_SELF_TEST__?.passed === 39);
    await reopened.waitForFunction(() => document.getElementById('offlinePill').dataset.state === 'ready');
    assert.equal(await reopened.locator('#flightTitle').innerText(), 'TW0402');
    await reopened.screenshot({path:path.join(artifacts, `${label}-mobile-offline.png`),fullPage:true});
    await reopened.setViewportSize({width:320,height:740});
    assert.equal(await reopened.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await reopened.close();
  });
  await check(`${label}: outbound remains separate and offline-readable`, async () => {
    const outbound = await context.newPage();
    await outbound.goto(base + 'TW401-flight-tracker.html');
    await outbound.waitForFunction(() => window.__TW401_SELF_TEST__?.passed === 23);
    assert.equal(await outbound.locator('#flightTitle').innerText(), 'TW401');
    assert.equal(await outbound.evaluate(() => navigator.serviceWorker.controller.scriptURL.includes('/tw402/')), false);
    await outbound.close();
  });
  await context.close();
  await check(`${label}: genuine desktop layout and offline reload`, async () => {
    const desktop = await browser.newContext({ viewport:{width:1440,height:1000}, deviceScaleFactor:1, isMobile:false, hasTouch:false, locale:'ko-KR', timezoneId:'America/Los_Angeles', reducedMotion:'reduce' });
    capturePageErrors(desktop, errors);
    try {
      const page = await desktop.newPage();
      await page.goto(base + 'tw402/TW402-flight-tracker.html');
      await page.waitForFunction(() => window.__TW402_SELF_TEST__?.passed === 39);
      await page.waitForFunction(() => document.getElementById('offlinePill').dataset.state === 'ready', null, {timeout:45000});
      await page.waitForFunction(() => navigator.serviceWorker.controller?.scriptURL.includes('/tw402/sw.js'));
      assert.equal(await page.evaluate(() => matchMedia('(pointer: fine)').matches), true);
      await desktop.setOffline(true);
      await page.reload();
      await page.waitForFunction(() => document.getElementById('offlinePill').dataset.state === 'ready');
      await page.locator('#simulator summary').click();
      await page.locator('[data-preset="50"]').click();
      assert.equal(await page.locator('#progressValue').innerText(), '50.0');
      await assertOfflineUsable(page);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
      await page.screenshot({path:path.join(artifacts, `${label}-desktop-offline.png`),fullPage:true});
    } finally { await desktop.close(); }
  });
  await check(`${label}: no uncaught browser errors in any page`, async () => assert.deepEqual(errors, []));
}
async function welcomeChecks(browser, base, label) {
  const context = await browser.newContext({ viewport:{width:390,height:844}, deviceScaleFactor:2, isMobile:true, hasTouch:true, locale:'ko-KR', timezoneId:'America/Los_Angeles', reducedMotion:'reduce' });
  const page = await context.newPage();
  const start = Date.parse('2026-10-11T06:30:00Z');
  const errors = [];
  capturePageErrors(context, errors);
  try {
    await page.clock.setFixedTime(start - 1);
    await page.goto(base + 'tw402/TW402-flight-tracker.html');
    await page.waitForFunction(() => navigator.serviceWorker.controller?.scriptURL.includes('/tw402/sw.js'));
    await check(`${label}: welcome exact threshold and one-second automatic update`, async () => {
      assert.equal(await page.locator('#welcomeHome').isVisible(), false);
      await page.clock.setFixedTime(start);
      await page.evaluate(() => window.__flightTracker.render());
      assert.equal(await page.locator('#welcomeHome').isVisible(), true);
      assert.equal(await page.locator('#welcomeTitle').innerText(), '선영 사랑해\n웰컴홈!');
      assert.equal(await page.locator('#welcomePreview').isVisible(), false);
      await page.clock.setFixedTime(start + 1);
      await page.waitForFunction(() => !document.getElementById('welcomeHome').hidden);
      assert.equal(await page.locator('#welcomeHome').isVisible(), true);
    });
    await check(`${label}: welcome mobile widths, desktop, and reduced motion`, async () => {
      for (const width of [320,390,430,768,1440]) {
        await page.setViewportSize({width,height:844});
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        const box = await page.locator('#welcomeHome').boundingBox();
        assert(box.x >= 0 && box.x + box.width <= width);
        assert.equal(await page.locator('.welcome-heart').evaluate(e => getComputedStyle(e).animationName), 'none');
      }
      await page.setViewportSize({width:390,height:844});
      await page.screenshot({path:path.join(artifacts, `${label}-welcome-mobile.png`),fullPage:false});
      await page.emulateMedia({reducedMotion:'no-preference'});
      assert.equal(await page.locator('.welcome-heart').evaluate(e => getComputedStyle(e).animationIterationCount), '2');
      await page.emulateMedia({reducedMotion:'reduce'});
    });
    await check(`${label}: welcome survives offline reload and after-arrival time`, async () => {
      await context.setOffline(true);
      await page.reload();
      await page.waitForFunction(() => document.getElementById('offlinePill').dataset.state === 'ready');
      assert.equal(await page.locator('#welcomeHome').isVisible(), true);
      await page.clock.setFixedTime(start + 600000);
      await page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
      assert.equal(await page.locator('#welcomeHome').isVisible(), true);
      assert.equal(await page.locator('#phaseTitle').innerText(), '예정 도착 시각이 지났어요');
      await page.reload();
      assert.equal(await page.locator('#welcomeHome').isVisible(), true);
    });
    await check(`${label}: reversible welcome simulation and return to device time`, async () => {
      await page.clock.setFixedTime(start - 1000);
      await page.locator('#simulator summary').click();
      await page.locator('[data-preset=welcome]').click();
      assert.equal(await page.locator('#welcomePreview').isVisible(), true);
      await page.locator('[data-preset=before]').click();
      assert.equal(await page.locator('#welcomeHome').isVisible(), false);
      await page.locator('[data-preset=welcome]').click();
      await page.locator('#welcomeDeviceTime').click();
      assert.equal(await page.locator('#welcomeHome').isVisible(), false);
      assert.equal(await page.locator('#mapMode').innerText(), 'DEVICE TIME');
      assert.deepEqual(errors, []);
    });
  } finally { await context.close(); }
}
async function persistentRestart(base, label) {
  await check(`${label}: offline reload after full browser process restart`, async () => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tw402-browser-profile-'));
    const errors = [];
    const launchOptions = { headless:true, ...(process.env.CHROMIUM_PATH ? { executablePath:process.env.CHROMIUM_PATH } : {}), viewport:{width:390,height:844}, deviceScaleFactor:2, isMobile:true, hasTouch:true, locale:'ko-KR', timezoneId:'America/Los_Angeles', reducedMotion:'reduce' };
    let context;
    try {
      context = await chromium.launchPersistentContext(profile, launchOptions);
      capturePageErrors(context, errors);
      let page = context.pages()[0] || await context.newPage();
      await page.goto(base + 'tw402/TW402-flight-tracker.html');
      await page.waitForFunction(() => window.__TW402_SELF_TEST__?.passed === 39);
      await page.waitForFunction(() => document.getElementById('offlinePill').dataset.state === 'ready', null, {timeout:45000});
      await page.waitForFunction(() => navigator.serviceWorker.controller?.scriptURL.includes('/tw402/sw.js'));
      // Closing a persistent context exits its browser process. Reuse only the
      // on-disk profile, not an in-memory context or an exported storageState.
      await context.close();
      context = undefined;
      context = await chromium.launchPersistentContext(profile, { ...launchOptions, offline:true });
      capturePageErrors(context, errors);
      await context.setOffline(true);
      page = context.pages()[0] || await context.newPage();
      await page.goto(base + 'tw402/TW402-flight-tracker.html?source=pwa');
      await page.waitForFunction(() => window.__TW402_SELF_TEST__?.passed === 39);
      await page.waitForFunction(() => document.getElementById('offlinePill').dataset.state === 'ready', null, {timeout:45000});
      assert.equal(await page.locator('#flightTitle').innerText(), 'TW0402');
      await assertOfflineUsable(page);
      assert.equal(await page.evaluate(() => navigator.serviceWorker.controller.scriptURL.includes('/tw402/sw.js')), true);
      await page.locator('#simulator summary').click();
      await page.locator('[data-preset="50"]').click();
      assert.equal(await page.locator('#progressValue').innerText(), '50.0');
      await page.screenshot({path:path.join(artifacts, `${label}-restart-offline.png`),fullPage:true});
      assert.deepEqual(errors, []);
    } finally {
      if (context) await context.close();
      fs.rmSync(profile, {recursive:true,force:true});
    }
  });
}
(async () => {
  let server, browser;
  try {
    server = await startServer();
    browser = await chromium.launch({ headless:true, ...(process.env.CHROMIUM_PATH ? { executablePath:process.env.CHROMIUM_PATH } : {}) });
    await tests(browser, 'http://127.0.0.1:4173/', 'local');
    await welcomeChecks(browser, 'http://127.0.0.1:4173/', 'local');
    await persistentRestart('http://127.0.0.1:4173/', 'local');
    await check('standalone file works without a server', async () => {
      const c = await browser.newContext(); const p = await c.newPage();
      await p.goto('file://' + path.join(root,'tw402/TW402-flight-tracker.html'));
      await p.waitForFunction(() => window.__TW402_SELF_TEST__?.passed === 39);
      assert.equal(await p.locator('#offlinePill').getAttribute('data-state'), 'ready');
      await c.close();
    });
    if (process.env.LIVE_BASE_URL) {
      const base = process.env.LIVE_BASE_URL;
      const expected = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'tw402/TW402-flight-tracker.html'))).digest('hex');
      const deadline = Date.now() + 12*60*1000;
      let verified = false;
      while (Date.now() < deadline) {
        const response = await fetch(base + 'tw402/TW402-flight-tracker.html?verification=' + Date.now());
        if (response.ok) {
          const actual = crypto.createHash('sha256').update(await response.text()).digest('hex');
          if (actual === expected) { verified = true; break; }
        }
        console.log('Waiting for Pages to serve this exact HTML...');
        await new Promise(r => setTimeout(r,15000));
      }
      assert(verified, 'Pages did not serve this commit before verification window ended');
      report.push({name:'published HTML matches local SHA256',pass:true,sha256:expected});
      await tests(browser, base, 'live');
      await welcomeChecks(browser, base, 'live');
      await persistentRestart(base, 'live');
    }
    fs.writeFileSync(path.join(artifacts,'browser-test-results.json'), JSON.stringify({passed:report.length,tests:report},null,2));
    console.log(`All ${report.length} browser acceptance checks passed`);
  } catch (e) {
    fs.writeFileSync(path.join(artifacts,'browser-test-results.json'), JSON.stringify({passed:report.length,tests:report,error:e.stack},null,2));
    console.error(e); process.exitCode=1;
  } finally { if(browser) await browser.close(); if(server) await new Promise(r=>server.close(r)); }
})();

