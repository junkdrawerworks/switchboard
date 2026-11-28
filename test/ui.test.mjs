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
  focus() { globalThis.document.activeElement = this; this.dispatchEvent(new Event('focusin')); }
  contains(n) { for (; n; n = n.parentNode) if (n === this) return true; return false; }
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
  const win = new EventTarget();
  globalThis.addEventListener = win.addEventListener.bind(win); globalThis.removeEventListener = win.removeEventListener.bind(win);
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
  let asked = 0;
  const done = sheet({ title: 'New spice jar', fields: [{ name: 'name', label: 'Name' }, { name: 'net', label: 'Net weight' }],
    check: () => { asked++; return new Promise(r => { answer = () => r(said.shift()); }); } });
  let result = 'open';
  done.then(v => { result = v; });
  p.field('name').value = 'Sumac';
  p.submit(); await later();
  p.submit(); await later();                                         // a second press while it checks does nothing more
  assert.equal(asked, 1, 'a second press while it checked asked again (Larder would open a second question)');
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

test('a check that fails says so and keeps the sheet open with what was typed, so Save never just does nothing', async () => {
  const p = fakePage();
  const { sheet } = await import('../js/kit/ui.js');
  const warned = [], warn = console.warn;
  console.warn = e => warned.push(e);
  try {
    let fail = 'throws';
    const done = sheet({ title: 'Edit Coffee beans', fields: [{ name: 'name', label: 'Name', value: 'Coffee beans' }, { name: 'note', label: 'Note' }],
      check: () => {
        if (fail === 'throws') throw new TypeError("Cannot read properties of undefined (reading 'netG')");
        return fail === 'rejects' ? Promise.reject(new Error('no answer')) : '';
      } });
    let result = 'open';
    done.then(v => { result = v; });
    p.field('note').value = 'The big tin';
    const line = () => p.dialog().find(n => /sheet-msg/.test(n.className)).textContent;
    for (const how of ['throws', 'rejects']) {
      fail = how;
      p.submit(); await later();
      assert.equal(result, 'open', `a check that ${how} closed the sheet`);
      assert.equal(line(), 'Not saved: something went wrong. Try again.', `a check that ${how} said nothing`);
      assert.equal(p.field('note').value, 'The big tin');
    }
    assert.equal(warned.length, 2, 'what went wrong is not in the console');
    fail = '';
    p.submit(); await later();                                         // and the next press is a Save again
    assert.deepEqual(result, { name: 'Coffee beans', note: 'The big tin' });
  } finally { console.warn = warn; }
});

test('a sheet is named by its title, which takes the focus on a touch screen so the keyboard waits for a tap on a field', async () => {
  const { sheet } = await import('../js/kit/ui.js');
  const fields = [{ name: 'name', label: 'Name' }, { name: 'note', label: 'Note' }];
  for (const [coarse, autofocus, want] of [[true, false, 'title'], [true, true, 'name'], [false, false, 'name']]) {
    const p = fakePage({ coarse });
    sheet({ title: 'Edit Coffee beans', fields, autofocus });
    const d = p.dialog(), h2 = d.find(n => n.tagName === 'H2');
    assert.equal(h2.textContent, 'Edit Coffee beans');
    assert.ok(h2.id && d.getAttribute('aria-labelledby') === h2.id, 'the dialog is not named by its title');
    const on = document.activeElement;
    assert.equal(on === h2 ? 'title' : on?.attrs?.name, want, `${coarse ? 'touch' : 'mouse'}${autofocus ? ', autofocus' : ''}: the focus went to ${on?.tagName}`);
    if (want === 'title') assert.equal(h2.getAttribute('tabindex'), '-1');
    p.button('Cancel').dispatchEvent(new Event('click'));
  }
});

