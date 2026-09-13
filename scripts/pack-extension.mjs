#!/usr/bin/env node
/* Builds dist/s256-extension-<version>.zip for upload to the Chrome Web Store.
   Only Web Store installs work without Developer Mode in Chrome. */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const dist = path.join(root, "dist");
fs.mkdirSync(dist, { recursive: true });
const out = path.join(dist, `s256-extension-${manifest.version}.zip`);
if (fs.existsSync(out)) fs.unlinkSync(out);

const include = [
  "manifest.json",
  "background.js",
  "popup.html",
  "index.html",
  "css",
  "js",
  "vendor",
  "icons",
  "content",
  "inject",
];
for (const p of include) {
  if (!fs.existsSync(path.join(root, p))) {
    console.error("missing", p);
    process.exit(1);
  }
}

const r = spawnSync("zip", ["-r", "-X", "-q", out, ...include, "-x", "*.DS_Store"], { cwd: root, encoding: "utf8" });
if (r.status !== 0) {
  console.error(r.stderr || r.stdout || "zip failed");
  process.exit(1);
}
console.log("wrote", out, fs.statSync(out).size, "bytes");
