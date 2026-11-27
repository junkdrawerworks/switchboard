// The ledger's Apps Script (ledger/Code.gs) run in Node against a pretend Google Sheet, and the apps' Ledger class
// (js/kit/ledger.js) talking to it, so the whole round trip is tested without Google.
import { test } from 'node:test';
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
    MailApp: { sendEmail: (...a) => mail.push(a), getRemainingDailyQuota: () => 100 },
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
  post(g, { key, op: 'batch', ops: [{ op: 'put', app: 'mothball', coll: 'totes', id: '01', doc: { name: 'Lights and the rink' } }] });
  post(g, { key, op: 'put', app: 'mothball', coll: 'totes', id: '2026-12-01', doc: { name: 'A date-shaped id' } });
  assert.deepEqual(sheets['mothball.totes'].data.slice(1).map(r => r[0]), ['01', '2026-12-01'], 'one row for 01, kept as text');
  const docs = post(g, { key, op: 'list', app: 'mothball', coll: 'totes', since: 0 }).docs;
  assert.deepEqual(docs.map(d => [d.id, d.name]), [['01', 'Lights and the rink'], ['2026-12-01', 'A date-shaped id']]);
  assert.equal(post(g, { key, op: 'get', app: 'mothball', coll: 'totes', id: '01' }).doc.name, 'Lights and the rink');
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
const store = () => ({ s: {}, getItem(k) { return this.s[k] ?? null; }, setItem(k, v) { this.s[k] = String(v); }, removeItem(k) { delete this.s[k]; } });
const URL_ = 'https://script.google.com/macros/s/X/exec';
async function world() {
  globalThis.localStorage = store();
  const { Ledger } = await import('../js/kit/ledger.js');
  const { g, props, sheets } = fakeGoogle();
  g.setup();
  const net = { up: true, hold: null };
  // hold(body) may return a promise: the request is applied when it resolves, then answered
  const fetchImpl = async (url, o) => {
    if (!net.up) throw new TypeError('Failed to fetch');
    const body = JSON.parse(o.body);
    const early = net.hold ? await net.hold(body) : null;
    const text = typeof early === 'string' ? early : JSON.stringify(post(g, body));
    return { ok: true, status: 200, json: async () => JSON.parse(text) };
  };
  const open = (app = 'frostbite') => { const l = new Ledger(app, { fetchImpl }); if (!l.connected) l.setConfig(URL_, props.KEY); return l; };
  const sheet = (app, coll) => Object.fromEntries(post(g, { key: props.KEY, op: 'list', app, coll, since: 0 }).docs.map(d => [d.id, d]));
  return { g, props, sheets, net, open, sheet };
}
const tick = () => new Promise(r => setImmediate(r));

test('a save made offline goes out by itself once the signal is back', { todo: 'no flush on online/visibility, no retry timer' }, async t => {
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

test('a list answer read before a save does not put the old copy back after the save is answered', { todo: 'sync keeps only ids still in the outbox' }, async () => {
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

test('two tabs of one app on one phone never drop each other\'s waiting changes', { todo: 'each Ledger rewrites the shared outbox from its own memory' }, async () => {
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

test('an open tab sees a change made in another tab before its next edit', { todo: 'no storage event / visibility sync: a stale window writes its old copy back' }, async () => {
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

test('one record the ledger refuses does not hold back the others, and the status says so', { todo: 'a refused op fails the whole batch forever; status reads "Saving 1…"' }, async () => {
  const { open, sheet } = await world();
  const a = open('mothball');
  a.put('builds', { id: 'Tree topper', name: 'from an import file' });
  await a.flush();
  a.put('totes', { id: '02', name: 'Halloween' });
  await a.sync(['totes', 'builds']); await a.sync(['totes', 'builds']);
  assert.ok(sheet('mothball', 'totes')['02'], 'the good record reaches the sheet');
  assert.doesNotMatch(a.statusText(), /^Saving/);
});

test('a wrong key does not read as "Offline"', { todo: 'statusText has no state for a refused key' }, async () => {
  const { open } = await world();
  const a = open();
  a.setConfig(URL_, 'not-the-key');
  a.put('items', { id: 'peas', name: 'Peas' });
  await a.sync(['items']);
  assert.doesNotMatch(a.statusText(), /Offline/);
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
  post(g, { key: props.KEY, op: 'put', app: 'larder', coll: 'queue', id: 'q1', doc: { text: 'Cumin', synced: false } });
  sheets['larder.queue'].data.push([...sheets['larder.queue'].data[1]]);   // a row copied by hand, or two writes racing the lock
  post(g, { key: props.KEY, op: 'put', app: 'larder', coll: 'queue', id: 'q1', doc: { text: 'Cumin', synced: true } });
  const waiting = post(g, { key: props.KEY, op: 'list', app: 'larder', coll: 'queue', since: 0, match: { synced: false } }).docs.filter(d => !d._deleted);
  assert.equal(waiting.length, 0, 'Home Assistant would add it to the list again every five minutes');
  post(g, { key: props.KEY, op: 'del', app: 'larder', coll: 'queue', id: 'q1' });
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
