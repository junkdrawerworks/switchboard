import { $, h, mount, toast, buzz, confirmSheet, qrSvg, loadQr, stampText } from './kit/ui.js';
import { APPS, parseTag, resolve, tagUrl } from './kit/tags.js';
import { Ledger, connectLink, watchConnectLinks, readConnectLink } from './kit/ledger.js';
import { readOnce, explainNfc, nfcSupported, cancelNfc } from './kit/nfc.js';
import { nfcPanel } from './kit/panel.js';
import { readOverrides, overridesWork, resolverWorks } from './overrides.js';
import { Look } from './look.js';

// Switchboard's own connect link (Another device, scanned on a second phone or tablet) sets up its ledger here as each
// app's does there: taken before the ledger is made, and the key isn't left in the address. Switchboard is where every
// app's Connect comes from, so a link for another ledger than the one saved here (anyone can make one) asks first, and
// Cancel keeps the saved one; with none saved, or the same one, it's taken at once, as before. Yes puts the link back
// in the address for the kit to take, which reloads the page on the new ledger.
let allowed = '';
const idOf = u => u.replace(/\/(exec|dev)\/?$/, '').slice(-6);   // the end of the deployment's id, before /exec
function askFirst() {
  const c = readConnectLink(location.hash), hash = location.hash;
  if (!c) return;                                 // no link, or one that doesn't read (the kit says so)
  if (hash === allowed) { allowed = ''; return; }
  let old = null;
  try { old = JSON.parse(localStorage.getItem('switchboard.ledger') || 'null'); } catch {}
  if (!old?.url || !old.key || (old.url === c.url && old.key === c.key)) return;
  history.replaceState(null, '', location.pathname + location.search);
  const text = old.url === c.url
    ? `This link has another key for the ledger saved here (…${idOf(c.url)}). Use it only if you ran setup again: with the wrong key, nothing saves.`
    : `This link sets Switchboard to a different ledger (…${idOf(c.url)}). The one saved here (…${idOf(old.url)}) is forgotten on this device, and each app follows the new one when you press Connect.`;
  confirmSheet('Use this ledger instead?', text, 'Use it', { danger: true }).then(yes => { if (yes) { allowed = hash; location.hash = hash; } });
}
addEventListener('hashchange', askFirst);         // before the kit's own, so it sees the address first
askFirst();
watchConnectLinks('switchboard', toast);
const ledger = new Ledger('switchboard');
const appOrder = ['h', 't', 'p', 'f', 'm'];
const blurb = { h: 'The rental house manual', t: 'Seasonal totes', p: 'Consumables and spices', f: 'The freezer', m: 'Makita packs' };

if (location.hash === '#test') { $('#test-ok').hidden = false; history.replaceState(null, '', location.pathname); }

// ---- setup
// Once connected, Switchboard opens on Needs a look, and the ledger, Connect, the test sticker and the letters fold
// under Setup (which takes the key off the first screen). Not connected, Setup is open: it's all there is to do. A link
// to one of its cards (each app's Open Switchboard goes to #apps) opens it there, and so does a ledger that needs
// something done (a key it turned down, an older script).
const setup = $('#setup');
setup.open = !ledger.connected;
function openSetupFor(hash = location.hash) {
  const el = /^#[a-z][\w-]*$/.test(hash) ? document.getElementById(hash.slice(1)) : null;
  if (el && el !== setup && setup.contains(el)) { setup.open = true; el.scrollIntoView(); }
}
openSetupFor();
addEventListener('hashchange', () => openSetupFor());

// ---- check a tag
// Where a sticker goes is what the resolver says: its OVERRIDES, read from 404.html (this site's own; with no signal the
// worker's copy), then the app the letter belongs to. overridesOk is false when OVERRIDES's own script has a mistake in
// it: then no sticker is sent elsewhere, and each opens its app's page. ok is false when the resolver's script won't run
// at all: then no tap goes anywhere. Not known (not fetched): as before.
const overrides = fetch('404.html').then(r => r.ok ? r.text() : Promise.reject(new Error(r.status)))
  .then(t => ({ map: readOverrides(t), ok: resolverWorks(t), overridesOk: overridesWork(t) })).catch(() => ({ map: {}, ok: true, overridesOk: true }));
