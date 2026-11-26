import { $, h, mount, toast, buzz } from './kit/ui.js';
import { APPS, parseTag, resolve, tagUrl } from './kit/tags.js';
import { Ledger, connectLink } from './kit/ledger.js';
import { readOnce, explainNfc, nfcSupported } from './kit/nfc.js';
import { nfcPanel } from './kit/panel.js';

const ledger = new Ledger('switchboard');
const appOrder = ['h', 't', 'p', 'f', 'm'];
const blurb = { h: 'The rental house manual', t: 'Seasonal totes', p: 'Consumables and spices', f: 'The freezer', m: 'Makita packs' };

if (location.hash === '#test') { $('#test-ok').hidden = false; history.replaceState(null, '', location.pathname); }

// ---- check a tag
$('#check-btn').addEventListener('click', async () => {
  const msg = $('#check-msg'), out = $('#check-out');
  if (!nfcSupported()) { msg.textContent = 'Reading tags here needs Chrome on an Android phone.'; msg.className = 'msg bad'; return; }
  msg.textContent = 'Listening. Hold a tag to the top of the phone.'; msg.className = 'msg wait'; out.hidden = true;
  try {
    const { url, serial } = await readOnce();
    buzz(50);
    const t = parseTag(url);
    msg.textContent = ''; out.hidden = false;
    if (!url) mount(out, h('p', {}, 'That sticker is blank.'), h('p', { class: 'muted mono' }, serial));
    else if (!t) mount(out, h('p', {}, 'Not a Switchboard tag. It holds:'), h('code', { class: 'url' }, url));
    else {
      const to = resolve(t.letter, t.id);
      mount(out,
        h('div', { class: 'tape-wrap' }, h('span', { class: 'tape-cap' }, `${t.letter} / ${APPS[t.letter]?.name || 'no app'}`), h('div', { class: 'tape' }, t.id)),
        to ? h('p', {}, 'Goes to ', h('code', {}, to)) : h('p', {}, 'No app owns this letter.'),
        to ? h('div', { class: 'btns' }, h('a', { class: 'btn', href: to }, 'Open')) : null);
    }
  } catch (e) { msg.textContent = await explainNfc(e, 'read'); msg.className = 'msg ' + (e.name === 'AbortError' ? '' : 'bad'); }
});

// ---- ledger
function renderLedger() {
  const st = $('#ledger-state');
  st.className = 'sync ' + ledger.state; st.textContent = ledger.statusText();
  if (ledger.cfg.url) { $('#lurl').value = ledger.cfg.url; $('#lkey').value = ledger.cfg.key; }
  $('#ledger-forget').hidden = !ledger.connected;
  renderApps();
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
    ledger.setConfig(url, key);
    msg.textContent = `Connected to ledger v${j.version}.`; msg.className = 'msg ok'; buzz(60);
  } catch (err) {
    msg.className = 'msg bad';
    msg.textContent = /bad key/.test(err.message) ? 'The address answered, but the key is wrong. Copy it again from the About tab, cell B2.'
      : `The ledger didn't answer (${err.message}). Check the deployment is set to "Anyone", then try again.`;
  }
  renderLedger();
});
$('#ledger-forget').addEventListener('click', () => { ledger.forget(); $('#lurl').value = ''; $('#lkey').value = ''; renderLedger(); });

function renderApps() {
  const list = $('#app-list');
  mount(list, appOrder.map(l => {
    const a = APPS[l];
    const link = ledger.connected ? connectLink(a.base, ledger.cfg.url, ledger.cfg.key) : null;
    return h('li', {}, h('div', { class: 'row' },
      h('span', { class: 'chip acc' }, l),
      h('span', { class: 'main' }, h('span', { class: 't' }, a.name), h('span', { class: 's' }, blurb[l])),
      link ? h('a', { class: 'btn', href: link, target: '_blank', rel: 'noopener' }, 'Connect') : h('span', { class: 'meta' }, 'ledger first')));
  }));
}

// ---- test sticker and letters
mount($('#test-panel'), nfcPanel(tagUrl('s', 'test'), { label: 'Write test sticker' }));
mount($('#route-rows'), Object.entries(APPS).map(([l, a]) => h('tr', {}, h('td', { class: 'm' }, l), h('td', {}, a.name), h('td', { class: 'm' }, a.base.replace('https://', '')))));

ledger.on(renderLedger);
renderLedger();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
window.__switchboard = { ledger, toast };
