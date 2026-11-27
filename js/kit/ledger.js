// The ledger: one Google Sheet (Switchboard's Apps Script) that every tag app reads and writes.
// Each app keeps a mirror of its collections in localStorage, so it opens instantly and works with no signal;
// writes go into an outbox and are sent in one batch when the ledger answers.
let frozen = false; // set while the page reloads for a new connect link: nothing more is written from the old one
const jget = k => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } };
const sget = k => { try { return localStorage.getItem(k); } catch { return null; } };
const jset = (k, v) => { if (frozen) return; try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const drop = k => { if (frozen) return; try { localStorage.removeItem(k); } catch {} };
const clone = o => JSON.parse(JSON.stringify(o));

// A setup link from Switchboard: …/#connect=<base64url of {"u":url,"k":key}>. readConnectLink says what the address
// holds: null (no link), false (a link that doesn't read, cut short say) or { url, key }.
export function readConnectLink(hash) {
  const m = /[#&]connect=([^&]*)/.exec(hash || '');
  if (!m) return null;
  try {
    const { u, k } = JSON.parse(atob(decodeURIComponent(m[1]).replace(/-/g, '+').replace(/_/g, '/')));
    if (typeof u === 'string' && /^https:\/\/script\.google(usercontent)?\.com\//.test(u) && typeof k === 'string' && k) return { url: u, key: k };
  } catch {}
  return false;
}

// Puts a ledger's address and key in place for an app. A different address is a different sheet: what this phone
// kept from the old one (its copy of the records, and changes still waiting to go to it) is cleared, and the number of
// changes dropped is returned. A new key for the same address (setup run again on the same sheet) keeps everything.
export function adopt(app, url, key, colls = []) {
  const old = jget(app + '.ledger') || {};
  let dropped = 0;
  if (old.url !== url) { dropped = (jget(app + '.outbox') || []).length; wipe(app, colls); }
  jset(app + '.ledger', { url, key });
  return dropped;
}
function wipe(app, colls = []) {
  const keys = new Set([app + '.outbox', app + '.touched', ...colls.map(c => `${app}.m.${c}`)]);
  try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k?.startsWith(app + '.m.')) keys.add(k); } } catch {}
  for (const k of keys) drop(k);
  jset(app + '.rev', 'new ledger ' + Date.now());
}

// Saves a connect link found in the address, and tidies the address. True if it was a good one.
export function takeConnectLink(app, loc = location) {
  const c = readConnectLink(loc.hash);
  if (c === null) return false;
  history.replaceState(null, '', loc.pathname + loc.search);
  if (c) adopt(app, c.url, c.key);
  return !!c;
}

// Each app calls this before making its Ledger. A connect link in the address, when the page opens or later (pasted
// into a tab already on the app), is saved; the address is tidied (the key isn't left in it), and say() (a toast)
// tells the person. A link for a new ledger reloads the page, so everything starts from the new one.
export function watchConnectLinks(app, say = () => {}) {
  const NOTE = app + '.connect-note';
  const take = running => {
    const c = readConnectLink(location.hash);
    if (c === null) return;
    history.replaceState(null, '', location.pathname + location.search);
    if (!c) { say('That connect link didn\'t work. Press Connect in Switchboard again.', 'bad'); return; }
    const old = jget(app + '.ledger') || {};
    if (old.url === c.url && old.key === c.key) { say('Connected to your ledger.'); return; }
    const dropped = adopt(app, c.url, c.key);
    const text = 'Connected to your ledger.' + (dropped ? ` ${dropped} change${dropped > 1 ? 's' : ''} waiting for the old one ${dropped > 1 ? 'were' : 'was'} dropped.` : '');
    if (!running) { say(text); return; }
    frozen = true;
    try { sessionStorage.setItem(NOTE, text); } catch {}
    location.reload();
  };
  try { const t = sessionStorage.getItem(NOTE); if (t) { sessionStorage.removeItem(NOTE); say(t); } } catch {}
  take(false);
  addEventListener('hashchange', () => take(true));
}

