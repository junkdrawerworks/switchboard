// The sticker panel every item screen uses: shows the tag link and writes it (and, where asked, locks it).
import { h, buzz, sheet, confirmSheet, dayText } from './ui.js';
import { nfcSupported, writeUrl, lockTag, readOnce, refusedWrite, sameSticker, explainNfc, cancelNfc } from './nfc.js';
import { parseTag } from './tags.js';

// Two links for the same sticker: the same tag (any case, a trailing slash), or the same text.
const sameLink = (a, b) => { const x = parseTag(a), y = parseTag(b); return x && y ? x.letter === y.letter && x.id === y.id : String(a).trim() === String(b).trim(); };
// What another sticker's link opens, in words: the app's own name for one of its stickers (nameOf), or the app and the
// id ("Mothball tote 02"); a link that isn't a tag as it is.
const THINGS = { h: id => id === 'house' || id === 'home' ? 'Placard\'s front page' : `Placard's ${id} page`, t: id => `Mothball tote ${id}`,
  p: id => `Larder's ${id}`, f: id => `Frostbite's ${id}`, m: id => `Packrat pack ${id}`, s: id => id === 'test' ? 'Switchboard\'s test sticker' : `Switchboard's ${id}` };
const opens = (link, nameOf) => { const t = parseTag(link); return !t ? link : nameOf?.(t) || THINGS[t.letter]?.(t.id) || link; };
const HOLD = 'Hold the sticker flat against the back of the phone, near the top, and keep it still.';

// Each sticker's panel state, by its link. A page draws a new panel after a save or a sync, and the new one carries on
// from the old: "Written. Tap it with the phone to check…" stays, a write in progress keeps its Stop button.
const panels = new Map();

