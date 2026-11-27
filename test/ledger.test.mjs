// The ledger's Apps Script (ledger/Code.gs) run in Node against a pretend Google Sheet, and the apps' Ledger class
// (js/kit/ledger.js) talking to it, so the whole round trip is tested without Google.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function fakeGoogle() {
  // What a real Sheet does with a string written into a cell under its Automatic format: one that looks like a number,
  // TRUE/FALSE or a date is stored as that ('01' becomes 1). A cell formatted as plain text ('@') keeps the string.
  const sheetValue = v => {
    if (typeof v !== 'string') return v;
    if (/^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/.test(v)) return Number(v);
    if (/^(true|false)$/i.test(v)) return /^true$/i.test(v);
    const d = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(v) || /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v);
    if (d) return v.includes('-') ? new Date(+d[1], d[2] - 1, +d[3]) : new Date(+d[3], d[1] - 1, +d[2]);
    return v;
  };
  const sheets = {};
  const props = {};
  const mail = [];
  mail.quota = 100;                                   // what MailApp says is left today; mail.refuse: sendEmail throws
  const cache = {};
  const locks = [];                                   // the lock and flush calls, in order
  const makeSheet = name => {
    const data = [];
    const fmt = {}, colFmt = {};                       // number formats: by 'row:col', and whole columns ('A:A')
    const put = (r, c, x) => { data[r - 1] ||= []; data[r - 1][c - 1] = (fmt[`${r}:${c}`] ?? colFmt[c]) === '@' ? x : sheetValue(x); };
    const s = {
      name, data, fmt, colFmt,
      getName: () => name,
      getLastRow: () => data.length,
      getMaxRows: () => Math.max(1000, data.length),
      getRange: (r, c, nr = 1, nc = 1) => {
        if (typeof r === 'string') { // 'A1:B5', 'B3' or a whole column 'A:A'
          const col = /^([A-Z]):\1$/.exec(r);
          if (col) return { setNumberFormat(f) { colFmt[col[1].charCodeAt(0) - 64] = f; return this; } };
          const m = /^([A-Z])(\d+)(?::([A-Z])(\d+))?$/.exec(r);
          const c0 = m[1].charCodeAt(0) - 64, r0 = +m[2];
          return s.getRange(r0, c0, m[4] ? +m[4] - r0 + 1 : 1, m[3] ? m[3].charCodeAt(0) - 64 - c0 + 1 : 1);
        }
        return {
          setValues: v => { v.forEach((row, i) => row.forEach((x, j) => put(r + i, c + j, x))); return { setFontWeight() {} }; },
          getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => (data[r - 1 + i] || [])[c - 1 + j] ?? '')),
          getValue: () => (data[r - 1] || [])[c - 1] ?? '',
          setNumberFormat(f) { for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) fmt[`${r + i}:${c + j}`] = f; return this; },
          setFontWeight() { return this; },
          getSheet: () => s, getRow: () => r, getLastRow: () => r + nr - 1, getColumn: () => c, getLastColumn: () => c + nc - 1,
        };
      },
      appendRow: row => { const r = data.length + 1; row.forEach((x, j) => put(r, j + 1, x)); },
      setFrozenRows() {}, setColumnWidth() {},
    };
    return s;
  };
  const ss = {
    getSheetByName: n => sheets[n] || null,
    insertSheet: n => (sheets[n] = makeSheet(n)),
  };
  let uuid = 0;
  const g = {
    SpreadsheetApp: { getActive: () => ss, flush: () => { locks.push('flush'); } },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] ?? null, setProperty: (k, v) => { props[k] = v; } }) },
    LockService: { getScriptLock: () => ({ waitLock() { locks.push('lock'); }, releaseLock() { locks.push('release'); } }) },
    CacheService: { getScriptCache: () => ({ get: k => cache[k] ?? null, put: (k, v) => { cache[k] = v; } }) },
    MailApp: { sendEmail: (...a) => { if (mail.refuse) throw new Error('Service invoked too many times for one day: email.'); mail.quota--; mail.push(a); },
      getRemainingDailyQuota: () => mail.quota },
    Session: { getEffectiveUser: () => ({ getEmail: () => 'owner@example.com' }) },
    Utilities: { getUuid: () => `0000000${++uuid}-aaaa-bbbb-cccc-dddddddddddd`.slice(-36) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: t => ({ text: t, setMimeType() { return this; } }) },
    Logger: { log() {} },
    console, JSON, Date, Math, Object, Array, String, Number,
  };
  vm.createContext(g);
  vm.runInContext(readFileSync(new URL('../ledger/Code.gs', import.meta.url), 'utf8'), g);
  return { g, sheets, props, mail, cache, locks };
}

const post = (g, body) => JSON.parse(g.doPost({ postData: { contents: JSON.stringify(body) } }).text);
const get = (g, q) => JSON.parse(g.doGet({ parameter: q }).text);

test('setup writes a key on the About tab, and ping works with and without it', () => {
  const { g, sheets, props } = fakeGoogle();
  g.setup();
  assert.equal(props.KEY.length, 40);
  assert.equal(sheets.About.data[1][1], props.KEY);
  assert.equal(get(g, {}).app, 'switchboard-ledger');
  assert.equal(post(g, { op: 'ping', key: 'nope' }).error, 'bad key');
  assert.equal(post(g, { op: 'ping', key: props.KEY }).ok, true);
});

test('put, list since, replace, delete and batch', () => {
  const { g, props } = fakeGoogle();
  g.setup();
  const key = props.KEY;
  assert.equal(post(g, { key, op: 'put', app: 'larder', coll: 'items', id: 'cumin', doc: { name: 'Cumin', g: 40 } }).ok, true);
  let l = post(g, { key, op: 'list', app: 'larder', coll: 'items', since: 0 });
  assert.deepEqual(l.docs.map(d => [d.id, d.name]), [['cumin', 'Cumin']]);
  const since = l.time;
  post(g, { key, op: 'put', app: 'larder', coll: 'items', id: 'cumin', doc: { name: 'Cumin, ground', g: 35 } });
  l = post(g, { key, op: 'list', app: 'larder', coll: 'items', since: since - 1 });
  assert.equal(l.docs.length, 1); assert.equal(l.docs[0].name, 'Cumin, ground');
  post(g, { key, op: 'batch', ops: [
    { op: 'put', app: 'larder', coll: 'items', id: 'paprika', doc: { name: 'Paprika' } },
    { op: 'del', app: 'larder', coll: 'items', id: 'cumin' },
    { op: 'add', app: 'larder', coll: 'queue', doc: { text: 'Cumin', synced: false } },
  ] });
  l = post(g, { key, op: 'list', app: 'larder', coll: 'items', since: 0 });
  assert.deepEqual(l.docs.map(d => [d.id, !!d._deleted]).sort(), [['cumin', true], ['paprika', false]]);
  const q = post(g, { key, op: 'list', app: 'larder', coll: 'queue', since: 0, match: { synced: false } });
  assert.equal(q.docs.length, 1); assert.equal(q.docs[0].text, 'Cumin');
  assert.equal(post(g, { key, op: 'list', app: 'larder', coll: 'queue', since: 0, match: { synced: true } }).docs.length, 0);
  assert.match(post(g, { key, op: 'put', app: 'Bad Name', coll: 'x', id: 'a', doc: {} }).error, /bad app/);
});

