// Switchboard's own checks, run by test/e2e.mjs on a phone-sized page.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };

// This repo served the way GitHub Pages serves it: a file it has, or 404.html with status 404 for any other address
// (every sticker's). `net` is the connection: 'up', 'down' (every connection dropped) or 'stalled' (one bar in a
// basement: each request is taken and held). `patch` rewrites 404.html as served (a change to OVERRIDES).
function pagesServer() {
  const ctl = { net: 'up', held: [], patch: null };
  const serve = async (req, res) => {
    let path = new URL(req.url, 'http://x').pathname, status = 200, body;
    if (path.endsWith('/')) path += 'index.html';
    try { body = await readFile(join(root, decodeURIComponent(path))); }
    catch { body = await readFile(join(root, '404.html')); status = 404; path = '/404.html'; }
    if (ctl.patch && path === '/404.html') body = Buffer.from(ctl.patch(String(body)));
    res.writeHead(status, { 'content-type': TYPES[extname(path)] || 'text/html', 'cache-control': 'max-age=600' });
    res.end(body);
  };
  const server = createServer((req, res) => {
    if (ctl.net === 'down') { req.socket.destroy(); return; }
    if (ctl.net === 'stalled') { ctl.held.push([req, res]); return; }
    serve(req, res);
  });
  ctl.unstall = () => { ctl.net = 'up'; return Promise.all(ctl.held.splice(0).map(([q, s]) => serve(q, s))); };
  ctl.close = () => { for (const [q] of ctl.held.splice(0)) q.socket.destroy(); server.closeAllConnections(); return new Promise(r => server.close(r)); };
  return new Promise(r => server.listen(0, () => { ctl.base = `http://localhost:${server.address().port}/`; r(ctl); }));
}

