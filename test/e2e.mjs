// Uses the app in Chromium through the real page:  node test/e2e.mjs  (needs Playwright)
// Skeleton from the junkdrawer skill: the checks at the bottom are the ones every project wants;
// add the ones that prove this app does its job.
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch { pw = require(join(execSync('npm root -g').toString().trim(), 'playwright')); }
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
// The server answers the way GitHub Pages does: a browser may keep each file for ten minutes, and asks again by its
// ETag. `net` is the connection: 'up', 'down' (the server drops every connection), 'stalled' (a train, a captive
// wifi: it takes each request and holds on to it), 'files stalled' (it answers for a page, then holds on to the files
// the page loads) or 'scripts stalled' (it holds on to the scripts only). With `release` set it serves the next
// release (see the end); with `release` 'files', a next release that changes the css and js but not index.html.
let net = 'up', release = false;
const held = [];
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (net === 'down') { req.socket.destroy(); return; }
  if (net === 'stalled' || (net === 'files stalled' && !/(\/|\.html)$/.test(path)) || (net === 'scripts stalled' && path.endsWith('.js'))) {
    held.push([req, res]);
    return;
  }
  serve(req, res);
}).listen(0);
async function serve(req, res) {
  let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path.endsWith('/')) path += 'index.html';
  let body;
  try { body = await readFile(join(root, path)); } catch { res.writeHead(404); res.end(); return; }
  if (release && path === '/sw.js') body = Buffer.from(String(body).replace(/const FILES = '[0-9a-f]*'/, "const FILES = 'next'"));
  else if (release && /\.(css|js)$/.test(path)) body = Buffer.concat([body, Buffer.from('\n/* the next release */\n')]);
  if (release === true && path === '/index.html') body = Buffer.concat([body, Buffer.from('<!-- the next release -->\n')]);
  const etag = `"${createHash('sha1').update(body).digest('hex').slice(0, 16)}"`;
  const head = { etag, 'cache-control': 'max-age=600', 'content-type': TYPES[extname(path)] || 'text/html' };
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, head); res.end(); return; }
  res.writeHead(200, head);
  res.end(body);
}
const base = `http://localhost:${server.address().port}/`;
// The connection comes back: the held requests are answered (as things are now, before `release` next changes).
const unstall = () => { net = 'up'; return Promise.all(held.splice(0).map(([req, res]) => serve(req, res))); };
// Waits for ok() to come true, for up to ms, or fails saying what didn't happen.
const until = async (ok, ms, what) => {
  for (const end = Date.now() + ms; !(await ok());) { assert.ok(Date.now() < end, what); await new Promise(r => setTimeout(r, 100)); }
};

const browser = await pw.chromium.launch({ executablePath: process.env.CHROME || undefined });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true });
const page = await ctx.newPage();
const problems = [];
page.on('pageerror', e => problems.push(e.message));
page.on('console', m => { if (m.type() === 'error') problems.push(m.text()); });
page.on('requestfailed', r => problems.push('failed: ' + r.url()));
page.on('request', r => { if (!r.url().startsWith(base)) problems.push('left the site: ' + r.url()); });

await page.goto(base);
await page.evaluate(() => document.fonts.ready);

// The app's own checks (test/app-checks.mjs) use it the way a person would.
const { appChecks } = await import('./app-checks.mjs');
await appChecks({ page, ctx, base, assert, problems });
await page.goto(base);

// Fits a phone: nothing scrolls sideways.
assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'the page scrolls sideways on a phone');

// Works offline once it has been opened. The server goes down as well as the browser: in some Chromium builds the
// browser's offline switch alone doesn't stop the service worker's own requests, and this passed with no copy at all.
await page.waitForFunction(() => navigator.serviceWorker?.controller, null, { timeout: 10000 });
const title = await page.title();
// The page opened from a link with a query string (a shared link's ?fbclid=…) is kept in the copy under its plain
// address: see the release below.
await page.goto(base + '?x=1');
await page.goto(base);
net = 'down';
await ctx.setOffline(true);
await page.reload();
assert.equal(await page.title(), title, 'the page did not open offline');
await ctx.setOffline(false);

