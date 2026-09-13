# Security

[Русский](#русский) · [English](#english)

Pairlock — локальный клиент. Своего сервера, аккаунта и телеметрии нет. Исходный код открыт ([MIT](./LICENSE)).

---

# Русский

## Для чего рассчитан

Тот, кто читает логи VK/MAX, канал мессенджера или выгрузку истории — **без устройств пары и без их секретных ключей**.

Публичные ключи `S256K1.…` для этого сценария **не секрет**. Их можно и нужно слать в том же чате. Из двух публичных точек X25519 общий секрет `ab·G` не считается (CDH). Без секрета нет ключа AES, без ключа AES-GCM не открывается. Подключиться «третьим» к чужой паре нельзя: сервера сессий нет, шифр заточен под одного получателя.

Отпечаток сверяют голосом / лично. Сверка только в том же чате не ловит подмену при первом обмене.

## Для чего не рассчитан

- Изъятое **разблокированное** устройство или пароль сейфа, полученный до сжигания
- Вредонос, оверлеи доступности, скриншот, камера в экран
- Клиентский JS VK/MAX, если писать в **их** поле или включить «показывать расшифровку в пузырях» (по умолчанию выключено). Штатный путь — зелёное поле Pairlock в закрытом shadow DOM
- Отправка открытым текстом: сейф открыт, чат не привязан
- Replay: сервер может повторно доставить старый пакет; он откроется в тот же старый текст. Номеров последовательности нет
- Метаданные: кто, когда, длина шифра
- Голос, фото, файлы, стикеры — шифруется только текст
- Холодная копия блоба сейфа, снятая до сжигания
- Форензика RAM / swap при открытой сессии

## Криптография

- Пакет (классика): `S256M1.` = версия ‖ pub отправителя ‖ эфемерный pub ‖ nonce 96 бит ‖ AES-256-GCM
- Пакет (стелс, по умолчанию): тот же body как `base64url(случайный pad ‖ body ‖ tag)` без бренда. Приёмник читает оба вида. Это прячет отпечаток продукта, но не маскирует шифр под обычную речь
- Ключ сообщения = HKDF-SHA256(ECDH(эфемер, их_id) ‖ ECDH(мой_id, их_id), соль = nonce, info = `s256m-v1-msg` ‖ pub ‖ nonce). Статический ECDH даёт аутентификацию отправителя
- Associated data = версия ‖ pub отправителя ‖ эфемерный pub
- Нулевые shared secret X25519 (low-order ключи, RFC 7748 §6.1) отвергаются
- Отпечаток = первые 80 бит SHA-256(pub), 5 групп по 4 hex-символа
- Identity и эфемеры: 32 байта из `crypto.getRandomValues` → скаляр X25519 по RFC 7748 (clamping) через TweetNaCl `nacl.box.keyPair` или `crypto.subtle.generateKey({ name: "X25519" })`. Ключ не выводится из пароля и не приходит с сервера. Nonce сообщений — 12 случайных байт из того же ГСЧ

Код: [`js/protocol.js`](./js/protocol.js), [`js/crypto.js`](./js/crypto.js), [`js/vault.js`](./js/vault.js).

## Сейф и ключи

- Формат `S256VAULT2`: PBKDF2-SHA256, число итераций в блобе (сейчас 600 000). Старые `S256VAULT1` (250 000) открываются и переупаковываются
- Пароль **не сохраняется**. Пока открыто, в памяти только выведенный ключ
- Смена identity (вкладка «Ключи», три предупреждения + фраза + пароль) меняет долгосрочный ключ и стирает контакты
- Срок пары (по желанию): `S256KT1.` — 15 мин / 30 мин / час / сутки / неделя. Сгорает сессия и локальная история **этого** контакта
- Сгорающая переписка: `S256KB1.` — у пары свой session + hash ratchet. После прочтения текст живёт 30 / 60 / 120 с, затем ключ сообщения удаляется. Identity этого пакета больше не открывает. Неоткрытое сгорает через 7 дней. Скрин и нечестный клиент — вне модели
- Исходящие с провода чужим секретом не восстанавливаются — эфемер после отправки забыт. Локальная копия лежит в сейфе

## Расширение

- Manifest V3, права `storage` + `activeTab` + `alarms`, хосты только VK / MAX. Нет `externally_connectable`
- Поле ввода — закрытый shadow root. Слушатели на `document_start` глотают клавиатуру до скриптов страницы
- Страж утечек: при привязанном чате тела `fetch` / XHR / WebSocket / `sendBeacon` сверяются с открытым текстом в поле сайта и отбрасываются
- Если сейф заблокирован или шифрование упало, отправка **прерывается**, а не уходит открытым текстом

## Аудит

Аудита сертифицированной лаборатории не было. Код открыт, тесты: `node scripts/test-protocol.mjs`, `node scripts/test-vault.mjs`.

Исправления по ходу разработки: убран запрос шрифтов Google; пароль больше не кладётся в session storage; PBKDF2 поднят до 600k с автообновлением старых сейфов; проверка low-order X25519; пометки несверенных и неизвестных ключей; CSP `connect-src 'none'`.

Уязвимости — GitHub issue. Боевые секретные ключи не присылать.

---

# English

## Designed for

Someone who can read VK/MAX logs, the messenger channel, or a history dump — **without** the pair’s devices and identity secrets.

Public keys `S256K1.…` are **not** a secret in this model. They are meant to travel in the same chat. Two X25519 public points do not yield the shared secret `ab·G` (CDH). No secret → no AES key → AES-GCM will not open. There is no session to join: no server, pairwise sealing only.

Compare fingerprints by voice / in person. Checking them only inside the same chat does not catch a first-contact swap.

## Not designed for

- Seized **unlocked** device, or the vault password obtained before burn
- Malware, accessibility overlays, screenshots, a camera on the screen
- VK/MAX page JS if you type into **their** box or turn on “show decrypted bubbles” (off by default). Use the Pairlock field in a closed shadow root
- Accidental plaintext: unlocked vault + unbound chat
- Replay: a server can re-deliver an old packet; it decrypts to the same old text. No sequence numbers
- Metadata: who, when, ciphertext length
- Voice, photos, files, stickers — text only
- A cold copy of the vault blob taken before burn
- RAM / swap forensics on a live unlocked session

## Cryptography

- Classic packet: `S256M1.` = version ‖ sender pub ‖ ephemeral pub ‖ 96-bit nonce ‖ AES-256-GCM
- Stealth (default): same body as `base64url(random pad ‖ body ‖ tag)` with no brand. Receivers accept both. This hides a product fingerprint; it does not make the blob look like ordinary language
- Message key = HKDF-SHA256(ECDH(eph, their_id) ‖ ECDH(my_id, their_id), salt = nonce, info = `s256m-v1-msg` ‖ pubs ‖ nonce). Static ECDH authenticates the sender
- Associated data = version ‖ sender pub ‖ ephemeral pub
- All-zero X25519 shared secrets (low-order keys, RFC 7748 §6.1) are rejected
- Fingerprint = first 80 bits of SHA-256(pub), five groups of four hex chars
- Identity and ephemerals: 32 bytes from `crypto.getRandomValues` → X25519 scalar per RFC 7748 (clamping) via TweetNaCl `nacl.box.keyPair` or `crypto.subtle.generateKey({ name: "X25519" })`. The key is not derived from the password and is not issued by a server. Message nonces are 12 random bytes from the same CSPRNG

## Vault and keys

- `S256VAULT2`: PBKDF2-SHA256, iteration count stored in the blob (currently 600,000). Legacy `S256VAULT1` (250,000) is read and re-wrapped
- The password is **never persisted**. While unlocked, only the derived key is kept
- Rotate identity (Keys tab, three warnings + typed phrase + password) replaces the long-term key and wipes contacts
- Optional timed pair: `S256KT1.` — 15m / 30m / 1h / 1d / 1w. Burns that contact’s session and local history only
- Disappearing thread: `S256KB1.` — pair session + hash ratchet. After first read, plaintext lives 30 / 60 / 120 s, then the message key is deleted. Identity alone cannot reopen the packet. Unopened slots burn after 7 days. Screenshots and a cheating client are out of scope
- Sent packets cannot be recovered from the wire with the peer’s secret — the ephemeral is discarded. A local copy sits in the vault

## Extension

- Manifest V3, permissions `storage` + `activeTab` + `alarms`, hosts limited to VK / MAX. No `externally_connectable`
- Composer lives in a closed shadow root. Capture listeners at `document_start` swallow keyboard events before page scripts
- Leak guard: while a chat is bound, `fetch` / XHR / WebSocket / `sendBeacon` bodies that match site-composer plaintext are dropped
- Encryption **fails closed**: if the vault is locked or encrypt fails, the send is aborted rather than sent in plaintext

## Review

No certified-lab audit. Source is public. Tests: `node scripts/test-protocol.mjs`, `node scripts/test-vault.mjs`.

Fixes already in tree: no Google Fonts request; password no longer in session storage; PBKDF2 raised to 600k with legacy upgrade; low-order X25519 check; unverified / unknown key markers; CSP `connect-src 'none'`.

Report issues on GitHub. Do not send production private keys.
