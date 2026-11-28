// Needs a look and Find anything: what each app says is due, and what it holds, from the app's own rules. Each app
// publishes js/attention.js (its COLLS; look(read, now) for its lines; things(read, now) for what its own search looks
// through; tags(read) for what each of its stickers is for); Switchboard imports it from the app's address and hands it
// the app's records, read from the ledger with the key Switchboard already holds. Read only: the only requests here are lists, and nothing is
// written to any app's records. No DOM here: unit-tested in test/ledger.test.mjs (against the pretend Sheet), and with
// the five apps' real files in the build folder's common/tools/test_attention.mjs.
//
// Each app's records are kept here the way the apps keep theirs (switchboard.m.<app>.<coll>: listed whole once a day,
// only what changed since in between), and so is what each app said last (switchboard.m.look), so the card shows at once
// when Switchboard opens, and with no signal shows the last word with its time. Forget, or another ledger's address,
// clears both: the kit's ledger.js drops every switchboard.m.* key then, and clear() here makes a check still running
// for the old ledger write nothing when its answers come back (gen), so the next check starts afresh.
import { APPS } from './kit/tags.js';
import { found } from './kit/find.js';

// The card's order: food going past its best first, then packs, the rental, the shopping list and the totes.
export const ORDER = ['f', 'm', 'h', 'p', 't'];
const DAY = 24 * 3600e3;
export const LOAD_LIMIT = 20000;     // an app's file that hasn't come in 20 s (one bar that never answers) didn't answer
const SAVED = 'switchboard.m.look';
const appOf = l => APPS[l].name.toLowerCase();   // its ledger name: placard, mothball, larder, frostbite, packrat
const failed = (message, kind) => Object.assign(new Error(message), { kind });
const text = v => (v == null ? '' : String(v));
// What an app's file gives, kept to the shapes the page draws (a file from a newer or older release can't break it).
const linesOf = v => (Array.isArray(v) ? v : []).filter(x => x && text(x.text)).map(x => ({ text: text(x.text), href: text(x.href) || './' }));
const thingsOf = v => (Array.isArray(v) ? v : []).filter(x => x && text(x.name)).map(x => ({ name: text(x.name), where: text(x.where), href: text(x.href) || './',
  texts: (Array.isArray(x.texts) ? x.texts : [x.name]).map(text) }));
const tagsOf = v => Object.fromEntries(Object.entries(v && typeof v === 'object' ? v : {}).filter(([, t]) => t && text(t.name)).map(([id, t]) => [id, { name: text(t.name), where: text(t.where) }]));

export class Look {
  // call(body): the ledger's answer to one request (Switchboard's Ledger.call, with its key and its errors' kinds).
  // load(letter, tries): that app's js/attention.js as a module. store: localStorage.
  constructor({ call, load = null, store = globalThis.localStorage, now = () => Date.now(), limit = LOAD_LIMIT }) {
    this.call = call; this.store = store; this.now = now; this.limit = limit;
    this.load = load || ((l, tries) => import(new URL('js/attention.js' + (tries ? `?try=${tries}` : ''), APPS[l].base).href));
    this.tries = {};          // failed loads per app: a module that failed once in this page is asked for at a new address
    this.mods = {};           // the modules that came in
    this.results = this.saved();   // { [letter]: { at, lines, error? } }: the last word, then this page's
    this.running = null;
    this.checkedAt = 0;
    this.gen = 0;             // one up at each clear(): answers to a run from before it are dropped
  }
  get(k) { try { return JSON.parse(this.store.getItem(k) || 'null'); } catch { return null; } }
  set(k, v) { try { this.store.setItem(k, JSON.stringify(v)); } catch {} }
  saved() { const s = this.get(SAVED); return s && typeof s === 'object' ? s : {}; }

  // One collection of one app, brought up to date: its records, deleted ones left out. A ledger with no tab for it
  // (renamed or deleted by hand) says none, and the copy is kept, as the apps keep theirs.
  async read(app, coll, gen = this.gen) {
    const key = `switchboard.m.${app}.${coll}`, mm = this.get(key) || { docs: {}, since: 0 };
    const asked = this.now(), full = asked - (mm.fullAt || 0) > DAY;
    const j = await this.call({ op: 'list', app, coll, since: full ? 0 : mm.since || 0 });
    if (gen !== this.gen) throw failed('another ledger', 'gone');   // Forget, or another ledger, while this was asked
    const docs = Array.isArray(j?.docs) ? j.docs : [];
    if (full && !j.none) mm.docs = {};
    for (const d of docs) {
      if (!d || d.id == null) continue;
      if (d._deleted || d._bad) delete mm.docs[d.id]; else mm.docs[d.id] = d;
    }
    if (full) mm.fullAt = asked;
    mm.since = (j?.time || asked) - 5000;   // overlap: a write in the same moment as the list is fetched again
    this.set(key, mm);
    return Object.values(mm.docs);
  }