const BROKEN = '404.html has a mistake in it, so no sticker opens anything: every tap stops on "This tag isn\'t set up". Undo the last change to 404.html on GitHub.';
const NOT_SENT = 'OVERRIDES in 404.html has a mistake in it, so no sticker is sent elsewhere: each opens its own app\'s page. Undo the last change to 404.html on GitHub.';
// Each press is one read. While it listens the button says Stop, and a press stops it. A read that Stop (or a newer
// press) ended says nothing more, so its "Stopped." can't land on top of the next press's "Listening" line.
let reading = 0, presses = 0;
const checkBtn = $('#check-btn');
const idle = () => { reading = 0; checkBtn.textContent = 'Check a tag'; };
checkBtn.addEventListener('click', async () => {
  const msg = $('#check-msg'), out = $('#check-out');
  if (!nfcSupported()) { msg.textContent = 'Reading tags here needs Chrome on an Android phone.'; msg.className = 'msg bad'; return; }
  if (reading) { idle(); cancelNfc(); msg.textContent = 'Stopped.'; msg.className = 'msg'; return; }
  const me = reading = ++presses;
  checkBtn.textContent = 'Stop';
  msg.textContent = 'Listening. Hold the sticker flat against the back of the phone, near the top.'; msg.className = 'msg wait'; out.hidden = true;
  try {
    const { url, serial } = await readOnce();
    const { map: sent, ok, overridesOk } = await overrides;
    if (reading !== me) return;
    idle(); buzz(50);
    const t = parseTag(url);
    msg.textContent = ''; out.hidden = false;
    if (!url) mount(out, h('p', {}, 'That sticker is blank.'), h('p', { class: 'muted mono' }, serial));
    else if (!t) mount(out, h('p', {}, 'Not a Switchboard tag. It holds:'), h('code', { class: 'url' }, url));
    else {
      const to = ok ? resolve(t.letter, t.id, sent) : null;
      mount(out,
        h('div', { class: 'tape-wrap' }, h('span', { class: 'tape-cap' }, `${t.letter} / ${APPS[t.letter]?.name || 'no app'}`), h('div', { class: 'tape' }, t.id)),
        to ? named(to) : null,
        !ok ? h('p', { class: 'msg bad' }, BROKEN) : to ? h('p', {}, 'Goes to ', h('code', {}, to)) : h('p', {}, 'No app owns this letter.'),
        ok && !overridesOk ? h('p', { class: 'msg bad' }, NOT_SENT) : null,
        ok && sent[`${t.letter}/${t.id}`] ? h('p', { class: 'muted' }, 'Sent here by OVERRIDES in 404.html.') : null,
        to ? h('div', { class: 'btns' }, h('a', { class: 'btn', href: to }, 'Open')) : null);
    }
  } catch (e) {
    if (reading !== me) return;
    idle();
    const text = await explainNfc(e, 'read');
    if (reading) return; // pressed again while that was worked out
    msg.textContent = text; msg.className = 'msg ' + (e.name === 'AbortError' ? '' : 'bad');
  }
});

// ---- ledger
// What the ledger said when this page last asked (on open, and at Test and save): { version }, or { error } with the
// kit's e.kind: badkey, broken (a sign-in or error page instead of the ledger), offline or error (the ledger said no).
let answer = null;
// The ledger script these apps need: ledger/Code.gs's VERSION (test/ledger.test.mjs checks the two match). An older one
// still answers, but the sheet it writes turns tote and pack numbers 01 to 09 into 1 to 9, so it's amber, not green.
const WANT = '1.1';
const older = v => {
  const a = String(v).split('.').map(Number), b = WANT.split('.').map(Number);
  for (let i = 0; i < b.length; i++) if ((a[i] || 0) !== b[i]) return (a[i] || 0) < b[i];
  return false;
};
const OLD_FIX = 'Paste ledger/Code.gs from Switchboard\'s repo over it, Save, then Deploy, Manage deployments, the pencil, Version: New version, Deploy. Until then don\'t save totes or packs numbered 01 to 09.';
const stateLine = e => ({ badkey: 'Wrong key — copy B2 from the sheet\'s About tab again', broken: 'The ledger isn\'t answering — check the deployment',
  error: `The ledger said no (${e.message})` })[e.kind] || 'Offline — can\'t reach the ledger';
