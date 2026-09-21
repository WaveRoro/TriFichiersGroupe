// Stamps docs/index.html with a version derived from the site's own files.
//
// GitHub Pages lets browsers reuse each file for ~10 minutes, and a phone
// can keep serving an old script (or pair a new one with an old one) after an
// update. Putting the version in the URL of the stylesheet, the entry script
// and - through an import map - every module makes the browser fetch exactly
// the files that belong together as soon as it loads a fresh index.html. The
// same version is shown on the sign-in and folder screens, so "is my phone up
// to date?" has a visible answer.
//
//   node tools/stamp.mjs          rewrite docs/index.html
//   node tools/stamp.mjs --check  exit 1 if it is out of date (used by the tests)
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const DOCS = join(dirname(fileURLToPath(import.meta.url)), "..", "docs");

const isVersioned = (name) => name.endsWith(".js") || name === "style.css";

// Line endings are normalised so the same content gives the same version on
// every machine, whatever git does to them on checkout.
export function computeStamp(dir = DOCS) {
  const hash = createHash("sha1");
  for (const name of readdirSync(dir).filter(isVersioned).sort()) {
    hash.update(name + "\n");
    hash.update(readFileSync(join(dir, name), "utf8").replace(/\r\n/g, "\n"));
  }
  return hash.digest("hex").slice(0, 8);
}

export function moduleNames(dir = DOCS) {
  return readdirSync(dir).filter((n) => n.endsWith(".js") && n !== "app.js").sort();
}

export function stampHtml(html, stamp, modules) {
  const map = JSON.stringify({ imports: Object.fromEntries(modules.map((m) => [`./${m}`, `./${m}?v=${stamp}`])) }, null, 2);
  return html
    .replace(/(href="style\.css)(\?v=\w+)?"/, `$1?v=${stamp}"`)
    .replace(/(src="app\.js)(\?v=\w+)?"/, `$1?v=${stamp}"`)
    .replace(/<script type="importmap">[\s\S]*?<\/script>/, `<script type="importmap">\n${map}\n</script>`)
    .replace(/(<span class="app-version">)[^<]*(<\/span>)/g, `$1${stamp}$2`);
}

export function isCurrent(dir = DOCS) {
  const html = readFileSync(join(dir, "index.html"), "utf8");
  return html.replace(/\r\n/g, "\n") === stampHtml(html, computeStamp(dir), moduleNames(dir)).replace(/\r\n/g, "\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes("--check")) {
    if (!isCurrent()) {
      console.error("docs/index.html is out of date: run `npm run stamp`.");
      process.exit(1);
    }
  } else {
    const file = join(DOCS, "index.html");
    const before = readFileSync(file, "utf8");
    const after = stampHtml(before, computeStamp(), moduleNames());
    if (after !== before) writeFileSync(file, after);
    console.log("version", computeStamp());
  }
}