test('tote and pack numbers stay text: 01 is saved twice as one row and lists back as 01', () => {
  const { g, props, sheets } = fakeGoogle();
  g.setup();
  const key = props.KEY;
  post(g, { key, op: 'put', app: 'mothball', coll: 'totes', id: '01', doc: { name: 'Lights' } });
  post(g, { key, op: 'batch', ops: [{ op: 'put', app: 'mothball', coll: 'totes', id: '01', doc: { name: 'Lights and wreaths' } }] });
  post(g, { key, op: 'put', app: 'mothball', coll: 'totes', id: '2026-12-01', doc: { name: 'A date-shaped id' } });
  assert.deepEqual(sheets['mothball.totes'].data.slice(1).map(r => r[0]), ['01', '2026-12-01'], 'one row for 01, kept as text');
  const docs = post(g, { key, op: 'list', app: 'mothball', coll: 'totes', since: 0 }).docs;
  assert.deepEqual(docs.map(d => [d.id, d.name]), [['01', 'Lights and wreaths'], ['2026-12-01', 'A date-shaped id']]);
  assert.equal(post(g, { key, op: 'get', app: 'mothball', coll: 'totes', id: '01' }).doc.name, 'Lights and wreaths');
  // a tab made by the first version of the script, with no column format: each row it writes is made text first
  const old = g.SpreadsheetApp.getActive().insertSheet('packrat.packs');
  old.appendRow(['id', 'updated', 'deleted', 'json']);
  post(g, { key, op: 'put', app: 'packrat', coll: 'packs', id: '07', doc: { label: '5.0 Ah' } });
  post(g, { key, op: 'put', app: 'packrat', coll: 'packs', id: '07', doc: { label: '5.0 Ah #2' } });
  assert.deepEqual(old.data.slice(1).map(r => r[0]), ['07']);
  // a report's made-up id can be all digits too
  const rep = post(g, { key, op: 'add', app: 'placard', coll: 'reports', doc: { text: 'x' } });
  assert.match(rep.id, /^\d+$/, 'the pretend Google makes all-digit ids');
  assert.equal(sheets['placard.reports'].data[1][0], rep.id);
  assert.equal(post(g, { key, op: 'list', app: 'placard', coll: 'reports', since: 0 }).docs[0].id, rep.id);
});

test('a tote saved as 01 by version 1.0 of the script (stored as the number 1) is the same record once 1.1 is pasted', async () => {
  const { g, props, sheets, open } = await world();
  const key = props.KEY;
  // version 1.0 made tabs with no text format and wrote ids as they came, so the Sheet kept the tote number 01 as 1
  const v10 = sheets['mothball.totes'] = g.SpreadsheetApp.getActive().insertSheet('mothball.totes');
  v10.appendRow(['id', 'updated', 'deleted', 'json']);
  v10.appendRow(['01', 1000, false, '{"name":"Lights"}']);
  v10.appendRow(['02', 1000, false, '{"name":"Wreaths"}']);
  assert.deepEqual(v10.data.slice(1).map(r => r[0]), [1, 2], 'the pretend Sheet should store them as numbers, as a real one does');
  // a phone that synced then lists totes "1" and "2"
  const phone = open('mothball');
  await phone.sync(['totes']);
  assert.deepEqual(phone.docs('totes').map(d => d.id).sort(), ['1', '2']);
  // 1.1 pasted over it; tote 01 saved again: the same row, now the text 01, and phones drop the "1" they listed
  phone.put('totes', { id: '01', name: 'Lights and wreaths' });
  await phone.sync(['totes']);
  const live = v10.data.slice(1).filter(r => r[2] !== true);
  assert.deepEqual(live.map(r => r[0]), ['01', 2], 'tote 01 is in the sheet twice (the 1.0 row and a new one)');
  assert.equal(JSON.parse(live[0][3]).name, 'Lights and wreaths');
  assert.deepEqual(post(g, { key, op: 'list', app: 'mothball', coll: 'totes', since: 0 }).docs.filter(d => !d._deleted).map(d => d.id), ['01', '2']);
  assert.deepEqual(phone.docs('totes').map(d => d.id).sort(), ['01', '2'], 'the phone keeps a tote "1" beside 01');
  // tote 02 saved from a new laptop (which lists 01 and "2"): the same, and nothing left over
  post(g, { key, op: 'put', app: 'mothball', coll: 'totes', id: '02', doc: { name: 'Wreaths' } });
  assert.deepEqual(v10.data.slice(1).filter(r => r[2] !== true).map(r => r[0]), ['01', '02']);
  // an id that's really "1" (not a v1.0 01) still matches its own row, and leaves 01 alone
  post(g, { key, op: 'put', app: 'mothball', coll: 'totes', id: '1', doc: { name: 'One' } });
  assert.equal(post(g, { key, op: 'get', app: 'mothball', coll: 'totes', id: '01' }).doc.name, 'Lights and wreaths');
  assert.equal(post(g, { key, op: 'get', app: 'mothball', coll: 'totes', id: '1' }).doc.name, 'One');
});

test('Switchboard asks for the same script version as ledger/Code.gs is', () => {
  const version = /const VERSION = '([\d.]+)'/.exec(readFileSync(new URL('../ledger/Code.gs', import.meta.url), 'utf8'))?.[1];
  const want = /const WANT = '([\d.]+)'/.exec(readFileSync(new URL('../js/app.js', import.meta.url), 'utf8'))?.[1];
  assert.ok(version && want);
  assert.equal(want, version, 'js/app.js WANT and ledger/Code.gs VERSION differ: Switchboard would call the new script old, or the old one fine');
});

test('only Placard\'s site is public, and public reports are kept, limited and emailed', () => {
  const { g, props, mail } = fakeGoogle();
  g.setup();
  post(g, { key: props.KEY, op: 'put', app: 'placard', coll: 'site', id: 'site', doc: { title: 'House manual' } });
  post(g, { key: props.KEY, op: 'put', app: 'larder', coll: 'items', id: 'x', doc: { name: 'secret' } });
  assert.equal(get(g, { op: 'pub', app: 'placard', coll: 'site' }).docs[0].title, 'House manual');
  assert.equal(get(g, { op: 'pub', app: 'larder', coll: 'items' }).error, 'not public');
  assert.equal(post(g, { op: 'report', app: 'placard', coll: 'reports', doc: { system: 'water-heater', text: 'Drip under the tank', name: 'Pat' } }).ok, true);
  assert.equal(mail.length, 1); assert.match(mail[0][1], /water-heater/);
  assert.equal(post(g, { op: 'report', app: 'placard', coll: 'reports', doc: { text: 'spam', website: 'x' } }).ok, true);
  assert.equal(mail.length, 1, 'the robot field is dropped');
  assert.equal(post(g, { op: 'report', app: 'larder', coll: 'items', doc: { text: 'x' } }).error, 'not public');
  for (let i = 0; i < 40; i++) post(g, { op: 'report', app: 'placard', coll: 'reports', doc: { text: 'n' + i } });
  assert.match(post(g, { op: 'report', app: 'placard', coll: 'reports', doc: { text: 'one more' } }).error, /too many/);
  const reps = post(g, { key: props.KEY, op: 'list', app: 'placard', coll: 'reports', since: 0 }).docs;
  assert.equal(reps.length, 30);
});

test('only a real report counts towards the hour', () => {
  const { g, props } = fakeGoogle();
  g.setup();
  // empty ones (a robot, or a form sent blank) are turned down without using up the hour
  for (let i = 0; i < 40; i++) assert.equal(post(g, { op: 'report', app: 'placard', coll: 'reports', doc: { text: '', name: 'x' } }).error, 'empty report');
  for (let i = 0; i < 5; i++) post(g, { op: 'report', app: 'placard', coll: 'reports', doc: { text: '  ', website: 'spam.example' } });
  const r = post(g, { op: 'report', app: 'placard', coll: 'reports', doc: { text: 'Water under the tank' } });
  assert.equal(r.ok, true, 'a real report after 40 empty ones: ' + r.error);
  assert.equal(post(g, { key: props.KEY, op: 'list', app: 'placard', coll: 'reports', since: 0 }).docs.length, 1);
});

