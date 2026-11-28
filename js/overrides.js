// 404.html has two scripts: OVERRIDES on its own first (the lines the owner types, sending single stickers somewhere
// else: a locked Placard sticker pointed at another page, say), then the resolver (ROUTES, NAMES and the forward), which
// uses OVERRIDES only if its script ran. Check a tag reads both from 404.html's text, as the page runs them, so it shows
// where a tap really goes. test/tags.test.mjs runs 404.html's own scripts beside these and checks the two agree.
const scripts = html => [...String(html || '').matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
// The resolver's script is the one with ROUTES; anything before it is OVERRIDES's (null: there's none).
function parts(html) {
  const all = scripts(html), at = all.findIndex(s => /\bvar ROUTES\b/.test(s));
  return { resolver: at < 0 ? null : all[at], overrides: at > 0 ? all.slice(0, at).join('\n') : null };
}
// OVERRIDES's script run on its own: { ok, map }. ok is false when it doesn't compile, stops with an error or leaves no
// object (the resolver then uses none, as here); map has the keys lowercased as the resolver makes them. Run in a
// function, never on the page; it's this site's own file, the same code every tap runs.
function runOverrides(html) {
  const s = parts(html).overrides;
  if (s == null) return { ok: true, map: {} };
  let o;
  try { o = new Function(`${s}\n;return typeof OVERRIDES === 'object' && OVERRIDES ? OVERRIDES : null;`)(); } catch { return { ok: false, map: {} }; }
  if (!o) return { ok: false, map: {} };
  const map = {};
  for (const k in o) map[k.toLowerCase()] = o[k];
  return { ok: true, map };
}

// The overrides a tap gets: none when their script has a mistake in it.
export const readOverrides = html => runOverrides(html).map;

// Whether OVERRIDES's script runs. A comma left out between two lines, curly quotes from a phone keyboard or '=' for
// ':' stop it: then no sticker is sent elsewhere, and every one opens its own app's page.
export const overridesWork = html => runOverrides(html).ok;

// Whether the resolver's script is JavaScript a browser will run. Nobody types into it, but if it stops, so does the
// page's last script: every sticker in the house lands on "This tag isn't set up". Compiled here, never run.
export function resolverWorks(html) {
  const s = parts(html).resolver;
  if (s == null) return false;
  try { new Function(s); return true; } catch { return false; }
}
