// The kit's Web NFC reader (js/kit/nfc.js) with a pretend NDEFReader, without a browser.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// A pretend Chrome reader: scan() starts listening (and stops when its signal aborts), tap() delivers a sticker.
let readers = [];
globalThis.window = globalThis;
globalThis.NDEFReader = class {
  async scan({ signal } = {}) {
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    this.signal = signal; this.listening = true; readers.push(this);
    signal?.addEventListener('abort', () => { this.listening = false; });
  }
};
const enc = s => new TextEncoder().encode(s);
const tap = (records, serial = '04:a2:19:7c') => {
  const r = readers.filter(x => x.listening).at(-1);
  assert.ok(r, 'nothing is listening');
  r.onreading?.({ serialNumber: serial, message: { records } });
};
const tick = () => new Promise(r => setTimeout(r, 0));
const { readOnce, cancelNfc, explainNfc } = await import('../js/kit/nfc.js');
beforeEach(() => { cancelNfc(); readers = []; });

test('a sticker held to the phone is read, and the reader stops listening', async () => {
  const p = readOnce({ timeout: 2000 });
  await tick();
  tap([{ recordType: 'url', data: enc('https://tag.junkdrawer.works/s/test') }]);
  assert.deepEqual(await p, { serial: '04:a2:19:7c', url: 'https://tag.junkdrawer.works/s/test' });
  assert.equal(readers[0].listening, false, 'still scanning after the read');
});

test('a blank sticker reads as no link, and a sticker with text first finds its link', async () => {
  let p = readOnce({ timeout: 2000 });
  await tick(); tap([]);
  assert.deepEqual(await p, { serial: '04:a2:19:7c', url: '' });
  p = readOnce({ timeout: 2000 });
  await tick(); tap([{ recordType: 'text', data: enc('hello') }, { recordType: 'absolute-url', data: enc('https://example.com/') }]);
  assert.equal((await p).url, 'https://example.com/');
});

test('no sticker in time ends as a timeout, not as stopped', async () => {
  await assert.rejects(readOnce({ timeout: 30 }), { name: 'TimeoutError' });
  assert.equal(readers[0].listening, false);
});

test('Stop ends a read as stopped, and a new read replaces the one before it', async () => {
  let p = readOnce({ timeout: 2000 });
  await tick(); cancelNfc();
  await assert.rejects(p, { name: 'AbortError' });
  const first = readOnce({ timeout: 2000 });
  await tick();
  const second = readOnce({ timeout: 2000 });
  await assert.rejects(first, { name: 'AbortError' });
  await tick(); tap([{ recordType: 'url', data: enc('https://tag.junkdrawer.works/t/04') }]);
  assert.equal((await second).url, 'https://tag.junkdrawer.works/t/04');
});

test('stopped while the reader is still starting: stopped, not left waiting', async () => {
  const p = readOnce({ timeout: 5000 });
  cancelNfc();                         // before scan() has answered
  const t0 = Date.now();
  await assert.rejects(p, { name: 'AbortError' });
  assert.ok(Date.now() - t0 < 1000, 'waited for the timeout');
});

test("what went wrong says where a Pixel's NFC switch and reader are", async () => {
  assert.equal(await explainNfc({ name: 'NotReadableError', message: '' }, 'read'),
    'NFC looks switched off. Turn it on in the phone\'s settings (Connected devices → Connection preferences → NFC).');
  assert.match(await explainNfc({ name: 'NetworkError', message: 'lost' }, 'write'), /^Couldn't write the sticker \(lost\)\. Hold it flat against the back of the phone, near the top, and keep it still\.$/);
});
