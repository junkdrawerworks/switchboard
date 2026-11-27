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

// 404.html's scripts (the one in its head, then the one at the end of its body) with a pretend page. overrides: lines
// put into OVERRIDES, as Mark would.
function runResolver(pathname, overrides = '') {
  let html = readFileSync(new URL('../404.html', import.meta.url), 'utf8');
  if (overrides) html = html.replace('var OVERRIDES = {\n};', `var OVERRIDES = {\n${overrides}\n};`);
  const els = { title: { textContent: 'This tag isn\'t set up' }, app: { hidden: true } };
  const el = id => (els[id] ||= { textContent: '', href: '' });
  const ctx = { location: { origin: 'https://tag.junkdrawer.works', host: 'tag.junkdrawer.works', pathname, replace(u) { ctx.went = u; } },
    navigator: { serviceWorker: { register(u) { ctx.registered = u; return Promise.resolve(); } } }, document: { getElementById: el } };
  vm.createContext(ctx);
  ctx.window = ctx; // the page's globals are window's, as in a browser
  for (const [, script] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) vm.runInContext(script, ctx);
  return { went: ctx.went, routes: ctx.ROUTES, names: ctx.NAMES, registered: ctx.registered,
    title: els.title.textContent, shown: !els.app.hidden ? `${el('why').textContent} ${el('name').textContent} ${el('open').href}` : '' };
}

test('the resolver page sends each letter to the same app as tags.js', () => {
  const { routes, names } = runResolver('/nothing');
  assert.deepEqual(Object.keys(routes).sort(), Object.keys(APPS).sort());
  assert.deepEqual(Object.keys(names).sort(), Object.keys(APPS).sort());
  for (const [l, a] of Object.entries(APPS)) { assert.equal(routes[l], a.base, `letter ${l}`); assert.equal(names[l], a.name, `letter ${l}`); }
  assert.equal(runResolver('/h/water-heater').went, 'https://placard.junkdrawer.works/#water-heater');
  assert.equal(runResolver('/P/Cumin/').went, 'https://larder.junkdrawer.works/#cumin');
  assert.equal(runResolver('/s/test').went, 'https://tag.junkdrawer.works/#test');
  assert.equal(runResolver('/z/whatever').went, undefined);
  assert.equal(runResolver('/h/').went, undefined);
  // a tap leaves Switchboard's offline copy behind (the worker at the site's root), so the next one works with no signal
  assert.equal(runResolver('/h/water-heater').registered, 'https://tag.junkdrawer.works/sw.js');
});

test('the resolver page: overrides in any case, and a link cut short or mistyped', () => {
  // OVERRIDES keys are matched lowercased, like the tapped address: 'H/Boiler' once was silently ignored
  const o = "  'H/Boiler': 'https://example.com/boiler',\n  'h/water-heater': 'https://example.com/manual'";
  assert.equal(runResolver('/h/boiler', o).went, 'https://example.com/boiler');
  assert.equal(runResolver('/H/BOILER/', o).went, 'https://example.com/boiler');
  assert.equal(runResolver('/H/Water-Heater', o).went, 'https://example.com/manual');
  assert.equal(runResolver('/h/other', o).went, 'https://placard.junkdrawer.works/#other');
  // a whole tag goes on, and its page never says anything else meanwhile
  const ok = runResolver('/h/water-heater');
  assert.deepEqual([ok.title, ok.shown], ['This tag isn\'t set up', '']);
  // a letter an app owns with an id that isn't a whole one: cut short or mistyped, and a way into that app
  for (const path of ['/h/', '/h', '/h/-bad', '/h/a_b', '/h/water%2Dheater', '/h/' + 'a'.repeat(41), '/h/water-heater/extra', '/H/x.html']) {
    const r = runResolver(path);
    assert.equal(r.went, undefined, path);
    assert.equal(r.title, 'This link is cut short or mistyped', path);
    assert.equal(r.shown, 'which isn\'t a whole tag address. Placard https://placard.junkdrawer.works/', path);
  }
  assert.equal(runResolver('/m/').shown, 'which isn\'t a whole tag address. Packrat https://packrat.junkdrawer.works/');
  // a letter no app owns, or no letter at all: as before
  for (const path of ['/x/foo', '/hh/x', '/']) {
    const r = runResolver(path);
    assert.deepEqual([r.went, r.title, r.shown], [undefined, 'This tag isn\'t set up', ''], path);
  }
});