export function connectLink(base, url, key) {
  const b = btoa(JSON.stringify({ u: url, k: key })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${base}#connect=${b}`;
}

// Public reads need no key: only collections the ledger lists as public answer (Placard's site). Google gets 12 s to
// answer a read and 20 s a report; past that it counts as no signal (e.kind 'offline'), so a tenant on one bar that
// never answers sees the page's own message (no connection, or the report kept with Text it instead) instead of a
// wait with no end.
export const READ_LIMIT = 12000, REPORT_LIMIT = 20000;
async function answer(url, opts, ms, fetchImpl) {
  const ac = typeof AbortController === 'function' ? new AbortController() : null;
  const t = ac ? later(() => ac.abort(), ms) : null;
  try {
    const r = await fetchImpl(url, { ...opts, ...(ac ? { signal: ac.signal } : {}) });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || 'ledger said no');
    return j;
  } catch (e) {
    throw e.name === 'AbortError' ? failed(`no answer in ${ms / 1000} s`, 'offline') : e;
  } finally { clearTimeout(t); }
}
export async function publicRead(url, app, coll, { fetchImpl = (...a) => fetch(...a), limit = READ_LIMIT } = {}) {
  return (await answer(`${url}?op=pub&app=${encodeURIComponent(app)}&coll=${encodeURIComponent(coll)}`, {}, limit, fetchImpl)).docs;
}
export async function publicReport(url, app, coll, doc, { fetchImpl = (...a) => fetch(...a), limit = REPORT_LIMIT } = {}) {
  return answer(url, { method: 'POST', body: JSON.stringify({ op: 'report', app, coll, doc }) }, limit, fetchImpl);
}

// After a save that didn't go, try again after 5 s, 15 s, 30 s and a minute, then every two minutes while anything is
// waiting. A request Google hasn't answered in 45 s counts as no signal, so one stuck request never holds up the rest.
const RETRY = [5000, 15000, 30000, 60000, 120000];
const TIMEOUT = 45000;
const RESYNC = 30000; // coming back to the page brings it up to date, at most this often
// A page going away (the tab closed, the phone locked) sends what's waiting with fetch's keepalive, so the send
// outlives the page. Chromium refuses a keepalive body of 64 KiB or more before sending it, so only the first writes
// whose request stays under this many bytes go that way; the rest wait for the next ordinary send.
const KEEPALIVE_MAX = 60000;
const later = (fn, ms) => { const t = setTimeout(fn, ms); t?.unref?.(); return t; }; // unref: Node's tests don't wait on it
export const CANT_REACH = 'Can\'t reach the ledger yet. This opens as soon as it can.';
export const STILL_LOADING = 'Still loading from the ledger. Try again in a moment.';
export const WRONG_KEY = 'The ledger turned down this phone\'s key. Press Connect beside this app in Switchboard again.';
export const TOO_LONG = 'Too long to save: over 45,000 characters. Shorten it.';