test('a report says whether the email went: at most 20 a day, never past Google\'s quota, and kept either way', () => {
  const { g, props, mail } = fakeGoogle();
  g.setup();
  const RealDate = Date;
  let shift = 0;                                      // the pretend Google's clock, moved on a day below
  g.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [RealDate.now() + shift])); } static now() { return RealDate.now() + shift; } };
  const send = (text = 'Drip') => post(g, { op: 'report', app: 'placard', coll: 'reports', doc: { text } });
  const kept = () => post(g, { key: props.KEY, op: 'list', app: 'placard', coll: 'reports', since: 0 }).docs.length;
  assert.deepEqual(send(), { ok: true, emailed: true });
  assert.equal(mail.length, 1);
  // Google has nothing left today (other scripts used it): kept, not emailed, and nothing thrown
  mail.quota = 0;
  assert.deepEqual(send(), { ok: true, emailed: false });
  assert.equal(mail.length, 1); assert.equal(kept(), 2);
  // Google refuses the send itself
  mail.quota = 100; mail.refuse = true;
  assert.deepEqual(send(), { ok: true, emailed: false });
  mail.refuse = false;
  // the day's own cap: 20 tries at an email a day (the two above count), then kept without one
  const answers = [];
  for (let i = 0; i < 25; i++) { if (i === 10) shift += 3600 * 1000; answers.push(send('n' + i).emailed); } // over two hours: under 30 an hour
  assert.equal(answers.filter(Boolean).length, 17, 'emails sent on the first day');
  assert.deepEqual(answers.slice(17), Array(8).fill(false));
  assert.equal(mail.length, 18); assert.equal(kept(), 28);
  // the next day there are emails again
  shift += 24 * 3600 * 1000;
  assert.deepEqual(send('next day'), { ok: true, emailed: true });
  assert.equal(mail.length, 19);
});

test('by GET the ledger answers only ping and pub; anything else says to use POST', () => {
  const { g, props, sheets } = fakeGoogle();
  g.setup();
  const key = props.KEY;
  post(g, { key, op: 'put', app: 'placard', coll: 'site', id: 'house', doc: { title: 'House manual' } });
  assert.equal(get(g, {}).app, 'switchboard-ledger');
  assert.equal(get(g, { op: 'ping', key }).ok, true);
  assert.equal(get(g, { op: 'pub', app: 'placard', coll: 'site' }).docs[0].title, 'House manual');
  for (const q of [{ op: 'put', app: 'larder', coll: 'items', id: 'x', doc: '{"name":"x"}', key }, { op: 'list', app: 'larder', coll: 'items', key },
    { op: 'del', app: 'placard', coll: 'site', id: 'house', key }, { op: 'report', app: 'placard', coll: 'reports', text: 'x' }])
    assert.deepEqual(get(g, q), { ok: false, error: 'use POST' }, q.op);
  assert.equal(sheets['larder.items'], undefined, 'a GET wrote a record');
  assert.equal(post(g, { key, op: 'get', app: 'placard', coll: 'site', id: 'house' }).doc._deleted, undefined);
});

test('the apps\' Ledger class syncs through it, keeps an outbox while offline, and sends it later', async () => {
  globalThis.localStorage = { s: {}, getItem(k) { return this.s[k] ?? null; }, setItem(k, v) { this.s[k] = String(v); }, removeItem(k) { delete this.s[k]; } };
  const { Ledger } = await import('../js/kit/ledger.js');
  const { g, props } = fakeGoogle();
  g.setup();
  let up = true;
  const fetchImpl = async (url, o) => {
    if (!up) throw new Error('offline');
    return { ok: true, json: async () => post(g, JSON.parse(o.body)) };
  };
  const a = new Ledger('frostbite', { fetchImpl });
  a.setConfig('https://script.google.com/macros/s/X/exec', props.KEY);
  a.put('items', { id: 'i1', name: 'Chicken thighs', zone: 'z1' });
  await a.flush();
  assert.equal(a.pending, 0);
  const b = new Ledger('frostbite-b', { fetchImpl });
  b.app = 'frostbite';
  b.setConfig('https://script.google.com/macros/s/X/exec', props.KEY);
  await b.sync(['items']);
  assert.equal(b.doc('items', 'i1').name, 'Chicken thighs');
  up = false;
  a.put('items', { id: 'i2', name: 'Peas' });
  a.del('items', 'i1');
  await a.flush();
  assert.equal(a.state, 'offline'); assert.equal(a.pending, 2);
  up = true;
  await a.sync(['items']);
  assert.equal(a.pending, 0);
  await b.sync(['items']);
  assert.equal(b.doc('items', 'i1'), null);
  assert.equal(b.doc('items', 'i2').name, 'Peas');
});

// ---- Invariants the ledger lab (full treatment, round 1) found broken. Each is the shortest sequence that breaks
// it, against the pretend Sheet. Marked todo until the fix lands; drop the todo with the fix.
const opened = [];                                  // every Ledger a test opens is stopped after it (its retry timer)
afterEach(() => { for (const l of opened.splice(0)) l.stop(); });
const store = () => ({ s: {}, getItem(k) { return this.s[k] ?? null; }, setItem(k, v) { this.s[k] = String(v); }, removeItem(k) { delete this.s[k]; },
  get length() { return Object.keys(this.s).length; }, key(i) { return Object.keys(this.s)[i] ?? null; } });
const URL_ = 'https://script.google.com/macros/s/X/exec';
async function world() {
  globalThis.localStorage = store();
  const { Ledger } = await import('../js/kit/ledger.js');
  const { g, props, sheets } = fakeGoogle();
  g.setup();
  const net = { up: true, hold: null, hang: false, calls: 0, fail: null };
  // hold(body) may return a promise: the request is applied when it resolves, then answered. hang: Google takes the
  // request and never answers (only the page's own timeout ends it).
  const fetchImpl = async (url, o) => {
    net.calls++;
    if (!net.up || net.fail?.(JSON.parse(o.body))) throw new TypeError('Failed to fetch');
    if (net.hang) return new Promise((res, rej) => o.signal?.addEventListener('abort', () => rej(new DOMException('The operation was aborted.', 'AbortError'))));
    const body = JSON.parse(o.body);
    const early = net.hold ? await net.hold(body) : null;
    const text = typeof early === 'string' ? early : JSON.stringify(post(g, body));
    return { ok: true, status: 200, json: async () => JSON.parse(text) };
  };
  const open = (app = 'frostbite') => { const l = new Ledger(app, { fetchImpl }); opened.push(l); if (!l.connected) l.setConfig(URL_, props.KEY); return l; };
  const sheet = (app, coll) => Object.fromEntries(post(g, { key: props.KEY, op: 'list', app, coll, since: 0 }).docs.map(d => [d.id, d]));
  return { g, props, sheets, net, open, sheet, Ledger };
}
const tick = () => new Promise(r => setImmediate(r));

test('a save made offline goes out by itself once the signal is back', async t => {
  const { net, open, sheet } = await world();
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const a = open();
  net.up = false;
  a.put('items', { id: 'peas', name: 'Peas' });
  await a.flush();
  t.mock.timers.tick(400); await tick();
  net.up = true;
  globalThis.dispatchEvent?.(new Event('online'));
  for (let i = 0; i < 120; i++) { t.mock.timers.tick(1000); await tick(); }
  assert.equal(a.pending, 0);
  assert.ok(sheet('frostbite', 'items').peas);
});

test('the retries back off, and stop once nothing is waiting', async t => {
  const { net, open } = await world();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const a = open();
  net.up = false;
  a.put('items', { id: 'peas', name: 'Peas' });
  t.mock.timers.tick(400); await tick(); await tick();
  const at = [];
  for (let s = 1; s <= 600; s++) { const n = net.calls; t.mock.timers.tick(1000); await tick(); await tick(); if (net.calls > n) at.push(s); }
  assert.deepEqual(at.slice(0, 7), [5, 20, 50, 110, 230, 350, 470], 'tries 5 s, 15 s, 30 s, a minute, then every two minutes');
  net.up = true;
  t.mock.timers.tick(120000); await tick(); await tick(); await tick();
  assert.equal(a.pending, 0);
  const n = net.calls;
  for (let s = 0; s < 600; s++) { t.mock.timers.tick(1000); await tick(); }
  assert.equal(net.calls, n, 'no more requests once the outbox is empty');
});