// A sticker tapped on a phone that has never opened Switchboard's own page (a tenant's): online, with no signal, and on
// a connection that's up but not answering. The apps' addresses answer with a stand-in page, so where a tap lands shows.
export async function resolverChecks({ browser, assert }) {
  const srv = await pagesServer();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await ctx.route(/^https:\/\//, r => r.fulfill({ contentType: 'text/html', body: '<!doctype html><title>the app</title>' }));
  const errors = [];
  ctx.on('page', p => p.on('pageerror', e => errors.push(e.message)));
  // A tap: where the phone ends up (an app's address) and how long it took, or the page it stayed on.
  const tap = async (path, ms = 10000) => {
    const p = await ctx.newPage(), t0 = Date.now();
    const went = p.goto(srv.base + path.replace(/^\//, ''), { timeout: ms }).catch(e => e);
    await Promise.race([p.waitForURL(/^https:/, { timeout: ms }).catch(() => {}), went.then(() => p.waitForTimeout(500))]);
    const out = { url: p.url(), took: Date.now() - t0, text: /^https:/.test(p.url()) ? '' : (await p.locator('body').textContent().catch(() => '')).replace(/\s+/g, ' ').trim() };
    await p.close();
    return out;
  };
  const worker = () => ctx.serviceWorkers().find(w => w.url() === srv.base + 'sw.js');
  try {
    let r = await tap('/h/first-tap');
    assert.equal(r.url, 'https://placard.junkdrawer.works/#first-tap', 'an online tap did not reach the app');
    // that one tap leaves the resolver's offline copy on the phone
    for (const end = Date.now() + 10000; !(await worker()?.evaluate(() => caches.match('404.html').then(Boolean)).catch(() => false));) {
      assert.ok(Date.now() < end, 'a phone whose only visit was a sticker tap has no offline copy of the resolver');
      await new Promise(res => setTimeout(res, 200));
    }
    // no signal: the next tap still reaches the app (which opens from its own copy)
    srv.net = 'down';
    r = await tap('/h/water-heater');
    assert.equal(r.url, 'https://placard.junkdrawer.works/#water-heater', `with no signal a tap stayed on ${r.url}: ${r.text.slice(0, 80)}`);
    // an address that isn't a whole tag shows the resolver's own page (not Switchboard's home without its files)
    r = await tap('/x/foo');
    assert.match(r.text, /This tag isn't set up/, 'offline, /x/foo did not show the resolver page: ' + r.text);
    r = await tap('/h/');
    assert.match(r.text, /This link is cut short or mistyped .* It's one of Placard's stickers\. Open Placard to find its page\./, 'offline, /h/ did not show the resolver page: ' + r.text.slice(0, 120));
    // one bar: the connection is up but nothing answers. The tap lands from the copy within a few seconds.
    srv.net = 'stalled';
    r = await tap('/h/smoke-co');
    assert.equal(r.url, 'https://placard.junkdrawer.works/#smoke-co', 'on a stalled connection the tap never opened');
    assert.ok(r.took < 8000, `on a stalled connection the tap took ${r.took} ms`);
    await srv.unstall();
    // the network comes first when it answers, so a change to OVERRIDES reaches a phone that has the copy
    srv.patch = b => b.replace('var OVERRIDES = {\n};', "var OVERRIDES = {\n  'h/water-heater': 'https://example.com/manual'\n};");
    r = await tap('/h/water-heater');
    assert.equal(r.url, 'https://example.com/manual', 'a phone with the offline copy missed a change to OVERRIDES');
    // and Check a tag on Switchboard's own page reads the same OVERRIDES: it shows, and Open goes to, where the tap went
    const sb = await ctx.newPage();
    await sb.addInitScript(fakeNfc);
    await sb.goto(srv.base);
    const checked = async url => {
      await sb.click('#check-btn');
      await sb.waitForFunction(() => /^Listening/.test(document.querySelector('#check-msg').textContent));
      await sb.evaluate(u => window.__nfc.tap(u), url);
      await sb.waitForSelector('#check-out:not([hidden])');
      return { to: await sb.locator('#check-out code').textContent(), open: await sb.locator('#check-out a.btn').getAttribute('href'),
        why: await sb.locator('#check-out p.muted').allTextContents() };
    };
    assert.deepEqual(await checked('https://tag.junkdrawer.works/h/water-heater'), { to: 'https://example.com/manual', open: 'https://example.com/manual',
      why: ['Sent here by OVERRIDES in 404.html.'] }, 'Check a tag shows the old page for a sticker OVERRIDES sends elsewhere');
    assert.deepEqual(await checked('https://tag.junkdrawer.works/h/smoke-co'), { to: 'https://placard.junkdrawer.works/#smoke-co', open: 'https://placard.junkdrawer.works/#smoke-co', why: [] });
    await sb.close();
    srv.patch = null;
    assert.deepEqual(errors, [], 'errors on the resolver page');
  } finally {
    await ctx.close();
    await srv.close();
  }
}

// A pretend Chrome NFC reader: scan() listens until its signal aborts; __nfc.tap(url) holds a sticker to it (no url: a
// blank one) and says whether anything was listening.
const fakeNfc = () => {
  window.__nfc = { readers: [], writes: [] };
  window.NDEFReader = class {
    async scan({ signal } = {}) {
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
      this.listening = true; window.__nfc.readers.push(this);
      signal?.addEventListener('abort', () => { this.listening = false; });
    }
    async write(m) { window.__nfc.writes.push(m.records[0].data); }
  };
  window.__nfc.tap = url => {
    const r = window.__nfc.readers.filter(x => x.listening).at(-1);
    if (!r?.onreading) return false;
    r.onreading({ serialNumber: '04:a2:19:7c:5e:11:90', message: { records: url ? [{ recordType: 'url', data: new TextEncoder().encode(url) }] : [] } });
    return true;
  };
};

// Check a tag: what three kinds of sticker show, and Stop.
async function checkATag({ page, base, assert }) {
  await page.addInitScript(fakeNfc);
  await page.goto(base);
  const text = sel => page.locator(sel).evaluate(el => el.textContent);
  const listening = () => page.waitForFunction(() => /^Listening/.test(document.querySelector('#check-msg').textContent));
  const check = async url => {
    await page.click('#check-btn');
    await listening();
    assert.equal(await text('#check-btn'), 'Stop', 'the button stops the read while it listens');
    assert.equal(await text('#check-msg'), 'Listening. Hold the sticker flat against the back of the phone, near the top.');
    assert.equal(await page.evaluate(u => window.__nfc.tap(u), url), true, 'nothing was listening for the sticker');
    await page.waitForSelector('#check-out:not([hidden])');
    assert.equal(await text('#check-btn'), 'Check a tag');
    assert.equal(await text('#check-msg'), '', 'a message beside what the sticker holds');
    assert.equal(await page.evaluate(() => window.__nfc.readers.some(r => r.listening)), false, 'still listening after the read');
    return text('#check-out');
  };
  await check('https://tag.junkdrawer.works/s/test');
  assert.equal(await text('#check-out .tape-cap'), 's / Switchboard');
  assert.equal(await text('#check-out .tape'), 'test');
  await check('https://tag.junkdrawer.works/t/04');
  assert.equal(await text('#check-out .tape-cap'), 't / Mothball');
  assert.equal(await page.locator('#check-out a.btn').getAttribute('href'), 'https://mothball.junkdrawer.works/#04');
  assert.match(await check(''), /That sticker is blank\./);
  assert.match(await check('https://example.com/menu'), /Not a Switchboard tag\. It holds:\s*https:\/\/example\.com\/menu/);
  // Stop
  await page.click('#check-btn');
  await listening();
  await page.click('#check-btn');
  await page.waitForFunction(() => document.querySelector('#check-msg').textContent === 'Stopped.');
  assert.equal(await text('#check-btn'), 'Check a tag');
  assert.equal(await page.evaluate(() => window.__nfc.readers.some(r => r.listening)), false, 'still listening after Stop');
  // Check, Stop and Check again in quick succession: the stopped read doesn't say "Stopped." over the new one
  await page.evaluate(() => { const b = document.querySelector('#check-btn'); b.click(); b.click(); b.click(); });
  await page.waitForTimeout(400);
  assert.match(await text('#check-msg'), /^Listening/, 'a stopped read wrote over the new one');
  assert.equal(await text('#check-btn'), 'Stop');
  assert.equal(await page.evaluate(() => window.__nfc.tap('https://tag.junkdrawer.works/f/garage-top')), true);
  await page.waitForSelector('#check-out:not([hidden])');
  assert.equal(await text('#check-out .tape-cap'), 'f / Frostbite');
}

// Installed on Android, an app opens every address inside its scope in its own window. Switchboard's scope is its page
// alone, so a sticker's address (/h/water-heater, on the same origin) opens the resolver in the browser as on any other
// phone. Chrome reads the manifest without errors (a scope that doesn't hold start_url is ignored, with an error), it can
// still be installed, and its id is what it was before (the old start_url, './'), so a copy already installed stays the
// same app.
async function manifestChecks({ page, base, assert }) {
  await page.goto(base);
  const cdp = await page.context().newCDPSession(page);
  try {
    const m = await cdp.send('Page.getAppManifest');
    assert.deepEqual(m.errors, [], 'Chrome found errors in the manifest');
    const scope = m.parsed?.scope ?? new URL(JSON.parse(m.data).scope, m.url).href;
    assert.ok(scope.endsWith('/index.html'), `the installed app's scope is ${scope}, which holds every sticker's address`);
    assert.equal((base + 'h/water-heater').startsWith(scope), false, `a sticker's address is inside the installed app's scope (${scope})`);
    const json = JSON.parse(m.data), start = new URL(json.start_url, m.url);
    assert.equal(start.href, base + 'index.html');
    assert.deepEqual((await cdp.send('Page.getInstallabilityErrors')).installabilityErrors, [], 'Switchboard can no longer be installed');
    // the id: a relative one is read against start_url's origin, and none at all is start_url (MDN, Web app manifests,
    // id). Before, it was start_url './', this address. (Chrome answers Page.getAppId only behind a flag.)
    const id = (await cdp.send('Page.getAppId')).appId || (typeof json.id === 'string' ? new URL(json.id, start.origin).href : start.href);
    assert.equal(id, base, 'the app\'s id changed, so a copy already installed would be another app');
  } finally { await cdp.detach(); }
}

export async function appChecks({ page, ctx, base, assert, problems }) {
  await manifestChecks({ page, base, assert });
  await resolverChecks({ browser: ctx.browser(), assert });
  await checkATag({ page, base, assert });
  // a toast takes the phone's width, so a sentence stays on one or two lines (left: 50% once squeezed it into half)
  await page.evaluate(() => window.__switchboard.toast('Couldn\'t send it. Check the signal, or call.'));
  await page.waitForTimeout(300);
  const t = await page.locator('#toast').evaluate(el => { const r = el.getBoundingClientRect(); return { w: r.width, h: r.height, left: r.left, right: innerWidth - r.right }; });
  assert.ok(t.h < 50, `the toast wrapped onto ${Math.round(t.h)} px of lines`);
  assert.ok(Math.abs(t.left - t.right) < 2 && t.left >= 16, `the toast isn't centred with its margins: ${JSON.stringify(t)}`);
  assert.equal(await page.locator('#route-rows tr').count(), 6, 'six letters in the table');
  // every address whole on a phone, none cut off at the table's edge
  const letters = await page.locator('#routes').evaluate(el => ({ fits: el.querySelector('.tbl').scrollWidth <= el.querySelector('.tbl').clientWidth,
    to: [...el.querySelectorAll('#route-rows td:last-child')].map(td => td.textContent) }));
  assert.deepEqual(letters, { fits: true, to: ['placard.junkdrawer.works', 'mothball.junkdrawer.works', 'larder.junkdrawer.works',
    'frostbite.junkdrawer.works', 'packrat.junkdrawer.works', 'tag.junkdrawer.works'] }, 'the Letters table cuts the addresses off');
  assert.equal(await page.locator('#app-list li').count(), 5, 'five apps to connect');
  assert.match(await page.locator('#app-list').innerText(), /ledger first/, 'apps wait for the ledger');
  assert.equal(await page.locator('#test-panel .url').innerText(), 'https://tag.junkdrawer.works/s/test');
  // a pretend ledger answers the test: Google down, a wrong key, then the right one
  const from = problems.length;
  let google = 'up', key = 'k'.repeat(40), version = '1.1';
  await page.route('https://script.google.com/**', async route => {
    if (google === 'down') { await new Promise(r => setTimeout(r, 800)); return route.abort('internetdisconnected'); }
    const body = JSON.parse(route.request().postData() || '{}');
    const ok = body.key === key;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(ok ? { ok: true, version, time: 1 } : { ok: false, error: 'bad key' }) });
  });
  const state = () => page.locator('#ledger-state').evaluate(el => [el.className, el.textContent]);
  assert.deepEqual(await state(), ['sync unset', 'Not connected to the ledger']);
  await page.fill('#lurl', 'https://script.google.com/macros/s/AKfyTEST/exec');
  await page.fill('#lkey', 'k'.repeat(40));
  google = 'down';
  await page.click('#ledger-test');
  await page.waitForFunction(() => document.querySelector('#ledger-msg').className === 'msg bad');
  assert.equal(await page.locator('#ledger-msg').textContent(), 'Google didn\'t answer. Check the phone is online, then try again.');
  google = 'up';
  await page.fill('#lkey', 'wrong');
  await page.click('#ledger-test');
  await page.waitForFunction(() => /key is wrong/.test(document.querySelector('#ledger-msg').textContent));
  await page.fill('#lkey', 'k'.repeat(40));
  await page.click('#ledger-test');
  await page.waitForFunction(() => /Connected to ledger v1.1/.test(document.querySelector('#ledger-msg').textContent));
  assert.deepEqual(await state(), ['sync synced', 'Connected to ledger v1.1']);
  assert.equal(await page.locator('#ledger-msg').getAttribute('class'), 'msg ok');
  // the first zip's script (1.0) answers too, but turns tote 01 into 1: amber, and how to paste the new one
  version = '1.0';
  await page.click('#ledger-test');
  await page.waitForFunction(() => /^Connected, but/.test(document.querySelector('#ledger-msg').textContent));
  assert.equal(await page.locator('#ledger-msg').getAttribute('class'), 'msg wait');
  assert.equal(await page.locator('#ledger-msg').textContent(), 'Connected, but the script is v1.0. Paste ledger/Code.gs from Switchboard\'s repo over it, Save, then Deploy, '
    + 'Manage deployments, the pencil, Version: New version, Deploy. Until then don\'t save totes or packs numbered 01 to 09.');
  assert.deepEqual(await state(), ['sync pending', 'Ledger script v1.0 is older than these apps need (v1.1)']);
  assert.match(await page.locator('#app-list a').first().getAttribute('href'), /#connect=/, 'Connect went away with an old script');
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#ledger-state').textContent === 'Ledger script v1.0 is older than these apps need (v1.1)');
  version = '1.1';
  const link = await page.locator('#app-list a').first().getAttribute('href');
  assert.match(link, /^https:\/\/placard\.junkdrawer\.works\/#connect=[A-Za-z0-9_-]+$/);
  const cfg = JSON.parse(Buffer.from(link.split('=')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
  assert.deepEqual(cfg, { u: 'https://script.google.com/macros/s/AKfyTEST/exec', k: 'k'.repeat(40) });
  // opened again, it asks the ledger: still fine, then the key changed in the sheet (setup run again)
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#ledger-state').textContent === 'Connected to ledger v1.1');
  key = 'n'.repeat(40);
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#ledger-state').classList.contains('badkey'));
  assert.deepEqual(await state(), ['sync badkey', 'Wrong key — copy B2 from the sheet\'s About tab again']);
  // a new key typed while it was asking isn't put back by the answer
  google = 'down';
  await page.reload();
  assert.deepEqual(await state(), ['sync pending', 'Checking the ledger…']);
  await page.fill('#lkey', 'n'.repeat(40));
  await page.waitForFunction(() => document.querySelector('#ledger-state').classList.contains('offline'));
  assert.equal(await page.inputValue('#lkey'), 'n'.repeat(40));
  google = 'up';
  await page.click('#ledger-test');
  await page.waitForFunction(() => document.querySelector('#ledger-state').textContent === 'Connected to ledger v1.1');
  // the test tag's landing note
  await page.goto('about:blank'); await page.goto(base + '#test');
  assert.equal(await page.locator('#test-ok').isHidden(), false, 'the test tag note shows');
  // forgotten, so nothing after this asks Google
  await page.click('#ledger-forget');
  assert.deepEqual(await state(), ['sync unset', 'Not connected to the ledger']);
  await page.unroute('https://script.google.com/**');
  for (let i = problems.length - 1; i >= from; i--) if (/script\.google\.com|Failed to load resource: net::ERR_INTERNET_DISCONNECTED/.test(problems[i])) problems.splice(i, 1);
}