// The ledger's own rules for a record (Code.gs write()): an id of 1-60 letters, digits and _ . : -, and at most 45,000
// characters of JSON without the id. put() and del() refuse anything else before it's queued, so one record the ledger
// would refuse can't hold up every save after it. refusal(doc) says why: '' (fine), 'bad id' or 'too big'.
export const ID_RULE = /^[A-Za-z0-9_.:-]{1,60}$/;
export const MAX_JSON = 45000;
export function refusal(doc) {
  if (!doc || !ID_RULE.test(String(doc.id ?? ''))) return 'bad id';
  const { id, _updated, _deleted, ...rest } = doc;
  return JSON.stringify(rest).length > MAX_JSON ? 'too big' : '';
}
// The line a sheet's check says for a record put() would refuse ('' when it can be saved).
export function refusedLine(doc) {
  const why = refusal(doc);
  return why === 'too big' ? TOO_LONG : why ? `"${doc?.id ?? ''}" can't be an id: letters, digits and dashes only.` : '';
}
// An import over what's here: the file fills in what's empty here and adds what's new, but never blanks or replaces a
// value here, so what was typed on the phone stays. A list of lines (a tote's contents, its build cards) gains the
// file's lines it doesn't have yet; an object (a contact card) is filled in field by field. custom[field](here, file)
// gives { value, filled, kept } for a field with rules of its own (Placard's details). Returns { doc, filled, kept }:
// the fields filled in or added to, and the fields where this copy kept a value the file has blank, different or not
// at all.
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
export const blank = v => v == null || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && !v.length) || (isObj(v) && Object.values(v).every(blank));
const lineKey = s => s.trim().toLowerCase();
export function fillIn(here, file, custom = {}) {
  const doc = clone(here), filled = [], kept = [];
  for (const [k, v] of Object.entries(file)) {
    if (k === 'id' || k.startsWith('_')) continue;
    const was = doc[k];
    if (custom[k]) {
      const r = custom[k](was, v);
      doc[k] = r.value; if (r.filled) filled.push(k); if (r.kept) kept.push(k);
    } else if (blank(v)) {
      if (!(k in doc)) doc[k] = clone(v); else if (!blank(was)) kept.push(k);
    } else if (blank(was)) {
      doc[k] = clone(v); filled.push(k);
    } else if (isObj(was) && isObj(v)) {
      const r = fillIn(was, v);
      doc[k] = r.doc; if (r.filled.length) filled.push(k); if (r.kept.length) kept.push(k);
    } else if (Array.isArray(was) && Array.isArray(v) && [...was, ...v].every(x => typeof x === 'string')) {
      const have = new Set(was.map(lineKey)), add = v.filter(x => x.trim() && !have.has(lineKey(x)));
      if (add.length) { doc[k] = [...was, ...add]; filled.push(k); }
      const theirs = new Set(v.map(lineKey));
      if (was.some(x => !theirs.has(lineKey(x)))) kept.push(k);
    } else if (JSON.stringify(was) !== JSON.stringify(v)) kept.push(k);
  }
  for (const k of Object.keys(here)) if (!(k in file) && k !== 'id' && !k.startsWith('_') && !blank(here[k]) && !kept.includes(k)) kept.push(k);
  return { doc, filled, kept };
}
// What an import did, for its toast: 'Added 2, filled in 3, kept your edits.', 'Nothing new in the file; your edits
// stay.', '…; left out 1 you deleted', '…; skipped 1 (id "Tote 6")'. what: ['page', 'pages'] names what was added.
export function importSummary({ added = 0, filled = 0, kept = 0, gone = 0, skipped = [] }, what = null) {
  const did = [added ? `added ${added}${what ? ' ' + what[added === 1 ? 0 : 1] : ''}` : '', filled ? `filled in ${filled}` : ''].filter(Boolean);
  let text = did.length ? did.join(', ') : 'nothing new in the file';
  if (kept) text += did.length ? ', kept your edits' : '; your edits stay';
  if (gone) text += `; left out ${gone} you deleted`;
  if (skipped.length) text += `; skipped ${skipped.length} (${skipped.slice(0, 3).join(', ')}${skipped.length > 3 ? ', …' : ''})`;
  return text[0].toUpperCase() + text.slice(1) + '.';
}
const STUCK = new Set(['offline', 'badkey', 'broken', 'error']);   // states a new change doesn't paper over
const failed = (message, kind) => Object.assign(new Error(message), { kind });
// Two tabs of one app (the installed app left open, and the tab a sticker tap opened) share its storage: the outbox
// (<app>.outbox), the mirror (<app>.m.<collection>) and <app>.rev, which changes with every write. A tab whose rev is
// out of date reads the others' writes back before it shows or changes anything, so neither drops the other's.
// <app>.touched says when this phone last changed each record, so a list Google read before that change can't undo it.
const TOUCH_KEEP = 120000;
// Once a day each collection is listed whole, and a record the sheet no longer has at all (a row cleared or deleted by
// hand, an earlier version of the sheet restored) leaves this phone too: a list of what changed can't say that. When it
// was last listed whole is kept with the copy (fullAt).
const FULL_EVERY = 24 * 3600e3;

