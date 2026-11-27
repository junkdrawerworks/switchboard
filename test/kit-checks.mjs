// The house kit's own checks, run by test/e2e.mjs in every tag app (copied from the build folder's common/kit by
// scaffold.py): the keyboard focus ring and the red toast can be seen, light and dark, a toast is announced and stays
// long enough to read, the sample's Leave the sample is a target a thumb can't miss, and the page shrinks above the
// on-screen keyboard. fieldsUnderBar is for the apps' own checks.
// WCAG relative luminance and contrast ratio of two computed colours ('rgb(…)' or 'rgba(…)').
const lum = c => {
  const [r, g, b] = c.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

// A sheet open on a short screen (the page resized above the on-screen keyboard): each field, focused in turn, sits
// above the sticky Save bar and inside the sheet. Returns the fields that don't.
export async function fieldsUnderBar(page) {
  return page.evaluate(async () => {
    const d = [...document.querySelectorAll('dialog[open]')].at(-1), bad = [];
    for (const f of d.querySelectorAll('input, select, textarea')) {
      if (f.getBoundingClientRect().width < 3 || f.closest('[aria-hidden="true"]')) continue;
      f.focus();
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const a = f.getBoundingClientRect(), bar = d.querySelector('.sheet-bar').getBoundingClientRect(), top = Math.max(0, d.getBoundingClientRect().top);
      if (a.bottom > bar.top + 1 || a.top < top - 1) bad.push(`#${f.id} at ${Math.round(a.top)}-${Math.round(a.bottom)}, the bar at ${Math.round(bar.top)}`);
    }
    return bad;
  });
}

export async function kitChecks({ browser, base, assert }) {
  for (const dark of [false, true]) {
    const scheme = dark ? 'dark' : 'light';
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: scheme, serviceWorkers: 'block' });
    try {
      const page = await ctx.newPage();
      await page.goto(base);
      await page.waitForFunction(() => document.readyState === 'complete' && document.querySelector('main a[href], main button, #app a[href], #app button'));
      // the toast's live region is on the page before anything is said in it, so the first toast is announced
      assert.deepEqual(await page.evaluate(() => { const t = document.querySelector('#toast'); return t && [t.getAttribute('role'), t.textContent]; }), ['status', ''],
        `${scheme}: no empty role=status toast region when the page loads`);
      // Tab onto the first button or link: its ring against the page and against a card
      let ring = null;
      for (let i = 0; i < 12 && !ring; i++) {
        await page.keyboard.press('Tab');
        ring = await page.evaluate(() => {
          const el = document.activeElement;
          if (!el || el === document.body || !el.matches(':focus-visible')) return null;
          const s = getComputedStyle(el), root = getComputedStyle(document.documentElement);
          const probe = document.createElement('i'); probe.style.color = root.getPropertyValue('--panel'); document.body.append(probe);
          const panel = getComputedStyle(probe).color; probe.remove();
          return { what: el.textContent.trim().slice(0, 30), style: s.outlineStyle, width: parseFloat(s.outlineWidth), color: s.outlineColor, bg: getComputedStyle(document.body).backgroundColor, panel };
        });
      }
      assert.ok(ring, `${scheme}: nothing on the page takes the keyboard's focus`);
      assert.equal(ring.style, 'solid'); assert.ok(ring.width >= 2, `${scheme}: the focus ring is ${ring.width} px`);
      for (const [where, bg] of [['the page', ring.bg], ['a card', ring.panel]]) {
        const r = contrast(ring.color, bg);
        assert.ok(r >= 3, `${scheme}: the focus ring on "${ring.what}" is ${r.toFixed(2)}:1 against ${where} (${ring.color} on ${bg}); it needs 3:1`);
      }
      // the red toast's words against its red
      const bad = await page.evaluate(async () => {
        const { toast } = await import('./js/kit/ui.js');
        toast('Couldn\'t send it. Check the signal, or call.', 'bad');
        const s = getComputedStyle(document.querySelector('#toast'));
        return { color: s.color, bg: s.backgroundColor };
      });
      const r = contrast(bad.color, bad.bg);
      assert.ok(r >= 4.5, `${scheme}: the red toast is ${r.toFixed(2)}:1 (${bad.color} on ${bad.bg}); it needs 4.5:1`);
      // a confirm's red button (Delete, Lock it, Clear it): its words against its red
      const red = await page.evaluate(() => { const b = document.createElement('button'); b.className = 'btn danger'; b.textContent = 'Delete'; document.body.append(b);
        const s = getComputedStyle(b), out = { color: s.color, bg: s.backgroundColor }; b.remove(); return out; });
      const rr = contrast(red.color, red.bg);
      assert.ok(rr >= 4.5, `${scheme}: the red Delete button is ${rr.toFixed(2)}:1 (${red.color} on ${red.bg}); it needs 4.5:1`);
      if (!dark) {
        // the page shrinks above the on-screen keyboard (Chrome on Android otherwise lays it over the sheet's Save bar)
        assert.match(await page.evaluate(() => document.querySelector('meta[name=viewport]')?.content || ''), /interactive-widget=resizes-content/,
          'the viewport meta lets the keyboard cover the page');
        // a long message stays up long enough to read: 1.2 s and 60 ms a character, at least 2.6 s
        const text = 'Read the pack on Cellmate first (on your Wi-Fi), then try again.';   // 64 characters: 5 s
        await page.evaluate(async t => { const { toast } = await import('./js/kit/ui.js'); toast(t, 'bad'); }, text);
        await page.waitForTimeout(4500);
        assert.equal(await page.locator('#toast.show').count(), 1, 'a long toast went before it could be read');
        await page.waitForFunction(() => !document.querySelector('#toast.show'), null, { timeout: 2000 });
        await page.evaluate(async () => { const { toast } = await import('./js/kit/ui.js'); toast('Saved.'); });
        await page.waitForTimeout(2300);
        assert.equal(await page.locator('#toast.show').count(), 1, 'a short toast went before 2.6 s');
      }
      // the sample's way out (in every app that has a sample): at least 44 px tall
      if (await page.evaluate(() => fetch('js/app.js').then(r => r.text()).then(t => t.includes('sampleLink')))) {
        await page.goto(base + '?demo');
        await page.waitForSelector('a.sample-out');
        const box = await page.locator('a.sample-out').boundingBox();
        assert.ok(box.height >= 44, `${scheme}: Leave the sample is ${Math.round(box.width)} x ${Math.round(box.height)} px; it needs 44 px of height`);
        // the sample's status dot can be seen: 3:1 against the page (it was the tape's edge colour, 1.00:1 in dark mode)
        const dot = await page.evaluate(() => { const s = document.querySelector('.sync.demo'); return s && [getComputedStyle(s, '::before').backgroundColor, getComputedStyle(document.body).backgroundColor]; });
        if (dot) { const r = contrast(...dot); assert.ok(r >= 3, `${scheme}: the sample's status dot is ${r.toFixed(2)}:1 against the page (${dot[0]} on ${dot[1]})`); }
      }
    } finally { await ctx.close(); }
  }
}
