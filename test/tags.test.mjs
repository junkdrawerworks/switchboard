// Tag links and the resolver page, without a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { APPS, parseTag, resolve, tagUrl, slug, newId, uniqueSlug } from '../js/kit/tags.js';
import { readOverrides, overridesWork, resolverWorks } from '../js/overrides.js';

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

test('a made-up id is never one a sheet would read as a number (all digits, or digits e digits)', () => {
  const ABC = 'abcdefghjkmnpqrstuvwxyz23456789', at = c => (ABC.indexOf(c) + 0.5) / ABC.length, letter = c => (ABC.indexOf(c) + 0.5) / 23;
  const seq = xs => { let i = 0; return () => xs[i++ % xs.length]; };
  // '234e56' is 2.34 × 10^58 to a Sheet, and '23456' a number: such an id's first character becomes a letter
  assert.equal(newId(6, seq([...[...'234e56'].map(at), letter('k')])), 'k34e56');
  assert.equal(newId(5, seq([...[...'23456'].map(at), letter('p')])), 'p3456');
  assert.equal(newId(5, () => at('7')), 'y7777');
  assert.equal(newId(6, seq([...'2a4e56'].map(at))), '2a4e56', 'an id with another letter is left as it is');
  for (let i = 0; i < 20000; i++) assert.doesNotMatch(newId(i % 2 ? 6 : 5), /^\d+(e\d+)?$/);
});

// 404.html's scripts (OVERRIDES's and the resolver's in its head, then the one at the end of its body) with a pretend
// page. overrides: lines put into OVERRIDES, as the owner would. A script that throws stops there and the next one still
// runs, as in a browser (errors: what each said). overrides in the answer: the ones the resolver used, lowercased.
// patch: a change to the rest of the file.
function runResolver(pathname, overrides = '', patch = html => html) {
  let html = patch(readFileSync(new URL('../404.html', import.meta.url), 'utf8'));
  if (overrides) html = html.replace('var OVERRIDES = {\n};', `var OVERRIDES = {\n${overrides}\n};`);
  const els = { title: { textContent: 'This tag isn\'t set up' }, app: { hidden: true } };
  const el = id => (els[id] ||= { textContent: '', href: '' });
  const ctx = { location: { origin: 'https://tag.junkdrawer.works', host: 'tag.junkdrawer.works', pathname, replace(u) { ctx.went = u; } },
    navigator: { serviceWorker: { register(u) { ctx.registered = u; return Promise.resolve(); } } }, document: { getElementById: el } };
  vm.createContext(ctx);
  ctx.window = ctx; // the page's globals are window's, as in a browser
  const errors = [];
  for (const [, script] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) try { vm.runInContext(script, ctx); } catch (e) { errors.push(e.message); }
  return { html, errors, went: ctx.went, routes: ctx.ROUTES, names: ctx.NAMES, overrides: { ...ctx.__overrides }, registered: ctx.registered, here: el('here').textContent, points: !el('points').hidden,
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
  // the address as typed: an encoded letter or space reads as itself, and one that doesn't decode as it came
  assert.equal(runResolver('/h/w%C3%A4ter').here, 'tag.junkdrawer.works/h/wäter');
  assert.equal(runResolver('/h/water%20heater').here, 'tag.junkdrawer.works/h/water heater');
  assert.equal(runResolver('/h/%E0%A4%A').here, 'tag.junkdrawer.works/h/%E0%A4%A');
  // a right-to-left override (or any direction mark) in the address can't turn the page's sentence round
  assert.equal(runResolver('/h/%E2%80%AEab').here, 'tag.junkdrawer.works/h/ab');
  assert.equal(runResolver('/h/a%E2%81%A6b%E2%81%A9%E2%80%8Fc%D8%9C').here, 'tag.junkdrawer.works/h/abc');
  // the page opened by its own name isn't a sticker that "points at …/404.html"
  const own = runResolver('/404.html');
  assert.deepEqual([own.went, own.title, own.points, own.shown], [undefined, 'Switchboard\'s page for tags', false, '']);
  assert.equal(runResolver('/x/foo').points, true);
  // a letter no app owns, or no letter at all: as before
  for (const path of ['/x/foo', '/hh/x', '/']) {
    const r = runResolver(path);
    assert.deepEqual([r.went, r.title, r.shown], [undefined, 'This tag isn\'t set up', ''], path);
  }
});