export class Ledger {
  constructor(app, { demo = null, fetchImpl = null } = {}) {
    this.app = app;
    this.cfg = jget(app + '.ledger') || {};
    this.demo = demo ? new DemoLedger(demo) : null;
    this.fetch = fetchImpl || ((...a) => fetch(...a));
    this.mirror = {};
    this.outbox = this.demo ? [] : (jget(app + '.outbox') || []);
    this.rev = this.demo ? null : sget(app + '.rev');
    this.touchedHere = {};    // the same as <app>.touched, for the sample (which keeps nothing)
    this.listeners = new Set();
    this.state = this.demo ? 'demo' : (this.connected ? (this.outbox.length ? 'pending' : 'idle') : 'unset');
    this.lastError = '';
    this.timeout = TIMEOUT;
    this.tries = 0;           // failed tries in a row
    this.answered = false;    // a sync has come back in this page
    this.syncFailed = false;  // the last sync didn't
    this.lastSync = 0;        // when the last sync ended in this page, and when the last one that came back did
    this.listedAt = 0;
    this.colls = null; this.onChange = null; this.stopped = false; this.unlisten = [];
  }
  get connected() { return !!(this.demo || (this.cfg.url && this.cfg.key)); }
  // A new address clears what this phone kept from the old ledger (see adopt); returns the changes dropped.
  setConfig(url, key) {
    const cfg = { url: String(url).trim(), key: String(key).trim() };
    const dropped = adopt(this.app, cfg.url, cfg.key, [...Object.keys(this.mirror), ...(this.colls || [])]);
    if (cfg.url !== this.cfg.url) this.restart();
    this.cfg = cfg;
    this.state = 'idle'; this.emit();
    return dropped;
  }
  forget() {
    wipe(this.app, [...Object.keys(this.mirror), ...(this.colls || [])]); drop(this.app + '.ledger');
    this.cfg = {}; this.restart(); this.state = 'unset'; this.emit();
  }
  // Forgets this page's copy of everything (after a new ledger, or another tab's), so it all comes from storage again.
  restart() {
    this.mirror = {}; this.outbox = this.demo ? [] : jget(this.app + '.outbox') || []; this.rev = sget(this.app + '.rev');
    this.answered = false; this.syncFailed = false; this.listedAt = 0; this.tries = 0; this.lastError = '';
  }
  // Another tab connected this app to a ledger, or forgot it.
  reconfig() {
    const cfg = jget(this.app + '.ledger') || {};
    if (cfg.url === this.cfg.url && cfg.key === this.cfg.key) return;
    if (cfg.url !== this.cfg.url) this.restart();
    this.cfg = cfg;
    this.state = this.connected ? 'idle' : 'unset';
    this.emit(); this.changed();
    // a fresh sync, after the one on its way (which, asked of the old sheet, brings nothing back: see _sync)
    if (this.connected && this.colls) (this._syncing || Promise.resolve()).then(() => this.sync(this.colls));
  }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { for (const fn of this.listeners) try { fn(this); } catch (e) { console.warn(e); } }

  // One request. A failure says what kind it was (e.kind): offline (no signal, or no answer in 45 s), badkey (the key
  // changed), broken (a deployment set to "Only myself" or deleted: see unreadable()) or error (the ledger said no).
  // keepalive only for a send as the page goes away (see flush).
  async call(body, { keepalive = false } = {}) {
    if (this.demo) return this.demo.handle(clone(body));
    if (!this.connected) throw failed('not connected', 'unset');
    const ac = typeof AbortController === 'function' ? new AbortController() : null;
    const t = ac ? later(() => ac.abort(), this.timeout) : null;
    let r, j;
    try {
      try { r = await this.fetch(this.cfg.url, { method: 'POST', body: JSON.stringify({ ...body, key: this.cfg.key }), ...(keepalive ? { keepalive: true } : {}), ...(ac ? { signal: ac.signal } : {}) }); }
      catch (e) { throw e.name === 'AbortError' ? failed('no answer in 45 s', 'offline') : failed(e.message, await this.unreadable() ? 'broken' : 'offline'); }
      if (!r.ok) throw failed('ledger HTTP ' + r.status, 'broken');
      try { j = await r.json(); }
      catch (e) { throw e.name === 'SyntaxError' ? failed('the ledger answered with a page, not data', 'broken') : failed(e.message, 'offline'); }
    } finally { clearTimeout(t); }
    if (!j.ok) throw failed(j.error || 'ledger said no', /bad key/.test(j.error) ? 'badkey' : 'error');
    return j;
  }
  // After a request failed the way no signal does: was it the connection, or a deployment that answers with a Google
  // sign-in or "not found" page (which a browser reports the same way, since the page doesn't let the app read it)?
  // A plain GET is the ledger's ping: if its answer reads, the deployment is fine and the connection dropped. If it
  // doesn't, but an opaque (no-cors) request does get an answer, the deployment is what's wrong.
  async unreadable() {
    const get = async mode => {
      const ac = typeof AbortController === 'function' ? new AbortController() : null;
      const t = ac ? later(() => ac.abort(), 10000) : null;
      try { const r = await this.fetch(this.cfg.url, { ...(mode ? { mode } : {}), ...(ac ? { signal: ac.signal } : {}) }); if (!mode) await r.json(); return true; }
      catch { return false; } finally { clearTimeout(t); }
    };
    return !(await get('')) && await get('no-cors');
  }
  fail(e) { this.state = e.kind || 'offline'; this.lastError = e.message; }
  async ping() { return this.call({ op: 'ping' }); }

