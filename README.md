# Switchboard

**Use it: [tag.junkdrawer.works](https://tag.junkdrawer.works/)** (writing stickers needs Chrome on an Android phone)

**One short link on every NFC sticker, sent on to the app that owns it, plus the shared ledger those apps save to.** Every sticker holds `https://tag.junkdrawer.works/<letter>/<id>`. The letter picks the app (h Placard, t Mothball, p Larder, f Frostbite, m Packrat) and the id is the thing the sticker is on. Because the sticker points here rather than straight at an app, any tag can be sent somewhere else later without rewriting it.

<p align="center">
  <img src="docs/phone-home.png" width="250" alt="Switchboard's page: Check a tag, the ledger address and key, and the five apps to connect.">
</p>

## How it works

- **The resolver.** `404.html` answers every tag address (GitHub Pages serves it for any path it doesn't have) and forwards the phone to `https://<app>.junkdrawer.works/#<id>`. `OVERRIDES` in the same file sends single tags elsewhere.
- **The ledger.** `ledger/Code.gs` is a Google Apps Script for a Google Sheet you own: each tab is one app's collection, each row a record. The apps, a Raspberry Pi and ESP32 boards all read and write it with one key. Only the house manual's pages are readable without the key.
- **Connect.** Each app lives at its own address, so each needs the ledger once. Switchboard makes a link per app that carries the address and key and opens the app with them filled in.
- **Check a tag.** Hold any sticker to the phone to see which app it belongs to and where it goes. Web NFC needs Chrome on Android.
- **Offline.** Any phone that has tapped one sticker online keeps a copy of the resolver (about 160 KB, fetched in the background on that first tap), so a later tap with no signal, or on one bar that never answers, still reaches the app's offline copy within a few seconds.

## Running it

It's a static site: plain HTML, CSS and JavaScript, with no build step.

```sh
npx http-server -p 8080 -c-1 .   # then open http://localhost:8080
npm test                         # unit tests, then the page in Chromium with a pretend NFC reader
node tools/make-icons.mjs        # PNG icons from icon.svg
```

GitHub Pages serves it from `main`, `/ (root)`, at its own address (`CNAME`).

### Files

- `index.html`, `css/app.css`, `js/app.js`: the Switchboard page.
- `404.html`: the resolver.
- `ledger/Code.gs`: the ledger web app.
- `js/kit/`, `css/kit.css`: the kit every tag app shares: ledger client, Web NFC, small UI helpers.
- `fonts/`: Barlow, Barlow Condensed and JetBrains Mono (SIL Open Font License), served from here so nothing loads from elsewhere.
- `test/`: the ledger round trip against a pretend Google Sheet, the resolver, and the page in Chromium (`test/e2e.mjs`, `test/app-checks.mjs`), offline included.

