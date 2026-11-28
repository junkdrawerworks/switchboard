// Writing and reading stickers with Chrome's Web NFC (Android only, on a page that is the whole tab).
export const nfcSupported = () => typeof window !== 'undefined' && 'NDEFReader' in window;

let active = null; // one NFC job at a time: a new one cancels the last

function job() {
  active?.abort();
  active = new AbortController();
  return active;
}
export function cancelNfc() { active?.abort(); active = null; }

// Writes one link. overwrite:false leaves a sticker that already holds records alone: the write is turned down with a
// NotAllowedError (MDN, NDEFReader.write()). Whether Chrome counts a factory-blank sticker as holding any isn't checked
// on a real one, so the panel reads a sticker turned down and writes a blank one without asking.
export async function writeUrl(url, { overwrite = true } = {}) {
  const ctl = job();
  try {
    await new NDEFReader().write({ records: [{ recordType: 'url', data: url }] }, { overwrite, signal: ctl.signal });
  } finally { if (active === ctl) active = null; }
}

// Makes the sticker read-only, for good. Chrome 100+; the tag stays readable by any phone. check(sticker), when given,
// reads the sticker first ({ serial, url, blank }, as readOnce) and returns why it mustn't be locked ('' to go on): the
// lock is then made on the same sticker, still against the phone, and a refusal throws a WrongTagError carrying the
// reason, with nothing locked.
export async function lockTag({ check = null, timeout = 30000 } = {}) {
  const ctl = job();
  let scan = null;
  try {
    const r = new NDEFReader();
    if (typeof r.makeReadOnly !== 'function') throw Object.assign(new Error('This Chrome can\'t lock tags.'), { name: 'NotSupportedError' });
    if (check) {
      const got = await readOn(r, ctl, timeout, true);
      scan = got.scan;
      const why = check(got.sticker);
      if (why) throw Object.assign(new Error(why), { name: 'WrongTagError' });
    }
    await r.makeReadOnly({ signal: ctl.signal });
  } finally { scan?.abort(); if (active === ctl) active = null; }
}

// Waits for one sticker and returns { serial, url, blank } (url is the first link record, or ''; blank: no record but
// Chrome's 'empty' one, as on a factory-blank sticker). It settles once: a sticker read, no sticker in time
// (TimeoutError), or stopped by cancelNfc() or a newer NFC job (AbortError).
export async function readOnce({ timeout = 30000 } = {}) {
  const ctl = job();
  try { return (await readOn(new NDEFReader(), ctl, timeout, false)).sticker; }
  finally { if (active === ctl) active = null; }
}

// The read under readOnce and lockTag: reader r scans with a controller of its own, stopped with the job's (Stop, a
// newer job, the timeout) and, unless keep, as soon as a sticker is read. keep leaves it listening for the lock that
// follows, so Chrome stays on the sticker held to the phone; the caller stops it (scan). Aborting the scan after a read
// fires the abort listener at once, so the read must settle first.
async function readOn(r, ctl, timeout, keep) {
  const scan = new AbortController();
  const stopped = () => Object.assign(new Error('stopped'), { name: 'AbortError' });
  ctl.signal.addEventListener('abort', () => scan.abort());
  try {
    await r.scan({ signal: scan.signal });
    if (ctl.signal.aborted) throw stopped(); // stopped while the scan was starting: the abort event has been and gone
    const sticker = await new Promise((resolve, reject) => {
      let done = false;
      const settle = (fn, v) => { if (done) return; done = true; clearTimeout(t); fn(v); };
      const t = setTimeout(() => { settle(reject, Object.assign(new Error('No tag within the time'), { name: 'TimeoutError' })); scan.abort(); }, timeout);
      ctl.signal.addEventListener('abort', () => settle(reject, stopped()));
      r.onreading = ev => {
        let url = '';
        const recs = [...(ev.message?.records || [])];
        for (const rec of recs) {
          if (rec.recordType === 'url' || rec.recordType === 'absolute-url') { url = new TextDecoder().decode(rec.data); break; }
        }
        settle(resolve, { serial: ev.serialNumber || '', url, blank: recs.every(rec => rec.recordType === 'empty') });
        if (!keep) scan.abort(); // stop listening
      };
      r.onreadingerror = () => {}; // a blank or unreadable tag: keep listening
    });
    return { sticker, scan };
  } catch (e) { scan.abort(); throw e; }
}

// A write turned down because the sticker already holds something (overwrite:false), or because it's locked: Chrome
// says NotAllowedError for both. Not one turned down for NFC permission or a missing tap on the button.
export const refusedWrite = e => e?.name === 'NotAllowedError' && !/activation|gesture|permission/i.test(e.message || '');

// What went wrong, in one plain line. The NFC switch is where Google's Pixel Help puts it
// (support.google.com/pixelphone/answer/7475639); that page doesn't say where the reader is: on a Pixel it's on the back.
export async function explainNfc(e, what = 'write') {
  let perm = '';
  try { perm = (await navigator.permissions.query({ name: 'nfc' })).state; } catch {}
  if (e.name === 'AbortError') return 'Stopped.';
  if (e.name === 'TimeoutError') return 'No sticker came near the phone. Press the button and try again.';
  if (e.name === 'WrongTagError') return e.message;
  if (perm === 'denied') return 'NFC is blocked for this site. Allow it in Chrome: the icon left of the address → Permissions → NFC.';
  if (e.name === 'NotAllowedError' && /activation|gesture/i.test(e.message)) return 'Chrome wants a fresh tap. Press the button again.';
  if (e.name === 'NotAllowedError' && /permission/i.test(e.message)) return 'NFC isn\'t allowed for this site yet. Press the button and allow it when Chrome asks.';
  if (e.name === 'NotAllowedError' && what === 'write') return 'That sticker is locked. Use a blank one.';
  if (e.name === 'NotReadableError') return 'NFC looks switched off. Turn it on in the phone\'s settings (Connected devices → Connection preferences → NFC).';
  if (e.name === 'NotSupportedError' && /NFC is not supported|unavailable/i.test(e.message)) return 'This phone or browser can\'t use NFC. Use Chrome on the Android phone.';
  if (e.name === 'NotSupportedError') return what === 'lock' ? 'This sticker can\'t be locked, or this Chrome can\'t lock it.' : 'That tag isn\'t one Chrome can write. NTAG213/215/216 stickers work.';
  return `Couldn't ${what} the sticker (${e.message || e.name}). Hold it flat against the back of the phone, near the top, and keep it still.`;
}
