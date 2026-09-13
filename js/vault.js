/* Encrypted vault. At rest: PBKDF2-SHA256 + AES-256-GCM. Unlocked copy only in memory / session. */
(function (global) {
  const C = () => global.S256Crypto;
  const P = () => global.S256Protocol;
  const MAGIC_V1 = "S256VAULT1"; /* legacy: fixed 250k iterations */
  const MAGIC = "S256VAULT2"; /* iterations stored in the blob */
  const LEGACY_ITERATIONS = 250000;
  const ITERATIONS = 600000; /* OWASP 2023 for PBKDF2-HMAC-SHA256 */
  const MIN_ITERATIONS = 100000;
  const MAX_ITERATIONS = 10000000;
  const STORAGE_KEY = "s256.vault.blob";
  const SESSION_KEY = "s256.vault.unlocked";
  const KEY_KEY = "s256.vault.key"; /* derived key only; the password is never persisted */
  const BURN_AT_KEY = "s256.burnAt"; /* plaintext deadline — outside the vault so burn can run locked */

  function storageLocal() {
    if (global.chrome && chrome.storage && chrome.storage.local) return "chrome";
    return "web";
  }

  const webStore = Object.create(null);
  const IDB_NAME = "s256";
  const IDB_STORE = "kv";
  let persistMode = "unknown";

  function idbAvailable() {
    try {
      return typeof indexedDB !== "undefined";
    } catch (_) {
      return false;
    }
  }

  function withIdb(mode, fn) {
    return new Promise((resolve, reject) => {
      if (!idbAvailable()) {
        reject(new Error("idb"));
        return;
      }
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
      };
      req.onerror = () => reject(req.error || new Error("idb"));
      req.onsuccess = () => {
        const db = req.result;
        let settled = false;
        const done = (err, val) => {
          if (settled) return;
          settled = true;
          try {
            db.close();
          } catch (_) {
            /* ignore */
          }
          if (err) reject(err);
          else resolve(val);
        };
        try {
          const tx = db.transaction(IDB_STORE, mode);
          const st = tx.objectStore(IDB_STORE);
          fn(st, done);
          tx.oncomplete = () => done(null, undefined);
          tx.onerror = () => done(tx.error || new Error("idb"));
        } catch (e) {
          done(e);
        }
      };
    });
  }

  function idbGet(key) {
    return withIdb("readonly", (st, done) => {
      const g = st.get(key);
      g.onsuccess = () => done(null, g.result ?? null);
      g.onerror = () => done(g.error || new Error("idb"));
    }).catch(() => null);
  }

  function idbSet(key, value) {
    return withIdb("readwrite", (st, done) => {
      const g = st.put(value, key);
      g.onsuccess = () => done(null, true);
      g.onerror = () => done(g.error || new Error("idb"));
    }).catch(() => false);
  }

  function idbDel(key) {
    return withIdb("readwrite", (st, done) => {
      const g = st.delete(key);
      g.onsuccess = () => done(null, true);
      g.onerror = () => done(g.error || new Error("idb"));
    }).catch(() => false);
  }

  function webGet(key) {
    try {
      if (typeof localStorage !== "undefined") {
        const v = localStorage.getItem(key);
        if (v != null) return v;
      }
    } catch (_) {
      /* iOS file://, data:, private mode */
    }
    return Object.prototype.hasOwnProperty.call(webStore, key) ? webStore[key] : null;
  }

  function webSet(key, value) {
    const v = String(value);
    webStore[key] = v;
    try {
      localStorage.setItem(key, v);
    } catch (_) {
      /* ignore */
    }
  }

  function webRemove(key) {
    delete webStore[key];
    try {
      localStorage.removeItem(key);
    } catch (_) {
      /* ignore */
    }
  }

  async function probeStore() {
    if (persistMode !== "unknown") return persistMode;
    const k = "s256.probe";
    try {
      localStorage.setItem(k, "1");
      if (localStorage.getItem(k) === "1") {
        localStorage.removeItem(k);
        persistMode = "local";
        return persistMode;
      }
    } catch (_) {
      /* continue */
    }
    try {
      await idbSet(k, "1");
      if ((await idbGet(k)) === "1") {
        persistMode = "idb";
        return persistMode;
      }
    } catch (_) {
      /* continue */
    }
    persistMode = "memory";
    return persistMode;
  }

  async function getLocal(key) {
    if (storageLocal() === "chrome") {
      return chrome.storage.local.get(key).then((r) => r[key] ?? null);
    }
    const fromLs = webGet(key);
    if (fromLs != null) return fromLs;
    return idbGet(key);
  }

  async function setLocal(key, value) {
    if (storageLocal() === "chrome") {
      return chrome.storage.local.set({ [key]: value });
    }
    webSet(key, value);
    await idbSet(key, String(value));
  }

  async function removeLocal(key) {
    if (storageLocal() === "chrome") {
      return chrome.storage.local.remove(key);
    }
    webRemove(key);
    await idbDel(key);
  }

  function sessionAvailable() {
    return !!(global.chrome && chrome.storage && chrome.storage.session);
  }

  async function getSession(key) {
    if (!sessionAvailable()) return memory._session[key] ?? null;
    const r = await chrome.storage.session.get(key);
    return r[key] ?? null;
  }

  async function setSession(key, value) {
    if (!sessionAvailable()) {
      memory._session[key] = value;
      return;
    }
    await chrome.storage.session.set({ [key]: value });
  }

  async function removeSession(key) {
    if (!sessionAvailable()) {
      delete memory._session[key];
      return;
    }
    await chrome.storage.session.remove(key);
  }

  const memory = {
    key: null, /* Uint8Array(32) derived from the password */
    salt: null,
    iter: ITERATIONS,
    state: null,
    identity: null,
    _session: {},
  };

  function blankSettings() {
    return {
      strict: true,
      onboarded: false,
      keyTtlSec: 0,
      pageDecrypt: false,
      stealthWire: true,
      burnVaultSec: 0,
      burnAt: 0,
      safeLocked: false,
    };
  }

  /* New vaults: forever identity. Per-contact TTL is chosen when pairing (offer keyTtlSec). */
  function defaultSettings() {
    return blankSettings();
  }

  const THREAD_MAX = 400;
  const THREAD_TEXT_MAX = 120000;
  /* VK messages.send limit is 4096 chars; stay under for MAX/web quirks. */
  const WIRE_MAX = 3900;
  const PLAIN_CHUNK_BYTES = 2200;
  const FRAG_MAX_PARTS = 60;

  function normalizePacket(p) {
    return String(p || "").trim().replace(/\s+/g, "");
  }

  function utf8Bytes(str) {
    return C().utf8(String(str || ""));
  }

  function splitUtf8Chunks(text, maxBytes) {
    const bytes = utf8Bytes(text);
    if (bytes.length <= maxBytes) return [String(text || "")];
    const dec = new TextDecoder();
    const out = [];
    let i = 0;
    while (i < bytes.length) {
      let end = Math.min(i + maxBytes, bytes.length);
      if (end < bytes.length) {
        while (end > i && (bytes[end] & 0xc0) === 0x80) end -= 1;
        if (end === i) end = Math.min(i + maxBytes, bytes.length);
      }
      out.push(dec.decode(bytes.subarray(i, end)));
      i = end;
    }
    return out;
  }

  function makeFragId() {
    return C().bytesToB64url(C().randomBytes(9));
  }

  function parseFrag(text) {
    const m = String(text || "").match(/^PLF1 ([A-Za-z0-9_-]+) (\d+) (\d+)\n([\s\S]*)$/);
    if (!m) return null;
    const index = Number(m[2]);
    const total = Number(m[3]);
    if (!Number.isFinite(index) || !Number.isFinite(total) || total < 1 || total > FRAG_MAX_PARTS) return null;
    if (index < 0 || index >= total) return null;
    return { id: m[1], index, total, payload: m[4] };
  }

  function loadThreads(raw) {
    const out = {};
    const src = raw && typeof raw === "object" ? raw : {};
    for (const id of Object.keys(src)) {
      const list = Array.isArray(src[id]) ? src[id] : [];
      out[id] = list
        .filter((m) => m && m.packet)
        .map((m) => ({
          id: String(m.id || m.packet).slice(0, 80),
          packet: normalizePacket(m.packet),
          text: String(m.text || "").slice(0, THREAD_TEXT_MAX),
          outgoing: !!m.outgoing,
          ts: Number(m.ts) || 0,
          known: m.known !== false,
          verified: !!m.verified,
        }));
    }
    return out;
  }

  function loadFragBuf(raw) {
    const out = {};
    const src = raw && typeof raw === "object" ? raw : {};
    for (const k of Object.keys(src)) {
      const v = src[k];
      if (!v || typeof v !== "object") continue;
      out[k] = {
        total: Number(v.total) || 0,
        parts: v.parts && typeof v.parts === "object" ? v.parts : {},
        ts: Number(v.ts) || 0,
        outgoing: !!v.outgoing,
        known: v.known !== false,
        verified: !!v.verified,
      };
    }
    return out;
  }

  function appendThread(state, contactId, row) {
    const packet = normalizePacket(row && row.packet);
    if (!packet || !contactId) return false;
    if (!state.threads) state.threads = {};
    const list = state.threads[contactId] || [];
    if (list.some((m) => m.packet === packet)) return false;
    list.push({
      id: packet.slice(-24),
      packet,
      text: String(row.text || "").slice(0, THREAD_TEXT_MAX),
      outgoing: !!row.outgoing,
      ts: Number(row.ts) || Date.now(),
      known: row.known !== false,
      verified: !!row.verified,
    });
    while (list.length > THREAD_MAX) list.shift();
    state.threads[contactId] = list;
    return true;
  }

  const SESSION_GRACE_MS = 120000;

  function ttlPhrase(sec) {
    const n = sec >>> 0;
    if (!n) return "бессрочно";
    if (n === 900) return "15 минут";
    if (n === 1800) return "30 минут";
    if (n === 3600) return "1 час";
    if (n === 86400) return "сутки";
    if (n === 604800) return "неделя";
    return n + " с";
  }

  function dumpSession(c) {
    return {
      ttlSec: c.ttlSec || 0,
      pairedAt: c.pairedAt || 0,
      expiresAt: c.expiresAt || 0,
      sessionWiped: !!c.sessionWiped,
      sessionPubB64: c.sessionPubB64 || null,
      sessionPrivB64: c.sessionPrivB64 || null,
      theirSessionPubB64: c.theirSessionPubB64 || null,
      sessionIkmB64: c.sessionIkm ? C().bytesToB64url(c.sessionIkm) : c.sessionIkmB64 || null,
    };
  }

  function loadSession(c, raw) {
    c.ttlSec = raw.ttlSec || 0;
    c.pairedAt = raw.pairedAt || 0;
    c.expiresAt = raw.expiresAt || 0;
    c.sessionWiped = !!raw.sessionWiped;
    c.sessionPubB64 = raw.sessionPubB64 || null;
    c.sessionPrivB64 = raw.sessionPrivB64 || null;
    c.theirSessionPubB64 = raw.theirSessionPubB64 || null;
    c.sessionIkmB64 = raw.sessionIkmB64 || null;
    c.sessionIkm = raw.sessionIkmB64 ? C().b64urlToBytes(raw.sessionIkmB64) : null;
    if (c.sessionWiped) c.sessionIkm = null;
  }

  function serializeState(state) {
    return JSON.stringify({
      version: 1,
      identity: {
        pubB64: C().bytesToB64url(state.identity.publicRaw),
        privB64: C().bytesToB64url(state.identity.privateRaw || C().b64urlToBytes(state.identity.privateJwk.d)),
        privJwk: state.identity.privateJwk,
      },
      contacts: state.contacts.map((c) => ({
        id: c.id,
        name: c.name,
        theirPubB64: C().bytesToB64url(c.theirPub),
        fingerprint: c.fingerprint,
        bindings: c.bindings || {},
        verified: !!c.verified,
        createdAt: c.createdAt,
        ...dumpSession(c),
      })),
      sentCache: state.sentCache || {},
      threads: state.threads || {},
      fragBuf: state.fragBuf || {},
      settings: Object.assign(blankSettings(), state.settings || {}),
    });
  }

  async function hydrateState(raw) {
    const identity = await C().identityFromStored(
      C().b64urlToBytes(raw.identity.pubB64),
      raw.identity.privJwk,
      raw.identity.privB64 || null
    );
    const contacts = [];
    for (const c of raw.contacts || []) {
      const row = {
        id: c.id,
        name: c.name,
        theirPub: C().b64urlToBytes(c.theirPubB64),
        fingerprint: c.fingerprint,
        bindings: c.bindings || {},
        verified: !!c.verified,
        createdAt: c.createdAt,
      };
      loadSession(row, c);
      contacts.push(row);
    }
    return {
      version: 1,
      identity,
      contacts,
      sentCache: raw.sentCache || {},
      threads: loadThreads(raw.threads),
      fragBuf: loadFragBuf(raw.fragBuf),
      settings: Object.assign(blankSettings(), raw.settings || {}),
    };
  }

  function u32(n) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n >>> 0, false);
    return b;
  }

  function readU32(bytes) {
    return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, false);
  }

  /* V2 layout: MAGIC(10) | iterations(4) | salt(16) | nonce(12) | AES-GCM(ct+tag) */
  async function wrapBlob(keyBytes, salt, iter, plaintext) {
    const nonce = C().randomBytes(12);
    const ct = await C().aesGcmEncrypt(keyBytes, nonce, C().utf8(plaintext), C().utf8(MAGIC));
    const packed = C().concatBytes([C().utf8(MAGIC), u32(iter), salt, nonce, ct]);
    return C().bytesToB64url(packed);
  }

  /* Returns { json, key, salt, iter, legacy }. Understands V1 (fixed 250k) and V2. */
  async function unwrapBlob(password, blob) {
    const packed = C().b64urlToBytes(String(blob).trim());
    const m2 = C().utf8(MAGIC);
    const m1 = C().utf8(MAGIC_V1);
    if (packed.length < m2.length + 16 + 12 + 16) throw new Error("Хранилище повреждено");
    let o = m2.length;
    let iter;
    let legacy;
    let ad;
    if (C().timingSafeEqual(packed.subarray(0, m2.length), m2)) {
      if (packed.length < o + 4 + 16 + 12 + 16) throw new Error("Хранилище повреждено");
      iter = readU32(packed.subarray(o, o + 4));
      o += 4;
      if (iter < MIN_ITERATIONS || iter > MAX_ITERATIONS) throw new Error("Хранилище повреждено");
      legacy = false;
      ad = m2;
    } else if (C().timingSafeEqual(packed.subarray(0, m1.length), m1)) {
      iter = LEGACY_ITERATIONS;
      legacy = true;
      ad = m1;
    } else {
      throw new Error("Это не хранилище S256");
    }
    const salt = packed.slice(o, o + 16); o += 16;
    const nonce = packed.subarray(o, o + 12); o += 12;
    const ct = packed.subarray(o);
    const key = await C().pbkdf2(password, salt, iter);
    try {
      const pt = await C().aesGcmDecrypt(key, nonce, ct, ad);
      return { json: C().utf8dec(pt), key, salt, iter, legacy };
    } catch {
      throw new Error("Неверный пароль");
    }
  }

  async function deriveFresh(password) {
    const salt = C().randomBytes(16);
    const key = await C().pbkdf2(password, salt, ITERATIONS);
    return { key, salt, iter: ITERATIONS };
  }

  function adoptKey(k) {
    memory.key = k.key;
    memory.salt = k.salt;
    memory.iter = k.iter;
  }

  async function persistSession() {
    if (!memory.state) return;
    await setSession(SESSION_KEY, serializeState(memory.state));
    if (memory.key) {
      await setSession(
        KEY_KEY,
        JSON.stringify({ k: C().bytesToB64url(memory.key), s: C().bytesToB64url(memory.salt), i: memory.iter })
      );
    }
  }

  async function persist() {
    if (!memory.state) return;
    await persistSession();
    if (!memory.key) return;
    const blob = await wrapBlob(memory.key, memory.salt, memory.iter, serializeState(memory.state));
    await setLocal(STORAGE_KEY, blob);
  }

  async function hasVault() {
    if (await enforceBurn()) return false;
    const blob = await getLocal(STORAGE_KEY);
    return !!blob;
  }

  function checkPassword(password) {
    if (!password || password.length < 8) throw new Error("Пароль минимум 8 символов");
  }

  async function create(password) {
    checkPassword(password);
    if (await getLocal(STORAGE_KEY)) throw new Error("Хранилище уже есть — откройте паролем");
    await removeLocal(BURN_AT_KEY);
    const identity = await C().generateIdentity();
    adoptKey(await deriveFresh(password));
    memory.state = {
      version: 1,
      identity,
      contacts: [],
      sentCache: {},
      threads: {},
      fragBuf: {},
      settings: defaultSettings(),
    };
    memory.identity = identity;
    await persist();
    return memory.state;
  }

  async function unlock(password) {
    if (await enforceBurn()) throw new Error("Хранилище сожжено по таймеру — ключей больше нет");
    const blob = await getLocal(STORAGE_KEY);
    if (!blob) throw new Error("Хранилище ещё не создано");
    const res = await unwrapBlob(password, blob);
    memory.state = await hydrateState(JSON.parse(res.json));
    memory.identity = memory.state.identity;
    if (res.legacy || res.iter < ITERATIONS) {
      /* transparently upgrade V1 / weak-iteration blobs */
      adoptKey(await deriveFresh(password));
      await persist();
    } else {
      adoptKey(res);
      await persistSession();
    }
    if (await enforceBurn()) throw new Error("Хранилище сожжено по таймеру — ключей больше нет");
    /* keep plaintext deadline in sync if it was only inside the vault settings */
    const bAt = (memory.state.settings && memory.state.settings.burnAt) || 0;
    if (bAt > Date.now()) await setLocal(BURN_AT_KEY, String(bAt));
    else if (bAt && bAt <= Date.now()) {
      await burnVaultNow();
      throw new Error("Хранилище сожжено по таймеру — ключей больше нет");
    }
    return memory.state;
  }

  async function restoreSession() {
    if (await enforceBurn()) return null;
    const json = await getSession(SESSION_KEY);
    if (!json) {
      memory.state = null;
      memory.identity = null;
      memory.key = null;
      memory.salt = null;
      return null;
    }
    memory.state = await hydrateState(JSON.parse(json));
    memory.identity = memory.state.identity;
    try {
      const k = JSON.parse((await getSession(KEY_KEY)) || "null");
      if (k && k.k && k.s) {
        memory.key = C().b64urlToBytes(k.k);
        memory.salt = C().b64urlToBytes(k.s);
        memory.iter = k.i || ITERATIONS;
      }
    } catch {
      /* state stays readable; writes will need a re-unlock */
    }
    if (await enforceBurn()) return null;
    return memory.state;
  }

  async function lock() {
    if (memory.key) memory.key.fill(0);
    memory.key = null;
    memory.salt = null;
    memory.state = null;
    memory.identity = null;
    await removeSession(SESSION_KEY);
    await removeSession(KEY_KEY);
  }

  function requireState() {
    if (!memory.state) throw new Error("Хранилище заблокировано");
    return memory.state;
  }

  /* Offer TTL for the next pair / QR. Does not wipe the vault or lock other contacts. */
  async function ensureSafePair(ttlSec) {
    const state = requireState();
    state.settings = Object.assign(blankSettings(), state.settings || {});
    const n = ttlSec != null ? Number(ttlSec) >>> 0 : state.settings.keyTtlSec || 86400;
    if (!P().isAllowedTtl(n)) throw new Error("Недопустимый срок");
    state.settings.keyTtlSec = n;
    state.settings.pendingSession = null;
    state.settings.safeLocked = false;
    await persist();
    return {
      keyTtlSec: state.settings.keyTtlSec,
      burnVaultSec: state.settings.burnVaultSec || 0,
      burnAt: state.settings.burnAt || 0,
      locked: false,
    };
  }

  /* Optional whole-vault wipe (advanced). Not tied to per-contact secret chats. */
  function isBurnMode() {
    const state = memory.state;
    if (!state || !state.settings) return false;
    const s = state.settings;
    if ((s.burnAt || 0) > Date.now()) return true;
    return false;
  }

  function isSafeLocked() {
    return isBurnMode();
  }

  async function commitSafePair(ttlSec) {
    /* Per-contact only — kept for API compat; does not schedule vault burn. */
    const n = Number(ttlSec) >>> 0;
    if (!P().isAllowedTtl(n)) throw new Error("Недопустимый срок");
    return requireState().settings;
  }

  async function setPairMode(mode, ttlSec) {
    const state = requireState();
    state.settings = Object.assign(blankSettings(), state.settings || {});
    if (mode === "safe") {
      const n = ttlSec != null ? Number(ttlSec) >>> 0 : state.settings.keyTtlSec || 86400;
      const r = await ensureSafePair(n);
      return { ...r, needsRekey: false, foreverPairs: 0 };
    }
    state.settings.keyTtlSec = 0;
    state.settings.pendingSession = null;
    state.settings.safeLocked = false;
    await persist();
    return {
      keyTtlSec: 0,
      burnVaultSec: state.settings.burnVaultSec || 0,
      burnAt: state.settings.burnAt || 0,
      locked: isSafeLocked(),
      needsRekey: false,
    };
  }

  function pairModeView() {
    const state = memory.state;
    const s = state && state.settings ? state.settings : {};
    const ttlOn = !!(s.keyTtlSec > 0);
    let timedContacts = 0;
    if (state && state.contacts) {
      for (const c of state.contacts) {
        if (c.ttlSec && !c.sessionWiped && c.sessionIkm) timedContacts += 1;
      }
    }
    return {
      mode: ttlOn ? "safe" : "forever",
      keyTtlSec: s.keyTtlSec || 0,
      burnVaultSec: s.burnVaultSec || 0,
      burnAt: s.burnAt || 0,
      locked: isSafeLocked(),
      safeLocked: false,
      burnMode: isBurnMode(),
      needsRekey: false,
      timedContacts,
      foreverPairs: 0,
    };
  }

  async function addContact(name, publicKeyText) {
    const state = requireState();
    state.settings = Object.assign(blankSettings(), state.settings || {});
    const parsed = P().parsePeerKey(publicKeyText);
    const theirPub = parsed.publicRaw;
    if (C().timingSafeEqual(theirPub, state.identity.publicRaw)) {
      throw new Error("Нельзя добавить свой ключ");
    }
    const fingerprint = await C().fingerprintDisplay(theirPub);
    const existing = state.contacts.find((c) => c.fingerprint === fingerprint);
    if (existing) {
      if (parsed.timed) {
        await attachSession(existing, parsed);
      } else {
        wipeContactSession(existing, { keepThread: true });
        existing.ttlSec = 0;
        existing.expiresAt = 0;
        existing.pairedAt = Date.now();
        existing.sessionWiped = false;
        if ((state.settings.keyTtlSec || 0) > 0) {
          state.settings.keyTtlSec = 0;
          state.settings.pendingSession = null;
        }
      }
      const nm = (name || "").trim().slice(0, 64);
      if (nm) existing.name = nm;
      await persist();
      return existing;
    }
    const contact = {
      id: fingerprint,
      name: (name || "Контакт").trim().slice(0, 64),
      theirPub,
      fingerprint,
      bindings: {},
      verified: false,
      createdAt: Date.now(),
      ttlSec: 0,
    };
    if (parsed.timed) {
      await attachSession(contact, parsed);
      state.contacts.push(contact);
      await persist();
      return contact;
    }
    /* Forever key while we had a timed offer → accept forever for this pair. */
    if ((state.settings.keyTtlSec || 0) > 0) {
      state.settings.keyTtlSec = 0;
      state.settings.pendingSession = null;
    }
    state.contacts.push(contact);
    await persist();
    return contact;
  }

  function wipeContactSession(c, opts) {
    if (c.sessionIkm && c.sessionIkm.fill) c.sessionIkm.fill(0);
    c.sessionIkm = null;
    c.sessionIkmB64 = null;
    c.sessionPrivB64 = null;
    c.sessionPubB64 = null;
    c.theirSessionPubB64 = null;
    c.sessionWiped = true;
    if (memory.state && memory.state.sentCache) {
      for (const k of Object.keys(memory.state.sentCache)) {
        if (memory.state.sentCache[k] && memory.state.sentCache[k].contactId === c.id) {
          delete memory.state.sentCache[k];
        }
      }
    }
    if (!(opts && opts.keepThread) && memory.state && memory.state.threads) delete memory.state.threads[c.id];
  }

  async function ensurePendingSession(ttlSec) {
    if (!P().isAllowedTtl(ttlSec)) throw new Error("Недопустимый срок ключей");
    const state = requireState();
    state.settings = Object.assign(defaultSettings(), state.settings || {});
    const cur = state.settings.pendingSession;
    const nowSec = Math.floor(Date.now() / 1000);
    const bound =
      cur &&
      state.contacts &&
      state.contacts.some((c) => c.sessionPubB64 && cur.pubB64 && c.sessionPubB64 === cur.pubB64);
    if (cur && cur.ttlSec === ttlSec && cur.privB64 && cur.pubB64 && nowSec - (cur.issuedAt || 0) < ttlSec && !bound) {
      return cur;
    }
    const kp = await C().generateX25519();
    const pending = {
      pubB64: C().bytesToB64url(kp.publicRaw),
      privB64: C().bytesToB64url(kp.privateRaw),
      ttlSec,
      issuedAt: nowSec,
    };
    state.settings.pendingSession = pending;
    await persist();
    return pending;
  }

  async function attachSession(c, parsed) {
    const state = requireState();
    if (!parsed.timed) {
      throw new Error("Нужен срочный ключ S256KT1 — бессрочный сюда не подходит.");
    }
    const want = (state.settings.keyTtlSec || 0) >>> 0;
    /* Pairing with their key = accept their lifetime for this contact (no trip to Keys). */
    if (want !== parsed.ttlSec) {
      state.settings.keyTtlSec = parsed.ttlSec;
      state.settings.pendingSession = null;
    }
    const pending = await ensurePendingSession(parsed.ttlSec);
    const sessionIkm = await C().x25519Dh(C().b64urlToBytes(pending.privB64), parsed.sessionPub);
    wipeContactSession(c);
    c.ttlSec = parsed.ttlSec;
    c.pairedAt = Date.now();
    c.expiresAt = c.pairedAt + parsed.ttlSec * 1000;
    c.sessionWiped = false;
    c.sessionPrivB64 = pending.privB64;
    c.sessionPubB64 = pending.pubB64;
    c.theirSessionPubB64 = C().bytesToB64url(parsed.sessionPub);
    c.sessionIkm = sessionIkm;
    /* Keep pending so the reply QR still advertises the same session ephemeral. */
  }

  function sessionView(c) {
    if (!c || !c.ttlSec) return { ttlSec: 0, expiresAt: 0, expired: false };
    const expired = !!(c.sessionWiped || !c.sessionIkm || Date.now() > (c.expiresAt || 0) + SESSION_GRACE_MS);
    return { ttlSec: c.ttlSec, expiresAt: c.expiresAt || 0, expired, label: ttlPhrase(c.ttlSec) };
  }

  async function expireSessions() {
    if (await enforceBurn()) return;
    if (!memory.state) return;
    const now = Date.now();
    let changed = false;
    for (const c of memory.state.contacts) {
      if (!c.ttlSec || c.sessionWiped) continue;
      if (now > (c.expiresAt || 0) + SESSION_GRACE_MS) {
        wipeContactSession(c);
        changed = true;
      }
    }
    if (changed) await persist();
  }

  /* Zero in-memory secrets and delete the vault blob. Deadline lives outside the
     ciphertext so this can run while locked (browser alarm / next open). */
  async function burnVaultNow() {
    if (memory.state && memory.state.identity && memory.state.identity.privateRaw && memory.state.identity.privateRaw.fill) {
      memory.state.identity.privateRaw.fill(0);
    }
    if (memory.state && memory.state.contacts) {
      for (const c of memory.state.contacts) wipeContactSession(c);
    }
    if (memory.key) memory.key.fill(0);
    memory.key = null;
    memory.salt = null;
    memory.state = null;
    memory.identity = null;
    await removeSession(SESSION_KEY);
    await removeSession(KEY_KEY);
    await removeLocal(STORAGE_KEY);
    await removeLocal(BURN_AT_KEY);
    return true;
  }

  async function getBurnAt() {
    const raw = await getLocal(BURN_AT_KEY);
    const n = Number(raw || 0);
    return n > 0 ? n : 0;
  }

  async function enforceBurn() {
    const at = await getBurnAt();
    if (!at || Date.now() < at) return false;
    await burnVaultNow();
    return true;
  }

  function burnView() {
    const state = memory.state;
    const sec = state && state.settings ? Number(state.settings.burnVaultSec || 0) || 0 : 0;
    const at = state && state.settings ? Number(state.settings.burnAt || 0) || 0 : 0;
    return {
      burnVaultSec: sec,
      burnAt: at,
      active: sec > 0 && at > 0,
      remainingMs: at > Date.now() ? at - Date.now() : 0,
    };
  }

  async function setVerified(id, verified) {
    const state = requireState();
    const c = state.contacts.find((x) => x.id === id);
    if (!c) throw new Error("Контакт не найден");
    c.verified = !!verified;
    await persist();
    return c;
  }

  async function setSetting(key, value) {
    const state = requireState();
    state.settings = Object.assign(blankSettings(), state.settings || {});
    if (key === "keyTtlSec") {
      const n = Number(value) >>> 0;
      if (n !== 0 && !P().isAllowedTtl(n)) throw new Error("Недопустимый срок ключей");
      state.settings.keyTtlSec = n;
      state.settings.pendingSession = null;
      state.settings.safeLocked = false;
    } else if (key === "pageDecrypt") {
      state.settings.pageDecrypt = !!value;
    } else if (key === "stealthWire") {
      state.settings.stealthWire = !!value;
    } else if (key === "burnVaultSec") {
      /* Optional whole-vault burn — independent of per-contact TTL. */
      const n = Number(value) >>> 0;
      if (n !== 0 && !P().isAllowedTtl(n)) throw new Error("Недопустимый срок сжигания");
      state.settings.burnVaultSec = n;
      if (!n) {
        state.settings.burnAt = 0;
        await removeLocal(BURN_AT_KEY);
      } else {
        const end = Date.now() + n * 1000;
        const prev = Number(state.settings.burnAt || 0) || 0;
        state.settings.burnAt = prev > Date.now() ? Math.min(prev, end) : end;
        await setLocal(BURN_AT_KEY, String(state.settings.burnAt));
      }
    } else {
      state.settings[key] = value;
    }
    await persist();
    return state.settings;
  }

  async function removeContact(id) {
    const state = requireState();
    state.contacts = state.contacts.filter((c) => c.id !== id);
    for (const k of Object.keys(state.sentCache)) {
      if (state.sentCache[k] && state.sentCache[k].contactId === id) delete state.sentCache[k];
    }
    if (state.threads) delete state.threads[id];
    await persist();
  }

  async function renameContact(id, name) {
    const state = requireState();
    const c = state.contacts.find((x) => x.id === id);
    if (!c) throw new Error("Контакт не найден");
    const nm = String(name || "").trim().slice(0, 64);
    if (!nm) throw new Error("Пустое имя");
    c.name = nm;
    await persist();
    return c;
  }

  async function bindPeer(contactId, platform, peer) {
    const state = requireState();
    const c = state.contacts.find((x) => x.id === contactId);
    if (!c) throw new Error("Контакт не найден");
    const p = String(peer).trim();
    if (!p) throw new Error("Пустой id чата");
    for (const other of state.contacts) {
      if (other.id !== contactId && other.bindings[platform] === p) {
        delete other.bindings[platform];
      }
    }
    c.bindings[platform] = p;
    await persist();
    return c;
  }

  async function unbindPeer(contactId, platform) {
    const state = requireState();
    const c = state.contacts.find((x) => x.id === contactId);
    if (!c) throw new Error("Контакт не найден");
    delete c.bindings[platform];
    await persist();
  }

  function findByBinding(platform, peer) {
    const state = requireState();
    const p = String(peer);
    return state.contacts.find((c) => c.bindings[platform] === p) || null;
  }

  function findByFingerprint(fp) {
    const state = requireState();
    return state.contacts.find((c) => c.fingerprint === fp) || null;
  }

  async function encryptForContact(contactId, plaintext) {
    const state = requireState();
    await expireSessions();
    const c = state.contacts.find((x) => x.id === contactId);
    if (!c) throw new Error("Контакт не найден");
    if (c.ttlSec && (c.sessionWiped || !c.sessionIkm || Date.now() > (c.expiresAt || 0) + SESSION_GRACE_MS)) {
      if (!c.sessionWiped) {
        wipeContactSession(c);
        await persist();
      }
      const err = new Error("Срок ключей вышел. Обменяйтесь новыми ключами S256KT1.");
      err.code = "expired";
      throw err;
    }
    const rawText = String(plaintext || "");
    if (!rawText.trim()) throw new Error("Пустой текст");
    if (utf8Bytes(rawText).length > PLAIN_CHUNK_BYTES * FRAG_MAX_PARTS) {
      throw new Error("Слишком длинное сообщение (лимит ~" + Math.floor((PLAIN_CHUNK_BYTES * FRAG_MAX_PARTS) / 1000) + " тыс. символов)");
    }
    const stealth = state.settings.stealthWire !== false;
    const chunks = splitUtf8Chunks(rawText, PLAIN_CHUNK_BYTES);
    if (chunks.length > FRAG_MAX_PARTS) throw new Error("Слишком длинное сообщение");
    const packets = [];
    const fragId = chunks.length > 1 ? makeFragId() : null;
    for (let i = 0; i < chunks.length; i++) {
      const body = fragId ? "PLF1 " + fragId + " " + i + " " + chunks.length + "\n" + chunks[i] : chunks[i];
      const packet = await P().encrypt(body, state.identity, c.theirPub, c.sessionIkm || null, { stealth });
      if (packet.length > WIRE_MAX) {
        throw new Error("Кусок не влез в лимит VK (" + WIRE_MAX + "). Укоротите сообщение.");
      }
      packets.push(packet);
      state.sentCache[packet] = { text: body, contactId: c.id, fullText: rawText, fragId: fragId || "" };
    }
    const keys = Object.keys(state.sentCache);
    if (keys.length > 400) {
      for (const k of keys.slice(0, keys.length - 400)) delete state.sentCache[k];
    }
    appendThread(state, c.id, {
      packet: fragId ? "PLF:" + fragId : packets[0],
      text: rawText,
      outgoing: true,
      ts: Date.now(),
      known: true,
      verified: !!c.verified,
    });
    await persist();
    return packets;
  }

  async function encryptForPeer(platform, peer, plaintext) {
    const c = findByBinding(platform, peer);
    if (!c) throw new Error("Чат не привязан к контакту");
    return encryptForContact(c.id, plaintext);
  }

  async function decryptPacket(packet) {
    const state = requireState();
    await expireSessions();
    const trimmed = String(packet).trim().replace(/\s+/g, "");
    const cached = state.sentCache[trimmed] || state.sentCache[packet];
    if (cached) {
      const c = state.contacts.find((x) => x.id === cached.contactId) || null;
      return {
        text: cached.text,
        contact: c,
        outgoing: true,
        fullText: cached.fullText || cached.text,
        fragId: cached.fragId || "",
      };
    }
    try {
      const parsed = P().unpack(trimmed);
      if (C().timingSafeEqual(parsed.senderPub, state.identity.publicRaw)) {
        return {
          text: "[исходящее: открытый текст есть только на устройстве, с которого отправили]",
          contact: null,
          outgoing: true,
        };
      }
    } catch {
      /* fall through to inbound decrypt */
    }
    return P().decryptAny(trimmed, state.identity, state.contacts);
  }

  function packetInThreads(state, packet) {
    const threads = state.threads || {};
    for (const id of Object.keys(threads)) {
      const list = threads[id] || [];
      if (list.some((m) => m.packet === packet)) return true;
    }
    return false;
  }

  async function ingestPackets(packets) {
    const state = requireState();
    await expireSessions();
    if (!state.fragBuf) state.fragBuf = {};
    const list = Array.isArray(packets) ? packets : [packets];
    let added = 0;
    const contactIds = [];
    const seenId = Object.create(null);
    for (let i = 0; i < list.length; i++) {
      const packet = normalizePacket(list[i]);
      if (!packet || !P().isCiphertext(packet)) continue;
      if (packetInThreads(state, packet)) continue;
      let res;
      try {
        res = await decryptPacket(packet);
      } catch {
        continue;
      }
      const contactId = res.contact && res.contact.id;
      if (!contactId) continue;
      const frag = parseFrag(res.text);
      if (!frag) {
        if (
          appendThread(state, contactId, {
            packet,
            text: res.text,
            outgoing: !!res.outgoing,
            ts: Date.now() + i,
            known: res.outgoing ? true : !!res.known,
            verified: res.outgoing ? true : !!res.verified,
          })
        ) {
          added += 1;
          if (!res.outgoing && !seenId[contactId]) {
            seenId[contactId] = true;
            contactIds.push(contactId);
          }
        }
        continue;
      }
      const assembledPacket = "PLF:" + frag.id;
      const bufKey = contactId + ":" + frag.id;
      const buf = state.fragBuf[bufKey] || {
        total: frag.total,
        parts: {},
        ts: Date.now(),
        outgoing: !!res.outgoing,
        known: res.outgoing ? true : !!res.known,
        verified: res.outgoing ? true : !!res.verified,
      };
      buf.total = frag.total;
      buf.parts[String(frag.index)] = frag.payload;
      state.fragBuf[bufKey] = buf;
      let complete = true;
      const pieces = [];
      for (let p = 0; p < frag.total; p++) {
        if (typeof buf.parts[String(p)] !== "string") {
          complete = false;
          break;
        }
        pieces.push(buf.parts[String(p)]);
      }
      if (!complete) continue;
      delete state.fragBuf[bufKey];
      if (packetInThreads(state, assembledPacket)) continue;
      const full = pieces.join("");
      if (
        appendThread(state, contactId, {
          packet: assembledPacket,
          text: full,
          outgoing: !!buf.outgoing,
          ts: Date.now() + i,
          known: buf.known !== false,
          verified: !!buf.verified,
        })
      ) {
        added += 1;
        if (!buf.outgoing && !seenId[contactId]) {
          seenId[contactId] = true;
          contactIds.push(contactId);
        }
      }
    }
    if (added || Object.keys(state.fragBuf).length) await persist();
    return { added, contactIds };
  }

  function listChats() {
    const state = requireState();
    const rows = state.contacts.map((c) => {
      const msgs = (state.threads && state.threads[c.id]) || [];
      const last = msgs.length ? msgs[msgs.length - 1] : null;
      const sess = sessionView(c);
      return {
        id: c.id,
        name: c.name,
        fingerprint: c.fingerprint,
        verified: !!c.verified,
        bindings: c.bindings || {},
        lastText: last ? last.text : "",
        lastOutgoing: last ? !!last.outgoing : false,
        lastTs: last ? last.ts : c.createdAt || 0,
        count: msgs.length,
        expired: !!sess.expired,
        ttlSec: sess.ttlSec || 0,
      };
    });
    rows.sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
    return rows;
  }

  function getThread(contactId) {
    const state = requireState();
    const c = state.contacts.find((x) => x.id === contactId);
    if (!c) throw new Error("Контакт не найден");
    return {
      contact: {
        id: c.id,
        name: c.name,
        fingerprint: c.fingerprint,
        verified: !!c.verified,
        bindings: c.bindings || {},
      },
      session: sessionView(c),
      messages: ((state.threads && state.threads[c.id]) || []).slice(),
    };
  }

  async function exportBackup() {
    if (isBurnMode()) {
      throw new Error("Пока идёт сжигание всего хранилища, экспорт недоступен");
    }
    const blob = await getLocal(STORAGE_KEY);
    if (!blob) throw new Error("Нечего экспортировать");
    return blob;
  }

  async function importBackup(blob, password) {
    const res = await unwrapBlob(password, blob);
    memory.state = await hydrateState(JSON.parse(res.json));
    memory.identity = memory.state.identity;
    if (res.legacy || res.iter < ITERATIONS) adoptKey(await deriveFresh(password));
    else adoptKey(res);
    await persist();
    return memory.state;
  }

  async function changePassword(oldPass, newPass) {
    checkPassword(newPass);
    if (!memory.state) await unlock(oldPass);
    else {
      const blob = await getLocal(STORAGE_KEY);
      await unwrapBlob(oldPass, blob);
    }
    adoptKey(await deriveFresh(newPass));
    await persist();
  }

  async function destroy() {
    await burnVaultNow();
  }

  /* New long-term identity. Password must match. Contacts and history on this
     device become unreadable — they were sealed to the old key. Vault password stays. */
  async function rotateIdentity(password) {
    checkPassword(password);
    const blob = await getLocal(STORAGE_KEY);
    if (!blob) throw new Error("Хранилище ещё не создано");
    await unwrapBlob(password, blob);
    const state = requireState();
    if (state.identity && state.identity.privateRaw && state.identity.privateRaw.fill) {
      state.identity.privateRaw.fill(0);
    }
    for (const c of state.contacts) wipeContactSession(c);
    const identity = await C().generateIdentity();
    state.identity = identity;
    memory.identity = identity;
    state.contacts = [];
    state.sentCache = {};
    state.threads = {};
    state.settings = blankSettings();
    state.settings.pendingSession = null;
    state.settings.onboarded = false;
    await removeLocal(BURN_AT_KEY);
    state.threads = {};
    state.fragBuf = {};
    await persist();
    return state;
  }

  async function publicKeyText() {
    const state = requireState();
    const ttl = (state.settings && state.settings.keyTtlSec) >>> 0;
    if (!ttl) return P().encodePublicKey(state.identity.publicRaw);
    let pending = state.settings.pendingSession;
    /* Prefer existing pending (even after attach) so the reply QR matches the session just formed. */
    if (!pending || pending.ttlSec !== ttl || !pending.pubB64 || !pending.privB64) {
      pending = await ensurePendingSession(ttl);
    }
    return P().encodeTimedKey(
      state.identity.publicRaw,
      C().b64urlToBytes(pending.pubB64),
      pending.ttlSec,
      pending.issuedAt
    );
  }

  async function myFingerprint() {
    const state = requireState();
    return C().fingerprintDisplay(state.identity.publicRaw);
  }

  function getSettings() {
    return requireState().settings;
  }

  async function setStrict(v) {
    requireState().settings.strict = !!v;
    await persist();
  }

  global.S256Vault = {
    hasVault,
    create,
    unlock,
    restoreSession,
    lock,
    persist,
    addContact,
    removeContact,
    renameContact,
    setVerified,
    setSetting,
    bindPeer,
    unbindPeer,
    findByBinding,
    findByFingerprint,
    encryptForContact,
    encryptForPeer,
    decryptPacket,
    ingestPackets,
    listChats,
    getThread,
    expireSessions,
    sessionView,
    ttlPhrase,
    enforceBurn,
    burnView,
    getBurnAt,
    burnVaultNow,
    ensureSafePair,
    setPairMode,
    pairModeView,
    isSafeLocked,
    isBurnMode,
    commitSafePair,
    exportBackup,
    importBackup,
    changePassword,
    rotateIdentity,
    destroy,
    publicKeyText,
    myFingerprint,
    getSettings,
    setStrict,
    requireState,
    isUnlocked: () => !!memory.state,
    canWrite: () => !!(memory.state && memory.key),
    getState: () => memory.state,
    probeStore,
    persistMode: () => persistMode,
    ITERATIONS,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