test('a button held while the app asks the ledger says so, keeps its width, and comes back as it was', async () => {
  fakePage();
  const { held, h } = await import('../js/kit/ui.js');
  const btn = h('button', { type: 'button', class: 'btn' }, 'New tote');
  btn.width = 112;
  let answer;
  const p = held(btn, new Promise(r => { answer = r; }));
  assert.deepEqual([btn.textContent, btn.disabled, btn.getAttribute('aria-busy'), btn.style.minWidth], ['Checking…', true, 'true', '112px']);
  answer('ok');
  assert.equal(await p, 'ok');
  assert.deepEqual([btn.textContent, btn.disabled, btn.getAttribute('aria-busy'), btn.style.minWidth || ''], ['New tote', false, null, '']);
  // a wait that fails gives the button back too, and a label of the app's own
  const q = held(btn, Promise.reject(new Error('no answer')), 'Asking…');
  assert.equal(btn.textContent, 'Asking…');
  await assert.rejects(q);
  assert.deepEqual([btn.textContent, btn.disabled], ['New tote', false]);
});

test('a confirm that deletes, locks or clears for good has the red button; any other has the app\'s', async () => {
  const p = fakePage();
  const { confirmSheet } = await import('../js/kit/ui.js');
  const yes = confirmSheet('Delete tote 01?', 'Its list and notes go.', 'Delete', { danger: true });
  assert.equal(p.button('Delete').className, 'btn danger');
  assert.equal(p.button('Delete').getAttribute('type'), 'submit');
  p.submit();
  assert.equal(await yes, true);
  const plain = confirmSheet('A new jar?', 'Sets the bought date to today.', 'New jar');
  assert.equal(p.button('New jar').className, 'btn');
  p.button('Cancel').dispatchEvent(new Event('click'));
  assert.equal(await plain, false);
});

test('a long edit sheet keeps what was typed for this tab through a reload, until Save, Cancel or Discard', async () => {
  const store = {};
  globalThis.sessionStorage = { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } };
  try {
    const { sheet, RESTORED } = await import('../js/kit/ui.js');
    const page = () => [{ name: 'name', label: 'Name', value: 'Water heater' }, { name: 'steps', label: 'What to do', type: 'textarea', value: 'Turn the dial' }];
    const typed = (p, name, v) => { p.field(name).value = v; p.dialog().find(n => n.tagName === 'FORM').dispatchEvent(new Event('input')); };
    const note = p => p.dialog().find(n => /draft-note/.test(n.className));
    let p = fakePage();
    sheet({ title: 'Edit Water heater', fields: page(), draft: 'page:water-heater' });
    assert.equal(note(p), undefined, 'a sheet with nothing typed before says it restored something');
    assert.deepEqual(Object.keys(store), [], 'kept before anything was typed');
    typed(p, 'steps', 'Turn the dial to Vacation\nCall the plumber');
    assert.deepEqual(JSON.parse(store['sheet-draft:page:water-heater']), { steps: 'Turn the dial to Vacation\nCall the plumber' }, 'kept a field nobody typed into');
    // the tab reloads with the sheet open (the page goes; the sheet never closed): opened again, it's all back, and says so
    p = fakePage();
    let done = sheet({ title: 'Edit Water heater', fields: page(), draft: 'page:water-heater' });
    assert.equal(p.field('steps').value, 'Turn the dial to Vacation\nCall the plumber', 'what was typed went with the reload');
    assert.equal(p.field('name').value, 'Water heater');
    assert.equal(note(p).find(n => n.tagName === 'P').textContent, RESTORED);
    assert.equal(note(p).getAttribute('role'), 'status');
    // a sheet under another name, or with none, doesn't get it
    const other = fakePage();
    sheet({ title: 'Edit Furnace', fields: page(), draft: 'page:furnace' });
    assert.equal(other.field('steps').value, 'Turn the dial');
    other.button('Cancel').dispatchEvent(new Event('click'));
    // Save clears it
    p.submit(); await later();
    assert.deepEqual(await done, { name: 'Water heater', steps: 'Turn the dial to Vacation\nCall the plumber' });
    assert.deepEqual(Object.keys(store), [], 'Save left the draft');
    // Cancel clears it too
    p = fakePage();
    done = sheet({ title: 'Edit Water heater', fields: page(), draft: 'page:water-heater' });
    typed(p, 'name', 'Water heater, basement');
    assert.ok(store['sheet-draft:page:water-heater']);
    const form = p.dialog().find(n => n.tagName === 'FORM');
    p.button('Cancel').dispatchEvent(new Event('click'));
    assert.equal(await done, null);
    assert.deepEqual(Object.keys(store), [], 'Cancel left the draft');
    form.dispatchEvent(new Event('change'));   // the field losing the focus as the sheet goes
    assert.deepEqual(Object.keys(store), [], 'a change fired as the sheet closed was kept again');
    // Discard puts back what the record holds, and forgets what was typed; typed back to as it was, nothing is kept
    p = fakePage();
    sheet({ title: 'Edit Water heater', fields: page(), draft: 'page:water-heater' });
    typed(p, 'steps', 'Half a sentence');
    p = fakePage();
    sheet({ title: 'Edit Water heater', fields: page(), draft: 'page:water-heater' });
    assert.equal(p.field('steps').value, 'Half a sentence');
    note(p).find(n => n.tagName === 'BUTTON' && n.textContent === 'Discard').dispatchEvent(new Event('click'));
    assert.equal(p.field('steps').value, 'Turn the dial');
    assert.equal(note(p), undefined, 'the line stayed after Discard');
    assert.deepEqual(Object.keys(store), []);
    typed(p, 'steps', 'Turn the dial ');
    typed(p, 'steps', 'Turn the dial');
    assert.deepEqual(Object.keys(store), [], 'kept with nothing changed from the record');
  } finally { delete globalThis.sessionStorage; }
});

