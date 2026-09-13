import fs from "fs";
import vm from "vm";

globalThis.self = globalThis;

function load(rel) {
  vm.runInThisContext(fs.readFileSync(new URL(rel, import.meta.url), "utf8"), { filename: rel });
}

const store = {};
globalThis.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => {
    store[k] = String(v);
  },
  removeItem: (k) => {
    delete store[k];
  },
};

load("../vendor/nacl.min.js");
load("../js/crypto.js");
load("../js/protocol.js");
load("../js/vault.js");

const V = globalThis.S256Vault;
const P = globalThis.S256Protocol;

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function main() {
  await V.create("correct-horse-battery");
  assert(V.pairModeView().mode === "forever", "normal mode default");
  assert(V.getSettings().burnVaultSec === 0, "burn off by default");
  const pubA = await V.publicKeyText();
  assert(pubA.startsWith("S256K1."), "default forever key");
  await V.lock();
  try {
    await V.unlock("wrong-password-xx");
    throw new Error("bad password accepted");
  } catch (e) {
    assert(e.message === "Неверный пароль", e.message);
  }
  await V.unlock("correct-horse-battery");

  const bob = await globalThis.S256Crypto.generateIdentity();
  const bobPub = P.encodePublicKey(bob.publicRaw);
  const c = await V.addContact("Боб", bobPub);
  const packetList = await V.encryptForContact(c.id, "секретный текст");
  assert(Array.isArray(packetList) && packetList.length === 1, "packets array");
  const packet = packetList[0];
  assert(P.isCiphertext(packet), "packet");
  const back = await V.decryptPacket(packet);
  assert(back.text === "секретный текст", back.text);
  assert(back.outgoing === true, "outgoing cache");
  assert(V.getSettings().pageDecrypt === false, "pageDecrypt default off");
  const threadOut = V.getThread(c.id);
  assert(threadOut.messages.length === 1 && threadOut.messages[0].text === "секретный текст", "outgoing thread");
  assert(threadOut.messages[0].outgoing === true, "outgoing flag");

  const inbound = await P.encrypt("ответ боба", bob, globalThis.S256Crypto.b64urlToBytes(pubA.slice("S256K1.".length)));
  const got = await V.decryptPacket(inbound);
  assert(got.text === "ответ боба", got.text);
  assert(got.outgoing === false, "inbound");
  assert(got.known === true, "known sender");
  assert(got.verified === false, "not verified yet");

  await V.setVerified(c.id, true);
  const got2 = await V.decryptPacket(inbound);
  assert(got2.verified === true, "verified flag");

  const ing = await V.ingestPackets([inbound, inbound, packet]);
  assert(ing.added === 1, "ingest inbound once, skip dupes");
  const threadIn = V.getThread(c.id);
  assert(threadIn.messages.length === 2, "thread has out+in");
  assert(threadIn.messages[1].text === "ответ боба" && threadIn.messages[1].outgoing === false, "inbound thread");
  const chats = V.listChats();
  assert(chats[0].id === c.id && chats[0].lastText === "ответ боба", "chat list last");

  const long = "Ж".repeat(5000);
  const parts = await V.encryptForContact(c.id, long);
  assert(parts.length > 1, "long message fragmented: " + parts.length);
  for (const p of parts) {
    assert(P.isCiphertext(p), "frag ciphertext");
    assert(p.length <= 3900, "frag under VK limit " + p.length);
  }
  const alicePubRaw = globalThis.S256Crypto.b64urlToBytes(pubA.slice("S256K1.".length));
  const fragPlain = [];
  for (const p of parts) {
    fragPlain.push(await P.decrypt(p, bob, alicePubRaw));
  }
  assert(fragPlain.every((t) => t.startsWith("PLF1 ")), "frag headers");
  const threadLong = V.getThread(c.id);
  assert(threadLong.messages.some((m) => m.text === long), "long stored whole");
  const reassemble = fragPlain
    .map((t) => {
      const m = t.match(/^PLF1 ([A-Za-z0-9_-]+) (\d+) (\d+)\n([\s\S]*)$/);
      return m ? { i: Number(m[2]), body: m[4] } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.i - b.i);
  assert(reassemble.length === parts.length, "all frags");
  assert(reassemble.map((x) => x.body).join("") === long, "reassembled");

  await V.setSetting("pageDecrypt", false);
  assert(V.getSettings().pageDecrypt === false, "pageDecrypt off");
  await V.setSetting("pageDecrypt", true);

  const stranger = await globalThis.S256Crypto.generateIdentity();
  const fromStranger = await P.encrypt("я чужой", stranger, globalThis.S256Crypto.b64urlToBytes(pubA.slice("S256K1.".length)));
  const s = await V.decryptPacket(fromStranger);
  assert(s.text === "я чужой" && s.known === false, "unknown sender flagged");

  const Cx = globalThis.S256Crypto;

  /* Forever contact stays; offer TTL does not lock vault or burn everyone */
  await V.setPairMode("safe", 86400);
  assert(V.pairModeView().mode === "safe", "offer TTL selected");
  assert(!V.isSafeLocked(), "offer TTL does not lock vault");
  assert(!V.isBurnMode(), "no vault burn from pair TTL");
  const blobWhileTimedOffer = await V.exportBackup();
  assert(blobWhileTimedOffer && blobWhileTimedOffer.length > 20, "export ok with per-contact offer");
  assert(c.ttlSec === 0, "existing forever contact untouched");

  /* Peer forever key while we offer timed → accept forever terms */
  const other = await Cx.generateIdentity();
  const cForever = await V.addContact("Вечный", P.encodePublicKey(other.publicRaw));
  assert(cForever.ttlSec === 0, "accepted forever peer");
  assert(V.getSettings().keyTtlSec === 0, "offer cleared to forever");

  await V.setPairMode("safe", 86400);
  /* Peer different TTL → adopt theirs (no Keys trip) */
  const bobSessMismatch = await Cx.generateX25519();
  const otherKt = P.encodeTimedKey(bob.publicRaw, bobSessMismatch.publicRaw, 900, Math.floor(Date.now() / 1000));
  const cAdopt = await V.addContact("Боб", otherKt);
  assert(cAdopt.ttlSec === 900, "adopted peer 15m");
  assert(V.getSettings().keyTtlSec === 900, "offer synced to 15m");
  assert(cForever.ttlSec === 0, "other contact still forever");

  await V.setPairMode("safe", 86400);
  /* Re-key Bob to 1 day */
  const myKt = await V.publicKeyText();
  assert(P.isTimedKey(myKt), "vault advertises kt1");
  const bobSess2 = await Cx.generateX25519();
  const bobKt = P.encodeTimedKey(bob.publicRaw, bobSess2.publicRaw, 86400, Math.floor(Date.now() / 1000));
  const cTimed = await V.addContact("Боб", bobKt);
  assert(cTimed.id === c.id || cTimed.id === cAdopt.id, "same bob contact");
  assert(cTimed.ttlSec === 86400 && cTimed.sessionIkm, "session on this contact");
  assert(!V.isSafeLocked(), "still not vault-locked");
  await V.setPairMode("forever");
  assert(!(await V.publicKeyText()).startsWith("S256KT1."), "can return offer to forever");
  assert(cTimed.ttlSec === 86400, "contact session kept after offer reset");

  const timedOut = await V.encryptForContact(cTimed.id, "на сутки");
  assert((await V.decryptPacket(timedOut[0])).text === "на сутки", "timed cache");
  cTimed.expiresAt = Date.now() - 180000;
  await V.expireSessions();
  assert(V.sessionView(cTimed).expired, "marked expired");
  let expired = false;
  try {
    await V.encryptForContact(cTimed.id, "поздно");
  } catch (e) {
    expired = e.code === "expired";
  }
  assert(expired, "encrypt refused after expiry");
  assert(V.getState().contacts.some((x) => x.id === cTimed.id), "contact row remains");
  assert(await V.hasVault(), "vault still there after contact session burn");

  /* Second forever friend while first had timed — independent */
  const carol = await Cx.generateIdentity();
  const cCarol = await V.addContact("Кэрол", P.encodePublicKey(carol.publicRaw));
  assert(cCarol.ttlSec === 0, "carol forever");
  const carolMsg = await V.encryptForContact(cCarol.id, "привет кэрол");
  assert((await V.decryptPacket(carolMsg[0])).text === "привет кэрол", "carol ok");

  /* Accept peer timed offer with local forever → adopt TTL for this pair only */
  await V.setPairMode("forever");
  const dave = await Cx.generateIdentity();
  const daveSess = await Cx.generateX25519();
  const daveKt = P.encodeTimedKey(dave.publicRaw, daveSess.publicRaw, 900, Math.floor(Date.now() / 1000));
  const cDave = await V.addContact("Дейв", daveKt);
  assert(cDave.ttlSec === 900, "adopted peer ttl");
  assert(V.getSettings().keyTtlSec === 900, "offer synced for reply QR");
  assert(P.isTimedKey(await V.publicKeyText()), "reply is kt1");
  assert(cCarol.ttlSec === 0, "carol still forever");
  const daveForever = await V.addContact("Дейв", P.encodePublicKey(dave.publicRaw));
  assert(daveForever.id === cDave.id, "same dave rekeyed");
  assert(daveForever.ttlSec === 0, "rekey timed → forever");
  assert(cCarol.ttlSec === 0, "carol still forever after dave rekey");

  const blob = await V.exportBackup();
  assert(blob.startsWith("U1NNlZBVUxUMg") || globalThis.S256Crypto.utf8dec(globalThis.S256Crypto.b64urlToBytes(blob).subarray(0, 10)) === "S256VAULT2", "v2 magic");
  assert(!("s256.vault.pass" in store), "password must not be stored");
  await V.lock();
  await V.unlock("correct-horse-battery");
  assert(V.getState().contacts.find((x) => x.name === "Кэрол").verified === false, "carol persisted");
  assert(V.getState().settings.onboarded === false, "settings default");
  await V.setSetting("onboarded", true);
  await V.lock();
  await V.unlock("correct-horse-battery");
  assert(V.getState().settings.onboarded === true, "setting persisted");

  /* legacy V1 blob (250k, magic S256VAULT1) must still open and get upgraded */
  const C = globalThis.S256Crypto;
  const bob2 = await Cx.generateIdentity();
  const bobPub2 = P.encodePublicKey(bob2.publicRaw);
  const legacyJson = JSON.stringify({
    version: 1,
    identity: {
      pubB64: C.bytesToB64url(bob2.publicRaw),
      privB64: C.bytesToB64url(bob2.privateRaw),
      privJwk: bob2.privateJwk,
    },
    contacts: [],
    sentCache: {},
    settings: { strict: true },
  });
  const salt = C.randomBytes(16);
  const nonce = C.randomBytes(12);
  const key = await C.pbkdf2("legacy-pass-123", salt, 250000);
  const ct = await C.aesGcmEncrypt(key, nonce, C.utf8(legacyJson), C.utf8("S256VAULT1"));
  const legacyBlob = C.bytesToB64url(C.concatBytes([C.utf8("S256VAULT1"), salt, nonce, ct]));
  await V.lock();
  await V.importBackup(legacyBlob, "legacy-pass-123");
  await V.setPairMode("forever");
  assert((await V.publicKeyText()) === bobPub2, "legacy import identity");
  const upgraded = await V.exportBackup();
  assert(C.utf8dec(C.b64urlToBytes(upgraded).subarray(0, 10)) === "S256VAULT2", "legacy upgraded to v2");
  await V.lock();
  await V.unlock("legacy-pass-123");
  assert((await V.publicKeyText()) === bobPub2, "reopen after upgrade");

  /* low-order public key must be rejected */
  let rejected = false;
  try {
    await V.addContact("zero", P.encodePublicKey(new Uint8Array(32)));
    await V.encryptForContact(await globalThis.S256Crypto.fingerprintDisplay(new Uint8Array(32)), "x");
  } catch {
    rejected = true;
  }
  assert(rejected, "all-zero pubkey rejected");

  const oldPub = await V.publicKeyText();
  let badRotate = false;
  try {
    await V.rotateIdentity("wrong-password-xx");
  } catch {
    badRotate = true;
  }
  assert(badRotate, "rotate needs password");

  await V.setSetting("keyBurnTtlSec", 30);
  const kbAlice = await V.publicKeyText();
  assert(kbAlice.startsWith("S256KB1."), "burn offer key");
  const eve = await globalThis.S256Crypto.generateIdentity();
  const eveSess = await globalThis.S256Crypto.generateX25519();
  const eveTok = P.encodeBurnKey(eve.publicRaw, eveSess.publicRaw, 30, 0, Math.floor(Date.now() / 1000));
  const burnC = await V.addContact("Ева", eveTok);
  assert(burnC.burnTtlSec === 30 && burnC.ckSend && burnC.ckRecv, "burn pair attached");
  const burnOut = await V.encryptForContact(burnC.id, "огонь");
  assert(P.unpack(burnOut[0]).burn, "outgoing burn packet");
  const burnBack = await V.decryptPacket(burnOut[0]);
  assert(burnBack.text === "огонь" && burnBack.outgoing, "sender cache while live");
  const pending = V.getSettings().pendingSession;
  const alicePub = globalThis.S256Crypto.b64urlToBytes(kbAlice.split(".")[1]);
  const root = await globalThis.S256Crypto.x25519Dh(eveSess.privateRaw, globalThis.S256Crypto.b64urlToBytes(pending.pubB64));
  const eveChains = await P.deriveBurnChains(root, eve.publicRaw, alicePub);
  const eveStep = await P.ratchetStep(eveChains.ckSend, 0);
  const evePkt = await P.encrypt("тайна", eve, alicePub, null, {
    burn: { msgKey: eveStep.msgKey, counter: 0, issuedAt: Math.floor(Date.now() / 1000), burnTtl: 30 },
  });
  const eveGot = await V.decryptPacket(evePkt);
  assert(eveGot.text === "тайна" && eveGot.burnAt > Date.now(), "inbound burn opens once");
  const eveGot2 = await V.decryptPacket(evePkt);
  assert(eveGot2.text === "тайна", "second read uses open cache");
  eveGot.burnAt = Date.now() - 1;
  eveGot2.burnAt = Date.now() - 1;
  await V.expireBurns();
  const dead = await V.decryptPacket(evePkt);
  assert(dead.burned && /сгорело/.test(dead.text), "after window pairlock cannot open");
  await V.setSetting("keyBurnTtlSec", 0);

  await V.rotateIdentity("legacy-pass-123");
  const neu = await V.publicKeyText();
  assert(neu !== oldPub, "identity replaced");
  assert(V.getState().contacts.length === 0, "contacts cleared on rotate");
  assert(!V.getState().threads || Object.keys(V.getState().threads).length === 0, "threads wiped on rotate");

  /* Optional whole-vault burn still works via setting */
  await V.setSetting("burnVaultSec", 3600);
  assert(V.isBurnMode(), "vault burn scheduled");
  assert(store["s256.burnAt"], "burn deadline outside vault");
  let exportBlocked = false;
  try {
    await V.exportBackup();
  } catch (e) {
    exportBlocked = /экспорт/i.test(e.message || "");
  }
  assert(exportBlocked, "export blocked during vault burn");
  store["s256.burnAt"] = String(Date.now() - 1000);
  const burned = await V.enforceBurn();
  assert(burned === true, "burn executed");
  assert(!(await V.hasVault()), "vault gone after burn");
  assert(!store["s256.burnAt"], "burn marker cleared");
  let reopen = false;
  try {
    await V.unlock("legacy-pass-123");
  } catch (e) {
    reopen = /сожжено|ещё не создано/.test(e.message);
  }
  assert(reopen, "password useless after burn");

  console.log("vault OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
