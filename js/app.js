import { $, h, mount, toast, buzz, confirmSheet, qrSvg, loadQr } from './kit/ui.js';
import { APPS, parseTag, resolve, tagUrl } from './kit/tags.js';
import { Ledger, connectLink, watchConnectLinks, readConnectLink } from './kit/ledger.js';
import { readOnce, explainNfc, nfcSupported, cancelNfc } from './kit/nfc.js';
import { nfcPanel } from './kit/panel.js';
import { readOverrides, overridesWork, resolverWorks } from './overrides.js';

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
  $('#ledger-forget').hidden = !ledger.connected;
  $('#way-back').hidden = !ledger.connected;   // where to look in the sheet after a mistake (the guide's Reference has the steps)
  renderApps();
  renderAnother();
}
// The saved address and key in the boxes: at load and after Test and save, never under someone typing a new key.
const fillFields = () => { $('#lurl').value = ledger.cfg.url || ''; $('#lkey').value = ledger.cfg.key || ''; };
// A key changed in the sheet, or a deployment changed, shows as soon as Switchboard opens, not at the next save.
async function checkLedger() {
  if (!ledger.connected) return;
  answer = null; renderLedger();
  try { answer = { version: (await ledger.ping()).version }; } catch (e) { answer = { error: e }; }
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
    ledger.setConfig(url, key); answer = { version: j.version }; fillFields();
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
  ledger.forget(); answer = null; fillFields(); renderLedger();
  toast('Forgotten on this device.');
});

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
window.__switchboard = { ledger, toast };