const failText = e => ({ badkey: 'The address answered, but the key is wrong. Copy it again from the About tab, cell B2.',
  broken: 'Google answered with a sign-in or error page instead of the ledger. Check the address is the web app\'s (it ends /exec) and the deployment is set to "Anyone", then try again.',
  error: `The ledger said no (${e.message}).` })[e.kind] || 'Google didn\'t answer. Check the phone is online, then try again.';
function renderLedger() {
  const st = $('#ledger-state');
  const [k, text] = !ledger.connected ? ['unset', 'Not connected to the ledger'] : !answer ? ['pending', 'Checking the ledger…']
    : answer.version && older(answer.version) ? ['pending', `Ledger script v${answer.version} is older than these apps need (v${WANT})`]
    : answer.version ? ['synced', `Connected to ledger v${answer.version}`] : [answer.error.kind || 'offline', stateLine(answer.error)];
  st.className = 'sync ' + k; st.textContent = text;
  const folded = $('#setup-state'); folded.className = st.className; folded.textContent = text;   // seen with Setup folded too
  if (!ledger.connected || answer?.error?.kind === 'badkey' || (answer?.version && older(answer.version))) setup.open = true;
  $('#ledger-forget').hidden = !ledger.connected;
  $('#way-back').hidden = !ledger.connected;   // where to look in the sheet after a mistake (the guide's Reference has the steps)
  renderApps();
  renderAnother();
  renderLook();
}
// The saved address and key in the boxes: at load and after Test and save, never under someone typing a new key.
const fillFields = () => { $('#lurl').value = ledger.cfg.url || ''; $('#lkey').value = ledger.cfg.key || ''; };
// A key changed in the sheet, or a deployment changed, shows as soon as Switchboard opens, not at the next save.
async function checkLedger() {
  if (!ledger.connected) return;
  answer = null; renderLedger();
  try { answer = { version: (await ledger.ping()).version }; } catch (e) { answer = { error: e }; }
  if (answer.version) checkApps(); else { look.failAll(answer.error); asked = true; }   // the lists would fail the same way
  renderLedger();
}
$('#ledger-form').addEventListener('submit', async e => {
  e.preventDefault();
  const url = $('#lurl').value.trim(), key = $('#lkey').value.trim();
  const msg = $('#ledger-msg');
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(url)) { msg.textContent = 'That doesn\'t look like a web app address. It starts https://script.google.com/macros/s/ and ends /exec.'; msg.className = 'msg bad'; return; }
  msg.textContent = 'Testing…'; msg.className = 'msg wait';
  const trial = new Ledger('switchboard-trial');
  trial.cfg = { url, key };
  try {
    const j = await trial.ping();
    if (url !== ledger.cfg.url) look.clear();   // another sheet: nothing the old one said stays on the card
    ledger.setConfig(url, key); answer = { version: j.version }; fillFields(); checkApps();
    if (older(j.version)) { msg.textContent = `Connected, but the script is v${j.version}. ${OLD_FIX}`; msg.className = 'msg wait'; }
    else { msg.textContent = `Connected to ledger v${j.version}.`; msg.className = 'msg ok'; buzz(60); }
  } catch (err) {
    msg.className = 'msg bad'; msg.textContent = failText(err);
  }
  renderLedger();
});
// Forget asks first: setting it up again on a phone means finding the web app address in Apps Script and the key in the
// sheet. The apps keep their own connection.
$('#ledger-forget').addEventListener('click', async () => {
  if (!await confirmSheet('Forget the ledger on this device?', 'Switchboard stops offering Connect here. The apps stay connected. To set it up again you need the web app address and the key from the sheet\'s About tab.', 'Forget', { danger: true })) return;
  ledger.forget(); look.clear(); answer = null; fillFields(); renderLedger();
  toast('Forgotten on this device.');
});

