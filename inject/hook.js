/* Runs in the page world. Encrypts outgoing text before VK/MAX network stacks see it. */
(function () {
  if (window.__s256Hooked) return;
  window.__s256Hooked = true;

  const PREFIX = "S256M1.";
  const SRC = "s256-hook";
  const DST = "s256-content";
  let seq = 1;
  const pending = new Map();
  let state = {
    unlocked: false,
    currentPeer: null,
    bound: false,
    lastMaxChatId: null,
  };

  function isKeyPacket(s) {
    const t = String(s || "").trim();
    return t.startsWith("S256K1.") || t.startsWith("S256KT1.");
  }

  function isCipherPacket(s) {
    const t = String(s || "").trim().replace(/\s+/g, "");
    if (!t) return false;
    if (t.startsWith(PREFIX)) return true;
    if (isKeyPacket(t)) return false;
    if (t.length < 120 || t.length > 5000) return false;
    return /^[A-Za-z0-9_-]+$/.test(t);
  }

  function hasCipherMarker(s) {
    const t = String(s || "");
    if (t.indexOf(PREFIX) !== -1 || t.indexOf("S256K1.") !== -1 || t.indexOf("S256KT1.") !== -1) return true;
    return /(?:^|[^A-Za-z0-9_-])[A-Za-z0-9_-]{120,}(?:[^A-Za-z0-9_-]|$)/.test(t);
  }

  window.addEventListener("message", (ev) => {
    if (ev.source !== window || !ev.data || ev.data.source !== DST) return;
    const msg = ev.data;
    if (msg.type === "state") {
      state = Object.assign(state, msg.state || {});
      return;
    }
    if (msg.type === "encrypt-res" && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
      return;
    }
    if (msg.type === "inject-send") {
      injectSend(String(msg.text || ""));
      return;
    }
    if (msg.type === "confirm-res" && confirmPending.has(msg.id)) {
      /* the answer may carry the fresh binding state so encryption can start immediately */
      if (msg.state) state = Object.assign(state, msg.state);
      confirmPending.get(msg.id)(msg);
      confirmPending.delete(msg.id);
    }
  });

  /* Deliver ready ciphertext coming from the shielded composer: put it into the site's
     own input and trigger its send. Only ciphertext ever enters the page's DOM. */
  function injectSend(text) {
    const t = String(text || "").trim();
    if (!isCipherPacket(t) && !isKeyPacket(t)) return;
    const el = composerEl();
    if (!el) {
      notify("не нашёл поле ввода сайта — кликните в него один раз и повторите", false);
      return;
    }
    writeComposer(el, t);
    reenter = true;
    el.dispatchEvent(syntheticEnter());
    setTimeout(() => {
      try {
        const now = readComposer(el);
        if (hasCipherMarker(now)) {
          const b = findSendButton();
          if (b) b.click();
        }
      } finally {
        setTimeout(() => {
          reenter = false;
        }, 120);
      }
    }, 200);
  }

  function findSendButton() {
    const nodes = document.querySelectorAll("button, [role='button']");
    let best = null;
    for (const n of nodes) {
      if (!sendButtonOf(n)) continue;
      const r = n.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      best = n; /* last visible match: composers sit at the bottom of the DOM */
    }
    return best;
  }

  function askEncrypt(text, peer) {
    if (!text || isCipherPacket(text) || isKeyPacket(text)) {
      return Promise.resolve({ ok: true, text, already: true });
    }
    if (!state.unlocked) {
      return Promise.resolve({ ok: false, code: "locked", error: "locked" });
    }
    const p = peer || state.currentPeer;
    if (!p) return Promise.resolve({ ok: false, code: "unbound", error: "no-peer" });
    const id = seq++;
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        pending.delete(id);
        resolve({ ok: false, code: "timeout", error: "timeout" });
      }, 8000);
      pending.set(id, (res) => {
        clearTimeout(t);
        resolve(res);
      });
      window.postMessage(
        {
          source: SRC,
          type: "encrypt-req",
          id,
          text: String(text),
          platform: p.platform,
          peer: String(p.peer),
        },
        "*"
      );
    });
  }

  function shouldTouchUrl(url) {
    const u = String(url || "");
    if (/messages\.send/i.test(u)) return true;
    if (/al_im\.php/i.test(u)) return true;
    if (/\/method\/execute/i.test(u) && /messages/i.test(u)) return true;
    return false;
  }

  const TEXT_KEYS = new Set(["message", "text", "body", "content", "msg", "message_text", "textValue"]);
  const PEER_KEYS = new Set(["peer_id", "peerId", "user_id", "chat_id", "chatId", "dialogId", "conversationId", "sel"]);

  function extractPeer(obj) {
    if (!obj || typeof obj !== "object") return null;
    for (const k of PEER_KEYS) {
      if (obj[k] != null && obj[k] !== "") return String(obj[k]);
    }
    if (obj.payload) return extractPeer(obj.payload);
    if (obj.message && typeof obj.message === "object") return extractPeer(obj.message);
    return null;
  }

  async function encryptFields(obj, platformHint) {
    if (!obj || typeof obj !== "object") return obj;
    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) obj[i] = await encryptFields(obj[i], platformHint);
      return obj;
    }
    const peerVal = extractPeer(obj);
    const peer = peerVal
      ? { platform: platformHint || (state.currentPeer && state.currentPeer.platform) || "vk", peer: peerVal }
      : state.currentPeer;

    if (obj.opcode === 64 || obj.opcode === 67) {
      const chatId = obj.payload && (obj.payload.chatId ?? obj.payload.userId);
      if (chatId != null) {
        state.lastMaxChatId = String(chatId);
        window.postMessage({ source: SRC, type: "max-peer", peer: String(chatId) }, "*");
      }
    }

    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (v && typeof v === "object") {
        obj[k] = await encryptFields(v, platformHint);
        continue;
      }
      if (typeof v !== "string") continue;
      if (!TEXT_KEYS.has(k)) continue;
      if (!v.trim() || isCipherPacket(v) || isKeyPacket(v)) continue;
      if (!peer) continue;
      const res = await askEncrypt(v, peer);
      if (res.ok && res.packets && res.packets.length > 1) {
        window.postMessage({ source: SRC, type: "multi-send", packets: res.packets }, "*");
        throw new Error("multi-send");
      }
      if (res.ok && res.text) obj[k] = res.text;
      else if (state.bound && res.code !== "unbound") throw new Error(res.error || "encrypt-failed");
    }
    return obj;
  }

  async function rewriteBody(url, body) {
    const platform = /max\.ru|oneme\.ru/.test(String(url)) ? "max" : (state.currentPeer && state.currentPeer.platform) || "vk";
    if (typeof body === "string") {
      if (/al_im\.php/i.test(String(url || "")) && !/act=[^&]*send/i.test(body)) {
        return body;
      }
      if (body.trim().startsWith("{") || body.trim().startsWith("[")) {
        try {
          const obj = JSON.parse(body);
          await encryptFields(obj, platform);
          return JSON.stringify(obj);
        } catch {
          /* not json */
        }
      }
      const params = new URLSearchParams(body);
      if (params.has("message") || params.has("text")) {
        const peer =
          params.get("peer_id") ||
          params.get("user_id") ||
          params.get("chat_id") ||
          (state.currentPeer && state.currentPeer.peer);
        const key = params.has("message") ? "message" : "text";
        const val = params.get(key);
        if (val && !isCipherPacket(val) && !isKeyPacket(val) && peer) {
          const res = await askEncrypt(val, {
            platform,
            peer: String(peer),
          });
          if (res.ok && res.packets && res.packets.length > 1) {
            window.postMessage({ source: SRC, type: "multi-send", packets: res.packets }, "*");
            throw new Error("multi-send");
          }
          if (res.ok && res.text) params.set(key, res.text);
          else if (state.bound) throw new Error(res.error || "encrypt-failed");
        }
        return params.toString();
      }
      return body;
    }
    if (body instanceof URLSearchParams) {
      return new URLSearchParams(await rewriteBody(url, body.toString()));
    }
    if (body instanceof FormData) {
      const msg = body.get("message") || body.get("text");
      const peer = body.get("peer_id") || body.get("user_id") || (state.currentPeer && state.currentPeer.peer);
      if (typeof msg === "string" && peer && !isCipherPacket(msg) && !isKeyPacket(msg)) {
        const res = await askEncrypt(msg, { platform, peer: String(peer) });
        if (res.ok && res.packets && res.packets.length > 1) {
          window.postMessage({ source: SRC, type: "multi-send", packets: res.packets }, "*");
          throw new Error("multi-send");
        }
        if (res.ok && res.text) {
          if (body.has("message")) body.set("message", res.text);
          if (body.has("text")) body.set("text", res.text);
        } else if (state.bound) throw new Error(res.error || "encrypt-failed");
      }
      return body;
    }
    return body;
  }

  /* ---------- Leak guard ----------
     While a chat is bound, whatever plaintext sits in the site's own composer must not
     leave the browser in ANY request: draft sync, analytics, "typing" payloads. Every
     outgoing body is compared against the composer text (raw, URL- and JSON-escaped). */
  function composerPlain() {
    const el = composerEl();
    if (!el) return null;
    const t = readComposer(el).trim();
    if (t.length < 4 || isCipherPacket(t) || isKeyPacket(t)) return null;
    return t;
  }

  function bodyToString(body) {
    if (body == null) return "";
    if (typeof body === "string") return body;
    if (body instanceof URLSearchParams) return body.toString();
    if (body instanceof FormData) {
      const parts = [];
      for (const [k, v] of body.entries()) if (typeof v === "string") parts.push(k + "=" + v);
      return parts.join("&");
    }
    return "";
  }

  function leaksPlain(body) {
    if (!state.bound || !state.unlocked) return false;
    const p = composerPlain();
    if (!p) return false;
    const s = bodyToString(body);
    if (!s) return false;
    const probes = [p, encodeURIComponent(p), JSON.stringify(p).slice(1, -1)];
    const head = p.slice(0, 40);
    if (head.length >= 8) probes.push(head, encodeURIComponent(head), JSON.stringify(head).slice(1, -1));
    return probes.some((v) => v && s.indexOf(v) !== -1);
  }

  let leakNotified = 0;
  function reportLeak(kind, url) {
    console.warn("[S256] blocked plaintext leak via " + kind, String(url || "").slice(0, 120));
    const now = Date.now();
    if (now - leakNotified > 3000) {
      leakNotified = now;
      notify("заблокирована отправка открытого текста (черновик). Пишите в защищённом поле", false);
    }
  }

  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    const url = typeof input === "string" ? input : input && input.url;
    const looksVk = shouldTouchUrl(url);
    let body = init && init.body;
    try {
      if (!body && input instanceof Request) body = await input.clone().text();
    } catch {
      body = init && init.body;
    }
    const looksMsg = typeof body === "string" && /(^|&)message=/.test(body);
    const looksForm = typeof FormData !== "undefined" && body instanceof FormData && state.bound;
    if (looksVk || looksMsg || looksForm) {
      try {
        const next = await rewriteBody(url, body);
        if (leaksPlain(next)) {
          reportLeak("fetch", url);
          return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (input instanceof Request) {
          init = Object.assign({}, init, { body: next, method: input.method, headers: input.headers });
          return origFetch.call(this, input.url, init);
        }
        init = Object.assign({}, init, { body: next });
        return origFetch.call(this, input, init);
      } catch (e) {
        console.warn("[S256] fetch encrypt blocked", e);
        if (state.bound) throw e;
      }
    }
    if (leaksPlain(body)) {
      reportLeak("fetch", url);
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return origFetch.call(this, input, init);
  };

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__s256url = url;
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    const xhr = this;
    const url = this.__s256url || "";
    if (!shouldTouchUrl(url) && !(typeof body === "string" && /(^|&)message=/.test(body))) {
      if (leaksPlain(body)) {
        reportLeak("xhr", url);
        try {
          xhr.abort();
        } catch (_) {
          /* ignore */
        }
        return;
      }
      return origSend.call(this, body);
    }
    rewriteBody(url, body)
      .then((next) => {
        if (leaksPlain(next)) {
          reportLeak("xhr", url);
          xhr.abort();
          return;
        }
        origSend.call(xhr, next);
      })
      .catch((e) => {
        console.warn("[S256] xhr encrypt blocked", e);
        try {
          xhr.abort();
        } catch (_) {
          /* ignore */
        }
      });
  };

  if (navigator.sendBeacon) {
    const origBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (url, data) {
      if (leaksPlain(typeof data === "string" || data instanceof URLSearchParams || data instanceof FormData ? data : "")) {
        reportLeak("beacon", url);
        return true;
      }
      return origBeacon(url, data);
    };
  }

  const origWsSend = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data) {
    if (typeof data !== "string") return origWsSend.call(this, data);
    if (leaksPlain(data)) {
      reportLeak("ws", this.url);
      return;
    }
    if (data[0] !== "{" && data[0] !== "[") return origWsSend.call(this, data);
    const ws = this;
    (async () => {
      try {
        const obj = JSON.parse(data);
        const opcode = obj.opcode;
        if (opcode === 64 || opcode === 67) {
          await encryptFields(obj, "max");
          const out = JSON.stringify(obj);
          if (leaksPlain(out)) {
            reportLeak("ws", ws.url);
            return;
          }
          origWsSend.call(ws, out);
          return;
        }
      } catch (e) {
        console.warn("[S256] ws encrypt", e);
        if (state.bound) return;
      }
      origWsSend.call(ws, data);
    })();
  };

  let lastEditable = null;
  document.addEventListener(
    "focusin",
    (e) => {
      const el = e.target;
      if (el && (el.isContentEditable || el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && el.type === "text"))) {
        lastEditable = el;
      }
    },
    true
  );

  function composerEl() {
    const a = document.activeElement;
    if (a && (a.isContentEditable || a.tagName === "TEXTAREA" || a.tagName === "INPUT")) return a;
    if (lastEditable && document.contains(lastEditable)) return lastEditable;
    return (
      document.querySelector("[contenteditable='true'][role='textbox']") ||
      document.querySelector("[contenteditable='true']") ||
      document.querySelector("textarea") ||
      null
    );
  }

  function notify(text, ok) {
    window.postMessage({ source: SRC, type: "notify", text: String(text), ok: !!ok }, "*");
  }

  function readComposer(el) {
    if (!el) return "";
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") return el.value;
    return el.innerText || el.textContent || "";
  }

  function writeComposer(el, text) {
    el.focus();
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, "value");
      if (desc && desc.set) desc.set.call(el, text);
      else el.value = text;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }
    document.execCommand("selectAll", false, null);
    document.execCommand("insertText", false, text);
  }

  /* Composer-level encryption. This is the primary path: it works no matter how the
     site ships the message (fetch, XHR, WebSocket, worker). The network hooks above
     are a second line of defence. The event is cancelled SYNCHRONOUSLY, then the
     ciphertext is written into the composer and the original action is replayed. */
  let reenter = false;

  function pendingPlain() {
    if (reenter || !state.unlocked || !state.bound) return null;
    const el = composerEl();
    if (!el) return null;
    const text = readComposer(el).trim();
    if (!text || isCipherPacket(text) || isKeyPacket(text)) return null;
    return { el, text };
  }

  async function encryptThenReplay(job, replay) {
    const res = await askEncrypt(job.text, state.currentPeer);
    const packets = res.packets && res.packets.length ? res.packets : res.text ? [res.text] : [];
    if (!res.ok || !packets.length) {
      notify(
        res.code === "expired"
          ? "срок ключей вышел — сообщение НЕ отправлено. Обменяйтесь новыми ключами"
          : res.code === "locked"
            ? "Pairlock заблокирован — сообщение НЕ отправлено"
            : "не удалось зашифровать — сообщение НЕ отправлено",
        false
      );
      return;
    }
    if (packets.length > 1) {
      writeComposer(job.el, "");
      window.postMessage({ source: SRC, type: "multi-send", packets }, "*");
      notify("длинное сообщение · " + packets.length + " частей", true);
      return;
    }
    writeComposer(job.el, packets[0]);
    reenter = true;
    try {
      replay();
    } finally {
      setTimeout(() => {
        reenter = false;
      }, 120);
    }
  }

  function syntheticEnter() {
    const ev = new KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
    });
    return ev;
  }

  /* ---------- Plaintext confirmation ----------
     When the chat is NOT being encrypted (locked / unbound) and the user is about to send
     text in a dialog, stop the send and ask via the overlay. Only dialogs (a detected peer)
     and real composers (contenteditable / textarea) qualify — search boxes are left alone. */
  const confirmPending = new Map();
  let confirmSeq = 1;

  function plainPending() {
    if (reenter || !state.currentPeer) return null;
    if (state.unlocked && state.bound) return null;
    const el = composerEl();
    if (!el || el.tagName === "INPUT") return null;
    const text = readComposer(el).trim();
    if (!text || isCipherPacket(text) || isKeyPacket(text)) return null;
    return { el, text };
  }

  function askConfirm(text) {
    const id = confirmSeq++;
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        confirmPending.delete(id);
        resolve({ cancel: true });
      }, 180000);
      confirmPending.set(id, (res) => {
        clearTimeout(t);
        resolve(res);
      });
      window.postMessage(
        { source: SRC, type: "confirm-req", id, preview: text.slice(0, 160), reason: state.unlocked ? "unbound" : "locked" },
        "*"
      );
    });
  }

  function replayPlain(job, replay) {
    reenter = true;
    try {
      replay();
    } finally {
      setTimeout(() => {
        reenter = false;
      }, 120);
    }
  }

  async function confirmThen(job, replay) {
    const res = await askConfirm(job.text);
    if (res.send) return replayPlain(job, replay);
    if (res.encrypt) return encryptThenReplay(job, replay);
    /* cancelled: text stays in the composer */
  }

  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
      const job = pendingPlain();
      if (job) {
        e.preventDefault();
        e.stopImmediatePropagation();
        encryptThenReplay(job, () => {
          job.el.focus();
          job.el.dispatchEvent(syntheticEnter());
        });
        return;
      }
      const plain = plainPending();
      if (!plain) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      confirmThen(plain, () => {
        plain.el.focus();
        plain.el.dispatchEvent(syntheticEnter());
      });
    },
    true
  );

  function sendButtonOf(target) {
    if (!target || !target.closest) return null;
    const b = target.closest("button, [role='button'], a[aria-label]");
    if (!b) return null;
    const label = [
      b.getAttribute("aria-label"),
      b.getAttribute("title"),
      b.getAttribute("data-testid"),
      b.getAttribute("data-test-id"),
      b.className && String(b.className),
    ]
      .filter(Boolean)
      .join(" ");
    return /отправ|send/i.test(label) ? b : null;
  }

  document.addEventListener(
    "click",
    (e) => {
      const btn = sendButtonOf(e.target);
      if (!btn) return;
      const job = pendingPlain();
      if (job) {
        e.preventDefault();
        e.stopImmediatePropagation();
        encryptThenReplay(job, () => btn.click());
        return;
      }
      const plain = plainPending();
      if (!plain) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      confirmThen(plain, () => btn.click());
    },
    true
  );
})();