test('a draft brings back only what was typed, not a field another device changed meanwhile', async () => {
  const store = {};
  globalThis.sessionStorage = { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } };
  try {
    const { sheet, RESTORED } = await import('../js/kit/ui.js');
    const page = name => [{ name: 'name', label: 'Name', value: name }, { name: 'steps', label: 'What to do', type: 'textarea', value: 'Turn the dial' }];
    const typed = (p, name, v) => { p.field(name).value = v; p.dialog().find(n => n.tagName === 'FORM').dispatchEvent(new Event('input')); };
    let p = fakePage();
    sheet({ title: 'Edit Water heater', fields: page('Water heater'), draft: 'page:water-heater' });
    typed(p, 'steps', 'Turn the dial to Vacation');   // only the steps typed
    // the tab reloads with the sheet open; meanwhile the laptop renamed the page, and that reached this phone
    p = fakePage();
    const done = sheet({ title: 'Edit Water heater, basement', fields: page('Water heater, basement'), draft: 'page:water-heater' });
    assert.equal(p.field('name').value, 'Water heater, basement', 'the name changed on the laptop was put back to the old one');
    assert.equal(p.field('steps').value, 'Turn the dial to Vacation');
    assert.equal(p.dialog().find(n => /draft-note/.test(n.className)).find(n => n.tagName === 'P').textContent, RESTORED);
    assert.deepEqual(JSON.parse(store['sheet-draft:page:water-heater']), { steps: 'Turn the dial to Vacation' });
    p.submit(); await later();
    assert.deepEqual(await done, { name: 'Water heater, basement', steps: 'Turn the dial to Vacation' });
    // typed, and the laptop made the same change meanwhile: nothing to bring back, so no line, and nothing kept
    p = fakePage();
    sheet({ title: 'Edit Water heater', fields: page('Water heater'), draft: 'page:water-heater' });
    typed(p, 'name', 'Water heater, basement');
    p = fakePage();
    sheet({ title: 'Edit Water heater, basement', fields: page('Water heater, basement'), draft: 'page:water-heater' });
    assert.equal(p.dialog().find(n => /draft-note/.test(n.className)), undefined);
    assert.deepEqual(Object.keys(store), []);
  } finally { delete globalThis.sessionStorage; }
});