// ---- needs a look
// One card of what's due across the apps, each line a link into its app: each app's own rules (its js/attention.js,
// imported from its address) over its records, read here from the ledger (look.js). The card shows the last word at
// once, then each app's answer as it comes; with no signal, or an app that doesn't answer, the last word stays, with
// its time. It's asked again when Switchboard is opened, and when it comes back to the front after a minute or more.
const look = new Look({ call: body => ledger.call(body) });
let asked = false;   // a check has been started in this page, or the ledger has said why not
const names = ls => { const n = ls.map(l => APPS[l].name); return n.length > 1 ? `${n.slice(0, -1).join(', ')} and ${n.at(-1)}` : n[0]; };
function checkApps() {
  asked = true;
  look.checkAll(() => renderLook()).then(() => renderLook());
  renderLook();
}
function renderLook() {
  $('#look').hidden = !ledger.connected;
  renderFind();
  if (!ledger.connected) return;
  const st = $('#look-state'), down = look.down, lines = look.lines();
  // what went wrong, short, and how old the last word shown is: 'Offline — as of Nov 27, 9:14 am', 'Packrat didn't answer'
  const asOf = ls => { const t = look.oldest(ls); return t ? ` — as of ${stampText(t)}` : ''; };
  const e = down.length ? look.results[down[0]].error : null;
  const why = e && ({ app: `${names(down)} didn't answer`, badkey: 'Wrong key', broken: 'The ledger isn\'t answering', error: 'The ledger said no' }[e.kind] || 'Offline');
  const [k, text] = look.running || !asked ? ['pending', 'Checking the apps…'] : !e ? ['synced', 'Up to date']
    : [e.kind === 'app' ? 'offline' : e.kind, why + asOf(down)];
  st.className = 'sync ' + k; st.textContent = text;
  // each line's label ('Freezer:') in bold; nothing to say once every app has had its say, now or last time
  mount($('#look-list'), lines.length ? lines.map(x => {
    const [, label, rest] = /^([^:]{1,24}:)?\s*(.*)$/s.exec(x.text);
    return h('li', {}, h('a', { class: 'row', href: x.href }, h('span', { class: 'main' }, h('span', { class: 't' }, label ? [h('b', {}, label), ' ', rest] : rest)), h('span', { class: 'meta', 'aria-hidden': 'true' }, '›')));
  }) : look.missing.length ? [] : h('li', { class: 'empty' }, 'Nothing needs a look.'));
}
const again = () => { if (ledger.connected && !look.running && Date.now() - look.checkedAt > 60000) checkLedger(); };
document.addEventListener('visibilitychange', () => { if (!document.hidden) again(); });
addEventListener('online', again);

// ---- find anything
// One box over every app: what each app's own search looks through (its attention file's things), matched the kit's
// way (find.js, as Larder's, Frostbite's and Mothball's boxes), each result naming its app and place and opening it
// there. It searches what each app said last, so it works with no signal too.
let query = '';
const SHOW = 40;
function renderFind() {
  $('#find').hidden = !ledger.connected;
  const list = $('#find-list'), q = query.trim();
  list.hidden = !q || !ledger.connected;
  if (list.hidden) { list.replaceChildren(); return; }
  const hits = look.find(q), missing = look.missing;
  const not = missing.length ? ` ${names(missing)} ${missing.length > 1 ? 'haven\'t' : 'hasn\'t'} answered yet.` : '';
  mount(list, hits.length ? hits.slice(0, SHOW).map(x => h('li', {}, h('a', { class: 'row', href: x.href },
    h('span', { class: 'main' }, h('span', { class: 't' }, x.name), h('span', { class: 's' }, [APPS[x.l].name, x.where].filter(Boolean).join(' \u00b7 ')))))) : h('li', { class: 'empty' }, `No "${q}" in any app.${not}`),
    hits.length > SHOW ? h('li', { class: 'empty' }, `and ${hits.length - SHOW} more: add a word to narrow it`) : null);
}
$('#find-q').addEventListener('input', e => { query = e.target.value; renderFind(); });
// Check a tag, once connected: what the sticker is for, as the app it opens has it ('Cumin, ground · Spice drawer'), or
// that the app has no record for it yet. Where it goes decides (OVERRIDES included); not an app's page, or an app that
// hasn't answered here: nothing.
function named(to) {
  if (!ledger.connected) return null;
  const l = Object.keys(APPS).find(k => k !== 's' && to.startsWith(APPS[k].base + '#')), id = l ? to.slice(APPS[l].base.length + 1) : '';
  const it = l && /^[a-z0-9][a-z0-9-]{0,39}$/.test(id) ? look.named(l, id) : undefined;
  if (it === undefined) return null;
  return it ? h('p', { class: 'named' }, h('b', {}, it.name), it.where ? ` \u00b7 ${it.where}` : '') : h('p', { class: 'muted named' }, `Not set up in ${APPS[l].name} yet.`);
}

