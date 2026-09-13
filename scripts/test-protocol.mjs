import fs from "fs";
import vm from "vm";

globalThis.self = globalThis;

function load(rel) {
  vm.runInThisContext(fs.readFileSync(new URL(rel, import.meta.url), "utf8"), { filename: rel });
}

load("../vendor/nacl.min.js");
load("../js/crypto.js");
load("../js/protocol.js");

const C = globalThis.S256Crypto;
const P = globalThis.S256Protocol;

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function identity() {
  return C.generateIdentity();
}

async function main() {
  if (!crypto.subtle) throw new Error("no subtle");
  try {
    await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]);
  } catch {
    /* nacl fallback is enough */
  }
  if (typeof nacl === "undefined") throw new Error("nacl missing");

  const alice = await identity();
  const bob = await identity();
  const alicePub = P.encodePublicKey(alice.publicRaw);
  const bobPub = P.encodePublicKey(bob.publicRaw);
  assert(P.isPublicKey(alicePub), "pub prefix");

  const packet = await P.encrypt("Привет, это секрет 🔐", alice, bob.publicRaw);
  assert(P.isCiphertext(packet), "cipher prefix");
  assert(packet.startsWith("S256M1."), "classic brand");
  assert(!packet.includes("Привет"), "no leak");

  const plain = await P.decrypt(packet, bob, alice.publicRaw);
  assert(plain === "Привет, это секрет 🔐", "roundtrip: " + plain);

  const stealth = await P.encrypt("стелс ок", alice, bob.publicRaw, null, { stealth: true });
  assert(P.isCiphertext(stealth), "stealth recognized");
  assert(!stealth.startsWith("S256M1."), "no brand on stealth");
  assert(!stealth.includes("S256M1"), "no brand substring");
  const stealth2 = await P.encrypt("стелс ок", alice, bob.publicRaw, null, { stealth: true });
  assert(stealth.slice(0, 8) !== stealth2.slice(0, 8), "stealth pad randomizes start");
  assert((await P.decrypt(stealth, bob, alice.publicRaw)) === "стелс ок", "stealth roundtrip");
  assert(!P.isCiphertext("AAAAAAAAAAAA" + "B".repeat(200)), "random junk not ciphertext");

  let failed = false;
  try {
    await P.decrypt(packet, alice, bob.publicRaw);
  } catch {
    failed = true;
  }
  assert(failed, "sender must not decrypt inbound-style with own key as recipient mismatch path");

  const reply = await P.encrypt("Ок, вижу", bob, alice.publicRaw);
  const replyPlain = await P.decrypt(reply, alice, bob.publicRaw);
  assert(replyPlain === "Ок, вижу", "reply");

  const third = await identity();
  let mitm = false;
  try {
    await P.decrypt(packet, third, alice.publicRaw);
  } catch {
    mitm = true;
  }
  assert(mitm, "third party cannot decrypt");

  const sessA = await C.generateX25519();
  const sessB = await C.generateX25519();
  const ikmA = await C.x25519Dh(sessA.privateRaw, sessB.publicRaw);
  const ikmB = await C.x25519Dh(sessB.privateRaw, sessA.publicRaw);
  assert(C.timingSafeEqual(ikmA, ikmB), "session dh match");
  const timedPkt = await P.encrypt("только с сессией", alice, bob.publicRaw, ikmA);
  assert((await P.decrypt(timedPkt, bob, alice.publicRaw, ikmB)) === "только с сессией", "timed roundtrip");
  let noSession = false;
  try {
    await P.decrypt(timedPkt, bob, alice.publicRaw);
  } catch {
    noSession = true;
  }
  assert(noSession, "identity-only cannot open timed packet");
  const kt = P.encodeTimedKey(alice.publicRaw, sessA.publicRaw, 86400, 1700000000);
  assert(P.isTimedKey(kt) && P.isPublicKey(kt), "kt1 prefix");
  const parsed = P.parsePeerKey(kt);
  assert(parsed.timed && parsed.ttlSec === 86400, "parse kt1");
  let badTtl = false;
  try {
    P.encodeTimedKey(alice.publicRaw, sessA.publicRaw, 13, 1700000000);
  } catch {
    badTtl = true;
  }
  assert(badTtl, "ttl whitelist");
  const classic = P.parsePeerKey(alicePub);
  assert(!classic.timed && classic.ttlSec === 0, "k1 still classic");
  assert(alicePub.indexOf("S256K1.") === 0, "k1 prefix");
  assert(alicePub.slice("S256K1.".length).length === 43, "k1 payload 43");
  const glued = P.parsePeerKey(alicePub + "13:45");
  assert(C.timingSafeEqual(glued.publicRaw, alice.publicRaw), "trailing chat time stripped from k1");

  const weekTok = P.encodeTimedKey(alice.publicRaw, sessA.publicRaw, 604800, 1757678901);
  const week = P.parsePeerKey(weekTok);
  assert(week.timed && week.ttlSec === 604800, "week ttl");
  const weekGlued = P.parsePeerKey(weekTok + "13");
  assert(weekGlued.ttlSec === 604800 && weekGlued.issuedAt === 1757678901, "week trailing digits stripped");

  const many = [];
  for (let i = 0; i < 8; i++) {
    many.push(await P.encrypt("msg-" + i, alice, bob.publicRaw));
  }
  for (let i = 7; i >= 0; i--) {
    assert((await P.decrypt(many[i], bob, alice.publicRaw)) === "msg-" + i, "ooo " + i);
  }

  console.log("OK");
  console.log("sample", packet.slice(0, 40) + "…");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
