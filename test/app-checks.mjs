// Switchboard's own checks, run by test/e2e.mjs on a phone-sized page.
export async function appChecks({ page, base, assert, problems }) {
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
