// OVERRIDES in 404.html sends single stickers somewhere else (a locked Placard sticker pointed at another page, say).
// The resolver is the only thing that applies them, so Check a tag reads the same block from 404.html's text and
// evaluates it as the page does: a comment, either kind of quote and a comma or none at the end all read as they do
// there, and the keys are lowercased as the resolver makes them. A block that isn't JavaScript gives none. test/
// tags.test.mjs runs 404.html's own scripts beside this and checks the two agree, so a change to the block shows there.
export function readOverrides(html) {
  const block = /var OVERRIDES = \{([\s\S]*?)\};/.exec(String(html || ''));
  if (!block) return {};
  let o;
  try { o = new Function(`return {${block[1]}\n};`)(); } catch { return {}; }
  const out = {};
  for (const k of Object.keys(o)) out[k.toLowerCase()] = o[k];
  return out;
}

// Whether 404.html's first script (ROUTES, NAMES, OVERRIDES and the forward) is JavaScript a browser will run. A comma
// left out between two lines, curly quotes from a phone keyboard or '=' for ':' stop it, and the page's second script
// then stops too: every sticker in the house lands on "This tag isn't set up". Compiled here, never run.
export function resolverWorks(html) {
  const s = /<script>([\s\S]*?)<\/script>/.exec(String(html || ''));
  if (!s) return false;
  try { new Function(s[1]); return true; } catch { return false; }
}
