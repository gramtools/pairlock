(function () {
  const PREFIX = "S256M1.";
  const SRC_HOOK = "s256-hook";
  const DST_HOOK = "s256-content";

  function isKeyPacket(s) {
    const t = String(s || "").trim();
    return t.startsWith("S256K1.") || t.startsWith("S256KT1.") || t.startsWith("S256KB1.");
  }

  /* Classic S256M1. or stealth base64 blob (no brand prefix). Loose length check —
     background confirms with the real tag when decrypting. */
  function isCipherPacket(s) {
    const t = String(s || "").trim().replace(/\s+/g, "");
    if (!t) return false;
    if (t.startsWith(PREFIX)) return true;
    if (isKeyPacket(t)) return false;
    if (t.length < 120 || t.length > 5000) return false;
    return /^[A-Za-z0-9_-]+$/.test(t);
  }

  function extractCipherTokens(text) {
    const s = String(text || "");
    const out = [];
    const classic = s.match(/S256M1\.[A-Za-z0-9_-]+/g);
    if (classic) out.push(...classic);
    const re = /[A-Za-z0-9_-]{120,4200}/g;
    let m;
    while ((m = re.exec(s))) {
      const tok = m[0];
      if (tok.startsWith("S256K") || tok.startsWith("S256KT")) continue;
      if (tok.startsWith("S256M1.")) continue;
      if (!isCipherPacket(tok)) continue;
      if (out.indexOf(tok) === -1) out.push(tok);
    }
    return out;
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function injectPackets(packets) {
    const list = Array.isArray(packets) ? packets.filter(Boolean) : [];
    for (let i = 0; i < list.length; i++) {
      pauseCoverUntil = Date.now() + 900;
      window.postMessage({ source: DST_HOOK, type: "inject-send", text: list[i] }, "*");
      if (i + 1 < list.length) await sleep(450);
    }
  }

  function ttlPhrase(sec) {
    const n = sec >>> 0;
    if (!n) return "бессрочно";
    if (n === 900) return "15 минут";
    if (n === 1800) return "30 минут";
    if (n === 3600) return "1 час";
    if (n === 86400) return "сутки";
    if (n === 604800) return "неделя";
    if (n === 30) return "30 секунд";
    if (n === 60) return "1 минута";
    if (n === 120) return "2 минуты";
    return n + " с";
  }

  function parseKeyPreview(text) {
    const tokens = extractKeyTokensFromText(text);
    const t = tokens[0] || "";
    if (!t) return null;
    if (t.startsWith("S256KB1.")) {
      const p = t.split(".");
      return { timed: Number(p[4]) > 0, burn: true, burnTtlSec: Number(p[3]) || 0, ttlSec: Number(p[4]) || 0, token: t };
    }
    if (t.startsWith("S256KT1.")) {
      const p = t.split(".");
      return { timed: true, ttlSec: Number(p[3]) || 0, token: t };
    }
    if (t.startsWith("S256K1.")) return { timed: false, ttlSec: 0, token: t };
    return null;
  }

  let overlay;
  let overlayText;
  let composerHost;
  let chatHost = null;
  let chatShadow = null;
  let floatChatId = null;
  let floatStick = true;
  let floatForceBottom = false;
  let floatVerify = false; /* voice fingerprint check inside float chat */
  let chatPoll = null;
  let lastPeer = null;
  let lastStatus = { unlocked: false, bound: null };
  let pauseCoverUntil = 0;

  /* ---------- Shielded composer: keystroke firewall ----------
     This script runs at document_start in the extension's isolated world, so its
     capture listeners on `window` are registered before any page script exists and
     therefore fire first. For every input-related event whose composed path passes
     through our overlay we call stopImmediatePropagation(): the page's own listeners
     (keyloggers, draft sync, "typing" analytics) never see the event, while the
     browser still performs the default action (inserting the character). The field
     itself lives in a closed shadow root that page code cannot open, and the page's
     prototype overrides do not reach this world. */
  let shadowRoot = null;
  let scField = null;
  const SHIELD_EVENTS = [
    "keydown",
    "keypress",
    "keyup",
    "beforeinput",
    "input",
    "textInput",
    "compositionstart",
    "compositionupdate",
    "compositionend",
    "paste",
    "cut",
    "copy",
    "drop",
    "contextmenu",
  ];

  function insideOverlay(e) {
    const path = e.composedPath ? e.composedPath() : [];
    return (
      (overlay && path.indexOf(overlay) !== -1) ||
      (composerHost && path.indexOf(composerHost) !== -1) ||
      (chatHost && path.indexOf(chatHost) !== -1) ||
      (modalHost && path.indexOf(modalHost) !== -1)
    );
  }

  function onShielded(type, e) {
    if (modalReq && type === "keydown" && e.key === "Escape") {
      e.preventDefault();
      answerModal({ cancel: true });
      return;
    }
    const focused = shadowRoot && shadowRoot.activeElement;
    const chatField = chatShadow && chatShadow.getElementById("ct");
    const pwField = chatShadow && chatShadow.getElementById("pw");
    const active = chatShadow && chatShadow.activeElement;
    if (pwField && (active === pwField || active === chatShadow.getElementById("pw2"))) {
      if (type === "keydown" && e.key === "Enter") {
        e.preventDefault();
        unlockFloat();
      }
      return;
    }
    const chatFocused = active === chatField;
    if (chatFocused) {
      if (type === "keydown" && e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        sendFloatChat();
      }
      return;
    }
    if (focused !== scField) return;
    if (type === "keydown" && e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendShielded();
      return;
    }
    if (type === "keydown" && e.key === "Escape") {
      e.preventDefault();
      scField.blur();
      return;
    }
    if (type === "input") autosize();
  }

  for (const type of SHIELD_EVENTS) {
    window.addEventListener(
      type,
      (e) => {
        if (!insideOverlay(e)) return;
        e.stopImmediatePropagation();
        onShielded(type, e);
      },
      true
    );
  }

  function autosize() {
    if (!scField) return;
    scField.style.height = "auto";
    scField.style.height = Math.min(160, Math.max(36, scField.scrollHeight)) + "px";
    applyComposerCover();
  }

  function platformOf(host) {
    if (/max\.ru$/i.test(host) || host.includes("max.ru")) return "max";
    if (/(^|\.)vk\.(com|ru|me)$/i.test(host) || host.includes("vk.")) return "vk";
    return "web";
  }

  function detectPeer() {
    const host = location.hostname;
    const platform = platformOf(host);
    const u = new URL(location.href);
    if (platform === "vk") {
      const sel = u.searchParams.get("sel") || u.searchParams.get("peer");
      if (sel) return { platform: "vk", peer: sel };
      /* vk.ru/im/convo/123, web.vk.me/convo/123, vk.ru/im/123 */
      const path = u.pathname.match(/\/convo\/([^/?#]+)/) || u.pathname.match(/\/im\/(-?\d+)/);
      if (path) return { platform: "vk", peer: path[1] };
      const hash = u.hash.match(/sel=([^&]+)/);
      if (hash) return { platform: "vk", peer: decodeURIComponent(hash[1]) };
    }
    if (platform === "max") {
      const m =
        u.pathname.match(/\/(?:chats?|dialog|im)\/(-?\d+)/i) ||
        u.pathname.match(/(-?\d{3,})/) ||
        u.hash.match(/(-?\d{3,})/);
      if (m) return { platform: "max", peer: m[1] };
      if (lastPeer && lastPeer.platform === "max") return lastPeer;
    }
    return lastPeer;
  }

  function isDirectChat(peer) {
    if (!peer || peer.peer == null || peer.peer === "") return false;
    const p = String(peer.peer);
    if (peer.platform === "vk" && (/^c/i.test(p) || p === "0")) return false;
    return true;
  }

  function send(msg) {
    try {
      if (!chrome.runtime || !chrome.runtime.id) {
        return Promise.resolve({
          ok: false,
          error: "Обновите страницу VK/MAX (F5) — расширение перезагружено",
          code: "stale",
        });
      }
      return chrome.runtime.sendMessage(msg).then((r) => {
        if (r == null) {
          return {
            ok: false,
            error: "Нет ответа от Pairlock — обновите страницу (F5)",
            code: "no_response",
          };
        }
        return r;
      }).catch((e) => {
        const m = String((e && e.message) || e || "");
        const stale = /context invalidated|extension|receiving end/i.test(m);
        return {
          ok: false,
          error: stale ? "Обновите страницу VK/MAX (F5) — расширение перезагружено" : m || "ошибка связи",
          code: stale ? "stale" : "send_fail",
        };
      });
    } catch (e) {
      return Promise.resolve({
        ok: false,
        error: "Обновите страницу VK/MAX (F5)",
        code: "stale",
      });
    }
  }

  function pushStateToHook() {
    const peer = detectPeer();
    window.postMessage(
      {
        source: DST_HOOK,
        type: "state",
        state: {
          unlocked: !!lastStatus.unlocked,
          bound: !!(lastStatus.bound || lastStatus.bindNext),
          currentPeer: peer,
        },
      },
      "*"
    );
  }

  /* Overlay position / collapsed state are remembered per browser (not per site). */
  const UI_KEY = "s256.overlay.ui";
  let ui = { x: null, y: null, collapsed: false, composer: true, chatOpen: false, chatX: null, chatY: null };
  let actionBtn;
  let winBtn;
  let extraBox;
  let barEl;
  let miniEl;
  let currentAction = null; /* "bind" | "unbind" | null */

  async function loadUi() {
    try {
      const r = await chrome.storage.local.get(UI_KEY);
      if (r && r[UI_KEY]) ui = Object.assign(ui, r[UI_KEY]);
    } catch {
      /* ignore */
    }
  }

  function saveUi() {
    try {
      chrome.storage.local.set({ [UI_KEY]: ui });
    } catch {
      /* ignore */
    }
  }

  function applyDock() {
    if (!overlay || !shadowRoot) return;
    const wrap = shadowRoot.querySelector(".wrap");
    if (!wrap) return;
    if (ui.x == null || ui.y == null) {
      wrap.classList.remove("side", "side-left", "side-right");
      return;
    }
    const edge = 88;
    const nearLeft = ui.x < edge;
    const nearRight = ui.x > window.innerWidth - edge - 72;
    wrap.classList.toggle("side", nearLeft || nearRight);
    wrap.classList.toggle("side-left", nearLeft);
    wrap.classList.toggle("side-right", nearRight && !nearLeft);
  }

  function applyPosition() {
    if (!overlay) return;
    applyDock();
    const covering = composerHost && composerHost.style.display !== "none" && composerHost.style.display !== "";
    const w = overlay.offsetWidth || 320;
    const h = overlay.offsetHeight || 40;
    if (ui.x == null || ui.y == null) {
      if (covering) {
        overlay.style.left = "12px";
        overlay.style.top = "28%";
        overlay.style.bottom = "auto";
        overlay.style.transform = "none";
        if (shadowRoot) {
          const wrap = shadowRoot.querySelector(".wrap");
          if (wrap) wrap.classList.add("side", "side-left");
        }
        applyComposerCover();
        return;
      }
      overlay.style.left = "50%";
      overlay.style.top = "auto";
      overlay.style.bottom = "18px";
      overlay.style.transform = "translateX(-50%)";
      applyComposerCover();
      return;
    }
    const x = Math.min(Math.max(0, ui.x), Math.max(0, window.innerWidth - w));
    const y = Math.min(Math.max(0, ui.y), Math.max(0, window.innerHeight - h));
    overlay.style.left = x + "px";
    overlay.style.top = y + "px";
    overlay.style.bottom = "auto";
    overlay.style.transform = "none";
    applyComposerCover();
  }

  let panelEl;
  let panelTo;
  let compBtn;
  let offerEl;
  let offerTitle;
  let offerDesc;
  let offerKicker;
  let offerSteps;
  let offerPick;
  let offerAdd;
  let sendKeyBtn;
  let haveKeyBtn;
  let rekeyEl;
  let rekeyTitle;
  let rekeyDesc;
  let rekeyChips;
  let rekeySend;
  let rekeyTtl = 0;
  let rekeyBurn = 0;
  let rekeyPeer = "";
  let adoptedPeerToken = "";
  let watchedPeer = "";
  let offerMode = "hide"; /* hide | new | keyfound */
  let dismissed = new Set();
  let keySent = new Set();
  let keySentAt = new Map(); /* peerKey → when we injected our key */
  let foundKey = "";
  let myKeyCache = "";
  let offerForced = false; /* «У меня уже есть его ключ» — ручная вставка */
  const KEY_FRESH_MS = 10 * 60 * 1000;
  const recentKeys = new Map(); /* token → { at, mine, peer } */
  let myIdentityFp = "";
  const pairEpoch = new Map(); /* peerKey → when this handshake started */
  const staleTokens = new Map(); /* peerKey → Set of keys already in the thread */
  const pairGenReady = new Set(); /* peers whose history we already snapshotted */

  function normalizePersonName(s) {
    return String(s || "")
      .trim()
      .replace(/\s+/g, " ")
      .replace(/[·•].*$/, "")
      .trim()
      .slice(0, 64);
  }

  function namesEqual(a, b) {
    const x = normalizePersonName(a).toLowerCase();
    const y = normalizePersonName(b).toLowerCase();
    return !!x && !!y && x === y;
  }

  /* Own VK/MAX display name — must never become the contact label. */
  function ownAccountName() {
    const sels = [
      "[class*='TopNav'] [class*='OwnerPageName']",
      "[class*='top-nav'] [class*='name']",
      "[data-testid='header-profile']",
      ".HeaderNav__profileName",
      ".top_profile_name",
      "[class*='AccountSwitch'] [class*='name']",
    ];
    for (const s of sels) {
      const el = document.querySelector(s);
      const t = normalizePersonName(el && (el.innerText || el.textContent));
      if (t && t.length > 1 && t.length < 48) return t;
    }
    try {
      const blob = String(document.body && document.body.innerText ? document.body.innerText.slice(0, 4000) : "");
      const m =
        blob.match(/Your account\s*\(([^)]+)\)/i) ||
        blob.match(/Ваш аккаунт\s*\(([^)]+)\)/i) ||
        blob.match(/Это вы[^\n]*\n([^\n]{2,48})/i);
      if (m) {
        const t = normalizePersonName(m[1]);
        if (t && t.length > 1) return t;
      }
    } catch (_) {
      /* ignore */
    }
    return "";
  }

  /* Title of the OPEN dialog only — not the first row in the chat list. */
  function chatTitle() {
    const headerRoots = [
      document.querySelector(".im-page--title"),
      document.querySelector(".im-page--header"),
      document.querySelector(".im-page--title-main") && document.querySelector(".im-page--title-main").closest(".im-page--header, .im-page--title, header, [class*='Header']"),
      document.querySelector("[class*='ConvoHeader']"),
      document.querySelector("[class*='ChatHeader']"),
      document.querySelector("[class*='im-page--chin']") && document.querySelector(".im-page--title-main") && document.querySelector(".im-page--title-main").parentElement,
      document.querySelector("main header"),
      document.querySelector("[role='main'] header"),
    ].filter(Boolean);

    const sels = [
      ".im-page--title-main",
      "[class*='PeerTitle']",
      "[class*='peer-title']",
      "h1",
      "h2",
      "[class*='Title']",
    ];

    function fromRoot(root) {
      for (const s of sels) {
        const el = root.querySelector(s);
        if (!el) continue;
        /* Skip nodes that live inside the left conversation list. */
        if (el.closest && el.closest("[class*='SimpleCell'], [class*='ListItem'], [class*='im-page--dialogs'], [class*='ConversationsList'], [class*='PeerList']")) {
          continue;
        }
        const t = normalizePersonName(el.innerText || el.textContent);
        if (t && t.length > 1 && t.length < 48 && !/^s256/i.test(t) && !/^pairlock/i.test(t)) return t;
      }
      return "";
    }

    for (const root of headerRoots) {
      const t = fromRoot(root);
      if (t) return t;
    }

    /* Last resort: PeerTitle that is NOT inside the dialogs list. */
    const all = document.querySelectorAll("[class*='PeerTitle'], [class*='peer-title'], .im-page--title-main");
    for (const el of all) {
      if (el.closest && el.closest("[class*='im-page--dialogs'], [class*='ConversationsList'], [class*='PeerList'], [class*='SimpleCell']")) continue;
      const t = normalizePersonName(el.innerText || el.textContent);
      if (t && t.length > 1 && t.length < 48 && !/^s256/i.test(t)) return t;
    }
    return "";
  }

  /* Name to store for the other person — never your own account name. */
  function peerDisplayName() {
    const title = chatTitle();
    const own = ownAccountName();
    if (!title) return "";
    if (own && namesEqual(title, own)) return "";
    return title;
  }

  function peerKeyOf(peer) {
    return peer ? peer.platform + ":" + peer.peer : "";
  }

  function keyIdentity(token) {
    const p = String(token || "").split(".");
    if ((p[0] === "S256K1" || p[0] === "S256KT1" || p[0] === "S256KB1") && p[1]) return p[1];
    return "";
  }

  function isMyKeyToken(token) {
    if (!token) return false;
    if (myKeyCache && token === myKeyCache) return true;
    const a = keyIdentity(token);
    const b = keyIdentity(myKeyCache);
    return !!(a && b && a === b);
  }

  function readUnixMs(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 1e9 || n > 2e13) return 0;
    return n < 1e12 ? n * 1000 : n;
  }

  function chatHistoryRoot() {
    const sels = [
      ".im-page--history",
      ".im-page--chat-body",
      "[class*='ConvoHistory']",
      "[class*='MessagesList']",
      "[class*='messages-list']",
      "main [class*='Chat']",
      "[role='log']",
    ];
    for (const s of sels) {
      const el = document.querySelector(s);
      if (el) return el;
    }
    return null;
  }

  function inDialogsList(el) {
    return !!(
      el &&
      el.closest &&
      el.closest(
        "[class*='im-page--dialogs'], [class*='ConversationsList'], [class*='PeerList'], [class*='ChatList']"
      )
    );
  }

  function inOpenChat(node) {
    const el = node && node.nodeType === 3 ? node.parentElement : node;
    if (!el || !el.closest) return false;
    if (el.closest("textarea, input, [contenteditable='true'], [contenteditable='']")) return false;
    if (el.closest("script, style, noscript")) return false;
    if (inDialogsList(el)) return false;
    const hist = chatHistoryRoot();
    if (hist) return hist.contains(el);
    return true;
  }

  function isHistoryRoot(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.getAttribute("role") === "log") return true;
    const c = String(el.className || "");
    return (
      c.indexOf("im-page--history") !== -1 ||
      c.indexOf("im-page--chat-body") !== -1 ||
      c.indexOf("ConvoHistory") !== -1 ||
      c.indexOf("MessagesList") !== -1
    );
  }

  function messageRowOf(node) {
    let el = node && node.nodeType === 3 ? node.parentElement : node;
    for (let i = 0; i < 10 && el; i++, el = el.parentElement) {
      if (isHistoryRoot(el) || inDialogsList(el)) return null;
      const c = String(el.className || "");
      if (el.dataset && (el.dataset.ts || el.dataset.unixtime)) return el;
      if (/\bim-mess\b/.test(c) && c.indexOf("im-mess--") === -1 && c.indexOf("im-mess-stack") === -1) {
        return el;
      }
      if (/MessageBubble|message-in|message-out|Bubble/.test(c) && (el.innerText || "").length < 800) {
        return el;
      }
    }
    return node && node.nodeType === 1 ? node : node && node.parentElement;
  }

  function guessStamp(node) {
    const row = messageRowOf(node);
    if (!row) return 0;
    const ds = row.dataset || {};
    for (const k of ["ts", "unixtime", "unix", "time"]) {
      const ms = readUnixMs(ds[k]);
      if (ms) return ms;
    }
    const attrTs = (row.getAttribute && (row.getAttribute("data-ts") || row.getAttribute("data-unixtime"))) || "";
    const fromAttr = readUnixMs(attrTs);
    if (fromAttr) return fromAttr;
    if (row.tagName === "TIME" && row.dateTime) {
      const d = Date.parse(row.dateTime);
      if (!Number.isNaN(d)) return d;
    }
    const blob = String((row.getAttribute && row.getAttribute("aria-label")) || "").slice(0, 80);
    const local = blob || String(row.innerText || "").slice(0, 80);
    if ((row.innerText || "").length > 400 && !blob) return 0;
    if (/только что|just now|\bсейчас\b/i.test(local)) return Date.now();
    const rel = local.match(/(\d+)\s*(мин(?:ут(?:у|ы|а)?)?|min|сек(?:унд(?:у|ы|а)?)?|sec)/i);
    if (rel) {
      const n = Number(rel[1]);
      const unit = rel[2].toLowerCase();
      const delta = /сек|sec/.test(unit) ? n * 1000 : n * 60000;
      return Date.now() - delta;
    }
    const hm = local.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
    if (hm && (row.innerText || "").length < 220) {
      const d = new Date();
      d.setHours(Number(hm[1]), Number(hm[2]), 0, 0);
      if (d.getTime() > Date.now() + 120000) d.setDate(d.getDate() - 1);
      return d.getTime();
    }
    return 0;
  }

  function keyIssuedMs(token) {
    const p = String(token || "").split(".");
    if (p[0] === "S256KB1" && p[5]) return readUnixMs(p[5]);
    if (p[0] !== "S256KT1" || !p[4]) return 0;
    return readUnixMs(p[4]);
  }

  function stripKeyNoise(s) {
    return String(s || "").replace(/[\u00ad\u200b\u200c\u200d\u2060\ufeff]/g, "");
  }

  function extractKeyTokensFromText(text) {
    const raw = stripKeyNoise(text);
    const compact = raw.replace(/\s+/g, "");
    if (raw.indexOf("S256K") === -1 && compact.indexOf("S256K") === -1) return [];
    const re =
      /S256KB1\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}\.(?:30|60|120)\.(?:0|900|1800|3600|86400|604800)\.\d{10}|S256KT1\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}\.(?:900|1800|3600|86400|604800)\.\d{10}|S256K1\.[A-Za-z0-9_-]{43}/g;
    const out = [];
    function pull(s) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(s))) {
        if (out.indexOf(m[0]) === -1) out.push(m[0]);
      }
    }
    pull(raw);
    pull(compact);
    return out;
  }

  function textForKeyScan(node) {
    const own = node && node.nodeValue ? node.nodeValue : "";
    if (extractKeyTokensFromText(own).length) return own;
    const el = node && (node.nodeType === 1 ? node : node.parentElement);
    if (!el) return own;
    const row = messageRowOf(el) || el;
    return row.innerText || row.textContent || own;
  }

  function resetHandshake(pk) {
    if (!pk) {
      recentKeys.clear();
      keySent.clear();
      keySentAt.clear();
      staleTokens.clear();
      pairEpoch.clear();
      pairGenReady.clear();
      foundKey = "";
      offerForced = false;
      return;
    }
    for (const [k, v] of recentKeys) {
      if (!v.peer || v.peer === pk) recentKeys.delete(k);
    }
    keySent.delete(pk);
    keySentAt.delete(pk);
    staleTokens.delete(pk);
    pairEpoch.delete(pk);
    pairGenReady.delete(pk);
    foundKey = "";
    offerForced = false;
  }

  function collectHistoryKeys() {
    const out = [];
    const root = chatHistoryRoot();
    const scope = root || document.body;
    if (!scope || !scope.querySelectorAll) return out;
    const rows = scope.querySelectorAll(".im-mess[data-ts], .im-mess, [data-ts]");
    const list = rows.length ? rows : [];
    const start = Math.max(0, list.length - 40);
    for (let i = start; i < list.length; i++) {
      const row = list[i];
      if (inDialogsList(row)) continue;
      const tokens = extractKeyTokensFromText(row.innerText || row.textContent || "");
      for (const tok of tokens) out.push({ token: tok, node: row });
    }
    if (!rows.length && scope) {
      const tokens = extractKeyTokensFromText(String(scope.innerText || "").slice(-4000));
      for (const tok of tokens) out.push({ token: tok, node: root || scope });
    }
    return out;
  }

  function snapshotStaleKeys(pk) {
    if (!pk) return;
    if (lastStatus.bound && !lastStatus.bound.expired) return;
    const set = new Set();
    for (const row of collectHistoryKeys()) set.add(row.token);
    staleTokens.set(pk, set);
    pairEpoch.set(pk, Date.now());
    pairGenReady.add(pk);
    for (const [k, v] of recentKeys) {
      if (!v.peer || v.peer === pk) recentKeys.delete(k);
    }
    keySent.delete(pk);
    keySentAt.delete(pk);
    foundKey = "";
    offerForced = false;
    if (offerMode === "keyfound") offerMode = "new";
  }

  function beginHandshakeIfNeeded(pk, st) {
    if (!pk || !st || !st.unlocked) return;
    if (st.bound && !st.bound.expired) {
      pairGenReady.delete(pk);
      return;
    }
    if (!pairGenReady.has(pk)) snapshotStaleKeys(pk);
  }

  function pruneKeys() {
    const now = Date.now();
    for (const [k, v] of recentKeys) {
      if (now - v.at > KEY_FRESH_MS) recentKeys.delete(k);
    }
    for (const [pk, at] of keySentAt) {
      if (now - at > KEY_FRESH_MS) {
        keySentAt.delete(pk);
        keySent.delete(pk);
      }
    }
  }

  function rememberKey(token, at, peerPk, mineHint) {
    if (!token) return;
    const now = Date.now();
    if (!at || now - at > KEY_FRESH_MS || at > now + 120000) return;
    const mine = mineHint === true || isMyKeyToken(token);
    const prev = recentKeys.get(token);
    if (!prev || at >= prev.at) {
      recentKeys.set(token, { at, mine, peer: peerPk || (prev && prev.peer) || "" });
    } else if (prev && peerPk && !prev.peer) {
      prev.peer = peerPk;
    }
  }

  function ingestKeyToken(token, node, pk, live) {
    if (!token || !inOpenChat(node)) return;
    const epoch = pairEpoch.get(pk) || 0;
    const stale = staleTokens.get(pk);
    const isStale = !!(stale && stale.has(token));
    let at = guessStamp(node) || keyIssuedMs(token) || 0;
    if (isStale) {
      /* Same S256K1 can sit in history after a reset. Count it only if this is a NEW bubble. */
      if (at && epoch && at > epoch + 1200) {
        /* resent after handshake start */
      } else if (!at && live && epoch && Date.now() > epoch + 800) {
        at = Date.now();
      } else {
        return;
      }
    } else if (epoch) {
      if (at && at < epoch - 2000) return;
      if (!at) {
        if (live) at = Date.now();
        else return;
      }
    } else if (!at) {
      at = live ? Date.now() : 0;
      if (!at) return;
    }
    if (Date.now() - at > KEY_FRESH_MS) return;
    rememberKey(token, at, pk);
  }

  function harvestKeysFromHistory() {
    const pk = peerKeyOf(detectPeer());
    if (!pk) return;
    for (const row of collectHistoryKeys()) ingestKeyToken(row.token, row.node, pk, false);
  }

  function finalizeKeyScan() {
    const peer = detectPeer();
    const pk = peerKeyOf(peer);
    const prev = foundKey;
    const prevMine = myKeyFresh(pk);
    pruneKeys();
    const next = theirFreshKey(pk);
    foundKey = next;
    if (lastStatus.bound && !lastStatus.bound.expired) {
      /* paired */
    } else if (next && lastStatus.unlocked && peer && !dismissed.has(pk)) {
      offerMode = "keyfound";
    } else if (offerForced) {
      offerMode = "keyfound";
    } else if (offerMode === "keyfound") {
      offerMode = "new";
    }
    if (next !== prev || myKeyFresh(pk) !== prevMine) applyOffer();
  }

  function retagMine() {
    for (const [k, v] of recentKeys) v.mine = isMyKeyToken(k);
  }

  function theirFreshKey(pk) {
    pruneKeys();
    let best = "";
    let at = 0;
    for (const [k, v] of recentKeys) {
      if (pk && v.peer && v.peer !== pk) continue;
      if (v.mine) continue;
      if (v.at >= at) {
        best = k;
        at = v.at;
      }
    }
    return best;
  }

  function myKeyFresh(pk) {
    pruneKeys();
    if (pk && keySentAt.has(pk)) return true;
    for (const v of recentKeys.values()) {
      if (pk && v.peer && v.peer !== pk) continue;
      if (v.mine) return true;
    }
    return false;
  }

  async function ensureMyKey() {
    if (myKeyCache) return myKeyCache;
    const r = await send({ type: "S256_MY_KEY" });
    if (r && r.key) {
      myKeyCache = r.key;
      retagMine();
      const pk = peerKeyOf(detectPeer());
      const was = foundKey;
      foundKey = theirFreshKey(pk);
      if (foundKey !== was) applyOffer();
    }
    return myKeyCache;
  }

  function applyCollapsed() {
    if (!overlay) return;
    barEl.style.display = ui.collapsed ? "none" : "flex";
    extraBox.style.display = "none";
    miniEl.style.display = ui.collapsed ? "flex" : "none";
    applyPanel();
    applyOffer();
    applyPosition();
  }

  /* The shielded composer is offered only when it can actually encrypt: unlocked + bound.
     It sits on top of VK/MAX's own field so you cannot type into the wrong box. */
  function applyPanel() {
    if (!panelEl) return;
    const usable = !!(lastStatus.unlocked && lastStatus.bound);
    const show = usable && !ui.collapsed && ui.composer !== false;
    if (compBtn) {
      compBtn.style.display = usable ? "" : "none";
      compBtn.className = "icon" + (show ? " on-soft" : "");
    }
    if (show) {
      panelTo.textContent = lastStatus.bound.name;
      autosize();
    }
    applyComposerCover();
  }

  function applyComposerCover() {
    if (!composerHost || !panelEl) return;
    const usable = !!(lastStatus.unlocked && lastStatus.bound);
    const show = usable && !ui.collapsed && ui.composer !== false;
    if (!show) {
      composerHost.style.display = "none";
      panelEl.style.display = "none";
      return;
    }
    panelEl.style.display = "flex";
    composerHost.style.display = "block";
    const el = siteComposer();
    const margin = 10;
    if (!el) {
      composerHost.style.left = "50%";
      composerHost.style.right = "auto";
      composerHost.style.top = "auto";
      composerHost.style.bottom = "72px";
      composerHost.style.width = "min(560px, 92vw)";
      composerHost.style.transform = "translateX(-50%)";
      return;
    }
    const r = el.getBoundingClientRect();
    /* Cover the field and the site send button to the right, keep our Send in view. */
    const width = Math.min(window.innerWidth - margin * 2, Math.max(r.width + 96, 280));
    let left = r.left - 6;
    if (left + width > window.innerWidth - margin) left = window.innerWidth - margin - width;
    if (left < margin) left = margin;
    composerHost.style.left = left + "px";
    composerHost.style.right = "auto";
    composerHost.style.width = width + "px";
    composerHost.style.transform = "none";
    composerHost.style.bottom = "auto";
    const h = composerHost.offsetHeight || 92;
    let top = r.top - 8;
    const maxTop = window.innerHeight - h - margin;
    if (top > maxTop) top = maxTop;
    if (top < margin) top = margin;
    composerHost.style.top = top + "px";
  }

  function pairTermsAction(preview) {
    const mineTtl = (lastStatus.keyTtlSec || 0) >>> 0;
    const mineBurn = (lastStatus.keyBurnTtlSec || 0) >>> 0;
    if (!preview) return { label: "Создать пару", adopt: false, peerTtl: 0, peerBurn: 0 };
    const peerTtl = preview.timed ? preview.ttlSec >>> 0 : 0;
    const peerBurn = preview.burn ? preview.burnTtlSec >>> 0 : 0;
    const bits = [];
    if (peerBurn) bits.push("сгорает " + ttlPhrase(peerBurn));
    bits.push(peerTtl ? "ключи " + ttlPhrase(peerTtl) : "бессрочно");
    const differ = peerTtl !== mineTtl || peerBurn !== mineBurn;
    return {
      label: differ ? "Принять: " + bits.join(", ") : "Создать пару",
      adopt: differ,
      peerTtl,
      peerBurn,
    };
  }

  function refreshPairGoButton() {
    if (!shadowRoot) return;
    const go = shadowRoot.getElementById("oaddgo");
    const keyEl = shadowRoot.getElementById("okey");
    if (!go || !keyEl) return;
    const preview = parseKeyPreview(keyEl.value || foundKey || "");
    const act = pairTermsAction(preview);
    go.textContent = act.label;
  }

  function paintChecklist(stage, who) {
    const list = shadowRoot && shadowRoot.getElementById("olist");
    if (!list) return;
    const peer = detectPeer();
    const pk = peerKeyOf(peer);
    const chatOk = isDirectChat(peer);
    const mineOk = !!(pk && myKeyFresh(pk));
    const theirsOk = !!(foundKey || (stage === "pair" && offerForced));
    const pairReady = stage === "pair" && mineOk && theirsOk;
    const rows = [
      [
        "chat",
        chatOk,
        chatOk ? "Чат открыт: «" + (who || "диалог") + "»" : "Откройте личный чат с человеком",
      ],
      ["mine", mineOk, mineOk ? "Ваш ключ ушёл в этот чат" : "Отправьте свой ключ в этот чат"],
      ["theirs", theirsOk, theirsOk ? "Его ключ виден в чате" : "Дождитесь его ключа в этом же чате"],
      ["pair", pairReady, pairReady ? "Оба ключа на месте — можно создать пару" : "Пара — когда оба ключа в чате"],
    ];
    let current = "chat";
    if (chatOk && !mineOk) current = "mine";
    else if (chatOk && mineOk && !theirsOk) current = "theirs";
    else if (chatOk && mineOk && theirsOk) current = "pair";
    if (stage === "expired") {
      list.style.display = "none";
      return;
    }
    list.style.display = "flex";
    list.innerHTML = "";
    for (let i = 0; i < rows.length; i++) {
      const k = rows[i][0];
      const ok = rows[i][1];
      const d = document.createElement("div");
      d.className = "oli" + (ok ? " done" : "") + (k === current && !ok ? " on" : "");
      const box = document.createElement("span");
      box.className = "obox";
      box.textContent = ok ? "✓" : String(i + 1);
      const t = document.createElement("span");
      t.className = "oli-t";
      t.textContent = rows[i][2];
      d.appendChild(box);
      d.appendChild(t);
      list.appendChild(d);
    }
  }

  function setOfferStage(stage) {
    if (!offerEl) return;
    offerEl.dataset.stage = stage;
    const n =
      stage === "needchat" ? 0 : stage === "send" ? 1 : stage === "wait" ? 2 : stage === "pair" ? 3 : 0;
    if (offerKicker) {
      offerKicker.textContent =
        stage === "needchat"
          ? "Сначала чат"
          : stage === "expired"
            ? "Ключи истекли"
            : "Шаг " + n + " из 3";
      offerKicker.style.display = "";
    }
    if (sendKeyBtn) {
      sendKeyBtn.style.display = stage === "pair" || stage === "needchat" ? "none" : "";
      sendKeyBtn.className = stage === "wait" ? "ghost" : "primary";
      sendKeyBtn.textContent =
        stage === "expired"
          ? "Отправить новый ключ в этот чат"
          : stage === "wait"
            ? "Отправить ключ ещё раз"
            : "Отправить ключ в этот чат";
    }
    if (haveKeyBtn) haveKeyBtn.style.display = stage === "send" || stage === "wait" ? "" : "none";
    if (bindPickBtn) {
      const hasPeople = !!(lastStatus.contacts && lastStatus.contacts.length);
      bindPickBtn.style.display = stage === "send" && hasPeople ? "" : "none";
    }
    const ob = offerEl.querySelector("#ob");
    if (ob) ob.style.display = stage === "pair" || stage === "needchat" ? "none" : "flex";
  }

  function applyOffer() {
    if (!offerEl) return;
    const peer = detectPeer();
    const pk = peerKeyOf(peer);
    const expired = !!(lastStatus.bound && lastStatus.bound.expired);
    const direct = isDirectChat(peer);
    const needChat = lastStatus.unlocked && !lastStatus.bound && !expired && !direct;
    const show =
      !ui.collapsed &&
      lastStatus.unlocked &&
      (expired ||
        (needChat && !dismissed.has("__home__")) ||
        (direct &&
          !lastStatus.bound &&
          (offerMode === "keyfound" || (!dismissed.has(pk) && offerMode !== "hide"))));
    offerEl.style.display = show ? "flex" : "none";
    if (show) {
      const title = peerDisplayName() || chatTitle();
      const who = title ? title : "этот чат";
      const okeyWrap = shadowRoot.getElementById("okeywrap");
      const okeyHint = shadowRoot.getElementById("okeyhint");
      if (expired) {
        setOfferStage("expired");
        offerTitle.textContent = "Срок ключей вышел";
        offerDesc.textContent =
          "Сессия с «" + who + "» стёрта. Откройте этот же чат и отправьте новый ключ. Другие чаты на месте.";
        offerAdd.style.display = "none";
      } else if (needChat) {
        setOfferStage("needchat");
        offerTitle.textContent = peer && !direct ? "Нужна личная переписка" : "Сначала откройте чат";
        offerDesc.textContent = peer && !direct
          ? "Это беседа. Pairlock сопрягает только личный диалог — один на один. Откройте чат с человеком слева."
          : "Зайдите в личную переписку с человеком (не список чатов). Ключ уйдёт в открытую ленту — без этого пары не будет.";
        offerAdd.style.display = "none";
      } else if (offerMode === "keyfound") {
        setOfferStage("pair");
        offerTitle.textContent = foundKey ? "Его ключ уже в чате" : "Вставьте его ключ";
        offerDesc.textContent = !myKeyFresh(pk)
          ? "Чеклист: ваш ключ ещё не уходил в этот чат. Нажмите синюю кнопку — потом создайте пару."
          : "Оба ключа в этом чате. Проверьте имя и нажмите зелёную кнопку.";
        offerAdd.style.display = "flex";
        if (foundKey) shadowRoot.getElementById("okey").value = foundKey;
        const oname = shadowRoot.getElementById("oname");
        if (oname && title && !oname.value) oname.value = title;
        if (okeyWrap) okeyWrap.style.display = offerForced ? "flex" : "none";
        if (okeyHint) {
          okeyHint.style.display = foundKey && !offerForced ? "" : "none";
          okeyHint.textContent = "Ключ считан из ленты чата. VK/MAX видят его как обычное сообщение — это нормально.";
        }
        refreshPairGoButton();
      } else if (myKeyFresh(pk)) {
        setOfferStage("wait");
        offerTitle.textContent = "Ждём его ключ в этом чате";
        offerDesc.textContent =
          "Напишите человеку: пусть тоже откроет этот диалог и нажмёт «отправить ключ» в Pairlock. Когда его ключ появится в ленте — шаг сменится сам.";
        offerAdd.style.display = "none";
      } else {
        setOfferStage("send");
        offerTitle.textContent = "Ключ в чат с «" + who + "»";
        offerDesc.textContent =
          "Выберите срок ключей и сгорание сообщений, затем отправьте ключ в эту ленту. Это не пароль. Друг примет ваши условия или пришлёт свои.";
        offerAdd.style.display = "none";
      }
      if (okeyWrap && offerMode !== "keyfound") okeyWrap.style.display = "none";
      paintChecklist(offerEl.dataset.stage, who);
    }
    applyRekey();
  }

  function applyRekey() {
    const chips = rekeyChips || (shadowRoot && shadowRoot.getElementById("rchips"));
    const burnChips = shadowRoot && shadowRoot.getElementById("bchips");
    const sendBtn = rekeySend || (shadowRoot && shadowRoot.getElementById("rsend"));
    const note = rekeyDesc || (shadowRoot && shadowRoot.getElementById("rd"));
    const lab = shadowRoot && shadowRoot.getElementById("rlab");
    const blab = shadowRoot && shadowRoot.getElementById("blab");
    const go = shadowRoot && shadowRoot.getElementById("oaddgo");
    rekeyChips = chips;
    rekeySend = sendBtn;
    rekeyDesc = note;
    if (!chips) return;
    const offerOn = !!(offerEl && offerEl.style.display !== "none");
    const stage = (offerEl && offerEl.dataset.stage) || "";
    const pickTtl = offerOn && (stage === "send" || stage === "wait" || stage === "expired" || stage === "keyfound");
    const showChips = pickTtl && stage !== "needchat";
    chips.style.display = showChips ? "flex" : "none";
    if (burnChips) burnChips.style.display = showChips ? "flex" : "none";
    if (lab) lab.style.display = showChips ? "" : "none";
    if (blab) blab.style.display = showChips ? "" : "none";
    if (note) note.style.display = offerOn ? "" : "none";
    if (!offerOn) {
      if (sendBtn) sendBtn.style.display = "none";
      return;
    }
    if (stage === "needchat") {
      chips.style.display = "none";
      if (burnChips) burnChips.style.display = "none";
      if (lab) lab.style.display = "none";
      if (blab) blab.style.display = "none";
      if (note) note.style.display = "none";
      if (sendBtn) sendBtn.style.display = "none";
      return;
    }
    const pk = peerKeyOf(detectPeer());
    const keyEl = shadowRoot.getElementById("okey");
    const preview = parseKeyPreview(foundKey || (keyEl && keyEl.value) || "");
    if (pk !== rekeyPeer) {
      rekeyPeer = pk;
      adoptedPeerToken = "";
      rekeyTtl = (lastStatus.keyTtlSec || 0) >>> 0;
      rekeyBurn = (lastStatus.keyBurnTtlSec || 0) >>> 0;
    }
    if (offerMode === "keyfound" && preview && preview.token !== adoptedPeerToken) {
      adoptedPeerToken = preview.token;
      rekeyTtl = preview.timed ? preview.ttlSec >>> 0 : 0;
      rekeyBurn = preview.burn ? preview.burnTtlSec >>> 0 : 0;
    }
    const ttlOpts = [
      [0, "бессрочно"],
      [900, "15 мин"],
      [3600, "1 час"],
      [86400, "сутки"],
      [604800, "неделя"],
    ];
    const burnOpts = [
      [0, "не сгорает"],
      [30, "30 с"],
      [60, "1 мин"],
      [120, "2 мин"],
    ];
    function fillChips(box, opts, current, setVal) {
      if (!box || !showChips) return;
      box.innerHTML = "";
      for (const [sec, label] of opts) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "rchip" + (current === sec ? " on" : "");
        b.textContent = label;
        b.addEventListener("click", (e) => {
          e.stopPropagation();
          setVal(sec);
          applyRekey();
        });
        box.appendChild(b);
      }
    }
    fillChips(chips, ttlOpts, rekeyTtl, (sec) => {
      rekeyTtl = sec;
    });
    fillChips(burnChips, burnOpts, rekeyBurn, (sec) => {
      rekeyBurn = sec;
    });
    const hisTtl = preview ? (preview.timed ? ttlPhrase(preview.ttlSec) : "бессрочно") : "";
    const hisBurn = preview && preview.burn ? ttlPhrase(preview.burnTtlSec) : "не сгорает";
    const his = preview ? hisTtl + ", " + hisBurn : "";
    const sameAsHim =
      !!preview &&
      rekeyTtl === (preview.timed ? preview.ttlSec >>> 0 : 0) &&
      rekeyBurn === (preview.burn ? preview.burnTtlSec >>> 0 : 0);
    const mineInChat = myKeyFresh(pk);
    if (offerMode === "keyfound" && preview) {
      if (!mineInChat) {
        if (sendBtn) {
          sendBtn.style.display = "block";
          sendBtn.className = "primary";
          sendBtn.textContent = sameAsHim ? "Принять его условия и отправить ключ" : "Отправить свои условия";
        }
        if (note)
          note.textContent = sameAsHim
            ? "Он предлагает: " + his + ". Чипы уже стоят как у него. Можно принять или выбрать своё и отправить другой ключ."
            : "Вы предлагаете другие условия. Отправьте свой ключ — он увидит их и сможет принять.";
        if (go) {
          go.style.display = "none";
          go.className = "ghost-go";
        }
      } else {
        if (sendBtn) sendBtn.style.display = "none";
        if (note) note.textContent = "В чате оба ключа. Пара возьмёт условия из его ключа: " + his + ".";
        if (go) {
          go.style.display = "";
          go.className = "";
          go.textContent = pairTermsAction(preview).label;
        }
      }
    } else {
      if (sendBtn) sendBtn.style.display = "none";
      if (go) {
        go.style.display = "";
        go.className = "";
      }
      if (note)
        note.textContent =
          "Срок — как долго живёт пара. Сгорание — сколько фраза читается после открытия (30 с / 1 мин / 2 мин). Если у друга другие условия — на шаге 3 примете или ответите своими.";
    }
  }

  async function applyOfferTerms() {
    const ttl = rekeyTtl >>> 0;
    const burn = rekeyBurn >>> 0;
    const r = await send({
      type: "S256_SET_PAIR_MODE",
      mode: ttl > 0 ? "safe" : "forever",
      ttlSec: ttl,
    });
    if (!r || !r.ok) {
      paint((r && r.error) || "не удалось выставить срок", false);
      return false;
    }
    const b = await send({ type: "S256_SET_BURN_TTL", ttlSec: burn });
    if (!b || !b.ok) {
      paint((b && b.error) || "не удалось выставить сгорание", false);
      return false;
    }
    lastStatus.keyTtlSec = ttl;
    lastStatus.keyBurnTtlSec = burn;
    return true;
  }

  async function sendRekey() {
    if (!(await applyOfferTerms())) return;
    await sendMyKey();
  }

  async function sendShielded() {
    if (!scField) return;
    const text = scField.value;
    if (!text.trim()) return;
    const peer = detectPeer();
    if (!peer || !lastStatus.bound || !lastStatus.unlocked) {
      paint("чат не привязан — сообщение НЕ отправлено", false);
      return;
    }
    if (isKeyPacket(text)) {
      pauseCoverUntil = Date.now() + 900;
      window.postMessage({ source: DST_HOOK, type: "inject-send", text: text.trim() }, "*");
      scField.value = "";
      autosize();
      return;
    }
    scField.disabled = true;
    try {
      const res = await send({ type: "S256_ENCRYPT", text, platform: peer.platform, peer: peer.peer });
      if (!res || !res.ok || !(res.packets || res.text)) {
        paint(
          res && res.code === "expired"
            ? "срок ключей вышел — сообщение НЕ отправлено"
            : "не удалось зашифровать — сообщение НЕ отправлено",
          false
        );
        return;
      }
      const packets = res.packets && res.packets.length ? res.packets : [res.text];
      await injectPackets(packets);
      if (packets.length > 1) paint("длинное · отправлено " + packets.length + " частями", true);
      scField.value = "";
      autosize();
    } finally {
      scField.disabled = false;
      setTimeout(() => scField && scField.focus(), 250);
    }
  }

  function ensureComposerHost() {
    if (composerHost) return;
    composerHost = document.createElement("div");
    composerHost.style.all = "initial";
    composerHost.style.position = "fixed";
    composerHost.style.zIndex = "2147483645";
    composerHost.style.fontFamily = 'system-ui, "Segoe UI", sans-serif';
    composerHost.style.display = "none";
    const cshadow = composerHost.attachShadow({ mode: "closed" });
    cshadow.innerHTML = `
      <style>
        .panel {
          display: flex; flex-direction: column; gap: 6px;
          width: 100%; box-sizing: border-box;
          background: #17212b; color: #fff;
          border: 2px solid #3dd68c; border-radius: 16px;
          padding: 8px 10px; box-shadow: 0 12px 40px rgba(0,0,0,.55);
          font-size: 12px;
        }
        .ph { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
        .ph b { color: #3dd68c; }
        .ph .grow { flex: 1; min-width: 0; color: #c5d4e0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .muted { color: #8fa1b3; }
        .line { display: flex; align-items: flex-end; gap: 8px; }
        textarea {
          all: initial; display: block; flex: 1; min-width: 0; box-sizing: border-box;
          font: 14px/1.4 system-ui, "Segoe UI", sans-serif; color: #fff;
          background: #0f1720; border: 1px solid rgba(61,214,140,.45); border-radius: 12px;
          padding: 8px 10px; resize: none; height: 36px; max-height: 160px; overflow-y: auto;
          outline: none; caret-color: #3dd68c;
        }
        textarea:focus { border-color: #3dd68c; }
        textarea::placeholder { color: #6d7f8f; }
        button.send {
          flex: 0 0 auto; border: 0; border-radius: 999px; padding: 9px 14px;
          background: #3dd68c; color: #0b1a12; font-weight: 700; cursor: pointer; font-size: 12px;
          white-space: nowrap; align-self: stretch;
        }
        button.chat {
          flex: 0 0 auto; border: 1px solid rgba(148,186,214,.28); border-radius: 999px;
          padding: 4px 10px; background: transparent; color: #d7e6f2;
          font-weight: 700; cursor: pointer; font-size: 11px; white-space: nowrap;
        }
        button.chat:hover { border-color: #3db4f2; color: #fff; }
      </style>
      <div class="panel" id="panel">
        <div class="ph">
          <b>Пишите здесь</b>
          <span class="grow" id="pto"></span>
          <button type="button" class="chat" id="sc-chat" title="Открыть чат Pairlock">Чат</button>
        </div>
        <div class="line">
          <textarea id="sc" rows="1" placeholder="Enter — отправить"></textarea>
          <button class="send" id="scs" type="button">Отправить 🔒</button>
        </div>
      </div>
    `;
    panelEl = cshadow.getElementById("panel");
    panelTo = cshadow.getElementById("pto");
    scField = cshadow.getElementById("sc");
    const sendBtn = cshadow.getElementById("scs");
    sendBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      sendShielded();
    });
    const chatBtn = cshadow.getElementById("sc-chat");
    chatBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (lastStatus.bound && lastStatus.bound.id) floatChatId = lastStatus.bound.id;
      setChatOpen(true);
    });
    document.documentElement.appendChild(composerHost);
  }

  function makeDraggable(handle) {
    let startX = 0;
    let startY = 0;
    let origX = 0;
    let origY = 0;
    let moved = false;
    let dragging = false;
    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      if (e.target && e.target.closest && e.target.closest("button, textarea, input, a")) return;
      dragging = true;
      moved = false;
      const rect = overlay.getBoundingClientRect();
      origX = rect.left;
      origY = rect.top;
      startX = e.clientX;
      startY = e.clientY;
      handle.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    handle.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
      if (!moved) return;
      ui.x = origX + dx;
      ui.y = origY + dy;
      applyPosition();
    });
    const stop = () => {
      if (!dragging) return;
      dragging = false;
      if (moved) saveUi();
    };
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
    return () => moved;
  }

  function initials(name) {
    const s = String(name || "?").trim();
    const parts = s.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0].charAt(0) + parts[1].charAt(0)).toUpperCase();
    return (s.slice(0, 2) || "?").toUpperCase();
  }

  function fmtTime(ts) {
    if (!ts) return "";
    const d = new Date(ts);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) {
      return d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
    }
    return d.toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
  }

  function msgsNearBottom(el) {
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 72;
  }

  function syncFloatJump() {
    const jump = chatShadow && chatShadow.getElementById("jump");
    const body = chatShadow && chatShadow.getElementById("body");
    if (!jump) return;
    const show = !!(floatChatId && body && !msgsNearBottom(body));
    jump.classList.toggle("show", show);
  }

  function applyChatPosition() {
    if (!chatHost || chatHost.style.display === "none") return;
    const w = chatHost.offsetWidth || 360;
    const h = chatHost.offsetHeight || 480;
    let x = ui.chatX;
    let y = ui.chatY;
    if (x == null || y == null) {
      x = Math.max(12, window.innerWidth - w - 16);
      y = 64;
    }
    x = Math.min(Math.max(0, x), Math.max(0, window.innerWidth - w));
    y = Math.min(Math.max(0, y), Math.max(0, window.innerHeight - 64));
    chatHost.style.left = x + "px";
    chatHost.style.top = y + "px";
  }

  function setChatOpen(on) {
    ui.chatOpen = !!on;
    saveUi();
    if (ui.chatOpen) {
      if (!floatChatId && lastStatus.bound && lastStatus.bound.id) floatChatId = lastStatus.bound.id;
      ensureChatHost();
      chatHost.style.display = "block";
      applyChatPosition();
      paintFloatChat();
      if (!chatPoll) chatPoll = setInterval(paintFloatChat, 2000);
    } else {
      if (chatHost) chatHost.style.display = "none";
      if (chatPoll) {
        clearInterval(chatPoll);
        chatPoll = null;
      }
    }
    if (winBtn) winBtn.className = "ghost" + (ui.chatOpen ? " on" : "");
  }

  function ensureChatHost() {
    if (chatHost) return;
    chatHost = document.createElement("div");
    chatHost.style.all = "initial";
    chatHost.style.position = "fixed";
    chatHost.style.zIndex = "2147483646";
    chatHost.style.fontFamily = 'system-ui, "Segoe UI", sans-serif';
    chatHost.style.display = "none";
    chatShadow = chatHost.attachShadow({ mode: "closed" });
    chatShadow.innerHTML = `
      <style>
        .win {
          position: relative;
          width: 400px; height: min(560px, 78vh); display: flex; flex-direction: column;
          background: #0c1622; color: #f4f8fc;
          border: 1px solid rgba(148,186,214,.16); border-radius: 16px;
          box-shadow: 0 18px 50px rgba(0,0,0,.55); overflow: hidden;
        }
        .hd {
          display: flex; align-items: center; gap: 8px;
          padding: 10px 10px 10px 8px; background: #121c2a;
          border-bottom: 1px solid rgba(148,186,214,.12);
          cursor: grab; user-select: none; flex-shrink: 0;
        }
        .hd:active { cursor: grabbing; }
        .ava {
          width: 32px; height: 32px; border-radius: 50%;
          background: #245a86; display: grid; place-items: center;
          font-weight: 800; font-size: 11px; color: #eef7fd; flex-shrink: 0;
        }
        .ttl { flex: 1; min-width: 0; font-weight: 750; font-size: 14px; }
        .sub { color: #7f96aa; font-size: 11px; font-weight: 500; margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        button {
          border: 0; border-radius: 10px; background: #1a2738; color: #fff;
          font: 700 13px system-ui; cursor: pointer; padding: 6px 8px;
        }
        button.icon { background: transparent; color: #8fa1b3; font-size: 16px; line-height: 1; padding: 4px 6px; }
        button.icon:hover { color: #fff; }
        .body { flex: 1; min-height: 0; overflow-y: auto; }
        .jump {
          position: absolute; right: 14px; bottom: 62px; z-index: 4;
          width: 38px; height: 38px; border-radius: 50%; padding: 0;
          background: #2aabee; color: #fff; font-size: 18px; line-height: 1;
          display: none; place-items: center;
          box-shadow: 0 8px 22px rgba(0,0,0,.4);
        }
        .jump.show { display: grid; }
        .row {
          display: flex; align-items: center; gap: 10px; width: 100%;
          text-align: left; background: transparent; border: 0; border-radius: 0;
          border-bottom: 1px solid rgba(148,186,214,.1); padding: 10px 12px; color: inherit;
          font: inherit; cursor: pointer;
        }
        .row:hover { background: rgba(61,180,242,.08); }
        .meta { flex: 1; min-width: 0; }
        .top { display: flex; justify-content: space-between; gap: 8px; }
        .name { font-weight: 750; font-size: 14px; }
        .time { color: #7f96aa; font-size: 11px; flex-shrink: 0; }
        .prev { color: #7f96aa; font-size: 12px; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .msgs { display: flex; flex-direction: column; gap: 4px; padding: 10px 10px; min-height: 100%; }
        .msg { width: fit-content; max-width: 92%; padding: 8px 12px 6px; border-radius: 14px; font-size: 14px; line-height: 1.45; word-break: break-word; overflow-wrap: anywhere; }
        .msg.in { align-self: flex-start; background: #152433; border: 1px solid rgba(148,186,214,.12); border-bottom-left-radius: 4px; }
        .msg.out { align-self: flex-end; background: #2b5278; border-bottom-right-radius: 4px; }
        .mb { white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; font-weight: 450; }
        .st { margin-top: 2px; font-size: 11px; opacity: .72; }
        .msg.out .st { text-align: right; color: rgba(238,247,253,.75); }
        .empty { margin: auto; color: #7f96aa; font-size: 13px; text-align: center; padding: 28px 16px; line-height: 1.45; }
        .lock { padding: 18px 14px 12px; display: flex; flex-direction: column; gap: 8px; }
        .lock p { color: #7f96aa; font-size: 13px; line-height: 1.45; margin: 0 0 4px; }
        .lock label { color: #9eb6c9; font-size: 12px; font-weight: 650; }
        .lock input {
          all: unset; display: block; box-sizing: border-box; width: 100%;
          font: 14px/1.4 system-ui, sans-serif; color: #fff;
          background: #1a2738; border: 1px solid rgba(148,186,214,.16); border-radius: 12px;
          padding: 9px 10px;
        }
        .lock .go { background: #2aabee; border-radius: 999px; padding: 9px 12px; margin-top: 4px; }
        .cbar { display: flex; gap: 8px; align-items: flex-end; padding: 8px 10px 10px; border-top: 1px solid rgba(148,186,214,.12); flex-shrink: 0; }
        textarea {
          all: initial; display: block; flex: 1; min-width: 0; box-sizing: border-box;
          font: 14px/1.4 system-ui, sans-serif; color: #fff;
          background: #1a2738; border: 1px solid rgba(148,186,214,.16); border-radius: 14px;
          padding: 8px 10px; resize: none; height: 38px; max-height: 160px; overflow-y: auto;
          outline: none;
        }
        .send {
          width: 38px; height: 38px; border-radius: 50%; padding: 0;
          background: #3db4f2; color: #041018; display: grid; place-items: center; flex-shrink: 0;
        }
        .send svg { width: 16px; height: 16px; fill: #041018; }
        .hint { color: #f0b429; font-size: 11px; padding: 0 12px 8px; display: none; }
        button.ghost.on { background: #2aabee; }
        .vf {
          padding: 12px 14px 16px; display: flex; flex-direction: column; gap: 10px;
          overflow: auto; height: 100%; box-sizing: border-box;
        }
        .vf h3 { margin: 0; font-size: 15px; color: #fff; font-weight: 800; }
        .vf p { margin: 0; color: #9eb2c4; font-size: 12px; line-height: 1.4; }
        .fp {
          background: #121a24; border: 1px solid rgba(148,186,214,.14); border-radius: 12px;
          padding: 10px 12px;
        }
        .fp .l { color: #7be3b0; font-size: 11px; font-weight: 700; margin-bottom: 4px; }
        .fp .c {
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          font-size: 15px; letter-spacing: 0.08em; color: #fff; word-break: break-all;
        }
        .vf .row { display: flex; flex-wrap: wrap; gap: 6px; }
        .vf button { border-radius: 12px; padding: 8px 12px; font-size: 12px; }
        .vf button.danger { background: #e35d6a; color: #fff; }
        button.verify-btn {
          background: #242f3d; color: #f6d27a; font-size: 11px; padding: 4px 8px;
          border-radius: 10px; flex-shrink: 0; font-weight: 700;
        }
      </style>
      <div class="win">
        <div class="hd" id="hd">
          <button class="icon" id="back" style="display:none" type="button">←</button>
          <div class="ava" id="ava">S</div>
          <div style="flex:1;min-width:0">
            <div class="ttl" id="ttl">Чаты</div>
            <div class="sub" id="sub"></div>
          </div>
          <button class="verify-btn" id="vfbtn" type="button" style="display:none" title="Сверить коды голосом">Сверить</button>
          <button class="icon" id="close" type="button" title="Закрыть">×</button>
        </div>
        <div class="body" id="body"></div>
        <button class="jump" id="jump" type="button" title="К последним">↓</button>
        <div class="cbar" id="cbar" style="display:none">
          <textarea id="ct" rows="1" placeholder="Сообщение"></textarea>
          <button class="send" id="cs" type="button" title="Отправить">
            <svg viewBox="0 0 24 24"><path d="M3.4 20.4l17.4-8.4L3.4 3.6 3 10.3l11 1.7-11 1.7z"/></svg>
          </button>
        </div>
        <div class="hint" id="hint"></div>
      </div>
    `;
    const hd = chatShadow.getElementById("hd");
    chatShadow.getElementById("close").addEventListener("click", (e) => {
      e.stopPropagation();
      setChatOpen(false);
    });
    chatShadow.getElementById("back").addEventListener("click", (e) => {
      e.stopPropagation();
      floatChatId = null;
      floatVerify = false;
      paintFloatChat();
    });
    chatShadow.getElementById("vfbtn").addEventListener("click", (e) => {
      e.stopPropagation();
      floatVerify = !floatVerify;
      paintFloatChat();
    });
    chatShadow.getElementById("cs").addEventListener("click", (e) => {
      e.stopPropagation();
      sendFloatChat();
    });
    let startX = 0;
    let startY = 0;
    let origX = 0;
    let origY = 0;
    let dragging = false;
    let moved = false;
    hd.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      if (e.target && e.target.closest && e.target.closest("button")) return;
      dragging = true;
      moved = false;
      const rect = chatHost.getBoundingClientRect();
      origX = rect.left;
      origY = rect.top;
      startX = e.clientX;
      startY = e.clientY;
      hd.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    hd.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
      if (!moved) return;
      ui.chatX = origX + dx;
      ui.chatY = origY + dy;
      applyChatPosition();
    });
    const stop = () => {
      if (!dragging) return;
      dragging = false;
      if (moved) saveUi();
    };
    hd.addEventListener("pointerup", stop);
    hd.addEventListener("pointercancel", stop);
    const bodyEl = chatShadow.getElementById("body");
    const jumpEl = chatShadow.getElementById("jump");
    bodyEl.addEventListener("scroll", () => {
      floatStick = msgsNearBottom(bodyEl);
      syncFloatJump();
    });
    jumpEl.addEventListener("click", (e) => {
      e.stopPropagation();
      floatStick = true;
      floatForceBottom = false;
      bodyEl.scrollTop = bodyEl.scrollHeight;
      syncFloatJump();
    });
    document.documentElement.appendChild(chatHost);
    window.addEventListener("resize", applyChatPosition);
  }

  async function paintFloatChat() {
    if (!ui.chatOpen || !chatShadow) return;
    const body = chatShadow.getElementById("body");
    const ttl = chatShadow.getElementById("ttl");
    const sub = chatShadow.getElementById("sub");
    const ava = chatShadow.getElementById("ava");
    const back = chatShadow.getElementById("back");
    const cbar = chatShadow.getElementById("cbar");
    const hint = chatShadow.getElementById("hint");
    const vfbtn = chatShadow.getElementById("vfbtn");
    if (vfbtn) vfbtn.style.display = "none";
    const st = await send({ type: "S256_STATUS" });
    if (st && st.ok === false) {
      ttl.textContent = "Pairlock";
      sub.textContent = "нет связи";
      ava.textContent = "!";
      back.style.display = "none";
      cbar.style.display = "none";
      syncFloatJump();
      body.textContent = "";
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = st.error || "Обновите страницу VK/MAX (F5)";
      body.appendChild(empty);
      return;
    }
    if (!st || !st.unlocked) {
      ttl.textContent = "Pairlock";
      sub.textContent = st && st.hasVault === false ? "первый запуск" : "заблокировано";
      ava.textContent = "S";
      back.style.display = "none";
      cbar.style.display = "none";
      syncFloatJump();
      const first = !!(st && st.hasVault === false);
      const existing = chatShadow.getElementById("pw");
      /* keep typed password, but rebuild if create/unlock mode is wrong */
      if (existing) {
        const hasPw2 = !!chatShadow.getElementById("pw2");
        if (hasPw2 === first) return;
      }
      hint.style.display = "none";
      hint.textContent = "";
      body.textContent = "";
      const box = document.createElement("div");
      box.className = "lock";
      const p = document.createElement("p");
      p.textContent = first
        ? "Придумайте пароль хранилища. Его спрашивают только на этом компьютере."
        : "Введите пароль хранилища, чтобы открыть чаты.";
      box.appendChild(p);
      const lab = document.createElement("label");
      lab.textContent = "Пароль";
      box.appendChild(lab);
      const pw = document.createElement("input");
      pw.id = "pw";
      pw.type = "password";
      pw.autocomplete = first ? "new-password" : "current-password";
      box.appendChild(pw);
      if (first) {
        const lab2 = document.createElement("label");
        lab2.textContent = "Ещё раз";
        box.appendChild(lab2);
        const pw2 = document.createElement("input");
        pw2.id = "pw2";
        pw2.type = "password";
        pw2.autocomplete = "new-password";
        box.appendChild(pw2);
      }
      const go = document.createElement("button");
      go.className = "go";
      go.type = "button";
      go.textContent = first ? "Создать ключи" : "Открыть";
      go.addEventListener("click", (e) => {
        e.stopPropagation();
        unlockFloat();
      });
      box.appendChild(go);
      body.appendChild(box);
      setTimeout(() => pw.focus(), 0);
      return;
    }
    if (!floatChatId) {
      const list = await send({ type: "S256_CHAT_LIST" });
      ttl.textContent = "Чаты";
      ttl.onclick = null;
      ttl.style.cursor = "";
      ttl.title = "";
      sub.textContent = "";
      ava.textContent = "P";
      back.style.display = "none";
      cbar.style.display = "none";
      hint.style.display = "none";
      body.textContent = "";
      syncFloatJump();
      const chats = (list && list.chats) || [];
      if (!chats.length) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent =
          "Пока никого. Откройте диалог в VK/MAX и следуйте плашке Pairlock внизу: ключ → его ключ → создать пару → сверьте коды в этом окне.";
        body.appendChild(empty);
        return;
      }
      for (const c of chats) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "row";
        const a = document.createElement("div");
        a.className = "ava";
        a.textContent = initials(c.name);
        const meta = document.createElement("div");
        meta.className = "meta";
        const top = document.createElement("div");
        top.className = "top";
        const nm = document.createElement("span");
        nm.className = "name";
        nm.textContent = c.name;
        const tm = document.createElement("span");
        tm.className = "time";
        tm.textContent = fmtTime(c.lastTs);
        top.appendChild(nm);
        top.appendChild(tm);
        const prev = document.createElement("div");
        prev.className = "prev";
        prev.textContent = c.lastText ? (c.lastOutgoing ? "Вы: " : "") + c.lastText : c.fingerprint || "";
        meta.appendChild(top);
        meta.appendChild(prev);
        row.appendChild(a);
        row.appendChild(meta);
        row.addEventListener("click", () => {
          floatChatId = c.id;
          floatStick = true;
          floatForceBottom = true;
          paintFloatChat();
        });
        body.appendChild(row);
      }
      return;
    }
    const got = await send({ type: "S256_CHAT_THREAD", contactId: floatChatId });
    if (!got || !got.ok || !got.thread) {
      floatChatId = null;
      paintFloatChat();
      return;
    }
    const t = got.thread;
    const c = t.contact;
    ttl.textContent = c.name + (c.verified ? " ✓" : "");
    sub.textContent =
      (c.fingerprint || "") +
      (t.session && t.session.burnTtlSec ? " · сгорает " + ttlPhrase(t.session.burnTtlSec) : "");
    ava.textContent = initials(c.name);
    ttl.style.cursor = "pointer";
    ttl.title = "Нажмите, чтобы переименовать";
    ttl.onclick = async (e) => {
      e.stopPropagation();
      const next = window.prompt("Имя собеседника (как в VK)", c.name);
      if (next == null) return;
      const nm = String(next).trim();
      if (!nm || nm === c.name) return;
      const ren = await send({ type: "S256_RENAME", contactId: c.id, name: nm });
      if (ren && ren.ok) {
        await paintFloatChat();
        refreshStatus();
      } else {
        paint((ren && ren.error) || "не удалось переименовать", false);
      }
    };
    back.style.display = "";
    if (vfbtn) {
      if (c.verified) {
        vfbtn.style.display = "none";
        floatVerify = false;
      } else {
        vfbtn.style.display = "";
        vfbtn.textContent = floatVerify ? "К чату" : "Сверить";
      }
    }

    if (floatVerify && !c.verified) {
      cbar.style.display = "none";
      hint.style.display = "none";
      body.textContent = "";
      syncFloatJump();
      const me = await send({ type: "S256_MY_KEY" });
      const myFp = (me && me.fingerprint) || "—";
      const box = document.createElement("div");
      box.className = "vf";
      box.innerHTML =
        "<h3>Сверьте коды голосом</h3>" +
        "<p>Позвоните или спросите лично — не в этом же чате. Прочитайте коды вслух. Совпали — это он.</p>";
      const mkFp = (label, code) => {
        const el = document.createElement("div");
        el.className = "fp";
        el.innerHTML = "<div class='l'></div><div class='c'></div>";
        el.querySelector(".l").textContent = label;
        el.querySelector(".c").textContent = code;
        return el;
      };
      box.appendChild(mkFp("Ваш код — читаете вы", myFp));
      box.appendChild(mkFp("Его код — читает он · " + c.name, c.fingerprint || "—"));
      const row = document.createElement("div");
      row.className = "row";
      const match = document.createElement("button");
      match.type = "button";
      match.textContent = "Коды совпали";
      match.addEventListener("click", async (e) => {
        e.stopPropagation();
        const r = await send({ type: "S256_SET_VERIFIED", contactId: c.id, verified: true });
        if (!r || !r.ok) {
          paint((r && r.error) || "не удалось сохранить", false);
          return;
        }
        floatVerify = false;
        paint(c.name + " · коды сверены", true);
        await paintFloatChat();
        refreshStatus();
      });
      const bad = document.createElement("button");
      bad.type = "button";
      bad.className = "danger";
      bad.textContent = "Не совпали";
      bad.addEventListener("click", async (e) => {
        e.stopPropagation();
        const r = await send({ type: "S256_REMOVE_CONTACT", contactId: c.id });
        if (!r || !r.ok) {
          paint((r && r.error) || "не удалось сбросить", false);
          return;
        }
        floatVerify = false;
        floatChatId = null;
        paint("Пара сброшена — ключ могли подменить", false);
        await paintFloatChat();
        refreshStatus();
      });
      const later = document.createElement("button");
      later.type = "button";
      later.className = "ghost";
      later.textContent = "Позже";
      later.addEventListener("click", (e) => {
        e.stopPropagation();
        floatVerify = false;
        paintFloatChat();
      });
      row.appendChild(match);
      row.appendChild(bad);
      row.appendChild(later);
      box.appendChild(row);
      body.appendChild(box);
      return;
    }

    cbar.style.display = "flex";
    const keepTop = body.scrollTop;
    const stick = floatForceBottom || floatStick || msgsNearBottom(body);
    body.textContent = "";
    const msgs = document.createElement("div");
    msgs.className = "msgs";
    const list = t.messages || [];
    if (!list.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = c.verified
        ? "Напишите первым"
        : "Напишите первым. Сначала лучше сверьте коды — кнопка «Сверить» сверху.";
      msgs.appendChild(empty);
    } else {
      for (const m of list) {
        const el = document.createElement("div");
        el.className = "msg " + (m.outgoing ? "out" : "in");
        const mb = document.createElement("div");
        mb.className = "mb";
        mb.textContent = m.burned ? "● сгорело" : m.text || "";
        const stm = document.createElement("div");
        stm.className = "st";
        const left = m.burnAt && !m.burned ? Math.max(0, Math.ceil((m.burnAt - Date.now()) / 1000)) : 0;
        stm.textContent = fmtTime(m.ts) + (left ? " · сгорит через " + left + " с" : "");
        el.appendChild(mb);
        el.appendChild(stm);
        msgs.appendChild(el);
      }
    }
    body.appendChild(msgs);
    if (stick) {
      body.scrollTop = body.scrollHeight;
      floatForceBottom = false;
      floatStick = true;
    } else {
      body.scrollTop = keepTop;
      floatStick = false;
    }
    syncFloatJump();
    const peer = detectPeer();
    const binds = c.bindings || {};
    const live = !!(peer && binds[peer.platform] && String(binds[peer.platform]) === String(peer.peer));
    if (live) {
      hint.style.display = "none";
      hint.textContent = "";
    } else {
      hint.style.display = "block";
      hint.textContent = "Откройте этот диалог в VK/MAX — тогда сообщение уйдёт туда. Здесь оно уже есть.";
    }
  }

  async function unlockFloat() {
    const pw = chatShadow && chatShadow.getElementById("pw");
    const pw2 = chatShadow && chatShadow.getElementById("pw2");
    const hint = chatShadow && chatShadow.getElementById("hint");
    if (!pw) return;
    const password = pw.value;
    if (pw2 && password !== pw2.value) {
      if (hint) {
        hint.style.display = "block";
        hint.textContent = "Пароли не совпали";
      }
      return;
    }
    /* decide create vs unlock from vault, not from leftover pw2 field */
    const st = await send({ type: "S256_STATUS" });
    if (!st || st.ok === false) {
      if (hint) {
        hint.style.display = "block";
        hint.textContent = (st && st.error) || "Нет связи с Pairlock — обновите страницу (F5)";
      }
      return;
    }
    const needCreate = st.hasVault === false;
    if (needCreate && !pw2) {
      if (hint) {
        hint.style.display = "block";
        hint.textContent = "Нужно создать хранилище — обновите окно чата";
      }
      await paintFloatChat();
      return;
    }
    if (!needCreate && pw2) {
      if (hint) {
        hint.style.display = "block";
        hint.textContent = "Хранилище уже есть — введите только пароль открытия";
      }
      await paintFloatChat();
      return;
    }
    const res = await send({ type: needCreate ? "S256_CREATE" : "S256_UNLOCK", password });
    if (!res || !res.ok) {
      if (hint) {
        hint.style.display = "block";
        hint.textContent = (res && res.error) || "Неверный пароль";
      }
      return;
    }
    if (hint) {
      hint.style.display = "none";
      hint.textContent = "";
    }
    await refreshStatus();
    await paintFloatChat();
  }

  async function sendFloatChat() {
    const ta = chatShadow && chatShadow.getElementById("ct");
    if (!ta || !floatChatId) return;
    const text = ta.value;
    if (!String(text).trim()) return;
    ta.value = "";
    ta.style.height = "";
    floatStick = true;
    floatForceBottom = true;
    const res = await send({ type: "S256_CHAT_SEND", contactId: floatChatId, text: text.trim() });
    if (!res || !res.ok) {
      ta.value = text;
      const hint = chatShadow.getElementById("hint");
      if (hint) {
        hint.style.display = "block";
        hint.textContent = (res && res.error) || "не отправилось";
      }
      return;
    }
    const peer = detectPeer();
    const binds = res.bindings || {};
    const packets = res.packets && res.packets.length ? res.packets : res.packet ? [res.packet] : [];
    if (peer && binds[peer.platform] && String(binds[peer.platform]) === String(peer.peer)) {
      await injectPackets(packets);
    }
    if (packets.length > 1) {
      const hint = chatShadow.getElementById("hint");
      if (hint) {
        hint.style.display = "block";
        hint.textContent = "Длинное сообщение · " + packets.length + " частей в VK";
      }
    }
    await paintFloatChat();
  }

  function ensureOverlay() {
    if (overlay) return;
    overlay = document.createElement("div");
    overlay.style.all = "initial";
    overlay.style.position = "fixed";
    overlay.style.zIndex = "2147483646";
    overlay.style.fontFamily = 'system-ui, "Segoe UI", sans-serif';
    overlay.style.touchAction = "none";
    const shadow = overlay.attachShadow({ mode: "closed" });
    shadowRoot = shadow;
    shadow.innerHTML = `
      <style>
        .wrap { display: flex; flex-direction: column; align-items: center; gap: 8px; }
        .bar {
          display: flex; align-items: center; gap: 10px;
          background: #17212b; color: #fff;
          border: 1px solid rgba(255,255,255,.06); border-radius: 999px;
          padding: 6px 8px 6px 14px;
          box-shadow: 0 12px 40px rgba(0,0,0,.4);
          font-size: 12px; max-width: 92vw; cursor: grab; user-select: none;
        }
        .bar:active { cursor: grabbing; }
        .wrap.side { align-items: stretch; }
        .wrap.side .bar {
          flex-direction: column; align-items: stretch; gap: 8px;
          border-radius: 20px; padding: 10px 8px; max-width: 168px; width: 168px;
        }
        .wrap.side #t { white-space: normal; text-align: center; line-height: 1.35; max-width: 152px; }
        .wrap.side .bar button { width: 100%; }
        .wrap.side .offer { width: min(340px, 88vw); }
        .wrap.side #extra { flex-direction: column; }
        b { color: #2aabee; font-weight: 700; }
        button {
          border: 0; border-radius: 999px; padding: 6px 10px;
          background: #2aabee; color: #fff; font-weight: 700; cursor: pointer; font-size: 12px;
        }
        button.ghost { background: #242f3d; color: #fff; }
        button.ghost.on { background: #2aabee; }
        button.icon { background: transparent; color: #6d7f8f; padding: 4px 6px; font-size: 14px; line-height: 1; }
        button.icon:hover { color: #fff; }
        button.icon.on { background: #f0b429; color: #17212b; }
        button.icon.on-soft { color: #2aabee; }
        .muted { color: #6d7f8f; }
        #extra { display: none; gap: 6px; flex-wrap: wrap; justify-content: center; }
        .offer {
          display: none; flex-direction: column; gap: 10px;
          width: min(380px, 92vw); box-sizing: border-box;
          background: #121c28; color: #fff;
          border: 1px solid rgba(61,180,242,.22); border-radius: 18px;
          padding: 14px 14px 12px; box-shadow: 0 16px 40px rgba(0,0,0,.5);
          font-size: 13px; line-height: 1.4;
          overflow: hidden; min-width: 0;
        }
        .offer .oh { display: flex; align-items: flex-start; gap: 8px; }
        .offer .oh-left { min-width: 0; flex: 1; }
        .offer .okicker {
          font-size: 10px; font-weight: 800; letter-spacing: .08em;
          text-transform: uppercase; color: #3db4f2; margin-bottom: 3px;
        }
        .offer .ot { font-weight: 800; font-size: 16px; letter-spacing: -.02em; color: #f4f8fc; line-height: 1.25; }
        .offer .od { color: #8aa0b3; font-size: 13px; line-height: 1.45; font-weight: 500; }
        .offer .osteps { display: none; }
        .offer .olist { display: flex; flex-direction: column; gap: 6px; margin: 2px 0 4px; }
        .offer .oli {
          display: flex; align-items: flex-start; gap: 8px;
          padding: 8px 10px; border-radius: 12px;
          background: rgba(255,255,255,.03); border: 1px solid rgba(255,255,255,.05);
          color: #8aa0b3; font-size: 12px; font-weight: 650; line-height: 1.35;
        }
        .offer .oli.on { background: rgba(42,171,238,.12); border-color: rgba(42,171,238,.35); color: #e8f4fc; }
        .offer .oli.done { color: #7be3b0; border-color: rgba(61,214,140,.22); background: rgba(61,214,140,.08); }
        .offer .obox {
          flex-shrink: 0; width: 18px; height: 18px; margin-top: 1px; border-radius: 50%;
          display: flex; align-items: center; justify-content: center;
          font-size: 10px; font-weight: 800;
          background: rgba(255,255,255,.08); color: #8aa0b3;
        }
        .offer .oli.on .obox { background: #2aabee; color: #fff; }
        .offer .oli.done .obox { background: #2bb673; color: #fff; }
        .offer .oli-t { min-width: 0; }
        .offer #okeyhint { color: #6d7f8f; font-size: 12px; line-height: 1.4; }
        .offer .os {
          flex: 1; text-align: center; padding: 5px 4px; border-radius: 999px;
          font-size: 10px; font-weight: 750; color: #6d7f8f;
          background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.06);
        }
        .offer .os.done { color: #3dd68c; border-color: rgba(61,214,140,.28); }
        .offer .os.on { color: #fff; background: #2aabee; border-color: #2aabee; }
        .offer .ob, .offer .op, .offer #oadd {
          display: flex; flex-direction: column; gap: 8px;
          min-width: 0; width: 100%;
        }
        .offer #oadd { display: none; }
        .offer button.primary, .offer #oaddgo, .offer #rsend {
          display: block; width: 100%; box-sizing: border-box;
          border: 0; border-radius: 12px; padding: 11px 14px;
          background: #2aabee; color: #fff; font-weight: 800; cursor: pointer; font-size: 14px;
        }
        .offer #oaddgo { background: #2bb673; }
        .offer #oaddgo.ghost-go { background: #1b2734; color: #c5d4e0; font-size: 13px; padding: 9px 12px; }
        .offer #rlab { display: none; }
        .offer button.ghost {
          width: 100%; box-sizing: border-box; border: 0; border-radius: 12px; padding: 9px 12px;
          background: #1b2734; color: #c5d4e0; font-weight: 650; cursor: pointer; font-size: 13px;
        }
        .offer button.link, .offer #later {
          border: 0; background: transparent; color: #6d7f8f; font-weight: 650;
          cursor: pointer; font-size: 12px; padding: 4px 2px;
        }
        .offer #later { flex-shrink: 0; width: 28px; height: 28px; border-radius: 50%; font-size: 14px; color: #8aa0b3; }
        .offer #later:hover { background: rgba(255,255,255,.06); color: #fff; }
        .offer .olab { font-size: 11px; font-weight: 700; color: #6d7f8f; letter-spacing: .04em; text-transform: uppercase; }
        .offer input, .offer textarea {
          all: unset; display: block; width: 100%; box-sizing: border-box; min-width: 0;
          font: 13px/1.4 system-ui, sans-serif; color: #fff;
          background: #0f1720; border: 1px solid rgba(255,255,255,.08); border-radius: 10px;
          padding: 8px 10px; white-space: pre-wrap; overflow-wrap: anywhere;
        }
        .offer textarea { min-height: 44px; max-height: 72px; overflow: auto; }
        .offer .rchips { display: flex; flex-wrap: wrap; gap: 6px; }
        .offer .rchip {
          border: 1px solid rgba(255,255,255,.1); background: #1b2734; color: #c5d4e0;
          border-radius: 999px; padding: 6px 10px; font-size: 12px; font-weight: 700; cursor: pointer;
        }
        .offer .rchip.on { background: #2aabee; color: #fff; border-color: #2aabee; }
        .mini {
          display: none; align-items: center; justify-content: center;
          width: 34px; height: 34px; border-radius: 50%;
          background: #17212b; border: 1px solid rgba(255,255,255,.08);
          box-shadow: 0 8px 24px rgba(0,0,0,.4); cursor: grab; font-size: 16px; user-select: none;
        }
        .mini.ok { box-shadow: 0 0 0 2px rgba(61,214,140,.6), 0 8px 24px rgba(0,0,0,.4); }
        .mini.warn { box-shadow: 0 0 0 2px rgba(240,180,41,.7), 0 8px 24px rgba(0,0,0,.4); }
      </style>
      <div class="wrap">
        <div class="offer" id="offer">
          <div class="oh">
            <div class="oh-left">
              <div class="okicker" id="okicker">Шаг 1 из 3</div>
              <div class="ot" id="ot">Создать пару</div>
            </div>
            <button class="link" id="later" title="Позже">✕</button>
          </div>
          <div class="olist" id="olist"></div>
          <div class="od" id="od">Сначала откройте личный чат с человеком.</div>
          <div class="olab" id="rlab">Срок пары</div>
          <div class="rchips" id="rchips"></div>
          <div class="olab" id="blab">Сгорание сообщений</div>
          <div class="rchips" id="bchips"></div>
          <div class="od" id="rd"></div>
          <div class="ob" id="ob">
            <button id="sendkey" class="primary">Отправить ключ в этот чат</button>
            <button class="ghost" id="havekey">Вставить его ключ вручную</button>
            <button class="link" id="bindpick">Уже есть пара</button>
          </div>
          <div class="op" id="opick" style="display:none"></div>
          <div id="oadd" style="display:none">
            <span class="olab">Имя в вашей записной</span>
            <input id="oname" type="text" placeholder="Как его зовут" />
            <div id="okeyhint"></div>
            <div id="okeywrap" style="display:none">
              <span class="olab">Его ключ</span>
              <textarea id="okey" placeholder="S256K1.… / S256KT1.… / S256KB1.…"></textarea>
            </div>
            <button class="primary" id="rsend">Отправить мой ключ</button>
            <button id="oaddgo">Создать пару</button>
          </div>
        </div>
        <div class="bar" id="bar">
          <span id="t">Pairlock</span>
          <button id="a" class="ghost" style="display:none">Привязать</button>
          <button id="win" class="ghost" title="Открыть чат">Чат</button>
          <button id="comp" class="icon" title="Защищённый ввод" style="display:none">✎</button>
          <button id="raw" class="icon" title="Показать как видит сервер VK/MAX" style="display:none">👁</button>
          <button id="min" class="icon" title="Свернуть">–</button>
        </div>
        <div id="extra"></div>
        <div class="mini" id="mini" title="Pairlock — развернуть">🔒</div>
      </div>
    `;
    overlayText = shadow.getElementById("t");
    actionBtn = shadow.getElementById("a");
    winBtn = shadow.getElementById("win");
    extraBox = shadow.getElementById("extra");
    barEl = shadow.getElementById("bar");
    miniEl = shadow.getElementById("mini");
    const minBtn = shadow.getElementById("min");
    rawBtn = shadow.getElementById("raw");
    offerEl = shadow.getElementById("offer");
    offerTitle = shadow.getElementById("ot");
    offerDesc = shadow.getElementById("od");
    offerKicker = shadow.getElementById("okicker");
    offerSteps = shadow.getElementById("olist");
    offerPick = shadow.getElementById("opick");
    offerAdd = shadow.getElementById("oadd");
    sendKeyBtn = shadow.getElementById("sendkey");
    haveKeyBtn = shadow.getElementById("havekey");
    bindPickBtn = shadow.getElementById("bindpick");
    rekeyChips = shadow.getElementById("rchips");
    rekeyDesc = shadow.getElementById("rd");
    rekeySend = shadow.getElementById("rsend");
    compBtn = shadow.getElementById("comp");
    ensureComposerHost();

    shadow.getElementById("sendkey").addEventListener("click", (e) => {
      e.stopPropagation();
      sendMyKey();
    });
    if (rekeySend)
      rekeySend.addEventListener("click", (e) => {
        e.stopPropagation();
        sendRekey();
      });
    shadow.getElementById("later").addEventListener("click", (e) => {
      e.stopPropagation();
      const pk = peerKeyOf(detectPeer());
      if (pk) dismissed.add(pk);
      else dismissed.add("__home__");
      offerForced = false;
      offerMode = "hide";
      applyOffer();
    });
    shadow.getElementById("havekey").addEventListener("click", (e) => {
      e.stopPropagation();
      offerForced = true;
      offerMode = "keyfound";
      applyOffer();
    });
    shadow.getElementById("bindpick").addEventListener("click", (e) => {
      e.stopPropagation();
      const list = (lastStatus.contacts || []).slice();
      offerPick.innerHTML = "";
      if (!list.length) {
        paint("Сначала добавьте контакт в расширении", false);
        return;
      }
      offerPick.style.display = "flex";
      for (const c of list) {
        const b = document.createElement("button");
        b.textContent = c.name;
        b.addEventListener("click", async () => {
          const peer = detectPeer();
          if (!peer) return;
          await send({ type: "S256_BIND", contactId: c.id, platform: peer.platform, peer: peer.peer });
          offerMode = "hide";
          await refreshStatus();
        });
        offerPick.appendChild(b);
      }
    });
    shadow.getElementById("oaddgo").addEventListener("click", async (e) => {
      e.stopPropagation();
      const peer = detectPeer();
      if (!myKeyFresh(peerKeyOf(peer))) {
        paint("сначала отправьте свой ключ в чат — иначе пара будет только с одной стороны", false);
        applyRekey();
        return;
      }
      const name = shadow.getElementById("oname").value || peerDisplayName() || "Контакт";
      const preview = parseKeyPreview(shadow.getElementById("okey").value || foundKey || "");
      const key = preview && preview.token;
      if (!key) {
        paint("ключ в поле битый или обрезан — скопируйте S256K1./S256KT1./S256KB1. целиком", false);
        return;
      }
      const act = pairTermsAction(preview);
      const res = await send({
        type: "S256_ADD_AND_BIND",
        name,
        key,
        platform: peer && peer.platform,
        peer: peer && peer.peer,
        adoptTerms: true,
      });
      if (!res || !res.ok) {
        paint((res && res.error) || "не удалось добавить", false);
        return;
      }
      foundKey = "";
      offerMode = "hide";
      floatChatId = res.id;
      floatVerify = true;
      setChatOpen(true);
      const adopted =
        res.adoptedTtl != null
          ? res.adoptedTtl > 0
            ? " · принят срок " + ttlPhrase(res.adoptedTtl)
            : " · принят бессрочный"
          : act.adopt
            ? " · условия приняты"
            : "";
      paint(res.name + " · пара создана" + adopted + ". Сверьте коды голосом", true);
      await refreshStatus();
      /* If our key still isn't in the last 10 minutes, send it so the other side can finish. */
      if (!myKeyFresh(peerKeyOf(peer))) {
        try {
          await sendMyKey();
        } catch {
          /* non-fatal */
        }
      }
      await paintFloatChat();
    });
    const okeyEl = shadow.getElementById("okey");
    if (okeyEl) {
      okeyEl.addEventListener("input", () => {
        refreshPairGoButton();
        applyRekey();
      });
    }

    winBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      setChatOpen(!ui.chatOpen);
    });
    compBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      ui.composer = ui.composer === false;
      saveUi();
      applyPanel();
      applyPosition();
      if (ui.composer !== false) setTimeout(() => scField && scField.focus(), 0);
    });
    rawBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      setRawMode(!rawMode);
    });

    minBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      ui.collapsed = true;
      saveUi();
      applyCollapsed();
    });
    const miniMoved = makeDraggable(miniEl);
    miniEl.addEventListener("click", () => {
      if (miniMoved()) return;
      ui.collapsed = false;
      saveUi();
      applyCollapsed();
    });
    makeDraggable(barEl);
    window.addEventListener("resize", applyPosition);

    actionBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const peer = detectPeer();
      if (currentAction === "unbind") {
        if (lastStatus.bound && peer) {
          await send({ type: "S256_UNBIND", contactId: lastStatus.bound.id, platform: peer.platform });
          await refreshStatus();
        }
        return;
      }
      const st = await send({ type: "S256_STATUS" });
      if (!st || !st.unlocked) {
        paint("Разблокируйте Pairlock в иконке расширения", false);
        return;
      }
      if (!st.contacts || !st.contacts.length) {
        paint("Сначала добавьте контакт в расширении", false);
        return;
      }
      const pick = async (contactId, name) => {
        extraBox.style.display = "none";
        extraBox.innerHTML = "";
        if (!peer) {
          await send({ type: "S256_BIND_NEXT", contactId });
          paint("Жду сообщение — привяжу к «" + name + "»", true);
          return;
        }
        await send({ type: "S256_BIND", contactId, platform: peer.platform, peer: peer.peer });
        await refreshStatus();
      };
      if (st.contacts.length === 1) {
        await pick(st.contacts[0].id, st.contacts[0].name);
        return;
      }
      extraBox.style.display = "flex";
      extraBox.innerHTML = "";
      for (const c of st.contacts) {
        const b = document.createElement("button");
        b.textContent = c.name;
        b.addEventListener("click", () => pick(c.id, c.name));
        extraBox.appendChild(b);
      }
      paint("с кем этот чат?", true);
    });
    document.documentElement.appendChild(overlay);
    applyCollapsed();
  }

  /* action: "bind" | "unbind" | null — which button (if any) makes sense right now */
  function setAction(action) {
    currentAction = action;
    if (!actionBtn) return;
    if (!action) {
      actionBtn.style.display = "none";
      return;
    }
    actionBtn.style.display = "";
    actionBtn.textContent = action === "bind" ? "Привязать" : "Отвязать";
    actionBtn.className = action === "bind" ? "" : "ghost";
  }

  /* "Server view": undo every decryption on the page and stop decrypting until toggled back,
     so the user sees exactly what VK/MAX (and anyone reading their logs) sees. Session-only. */
  let rawMode = false;
  let rawBtn;
  const replaced = new Map(); /* text node -> original ciphertext-bearing value */

  function applyRawBtn() {
    if (!rawBtn) return;
    const show = !!lastStatus.pageDecrypt;
    rawBtn.style.display = show ? "" : "none";
    if (!show && rawMode) {
      rawMode = false;
      rawBtn.className = "icon";
    }
  }

  function setRawMode(on) {
    if (!lastStatus.pageDecrypt) {
      rawMode = false;
      applyRawBtn();
      return;
    }
    rawMode = !!on;
    if (rawBtn) {
      rawBtn.className = "icon" + (rawMode ? " on" : "");
      rawBtn.title = rawMode ? "Вернуть расшифровку" : "Показать как видит сервер VK/MAX";
    }
    if (rawMode) {
      for (const [node, original] of replaced) {
        if (node.isConnected) node.nodeValue = original;
      }
      replaced.clear();
    } else {
      scheduleScan();
    }
    refreshStatus();
  }

  function pageWritesPlain() {
    return !!lastStatus.pageDecrypt && !rawMode;
  }

  function revertPagePlain() {
    for (const [node, original] of replaced) {
      if (node.isConnected) node.nodeValue = original;
    }
    replaced.clear();
  }

  function paint(text, ok, action) {
    ensureOverlay();
    applyRawBtn();
    const safe = String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    const stealth = !lastStatus.pageDecrypt;
    const prefix = rawMode
      ? "<span style='color:#f0b429;font-weight:700'>👁 вид сервера</span> · "
      : stealth
        ? "<span style='color:#7be3b0;font-weight:700'>текст в расширении</span> · "
        : "";
    overlayText.innerHTML = ok
      ? "<b>Pairlock</b> · " + prefix + safe
      : "<b>Pairlock</b> · " + prefix + "<span class='muted'>" + safe + "</span>";
    if (action !== undefined) setAction(action);
    miniEl.className = "mini " + (ok ? "ok" : "warn");
    miniEl.title = "Pairlock · " + String(text);
    applyPanel();
    applyOffer();
    applyPosition();
  }

  async function sendMyKey() {
    const peer = detectPeer();
    if (!peer) return;
    if (!(await applyOfferTerms())) return;
    const res = await send({ type: "S256_MY_KEY" });
    if (!res || !res.ok || !res.key) {
      paint("не удалось взять ключ — разблокируйте Pairlock", false);
      return;
    }
    myKeyCache = res.key;
    const pk = peerKeyOf(peer);
    rememberKey(res.key, Date.now(), pk, true);
    pauseCoverUntil = Date.now() + 900;
    window.postMessage({ source: DST_HOOK, type: "inject-send", text: res.key }, "*");
    keySent.add(pk);
    keySentAt.set(pk, Date.now());
    if (theirFreshKey(pk)) paint("ваш ключ в чате · можно сопрягать", true);
    else paint("ключ отправлен · жду ключ в ответ", true);
    applyOffer();
  }

  function noteChatSwitch(peer, st) {
    const pk = peerKeyOf(peer);
    if (!pk || pk === watchedPeer) return;
    watchedPeer = pk;
    if (st && st.unlocked && !(st.bound && !st.bound.expired)) beginHandshakeIfNeeded(pk, st);
    foundKey = theirFreshKey(pk);
    offerForced = false;
    offerPick && (offerPick.style.display = "none");
    if (!st || !st.unlocked) {
      offerMode = "hide";
      return;
    }
    if (st.bound) {
      offerMode = "hide";
      return;
    }
    if (foundKey && !dismissed.has(pk)) offerMode = "keyfound";
    else offerMode = dismissed.has(pk) ? "hide" : "new";
    if (ui.collapsed) {
      ui.collapsed = false;
      applyCollapsed();
    }
  }

  function collectKeyTextNodes(root, out) {
    if (!root) return out;
    if (root.nodeType === 3) {
      const v = root.nodeValue || "";
      if (v.indexOf("S256K") !== -1) out.push(root);
      return out;
    }
    if (root.nodeType !== 1) return out;
    const it = document.createNodeIterator(root, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = it.nextNode())) {
      const v = n.nodeValue || "";
      if (v.indexOf("S256K") !== -1) out.push(n);
    }
    return out;
  }

  function scanKeys(nodes, live) {
    const pk = peerKeyOf(detectPeer());
    if (pk && lastStatus.unlocked && !(lastStatus.bound && !lastStatus.bound.expired)) {
      beginHandshakeIfNeeded(pk, lastStatus);
    }
    for (const n of nodes || []) {
      if (!inOpenChat(n)) continue;
      const tokens = extractKeyTokensFromText(textForKeyScan(n));
      for (const tok of tokens) ingestKeyToken(tok, n, pk, !!live);
    }
    harvestKeysFromHistory();
    finalizeKeyScan();
  }

  async function refreshStatus() {
    const peer = detectPeer();
    const st = await send({
      type: "S256_STATUS",
      platform: peer && peer.platform,
      peer: peer && peer.peer,
    });
    lastStatus = st || { unlocked: false };
    if (st && st.ok && st.unlocked && st.myFingerprint) {
      if (myIdentityFp && myIdentityFp !== st.myFingerprint) {
        resetHandshake();
        myKeyCache = "";
      }
      myIdentityFp = st.myFingerprint;
    }
    const pkNow = peerKeyOf(peer);
    if (st && st.ok && st.unlocked) beginHandshakeIfNeeded(pkNow, st);
    if (st && st.ok && st.unlocked) await ensureMyKey();
    applyRawBtn();
    pushStateToHook();
    paintComposer();
    noteChatSwitch(peer, lastStatus);
    applyOffer();
    if (!st || !st.ok) {
      paint("нет связи с фоном", false, null);
      return;
    }
    if (!st.unlocked) {
      paint("заблокировано — нажмите «Чат» и введите пароль. Сейчас текст уходит ОТКРЫТЫМ", false, null);
      return;
    }
    if (!st.pageDecrypt && replaced.size) revertPagePlain();
    if (st.bound) {
      offerMode = "hide";
      /* Fix wrong label: name was often taken from the chat LIST (same for everyone)
         or even from your own account. Re-read the OPEN dialog title and rename. */
      const liveName = peerDisplayName();
      const own = ownAccountName();
      const cur = st.bound.name || "";
      const looksWrong =
        !!liveName &&
        !namesEqual(liveName, cur) &&
        (namesEqual(cur, own) ||
          !cur ||
          cur === "Контакт" ||
          cur === "Contact" ||
          /* same display name on two different keys — keep syncing from the open dialog */
          (st.contacts || []).filter((c) => namesEqual(c.name, cur)).length > 1);
      if (looksWrong) {
        const ren = await send({ type: "S256_RENAME", contactId: st.bound.id, name: liveName });
        if (ren && ren.ok && ren.name) st.bound.name = ren.name;
      }
      if (st.bound.expired) {
        paint(st.bound.name + " · срок ключей вышел — обменяйтесь новыми", false, "unbind");
        return;
      }
      const left = st.bound.expiresAt ? st.bound.expiresAt - Date.now() : 0;
      const ttlBit = st.bound.ttlSec
        ? (left < 5 * 60 * 1000
          ? " · ключи " + ttlPhrase(st.bound.ttlSec) + ", скоро истекут"
          : " · ключи " + ttlPhrase(st.bound.ttlSec) + " до " + new Date(st.bound.expiresAt).toLocaleString("ru-RU", { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" }))
        : "";
      const burnBit = st.bound.burnTtlSec ? " · сгорает через " + ttlPhrase(st.bound.burnTtlSec) + " после прочтения" : "";
      const tail = st.pageDecrypt
        ? (st.bound.verified ? "🔒 шифруется" : "🔒 шифруется · отпечаток не сверен")
        : "🔒 шифруется · текст в «Чате», на странице каша";
      paint(st.bound.name + " · " + tail + ttlBit + burnBit, true, "unbind");
      return;
    }
    if (!peer) {
      paint("откройте личный диалог — Pairlock работает внутри чата", false, null);
      return;
    }
    if (!isDirectChat(peer)) {
      paint("откройте личный чат, не беседу", false, null);
      return;
    }
    scanKeys([]);
    if (st.contacts && st.contacts.length === 1) {
      paint("чат НЕ шифруется — привяжите к " + st.contacts[0].name + " или отправьте ключ", false, "bind");
      return;
    }
    paint("чат НЕ шифруется — отправьте ключ или привяжите контакт", false, "bind");
  }

  /* Auto-bind: if the open, unbound chat shows incoming ciphertext from exactly one
     known contact, this chat is theirs. Wrong guesses only cost the peer a
     non-decryptable bubble; they never leak plaintext. */
  const seenIncoming = new Map(); /* peerKey -> Set(contactId) */
  let autoBindBusy = false;

  async function maybeAutoBind(peer, contactId) {
    if (!peer || !contactId || autoBindBusy) return;
    const key = peer.platform + ":" + peer.peer;
    if (!seenIncoming.has(key)) seenIncoming.set(key, new Set());
    seenIncoming.get(key).add(contactId);
    if (lastStatus.bound) return;
    const ids = seenIncoming.get(key);
    if (ids.size !== 1) return;
    autoBindBusy = true;
    try {
      const st = await send({ type: "S256_STATUS", platform: peer.platform, peer: peer.peer });
      if (st && st.ok && st.unlocked && !st.bound) {
        await send({ type: "S256_BIND", contactId, platform: peer.platform, peer: peer.peer });
        await refreshStatus();
      }
    } finally {
      autoBindBusy = false;
    }
  }

  window.addEventListener("message", async (ev) => {
    if (ev.source !== window || !ev.data || ev.data.source !== SRC_HOOK) return;
    const msg = ev.data;
    if (msg.type === "notify") {
      paint(msg.text, !!msg.ok);
      setTimeout(refreshStatus, 4000);
      return;
    }
    if (msg.type === "confirm-req") {
      showConfirm(msg);
      return;
    }
    if (msg.type === "max-peer") {
      lastPeer = { platform: "max", peer: String(msg.peer) };
      refreshStatus();
      return;
    }
    if (msg.type === "encrypt-req") {
      const res = await send({
        type: "S256_ENCRYPT",
        text: msg.text,
        platform: msg.platform,
        peer: msg.peer,
      });
      const packets = res && res.packets && res.packets.length ? res.packets : res && res.text ? [res.text] : [];
      window.postMessage(
        {
          source: DST_HOOK,
          type: "encrypt-res",
          id: msg.id,
          ok: !!(res && res.ok),
          text: packets[0] || (res && res.text),
          packets,
          error: res && res.error,
          code: res && res.code,
        },
        "*"
      );
      if (res && res.ok) refreshStatus();
      return;
    }
    if (msg.type === "multi-send") {
      await injectPackets(msg.packets || []);
      if ((msg.packets || []).length > 1) paint("длинное · " + msg.packets.length + " частей", true);
      return;
    }
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === "S256_GET_PEER") {
      const peer = detectPeer();
      sendResponse(peer || { platform: platformOf(location.hostname), peer: null });
      return;
    }
    if (msg && msg.type === "S256_INJECT") {
      if (window !== window.top) return;
      const peer = detectPeer();
      const binds = msg.bindings || {};
      if (!peer || !peer.peer) {
        sendResponse({ ok: false, noChat: true });
        return;
      }
      const want = binds[peer.platform];
      if (!want || String(want) !== String(peer.peer)) {
        sendResponse({ ok: false, wrongChat: !!want });
        return;
      }
      const text = String(msg.text || "").trim();
      if (!isCipherPacket(text) && !isKeyPacket(text)) {
        sendResponse({ ok: false, error: "not-cipher" });
        return;
      }
      pauseCoverUntil = Date.now() + 900;
      window.postMessage({ source: DST_HOOK, type: "inject-send", text }, "*");
      sendResponse({ ok: true });
      return;
    }
  });

  const decryptCache = new Map();
  const ingested = new Set();

  function harvestPackets(tokens) {
    const fresh = [];
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (!token || ingested.has(token)) continue;
      ingested.add(token);
      fresh.push(token);
    }
    if (ingested.size > 2500) {
      const keep = tokens.slice(-400);
      ingested.clear();
      for (let i = 0; i < keep.length; i++) ingested.add(keep[i]);
    }
    if (!fresh.length) return;
    send({ type: "S256_INGEST", packets: fresh }).then((r) => {
      if (!r || !r.ok || !r.contactIds) return;
      const peer = detectPeer();
      for (let i = 0; i < r.contactIds.length; i++) maybeAutoBind(peer, r.contactIds[i]);
    });
  }

  async function decryptToken(token) {
    if (decryptCache.has(token)) return decryptCache.get(token);
    const res = await send({ type: "S256_DECRYPT", text: token });
    if (!res || !res.ok || res.skipped || typeof res.text !== "string") return null;
    if (res.burned) {
      const dead = "🔒 ● сгорело";
      decryptCache.set(token, dead);
      return dead;
    }
    if (res.burnAt) return null;
    let out = res.text;
    /* Every decrypted bubble gets a visible marker so the user can tell it was encrypted. */
    if (!res.outgoing && !res.known) out = "⚠︎ [неизвестный ключ] " + out;
    else if (!res.outgoing && !res.verified) out = "🔒◦ " + out;
    else out = "🔒 " + out;
    decryptCache.set(token, out);
    if (!res.outgoing && res.known && res.contactId) maybeAutoBind(detectPeer(), res.contactId);
    return out;
  }

  function skipDecrypt(node) {
    if (!node || !node.parentElement) return true;
    const el = node.parentElement;
    if (el.closest("textarea, input, [contenteditable='true'], [contenteditable='']")) return true;
    if (el.closest("script, style, noscript")) return true;
    return false;
  }

  async function scan(root) {
    if (!lastStatus.unlocked) return;
    const writeDom = pageWritesPlain();
    /* forget nodes React has already thrown away */
    if (replaced.size > 2000) {
      for (const node of replaced.keys()) if (!node.isConnected) replaced.delete(node);
    }
    const walker = document.createTreeWalker(root || document.body, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) {
      const n = walker.currentNode;
      if (skipDecrypt(n)) continue;
      if (!n.nodeValue) continue;
      if (
        n.nodeValue.indexOf(PREFIX) !== -1 ||
        n.nodeValue.indexOf("S256K") !== -1 ||
        extractCipherTokens(n.nodeValue).length
      ) {
        nodes.push(n);
      }
    }
    const harvested = [];
    for (const n of nodes) {
      const s = n.nodeValue;
      const tokens = extractCipherTokens(s);
      if (n.nodeValue.indexOf("S256K1.") !== -1 || n.nodeValue.indexOf("S256KT1.") !== -1 || n.nodeValue.indexOf("S256KB1.") !== -1) {
        /* keys harvested elsewhere */
      }
      for (const tok of tokens) harvested.push(tok);
      if (writeDom && tokens.length) {
        let next = s;
        let changed = false;
        for (const tok of tokens) {
          const plain = await decryptToken(tok);
          if (plain != null) {
            next = next.split(tok).join(plain);
            changed = true;
          }
        }
        if (changed) {
          if (!replaced.has(n)) replaced.set(n, s);
          n.nodeValue = next;
        }
      }
    }
    if (!writeDom) harvestPackets(harvested);
    scanKeys(nodes);
  }

  let scanTimer = null;
  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      scan(document.body);
      paintComposer();
    }, 80);
  }

  const mo = new MutationObserver((muts) => {
    if (lastStatus.unlocked) {
      const fresh = [];
      for (const m of muts) {
        if (m.type === "characterData" && m.target && m.target.nodeType === 3) {
          const v = m.target.nodeValue || "";
          if (v.indexOf("S256K1.") !== -1 || v.indexOf("S256KT1.") !== -1 || v.indexOf("S256KB1.") !== -1) fresh.push(m.target);
        }
        for (const n of m.addedNodes || []) collectKeyTextNodes(n, fresh);
      }
      if (fresh.length) scanKeys(fresh, true);
    }
    scheduleScan();
  });
  /* ---------- Plaintext confirmation dialog ----------
     Separate host (not inside the draggable overlay, whose transform would break fixed
     positioning). Closed shadow root, escaped text only. */
  let modalHost = null;
  let modalShadow = null;
  let modalReq = null; /* { id } of the request currently shown */
  const skipConfirm = new Set(); /* peer keys for which the user said "don't ask" (session) */

  function peerKey(peer) {
    return peer ? peer.platform + ":" + peer.peer : "";
  }

  function ensureModal() {
    if (modalHost) return;
    modalHost = document.createElement("div");
    modalHost.style.all = "initial";
    modalHost.style.position = "fixed";
    modalHost.style.inset = "0";
    modalHost.style.zIndex = "2147483647";
    modalHost.style.display = "none";
    modalHost.style.fontFamily = 'system-ui, "Segoe UI", sans-serif';
    modalShadow = modalHost.attachShadow({ mode: "closed" });
    modalShadow.innerHTML = `
      <style>
        .back { position: fixed; inset: 0; background: rgba(4,8,14,.62); display: flex; align-items: center; justify-content: center; backdrop-filter: blur(3px); }
        .dlg { width: min(440px, 92vw); background: #17212b; color: #fff; border-radius: 18px; padding: 20px 20px 16px;
               border: 1px solid rgba(229,72,77,.55); box-shadow: 0 24px 80px rgba(0,0,0,.6); font-size: 14px; line-height: 1.45; }
        .dt { font-size: 17px; font-weight: 800; color: #ff6b6b; margin-bottom: 8px; }
        .dr { color: #c9d4de; margin-bottom: 10px; }
        .dp { background: #0f1720; border-left: 3px solid #ff6b6b; border-radius: 8px; padding: 8px 10px; color: #ff9b9b; font-size: 13px;
              white-space: pre-wrap; word-break: break-word; max-height: 96px; overflow: auto; margin-bottom: 12px; }
        .dc { display: flex; align-items: center; gap: 8px; color: #8fa1b3; font-size: 12px; margin-bottom: 14px; cursor: pointer; }
        .db { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; }
        button { border: 0; border-radius: 999px; padding: 9px 14px; font: inherit; font-weight: 700; cursor: pointer; font-size: 13px; }
        .ghost { background: #242f3d; color: #fff; }
        .enc { background: #3dd68c; color: #0b1a12; }
        .danger { background: #e5484d; color: #fff; }
        #pick { display: none; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
        #pick button { background: #2aabee; color: #fff; }
      </style>
      <div class="back">
        <div class="dlg" role="alertdialog">
          <div class="dt">⚠️ Сообщение уйдёт БЕЗ шифрования</div>
          <div class="dr" id="dreason"></div>
          <div class="dp" id="dprev"></div>
          <div id="pick"></div>
          <label class="dc"><input type="checkbox" id="dskip"> Больше не спрашивать в этом чате</label>
          <div class="db">
            <button class="ghost" id="dcancel">Отмена</button>
            <button class="enc" id="dbind">Привязать и зашифровать</button>
            <button class="danger" id="dsend">Отправить открытым</button>
          </div>
        </div>
      </div>`;
    const $ = (id) => modalShadow.getElementById(id);
    $("dcancel").addEventListener("click", () => answerModal({ cancel: true }));
    $("dsend").addEventListener("click", () => {
      if ($("dskip").checked) skipConfirm.add(peerKey(detectPeer()));
      answerModal({ send: true });
    });
    $("dbind").addEventListener("click", async () => {
      const st = await send({ type: "S256_STATUS" });
      if (!st || !st.unlocked || !st.contacts || !st.contacts.length) return;
      const peer = detectPeer();
      if (!peer) return;
      const bindTo = async (contactId) => {
        await send({ type: "S256_BIND", contactId, platform: peer.platform, peer: peer.peer });
        await refreshStatus(); /* pushes bound=true to the hook before we answer */
        answerModal({
          encrypt: true,
          state: { unlocked: !!lastStatus.unlocked, bound: !!lastStatus.bound, currentPeer: peer },
        });
      };
      if (st.contacts.length === 1) return bindTo(st.contacts[0].id);
      const pick = $("pick");
      pick.innerHTML = "";
      for (const c of st.contacts) {
        const b = document.createElement("button");
        b.textContent = c.name;
        b.addEventListener("click", () => bindTo(c.id));
        pick.appendChild(b);
      }
      pick.style.display = "flex";
    });
    modalShadow.querySelector(".back").addEventListener("click", (e) => {
      if (e.target === e.currentTarget) answerModal({ cancel: true });
    });
    document.documentElement.appendChild(modalHost);
  }

  function answerModal(res) {
    if (!modalReq) return;
    const id = modalReq.id;
    modalReq = null;
    modalHost.style.display = "none";
    window.postMessage(Object.assign({ source: DST_HOOK, type: "confirm-res", id }, res), "*");
  }

  function showConfirm(msg) {
    const key = peerKey(detectPeer());
    if (key && skipConfirm.has(key)) {
      window.postMessage({ source: DST_HOOK, type: "confirm-res", id: msg.id, send: true }, "*");
      return;
    }
    ensureModal();
    if (modalReq) answerModal({ cancel: true });
    modalReq = { id: msg.id };
    const $ = (id) => modalShadow.getElementById(id);
    $("dreason").textContent =
      msg.reason === "locked"
        ? "Pairlock заблокирован. Нажмите иконку расширения и введите пароль — или отправьте как есть."
        : "Этот чат не привязан к контакту, поэтому текст уйдёт на сервер VK/MAX в открытом виде.";
    $("dprev").textContent = msg.preview || "";
    $("dskip").checked = false;
    $("pick").style.display = "none";
    $("pick").innerHTML = "";
    $("dbind").style.display = msg.reason === "locked" || !(lastStatus.contacts && lastStatus.contacts.length) ? "none" : "";
    modalHost.style.display = "block";
    setTimeout(() => $("dcancel").focus(), 0);
  }

  /* ---------- Composer highlight ----------
     Red while the dialog is NOT encrypted. Never green: the site's own field is
     always readable by VK/MAX JS, so a green frame would be a false all-clear. */
  let hlStyle = null;
  let hlEl = null;

  function siteComposer() {
    const nodes = document.querySelectorAll(
      "[contenteditable='true'][role='textbox'], [contenteditable='true'], form textarea, footer textarea, [class*='Composer'] textarea, [class*='composer'] textarea"
    );
    let best = null;
    let bestScore = -1;
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      const r = el.getBoundingClientRect();
      if (r.width < 80 || r.height < 16 || r.bottom < 0) continue;
      if (r.top < window.innerHeight * 0.4) continue;
      let score = r.width + (r.top > window.innerHeight * 0.55 ? 180 : 0);
      if (el.getAttribute("role") === "textbox") score += 80;
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }
    return best || document.querySelector("[contenteditable='true'][role='textbox']") || document.querySelector("textarea");
  }

  function ensureHlStyle() {
    if (hlStyle && hlStyle.isConnected) return;
    hlStyle = document.createElement("style");
    hlStyle.textContent = `
      [data-s256-state="plain"] {
        color: #ff5c5c !important; caret-color: #ff5c5c !important;
        box-shadow: inset 0 0 0 2px rgba(229,72,77,.75), 0 0 0 4px rgba(229,72,77,.12) !important;
        border-radius: 10px !important;
      }
      [data-s256-state="plain"]:empty::before, [data-s256-state="plain"][data-s256-empty="1"]::before {
        content: "⚠ НЕ шифруется — этот чат не привязан"; color: rgba(255,92,92,.75); pointer-events: none; font-size: 13px;
      }
    `;
    (document.head || document.documentElement).appendChild(hlStyle);
  }

  function paintComposer() {
    const peer = detectPeer();
    const el = siteComposer();
    if (hlEl && hlEl !== el) {
      hlEl.removeAttribute("data-s256-state");
      hlEl.removeAttribute("data-s256-empty");
    }
    hlEl = el;
    if (!el || !peer || !lastStatus || !lastStatus.ok) {
      if (el) {
        el.removeAttribute("data-s256-state");
        el.removeAttribute("data-s256-empty");
      }
      return;
    }
    /* Green on VK's own field would lie: their JS still sees whatever you type there.
       Red only, and only while this dialog is not encrypted. Bound chats get no marker. */
    const enc = !!(lastStatus.unlocked && lastStatus.bound);
    if (enc) {
      el.removeAttribute("data-s256-state");
      el.removeAttribute("data-s256-empty");
      applyComposerCover();
      return;
    }
    ensureHlStyle();
    el.setAttribute("data-s256-state", "plain");
    const empty = !(el.tagName === "TEXTAREA" ? el.value : el.textContent || "").trim();
    if (empty) el.setAttribute("data-s256-empty", "1");
    else el.removeAttribute("data-s256-empty");
  }

  async function start() {
    await loadUi();
    ensureOverlay();
    refreshStatus();
    if (ui.chatOpen) setChatOpen(true);
    if (document.body) {
      mo.observe(document.body, { childList: true, subtree: true, characterData: true });
      scheduleScan();
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();

  setInterval(refreshStatus, 2500);
  window.addEventListener("popstate", refreshStatus);
  window.addEventListener("hashchange", refreshStatus);
  /* keep the red/green composer marker in sync with what the user types in the site's field */
  document.addEventListener("input", () => paintComposer(), true);
  document.addEventListener(
    "focusin",
    (e) => {
      paintComposer();
      if (Date.now() < pauseCoverUntil) return;
      if (!lastStatus.bound || !lastStatus.unlocked || ui.collapsed || ui.composer === false) return;
      const el = siteComposer();
      if (!el || !scField) return;
      if (e.target === el || (el.contains && el.contains(e.target))) {
        scField.focus();
      }
    },
    true
  );
})();