  // ---- the mirror, and what other tabs of this app wrote
  // True when another tab had written since this one last looked: the outbox and mirror are now theirs plus ours.
  fresh() {
    if (this.demo) return false;
    const rev = sget(this.app + '.rev');
    if (rev === this.rev) return false;
    this.rev = rev;
    this.outbox = jget(this.app + '.outbox') || [];
    if (this.state === 'pending' && !this.outbox.length) this.state = 'saved';   // the other tab sent this one's changes too
    for (const coll of Object.keys(this.mirror)) this.mirror[coll] = jget(`${this.app}.m.${coll}`) || { docs: {}, since: 0 };
    return true;
  }
  stamp() { if (!this.demo) { this.rev = Date.now().toString(36) + Math.random().toString(36).slice(2, 8); jset(this.app + '.rev', this.rev); } }
  m(coll) {
    this.fresh();
    if (!this.mirror[coll]) this.mirror[coll] = (this.demo ? null : jget(`${this.app}.m.${coll}`)) || { docs: {}, since: 0 };
    return this.mirror[coll];
  }
  save(coll) { if (!this.demo) { jset(`${this.app}.m.${coll}`, this.m(coll)); this.stamp(); } }
  touch(coll, id) {
    const now = Date.now(), t = this.touched();
    for (const k of Object.keys(t)) if (t[k] < now - TOUCH_KEEP) delete t[k];
    t[coll + '/' + id] = now;
    if (this.demo) this.touchedHere = t; else jset(this.app + '.touched', t);
  }
  touched() { return this.demo ? { ...this.touchedHere } : jget(this.app + '.touched') || {}; }
  // A row whose json cell isn't valid JSON comes back as { id, _bad }: it stays out of the app, like a deleted one.
  docs(coll) { return Object.values(this.m(coll).docs).filter(d => !d._deleted && !d._bad); }
  doc(coll, id) { const d = this.m(coll).docs[id]; return d && !d._deleted && !d._bad ? d : null; }
  has(coll) { return this.m(coll).since > 0 || Object.keys(this.m(coll).docs).length > 0; }
  // True once a list of this collection has come back on this phone (kept with the copy, so a phone that heard from
  // the ledger yesterday and has no signal now still counts). Until then the copy can't say which numbers and names
  // another device already used, so a new record made from it could land on one in the sheet and replace it: the apps
  // hold back New until it's true. (has() is true for a record only made here, too.) The sample answers at once.
  synced(coll) { const mm = this.m(coll); return this.demo ? this.answered || this.has(coll) : !!mm.listed || mm.since > 0; }
  // A record deleted here, or on the sheet as this phone last heard: an import leaves it out.
  gone(coll, id) { return !!this.m(coll).docs[id]?._deleted; }
  // What a page should say while these collections haven't been heard from yet ('' once they have): on an empty
  // list, and beside the buttons that make a new record, which wait for it.
  notReady(...colls) {
    if (colls.every(c => this.synced(c))) return '';
    if (this.state === 'badkey') return WRONG_KEY;
    return this.syncFailed && !this.answered ? CANT_REACH : 'Loading…';
  }
  // Before a new record is made from this copy: if no list has come back in this page for 30 s, ask now (up to 4 s),
  // so a number or name another device has taken since is seen. No answer (no signal): it goes on with the copy.
  async catchUp(colls, ms = 4000) {
    if (this.demo || !this.connected || Date.now() - this.listedAt < RESYNC) return;
    await Promise.race([this.sync(colls), new Promise(r => later(r, ms))]);
  }