test('a request Google never answers ends as offline after 45 s, and the save goes on the next try', async t => {
  const { net, open, sheet } = await world();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const a = open();
  net.hang = true;
  a.put('items', { id: 'peas', name: 'Peas' });
  t.mock.timers.tick(400); await tick();
  t.mock.timers.tick(44000); await tick();
  assert.equal(a.state, 'pending', 'still waiting on the answer');
  t.mock.timers.tick(1000); await tick(); await tick();
  assert.equal(a.state, 'offline');
  net.hang = false;
  a.put('items', { id: 'corn', name: 'Corn' });                   // a new save is not held up by the stuck one
  t.mock.timers.tick(400); await tick(); await tick(); await tick();
  assert.equal(a.pending, 0);
  assert.ok(sheet('frostbite', 'items').peas && sheet('frostbite', 'items').corn);
});

test('a sync whose send fails but whose lists come back still tries the send again', async t => {
  const { net, open, sheet } = await world();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const a = open();
  a.keepUp(['items'], () => {});
  for (let i = 0; i < 5; i++) await tick();
  net.fail = b => b.op === 'batch';                               // the send's answer is lost; lists are fine
  a.put('items', { id: 'peas', name: 'Peas' });
  t.mock.timers.tick(400); for (let i = 0; i < 5; i++) await tick();   // its own send fails: a retry in 5 s
  await a.sync(['items']);                                        // fails to send again (retry in 15 s), lists fine
  assert.equal(a.pending, 1);
  net.fail = null;
  for (let s = 0; s < 20; s++) { t.mock.timers.tick(1000); for (let i = 0; i < 5; i++) await tick(); }
  assert.equal(a.pending, 0);
  assert.ok(sheet('frostbite', 'items').peas);
});

test('a retry that joins a sync already on its way tries again after it, if things are still waiting', async t => {
  const { net, open, sheet } = await world();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const a = open();
  a.keepUp(['items', 'zones'], () => {});
  for (let i = 0; i < 5; i++) await tick();
  let release;
  net.fail = b => b.op === 'batch';
  a.put('items', { id: 'peas', name: 'Peas' });
  t.mock.timers.tick(400); for (let i = 0; i < 5; i++) await tick();   // its own send fails: a retry in 5 s
  net.hold = b => (b.op === 'list' && b.coll === 'zones' ? new Promise(r => { release = r; }) : null);
  const s1 = a.sync(['items', 'zones']);                         // fails to send (retry in 15 s); its second list is slow
  for (let i = 0; i < 5; i++) await tick();
  for (let s = 0; s < 16; s++) { t.mock.timers.tick(1000); for (let i = 0; i < 5; i++) await tick(); }   // the retry joins it
  net.fail = null; net.hold = null; release(); await s1;
  for (let s = 0; s < 60; s++) { t.mock.timers.tick(1000); for (let i = 0; i < 5; i++) await tick(); }
  assert.equal(a.pending, 0, 'the change went on a later try');
  assert.ok(sheet('frostbite', 'items').peas);
});

test('a new phone that can\'t reach the ledger says so, then fills in by itself', async t => {
  const { net, open, g, props } = await world();
  post(g, { key: props.KEY, op: 'put', app: 'mothball', coll: 'totes', id: '04', doc: { name: 'Wreaths' } });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  net.up = false;
  const a = open('mothball');
  let draws = 0;
  assert.equal(a.notReady('totes'), 'Loading…');
  a.keepUp(['totes', 'builds'], () => draws++);
  for (let i = 0; i < 5; i++) await tick();
  t.mock.timers.tick(20); await tick();
  assert.equal(a.notReady('totes'), "Can't reach the ledger yet. This opens as soon as it can.");
  assert.equal(draws, 1, 'the page draws the note');
  net.up = true;
  for (let s = 0; s < 6; s++) { t.mock.timers.tick(1000); for (let i = 0; i < 5; i++) await tick(); }
  t.mock.timers.tick(20); await tick();
  assert.equal(a.notReady('totes', 'builds'), '');
  assert.equal(a.doc('totes', '04').name, 'Wreaths');
  assert.equal(draws, 2, 'and draws again with the tote');
});

test('New waits until a list has come back once on this phone, and that holds across a reload with no signal', async () => {
  const { net, open, g, props } = await world();
  const { CANT_REACH } = await import('../js/kit/ledger.js');
  post(g, { key: props.KEY, op: 'put', app: 'mothball', coll: 'totes', id: '01', doc: { name: 'Porch lights', items: ['Timer plug'] } });
  net.up = false;
  const a = open('mothball');
  assert.equal(a.synced('totes'), false);
  await a.sync(['totes', 'builds']);
  assert.deepEqual([a.synced('totes'), a.notReady('totes')], [false, CANT_REACH], 'no answer yet');
  net.up = true;
  await a.sync(['totes', 'builds']);
  assert.deepEqual([a.synced('totes'), a.synced('builds'), a.notReady('totes', 'builds')], [true, true, ''], 'an empty collection counts once listed');
  // a record only made on this phone is there (has), but the phone still hasn't heard from the ledger
  const b = open('larder');
  b.put('items', { id: 'olive-oil', name: 'Olive oil' });
  assert.deepEqual([b.has('items'), b.synced('items'), b.notReady('items')], [true, false, 'Loading…']);
  // the next day, no signal: what this phone heard yesterday still counts
  net.up = false;
  const c = open('mothball');
  assert.deepEqual([c.synced('totes'), c.notReady('totes', 'builds')], [true, '']);
  // a copy kept by the kit before it marked a list (since alone) counts too
  const was = JSON.parse(localStorage.getItem('mothball.m.totes'));
  delete was.listed; localStorage.setItem('mothball.m.totes', JSON.stringify(was));
  assert.equal(open('mothball').synced('totes'), true);
  // connected to another ledger: nothing heard from it yet
  c.setConfig('https://script.google.com/macros/s/Y/exec', props.KEY);
  assert.equal(c.synced('totes'), false);
  // the sample has nothing to wait for once it has answered
  const { Ledger } = await import('../js/kit/ledger.js');
  const d = new Ledger('mothball', { demo: { 'mothball.totes': [] } }); opened.push(d);
  await d.sync(['totes']);
  assert.equal(d.synced('totes'), true);
});

test('before a new record, a page that has heard nothing from the ledger for 30 s asks again, for up to 4 s', async t => {
  const { net, open, g, props } = await world();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const a = open('packrat');
  await a.sync(['packs']);
  post(g, { key: props.KEY, op: 'put', app: 'packrat', coll: 'packs', id: '01', doc: { label: '5.0 Ah #1', rom: '28BBBB0C1B0000A1' } });
  const calls = net.calls;
  await a.catchUp(['packs']);
  assert.equal(net.calls, calls, 'it asked again within 30 s of a list');
  t.mock.timers.tick(31000);
  await a.catchUp(['packs']);
  assert.equal(a.doc('packs', '01')?.label, '5.0 Ah #1', 'the pack another device made in the meantime');
  // Google takes the request and never answers: after 4 s it goes on with the copy it has
  t.mock.timers.tick(31000);
  net.hang = true;
  let done = false;
  a.catchUp(['packs']).then(() => { done = true; });
  for (let i = 0; i < 5; i++) await tick();
  t.mock.timers.tick(3999); await tick();
  assert.equal(done, false);
  t.mock.timers.tick(1); await tick(); await tick();
  assert.equal(done, true, 'New waited on for a ledger that never answers');
});

test('a list answer read before a save does not put the old copy back after the save is answered', async () => {
  const { net, open, sheet, g, props } = await world();
  post(g, { key: props.KEY, op: 'put', app: 'larder', coll: 'items', id: 'cumin', doc: { name: 'Cumin', state: 'ok' } });
  const a = open('larder');
  await a.sync(['items']);
  let release;
  net.hold = b => (b.op === 'list' ? new Promise(r => { release = r; }) : null);   // the list is read now, answered later
  const syncing = a.sync(['items']);
  await tick();
  // the list was sent; Google reads it before the save arrives
  const readEarly = JSON.stringify(post(g, { key: props.KEY, op: 'list', app: 'larder', coll: 'items', since: 0 }));
  net.hold = null;
  a.put('items', { ...a.doc('items', 'cumin'), state: 'out' });
  await a.flush();
  assert.equal(a.pending, 0);
  // answer the list with what Google read before the save
  release(readEarly);
  await syncing;
  assert.ok(readEarly.includes('"state":"ok"'));
  assert.equal(sheet('larder', 'items').cumin.state, 'out');
  assert.equal(a.doc('items', 'cumin').state, 'out', 'the screen must keep the saved state');
});

