// Tag links and the resolver page, without a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { APPS, parseTag, resolve, tagUrl, slug, newId, uniqueSlug } from '../js/kit/tags.js';

test('tag links round-trip', () => {
  assert.equal(tagUrl('h', 'water-heater'), 'https://tag.junkdrawer.works/h/water-heater');
  assert.deepEqual(parseTag('https://tag.junkdrawer.works/h/water-heater'), { letter: 'h', id: 'water-heater' });
  assert.deepEqual(parseTag('HTTP://TAG.junkdrawer.works/P/Cumin/'), { letter: 'p', id: 'cumin' });
  assert.equal(parseTag('https://parts-bin.junkdrawer.works/#bag/001'), null);
  assert.equal(parseTag('https://tag.junkdrawer.works/h/'), null);
  assert.equal(resolve('p', 'cumin'), 'https://larder.junkdrawer.works/#cumin');
  assert.equal(resolve('h', 'x', { 'h/x': 'https://example.com/' }), 'https://example.com/');
  assert.equal(resolve('z', 'x'), null);
});

test('slugs and ids', () => {
  assert.equal(slug('Smoked Paprika (Spanish)'), 'smoked-paprika-spanish');
  assert.equal(slug('Crème brûlée & co'), 'creme-brulee-and-co');
  assert.equal(uniqueSlug('Cumin', new Set(['cumin', 'cumin-2'])), 'cumin-3');
  let n = 0; const id = newId(5, () => (n++ % 7) / 7);
  assert.match(id, /^[a-z2-9]{5}$/);
});

function runResolver(pathname) {
  const html = readFileSync(new URL('../404.html', import.meta.url), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const ctx = { location: { pathname, replace(u) { ctx.went = u; } }, window: {} };
  vm.createContext(ctx); vm.runInContext(script, ctx);
  return { went: ctx.went, routes: ctx.ROUTES };
}

test('the resolver page sends each letter to the same app as tags.js', () => {
  const { routes } = runResolver('/nothing');
  assert.deepEqual(Object.keys(routes).sort(), Object.keys(APPS).sort());
  for (const [l, a] of Object.entries(APPS)) assert.equal(routes[l], a.base, `letter ${l}`);
  assert.equal(runResolver('/h/water-heater').went, 'https://placard.junkdrawer.works/#water-heater');
  assert.equal(runResolver('/P/Cumin/').went, 'https://larder.junkdrawer.works/#cumin');
  assert.equal(runResolver('/s/test').went, 'https://tag.junkdrawer.works/#test');
  assert.equal(runResolver('/z/whatever').went, undefined);
  assert.equal(runResolver('/h/').went, undefined);
});
