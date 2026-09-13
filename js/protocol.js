/* Pairlock wire — AES-256-GCM + X25519. Classic prefix S256M1. still works;
   stealth mode sends a random-looking base64 blob without a brand tag. */
(function (global) {
  const C = () => global.S256Crypto;
  const PREFIX = "S256M1.";
  const KEY_PREFIX = "S256K1.";
  const TIMED_PREFIX = "S256KT1.";
  const VERSION = 1;
  const INFO = C().utf8("s256m-v1-msg");
  const WIRE_INFO = C().utf8("pairlock-wire-v1");
  const STEALTH_PAD = 4;
  const STEALTH_TAG = 3;
  const BODY_MIN = 1 + 32 + 32 + 12 + 16;
  const STEALTH_MIN = STEALTH_PAD + BODY_MIN + STEALTH_TAG;
  /* Only these lifetimes are valid in a timed key. Anything else is rejected. */
  const TTL_SECONDS = Object.freeze([900, 1800, 3600, 86400, 604800]);
  const TTL_SET = Object.freeze(Object.fromEntries(TTL_SECONDS.map((n) => [n, true])));
  /* 32-byte X25519 → 43 chars base64url. Do not use greedy [A-Za-z0-9_-]+ — chat times like "13:45" stick to the key. */
  const PEER_KEY_RE =
    /S256KT1\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}\.(?:900|1800|3600|86400|604800)\.\d{10}|S256K1\.[A-Za-z0-9_-]{43}/;

  function wireTag(body) {
    /* Public recognition tag (not a secret MAC). nacl.hash = SHA-512. */
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
    if (s.startsWith(PREFIX) || s.startsWith(KEY_PREFIX) || s.startsWith(TIMED_PREFIX)) return false;
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
      if (body.length < BODY_MIN || body[0] !== VERSION) return false;
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
    return t.startsWith(KEY_PREFIX) || t.startsWith(TIMED_PREFIX);
  }

  function isTimedKey(text) {
    return typeof text === "string" && text.trim().startsWith(TIMED_PREFIX);
  }

  function isAllowedTtl(sec) {
    return !!TTL_SET[sec >>> 0];
  }

  function encodePublicKey(publicRaw) {
    return KEY_PREFIX + C().bytesToB64url(publicRaw);
  }

  function decodePublicKey(text) {
    const t = normalizePeerKey(text);
    if (!t.startsWith(KEY_PREFIX) || t.startsWith(TIMED_PREFIX)) throw new Error("Это не публичный ключ S256");
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
    if (!t.startsWith(TIMED_PREFIX)) throw new Error("Это не срочный ключ S256");
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

  /* K1 = forever identity. KT1 = identity + session pub + ttl, both sides must match. */
  function parsePeerKey(text) {
    const t = normalizePeerKey(text);
    if (t.startsWith(TIMED_PREFIX)) {
      const d = decodeTimedKey(t);
      return {
        timed: true,
        publicRaw: d.identityPub,
        sessionPub: d.sessionPub,
        ttlSec: d.ttlSec,
        issuedAt: d.issuedAt,
      };
    }
    return { timed: false, publicRaw: decodePublicKey(t), sessionPub: null, ttlSec: 0, issuedAt: 0 };
  }

  async function messageKey(ephDh, idDh, nonce, senderPub, theirPub, sessionIkm) {
    const parts = [ephDh, idDh];
    if (sessionIkm && sessionIkm.length) parts.push(sessionIkm);
    const ikm = C().concatBytes(parts);
    const infoParts = [INFO, senderPub, theirPub, nonce];
    if (sessionIkm && sessionIkm.length) infoParts.push(sessionIkm);
    return C().hkdf(ikm, nonce, C().concatBytes(infoParts), 32);
  }

  function packBody(senderPub, ephPub, nonce, ciphertext) {
    return C().concatBytes([
      Uint8Array.of(VERSION),
      senderPub,
      ephPub,
      nonce,
      ciphertext,
    ]);
  }

  function pack(senderPub, ephPub, nonce, ciphertext, stealth) {
    const body = packBody(senderPub, ephPub, nonce, ciphertext);
    if (!stealth) return PREFIX + C().bytesToB64url(body);
    /* Random pad → each message starts with different characters. No "S256M1." brand. */
    const pad = C().randomBytes(STEALTH_PAD);
    const tag = wireTag(body);
    return C().bytesToB64url(C().concatBytes([pad, body, tag]));
  }

  function unpack(text) {
    const t = String(text).trim().replace(/\s+/g, "");
    let body;
    if (t.startsWith(PREFIX)) {
      body = C().b64urlToBytes(t.slice(PREFIX.length));
    } else {
      const raw = C().b64urlToBytes(t);
      if (raw.length < STEALTH_MIN) throw new Error("Слишком короткий пакет");
      body = raw.subarray(STEALTH_PAD, raw.length - STEALTH_TAG);
      const tag = raw.subarray(raw.length - STEALTH_TAG);
      if (!C().timingSafeEqual(tag, wireTag(body))) throw new Error("Это не пакет Pairlock");
    }
    if (body.length < BODY_MIN) throw new Error("Слишком короткий пакет");
    if (body[0] !== VERSION) throw new Error("Неизвестная версия протокола");
    let o = 1;
    const senderPub = body.subarray(o, o + 32); o += 32;
    const ephPub = body.subarray(o, o + 32); o += 32;
    const nonce = body.subarray(o, o + 12); o += 12;
    const ciphertext = body.subarray(o);
    return { senderPub, ephPub, nonce, ciphertext };
  }

  async function encrypt(plaintext, myIdentity, theirPub, sessionIkm, opts) {
    if (!plaintext) throw new Error("Пустой текст");
    const stealth = !!(opts && opts.stealth);
    const eph = await C().generateX25519();
    const ephPub = await C().exportRawPublic(eph);
    const ephDh = await C().x25519Dh(eph.privateKey, theirPub);
    const idDh = await C().x25519Dh(myIdentity.privateKey, theirPub);
    const nonce = C().randomBytes(12);
    const mk = await messageKey(ephDh, idDh, nonce, myIdentity.publicRaw, theirPub, sessionIkm);
    const ad = C().concatBytes([Uint8Array.of(VERSION), myIdentity.publicRaw, ephPub]);
    const ct = await C().aesGcmEncrypt(mk, nonce, C().utf8(plaintext), ad);
    return pack(myIdentity.publicRaw, ephPub, nonce, ct, stealth);
  }

  async function decrypt(packet, myIdentity, expectedSenderPub, sessionIkm) {
    const { senderPub, ephPub, nonce, ciphertext } = unpack(packet);
    if (expectedSenderPub && !C().timingSafeEqual(senderPub, expectedSenderPub)) {
      throw new Error("Ключ отправителя не совпадает с контактом");
    }
    if (C().timingSafeEqual(senderPub, myIdentity.publicRaw)) {
      throw new Error("Пакет отправлен нами — расшифровка чужим ключом");
    }
    const ephDh = await C().x25519Dh(myIdentity.privateKey, ephPub);
    const idDh = await C().x25519Dh(myIdentity.privateKey, senderPub);
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
    const { senderPub } = unpack(packet);
    if (C().timingSafeEqual(senderPub, myIdentity.publicRaw)) {
      for (const c of contacts) {
        try {
          return {
            text: await decryptSentByUs(packet, myIdentity, c.theirPub),
            contact: c,
            outgoing: true,
          };
        } catch {
          /* try next */
        }
      }
      throw new Error("Исходящее, но контакт не найден");
    }
    const fp = await C().fingerprintDisplay(senderPub);
    const contact = contacts.find((c) => c.fingerprint === fp);
    const theirPub = contact ? contact.theirPub : senderPub;
    const sessionIkm = contact && contact.sessionIkm ? contact.sessionIkm : null;
    const text = await decrypt(packet, myIdentity, contact ? theirPub : senderPub, sessionIkm);
    return {
      text,
      contact: contact || null,
      known: !!contact,
      verified: !!(contact && contact.verified),
      outgoing: false,
      senderPub,
      senderFingerprint: fp,
    };
  }

  async function decryptSentByUs(packet, myIdentity, theirPub) {
    const { senderPub } = unpack(packet);
    if (!C().timingSafeEqual(senderPub, myIdentity.publicRaw)) {
      throw new Error("Не наше исходящее");
    }
    throw new Error("Исходящие без локальной копии не восстанавливаются — это нормально");
  }

  global.S256Protocol = {
    PREFIX,
    KEY_PREFIX,
    TIMED_PREFIX,
    VERSION,
    TTL_SECONDS,
    isCiphertext,
    looksLikeStealthToken,
    isPublicKey,
    isTimedKey,
    isAllowedTtl,
    encodePublicKey,
    decodePublicKey,
    encodeTimedKey,
    decodeTimedKey,
    parsePeerKey,
    encrypt,
    decrypt,
    decryptAny,
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