  put(coll, doc) {
    const why = refusal(doc);
    if (why) throw Object.assign(new Error(why === 'bad id' ? `bad id ${doc?.id ?? ''}` : 'record too big'), { refused: why });
    const d = { ...clone(doc), _updated: Date.now() };
    delete d._deleted;
    this.m(coll).docs[d.id] = d; this.touch(coll, d.id); this.save(coll);
    this.queue({ op: 'put', app: this.app, coll, id: d.id, doc: d });
    return d;
  }
  del(coll, id) {
    if (refusal({ id })) throw Object.assign(new Error('bad id ' + id), { refused: 'bad id' });
    const mm = this.m(coll);
    mm.docs[id] = { id, _deleted: true, _updated: Date.now() }; this.touch(coll, id); this.save(coll);
    this.queue({ op: 'del', app: this.app, coll, id });
  }
  // Each write carries its own stamp (q), which the ledger ignores: a send answered late takes out of the outbox only
  // the writes it carried, never a later one that reads the same (a tote deleted, made again and deleted again).
  queue(op) {
    op = { ...op, q: Date.now().toString(36) + Math.random().toString(36).slice(2, 7) };
    this.fresh();                                    // another tab's waiting writes stay in
    this.outbox = this.outbox.filter(o => !(o.coll === op.coll && o.id === op.id)); // only the latest write per doc
    this.outbox.push(op);
    if (!this.demo) { jset(this.app + '.outbox', this.outbox); this.stamp(); }
    if (!STUCK.has(this.state)) this.state = 'pending';
    this.emit();
    clearTimeout(this._t); this._t = later(() => this.flush(), 400);
  }
  get pending() { this.fresh(); return this.outbox.length; }
  waiting(coll) { this.fresh(); return this.outbox.filter(o => o.coll === coll).map(o => o.id); }

  // Sends the outbox, 40 at a time (the next batch goes on its own). Resolves false if the batch didn't go.
  // { keepalive: true } as the page goes away: the first writes that fit a keepalive request (KEEPALIVE_MAX) go with
  // it, and the rest by ordinary sends after it, if the page is still there; a first write too big for one goes by an
  // ordinary send.
  flush({ keepalive = false } = {}) {
    if (this._flushing) return this._flushing;
    if (!this.outbox.length || !this.connected || this.stopped) return Promise.resolve(!this.outbox.length);
    const p = this._flushing = this._flush(keepalive).finally(() => { if (this._flushing === p) this._flushing = null; });
    return p;
  }
  // How many of these writes fit one keepalive request: its body in bytes, as call() sends it, stays under KEEPALIVE_MAX.
  fits(ops) {
    const size = s => new TextEncoder().encode(s).length;
    let bytes = size(JSON.stringify({ op: 'batch', ops: [], key: this.cfg.key })), n = 0;
    for (const o of ops) { bytes += size(JSON.stringify(o)) + (n ? 1 : 0); if (bytes >= KEEPALIVE_MAX) break; n++; }
    return n;
  }
  async _flush(keepalive = false) {
    this.fresh();
    let ops = this.outbox.slice(0, 40);
    if (keepalive && !this.demo) { const n = this.fits(ops); if (n) ops = ops.slice(0, n); else keepalive = false; }
    let ok = false;
    try {
      await this.call({ op: 'batch', ops }, { keepalive });
      this.fresh();                                  // what went, by content and stamp: a newer write of the same record stays
      const sent = new Set(ops.map(o => JSON.stringify(o)));
      this.outbox = this.outbox.filter(o => !sent.has(JSON.stringify(o)));
      if (!this.demo) { jset(this.app + '.outbox', this.outbox); this.stamp(); }
      this.state = this.demo ? 'demo' : this.outbox.length ? 'pending' : 'saved'; this.lastError = '';
      this.tries = 0; ok = true;
    } catch (e) {
      this.fail(e);
    }
    this.emit();
    if (!ok) { this.retry(); return false; }
    this.calm();
    if (this.outbox.length) { this._flushing = null; this.flush(); }
    return true;
  }

