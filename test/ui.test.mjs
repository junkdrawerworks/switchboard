// The kit's small helpers (js/kit/ui.js) that need no page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ageText, agoText, daysSince, stampText, route, lines, parseDay, dayText, toastMs } from '../js/kit/ui.js';

const now = new Date(2026, 10, 27, 15, 0);   // 27 Nov 2026, 3 pm, local time
const day = n => { const d = new Date(2026, 10, 27 - n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

test('how long ago reads right on the first day, the second, the third and a month on', () => {
  assert.equal(agoText(day(0), now), 'today');
  assert.equal(agoText(day(1), now), 'yesterday');
  assert.equal(agoText(day(2), now), '2 days ago');
  assert.equal(agoText(day(31), now), '4 wk ago');
  assert.equal(agoText('2025-09-27', now), '14 mo ago');
  assert.equal(agoText('', now), '');
  assert.equal(ageText(day(0), now), 'today');
  assert.equal(ageText(day(1), now), '1 day');
  assert.equal(ageText(day(2), now), '2 days');
  assert.equal(ageText(day(31), now), '4 wk');
});

test('days are counted on the calendar: the spring clock change loses none', () => {
  const was = process.env.TZ;
  process.env.TZ = 'America/Chicago';   // the clocks went forward on Mar 8, 2026: that day had 23 hours
  try {
    const mar15 = new Date(2026, 2, 15, 12);
    assert.equal(daysSince('2026-03-01', mar15), 14);
    assert.equal(ageText('2026-03-01', mar15), '2 wk', 'Mar 1 to Mar 15 read 13 days');
    assert.equal(agoText('2026-03-08', new Date(2026, 2, 9, 0, 30)), 'yesterday', 'Mar 8 still read today on Mar 9');
    assert.equal(daysSince('2026-03-08', new Date(2026, 2, 8, 23, 59)), 0);
    assert.equal(daysSince('2026-11-01', new Date(2026, 10, 2, 0, 30)), 1, 'the fall change gains none');
    assert.equal(daysSince('2025-11-27', new Date(2026, 10, 27, 23, 0)), 365);
    assert.equal(daysSince('2026-11-28', new Date(2026, 10, 27, 9, 0)), -1, 'a day still to come');
  } finally { if (was === undefined) delete process.env.TZ; else process.env.TZ = was; }
});

test('a time from another year says the year', () => {
  assert.equal(stampText(new Date(2026, 10, 27, 9, 5).getTime(), now), 'Nov 27, 9:05 am');
  assert.equal(stampText(new Date(2025, 11, 9, 18, 0).getTime(), now), 'Dec 9, 2025, 6:00 pm');
});

test('an address that is cut short or mistyped opens the home page', () => {
  assert.deepEqual(route('#%E0%A4%A'), { view: 'home' });
  assert.deepEqual(route('#%'), { view: 'home' });
  assert.deepEqual(route('#04'), { view: 'item', id: '04' });
  assert.deepEqual(route('#Water-Heater'), { view: 'item', id: 'water-heater' });
  assert.deepEqual(route('#/label/01'), { view: 'label', arg: '01' });
  assert.deepEqual(route('#tree%20topper'), { view: 'item', id: 'tree topper' });
  assert.deepEqual(route(''), { view: 'home' });
});

test('lines take off typed numbering and bullets, and keep a number the line starts with', () => {
  assert.deepEqual(lines('1. Turn it off\n2) Wait a minute\n- Call\n* Text\n• Email\n\n  10. Ten  '), ['Turn it off', 'Wait a minute', 'Call', 'Text', 'Email', 'Ten']);
  assert.deepEqual(lines('0.5 inch of water in the pan is normal\n1.5 turns counterclockwise opens it\n-10°F or colder: let the kitchen tap drip\n2.5 m extension lead'),
    ['0.5 inch of water in the pan is normal', '1.5 turns counterclockwise opens it', '-10°F or colder: let the kitchen tap drip', '2.5 m extension lead']);
  assert.deepEqual(lines('- -10°F: drip the tap\n3) 0.5 inch\n12 V supply\n2024 model'), ['-10°F: drip the tap', '0.5 inch', '12 V supply', '2024 model']);
  assert.deepEqual(lines(''), []);
});

test('a day reads in the year written, at local midnight', () => {
  assert.equal(parseDay('0026-11-20').getFullYear(), 26, 'year 26 read as 1926');
  assert.equal(dayText('0026-11-20'), 'Nov 20, 26');
  const d = parseDay('2026-11-27');
  assert.deepEqual([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()], [2026, 10, 27, 0, 0]);
  assert.equal(parseDay('2026-03-08').getHours(), 0);
  assert.equal(dayText('1999-12-31'), 'Dec 31, 1999');
});

test('a toast stays long enough to read: 1.2 s and 60 ms a character, at least 2.6 s', () => {
  assert.equal(toastMs('Saved.'), 2600);
  assert.equal(toastMs('Read the pack on Cellmate first (on your Wi-Fi), then try again.'), 1200 + 60 * 64);
});

// ---- the sheet and buttons, on a small stand-in for the page: elements with attributes, children, events and focus
class FakeNode extends EventTarget {
  constructor(tag) {
    super(); this.tagName = tag.toUpperCase(); this.childNodes = []; this.attrs = {}; this.style = {}; this.dataset = {};
    this.className = ''; this.value = ''; this.parentNode = null; this.open = false; this.disabled = false; this.width = 120;
  }
  get children() { return this.childNodes.filter(n => !(n instanceof FakeText)); }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  hasAttribute(k) { return k in this.attrs; }
  removeAttribute(k) { delete this.attrs[k]; }
  append(...kids) { for (const k of kids) { const n = typeof k === 'string' ? new FakeText(k) : k; n.parentNode = this; this.childNodes.push(n); } }
  replaceChildren(...kids) { this.childNodes = []; this.append(...kids); }
  remove() { if (this.parentNode) this.parentNode.childNodes = this.parentNode.childNodes.filter(n => n !== this); this.parentNode = null; }
  get textContent() { return this.childNodes.map(n => n.textContent).join(''); }
  set textContent(t) { this.childNodes = []; if (t !== '') this.append(new FakeText(String(t))); }
  focus() { globalThis.document.activeElement = this; }
  getBoundingClientRect() { return { width: this.width, height: 44 }; }
  get offsetWidth() { return this.width; }
  showModal() { this.open = true; const a = this.all().find(n => n.hasAttribute?.('autofocus')); (a || this.all().find(n => ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(n.tagName)))?.focus(); }
  close() { if (!this.open) return; this.open = false; this.dispatchEvent(new Event('close')); }
  all() { return this.childNodes.flatMap(n => n instanceof FakeText ? [] : [n, ...n.all()]); }
  find(pred) { return this.all().find(pred); }
}
class FakeText extends FakeNode { constructor(t) { super('#text'); this.data = t; } get textContent() { return this.data; } all() { return []; } }
function fakePage({ coarse = false } = {}) {
  const body = new FakeNode('body');
  globalThis.Node = FakeNode;
  globalThis.document = { body, activeElement: null, createElement: t => new FakeNode(t), createTextNode: t => new FakeText(t), querySelector: () => null };
  globalThis.matchMedia = q => ({ matches: q === '(pointer: coarse)' && coarse });
  const dialog = () => body.children.filter(n => n.tagName === 'DIALOG' && n.open).at(-1);
  const field = name => dialog().find(n => n.attrs.name === name);
  const submit = () => dialog().find(n => n.tagName === 'FORM').dispatchEvent(new Event('submit', { cancelable: true }));
  const button = text => dialog().find(n => n.tagName === 'BUTTON' && n.textContent === text);
  return { body, dialog, field, submit, button };
}
const later = (ms = 0) => new Promise(r => setTimeout(r, ms));

test('a Save the app refuses keeps the sheet open with what was typed, says why, and focuses the field it names', async () => {
  const p = fakePage();
  const { sheet } = await import('../js/kit/ui.js');
  const taken = new Set(['01', '02']), checked = [];
  const done = sheet({ title: 'Tote 01', fields: [{ name: 'id', label: 'Number', value: '01' }, { name: 'items', label: 'Contents', type: 'textarea' }],
    check: v => { checked.push(v.id); return taken.has(v.id) && v.id !== '01' ? { field: 'id', line: `There's already a tote ${v.id}.` } : ''; } });
  let result = 'open';
  done.then(v => { result = v; });
  p.field('items').value = 'Three foam pumpkins\nTimer plug';
  p.field('id').value = '02';
  p.field('items').focus();
  p.submit(); await later();
  assert.equal(result, 'open', 'the sheet closed on a refused Save');
  assert.equal(p.dialog().open, true);
  const msg = p.dialog().find(n => /sheet-msg/.test(n.className));
  assert.equal(msg.textContent, "There's already a tote 02.");
  assert.equal(msg.getAttribute('aria-live'), 'polite');
  assert.equal(document.activeElement, p.field('id'), 'the focus is not on the number');
  assert.equal(p.field('items').value, 'Three foam pumpkins\nTimer plug', 'what was typed went');
  p.field('id').value = '03';
  p.submit(); await later();
  assert.deepEqual(result, { id: '03', items: 'Three foam pumpkins\nTimer plug' });
  assert.deepEqual(checked, ['02', '03']);
});

test('a check may wait (a question in a sheet of its own), and a line alone or a field alone keeps the sheet open', async () => {
  const p = fakePage();
  const { sheet } = await import('../js/kit/ui.js');
  let answer, said = ['Still loading from the ledger. Try again in a moment.', { field: 'net' }, ''];
  const done = sheet({ title: 'New spice jar', fields: [{ name: 'name', label: 'Name' }, { name: 'net', label: 'Net weight' }],
    check: () => new Promise(r => { answer = () => r(said.shift()); }) });
  let result = 'open';
  done.then(v => { result = v; });
  p.field('name').value = 'Sumac';
  p.submit(); await later();
  p.submit(); await later();                                         // a second press while it checks does nothing more
  answer(); await later();
  assert.equal(result, 'open');
  assert.equal(p.dialog().find(n => /sheet-msg/.test(n.className)).textContent, 'Still loading from the ledger. Try again in a moment.');
  p.submit(); await later(); answer(); await later();
  assert.equal(result, 'open', '{ field } alone closed the sheet');
  assert.equal(document.activeElement, p.field('net'));
  assert.equal(p.dialog().find(n => /sheet-msg/.test(n.className)).textContent, '', 'the old line stayed');
  p.submit(); await later(); answer(); await later();
  assert.deepEqual(result, { name: 'Sumac', net: '' });
  // Cancel while a check waits: the sheet answers null, and the check's answer changes nothing after
  const again = sheet({ title: 'New spice jar', fields: [{ name: 'name', label: 'Name' }], check: () => new Promise(r => { answer = () => r(''); }) });
  let second = 'open'; again.then(v => { second = v; });
  p.submit(); await later();
  p.button('Cancel').dispatchEvent(new Event('click'));
  answer(); await later();
  assert.equal(second, null);
});