test('a list asked for while a save was still waiting, and answered after the save went, does not put the old copy back', async t => {
  const { net, open, sheet, g, props } = await world();
  post(g, { key: props.KEY, op: 'put', app: 'larder', coll: 'items', id: 'cumin', doc: { name: 'Cumin', state: 'ok' } });
  const a = open('larder');
  await a.sync(['items']);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  let release;
  net.hold = b => (b.op === 'list' ? new Promise(r => { release = r; }) : null);
  const syncing = a.sync(['items']);                               // nothing to send: it goes on to the list
  a.put('items', { ...a.doc('items', 'cumin'), state: 'out' });    // a save made just before the list is asked for
  t.mock.timers.tick(10);
  await tick();                                                    // the list is asked for, the save still waiting
  const readEarly = JSON.stringify(post(g, { key: props.KEY, op: 'list', app: 'larder', coll: 'items', since: 0 }));
  net.hold = null;
  await a.flush();                                                 // the save goes, and is answered first
  assert.equal(a.pending, 0);
  release(readEarly);                                              // then the list, as Google read it before the save
  await syncing;
  assert.ok(readEarly.includes('"state":"ok"'));
  assert.equal(sheet('larder', 'items').cumin.state, 'out');
  assert.equal(a.doc('items', 'cumin').state, 'out', 'the screen must keep the saved state');
});

test('two tabs of one app on one phone never drop each other\'s waiting changes', async () => {
  const { net, open } = await world();
  const a = open();
  net.up = false;
  a.put('items', { id: 'peas', name: 'Peas' });
  const b = open();                         // a sticker tap opens a second tab
  b.put('items', { id: 'corn', name: 'Corn' });
  a.put('items', { id: 'ice', name: 'Ice cream' });
  const c = open();                         // what a reload would find
  assert.deepEqual(c.outbox.map(o => o.id).sort(), ['corn', 'ice', 'peas']);
});

test('a tab whose change another tab sent reads Saved, not "Saving 0…"', async () => {
  const { open, sheet } = await world();
  const a = open('mothball'), b = open('mothball');
  a.put('totes', { id: '01', name: 'Lights' });                   // within a's wait before it sends,
  b.put('totes', { id: '02', name: 'Wreaths' }); await b.flush();  // b sends both
  assert.deepEqual(Object.keys(sheet('mothball', 'totes')).sort(), ['01', '02']);
  assert.equal(a.statusText(), 'Saved');
  assert.equal(a.pending, 0);
});

test('an open tab sees a change made in another tab before its next edit', async () => {
  const { open, sheet, g, props } = await world();
  post(g, { key: props.KEY, op: 'put', app: 'larder', coll: 'items', id: 'cumin', doc: { name: 'Cumin', state: 'low' } });
  const win = open('larder'); await win.sync(['items']);
  const tab = open('larder'); await tab.sync(['items']);
  tab.put('items', { ...tab.doc('items', 'cumin'), state: 'ok' }); await tab.flush();
  globalThis.dispatchEvent?.(new Event('visibilitychange'));
  await tick(); await tick();
  win.put('items', { ...win.doc('items', 'cumin'), note: 'Penzeys' }); await win.flush();
  assert.equal(sheet('larder', 'items').cumin.state, 'ok');
});

test('one record the ledger refuses does not hold back the others, and the status says so', async () => {
  const { open, sheet } = await world();
  const a = open('mothball');
  // refused before it's queued, with the ledger's own reason, so nothing is stuck behind it
  assert.throws(() => a.put('builds', { id: 'Tree topper', name: 'from an import file' }), e => e.refused === 'bad id');
  assert.throws(() => a.put('builds', { id: 'manual', steps: 'x'.repeat(46000) }), e => e.refused === 'too big');
  assert.throws(() => a.del('builds', 'Tree topper'), /bad id/);
  assert.equal(a.pending, 0);
  await a.flush();
  a.put('totes', { id: '02', name: 'Halloween' });
  await a.sync(['totes', 'builds']); await a.sync(['totes', 'builds']);
  assert.ok(sheet('mothball', 'totes')['02'], 'the good record reaches the sheet');
  assert.doesNotMatch(a.statusText(), /^Saving/);
});

test('an import fills in and never blanks or replaces: fillIn, what the toast says, and a record deleted here', async () => {
  const { open } = await world();
  const { fillIn, importSummary } = await import('../js/kit/ledger.js');
  const here = { id: '01', _updated: 5, name: 'Porch lights', place: 'Garage', items: ['Timer plug', 'Clips'], out: false, note: '',
    contact: { name: 'Lab Owner', phone: '', email: '' } };
  const r = fillIn(here, { id: '01', _deleted: true, name: 'Porch Lights!', place: '', items: ['clips ', 'Spare fuses', ''], note: 'Check the timer.', season: 'christmas',
    contact: { name: '', phone: '555-0144', email: '' }, box: '' });
  assert.deepEqual(r.doc, { id: '01', _updated: 5, name: 'Porch lights', place: 'Garage', items: ['Timer plug', 'Clips', 'Spare fuses'], out: false, note: 'Check the timer.',
    contact: { name: 'Lab Owner', phone: '555-0144', email: '' }, season: 'christmas', box: '' });
  assert.deepEqual(r.filled.sort(), ['contact', 'items', 'note', 'season']);
  assert.deepEqual(r.kept.sort(), ['contact', 'items', 'name', 'out', 'place']);
  assert.deepEqual(here.items, ['Timer plug', 'Clips'], 'the copy here was changed in place');
  assert.deepEqual(fillIn({ id: 'x', facts: [['a', '']] }, { facts: [['a', 'b']] }, { facts: (h, f) => ({ value: f, filled: true, kept: false }) }),
    { doc: { id: 'x', facts: [['a', 'b']] }, filled: ['facts'], kept: [] });
  assert.equal(importSummary({ added: 2, filled: 3, kept: 4 }), 'Added 2, filled in 3, kept your edits.');
  assert.equal(importSummary({ added: 1, skipped: ['id "Tote 6"'] }, ['page', 'pages']), 'Added 1 page; skipped 1 (id "Tote 6").');
  assert.equal(importSummary({ added: 16 }, ['page', 'pages']), 'Added 16 pages.');
  assert.equal(importSummary({ kept: 2, gone: 1 }), 'Nothing new in the file; your edits stay; left out 1 you deleted.');
  assert.equal(importSummary({ skipped: ['a', 'b', 'c', 'd'] }), 'Nothing new in the file; skipped 4 (a, b, c, …).');
  const a = open('mothball');
  a.put('totes', { id: '06', name: 'Tree skirt' }); a.del('totes', '06');
  assert.deepEqual([a.gone('totes', '06'), a.gone('totes', '07'), a.doc('totes', '06')], [true, false, null]);
});

test('refusal() follows the ledger script: what it accepts and refuses', async () => {
  const { refusal } = await import('../js/kit/ledger.js');
  const { g, props } = fakeGoogle();
  g.setup();
  const docs = [{ id: '01' }, { id: 'pinch-cumin-2026-09-01' }, { id: 'a:b.c_d' }, { id: 'x'.repeat(60) }, { id: 'x'.repeat(61) }, { id: 'Tree topper' },
    { id: '' }, {}, { id: 'p', note: 'é'.repeat(44990) }, { id: 'p', note: 'x'.repeat(44991) }, { id: 'p', _updated: 1, note: 'x'.repeat(44990) }];
  for (const d of docs) {
    const r = post(g, { key: props.KEY, op: 'put', app: 'larder', coll: 'items', id: d.id, doc: d });
    assert.equal(refusal(d) === '', r.ok === true, `${JSON.stringify(d).slice(0, 40)}: kit says "${refusal(d)}", ledger says ${r.error || 'ok'}`);
  }
});

