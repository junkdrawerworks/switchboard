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
    // a long address (a maker's manual) wraps inside the card, so nothing scrolls sideways
    const manual = 'https://www.example-heaters.com/support/manuals/ProLineXE50GallonGasWaterHeaterInstallationAndUseGuide.pdf';
    srv.patch = b => b.replace('var OVERRIDES = {\n};', `var OVERRIDES = {\n  'h/water-heater': '${manual}'\n};`);
    await sb.reload();
    assert.equal((await checked('https://tag.junkdrawer.works/h/water-heater')).to, manual);
    assert.deepEqual(await sb.evaluate(() => { const card = document.querySelector('#check'), code = card.querySelector('#check-out code');
      return { page: document.documentElement.scrollWidth, code: Math.ceil(code.getBoundingClientRect().right) <= card.getBoundingClientRect().right - parseFloat(getComputedStyle(card).paddingRight) }; }),
    { page: 390, code: true }, 'a long address in Check a tag runs off its card');
    // a mistake typed into OVERRIDES (a comma left out between two lines) loses only the overrides: a tap opens the
    // sticker's own app, and Check a tag says where it goes, that OVERRIDES has the mistake, and Open goes there too
    srv.patch = b => b.replace('var OVERRIDES = {\n};', "var OVERRIDES = {\n  'h/water-heater': 'https://example.com/manual'\n  'h/smoke-co': 'https://example.com/alarm'\n};");
    const typos = errors.length;
    r = await tap('/h/water-heater');
    assert.equal(r.url, 'https://placard.junkdrawer.works/#water-heater', `a mistake in OVERRIDES stopped a tap on ${r.url}: ${r.text.slice(0, 80)}`);
    r = await tap('/t/01');
    assert.equal(r.url, 'https://mothball.junkdrawer.works/#01', 'a mistake in OVERRIDES stopped a sticker it doesn\'t name');
    await sb.reload();
    const said = async url => {
      await sb.click('#check-btn');
      await sb.waitForFunction(() => /^Listening/.test(document.querySelector('#check-msg').textContent));
      await sb.evaluate(u => window.__nfc.tap(u), url);
      await sb.waitForSelector('#check-out:not([hidden])');
      return sb.locator('#check-out').evaluate(o => ({ cap: o.querySelector('.tape-cap').textContent,
        said: [...o.querySelectorAll('p')].map(p => [p.className, p.textContent]), links: [...o.querySelectorAll('a')].map(a => a.getAttribute('href')) }));
    };
    assert.deepEqual(await said('https://tag.junkdrawer.works/h/water-heater'), { cap: 'h / Placard',
      said: [['', 'Goes to https://placard.junkdrawer.works/#water-heater'], ['msg bad', 'OVERRIDES in 404.html has a mistake in it, so no sticker is sent elsewhere: each opens its own app\'s page. Undo the last change to 404.html on GitHub.']],
      links: ['https://placard.junkdrawer.works/#water-heater'] }, 'Check a tag on a sticker while OVERRIDES has a mistake in it');
    // a mistake in the resolver's own script stops every tap: Check a tag says so, and offers no Open
    srv.patch = b => b.replace("  t: 'https://mothball.junkdrawer.works/',", "  t: 'https://mothball.junkdrawer.works/'");
    r = await tap('/h/water-heater');
    assert.match(r.text, /This tag isn't set up/, 'a tap went on with the resolver\'s script broken');
    await sb.reload();
    assert.deepEqual(await said('https://tag.junkdrawer.works/h/water-heater'),
      { cap: 'h / Placard', said: [['msg bad', '404.html has a mistake in it, so no sticker opens anything: every tap stops on "This tag isn\'t set up". Undo the last change to 404.html on GitHub.']], links: [] },
      'Check a tag offers where a sticker goes while 404.html stops every tap');
    // the taps on a 404.html with a mistake in it said so in the console, and nothing else did
    assert.ok(errors.length > typos && errors.slice(typos).every(e => /^Unexpected|^ROUTES is not defined$/.test(e)), 'errors on the resolver page: ' + errors.slice(typos));
    errors.splice(typos);
    await sb.close();
    srv.patch = null;
    assert.deepEqual(errors, [], 'errors on the resolver page');
  } finally {
    await ctx.close();
    await srv.close();
  }
}

