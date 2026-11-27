// Switchboard's own checks, run by test/e2e.mjs on a phone-sized page.

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

export async function appChecks({ page, base, assert, problems }) {
  await checkATag({ page, base, assert });
  assert.equal(await page.locator('#route-rows tr').count(), 6, 'six letters in the table');
  assert.equal(await page.locator('#app-list li').count(), 5, 'five apps to connect');
  assert.match(await page.locator('#app-list').innerText(), /ledger first/, 'apps wait for the ledger');
  assert.equal(await page.locator('#test-panel .url').innerText(), 'https://tag.junkdrawer.works/s/test');
  // a pretend ledger answers the test: a wrong key, then the right one
  await page.route('https://script.google.com/**', async route => {
    const body = JSON.parse(route.request().postData() || '{}');
    const ok = body.key === 'k'.repeat(40);
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(ok ? { ok: true, version: '1.0', time: 1 } : { ok: false, error: 'bad key' }) });
  });
  await page.fill('#lurl', 'https://script.google.com/macros/s/AKfyTEST/exec');
  await page.fill('#lkey', 'wrong');
  await page.click('#ledger-test');
  await page.waitForFunction(() => /key is wrong/.test(document.querySelector('#ledger-msg').textContent));
  await page.fill('#lkey', 'k'.repeat(40));
  await page.click('#ledger-test');
  await page.waitForFunction(() => /Connected to ledger v1.0/.test(document.querySelector('#ledger-msg').textContent));
  const link = await page.locator('#app-list a').first().getAttribute('href');
  assert.match(link, /^https:\/\/placard\.junkdrawer\.works\/#connect=[A-Za-z0-9_-]+$/);
  const cfg = JSON.parse(Buffer.from(link.split('=')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
  assert.deepEqual(cfg, { u: 'https://script.google.com/macros/s/AKfyTEST/exec', k: 'k'.repeat(40) });
  // the test tag's landing note
  await page.goto('about:blank'); await page.goto(base + '#test');
  assert.equal(await page.locator('#test-ok').isHidden(), false, 'the test tag note shows');
  await page.unroute('https://script.google.com/**');
  for (let i = problems.length - 1; i >= 0; i--) if (/script\.google\.com/.test(problems[i])) problems.splice(i, 1);
}