test('a tenant\'s read gives up after 12 s and a report after 20 s, as no signal; answered, both work as before', async t => {
  globalThis.localStorage = store();
  const { publicRead, publicReport } = await import('../js/kit/ledger.js');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const never = (url, o) => new Promise((res, rej) => o.signal.addEventListener('abort', () => rej(new DOMException('The operation was aborted.', 'AbortError'))));
  const watch = p => { const w = { done: false }; p.then(v => Object.assign(w, { done: true, v }), e => Object.assign(w, { done: true, e })); return w; };
  const read = watch(publicRead(URL_, 'placard', 'site', { fetchImpl: never }));
  const report = watch(publicReport(URL_, 'placard', 'reports', { text: 'Water on the floor' }, { fetchImpl: never }));
  t.mock.timers.tick(11999); await tick();
  assert.equal(read.done, false);
  t.mock.timers.tick(1); await tick();
  assert.equal(read.e?.kind, 'offline', 'a first visit waits on a read Google never answers');
  assert.equal(report.done, false, 'a report gets longer');
  t.mock.timers.tick(8000); await tick();
  assert.equal(report.e?.kind, 'offline', 'Send waits on a report Google never answers');
  const { g, props } = fakeGoogle();
  g.setup();
  post(g, { key: props.KEY, op: 'put', app: 'placard', coll: 'site', id: 'house', doc: { title: 'House manual' } });
  const google = async (url, o) => ({ json: async () => (o.method === 'POST' ? post(g, JSON.parse(o.body)) : get(g, Object.fromEntries(new URL(url).searchParams))) });
  assert.deepEqual((await publicRead(URL_, 'placard', 'site', { fetchImpl: google })).map(d => d.title), ['House manual']);
  assert.equal((await publicReport(URL_, 'placard', 'reports', { text: 'Water on the floor' }, { fetchImpl: google })).ok, true);
  await assert.rejects(publicRead(URL_, 'placard', 'reports', { fetchImpl: google }), /not public/);
});

test('a wrong key does not read as "Offline"', async () => {
  const { open } = await world();
  const a = open();
  a.setConfig(URL_, 'not-the-key');
  a.put('items', { id: 'peas', name: 'Peas' });
  await a.sync(['items']);
  assert.doesNotMatch(a.statusText(), /Offline/);
  assert.equal(a.statusText(), 'Wrong key — connect again from Switchboard');
  assert.equal(a.state, 'badkey');
  assert.equal(a.pending, 1, 'the change waits for the right key');
  const b = open('larder');                                       // with nothing waiting, too
  b.setConfig(URL_, 'not-the-key');
  await b.sync(['items']);
  assert.equal(b.statusText(), 'Wrong key — connect again from Switchboard');
  assert.equal(b.notReady('items'), "The ledger turned down this phone's key. Press Connect beside this app in Switchboard again.", 'an empty page doesn\'t promise to open by itself');
});

test('the status line says what the ledger is doing: no signal, a broken deployment, a refusal, saved, up to date', async () => {
  const { net, open, Ledger, props, g } = await world();
  const a = open('larder');
  assert.equal(a.statusText(), 'Connected', 'just connected (Switchboard\'s guide quotes it)');
  await a.sync(['items']);
  assert.equal(a.statusText(), 'Up to date');
  a.put('items', { id: 'cumin', name: 'Cumin' });
  assert.equal(a.statusText(), 'Saving 1…');
  await a.flush();
  assert.equal(a.statusText(), 'Saved');
  net.up = false;
  a.put('items', { id: 'dill', name: 'Dill' });
  await a.flush();
  assert.equal(a.statusText(), 'Offline — 1 waiting');
  a.put('items', { id: 'mace', name: 'Mace' });
  assert.equal(a.statusText(), 'Offline — 2 waiting', 'a new change while offline still says offline');
  net.up = true;
  await a.sync(['items']);
  assert.equal(a.statusText(), 'Saved');
  // a deployment set to "Only myself", or deleted: Google answers with its own page
  const page = { ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } };
  const html = new Ledger('larder', { fetchImpl: async () => page });
  await html.sync(['items']);
  assert.equal(html.statusText(), 'The ledger isn\'t answering — check the deployment');
  // ...which a browser usually reports as a network error, since Google's page doesn't allow the app to read it: a
  // plain request that does get through tells it apart from no signal
  const cors = new Ledger('larder', { fetchImpl: async (u, o) => { if (o.mode === 'no-cors') return { ok: false, status: 0, type: 'opaque' }; throw new TypeError('Failed to fetch'); } });
  await cors.sync(['items']);
  assert.equal(cors.statusText(), 'The ledger isn\'t answering — check the deployment');
  const none = new Ledger('larder', { fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
  await none.sync(['items']);
  assert.equal(none.statusText(), 'Offline', 'nothing waiting: not "Offline — 0 waiting"');
  // one bar of signal: a request's answer is lost on the way, though the deployment is fine (its ping reads)
  const flaky = new Ledger('larder', { fetchImpl: async (u, o) => {
    if (o.method === 'POST') throw new TypeError('Failed to fetch');
    return o.mode === 'no-cors' ? { ok: false, status: 0, type: 'opaque' } : { ok: true, status: 200, json: async () => JSON.parse(g.doGet({ parameter: {} }).text) };
  } });
  await flaky.sync(['items']);
  assert.equal(flaky.statusText(), 'Offline', 'not "check the deployment"');
  // the ledger refuses a batch (a lock it couldn't get in 20 s, say): it keeps saying so after a list comes back
  const busy = new Ledger('larder', { fetchImpl: async (u, o) => {
    const b = JSON.parse(o.body);
    const text = b.op === 'batch' ? JSON.stringify({ ok: false, error: 'Lock timeout' }) : JSON.stringify(post(g, b));
    return { ok: true, status: 200, json: async () => JSON.parse(text) };
  } });
  busy.put('items', { id: 'sage', name: 'Sage' });
  await busy.sync(['items']);
  assert.equal(busy.statusText(), 'The ledger said no (Lock timeout) — 1 waiting');
  // a list the ledger refuses, with nothing waiting: no "0 waiting" either
  const no = new Ledger('packrat', { fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ok: false, error: 'Lock timeout' }) }) });
  no.setConfig(URL_, props.KEY);
  await no.sync(['packs']);
  assert.equal(no.statusText(), 'The ledger said no (Lock timeout)');
  no.stop();
  for (const l of [html, cors, none, flaky, busy]) l.stop();
});

test('a sheet with two rows for one id shows the newer, and a row with broken json stays out of the app', async () => {
  const { open, g, props, sheets } = await world();
  post(g, { key: props.KEY, op: 'put', app: 'frostbite', coll: 'zones', id: 'top', doc: { name: 'Top basket' } });
  post(g, { key: props.KEY, op: 'put', app: 'frostbite', coll: 'zones', id: 'bin', doc: { name: 'Bin' } });
  const s = sheets['frostbite.zones'];
  s.data[2][3] = '{"name": "Bin", oops';                          // a hand edit that broke the json
  const a = open();
  const docs = [{ id: 'top', name: 'Top basket, old', _updated: 5 }, { id: 'top', name: 'Top basket', _updated: 9 }, { id: 'top', name: 'Top basket, older', _updated: 1 }];
  a.call = async b => (b.op === 'list' && b.coll === 'items' ? { ok: true, time: 10000, docs } : post(g, { ...b, key: props.KEY }));
  await a.sync(['items', 'zones']);
  assert.equal(a.doc('items', 'top').name, 'Top basket');
  assert.deepEqual(a.docs('zones').map(z => z.name), ['Top basket']);
  assert.equal(a.doc('zones', 'bin'), null);
});