// A pretend Chrome NFC reader: scan() listens until its signal aborts; __nfc.tap(url, serial) holds a sticker to it (no
// url: a blank one) and says whether anything was listening. A write meets __nfc.sticker (null: a blank one): one
// holding a link (or refuse: one Chrome takes for holding something) turns down a write that mustn't write over it with
// a NotAllowedError, and a locked one fails every write as Chrome's IO error, a NetworkError. As in Chrome, either lets
// go of the sticker (__nfc.held false): a write waits until a tap brings a sticker near again, and only a tap is read.
const fakeNfc = () => {
  window.__nfc = { readers: [], writes: [], sticker: null, held: true, waiting: null };
  window.NDEFReader = class {
    async scan({ signal } = {}) {
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
      this.listening = true; window.__nfc.readers.push(this);
      signal?.addEventListener('abort', () => { this.listening = false; });
    }
    async write(m, { overwrite = true } = {}) {
      const n = window.__nfc;
      if (!n.held) await new Promise(resolve => { n.waiting = resolve; });
      const s = n.sticker;
      if (s && !overwrite && (s.url || s.refuse)) { n.held = false; throw new DOMException('NDEFWriteOptions#overwrite does not allow overwrite.', 'NotAllowedError'); }
      if (s?.locked) { n.held = false; throw new DOMException('Failed to write due to an IO error: null', 'NetworkError'); }
      n.writes.push(m.records[0].data);
    }
  };
  window.__nfc.tap = (url, serial = '04:a2:19:7c:5e:11:90') => {
    const n = window.__nfc, r = n.readers.filter(x => x.listening).at(-1);
    n.held = true;
    if (r?.onreading) r.onreading({ serialNumber: serial, message: { records: url ? [{ recordType: 'url', data: new TextEncoder().encode(url) }] : [] } });
    const w = n.waiting; n.waiting = null; w?.();
    return !!r?.onreading || !!w;
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

// Write test sticker on a sticker that already holds something: it isn't written over unless asked. The kit's sticker
// panel, the same in every app.
async function writeOver({ page, assert }) {
  const said = () => page.locator('#test-panel .nfc > .msg:last-child').evaluate(el => [el.className, el.textContent]);
  const listening = () => page.waitForFunction(() => window.__nfc.readers.some(r => r.listening));
  const press = async (sticker, holds) => {
    await page.evaluate(s => { window.__nfc.sticker = s; window.__nfc.held = true; }, sticker);
    await page.click('#test-panel >> text=Write test sticker');
    if (holds === undefined) return;
    // turned down: Chrome has let go of it, so the panel asks for it to be taken off and held there again, and reads it
    await listening();
    assert.deepEqual(await said(), ['msg wait', 'This sticker already holds something. Take it off the phone, then hold it there again.']);
    assert.equal(await page.evaluate(u => window.__nfc.tap(u), holds), true);
  };
  const writes = () => page.evaluate(() => window.__nfc.writes.length);
  const n = await writes();
  // a blank sticker: written at once, without writing over anything
  await press(null);
  await page.waitForFunction(w => window.__nfc.writes.length > w, n);
  assert.deepEqual(await said(), ['msg ok', 'Written. Tap it with the phone to check it opens this page.']);
  // the test sticker itself: already holds this link, nothing written
  await press({ url: 'https://tag.junkdrawer.works/s/test' }, 'https://tag.junkdrawer.works/s/test');
  await page.waitForFunction(() => /^Already/.test(document.querySelector('#test-panel .nfc > .msg:last-child').textContent));
  assert.deepEqual(await said(), ['msg ok', 'Already holds this link.']);
  assert.equal(await writes(), n + 1, 'written over the same link');
  // a tote's sticker: asked first, and left alone on Cancel
  await press({ url: 'https://tag.junkdrawer.works/t/02' }, 'https://tag.junkdrawer.works/t/02');
  const ask = page.getByRole('dialog', { name: 'Write over this sticker?' });
  await ask.waitFor();
  assert.equal(await ask.locator('form > p').textContent(), 'It already opens Mothball tote 02. Writing over it makes it open this page instead. Hold it to the phone again after you press Write over it.');
  assert.deepEqual(await ask.locator('button[type=submit]').evaluate(b => [b.textContent, b.className]), ['Write over it', 'btn danger']);
  await ask.locator('button', { hasText: 'Cancel' }).click();
  await page.waitForFunction(() => /^Nothing written/.test(document.querySelector('#test-panel .nfc > .msg:last-child').textContent));
  assert.deepEqual(await said(), ['msg ', 'Nothing written. The sticker keeps its old link.']);
  assert.equal(await writes(), n + 1, 'written over a tote\'s sticker without asking');
  // asked, and then another sticker held to the phone (the tote's left it while the question was up): read, and not
  // written over, since it isn't the one the question named
  await press({ url: 'https://tag.junkdrawer.works/t/02' }, 'https://tag.junkdrawer.works/t/02');
  await ask.waitFor();
  await ask.locator('button[type=submit]').click();
  await listening();
  assert.deepEqual(await said(), ['msg wait', 'Hold the sticker flat against the back of the phone, near the top, and keep it still.']);
  await page.evaluate(() => { window.__nfc.sticker = { url: 'https://tag.junkdrawer.works/t/03' }; window.__nfc.tap('https://tag.junkdrawer.works/t/03', '04:a2:19:7c:5e:11:91'); });
  await page.waitForFunction(() => /^That's a different sticker/.test(document.querySelector('#test-panel .nfc > .msg:last-child').textContent));
  assert.deepEqual(await said(), ['msg bad', 'That\'s a different sticker from the one you said to write over. Nothing written.']);
  assert.equal(await writes(), n + 1, 'wrote over a sticker nobody was asked about');
  // and written over when asked, once the same sticker is held to the phone again
  await press({ url: 'https://tag.junkdrawer.works/t/02' }, 'https://tag.junkdrawer.works/t/02');
  await ask.waitFor();
  await ask.locator('button[type=submit]').click();
  await listening();
  assert.equal(await page.evaluate(() => window.__nfc.tap('https://tag.junkdrawer.works/t/02')), true);
  await page.waitForFunction(w => window.__nfc.writes.length > w, n + 1);
  assert.deepEqual(await said(), ['msg ok', 'Written. Tap it with the phone to check it opens this page.']);
  // something that isn't a link
  await page.evaluate(() => { window.__nfc.sticker = { refuse: true }; window.__nfc.held = true; });
  await page.click('#test-panel >> text=Write test sticker');
  await listening();
  await page.evaluate(() => { const r = window.__nfc.readers.filter(x => x.listening).at(-1); window.__nfc.held = true;
    r.onreading({ serialNumber: '04', message: { records: [{ recordType: 'text', data: new TextEncoder().encode('Hello') }] } }); });
  await ask.waitFor();
  assert.match(await ask.locator('form > p').textContent(), /^It already holds something that isn't a link\. /);
  await ask.locator('button', { hasText: 'Cancel' }).click();
  // a blank sticker Chrome turns down anyway (a factory-blank one counted as holding something): written without asking
  await press({ refuse: true }, '');
  await page.waitForFunction(w => window.__nfc.writes.length > w, n + 2);
  assert.equal(await page.locator('dialog[open]').count(), 0, 'asked before writing a blank sticker');
  assert.deepEqual(await said(), ['msg ok', 'Written. Tap it with the phone to check it opens this page.']);
  // a locked sticker: asked, and the write over fails as an IO error, which says it moved away or is locked
  await press({ url: 'https://tag.junkdrawer.works/h/water-heater', locked: true }, 'https://tag.junkdrawer.works/h/water-heater');
  await ask.waitFor();
  assert.match(await ask.locator('form > p').textContent(), /^It already opens Placard's water-heater page\. /);
  await ask.locator('button[type=submit]').click();
  await listening();
  assert.equal(await page.evaluate(() => window.__nfc.tap('https://tag.junkdrawer.works/h/water-heater')), true);
  await page.waitForFunction(() => /locked/.test(document.querySelector('#test-panel .nfc > .msg:last-child').textContent));
  assert.deepEqual(await said(), ['msg bad', 'Couldn\'t write it: the sticker moved away, or it\'s locked. Hold it still and press Write again; if this comes back, it\'s locked: use a blank one.']);
  assert.equal(await writes(), n + 3);
  assert.equal(await page.evaluate(() => window.__nfc.readers.some(r => r.listening)), false, 'still listening after the writes');
  await page.evaluate(() => { window.__nfc.sticker = null; window.__nfc.held = true; });
}

// Another device: Switchboard's own connect link as a QR code, drawn only when asked (it carries the key), hidden again
// by its button or when the page is left; opened on a second phone, that phone's Switchboard is set up with it.
async function anotherDevice({ page, base, assert }) {
  const U = 'https://script.google.com/macros/s/AKfyTEST/exec', K = 'k'.repeat(40);
  assert.equal(await page.locator('#another').isVisible(), true, 'no Another device once connected');
  assert.deepEqual([await page.locator('#another-btn').textContent(), await page.locator('#another-code').isHidden(), await page.locator('#another-qr svg').count()],
    ['Another device', true, 0], 'the code is drawn before it was asked for');
  await page.click('#another-btn');
  await page.waitForSelector('#another-qr svg');
  const link = await page.locator('#another-qr').getAttribute('data-url');
  assert.match(link, /^https:\/\/tag\.junkdrawer\.works\/#connect=[A-Za-z0-9_-]+$/);
  assert.deepEqual(JSON.parse(Buffer.from(link.split('=')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()), { u: U, k: K });
  // the code is that link: the same one the kit's QR maker draws for it
  assert.ok(await page.locator('#another-qr').evaluate(async (el, u) => { const d = document.createElement('div'); d.innerHTML = (await import('./js/kit/ui.js')).qrSvg(u, { size: 260, margin: 4 }); return d.innerHTML === el.innerHTML; }, link),
    'the code drawn isn\'t the QR code of the link');
  assert.deepEqual([await page.locator('#another-btn').textContent(), await page.locator('#another-btn').getAttribute('aria-expanded')], ['Hide the code', 'true']);
  assert.match(await page.locator('#another-code .msg.wait').textContent(), /^This code carries the ledger key/);
  // big enough for a camera, and inside the card on a phone
  const box = await page.locator('#another-qr svg').evaluate(el => { const r = el.getBoundingClientRect(), c = el.closest('.card').getBoundingClientRect(); return [Math.round(r.width), r.right <= c.right]; });
  assert.deepEqual(box, [260, true]);
  await page.click('#another-btn');
  assert.deepEqual([await page.locator('#another-qr svg').count(), await page.locator('#another-code').isHidden(), await page.locator('#another-btn').textContent()], [0, true, 'Another device']);
  // left on screen and the page left (another app, the phone locked): gone when it comes back
  await page.click('#another-btn');
  await page.waitForSelector('#another-qr svg');
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { value: true, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); delete document.hidden; });
  assert.equal(await page.locator('#another-qr svg').count(), 0, 'the code stayed after the page was left');
  // the second phone: its camera opens the link, and its Switchboard is set up, with the key out of the address
  const other = await page.context().browser().newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  try {
    await other.route('https://script.google.com/**', r => r.fulfill({ contentType: 'application/json',
      body: JSON.stringify(JSON.parse(r.request().postData() || '{}').key === K ? { ok: true, version: '1.1', time: 1 } : { ok: false, error: 'bad key' }) }));
    const p2 = await other.newPage();
    await p2.goto(base + link.slice(link.indexOf('#')));
    await p2.waitForFunction(() => document.querySelector('#ledger-state').textContent === 'Connected to ledger v1.1');
    assert.deepEqual([await p2.inputValue('#lurl'), await p2.inputValue('#lkey')], [U, K], 'the second phone\'s Switchboard wasn\'t set up');
    assert.equal(new URL(p2.url()).hash, '', 'the key was left in the address');
    assert.equal(await p2.locator('#toast').textContent(), 'Connected to your ledger.');
    assert.match(await p2.locator('#app-list a').first().getAttribute('href'), /^https:\/\/placard\.junkdrawer\.works\/#connect=/, 'no Connect on the second phone');
  } finally { await other.close(); }
}

// A connect link for another ledger on a phone whose Switchboard already has one (anyone can make such a link, and
// Switchboard hands its ledger to every app): asked first, with the address tidied meanwhile, and Cancel keeps the one
// saved. The same ledger is taken at once, as is any link on a phone with none (Another device, above). Pasted into the
// page already open it's asked too, and Use it starts the page again on the new one.
async function connectAsks({ page, base, assert }) {
  const A = 'https://script.google.com/macros/s/AKfyTEST/exec', B = 'https://script.google.com/macros/s/AKfyOTHERxyz123/exec', K = 'k'.repeat(40), K2 = 'q'.repeat(40);
  const link = (u, k) => '#connect=' + Buffer.from(JSON.stringify({ u, k })).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const other = await page.context().browser().newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  try {
    await other.route('https://script.google.com/**', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, version: '1.1', time: 1 }) }));
    await other.addInitScript(([u, k]) => { if (!localStorage.getItem('switchboard.ledger')) localStorage.setItem('switchboard.ledger', JSON.stringify({ url: u, key: k })); }, [A, K]);
    const p = await other.newPage();
    const saved = () => p.evaluate(() => JSON.parse(localStorage.getItem('switchboard.ledger')));
    const ask = p.getByRole('dialog', { name: 'Use this ledger instead?' });
    await p.goto(base + link(B, K2));
    await ask.waitFor();
    assert.equal(await ask.locator('form > p').textContent(), 'This link sets Switchboard to a different ledger (…xyz123). The one saved here (…fyTEST) is forgotten on this device, and each app follows the new one when you press Connect.');
    assert.deepEqual(await ask.locator('button[type=submit]').evaluate(b => [b.textContent, b.className]), ['Use it', 'btn danger']);
    assert.equal(new URL(p.url()).hash, '', 'the key was left in the address while asking');
    await ask.locator('button', { hasText: 'Cancel' }).click();
    await p.waitForTimeout(400);
    assert.deepEqual(await saved(), { url: A, key: K }, 'Cancel didn\'t keep the ledger saved here');
    assert.deepEqual([await p.inputValue('#lurl'), await p.inputValue('#lkey')], [A, K]);
    assert.equal(new URL(p.url()).hash, '');
    // the same ledger: taken at once, as before
    await p.evaluate(h => { location.hash = h; }, link(A, K));
    await p.waitForFunction(() => document.querySelector('#toast')?.textContent === 'Connected to your ledger.');
    assert.equal(await p.locator('dialog[open]').count(), 0, 'asked about the ledger already saved');
    assert.equal(new URL(p.url()).hash, '');
    // another one pasted into the page already open: asked, and Use it starts the page again on it
    await p.evaluate(h => { location.hash = h; }, link(B, K2));
    await ask.waitFor();
    await ask.locator('button[type=submit]').click();
    await p.waitForFunction(u => JSON.parse(localStorage.getItem('switchboard.ledger') || '{}').url === u, B);
    await p.waitForFunction(u => document.querySelector('#lurl')?.value === u, B);
    assert.deepEqual(await saved(), { url: B, key: K2 });
    assert.equal(await p.inputValue('#lkey'), K2);
    assert.equal(new URL(p.url()).hash, '', 'the key was left in the address');
    // a new key for the ledger saved here: asked, in words for that
    await p.evaluate(h => { location.hash = h; }, link(B, K));
    await ask.waitFor();
    assert.equal(await ask.locator('form > p').textContent(), 'This link has another key for the ledger saved here (…xyz123). Use it only if you ran setup again: with the wrong key, nothing saves.');
    await ask.locator('button', { hasText: 'Cancel' }).click();
    await p.waitForTimeout(400);
    assert.deepEqual(await saved(), { url: B, key: K2 });
  } finally { await other.close(); }
}

// Each app's js/attention.js, as GitHub Pages serves it (any site may import it), here a stand-in for each app that says
// what it was given: its records, the time, and whether a record that was deleted reached it. `blocked`: apps whose
// site doesn't answer (404).
const STAND_INS = {
  frostbite: "export const COLLS = ['items', 'zones']; export function look(read) { const n = read('items').length; return n ? [{ text: 'Freezer: ' + n + ' past best', href: './' }] : []; }",
  packrat: "export const COLLS = ['packs', 'reads', 'loans']; export function look(read) { return read('packs').filter(p => p.weak).map(p => ({ text: 'Packs: ' + p.id + ' weak', href: '#' + p.id })); }",
  placard: "export const COLLS = ['site', 'reports']; export function look(read) { const n = read('reports').length; return n ? [{ text: 'Rental: ' + n + ' new report', href: '#/reports' }] : []; }",
  larder: "export const COLLS = ['items', 'queue']; export function look(read) { const n = read('items').length; return n ? [{ text: 'Larder: ' + n + ' on the list', href: './' }] : []; }",
  mothball: "export const COLLS = ['totes', 'builds']; export function look(read) { return []; }",
};
async function serveStandIns(target, blocked = new Set()) {
  await target.route(/^https:\/\/(placard|mothball|larder|frostbite|packrat)\.junkdrawer\.works\/js\/attention\.js/, route => {
    const app = /^https:\/\/(\w+)\./.exec(route.request().url())[1];
    if (blocked.has(app)) return route.fulfill({ status: 404, contentType: 'text/html', body: '<h1>404</h1>' });
    return route.fulfill({ contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' }, body: STAND_INS[app] });
  });
}

// Needs a look, once connected: Switchboard opens on one card of what's due, each line a link into its app, from each
// app's own attention file over its records from the ledger, and asks the ledger for nothing but lists. Setup is folded
// (the key isn't on the first screen); an app's Open Switchboard (#apps) opens it, as does a key the ledger turns
// down. With no signal, or an app's site down, the last word stays, with its time; Forget takes it all away.
async function lookChecks({ browser, base, assert }) {
  const U = 'https://script.google.com/macros/s/AKfyLOOK/exec', K = 'k'.repeat(40);
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const ops = [], errors = [], blocked = new Set();
  let google = 'up', key = K, records = {
    'frostbite.items': [{ id: 'a', name: 'Chili' }, { id: 'b', name: 'Peas', _deleted: true, _updated: 2 }],
    'packrat.packs': [{ id: '03', weak: true }, { id: '04' }], 'placard.reports': [{ id: 'r1', text: 'Drip' }], 'larder.items': [{ id: 'rice' }, { id: 'oats' }] };
  await ctx.route('https://script.google.com/**', async route => {
    if (google === 'down') return route.abort('internetdisconnected');
    const b = JSON.parse(route.request().postData() || '{}');
    ops.push(b.op);
    const out = b.key !== key ? { ok: false, error: 'bad key' } : b.op === 'list' ? { ok: true, time: Date.now(), docs: records[`${b.app}.${b.coll}`] || [] } : { ok: true, version: '1.1', time: 1 };
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(out) });
  });
  await serveStandIns(ctx, blocked);
  await ctx.addInitScript(([u, k]) => { try { if (!sessionStorage.getItem('set')) { localStorage.setItem('switchboard.ledger', JSON.stringify({ url: u, key: k })); sessionStorage.setItem('set', '1'); } } catch {} }, [U, K]);
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push(e.message));
  const state = () => p.locator('#look-state').evaluate(el => [el.className, el.textContent]);
  const lines = () => p.locator('#look-list li').evaluateAll(lis => lis.map(li => [li.textContent, li.querySelector('a')?.href || null]));
  const settled = () => p.waitForFunction(() => !/Checking/.test(document.querySelector('#look-state').textContent));
  try {
    await p.goto(base);
    await settled();
    assert.deepEqual(await state(), ['sync synced', 'Up to date']);
    assert.deepEqual(await lines(), [['Freezer: 1 past best›', 'https://frostbite.junkdrawer.works/'], ['Packs: 03 weak›', 'https://packrat.junkdrawer.works/#03'],
      ['Rental: 1 new report›', 'https://placard.junkdrawer.works/#/reports'], ['Larder: 2 on the list›', 'https://larder.junkdrawer.works/']],
    'the card\'s lines, in order, each a link into its app (a deleted record reached its app\'s file)');
    assert.equal(await p.locator('#look-list b').first().textContent(), 'Freezer:');
    // the card first; the setup cards folded, the key off the screen, the ledger's state on the fold
    assert.deepEqual(await p.evaluate(() => [...document.querySelectorAll('main > section:not([hidden]), main > details')].map(e => e.id)), ['look', 'check', 'setup']);
    assert.equal(await p.locator('#setup').evaluate(d => d.open), false, 'Setup open once connected');
    assert.equal(await p.locator('#lkey').isVisible(), false, 'the key is on the first screen');
    assert.equal(await p.locator('#setup-state').textContent(), 'Connected to ledger v1.1');
    assert.deepEqual([...new Set(ops)].sort(), ['list', 'ping'], 'Needs a look asked the ledger for something other than lists');
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth), 390);
    // the summary opens and closes it, as any fold
    await p.click('#setup > summary');
    assert.equal(await p.locator('#lkey').isVisible(), true);
    await p.click('#setup > summary');
    // an app's Open Switchboard: Setup open at Connect the apps
    await p.goto('about:blank'); await p.goto(base + '#apps');
    await p.waitForFunction(() => document.querySelector('#setup').open);
    assert.ok(await p.locator('#apps').evaluate(el => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.top < innerHeight; }), 'Connect the apps isn\'t on the screen after #apps');
    // nothing due anywhere: every record deleted in its app
    const was = records;
    records = Object.fromEntries(Object.entries(was).map(([k, docs]) => [k, docs.map(d => ({ id: d.id, _deleted: true, _updated: 3 }))]));
    await p.goto(base); await settled();
    assert.deepEqual(await lines(), [['Nothing needs a look.', null]]);
    records = was;
    await p.reload(); await settled();
    // no signal: the last word stays, with its time
    google = 'down';
    await p.reload();
    assert.equal((await lines()).length, 4, 'the last word wasn\'t there while the ledger was asked');
    await p.waitForFunction(() => document.querySelector('#look-state').classList.contains('offline'));
    assert.match((await state())[1], /^Offline — as of [A-Z][a-z]{2} \d+, \d+:\d\d [ap]m$/);
    assert.equal((await lines()).length, 4, 'the last word went with the signal');
    google = 'up';
    // Packrat's site down: its last word stays, the others are new
    blocked.add('packrat');
    records['larder.items'] = [{ id: 'rice' }, { id: 'oats', _deleted: true, _updated: 4 }];
    await p.reload(); await settled();
    assert.match((await state())[1], /^Packrat didn't answer — as of /);
    assert.deepEqual((await lines()).map(x => x[0]), ['Freezer: 1 past best›', 'Packs: 03 weak›', 'Rental: 1 new report›', 'Larder: 1 on the list›']);
    blocked.clear();
    // the key turned down (setup run again in the sheet): Setup opens on the key
    key = 'n'.repeat(40);
    await p.reload();
    await p.waitForFunction(() => document.querySelector('#look-state').classList.contains('badkey'));
    assert.match((await state())[1], /^Wrong key — as of /);
    assert.equal(await p.locator('#setup').evaluate(d => d.open), true, 'Setup stayed folded with the key turned down');
    assert.equal(await p.locator('#lkey').isVisible(), true);
    // Forget: the card goes, and nothing the apps said is kept
    await p.click('#ledger-forget');
    await p.click('dialog[open] button[type=submit]');
    await p.waitForFunction(() => document.querySelector('#look').hidden);
    assert.deepEqual(await p.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('switchboard.m.'))), [], 'Forget kept the apps\' records');
    await p.reload();
    assert.deepEqual([await p.locator('#look').isHidden(), await p.locator('#setup').evaluate(d => d.open)], [true, true]);
    assert.deepEqual(errors, [], 'errors on the page');
  } finally { await ctx.close(); }
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
  await lookChecks({ browser: ctx.browser(), base, assert });
  await serveStandIns(page);   // once this page is connected below, its card asks the apps too
  await checkATag({ page, base, assert });
  await writeOver({ page, assert });
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
  assert.equal(await page.locator('#way-back').isHidden(), true, 'the way back after a mistake shown before a ledger is set up');
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
  // once connected, the card says where to look after a mistake: the deleted cell, and Version history then the Ledger menu
  assert.equal(await page.locator('#way-back').isVisible(), true, 'no way back after a mistake on the Ledger card');
  assert.equal(await page.locator('#way-back').textContent(), 'Undo a mistake: something deleted in an app comes back with FALSE in its row\'s deleted cell (column C, in that app\'s tab of the sheet). '
    + 'For a change, restore the version from before (File, Version history), then use the sheet\'s Ledger menu, Send everything to the phones again. The steps are in the build guide\'s Reference.');
  await anotherDevice({ page, base, assert });
  await connectAsks({ page, base, assert });
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
  // a key the ledger turned down isn't handed to the apps: no Connect, and the card says what to do
  assert.equal(await page.locator('#app-list a').count(), 0, 'Connect offered with a key the ledger turned down');
  assert.deepEqual(await page.locator('#app-list .meta').allTextContents(), Array(5).fill('fix the key first'));
  assert.equal(await page.locator('#apps-msg').textContent(), 'The key here is out of date. Paste the new one from the sheet\'s About tab (B2), then Test and save.');
  assert.equal(await page.locator('#apps-msg').isVisible(), true);
  assert.equal(await page.locator('#another').isHidden(), true, 'Another device offered with a key the ledger turned down');
  // a new key typed while it was asking isn't put back by the answer
  google = 'down';
  await page.reload();
  assert.deepEqual(await state(), ['sync pending', 'Checking the ledger…']);
  await page.click('#setup > summary');   // connected, Switchboard opens on Needs a look with the ledger folded under Setup
  await page.fill('#lkey', 'n'.repeat(40));
  await page.waitForFunction(() => document.querySelector('#ledger-state').classList.contains('offline'));
  assert.equal(await page.inputValue('#lkey'), 'n'.repeat(40));
  google = 'up';
  await page.click('#ledger-test');
  await page.waitForFunction(() => document.querySelector('#ledger-state').textContent === 'Connected to ledger v1.1');
  assert.equal(await page.locator('#app-list a').count(), 5, 'Connect didn\'t come back with the new key');
  assert.equal(await page.locator('#apps-msg').isVisible(), false);
  // the test tag's landing note
  await page.goto('about:blank'); await page.goto(base + '#test');
  assert.equal(await page.locator('#test-ok').isHidden(), false, 'the test tag note shows');
  await page.waitForFunction(() => document.querySelector('#ledger-state').textContent === 'Connected to ledger v1.1');
  // Forget asks first, with the red button; Cancel keeps the address and key
  await page.click('#setup > summary');
  await page.click('#ledger-forget');
  const ask = page.getByRole('dialog', { name: 'Forget the ledger on this device?' });
  await ask.waitFor();
  assert.equal(await ask.locator('form > p').textContent(), 'Switchboard stops offering Connect here. The apps stay connected. To set it up again you need the web app address and the key from the sheet\'s About tab.');
  assert.deepEqual(await ask.locator('button[type=submit]').evaluate(b => [b.textContent, b.className]), ['Forget', 'btn danger']);
  await ask.locator('button', { hasText: 'Cancel' }).click();
  assert.deepEqual([await page.inputValue('#lurl'), await page.inputValue('#lkey')], ['https://script.google.com/macros/s/AKfyTEST/exec', 'n'.repeat(40)], 'Cancel forgot the ledger');
  assert.deepEqual(await state(), ['sync synced', 'Connected to ledger v1.1']);
  // forgotten, so nothing after this asks Google
  await page.click('#ledger-forget');
  await page.click('dialog[open] button[type=submit]');
  await page.waitForSelector('.toast.show >> text=Forgotten on this device.');
  assert.deepEqual(await state(), ['sync unset', 'Not connected to the ledger']);
  assert.equal(await page.inputValue('#lurl'), '');
  assert.equal(await page.locator('#another').isHidden(), true, 'Another device offered after Forget');
  assert.equal(await page.locator('#way-back').isHidden(), true, 'the way back after a mistake left after Forget');
  await page.unroute('https://script.google.com/**');
  for (let i = problems.length - 1; i >= from; i--) if (/script\.google\.com|junkdrawer\.works\/js\/attention\.js|Failed to load resource: net::ERR_INTERNET_DISCONNECTED/.test(problems[i])) problems.splice(i, 1);
}