// ---- another device
// Switchboard's own connect link as a QR code: the other phone or tablet's camera opens it, its Switchboard is set up
// with the address and key (watchConnectLinks), and each app is connected from there as here. The code carries the
// key, so it's drawn only when asked, and goes when hidden, when this page is left, and when the ledger is forgotten
// or its key turned down.
let showing = false;
async function renderAnother() {
  const can = ledger.connected && answer?.error?.kind !== 'badkey';
  if (!can) showing = false;
  $('#another').hidden = !can;
  const btn = $('#another-btn'), box = $('#another-qr');
  btn.textContent = showing ? 'Hide the code' : 'Another device';
  btn.setAttribute('aria-expanded', String(showing));
  $('#another-code').hidden = !showing;
  if (!showing) { box.replaceChildren(); delete box.dataset.url; return; }
  const link = connectLink(APPS.s.base, ledger.cfg.url, ledger.cfg.key);
  if (box.dataset.url === link) return;
  try { await loadQr(); } catch { mount(box, h('p', { class: 'msg bad' }, 'The code didn\'t load. Reload the page to try again.')); return; }
  if (!showing || !ledger.connected) return;
  box.dataset.url = link;
  box.innerHTML = qrSvg(link, { size: 260, margin: 4 });
}
$('#another-btn').addEventListener('click', () => { showing = !showing; renderAnother(); });
document.addEventListener('visibilitychange', () => { if (document.hidden && showing) { showing = false; renderAnother(); } });

// A key the ledger turned down when Switchboard opened (setup run again in the sheet) would go to each app in its Connect
// link and be turned down there too, so the rows wait for the new one instead.
function renderApps() {
  const list = $('#app-list'), stale = ledger.connected && answer?.error?.kind === 'badkey';
  const said = $('#apps-msg');
  said.textContent = stale ? 'The key here is out of date. Paste the new one from the sheet\'s About tab (B2), then Test and save.' : '';
  said.hidden = !stale;
  mount(list, appOrder.map(l => {
    const a = APPS[l];
    const link = ledger.connected && !stale ? connectLink(a.base, ledger.cfg.url, ledger.cfg.key) : null;
    return h('li', {}, h('div', { class: 'row' },
      h('span', { class: 'chip acc' }, l),
      h('span', { class: 'main' }, h('span', { class: 't' }, a.name), h('span', { class: 's' }, blurb[l])),
      link ? h('a', { class: 'btn', href: link, target: '_blank', rel: 'noopener' }, 'Connect') : h('span', { class: 'meta' }, stale ? 'fix the key first' : 'ledger first')));
  }));
}

// ---- test sticker and letters
mount($('#test-panel'), nfcPanel(tagUrl('s', 'test'), { label: 'Write test sticker' }));
// Each address may break after a dot (placard. / junkdrawer.works), so the table fits a phone instead of cutting it off.
const host = base => base.replace(/^https:\/\/|\/$/g, '').split(/(?<=\.)/).flatMap((part, i) => (i ? [h('wbr'), part] : [part]));
mount($('#route-rows'), Object.entries(APPS).map(([l, a]) => h('tr', {}, h('td', { class: 'm' }, l), h('td', {}, a.name), h('td', { class: 'm' }, host(a.base)))));

ledger.on(renderLedger);
fillFields();
renderLedger();
checkLedger();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
window.__switchboard = { ledger, toast, look };