// tagged and locked are the days (YYYY-MM-DD) the app saved when this sticker was written and locked. In the sample
// (sample: true) Write still writes a real sticker, which is handy for trying the phone's reader, but Lock is off: it
// can't be undone, and the sample's pages aren't the real ones. move: what the locked line says after its date, how to
// send a locked sticker somewhere else (Switchboard's OVERRIDES unless the app has its own way), which Lock's question
// ends with too. name: what this
// sticker is for, and nameOf({ letter, id }): the app's name for another of its stickers, or nothing, both for what
// the panel says when the sticker held to the phone isn't this one ("This sticker opens Water heater, not Furnace").
// A new sticker written for a locked page is a replacement or a spare, and the panel asks which once it's written
// (when the app gives onSpare): a replacement is saved as written (onWritten, as before: the page reads not locked yet
// until it's locked too, and so is the question closed unanswered); a spare leaves the page locked (onSpare), and
// locking it then is onSpareLocked. spare and spareLocked are the days the last spare was written and locked, said
// under the locked line.
export const MOVE = 'To send it somewhere else, add it to OVERRIDES in Switchboard\'s 404.html.';
export function nfcPanel(url, { label = 'Write sticker', lock = false, onWritten = null, onLocked = null, note = '', tagged = null, locked = null, sample = false, move = MOVE,
  name = 'this page', nameOf = null, spare = null, spareLocked = null, onSpare = null, onSpareLocked = null } = {}) {
  const st = panels.get(url) || { said: ['', ''], busy: '', spare: false };
  panels.set(url, st);
  const msg = st.msg = h('p', { class: 'msg', 'aria-live': 'polite' });
  const say = (t, k = '') => { st.said = [t, k]; st.msg.textContent = t; st.msg.className = 'msg ' + k; };
  const btns = st.btns = h('div', { class: 'btns' });
  const labels = () => st.btns.querySelectorAll('button').forEach(b => { b.textContent = st.busy === b.dataset.what ? 'Stop' : b.dataset.label; });
  // One press: what fn answers ('written', 'same', 'kept', 'locked'), or null when it failed or was stopped (said here).
  // Pressed again while it waits for the sticker, the button stops it.
  const run = async (what, fn) => {
    if (st.busy) { cancelNfc(); return null; }
    st.busy = what; labels();
    say(HOLD, 'wait');
    try { return await fn(); }
    catch (e) { buzz([40, 60, 40]); say(await explainNfc(e, what), e.name === 'AbortError' ? '' : 'bad'); return null; }
    finally { st.busy = ''; labels(); }
  };
  // Write tries first not to write over anything. A sticker that already holds something is read: this link already
  // ('same', nothing written); nothing after all (a blank one turned down anyway: written); or something else, written
  // over only when asked, so the jar or bin next door can't be rewritten by accident while the sticker in the hand stays
  // blank. Chrome lets go of a sticker that turned a write down, and reads it again only once it comes near the phone
  // again, so the panel asks for that. After the question it's read once more, and written over only if it's the one
  // asked about (the sticker that left the phone meanwhile isn't swapped for its neighbour). Locked, the write over
  // fails and says it may be locked.
  const write = async () => {
    try { await writeUrl(url, { overwrite: false }); return 'written'; }
    catch (e) { if (!refusedWrite(e)) throw e; }
    say('This sticker already holds something. Take it off the phone, then hold it there again.', 'wait');
    const held = await readOnce();
    if (held.url && sameLink(held.url, url)) return 'same';
    if (!held.blank) {
      const what = held.url ? `It already opens ${opens(held.url, nameOf)}.` : 'It already holds something that isn\'t a link.';
      if (!await confirmSheet('Write over this sticker?', `${what} Writing over it makes it open ${name} instead. Hold it to the phone again after you press Write over it.`, 'Write over it', { danger: true })) return 'kept';
      say(HOLD, 'wait');
      const again = await readOnce();
      if (!sameSticker(again, held)) throw Object.assign(new Error('That\'s a different sticker from the one you said to write over. Nothing written.'), { name: 'WrongTagError' });
    }
    await writeUrl(url, { overwrite: true });   // the sticker just read: Chrome still has it
    return 'written';
  };
  btns.append(h('button', { type: 'button', class: 'btn', 'data-what': 'write', 'data-label': label, onclick: async () => {
    const r = await run('write', write);
    if (r === 'written') {
      buzz(80); say(lock && !sample ? 'Written. Tap it with the phone to check, then lock it.' : 'Written. Tap it with the phone to check it opens this page.', 'ok');
      if (!(locked && onSpare)) { onWritten?.(); return; }
      // closed without an answer (Escape, Back), it counts as a replacement: the page reads not locked yet until a
      // sticker is locked, which is safe either way (a spare locked turns it green too), where a spare would leave the
      // page green while an unlocked sticker might be on the wall
      const v = await sheet({ title: 'Replacing the one on the wall, or a spare to keep?', ok: 'A spare to keep', other: 'Replacing it', cancel: null,
        body: h('p', {}, 'Replacing it: this page reads written, not locked yet, until you lock the new one. A spare: the page stays locked, and the spare is noted under it.') });
      if (!v || v.__other) onWritten?.(); else onSpare();
    }
    // a sticker already holding the link is written as far as anyone can tell: saved as written if it wasn't yet
    else if (r === 'same') { buzz(80); say('Already holds this link.', 'ok'); if (!tagged && !locked) onWritten?.(); }
    else if (r === 'kept') say('Nothing written. The sticker keeps its old link.');
  } }, label));
  // Lock reads the sticker first and locks only one that holds this link: locking can't be undone, and a sticker locked
  // on the wrong system would open the wrong page for good.
  const refuse = got => got.url && sameLink(got.url, url) ? '' : got.url ? `This sticker opens ${opens(got.url, nameOf)}, not ${name}. Nothing was locked.`
    : got.blank ? 'This sticker is blank. Write it first, then lock it.' : `This sticker doesn't hold the link for ${name}. Nothing was locked.`;
  if (lock) btns.append(h('button', { type: 'button', class: 'btn ghost', 'data-what': 'lock', 'data-label': 'Lock sticker', disabled: sample, onclick: async () => {
    if (sample) return;
    if (!st.busy && !await confirmSheet('Lock this sticker?', `Locking is permanent: nobody can rewrite it, you included. Do it only after a tap opens the right page. ${move}`, 'Lock it', { danger: true })) return;
    if (await run('lock', () => lockTag({ check: refuse }).then(() => 'locked')) !== 'locked') return;
    // the page was locked already: this is another sticker for it, a spare (a replacement was saved as written first)
    buzz(80); say('Locked. It will open this page for good.', 'ok'); st.spare = false;
    if (locked && onSpareLocked) onSpareLocked(); else onLocked?.();
  } }, 'Lock sticker'));
  labels();
  if (!nfcSupported()) {
    btns.querySelectorAll('button').forEach(b => { b.disabled = true; });
    say('Writing stickers needs Chrome on an Android phone. Any NFC writer app can write the link above instead.', 'wait');
  } else say(...st.said);
  // A locked sticker can't be written again, so Write and Lock wait behind "Replace or make a spare": a new blank
  // sticker for the same page (the app saves it as written, not locked, until that one is locked too).
  const state = locked ? `Locked ${dayText(locked)}. ${move}`
    : tagged ? `Written ${dayText(tagged)}${lock ? ', not locked yet' : ''}.` : lock ? 'Not written yet.' : '';
  const another = h('div', {}, h('p', { class: 'msg' }, 'Use a new blank sticker. The old one, wherever it is, keeps opening this page.'), btns);
  const hidden = locked && !st.spare && !st.busy;
  const more = hidden ? h('div', { class: 'btns' }, h('button', { type: 'button', class: 'btn ghost', onclick: () => { st.spare = true; more.replaceWith(another); say(''); } }, 'Replace or make a spare')) : null;
  return h('div', { class: 'nfc' },
    h('span', { class: 'tape-cap' }, 'Sticker'),
    h('code', { class: 'url' }, url),
    state ? h('p', { class: 'msg state' }, state) : null,
    spare ? h('p', { class: 'msg spare' }, spareLocked ? `Spare locked ${dayText(spareLocked)}.` : `Spare written ${dayText(spare)}.`) : null,
    note ? h('p', { class: 'msg' }, note) : null,
    sample ? h('p', { class: 'msg sample' }, 'This writes a real sticker with the sample\'s link.') : null,
    sample && lock ? h('p', { class: 'msg sample' }, 'Locking is off in the sample: it can\'t be undone.') : null,
    locked ? (hidden ? more : another) : btns,
    msg);
}
