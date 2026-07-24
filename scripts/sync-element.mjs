/**
 * Fans the freshly built player bundle out to every target that ships its own
 * copy:
 *   dist/element.js → chrome-extension/dist/element.js
 *                   → vscode-extension/webview/dist/element.js
 *                   → desktop/renderer/vendor/element.js
 *
 * These copies are gitignored, so nothing here shows up in a commit — but a
 * stale one DOES get published. Shipping a stale vscode webview bundle once
 * cost a whole patch bump, because the marketplace can't overwrite a published
 * version.
 *
 * Deliberately does NOT build: dist/ is produced by `npm run build:ts`, which
 * stays under the author's control. If dist/ is missing we stop; if it looks
 * older than src/ we warn loudly and copy anyway (the caller may know better).
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { copyFile, mkdir, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = resolve(repoRoot, "dist", "element.js");

const targets = [
  ["chrome-extension", "chrome-extension/dist/element.js"],
  ["vscode-extension", "vscode-extension/webview/dist/element.js"],
  ["desktop", "desktop/renderer/vendor/element.js"],
];

if (!existsSync(src)) {
  console.error(
    "\n✗ dist/element.js not found.\n" +
      "  Build the player bundle first:\n" +
      "    npm run build:ts        (or full: npm run build)\n",
  );
  process.exit(1);
}

/** Newest mtime under a directory, so a stale bundle can't slip through unnoticed. */
async function newestMtime(dir) {
  let newest = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    const t = entry.isDirectory() ? await newestMtime(full) : statSync(full).mtimeMs;
    if (t > newest) newest = t;
  }
  return newest;
}

function ago(ms) {
  const mins = Math.round(ms / 60000);
  if (mins < 90) return `${mins} minute(s)`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `${hours} hour(s)` : `${Math.round(hours / 24)} day(s)`;
}

const builtAt = statSync(src).mtimeMs;
const srcTouchedAt = await newestMtime(resolve(repoRoot, "src"));
if (srcTouchedAt > builtAt) {
  // console.log, not console.warn: stderr interleaves unpredictably with the
  // stdout progress below, and a staleness warning that surfaces AFTER
  // "all targets in sync" reads like it doesn't apply.
  console.log(
    `\n⚠ src/ was edited ${ago(srcTouchedAt - builtAt)} AFTER dist/element.js was built.\n` +
      "  You are about to fan out a stale bundle. Run `npm run build:ts` first\n" +
      "  unless you meant to ship the older build.",
  );
}

const hash = (p) => createHash("md5").update(readFileSync(p)).digest("hex");
const srcHash = hash(src);
const sizeMB = (statSync(src).size / 1024 / 1024).toFixed(1);

console.log(`\ndist/element.js  ${sizeMB} MB  ${srcHash.slice(0, 8)}`);

for (const [label, rel] of targets) {
  const dst = resolve(repoRoot, rel);
  await mkdir(dirname(dst), { recursive: true });
  await copyFile(src, dst);
  // Verify rather than trust: a truncated copy is exactly the failure this
  // script exists to prevent, and it's silent otherwise.
  if (hash(dst) !== srcHash) {
    console.error(`✗ ${label}: copy verification FAILED (${rel})`);
    process.exit(1);
  }
  console.log(`✓ ${label.padEnd(17)} → ${rel}`);
}

console.log("\n✓ all targets in sync\n");
