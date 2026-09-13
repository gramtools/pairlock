importScripts("vendor/nacl.min.js", "js/crypto.js", "js/protocol.js", "js/vault.js");

async function ready() {
  await S256Vault.restoreSession();
  if (!S256Vault.isUnlocked()) {
    const err = new Error("locked");
    err.code = "locked";
    throw err;
  }
}

async function tickBurn() {
  try {
    await S256Vault.enforceBurn();
  } catch (_) {
    /* ignore */
  }
}

try {
  chrome.alarms.create("s256-burn", { periodInMinutes: 10 });
} catch (_) {
  /* alarms may be unavailable */
}
if (chrome.alarms && chrome.alarms.onAlarm) {
  chrome.alarms.onAlarm.addListener((a) => {
    if (a && a.name === "s256-burn") tickBurn();
  });
}
if (chrome.runtime.onStartup) chrome.runtime.onStartup.addListener(tickBurn);
if (chrome.runtime.onInstalled) chrome.runtime.onInstalled.addListener(tickBurn);
tickBurn();

async function getBindNext() {
  const r = await chrome.storage.session.get("s256.bindNext");
  return r["s256.bindNext"] || null;
}

async function setBindNext(contactId) {
  if (contactId) await chrome.storage.session.set({ "s256.bindNext": contactId });
  else await chrome.storage.session.remove("s256.bindNext");
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (!msg || typeof msg.type !== "string" || !msg.type.startsWith("S256_")) return null;

    if (msg.type === "S256_STATUS") {
      await S256Vault.restoreSession();
      const unlocked = S256Vault.isUnlocked();
      let bound = null;
      let contacts = [];
      if (unlocked) {
        await S256Vault.expireSessions();
        const state = S256Vault.getState();
        contacts = state.contacts.map((c) => ({
          id: c.id,
          name: c.name,
          fingerprint: c.fingerprint,
          bindings: c.bindings,
          verified: !!c.verified,
        }));
        if (msg.platform && msg.peer) bound = S256Vault.findByBinding(msg.platform, msg.peer);
      }
      return {
        ok: true,
        unlocked,
        bound: bound
          ? Object.assign(
              { id: bound.id, name: bound.name, fingerprint: bound.fingerprint, verified: !!bound.verified },
              S256Vault.sessionView(bound)
            )
          : null,
        contacts,
        hasVault: await S256Vault.hasVault(),
        bindNext: await getBindNext(),
        keyTtlSec: unlocked ? (S256Vault.getState().settings.keyTtlSec || 0) : 0,
        burnVaultSec: unlocked ? (S256Vault.getState().settings.burnVaultSec || 0) : 0,
        burnAt: unlocked ? (S256Vault.getState().settings.burnAt || 0) : 0,
        pairMode: unlocked ? S256Vault.pairModeView().mode : "forever",
        pairLocked: unlocked ? S256Vault.isSafeLocked() : false,
        pageDecrypt: unlocked ? !!S256Vault.getState().settings.pageDecrypt : false,
        stealthWire: unlocked ? S256Vault.getState().settings.stealthWire !== false : true,
        myFingerprint: unlocked ? await S256Vault.myFingerprint() : "",
      };
    }

    if (msg.type === "S256_ENSURE_SAFE_PAIR") {
      await ready();
      const s = await S256Vault.ensureSafePair();
      return { ok: true, ...s, pairMode: "safe" };
    }

    if (msg.type === "S256_SET_PAIR_MODE") {
      await ready();
      const s = await S256Vault.setPairMode(
        msg.mode === "forever" ? "forever" : "safe",
        msg.ttlSec != null ? msg.ttlSec : undefined
      );
      return { ok: true, ...s, pairMode: msg.mode === "forever" ? "forever" : "safe" };
    }

    if (msg.type === "S256_UNLOCK") {
      await S256Vault.unlock(String(msg.password || ""));
      return { ok: true };
    }

    if (msg.type === "S256_CREATE") {
      if (await S256Vault.hasVault()) {
        return { ok: false, error: "Хранилище уже есть — введите пароль для открытия", code: "exists" };
      }
      await S256Vault.create(String(msg.password || ""));
      return { ok: true };
    }

    if (msg.type === "S256_LOCK") {
      await S256Vault.lock();
      return { ok: true };
    }

    if (msg.type === "S256_BIND_NEXT") {
      await ready();
      await setBindNext(msg.contactId || null);
      return { ok: true, bindNext: msg.contactId || null };
    }

    if (msg.type === "S256_BIND") {
      await ready();
      const c = await S256Vault.bindPeer(msg.contactId, msg.platform, msg.peer);
      return { ok: true, name: c.name };
    }

    if (msg.type === "S256_UNBIND") {
      await ready();
      await S256Vault.unbindPeer(msg.contactId, msg.platform);
      return { ok: true };
    }

    if (msg.type === "S256_MY_KEY") {
      await ready();
      return { ok: true, key: await S256Vault.publicKeyText(), fingerprint: await S256Vault.myFingerprint() };
    }

    if (msg.type === "S256_ADD_AND_BIND") {
      await ready();
      let c = null;
      let adoptedTtl = null;
      try {
        const before = (S256Vault.getSettings().keyTtlSec || 0) >>> 0;
        let peerTtl = 0;
        let timed = false;
        try {
          const parsed = S256Protocol.parsePeerKey(msg.key);
          timed = !!parsed.timed;
          peerTtl = parsed.timed ? parsed.ttlSec >>> 0 : 0;
        } catch {
          /* addContact will throw */
        }
        c = await S256Vault.addContact(msg.name, msg.key);
        const after = (S256Vault.getSettings().keyTtlSec || 0) >>> 0;
        if (timed && before !== peerTtl) adoptedTtl = peerTtl;
        else if (!timed && before > 0 && after === 0) adoptedTtl = 0;
      } catch (e) {
        try {
          const parsed = S256Protocol.parsePeerKey(msg.key);
          const fp = await S256Crypto.fingerprintDisplay(parsed.publicRaw);
          c = S256Vault.findByFingerprint(fp);
        } catch {
          /* ignore */
        }
        if (!c) throw e;
      }
      if (msg.platform && msg.peer) await S256Vault.bindPeer(c.id, msg.platform, msg.peer);
      return {
        ok: true,
        id: c.id,
        name: c.name,
        fingerprint: c.fingerprint,
        ttlSec: c.ttlSec || 0,
        expiresAt: c.expiresAt || 0,
        expired: !!S256Vault.sessionView(c).expired,
        adoptedTtl,
        keyTtlSec: S256Vault.getSettings().keyTtlSec || 0,
      };
    }

    if (msg.type === "S256_RENAME") {
      await ready();
      const c = await S256Vault.renameContact(msg.contactId, String(msg.name || ""));
      return { ok: true, id: c.id, name: c.name };
    }

    if (msg.type === "S256_SET_VERIFIED") {
      await ready();
      await S256Vault.setVerified(msg.contactId, !!msg.verified);
      return { ok: true };
    }

    if (msg.type === "S256_REMOVE_CONTACT") {
      await ready();
      await S256Vault.removeContact(msg.contactId);
      return { ok: true };
    }

    if (msg.type === "S256_ENCRYPT") {
      await ready();
      const text = String(msg.text || "");
      if (!text.trim()) return { ok: true, text, skipped: true };
      if (S256Protocol.isCiphertext(text) || S256Protocol.isPublicKey(text)) return { ok: true, text: text.trim(), already: true };

      let contact = null;
      try {
        contact = S256Vault.findByBinding(msg.platform, msg.peer);
      } catch {
        contact = null;
      }
      const bindNext = await getBindNext();
      if (!contact && bindNext) {
        await S256Vault.bindPeer(bindNext, msg.platform, msg.peer);
        await setBindNext(null);
        contact = S256Vault.findByBinding(msg.platform, msg.peer);
      }
      if (!contact) {
        const err = new Error("unbound");
        err.code = "unbound";
        throw err;
      }
      const packets = await S256Vault.encryptForContact(contact.id, text);
      return {
        ok: true,
        text: packets[0],
        packets,
        parts: packets.length,
        name: contact.name,
      };
    }

    if (msg.type === "S256_DECRYPT") {
      await ready();
      const text = String(msg.text || "").trim();
      if (!S256Protocol.isCiphertext(text)) return { ok: true, skipped: true, text };
      const res = await S256Vault.decryptPacket(text);
      try {
        await S256Vault.ingestPackets([text]);
      } catch {
        /* thread write is best-effort */
      }
      return {
        ok: true,
        text: res.text,
        outgoing: !!res.outgoing,
        known: res.outgoing ? true : !!res.known,
        verified: res.outgoing ? true : !!res.verified,
        name: res.contact ? res.contact.name : null,
        contactId: res.contact ? res.contact.id : null,
      };
    }

    if (msg.type === "S256_INGEST") {
      await ready();
      const got = await S256Vault.ingestPackets(msg.packets || []);
      return { ok: true, added: got.added, contactIds: got.contactIds || [] };
    }

    if (msg.type === "S256_CHAT_LIST") {
      await ready();
      return { ok: true, chats: S256Vault.listChats() };
    }

    if (msg.type === "S256_CHAT_THREAD") {
      await ready();
      return { ok: true, thread: S256Vault.getThread(msg.contactId) };
    }

    if (msg.type === "S256_CHAT_SEND") {
      await ready();
      const text = String(msg.text || "").trim();
      if (!text) return { ok: false, error: "empty" };
      const packets = await S256Vault.encryptForContact(msg.contactId, text);
      const thread = S256Vault.getThread(msg.contactId);
      return {
        ok: true,
        packet: packets[0],
        packets,
        parts: packets.length,
        bindings: (thread.contact && thread.contact.bindings) || {},
        name: thread.contact ? thread.contact.name : "",
      };
    }

    return { ok: false, error: "unknown" };
  })()
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, error: e.message, code: e.code || "error" }));
  return true;
});