test('moving a phone to a different ledger shows only the new sheet, and says how many waiting changes were dropped', async () => {
  globalThis.localStorage = store();
  const { Ledger } = await import('../js/kit/ledger.js');
  const A = fakeGoogle(), B = fakeGoogle();
  A.g.setup(); B.g.setup();
  post(B.g, { key: B.props.KEY, op: 'put', app: 'frostbite', coll: 'items', id: 'stew', doc: { name: 'Beef stew' } });   // the real sheet, older
  post(A.g, { key: A.props.KEY, op: 'put', app: 'frostbite', coll: 'items', id: 'test', doc: { name: 'Test item' } });   // a trial sheet
  let up = true;
  const fetchImpl = async (url, o) => {
    if (!up) throw new TypeError('Failed to fetch');
    const G = url.includes('/A/') ? A : B;
    const text = JSON.stringify(post(G.g, JSON.parse(o.body)));
    return { ok: true, status: 200, json: async () => JSON.parse(text) };
  };
  const t = new Ledger('frostbite', { fetchImpl }); opened.push(t);
  t.setConfig('https://script.google.com/macros/s/A/exec', A.props.KEY);
  await t.sync(['items']);
  assert.deepEqual(t.docs('items').map(d => d.name), ['Test item']);
  up = false;
  t.put('items', { id: 'peas', name: 'Peas' });
  await t.flush();
  up = true;
  // a new key for the same address (setup run again on the same sheet): everything stays, the change goes
  A.props.KEY = 'k2'.repeat(20);
  assert.equal(t.setConfig('https://script.google.com/macros/s/A/exec', A.props.KEY), 0);
  assert.equal(t.pending, 1);
  up = false;
  t.put('items', { id: 'corn', name: 'Corn' });
  await t.flush();
  up = true;
  // the real sheet: the trial sheet's records and its two waiting changes go
  assert.equal(t.setConfig('https://script.google.com/macros/s/B/exec', B.props.KEY), 2);
  assert.equal(t.pending, 0);
  await t.sync(['items']);
  assert.deepEqual(t.docs('items').map(d => d.name), ['Beef stew']);
  const reload = new Ledger('frostbite', { fetchImpl }); opened.push(reload);
  assert.deepEqual(reload.docs('items').map(d => d.name), ['Beef stew'], 'what a reload finds');
  assert.equal(reload.pending, 0);
  // Forget clears it all
  reload.forget();
  assert.equal(reload.connected, false);
  assert.deepEqual(Object.keys(localStorage.s).filter(k => /^frostbite\.(m\.|outbox|ledger|touched)/.test(k)), []);
});

test('connect links: a good one reads back, a cut-short or foreign one doesn\'t', async () => {
  const { connectLink, readConnectLink } = await import('../js/kit/ledger.js');
  const link = connectLink('https://larder.junkdrawer.works/', 'https://script.google.com/macros/s/AKfy/exec', 'k'.repeat(40));
  assert.deepEqual(readConnectLink(new URL(link).hash), { url: 'https://script.google.com/macros/s/AKfy/exec', key: 'k'.repeat(40) });
  assert.equal(readConnectLink(''), null);
  assert.equal(readConnectLink('#cumin'), null);
  assert.equal(readConnectLink(new URL(link).hash.slice(0, 30)), false, 'cut short');
  assert.equal(readConnectLink('#connect=not base64!'), false);
  assert.equal(readConnectLink('#connect=' + btoa(JSON.stringify({ u: 'https://example.com/exec', k: 'x' }))), false, 'not a Google address');
});

test('an older request from a reloaded page that lands late does not overwrite a newer save', { todo: 'Code.gs applies writes in arrival order; needs a per-device order check' }, async () => {
  const { net, open, sheet } = await world();
  const a = open('mothball');
  let release;
  net.hold = b => (b.op === 'batch' && !release ? new Promise(r => { release = r; }) : null);
  a.put('totes', { id: '01', name: 'Lights', place: 'Garage' });
  const first = a.flush();                                         // on its way, Google slow to start
  await tick();
  a.put('totes', { ...a.doc('totes', '01'), place: 'Attic' });
  const b = open('mothball');                                      // reload: the new page resends the newer copy
  a.fetch = () => new Promise(() => {});                           // the old page is gone: nothing more from it
  net.hold = null;
  await b.flush();
  release(); await first;                                          // the old page's request finally runs
  assert.equal(sheet('mothball', 'totes')['01'].place, 'Attic');
});

test('a duplicate row for one id: writes reach it, lists show one record, deletes stick', async () => {
  const { g, props, sheets } = await world();
  // Two rows for one id made by hand (a row copied, then one copy edited), before anything writes to them: lists and
  // gets answer with the one changed last, wherever it is, which is what Home Assistant and Dispatch read.
  post(g, { key: props.KEY, op: 'put', app: 'larder', coll: 'queue', id: 'q0', doc: { text: 'Dill', synced: true } });
  const q = sheets['larder.queue'].data;
  q.push(['h1', 2000, false, '{"text":"Cumin","synced":true}'], ['h1', 1000, false, '{"text":"Cumin","synced":false}']);
  q.push(['h2', 1000, false, '{"text":"Sage","synced":false}'], ['h2', 2000, false, '{"text":"Sage","synced":true}']);
  const hand = post(g, { key: props.KEY, op: 'list', app: 'larder', coll: 'queue', since: 0, match: { synced: false } }).docs;
  assert.deepEqual(hand.map(d => d.id), [], 'Home Assistant would add a hand-copied entry it already has');
  for (const id of ['h1', 'h2']) assert.equal(post(g, { key: props.KEY, op: 'get', app: 'larder', coll: 'queue', id }).doc.synced, true);
  assert.deepEqual(post(g, { key: props.KEY, op: 'list', app: 'larder', coll: 'queue', since: 0 }).docs.map(d => d.id), ['q0', 'h1', 'h2']);
  post(g, { key: props.KEY, op: 'put', app: 'larder', coll: 'queue', id: 'q1', doc: { text: 'Cumin', synced: false } });
  q.push([...q.find(r => r[0] === 'q1')]);                                 // a row copied by hand, or two writes racing the lock
  post(g, { key: props.KEY, op: 'put', app: 'larder', coll: 'queue', id: 'q1', doc: { text: 'Cumin', synced: true } });
  const waiting = post(g, { key: props.KEY, op: 'list', app: 'larder', coll: 'queue', since: 0, match: { synced: false } }).docs.filter(d => !d._deleted);
  assert.equal(waiting.length, 0, 'Home Assistant would add it to the list again every five minutes');
  assert.deepEqual(q.filter(r => r[0] === 'q1').map(r => JSON.parse(r[3]).synced), [true, true], 'a write reached only one of the two rows');
  post(g, { key: props.KEY, op: 'del', app: 'larder', coll: 'queue', id: 'q1' });
  assert.deepEqual(q.filter(r => r[0] === 'q1').map(r => r[2]), [true, true], 'a delete reached only one of the two rows');
  const all = post(g, { key: props.KEY, op: 'list', app: 'larder', coll: 'queue', since: 0 }).docs.filter(d => d.id === 'q1');
  assert.ok(all.every(d => d._deleted), 'a new phone must not see it come back');
});

test('every write commits before the lock is released', () => {
  const { g, props, locks } = fakeGoogle();
  g.setup();
  post(g, { key: props.KEY, op: 'batch', ops: [{ op: 'put', app: 'larder', coll: 'items', id: 'cumin', doc: { name: 'Cumin' } }] });
  post(g, { key: props.KEY, op: 'put', app: 'larder', coll: 'items', id: 'dill', doc: { name: 'Dill' } });
  assert.deepEqual(locks, ['lock', 'flush', 'release', 'lock', 'flush', 'release']);
});

