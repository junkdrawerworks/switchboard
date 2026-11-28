// Offline support: keep a copy of the app so it works with no signal.
// Anything the person saves lives in localStorage, not here.
// Network first, so a new version shows up as soon as you're online, but a page the network hasn't answered in a few
// seconds opens from the copy instead (see page()), and so does a page whose files it hasn't (see file()).

// An installed copy downloads the whole list again only when this file changes by a byte. Otherwise each file in it is
// refreshed only when a page that loads it is visited online, and the copy could mix two releases. So FILES is a
// fingerprint of every file in SHELL: change any of them and test/e2e.mjs fails until FILES is changed to match (it
// says what to), which changes this file, so every copy is made whole again at once.
const CACHE = 'switchboard-v2'; // bump the number when the file list changes
const FILES = 'dbb4e713'; // test/e2e.mjs checks this
const SHELL = [
  './', 'index.html', 'icon.svg', 'manifest.webmanifest',
  '404.html', 'css/app.css', 'css/kit.css', 'js/app.js',
  'js/overrides.js', 'js/kit/ledger.js', 'js/kit/nfc.js', 'js/kit/panel.js',
  'js/kit/tags.js', 'js/kit/ui.js', 'fonts/barlow-400.woff2', 'fonts/barlow-600.woff2',
  'fonts/barlow-condensed-700.woff2', 'fonts/jetbrains-mono-500.woff2',
];

// Each file straight from the server (a quick "not modified" for one that hasn't changed), not from the browser's own
// copies, which can be ten minutes old (see fresh() below): a copy made from those could mix in the last release.
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE)
    .then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'no-cache' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    // Only this project's own old copies, by exact name: the tools at junkdrawer.works/REPO/ share one Cache Storage,
    // and a looser match would delete another project's copy (all of them, or one whose name starts with this one's).
    .then(keys => Promise.all(keys.filter(k => k !== CACHE && /^switchboard-v[0-9]+$/.test(k)).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// How long a page, or a file it loads, waits for the network before it comes from the copy instead.
const PATIENCE = 4000; // ms
// The pages (by their client ids) that opened from the copy, or took a file from it: the rest of their files come from
// it too, so a page never mixes the copy's files with newer ones. (The browser stops the worker once it has been idle a
// while, and the lists go with it.)
const fromCopy = new Set();
// The pages that came from the network just as the copy has them, and every file the network has sent them so far too
// (see compare()): so far they're exactly what they would be from the copy, so one of their files can come from it.
const likeCopy = new Set();
const remember = (list, id) => { list.add(id); if (list.size > 50) list.delete(list.values().next().value); }; // the oldest, long gone

// Switchboard only: a sticker's address (/h/water-heater), or any other address here that isn't one of Switchboard's
// own pages (/h/ from a sticker written short), is answered by 404.html, the resolver, which works at any depth. The
// network comes first, so a change to OVERRIDES arrives. With no signal the copy's 404.html answers at once; on a
// connection that's up but not answering (one bar in a basement) it answers after RESOLVE. Either way the tap still
// reaches the app, which then opens from its own copy.
const RESOLVE = 3000; // ms
const OWN = new Set(SHELL.map(u => new URL(u, location).pathname)); // '/', '/index.html', '/404.html', the files
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.mode !== 'navigate' || url.origin !== location.origin || OWN.has(url.pathname)) return;
  e.stopImmediatePropagation();
  e.respondWith(new Promise(resolve => {
    let answered = false;
    const answer = res => { if (res && !answered) { answered = true; resolve(res); } };
    const copy = () => caches.match('404.html');
    const slow = setTimeout(() => copy().then(answer), RESOLVE);
    fresh(e.request).then(res => { clearTimeout(slow); answer(res); },
      () => { clearTimeout(slow); copy().then(res => answer(res || Response.error())); });
  }));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (e.request.mode === 'navigate') e.respondWith(page(e));
  else if (fromCopy.has(e.clientId)) e.respondWith(kept(e.request).then(r => r || network(e)));
  else e.respondWith(file(e));
});

// A page, from the network. On a connection that's up but not answering (a train, a captive wifi, one bar of signal),
// it opens from the copy after PATIENCE instead, if the copy has it. With no copy of the page, it waits on for the
// network. With no network at all, it opens from the copy straight away, as it always has.
function page(e) {
  let answered = false, copied = false;
  // The network's answer goes into the copy, unless the copy answered first: that page's files came from the copy,
  // and a newer page kept beside them would be the mix this is avoiding, next time it opens from the copy.
  const net = network(e, () => !copied);
  // Safari before 16 doesn't say which page a load becomes (no resultingClientId), so the page's files couldn't come
  // from the copy too, and would wait on the network anyway. There a page waits for the network, as it always has.
  if (!e.resultingClientId) return net.catch(() => offline(e.request));
  return new Promise((resolve, reject) => {
    const answer = res => { if (!answered) { answered = true; resolve(res); } };
    const slow = setTimeout(() => kept(e.request).then(copy => {
      if (!copy || answered) return;
      copied = true;
      remember(fromCopy, e.resultingClientId);
      answer(copy);
    }), PATIENCE);
    net.then(res => { clearTimeout(slow); answer(res); },
      () => { clearTimeout(slow); offline(e.request).then(answer, reject); });
  });
}

