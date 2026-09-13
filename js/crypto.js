/* S256 — Web Crypto primitives. No network, no third-party code. */
(function (global) {
  const te = new TextEncoder();
  const td = new TextDecoder();

  function concatBytes(parts) {
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      out.set(p, off);
      off += p.length;
    }
    return out;
  }

  function bytesToB64url(bytes) {
    let bin = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  function b64urlToBytes(s) {
    const t = String(s || "");
    if (!t || /[^A-Za-z0-9+/=_-]/.test(t) || t.length % 4 === 1) {
      throw new Error("Повреждённый ключ");
    }
    try {
      const pad = "=".repeat((4 - (t.length % 4)) % 4);
      const b64 = t.replace(/-/g, "+").replace(/_/g, "/") + pad;
      const bin = atob(b64);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    } catch (e) {
      if (e && e.message === "Повреждённый ключ") throw e;
      throw new Error("Повреждённый ключ");
    }
  }

  function utf8(str) {
    return te.encode(str);
  }

  function utf8dec(bytes) {
    return td.decode(bytes);
  }

  function timingSafeEqual(a, b) {
    if (a.length !== b.length) return false;
    let x = 0;
    for (let i = 0; i < a.length; i++) x |= a[i] ^ b[i];
    return x === 0;
  }

  function randomBytes(n) {
    const u = new Uint8Array(n);
    crypto.getRandomValues(u);
    return u;
  }

  async function sha256(bytes) {
    return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  }

  async function hkdf(ikm, salt, info, length) {
    const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt, info },
      key,
      length * 8
    );
    return new Uint8Array(bits);
  }

  async function pbkdf2(password, salt, iterations) {
    const base = await crypto.subtle.importKey("raw", utf8(password), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt, iterations },
      base,
      256
    );
    return new Uint8Array(bits);
  }

  async function aesGcmEncrypt(keyBytes, nonce, plaintext, ad) {
    const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
    const buf = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, additionalData: ad, tagLength: 128 },
      key,
      plaintext
    );
    return new Uint8Array(buf);
  }

  async function aesGcmDecrypt(keyBytes, nonce, ciphertext, ad) {
    const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
    const buf = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce, additionalData: ad, tagLength: 128 },
      key,
      ciphertext
    );
    return new Uint8Array(buf);
  }

  function naclOk() {
    return typeof global.nacl !== "undefined" && global.nacl.box && global.nacl.scalarMult;
  }

  function hasX25519() {
    return naclOk() || !!(global.crypto && crypto.subtle);
  }

  function jwkFromRaw(publicRaw, privateRaw) {
    return {
      kty: "OKP",
      crv: "X25519",
      x: bytesToB64url(publicRaw),
      d: bytesToB64url(privateRaw),
    };
  }

  function rawFromJwk(jwk) {
    if (!jwk || !jwk.d) throw new Error("В ключе нет секретной части");
    return b64urlToBytes(jwk.d);
  }

  async function generateX25519() {
    if (naclOk()) {
      const kp = global.nacl.box.keyPair();
      return { publicRaw: kp.publicKey, privateRaw: kp.secretKey, privateKey: kp.secretKey };
    }
    const kp = await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]);
    const publicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
    const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
    const privateRaw = rawFromJwk(jwk);
    return { publicRaw, privateRaw, privateKey: privateRaw, privateJwk: jwk };
  }

  async function exportRawPublic(keyPair) {
    if (keyPair && keyPair.publicRaw) return keyPair.publicRaw;
    return new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));
  }

  async function exportPrivateJwk(keyPair) {
    if (keyPair && keyPair.privateRaw) return jwkFromRaw(keyPair.publicRaw, keyPair.privateRaw);
    return crypto.subtle.exportKey("jwk", keyPair.privateKey);
  }

  async function importPublicRaw(raw) {
    if (naclOk()) return raw;
    return crypto.subtle.importKey("raw", raw, { name: "X25519" }, true, []);
  }

  async function importPrivateJwk(jwk) {
    return rawFromJwk(jwk);
  }

  function isAllZero(bytes) {
    let acc = 0;
    for (let i = 0; i < bytes.length; i++) acc |= bytes[i];
    return acc === 0;
  }

  async function x25519Dh(privateKey, publicRaw) {
    const pub = publicRaw instanceof Uint8Array ? publicRaw : new Uint8Array(publicRaw);
    if (pub.length !== 32) throw new Error("Неверная длина ключа");
    let sk = privateKey;
    if (sk && sk.privateRaw) sk = sk.privateRaw;
    let shared;
    if (sk instanceof Uint8Array) {
      if (!naclOk()) throw new Error("Нет X25519 (нужен nacl или современный браузер)");
      shared = global.nacl.scalarMult(sk, pub);
    } else {
      const imported = await crypto.subtle.importKey("raw", pub, { name: "X25519" }, true, []);
      const bits = await crypto.subtle.deriveBits({ name: "X25519", public: imported }, privateKey, 256);
      shared = new Uint8Array(bits);
    }
    /* RFC 7748 §6.1: reject low-order public keys, otherwise the shared secret is public. */
    if (isAllZero(shared)) throw new Error("Некорректный публичный ключ собеседника");
    return shared;
  }

  async function identityFromJwk(jwk, publicRaw) {
    return identityFromStored(publicRaw, jwk, null);
  }

  async function identityFromStored(publicRaw, jwk, privB64) {
    const privateRaw = privB64 ? b64urlToBytes(privB64) : rawFromJwk(jwk);
    const privateJwk = jwk && jwk.d ? jwk : jwkFromRaw(publicRaw, privateRaw);
    return {
      privateKey: privateRaw,
      privateRaw,
      publicRaw,
      privateJwk,
    };
  }

  async function generateIdentity() {
    const kp = await generateX25519();
    const privateJwk = kp.privateJwk || jwkFromRaw(kp.publicRaw, kp.privateRaw);
    return {
      privateKey: kp.privateRaw,
      privateRaw: kp.privateRaw,
      publicRaw: kp.publicRaw,
      privateJwk,
    };
  }

  async function fingerprintBytes(publicRaw) {
    return sha256(publicRaw);
  }

  async function fingerprintDisplay(publicRaw) {
    const h = await fingerprintBytes(publicRaw);
    const hex = [...h.subarray(0, 10)].map((b) => b.toString(16).padStart(2, "0")).join("");
    return hex.match(/.{1,4}/g).join("-").toUpperCase();
  }

  global.S256Crypto = {
    concatBytes,
    bytesToB64url,
    b64urlToBytes,
    utf8,
    utf8dec,
    timingSafeEqual,
    randomBytes,
    sha256,
    hkdf,
    pbkdf2,
    aesGcmEncrypt,
    aesGcmDecrypt,
    hasX25519,
    generateX25519,
    exportRawPublic,
    exportPrivateJwk,
    importPublicRaw,
    importPrivateJwk,
    x25519Dh,
    identityFromJwk,
    identityFromStored,
    generateIdentity,
    naclOk,
    fingerprintBytes,
    fingerprintDisplay,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