  // Brings collections up to date. A record with a write waiting (when the list is asked for, or still when it comes
  // back), or changed on this phone since it was asked for, keeps the copy here: the list may have been read before
  // that write reached the sheet.
  sync(colls) {
    if (!this.connected) return Promise.resolve(false);
    if (this._syncing) return this._syncing;
    this._syncing = this._sync(colls).finally(() => { this._syncing = null; });
    return this._syncing;
  }
  // True when this phone has been connected to a different ledger (in another tab) since this page last looked; it
  // takes the new one up (reconfig).
  moved() { const now = jget(this.app + '.ledger') || {}; if (now.url === this.cfg.url) return false; this.reconfig(); return true; }
  async _sync(colls) {
    const url = this.cfg.url;                        // the sheet these lists are asked of
    const had = this.pending, sent = await this.flush();
    const ready = colls.map(c => this.synced(c)).join();
    let changed = false, ok = false;
    try {
      // every collection is asked for at once, and the answers are taken in order, each with the time it was asked
      // and what was waiting then
      const asks = colls.map(coll => {
        const asked = Date.now(), full = asked - (this.m(coll).fullAt || 0) > FULL_EVERY;
        return { coll, asked, full, waitingThen: this.waiting(coll), answer: this.call({ op: 'list', app: this.app, coll, since: full ? 0 : this.m(coll).since }) };
      });
      for (const a of asks) a.answer.catch(() => {});   // one failing after an earlier one did is said once, below
      for (const { coll, asked, full, waitingThen, answer } of asks) {
        const j = await answer;
        // the phone moved to another ledger while this was asked: the old sheet's answer isn't the new one's copy,
        // and nothing is saved (not even that the new ledger has been heard from)
        if (this.cfg.url !== url || this.moved()) return false;
        const mm = this.m(coll), touched = this.touched();
        const waiting = new Set([...waitingThen, ...this.waiting(coll)]);
        const newest = {};                           // one record per id, should the sheet have two rows for one
        for (const d of j.docs) if (!newest[d.id] || (d._updated || 0) >= (newest[d.id]._updated || 0)) newest[d.id] = d;
        for (const d of Object.values(newest)) {
          if (waiting.has(d.id) || touched[coll + '/' + d.id] >= asked) continue;
          if (!changed && JSON.stringify(mm.docs[d.id]) !== JSON.stringify(d)) changed = true;
          mm.docs[d.id] = d;
        }
        if (full) {                                  // the whole list: what isn't in it has gone from the sheet
          const have = new Set(j.docs.map(d => String(d.id)));
          for (const id of Object.keys(mm.docs)) if (!have.has(id) && !waiting.has(id) && !(touched[coll + '/' + id] >= asked)) { delete mm.docs[id]; changed = true; }
          mm.fullAt = asked;
        }
        mm.since = (j.time || Date.now()) - 5000; // overlap: a write in the same moment as the list is fetched again, never missed
        mm.listed = true;
        this.save(coll);
      }
      // a send that failed keeps its say in the status line: the lists coming back don't mean the change went
      if (sent) { this.state = this.demo ? 'demo' : this.outbox.length ? 'pending' : had ? 'saved' : 'synced'; this.lastError = ''; }
      ok = true;
    } catch (e) {
      this.fail(e);
    }
    const first = !this.answered && !this.syncFailed;
    this.answered ||= ok; this.syncFailed = !ok; this.lastSync = Date.now(); if (ok) this.listedAt = this.lastSync;
    this.emit();
    if (ok) this.calm(); else this.retry();
    if (changed || first || ready !== colls.map(c => this.synced(c)).join()) this.changed();
    return ok;
  }