test('a json cell changed by hand reaches a phone that has already synced, and the About tab is left alone', () => {
  const { g, props, sheets } = fakeGoogle();
  g.setup();
  const key = props.KEY;
  post(g, { key, op: 'put', app: 'frostbite', coll: 'items', id: 'stew', doc: { name: 'Beef stew', qty: 2 } });
  post(g, { key, op: 'put', app: 'frostbite', coll: 'items', id: 'peas', doc: { name: 'Peas', qty: 1 } });
  const s = sheets['frostbite.items'];
  s.data[1][1] = s.data[2][1] = 1000;                            // saved a while ago
  const since = 2000;                                            // and the phone has synced since
  s.data[1][3] = '{"name":"Beef stew","qty":1}';                 // typed into D2
  g.onEdit({ range: s.getRange(2, 4) });
  assert.ok(s.data[1][1] > since, 'the hand-edited row has a new updated time');
  assert.equal(s.data[2][1], 1000, 'the row nobody touched keeps its time');
  assert.equal(s.data[0][1], 'updated', 'the header row is left alone');
  const l = post(g, { key, op: 'list', app: 'frostbite', coll: 'items', since }).docs;
  assert.deepEqual(l.map(d => [d.id, d.qty]), [['stew', 1]]);
  // a paste over several rows, one of them empty below the records
  g.onEdit({ range: s.getRange(1, 1, 4, 4) });
  assert.equal(s.data[3], undefined, 'an empty row gets no stamp');
  const keyCell = sheets.About.data[1][1];
  g.onEdit({ range: sheets.About.getRange(2, 2) });
  assert.equal(sheets.About.data[1][1], keyCell);
  g.onEdit({ range: s.getRange(2, 6) });                         // a note in column F
  g.onEdit({});
});

test('an add sent twice with the same id (a retry) keeps one row and does not undo later changes', { todo: 'add with an id overwrites; Pinch and Cellmate send no id' }, async () => {
  const { g, props, sheets } = await world();
  const add = () => post(g, { key: props.KEY, op: 'add', app: 'larder', coll: 'queue', doc: { id: 'pinch-cumin-2026-09-01', item: 'cumin', synced: false } });
  add();
  post(g, { key: props.KEY, op: 'put', app: 'larder', coll: 'queue', id: 'pinch-cumin-2026-09-01', doc: { item: 'cumin', synced: true } });
  add();
  assert.equal(sheets['larder.queue'].data.length - 1, 1);
  assert.equal(post(g, { key: props.KEY, op: 'list', app: 'larder', coll: 'queue', since: 0, match: { synced: false } }).docs.length, 0);
});

// ---- Round 3's ledger lab (full treatment): each is the shortest sequence its fuzzer or walks found.
test('a delete made again while an earlier send of the same delete is still on its way goes too', async () => {
  const { net, open, sheet, g } = await world();
  const a = open('mothball'), b = open('mothball');               // the installed app and a tab a sticker tap opened
  a.put('totes', { id: '01', name: 'Lights' }); await a.flush();
  let answer;
  net.hold = body => { if (body.op !== 'batch' || answer) return null; const text = JSON.stringify(post(g, body)); return new Promise(r => { answer = () => r(text); }); };
  a.del('totes', '01');
  const first = a.flush();                                         // Google applies the delete; its answer is slow
  await tick(); await tick();
  b.put('totes', { id: '01', name: 'Lights and wreaths' }); await b.flush();   // made again in the other tab, and sent
  b.del('totes', '01');                                            // and deleted again: the same op as the first
  answer(); await first;                                           // the first answer takes away the second delete
  await b.flush(); await a.flush();
  assert.equal(b.pending, 0);
  assert.equal(sheet('mothball', 'totes')['01']._deleted, true, 'the second delete never reached the sheet');
});

test('a sync on its way in another tab when the phone moves to a different ledger brings nothing of the old sheet', async () => {
  globalThis.localStorage = store();
  const { Ledger, adopt } = await import('../js/kit/ledger.js');
  const trial = fakeGoogle(), real = fakeGoogle();
  trial.g.setup(); real.g.setup();
  post(real.g, { key: real.props.KEY, op: 'put', app: 'frostbite', coll: 'items', id: 'stew', doc: { name: 'Beef stew' } });
  real.sheets['frostbite.items'].data[1][1] = Date.now() - 86400e3;   // saved on the real sheet yesterday
  post(trial.g, { key: trial.props.KEY, op: 'put', app: 'frostbite', coll: 'items', id: 'test', doc: { name: 'Test item' } });
  const TRIAL = 'https://script.google.com/macros/s/TRIAL/exec', REAL = 'https://script.google.com/macros/s/REAL/exec';
  let slow = null;
  const fetchImpl = async (url, o) => {
    const body = JSON.parse(o.body), G = url === TRIAL ? trial : real;
    const text = JSON.stringify(post(G.g, body));                    // Google reads it now...
    if (slow && url === TRIAL && body.op === 'list') await slow;      // ...and the answer is slow to come back
    return { ok: true, status: 200, json: async () => JSON.parse(text) };
  };
  const a = new Ledger('frostbite', { fetchImpl }); opened.push(a);
  a.setConfig(TRIAL, trial.props.KEY); await a.sync(['items']);
  const b = new Ledger('frostbite', { fetchImpl }); opened.push(b); b.colls = ['items'];   // a second tab of the app
  let release; slow = new Promise(r => { release = r; });
  const onItsWay = b.sync(['items']);                               // b's list has reached the trial sheet
  await tick(); await tick();
  adopt('frostbite', REAL, real.props.KEY);                         // a connect link for the real ledger, taken in a (it reloads)
  b.reconfig();                                                     // b hears of it (the storage event)
  release(); await onItsWay; await b.sync(['items']);
  const a2 = new Ledger('frostbite', { fetchImpl }); opened.push(a2); await a2.sync(['items']);   // a after its reload
  assert.deepEqual(a2.docs('items').map(d => d.name), ['Beef stew'], 'what the phone shows for the real ledger');
  assert.deepEqual(b.docs('items').map(d => d.name), ['Beef stew']);
  assert.ok(b.synced('items'));
});

test('a list answered from the old sheet after this tab missed the new address is dropped, and the next sync starts fresh', async () => {
  globalThis.localStorage = store();
  const { Ledger, adopt } = await import('../js/kit/ledger.js');
  const trial = fakeGoogle(), real = fakeGoogle();
  trial.g.setup(); real.g.setup();
  post(real.g, { key: real.props.KEY, op: 'put', app: 'mothball', coll: 'totes', id: '01', doc: { name: 'Porch lights' } });
  post(trial.g, { key: trial.props.KEY, op: 'put', app: 'mothball', coll: 'totes', id: '01', doc: { name: 'Trial tote' } });
  post(trial.g, { key: trial.props.KEY, op: 'put', app: 'mothball', coll: 'totes', id: '02', doc: { name: 'Another trial tote' } });
  const TRIAL = 'https://script.google.com/macros/s/TRIAL/exec', REAL = 'https://script.google.com/macros/s/REAL/exec';
  let slow = null;
  const fetchImpl = async (url, o) => {
    const body = JSON.parse(o.body), G = url === TRIAL ? trial : real;
    const text = JSON.stringify(post(G.g, body));
    if (slow && url === TRIAL && body.op === 'list') await slow;
    return { ok: true, status: 200, json: async () => JSON.parse(text) };
  };
  const b = new Ledger('mothball', { fetchImpl }); opened.push(b);
  b.setConfig(TRIAL, trial.props.KEY);
  let release; slow = new Promise(r => { release = r; });
  const onItsWay = b.sync(['totes', 'builds']);
  await tick(); await tick();
  adopt('mothball', REAL, real.props.KEY);   // another tab took a connect link; this one hasn't had the storage event yet
  release();
  assert.equal(await onItsWay, false, 'the old sheet\'s answer counted as a sync');
  assert.equal(b.cfg.url, REAL, 'the tab still talks to the old sheet');
  assert.equal(b.synced('totes'), false, 'the new ledger counts as heard from');
  assert.deepEqual(JSON.parse(localStorage.getItem('mothball.m.totes') || 'null')?.docs || {}, {}, 'the old sheet\'s records were saved for the new one');
  await b.sync(['totes', 'builds']);
  assert.deepEqual(b.docs('totes').map(d => d.name), ['Porch lights']);
});