// On a connection that's up but not answering, it opens from the copy too, after the worker's few seconds' wait for
// the network: the page and every file it loads (were any of them left waiting on the network, it wouldn't open).
net = 'stalled';
const t0 = Date.now();
await page.reload({ timeout: 10000 }).catch(() => {});
const took = Date.now() - t0;
assert.ok(took < 8000, `the page took ${took} ms to open on a stalled connection`);
assert.equal(await page.title(), title, 'the page did not open on a stalled connection');
await unstall();

// On a connection that answers for the page but then holds on to the files it loads, it opens too: after the same
// wait, a file the copy has comes from it, and the rest of that page's files come from it straight away.
net = 'files stalled';
const t1 = Date.now();
await page.reload({ timeout: 10000 }).catch(() => {});
const took1 = Date.now() - t1;
assert.ok(took1 < 7000 && await page.evaluate(() => document.readyState) === 'complete', `the page took ${took1} ms to open when the files it loads stalled`);
await unstall();

// But never as a mix of two releases: a page the network has started sending newer files than the copy's (here the
// next release's css, the page itself unchanged), or a page newer than the copy's, waits on for the network.
const waitsForNetwork = async what => {
  await page.reload({ timeout: 5500 }).catch(() => {});
  assert.notEqual(await page.evaluate(() => document.readyState), 'complete', what);
};
release = 'files';
net = 'scripts stalled';
await waitsForNetwork("the copy's scripts opened a page beside the next release's css");
release = false;
await unstall();
await page.waitForFunction(() => document.readyState === 'complete');
release = true;
net = 'files stalled';
await waitsForNetwork("the copy's files opened the next release's page");
await unstall();
await page.waitForFunction(() => document.readyState === 'complete');

// A new release: every file in the new copy comes from the server, though the browser still has its own copies of
// the old ones for ten minutes. (The next release changes index.html, and so FILES in sw.js, as a real one does.)
release = true;
await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
await until(() => page.evaluate(async () => !!(await (await caches.match('index.html'))?.text())?.includes('<!-- the next release -->')),
  10000, "the new release's offline copy kept the old index.html");
// With the network down, the page opens from the new release's copy, not from an old page kept under ?x=1 (which
// would run the old index.html with the new release's files).
net = 'down';
await ctx.setOffline(true);
await page.reload();
assert.equal(await page.evaluate(() => [...document.childNodes].some(n => n.nodeType === Node.COMMENT_NODE && n.data.includes('the next release'))), true,
  'offline after a release, the page opened from an old copy kept under its query string');
assert.deepEqual(await page.evaluate(async () => (await (await caches.open((await caches.keys())[0])).keys()).map(r => r.url).filter(u => u.includes('?'))), [],
  'the copy kept a page under its query string');
await ctx.setOffline(false);
net = 'up';
release = false;

assert.deepEqual(problems.filter(p => !p.startsWith('failed:')), [], 'problems while using it');
await browser.close();
server.close();

// sw.js changes whenever a file it keeps does, so a release replaces the whole offline copy at once: FILES in sw.js is
// a fingerprint of every file in SHELL (sha1 of each, in the list's order, an address like './' read as its
// index.html; the first 8 hex of the sha1 of those).
const sw = await readFile(join(root, 'sw.js'), 'utf8');
const shell = [...sw.match(/SHELL = \[([^\]]*)\]/)[1].replace(/\/\/.*/g, '').matchAll(/'([^']*)'/g)].map(m => m[1]);
const all = createHash('sha1');
for (const f of shell) all.update(createHash('sha1').update(await readFile(join(root, f.endsWith('/') ? f + 'index.html' : f))).digest());
const files = all.digest('hex').slice(0, 8);
assert.equal(sw.match(/const FILES = '([0-9a-f]*)'/)?.[1], files, `a file sw.js keeps for offline has changed: set FILES in sw.js to '${files}'`);
console.log('all good');