// A file a page loads, from the network. On a connection that answered for the page but then holds on to its files,
// the page would never open. So, as in page(): after PATIENCE the file comes from the copy instead, if the copy has it
// and the page is still likeCopy, and the rest of that page's files come from the copy straight away. The network's
// late answer still goes into the copy. A page that isn't likeCopy waits on for the network, as before: the network has
// sent it something newer than the copy's (a release the worker hasn't fetched yet), and the copy's file beside that
// would be a mix of two releases.
function file(e) {
  const id = e.clientId;
  return new Promise((resolve, reject) => {
    let answered = false;
    const answer = res => { if (!answered) { answered = true; resolve(res); } };
    const slow = setTimeout(() => likeCopy.has(id) && kept(e.request).then(copy => {
      if (!copy || answered) return;
      remember(fromCopy, id);
      answer(copy);
    }), PATIENCE);
    network(e).then(res => {
      clearTimeout(slow);
      // The page went over to the copy while this was on its way: the copy's, in case this one is newer.
      if (fromCopy.has(id)) kept(e.request).then(copy => answer(copy || res)); else answer(res);
    }, () => { clearTimeout(slow); offline(e.request).then(answer, reject); });
  });
}

// A file from the network, kept in the copy for next time (unless keep() says not). The worker stays up until it's in.
function network(e, keep = () => true) {
  let stored;
  const got = fresh(e.request).then(res => {
    if (res.ok && keep()) {
      const copy = res.clone(), key = keyFor(e.request);
      stored = caches.open(CACHE).then(c => c.match(key).then(was => { compare(e, res, was); return c.put(key, copy); }));
    }
    return res;
  });
  try { e.waitUntil(got.then(() => stored, () => {})); } catch { /* the event is over: the copy goes in anyway */ }
  return got;
}

// Before the network's answer goes into the copy: is it what the copy had (the same ETag)? A page that is goes on
// likeCopy; a page or file that isn't (from a release the worker hasn't fetched yet) takes its page off. A file the copy
// hasn't got leaves it as it is: there's no copy of it to mix in.
function compare(e, res, was) {
  const id = e.resultingClientId || e.clientId, isPage = e.request.mode === 'navigate', tag = res.headers.get('etag');
  if (!id || (!was && !isPage)) return;
  if (tag && was?.headers.get('etag') === tag) { if (isPage) remember(likeCopy, id); }
  else likeCopy.delete(id);
}

// A page is kept under its address without the query string, so a page opened from a shared link (?fbclid=…) is the
// same page in the copy: a release refreshes it with the rest, instead of an old one staying on under the query, and
// the copy doesn't gain a page for every link. Files are kept under their own address.
const keyFor = request => {
  if (request.mode !== 'navigate') return request;
  const url = new URL(request.url);
  return url.origin + url.pathname;
};
// A file from the copy, marked like the network's (see askAgainNextTime() below), so a reload once the network is
// back asks again rather than reusing it. A page is looked up by its plain address only.
const kept = request => (request.mode === 'navigate' ? caches.match(keyFor(request)) : caches.match(request, { ignoreSearch: true }))
  .then(r => r && askAgainNextTime(r));
// With no network: the file from the copy, or for anything it hasn't got, the app's page.
const offline = request => kept(request).then(r => r || caches.match('index.html'));

// GitHub Pages lets browsers keep files for ten minutes, so without this an update can take that long to show up.
// Ask the server every time instead; a file that hasn't changed comes back as a quick "not modified".
function fresh(request) {
  const got = request.mode === 'navigate'
    // A page load can't be answered with a redirected response, so fall back to the plain request if there was one.
    ? fetch(request.url, { cache: 'no-cache' }).then(res => (res.redirected ? fetch(request) : res))
    : fetch(request, { cache: 'no-cache' });
  return got.then(askAgainNextTime);
}

// The open tab keeps its own copy of each file too, and would reuse it on a reload without asking.
// Marking the copy it gets from here no-cache sends that reload back through fresh() as well.
function askAgainNextTime(res) {
  if (res.status !== 200 || res.type !== 'basic' || res.redirected) return res;
  const headers = new Headers(res.headers);
  headers.set('cache-control', 'no-cache');
  headers.delete('content-encoding'); // the body here is already unpacked
  headers.delete('content-length');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