  // ---- staying up to date while the page is open
  // keepUp(colls, onChange): syncs now, then again when the signal comes back, when the page is shown again (at most
  // every 30 s) and on the retry timer while anything is waiting. onChange runs whenever what the page shows may differ.
  keepUp(colls, onChange) {
    this.colls = colls; this.onChange = onChange;
    const w = globalThis.window, d = globalThis.document;
    const on = (t, ev, fn) => { if (t?.addEventListener) { t.addEventListener(ev, fn); this.unlisten.push(() => t.removeEventListener(ev, fn)); } };
    on(w, 'online', () => this.wake(true));
    on(w, 'pageshow', e => { if (e.persisted) this.wake(); });
    on(d, 'visibilitychange', () => { if (d.visibilityState === 'visible') this.wake(); else this.flush({ keepalive: true }); });
    on(w, 'pagehide', () => this.flush({ keepalive: true }));   // the tab closed, or the page left for another
    on(w, 'storage', e => {
      if (e.key == null || e.key === this.app + '.ledger') this.reconfig();
      if ((e.key == null || e.key.startsWith(this.app + '.')) && this.fresh()) { this.emit(); this.changed(); }
    });
    if (this.connected) this.sync(colls);
    return this;
  }
  // The signal is back, or the page is in front again: send what's waiting, and catch up if it's been a while.
  wake(now = false) {
    if (this.stopped || !this.connected) return;
    this.tries = 0;                                  // a fresh start: tries after this one back off from 5 s again
    if (this.colls && (now || this.syncFailed || Date.now() - this.lastSync > RESYNC)) this.sync(this.colls);
    else this.flush();
  }
  get behind() { return !!(this.outbox.length || (this.colls && this.syncFailed)); }
  // After a try that failed: the next one, later each time. Not for a key the ledger refuses: only a new connect link
  // mends that, and it reloads the page.
  retry() {
    clearTimeout(this._r);
    if (this.stopped || this.demo || !this.connected || !this.behind || this.state === 'badkey') return;
    this._r = later(async () => {
      this._r = null;
      await (this.colls ? this.sync(this.colls) : this.flush());
      if (this.behind && !this._r) this.retry();      // it joined a sync already on its way, which left things waiting
    }, RETRY[Math.min(this.tries, RETRY.length - 1)]);
    this.tries++;
  }
  // After a try that worked: no more tries once nothing is waiting (a timer set by an earlier failure stays otherwise).
  calm() { if (!this.behind) { clearTimeout(this._r); this._r = null; this.tries = 0; } }
  // Tells the page to draw again, but not under someone typing into a box on the page itself (Larder's search):
  // that waits until they leave the box. Forms in a sheet (a dialog) aren't redrawn, so they don't wait.
  changed() {
    if (!this.onChange) return;
    clearTimeout(this._c);
    this._c = later(() => {
      const a = globalThis.document?.activeElement;
      const typing = a && (a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || (a.tagName === 'INPUT' && !/^(checkbox|radio|button|submit|reset|file|range|color)$/.test(a.type))) && !a.closest?.('dialog');
      if (typing) { a.addEventListener('blur', () => { this._c = later(() => this.changed(), 400); }, { once: true }); return; }
      try { this.onChange(this); } catch (e) { console.warn(e); }
    }, 20);
  }
  stop() { this.stopped = true; clearTimeout(this._r); clearTimeout(this._t); clearTimeout(this._c); this.unlisten.splice(0).forEach(f => f()); }

  // The line under each app's name. Its class is the state: idle, saved and synced are green; pending amber; the rest red.
  statusText() {
    if (this.demo) return 'Sample data: nothing is kept';
    this.fresh();
    const n = this.outbox.length, waits = n ? ` — ${n} waiting` : '';   // "Offline" alone when nothing is waiting
    return ({ unset: 'Not connected to the ledger', idle: 'Connected', pending: `Saving ${n}…`, saved: 'Saved', synced: 'Up to date',
      offline: `Offline${waits}`, badkey: 'Wrong key — connect again from Switchboard',
      broken: 'The ledger isn\'t answering — check the deployment', error: `The ledger said no (${this.lastError})${waits}` })[this.state] || '';
  }
}

// The same answers as the Apps Script, held in memory: the sample mode and the tests use it.
export class DemoLedger {
  constructor(seed) {
    this.t = 1000;
    this.store = {};
    for (const [name, docs] of Object.entries(seed || {})) for (const d of docs) this.write(name, d);
    this.reports = [];
  }
  write(name, doc) { (this.store[name] ||= {})[doc.id] = { ...doc, _updated: ++this.t }; }
  handle(b) {
    const name = `${b.app}.${b.coll}`;
    const docs = () => Object.values(this.store[name] || {});
    switch (b.op) {
      case 'ping': return { ok: true, version: 'demo', time: this.t };
      case 'list': return { ok: true, time: this.t, docs: docs().filter(d => d._updated > (b.since || 0)) };
      case 'pub': return { ok: true, docs: docs().filter(d => !d._deleted) };
      case 'report': this.reports.push(b.doc); return { ok: true };
      case 'put': this.write(name, { ...b.doc, id: b.id }); return { ok: true };
      case 'del': this.write(name, { id: b.id, _deleted: true }); return { ok: true };
      case 'batch': for (const o of b.ops) this.handle(o); return { ok: true, n: b.ops.length };
      default: return { ok: false, error: 'unknown op ' + b.op };
    }
  }
}