  async module(l) {
    if (this.mods[l]) return this.mods[l];
    let t;
    const late = new Promise((_, no) => { t = setTimeout(() => no(failed(`no answer in ${this.limit / 1000} s`, 'app')), this.limit); t?.unref?.(); });
    try {
      const m = await Promise.race([this.load(l, this.tries[l] || 0), late]);
      if (!Array.isArray(m?.COLLS) || typeof m.look !== 'function') throw failed('not an attention file', 'app');
      return (this.mods[l] = m);
    } catch (e) {
      this.tries[l] = (this.tries[l] || 0) + 1;
      throw e.kind ? e : failed(e.message, 'app');
    } finally { clearTimeout(t); }
  }

  // What one app says now: { at, lines }. Its file and its records come together; either failing keeps the last word
  // it said here, with the error (kind: app for its file, else the ledger's: offline, badkey, broken, error).
  // A check from before a clear() writes nothing: neither the copies, the last word kept, nor what the card shows.
  async check(l) {
    const gen = this.gen;
    try {
      const m = await this.module(l), app = appOf(l), docs = {};
      await Promise.all(m.COLLS.map(async c => { docs[c] = await this.read(app, c, gen); }));
      if (gen !== this.gen) return this.results[l];
      const read = c => docs[c] || [], at = this.now();
      const res = this.answer(m, read, new Date(at));
      res.at = at;
      this.results[l] = res;
      const all = this.saved(); all[l] = res; this.set(SAVED, all);
    } catch (e) {
      if (gen !== this.gen) return this.results[l];
      this.results[l] = { ...(this.saved()[l] || {}), error: { kind: e.kind || 'app', message: e.message } };
    }
    return this.results[l];
  }
  // An app's file from before Find anything gives no things (it isn't searched) and no tags (Check a tag says nothing).
  answer(m, read, now) {
    return { lines: linesOf(m.look(read, now)), things: typeof m.things === 'function' ? thingsOf(m.things(read, now)) : [],
      tags: typeof m.tags === 'function' ? tagsOf(m.tags(read)) : null };
  }

  // Every app at once; then(letter) after each answers, so the card fills in as they come. One run at a time, but a run
  // from before a clear() doesn't count: the next checkAll starts a new one.
  checkAll(then = () => {}) {
    if (this.running) return this.running;
    const run = this.running = Promise.all(ORDER.map(l => this.check(l).then(() => then(l))))
      .finally(() => { if (this.running === run) { this.running = null; this.checkedAt = this.now(); } });
    return run;
  }
  // Every app failed the same way before any was asked (the ledger turned the key down when Switchboard opened).
  failAll(e) { for (const l of ORDER) this.results[l] = { ...(this.saved()[l] || {}), error: { kind: e.kind || 'offline', message: e.message } }; }
  // After Forget, or before another ledger's address is saved: nothing kept (ledger.js drops the copies), nothing shown,
  // and a check still running writes nothing.
  clear() { this.gen++; this.running = null; this.results = {}; this.mods = {}; this.tries = {}; }

  // The card: every line, in ORDER; down: the apps whose last check failed; missing: those with nothing to show at all.
  lines() { return ORDER.flatMap(l => (this.results[l]?.lines || []).map(x => ({ ...x, l, href: new URL(x.href, APPS[l].base).href }))); }
  get down() { return ORDER.filter(l => this.results[l]?.error); }
  get missing() { return ORDER.filter(l => !this.results[l]?.at); }
  // Find anything: what every word typed is found in, the kit's way (as each app's own search), each app's in its own
  // order, the apps in ORDER: [{ name, where, href, l }].
  find(q) {
    return ORDER.flatMap(l => (this.results[l]?.things || []).filter(t => found(q, ...t.texts)).map(t => ({ name: t.name, where: t.where, l, href: new URL(t.href, APPS[l].base).href })));
  }
  // Check a tag: what the sticker opening that app at #id is for ({ name, where }), null when the app has no record for it
  // (not set up yet), undefined when it isn't known here (the app hasn't answered, or its file doesn't say).
  named(l, id) { const t = this.results[l]?.tags; return t ? (Object.hasOwn(t, id) ? t[id] : null) : undefined; }
  // When the oldest of the last words shown was said (for 'as of'), or 0.
  oldest(ls = ORDER) { const at = ls.map(l => this.results[l]?.at).filter(Boolean); return at.length ? Math.min(...at) : 0; }
}
