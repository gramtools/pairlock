/* Pairlock wire — AES-256-GCM + X25519. Classic prefix S256M1. still works;
   stealth mode sends a random-looking base64 blob without a brand tag.
   Version 2 = burn-pair packets: hash ratchet, unread after the view window. */
(function (global) {
  const C = () => global.S256Crypto;
  const PREFIX = "S256M1.";
  const KEY_PREFIX = "S256K1.";
  const TIMED_PREFIX = "S256KT1.";
  const BURN_PREFIX = "S256KB1.";
  const VERSION = 1;
  const VERSION_BURN = 2;
  const INFO = C().utf8("s256m-v1-msg");
  const BURN_INFO = C().utf8("s256m-v2-burn");
  const BURN_CK_INFO = C().utf8("pairlock-burn-ck-v1");
  const BURN_MSG_INFO = C().utf8("pairlock-burn-msg-v1");
  const BURN_NEXT_INFO = C().utf8("pairlock-burn-next-v1");
  const WIRE_INFO = C().utf8("pairlock-wire-v1");
  const STEALTH_PAD = 4;
  const STEALTH_TAG = 3;
  const BODY_MIN = 1 + 32 + 32 + 12 + 16;
  const BODY_MIN_BURN = 1 + 32 + 32 + 12 + 4 + 4 + 2 + 16;
  const STEALTH_MIN = STEALTH_PAD + BODY_MIN + STEALTH_TAG;
  const TTL_SECONDS = Object.freeze([900, 1800, 3600, 86400, 604800]);
  const TTL_SET = Object.freeze(Object.fromEntries(TTL_SECONDS.map((n) => [n, true])));
  const BURN_SECONDS = Object.freeze([30, 60, 120]);
  const BURN_SET = Object.freeze(Object.fromEntries(BURN_SECONDS.map((n) => [n, true])));
  const SKIP_MAX = 16;
  const UNOPENED_MAX_SEC = 7 * 86400;
  const PEER_KEY_RE =
    /S256KB1\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}\.(?:30|60|120)\.(?:0|900|1800|3600|86400|604800)\.\d{10}|S256KT1\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}\.(?:900|1800|3600|86400|604800)\.\d{10}|S256K1\.[A-Za-z0-9_-]{43}/;

  function u16(n) {
    return Uint8Array.of((n >>> 8) & 255, n & 255);
  }

  function u32(n) {
    return Uint8Array.of((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
  }

  function readU16(bytes, o) {
    return ((bytes[o] << 8) | bytes[o + 1]) >>> 0;
  }

  function readU32(bytes, o) {
    return ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0;
  }

  function wireTag(body) {
    if (typeof nacl !== "undefined" && nacl.hash) {
      return nacl.hash(C().concatBytes([WIRE_INFO, body])).subarray(0, STEALTH_TAG);
    }
    let h = 2166136261 >>> 0;
    for (let i = 0; i < WIRE_INFO.length; i++) h = Math.imul(h ^ WIRE_INFO[i], 16777619) >>> 0;
    for (let i = 0; i < body.length; i++) h = Math.imul(h ^ body[i], 16777619) >>> 0;
    return Uint8Array.of((h >>> 16) & 255, (h >>> 8) & 255, h & 255);
  }

  function looksLikeStealthToken(t) {
    if (typeof t !== "string") return false;
    const s = t.trim().replace(/\s+/g, "");
    if (s.length < 120 || s.length > 5000) return false;
    if (!/^[A-Za-z0-9_-]+$/.test(s)) return false;
    if (s.startsWith(PREFIX) || s.startsWith(KEY_PREFIX) || s.startsWith(TIMED_PREFIX) || s.startsWith(BURN_PREFIX)) {
      return false;
    }
    const approx = Math.floor((s.length * 3) / 4);
    return approx >= STEALTH_MIN;
  }

  function isCiphertext(text) {
    if (typeof text !== "string") return false;
    const t = text.trim().replace(/\s+/g, "");
    if (t.startsWith(PREFIX)) return true;
    if (!looksLikeStealthToken(t)) return false;
    try {
      const raw = C().b64urlToBytes(t);
      if (raw.length < STEALTH_MIN) return false;
      const body = raw.subarray(STEALTH_PAD, raw.length - STEALTH_TAG);
      const tag = raw.subarray(raw.length - STEALTH_TAG);
      if (body.length < BODY_MIN) return false;
      if (body[0] !== VERSION && body[0] !== VERSION_BURN) return false;
      if (body[0] === VERSION_BURN && body.length < BODY_MIN_BURN) return false;
      return C().timingSafeEqual(tag, wireTag(body));
    } catch {
      return false;
    }
  }

  function normalizePeerKey(text) {
    const compact = String(text || "").replace(/[\s\u00ad\u200b\u200c\u200d\u2060\ufeff]/g, "");
    const m = compact.match(PEER_KEY_RE);
    return m ? m[0] : compact;
  }

  function isPublicKey(text) {
    const t = typeof text === "string" ? text.trim() : "";
    return t.startsWith(KEY_PREFIX) || t.startsWith(TIMED_PREFIX) || t.startsWith(BURN_PREFIX);
  }

  function isTimedKey(text) {
    return typeof text === "string" && text.trim().startsWith(TIMED_PREFIX);
  }

  function isBurnKey(text) {
    return typeof text === "string" && text.trim().startsWith(BURN_PREFIX);
  }

  function isAllowedTtl(sec) {
    return !!TTL_SET[sec >>> 0];
  }

  function isAllowedBurnTtl(sec) {
    return !!BURN_SET[sec >>> 0];
  }

  function encodePublicKey(publicRaw) {
    return KEY_PREFIX + C().bytesToB64url(publicRaw);
  }

  function decodePublicKey(text) {
    const t = normalizePeerKey(text);
    if (!t.startsWith(KEY_PREFIX) || t.startsWith(TIMED_PREFIX) || t.startsWith(BURN_PREFIX)) {
      throw new Error("Это не публичный ключ Pairlock");
    }
    if (!/^S256K1\.[A-Za-z0-9_-]{43}$/.test(t)) throw new Error("Повреждённый ключ");
    const raw = C().b64urlToBytes(t.slice(KEY_PREFIX.length));
    if (raw.length !== 32) throw new Error("Неверная длина ключа");
    return raw;
  }

  function encodeTimedKey(identityPub, sessionPub, ttlSec, issuedAt) {
    const ttl = ttlSec >>> 0;
    if (!TTL_SET[ttl]) throw new Error("Недопустимый срок ключей");
    const id = identityPub instanceof Uint8Array ? identityPub : new Uint8Array(identityPub);
    const sess = sessionPub instanceof Uint8Array ? sessionPub : new Uint8Array(sessionPub);
    if (id.length !== 32 || sess.length !== 32) throw new Error("Неверная длина ключа");
    const issued = issuedAt >>> 0;
    if (!issued) throw new Error("Нет времени выпуска ключа");
    return TIMED_PREFIX + C().bytesToB64url(id) + "." + C().bytesToB64url(sess) + "." + ttl + "." + issued;
  }

  function decodeTimedKey(text) {
    const t = normalizePeerKey(text);
    if (!t.startsWith(TIMED_PREFIX)) throw new Error("Это не срочный ключ Pairlock");
    const parts = t.split(".");
    if (parts.length !== 5 || parts[0] !== "S256KT1") throw new Error("Повреждённый срочный ключ");
    if (parts[1].length !== 43 || parts[2].length !== 43) throw new Error("Повреждённый срочный ключ");
    const identityPub = C().b64urlToBytes(parts[1]);
    const sessionPub = C().b64urlToBytes(parts[2]);
    const ttlSec = Number(parts[3]);
    const issuedAt = Number(parts[4]);
    if (identityPub.length !== 32 || sessionPub.length !== 32) throw new Error("Неверная длина ключа");
    if (!TTL_SET[ttlSec]) throw new Error("Недопустимый срок ключей");
    if (!Number.isFinite(issuedAt) || issuedAt < 1) throw new Error("Повреждённый срочный ключ");
    return { identityPub, sessionPub, ttlSec, issuedAt };
  }

  function encodeBurnKey(identityPub, sessionPub, burnTtlSec, pairTtlSec, issuedAt) {
    const burn = burnTtlSec >>> 0;
    const pair = pairTtlSec >>> 0;
    if (!BURN_SET[burn]) throw new Error("Недопустимое окно сгорания");
    if (pair !== 0 && !TTL_SET[pair]) throw new Error("Недопустимый срок ключей");
    const id = identityPub instanceof Uint8Array ? identityPub : new Uint8Array(identityPub);
    const sess = sessionPub instanceof Uint8Array ? sessionPub : new Uint8Array(sessionPub);
    if (id.length !== 32 || sess.length !== 32) throw new Error("Неверная длина ключа");
    const issued = issuedAt >>> 0;
    if (!issued) throw new Error("Нет времени выпуска ключа");
    return (
      BURN_PREFIX +
      C().bytesToB64url(id) +
      "." +
      C().bytesToB64url(sess) +
      "." +
      burn +
      "." +
      pair +
      "." +
      issued
    );
  }

  function decodeBurnKey(text) {
    const t = normalizePeerKey(text);
    if (!t.startsWith(BURN_PREFIX)) throw new Error("Это не ключ сгорающей пары");
    const parts = t.split(".");
    if (parts.length !== 6 || parts[0] !== "S256KB1") throw new Error("Повреждённый ключ сгорания");
    if (parts[1].length !== 43 || parts[2].length !== 43) throw new Error("Повреждённый ключ сгорания");
    const identityPub = C().b64urlToBytes(parts[1]);
    const sessionPub = C().b64urlToBytes(parts[2]);
    const burnTtlSec = Number(parts[3]);
    const ttlSec = Number(parts[4]);
    const issuedAt = Number(parts[5]);
    if (identityPub.length !== 32 || sessionPub.length !== 32) throw new Error("Неверная длина ключа");
    if (!BURN_SET[burnTtlSec]) throw new Error("Недопустимое окно сгорания");
    if (ttlSec !== 0 && !TTL_SET[ttlSec]) throw new Error("Недопустимый срок ключей");
    if (!Number.isFinite(issuedAt) || issuedAt < 1) throw new Error("Повреждённый ключ сгорания");
    return { identityPub, sessionPub, burnTtlSec, ttlSec, issuedAt };
  }

  function parsePeerKey(text) {
    const t = normalizePeerKey(text);
    if (t.startsWith(BURN_PREFIX)) {
      const d = decodeBurnKey(t);
      return {
        timed: d.ttlSec > 0,
        burn: true,
        publicRaw: d.identityPub,
        sessionPub: d.sessionPub,
        ttlSec: d.ttlSec,
        burnTtlSec: d.burnTtlSec,
        issuedAt: d.issuedAt,
      };
    }
    if (t.startsWith(TIMED_PREFIX)) {
      const d = decodeTimedKey(t);
      return {
        timed: true,
        burn: false,
        publicRaw: d.identityPub,
        sessionPub: d.sessionPub,
        ttlSec: d.ttlSec,
        burnTtlSec: 0,
        issuedAt: d.issuedAt,
      };
    }
    return {
      timed: false,
      burn: false,
      publicRaw: decodePublicKey(t),
      sessionPub: null,
      ttlSec: 0,
      burnTtlSec: 0,
      issuedAt: 0,
    };
  }

  async function messageKey(ephDh, idDh, nonce, senderPub, theirPub, sessionIkm, extra) {
    const parts = [ephDh, idDh];
    if (sessionIkm && sessionIkm.length) parts.push(sessionIkm);
    if (extra && extra.length) parts.push(extra);
    const ikm = C().concatBytes(parts);
    const infoParts = [extra && extra.length ? BURN_INFO : INFO, senderPub, theirPub, nonce];
    if (sessionIkm && sessionIkm.length) infoParts.push(sessionIkm);
    if (extra && extra.length) infoParts.push(extra);
    return C().hkdf(ikm, nonce, C().concatBytes(infoParts), 32);
  }

  async function deriveBurnChains(root, myPub, theirPub) {
    const salt = new Uint8Array(32);
    const ckSend = await C().hkdf(root, salt, C().concatBytes([BURN_CK_INFO, myPub, theirPub]), 32);
    const ckRecv = await C().hkdf(root, salt, C().concatBytes([BURN_CK_INFO, theirPub, myPub]), 32);
    return { ckSend, ckRecv };
  }

  async function ratchetStep(ck, counter) {
    const n = u32(counter >>> 0);
    const msgKey = await C().hkdf(ck, n, BURN_MSG_INFO, 32);
    const nextCk = await C().hkdf(ck, n, BURN_NEXT_INFO, 32);
    return { msgKey, nextCk };
  }

  function packBody(senderPub, ephPub, nonce, ciphertext) {
    return C().concatBytes([Uint8Array.of(VERSION), senderPub, ephPub, nonce, ciphertext]);
  }

  function packBurnBody(senderPub, ephPub, nonce, counter, issuedAt, burnTtl, ciphertext) {
    return C().concatBytes([
      Uint8Array.of(VERSION_BURN),
      senderPub,
      ephPub,
      nonce,
      u32(counter),
      u32(issuedAt),
      u16(burnTtl),
      ciphertext,
    ]);
  }

  function wrapWire(body, stealth) {
    if (!stealth) return PREFIX + C().bytesToB64url(body);
    const pad = C().randomBytes(STEALTH_PAD);
    const tag = wireTag(body);
    return C().bytesToB64url(C().concatBytes([pad, body, tag]));
  }

  function pack(senderPub, ephPub, nonce, ciphertext, stealth) {
    return wrapWire(packBody(senderPub, ephPub, nonce, ciphertext), stealth);
  }

  function rawBody(text) {
    const t = String(text).trim().replace(/\s+/g, "");
    if (t.startsWith(PREFIX)) return C().b64urlToBytes(t.slice(PREFIX.length));
    const raw = C().b64urlToBytes(t);
    if (raw.length < STEALTH_MIN) throw new Error("Слишком короткий пакет");
    const body = raw.subarray(STEALTH_PAD, raw.length - STEALTH_TAG);
    const tag = raw.subarray(raw.length - STEALTH_TAG);
    if (!C().timingSafeEqual(tag, wireTag(body))) throw new Error("Это не пакет Pairlock");
    return body;
  }

  function unpack(text) {
    const body = rawBody(text);
    if (body.length < BODY_MIN) throw new Error("Слишком короткий пакет");
    const version = body[0];
    if (version !== VERSION && version !== VERSION_BURN) throw new Error("Неизвестная версия протокола");
    let o = 1;
    const senderPub = body.subarray(o, o + 32);
    o += 32;
    const ephPub = body.subarray(o, o + 32);
    o += 32;
    const nonce = body.subarray(o, o + 12);
    o += 12;
    if (version === VERSION) {
      return { version, senderPub, ephPub, nonce, ciphertext: body.subarray(o), burn: false };
    }
    if (body.length < BODY_MIN_BURN) throw new Error("Слишком короткий пакет");
    const counter = readU32(body, o);
    o += 4;
    const issuedAt = readU32(body, o);
    o += 4;
    const burnTtl = readU16(body, o);
    o += 2;
    if (!BURN_SET[burnTtl]) throw new Error("Недопустимое окно сгорания");
    return {
      version,
      senderPub,
      ephPub,
      nonce,
      counter,
      issuedAt,
      burnTtl,
      ciphertext: body.subarray(o),
      burn: true,
    };
  }

  async function encrypt(plaintext, myIdentity, theirPub, sessionIkm, opts) {
    if (!plaintext) throw new Error("Пустой текст");
    const stealth = !!(opts && opts.stealth);
    const burn = opts && opts.burn;
    const eph = await C().generateX25519();
    const ephPub = await C().exportRawPublic(eph);
    const ephDh = await C().x25519Dh(eph.privateKey, theirPub);
    const idDh = await C().x25519Dh(myIdentity.privateKey, theirPub);
    const nonce = C().randomBytes(12);
    if (burn) {
      if (!BURN_SET[burn.burnTtl >>> 0]) throw new Error("Недопустимое окно сгорания");
      if (!burn.msgKey || burn.msgKey.length !== 32) throw new Error("Нет ключа ratchet");
      const mk = await messageKey(ephDh, idDh, nonce, myIdentity.publicRaw, theirPub, null, burn.msgKey);
      const ad = C().concatBytes([Uint8Array.of(VERSION_BURN), myIdentity.publicRaw, ephPub, u32(burn.counter >>> 0)]);
      const ct = await C().aesGcmEncrypt(mk, nonce, C().utf8(plaintext), ad);
      const issuedAt = (burn.issuedAt >>> 0) || Math.floor(Date.now() / 1000);
      return wrapWire(
        packBurnBody(myIdentity.publicRaw, ephPub, nonce, burn.counter >>> 0, issuedAt, burn.burnTtl >>> 0, ct),
        stealth
      );
    }
    const mk = await messageKey(ephDh, idDh, nonce, myIdentity.publicRaw, theirPub, sessionIkm);
    const ad = C().concatBytes([Uint8Array.of(VERSION), myIdentity.publicRaw, ephPub]);
    const ct = await C().aesGcmEncrypt(mk, nonce, C().utf8(plaintext), ad);
    return pack(myIdentity.publicRaw, ephPub, nonce, ct, stealth);
  }

  async function decrypt(packet, myIdentity, expectedSenderPub, sessionIkm, opts) {
    const parsed = unpack(packet);
    const { senderPub, ephPub, nonce, ciphertext } = parsed;
    if (expectedSenderPub && !C().timingSafeEqual(senderPub, expectedSenderPub)) {
      throw new Error("Ключ отправителя не совпадает с контактом");
    }
    if (C().timingSafeEqual(senderPub, myIdentity.publicRaw)) {
      throw new Error("Пакет отправлен нами — расшифровка чужим ключом");
    }
    const ephDh = await C().x25519Dh(myIdentity.privateKey, ephPub);
    const idDh = await C().x25519Dh(myIdentity.privateKey, senderPub);
    if (parsed.burn) {
      const msgKey = opts && opts.msgKey;
      if (!msgKey || msgKey.length !== 32) throw new Error("Нет ключа ratchet");
      const mk = await messageKey(ephDh, idDh, nonce, senderPub, myIdentity.publicRaw, null, msgKey);
      const ad = C().concatBytes([Uint8Array.of(VERSION_BURN), senderPub, ephPub, u32(parsed.counter)]);
      try {
        const pt = await C().aesGcmDecrypt(mk, nonce, ciphertext, ad);
        return C().utf8dec(pt);
      } catch {
        throw new Error("Не расшифровалось. Чужой ключ или повреждённый текст.");
      }
    }
    const mk = await messageKey(ephDh, idDh, nonce, senderPub, myIdentity.publicRaw, sessionIkm);
    const ad = C().concatBytes([Uint8Array.of(VERSION), senderPub, ephPub]);
    try {
      const pt = await C().aesGcmDecrypt(mk, nonce, ciphertext, ad);
      return C().utf8dec(pt);
    } catch {
      throw new Error("Не расшифровалось. Чужой ключ или повреждённый текст.");
    }
  }

  async function decryptAny(packet, myIdentity, contacts) {
    const parsed = unpack(packet);
    if (C().timingSafeEqual(parsed.senderPub, myIdentity.publicRaw)) {
      throw new Error("Исходящие без локальной копии не восстанавливаются — это нормально");
    }
    if (parsed.burn) {
      throw new Error("Сгорающее сообщение открывается только через сейф пары");
    }
    const fp = await C().fingerprintDisplay(parsed.senderPub);
    const contact = contacts.find((c) => c.fingerprint === fp);
    const theirPub = contact ? contact.theirPub : parsed.senderPub;
    const sessionIkm = contact && contact.sessionIkm ? contact.sessionIkm : null;
    const text = await decrypt(packet, myIdentity, contact ? theirPub : parsed.senderPub, sessionIkm);
    return {
      text,
      contact: contact || null,
      known: !!contact,
      verified: !!(contact && contact.verified),
      outgoing: false,
      senderPub: parsed.senderPub,
      senderFingerprint: fp,
    };
  }

  global.S256Protocol = {
    PREFIX,
    KEY_PREFIX,
    TIMED_PREFIX,
    BURN_PREFIX,
    VERSION,
    VERSION_BURN,
    TTL_SECONDS,
    BURN_SECONDS,
    SKIP_MAX,
    UNOPENED_MAX_SEC,
    isCiphertext,
    looksLikeStealthToken,
    isPublicKey,
    isTimedKey,
    isBurnKey,
    isAllowedTtl,
    isAllowedBurnTtl,
    encodePublicKey,
    decodePublicKey,
    encodeTimedKey,
    decodeTimedKey,
    encodeBurnKey,
    decodeBurnKey,
    parsePeerKey,
    deriveBurnChains,
    ratchetStep,
    unpack,
    encrypt,
    decrypt,
    decryptAny,
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
