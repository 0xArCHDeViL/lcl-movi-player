import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const artifact = resolve("dist/element.slim.js");
const source = readFileSync(artifact, "utf8");
const replacements = [
  [
    'class="movi-quality-btn-badge" style="display: none;"',
    'class="movi-quality-btn-badge" part="quality-badge" style="display: none;"',
  ],
  [
    'class="movi-settings-btn-badge" style="display: none;"',
    'class="movi-settings-btn-badge" part="quality-badge" style="display: none;"',
  ],
];

let output = source;
for (const [from, to] of replacements) {
  if (output.includes(to)) continue;
  if (!output.includes(from)) throw new Error(`Expected native badge markup not found: ${from}`);
  output = output.replace(from, to);
}

if (!output.includes('part="quality-badge"')) throw new Error("Native quality badge part was not written.");
writeFileSync(artifact, output);
console.log("Patched native MoviPlayer quality badges with part=quality-badge.");