test('Check a tag reads OVERRIDES as the resolver does, so it shows where a tap really goes', () => {
  // as shipped: none, and both scripts run
  assert.deepEqual(readOverrides(runResolver('/nothing').html), {});
  assert.deepEqual(runResolver('/nothing').overrides, {});
  assert.deepEqual(runResolver('/nothing').errors, []);
  assert.equal(overridesWork(runResolver('/nothing').html), true);
  // the owner's lines, each way they might be typed: either quote, any case, a comma or none at the end, one commented out
  for (const lines of [
    "  'h/water-heater': 'https://placard.junkdrawer.works/#water-shutoff'",
    "  'H/Boiler': 'https://example.com/boiler',\n  \"h/well-tank\": \"https://example.com/tank?a=1&b=2\",\n  // 'h/old': 'https://example.com/old',\n  'm/03':'https://example.com/pack'",
    "  /* moved in March */ 'h/range': 'https://example.com/range', // the new one\n"]) {
    const r = runResolver('/nothing', lines);
    assert.deepEqual(r.errors, [], lines);
    assert.equal(resolverWorks(r.html), true, lines);
    assert.equal(overridesWork(r.html), true, lines);
    assert.deepEqual(readOverrides(r.html), r.overrides, `Check a tag and the resolver read OVERRIDES differently: ${lines}`);
    assert.ok(Object.keys(r.overrides).length, 'the resolver took none of them: ' + lines);
  }
  // and where the resolver sends the sticker is where Check a tag says it goes
  const o = "  'H/Water-Heater': 'https://placard.junkdrawer.works/#water-shutoff'";
  const r = runResolver('/h/water-heater', o);
  assert.equal(resolve('h', 'water-heater', readOverrides(r.html)), r.went);
  assert.equal(resolve('h', 'well-tank', readOverrides(r.html)), 'https://placard.junkdrawer.works/#well-tank');
  // the block the reader looks for is in 404.html, in its shape
  assert.match(readFileSync(new URL('../404.html', import.meta.url), 'utf8'), /\nvar OVERRIDES = \{\n\};\n/, '404.html\'s OVERRIDES block changed shape: change js/overrides.js with it');
});

test('a mistake typed into OVERRIDES loses only the overrides: every sticker still opens its app, and Check a tag knows', () => {
  assert.equal(resolverWorks(runResolver('/nothing').html), true, 'as shipped');
  // OVERRIDES is a script of its own, before the resolver's
  const html = runResolver('/nothing').html, scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  assert.equal(scripts.length, 3);
  assert.match(scripts[0], /\nvar OVERRIDES = \{\n\};\n$/, 'OVERRIDES isn\'t on its own in the first script');
  assert.match(scripts[1], /var ROUTES = /);
  assert.doesNotMatch(scripts[1], /OVERRIDES\s*=[^=]/, 'the resolver assigns to OVERRIDES');
  for (const [what, lines] of [
    ['a comma left out between two lines', "  'h/water-heater': 'https://example.com/manual'\n  'h/smoke-co': 'https://example.com/alarm'"],
    ['curly quotes from a phone keyboard', "  \u2018h/water-heater\u2019: \u2018https://example.com/manual\u2019,"],
    ['= for :', "  'h/water-heater' = 'https://example.com/manual',"],
    ['an address without its quotes (it runs, then stops on a name it doesn\'t know)', "  'h/water-heater': https://example.com/manual,"]]) {
    for (const [path, app] of [['/h/water-heater', 'https://placard.junkdrawer.works/#water-heater'], ['/h/smoke-co', 'https://placard.junkdrawer.works/#smoke-co'], ['/t/01', 'https://mothball.junkdrawer.works/#01']]) {
      const r = runResolver(path, lines);
      assert.equal(r.went, app, `${what}: a tap on ${path}`);
      assert.equal(r.errors.length, 1, `${what}: not just OVERRIDES's script stopped: ${r.errors}`);
      assert.deepEqual(r.overrides, {}, `${what}: the resolver used an override`);
      assert.equal(r.registered, 'https://tag.junkdrawer.works/sw.js', `${what}: no offline copy left behind`);
    }
    // a link cut short still says so, with a way into its app
    assert.equal(runResolver('/h/', lines).title, 'This link is cut short or mistyped', what);
    const { html } = runResolver('/nothing', lines);
    assert.equal(resolverWorks(html), true, `${what}: Check a tag says no sticker opens anything`);
    assert.equal(overridesWork(html), false, `${what}: Check a tag doesn't see the mistake in OVERRIDES`);
    assert.deepEqual(readOverrides(html), {}, `${what}: Check a tag reads an override no tap gets`);
  }
});

test('a mistake in the resolver\'s own script stops every tap, and Check a tag knows it', () => {
  const broken = h => h.replace("  t: 'https://mothball.junkdrawer.works/',", "  t: 'https://mothball.junkdrawer.works/'");
  for (const path of ['/h/water-heater', '/t/01']) {
    const r = runResolver(path, '', broken);
    assert.notEqual(r.html, runResolver(path).html);
    assert.equal(r.went, undefined, path);
    assert.equal(r.errors.length, 2, `the resolver's and the page's last script didn't both stop: ${r.errors}`);
    assert.equal(resolverWorks(r.html), false, 'Check a tag takes 404.html for working');
  }
});

test('a pair kept in a comment reads as the tap goes', () => {
  // an old pair kept in a comment after the new one: the tap goes to the new one, and Check a tag says so
  const kept = "  'h/water-heater': 'https://example.com/new', // was 'h/water-heater': 'https://example.com/old'";
  const r = runResolver('/h/water-heater', kept);
  assert.equal(r.went, 'https://example.com/new');
  assert.equal(resolverWorks(r.html), true);
  assert.equal(resolve('h', 'water-heater', readOverrides(r.html)), r.went, 'Check a tag reads the commented-out pair');
});
