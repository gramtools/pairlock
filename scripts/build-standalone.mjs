#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const readBin = (p) => fs.readFileSync(path.join(root, p));

function wrapCss(css) {
  return "<style>\n" + css + "\n</style>";
}

function wrapJs(js, name) {
  const safe = js.replace(/<\/script/gi, "<\\/script");
  return `<script>\n/* ${name} */\n${safe}\n</script>`;
}

const icon48 = readBin("icons/icon48.png").toString("base64");
const iconData = `url("data:image/png;base64,${icon48}")`;
const css = read("css/app.css").replace(
  /url\("\.\.\/icons\/icon48\.png"\)/g,
  iconData
);

const html = `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; base-uri 'none'; form-action 'none'" />
  <meta name="referrer" content="no-referrer" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="color-scheme" content="dark" />
  <meta name="theme-color" content="#0c1622" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
  <meta name="apple-mobile-web-app-title" content="Pairlock" />
  <meta name="description" content="S256 — open-source local encrypted messenger pad. Keys never leave the device." />
  <title>Pairlock</title>
  ${wrapCss(css)}
</head>
<body class="page">
  <div class="wrap" id="app">
    <div style="padding:28px 20px;color:#f4f8fc;line-height:1.5">
      <div style="width:42px;height:42px;border-radius:14px;background:${iconData} center/cover no-repeat,#0c1622;margin-bottom:14px"></div>
      <h1 style="font-size:22px;margin:0 0 8px;letter-spacing:-0.03em">Pairlock</h1>
      <p style="color:#7f96aa;margin:0">Загрузка…</p>
    </div>
  </div>
  <noscript><p style="padding:20px;color:#fff">Pairlock нужен JavaScript.</p></noscript>
  ${wrapJs(read("vendor/nacl.min.js"), "nacl")}
  ${wrapJs(read("vendor/qrcode.min.js"), "qrcode")}
  ${wrapJs(read("js/crypto.js"), "crypto")}
  ${wrapJs(read("js/protocol.js"), "protocol")}
  ${wrapJs(read("js/vault.js"), "vault")}
  ${wrapJs(read("js/app.js"), "app")}
</body>
</html>
`;

const out = path.join(root, "s256.html");
fs.writeFileSync(out, html);
console.log("wrote", out, fs.statSync(out).size, "bytes");
