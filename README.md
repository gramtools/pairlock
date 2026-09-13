# Pairlock

[Русский](#русский) · [English](#english)

Локальное шифрование текста для VK, MAX и любого другого чата. **Сервера нет.** Ключи не покидают устройство. Мессенджер видит только шифр.

MIT · открытый исходный код · [схема](#как-устроено-шифрование) · [SECURITY.md](./SECURITY.md)

---

# Русский

Pairlock — клиент на вашем устройстве, не мессенджер и не облако. Текст закрывается **AES-256-GCM**, обмен секретом — **X25519**, на каждое сообщение свой эфемерный ключ. SHA-256 здесь только внутри HKDF, это не «шифр SHA-256».

Своего бэкенда, аккаунта и телеметрии нет. Popup и страница ставят CSP `connect-src 'none'` — клиент сам никуда не ходит. По сети мессенджера уходит уже готовый пакет.

Официального аудита лаборатории не было. Код открыт: [`js/protocol.js`](./js/protocol.js), [`js/crypto.js`](./js/crypto.js), [`js/vault.js`](./js/vault.js).

## Установка

Расширение — Manifest V3, ставится в **Chrome, Edge, Яндекс.Браузер, Brave** (один и тот же Chromium). Сайты: `vk.ru`, `vk.com`, `web.max.ru`.

1. Откройте `chrome://extensions` (в Edge — `edge://extensions`, в Яндексе — `browser://extensions`).
2. Включите **Режим разработчика**.
3. **Загрузить распакованное** → папка репозитория, где лежит `manifest.json`.
4. Создайте хранилище, обменяйтесь ключами, сверьте отпечаток **голосом**.
5. В чате нажмите **Привязать** и пишите в зелёном поле Pairlock.

**Safari / iPhone:** как Chrome-расширение не ставится. Только страница по обычному `https://` в Safari (локальный файл на iPhone не запускается).

**Firefox:** этот пакет не собирался. Нужен отдельный порт.

**Страница без расширения:** [s256.html](./s256.html) в Chrome на ПК / Android. Свой хостинг / GitHub Pages: `index.html`, `css/`, `js/`, `vendor/`, `icons/`, `sw.js`, `site.webmanifest`.

Фото, файлы и голосовые **не шифруются**. Пока хранилище заблокировано или чат не привязан, расширение сообщения не трогает.

## Своё поле и окно чата

Поле «Напишите сообщение» на сайте VK/MAX читает скрипт страницы: черновики, аналитика набора, логи для администрации. Даже если потом уйдёт шифр, **набранный текст они уже видели**.

Поэтому у привязанного чата расширение кладёт **своё зелёное поле** поверх поля сайта и открывает **своё окно чата**. Пишите только туда для полной уверенности и работы шифрования. 

- поле живёт в закрытом shadow DOM — скрипты VK/MAX его не открывают и не читают;
- нажатия клавиш и вставка перехватываются на `document_start`, до слушателей сайта;
- в строку сайта попадает уже готовый зашифрованный пакет, после чего расширение само нажимает «отправить»;
- если всё же набрать открытый текст в поле VK/MAX, страж утечек режет уходящие `fetch` / XHR / WebSocket / `sendBeacon` с этой фразой.

Подстановка расшифровки в пузыри сайта по умолчанию выключена: на странице остаётся шифр, фразу читаете в окне Pairlock.

## Как устроено шифрование

У каждого своя долгосрочная пара X25519:

| | Где живёт | Можно ли слать |
|---|---|---|
| **Секретный ключ** | только на устройстве, в сейфе | нет, никогда |
| **Публичный ключ** `S256K1.…` | его как раз и отправляют | да, это не пароль |

Секрет **не задаёте вы и не выдаёт сервер**. При создании сейфа устройство само рисует 32 случайных байта из криптостойкого ГСЧ браузера — `crypto.getRandomValues` (Web Crypto). Из них собирается скаляр X25519 по стандарту RFC 7748: лишние биты обрезаются (clamping), публичный ключ считается как `A = a·G` на Curve25519. В коде это `nacl.box.keyPair()` (TweetNaCl, лежит в `vendor/`) либо `crypto.subtle.generateKey({ name: "X25519" })`.

Сайт rfc-editor.org **не открывается**. RFC 7748 — номер стандарта, алгоритм уже внутри расширения. Генерация ключа, шифрование и расшифровка идут полностью офлайн. Сеть нужна только мессенджеру, чтобы доставить уже готовый пакет. Popup и страница Pairlock ставят CSP `connect-src 'none'` — сами никуда не ходят.

Пароль сейфа — **другая** вещь: он не является ключом переписки. Из пароля через PBKDF2-SHA256 (600 000 итераций) получается только ключ, которым сейф закрыт на диске. Сам `a` уже лежит внутри сейфа. Забытый пароль не восстанавливает ключ — и наоборот, по паролю ключ не угадать: пространство скаляров после clamping ≈ 2²⁵², перебор нереален.

Эфемер на каждое сообщение и nonce (12 байт) берутся из того же ГСЧ и после отправки забываются. Никто не выбирает «слабый» ключ вручную, сида и «мастер-фразы» нет.

```
Вы                              Друг
секрет a  — только здесь        секрет b  — только здесь
публичный A = a·G  ──────────►  сохраняет A
сохраняет B        ◄──────────  публичный B = b·G
```

Пара = оба добавили друг друга в контакты. Шифр заточен под **одного** получателя. Третий в том же чате VK ключ пары не получает.

На каждое сообщение отправитель:

1. Генерирует **новый** эфемерный X25519 `(e, E)` — живёт одну отправку, потом забывается.
2. Считает два ECDH: `e·B` и `a·B`.
3. Смешивает их через **HKDF-SHA256** (соль = nonce). Получается ключ AES на это сообщение.
4. Шифрует текст **AES-256-GCM**. В канал уходит пакет, не фраза.

```
пакет  =  версия  ‖  A  ‖  E  ‖  nonce  ‖  AES-GCM(текст)
           1 б      32 б  32 б   12 б      шифр + тег
```

Получатель считает те же ECDH своим секретом `b`: `b·E` и `b·A`. Совпало — GCM открывает текст. Чужой ключ, порча, не та пара — ошибки, фразы нет.

Ключ сообщения:

```
HKDF-SHA256( ECDH(эфемер, ключ_друга)  ‖  ECDH(мой_секрет, ключ_друга) )
```

Статический ECDH одновременно **аутентифицирует** отправителя: подделать пакет «от известного контакта» нельзя без его секрета.

По умолчанию пакет уходит в **стелс-виде**: тот же body, но без префикса `S256M1.` — каждое сообщение начинается по-разному. Приёмник читает оба формата.

## Срок пары (временный чат)

По умолчанию ключи бессрочные: `S256K1.…`. На вкладке **Ключи** можно задать срок **следующей** пары: 15 мин / 30 мин / час / сутки / неделя. В чат уходит `S256KT1.…` (тот же identity + сессионный ключ + срок).

- действует на ваш QR и **новую** пару; уже созданные контакты не меняются;
- оба должны совпасть по сроку **до** обмена — либо принять срочный ключ друга, срок подхватится сам;
- когда время вышло, стираются **только сессия и локальная история этого чата**; остальные контакты на месте;
- отпечаток identity тот же; чтобы писать снова — обменяйтесь ключами заново;
- скриншот, сделанный до истечения, по-прежнему риск; это не «сообщение исчезает с сервера VK».

Смена бессрочного identity (красная кнопка на вкладке «Ключи») — другое: сгорают все контакты на этом устройстве, отпечаток новый. Это не смена срока.

## Почему публичные ключи можно слать открыто

Публичный ключ X25519 — это точка на кривой: `A = a·G`. По `A` восстановить `a` — задача дискретного логарифма. Для Curve25519 практического способа нет.

Поэтому `S256K1.…` **специально** шлют в том же VK / MAX / Telegram. Это не пароль и не секрет хранилища. Секретный ключ и пароль сейфа в чат не отправляют.

Отпечаток (первые 80 бит SHA-256 публичного ключа) сверяют **голосом или лично**. Если сверять только в том же чате, подмену ключа при первом обмене можно не заметить. Пока не сверили — контакт помечен, сообщения с `◦`.

## Почему перехватчик не читает переписку

Допустим, у оператора канала, у сервера мессенджера или у того, кто выгрузил историю, есть **оба** публичных ключа `A` и `B` и все пакеты.

Ему этого **недостаточно**.

Общий секрет пары — `a·B = b·A = ab·G`. Чтобы его посчитать, нужен **хотя бы один секрет** (`a` или `b`). Из двух публичных точек `A` и `B` величину `ab·G` не получить — это задача CDH, на X25519 она считается неразрешимой.

| Кто | Что видит | Почему нет текста |
|---|---|---|
| Сервер VK/MAX, логи, перехват канала | оба `S256K1.…` и все пакеты | нет `a` и нет `b` → нет ключа AES → GCM не открывается |
| Посторонний в том же чате / «подключился третьим» | ту же кашу | шифр заточен под публичный ключ получателя, не «для всех в беседе» |
| Свой клиент Pairlock без вашего контакта | пустой сейф | чужой публичный ключ сам в контакты не попадает; добавить его можете только вы |
| Знает одну старую фразу | эту фразу | plaintext **не** восстанавливает identity; следующее сообщение — новый эфемер и новый AES |

«Подключиться» к чужой паре нельзя: сервера сессий нет, ключ никуда не запрашивается и никому не раздаётся. Третье устройство получает текст только если **вы сами** добавили его публичный ключ (и тогда это уже другая пара).

Что **может** прочитать текст: устройства пары с открытым сейфом; вредонос или изъятый разблокированный телефон; скриншот экрана; подмена ключа при первом обмене, если отпечаток не сверили вне канала.

Подробный перечень угроз — [SECURITY.md](./SECURITY.md).

## Что защищает и что нет

**Защищает** текст от сервера мессенджера и от тех, у кого нет устройств пары и их секретных ключей.

**Не защищает:** метаданные (кто с кем, когда, длина), фото / голос / файлы, изъятый разблокированный телефон, подмену ключа без сверки отпечатка, скриншот.

Хранилище `S256VAULT2`: пароль → PBKDF2-SHA256 (600 000 итераций) → AES-GCM. Пароль никуда не пишется. Забытый пароль восстановить некому.

## Сборка

```bash
node scripts/test-protocol.mjs
node scripts/test-vault.mjs
node scripts/build-standalone.mjs    # один файл s256.html
node scripts/pack-extension.mjs      # zip для Chrome Web Store
```

Лицензия [MIT](./LICENSE).

---

# English

Pairlock is a **local** encryption pad for VK, MAX, and any other chat. **No server.** Keys never leave the device. The messenger only sees ciphertext.

Text is sealed with **AES-256-GCM**. Key agreement is **X25519**. Each message gets a fresh ephemeral key. SHA-256 is used inside HKDF — this is not a “SHA-256 cipher”.

There is no backend, account, or telemetry. The popup and the standalone page ship CSP with `connect-src 'none'`. The client does not phone home.

No laboratory audit. The source is public: [`js/protocol.js`](./js/protocol.js), [`js/crypto.js`](./js/crypto.js), [`js/vault.js`](./js/vault.js). Threat model: [SECURITY.md](./SECURITY.md).

## Install

The extension is Manifest V3. It loads in **Chrome, Edge, Yandex Browser, and Brave** (same Chromium). Sites: `vk.ru`, `vk.com`, `web.max.ru`.

1. Open `chrome://extensions` (Edge: `edge://extensions`, Yandex: `browser://extensions`).
2. Enable **Developer mode**.
3. **Load unpacked** → this repo folder (`manifest.json`).
4. Create a vault, exchange keys, compare the fingerprint **by voice**.
5. Bind the chat and type in the Pairlock field.

**Safari / iPhone:** cannot load this as a Chrome extension. Use a normal `https://` page in Safari (a local file will not run on iPhone).

**Firefox:** this package was not built for it. A separate port is needed.

**Page without the extension:** [s256.html](./s256.html) in Chrome on desktop / Android. Self-host / GitHub Pages: `index.html`, `css/`, `js/`, `vendor/`, `icons/`, `sw.js`, `site.webmanifest`.

Photos, files, and voice notes are **not** encrypted. If the vault is locked or the chat is unbound, the extension does not touch messages.

## Own composer and chat window

The site’s “Write a message” box is readable by VK/MAX page scripts: drafts, typing analytics, admin logs. Encrypting *after* you typed there is too late — they already saw the sentence.

So for a bound chat the extension puts **its own green field** over the site box and opens **its own chat window**. Type only there.

- the field lives in a closed shadow DOM — VK/MAX scripts cannot open or read it;
- keystrokes and paste are captured at `document_start`, before page listeners;
- only the finished packet is written into the site’s box; the extension then hits send;
- if plaintext still lands in the VK/MAX field, a leak guard drops matching `fetch` / XHR / WebSocket / `sendBeacon` bodies.

On-page decrypt into site bubbles is off by default: the page keeps ciphertext; you read the sentence in the Pairlock window.

## How encryption works

Each side has a long-term X25519 identity:

| | Where it lives | Safe to send? |
|---|---|---|
| **Secret key** | on-device, inside the vault | never |
| **Public key** `S256K1.…` | meant to be sent | yes — it is not a password |

You do **not** pick the secret, and no server issues it. When the vault is created, the device draws 32 random bytes from the browser CSPRNG — `crypto.getRandomValues` (Web Crypto). Those bytes become an X25519 scalar per RFC 7748 (clamping), and the public key is `A = a·G` on Curve25519. In code that is `nacl.box.keyPair()` (TweetNaCl, shipped in `vendor/`) or `crypto.subtle.generateKey({ name: "X25519" })`.

rfc-editor.org is **never fetched**. RFC 7748 is the name of the standard; the algorithm is already inside the extension. Keygen, encrypt, and decrypt are fully offline. The only network is the messenger delivering a finished packet. Pairlock’s popup and page ship CSP `connect-src 'none'` — they do not phone home.

The vault password is **separate**. PBKDF2-SHA256 (600,000 iterations) only wraps the blob on disk. The identity scalar `a` already lives inside that blob. A forgotten password cannot recover the key — and the password cannot be used to guess `a`: after clamping the space is about 2²⁵², which is not brute-forceable.

Per-message ephemerals and the 12-byte nonce come from the same CSPRNG and are discarded after send. There is no user-chosen “weak key”, no seed, and no master phrase.

```
You                             Friend
secret a  — only here           secret b  — only here
public A = a·G  ──────────────► saves A
saves B         ◄────────────── public B = b·G
```

A pair exists only when both sides have added each other. Ciphertext is sealed to **one** recipient. Sitting in the same VK chat does not grant the pair key.

For every message the sender:

1. Generates a **fresh** ephemeral X25519 `(e, E)` — used once, then discarded.
2. Computes two ECDHs: `e·B` and `a·B`.
3. Mixes them with **HKDF-SHA256** (salt = nonce) into a one-message AES key.
4. Encrypts with **AES-256-GCM**. The wire sees a packet, not a sentence.

```
packet  =  version  ‖  A  ‖  E  ‖  nonce  ‖  AES-GCM(text)
            1 B       32 B  32 B   12 B      ciphertext + tag
```

The recipient repeats the ECDHs with secret `b`: `b·E` and `b·A`. Match — GCM opens. Wrong key, corruption, or the wrong pair — no plaintext.

```
HKDF-SHA256( ECDH(ephemeral, their_pub)  ‖  ECDH(my_secret, their_pub) )
```

The static ECDH also **authenticates** the sender: a third party cannot forge a packet “from” a known contact without that contact’s secret.

Default **stealth** wrap: the same body, no `S256M1.` brand. Receivers accept both forms.

## Timed pair (temporary chat)

Keys are forever by default: `S256K1.…`. On the **Keys** tab you can set a lifetime for the **next** pair: 15 min / 30 min / 1 hour / 1 day / 1 week. The chat then carries `S256KT1.…` (same identity + session key + TTL).

- applies to your QR and **new** pairs; existing contacts stay as they are;
- both sides must match the lifetime **before** exchange — or accept the friend’s timed key and adopt their TTL;
- when time is up, only **that** contact’s session and local history burn; other contacts stay;
- the identity fingerprint does not change; exchange keys again to keep writing;
- a screenshot taken before expiry still exists; this does not wipe the message from VK’s server.

Rotating the long-term identity (red button on Keys) is different: every contact on this device is wiped and the fingerprint changes. That is not a TTL change.

## Why public keys are safe to exchange

An X25519 public key is a curve point: `A = a·G`. Recovering `a` from `A` is the elliptic-curve discrete logarithm. There is no practical attack on Curve25519.

So `S256K1.…` is **supposed** to travel through VK / MAX / Telegram. It is not a password and not the vault secret. The identity secret and the vault password never go into a chat.

Compare the fingerprint (first 80 bits of SHA-256 of the public key) **by voice or in person**. Checking it only inside the same chat does not catch a first-contact swap. Unverified contacts are marked; their messages show `◦`.

## Why an interceptor cannot read the chat

Suppose an operator, the messenger server, or anyone with a full history dump has **both** public keys `A` and `B` and every packet.

That is **not enough**.

The pair secret is `a·B = b·A = ab·G`. Computing it requires **at least one** secret (`a` or `b`). From the two public points `A` and `B` you cannot get `ab·G` — that is the CDH problem, believed hard on X25519.

| Who | What they see | Why there is no text |
|---|---|---|
| VK/MAX server, logs, lawful intercept of the channel | both `S256K1.…` and every packet | no `a`, no `b` → no AES key → GCM will not open |
| A third person in the same chat / “joining” the thread | the same blob | sealed to the recipient’s public key, not to “everyone in the room” |
| A Pairlock install that is not in your address book | an empty vault | a stranger’s public key does not appear in your contacts unless you add it |
| Someone who knows one old sentence | that sentence | plaintext does **not** recover the identity; the next message has a new ephemeral and a new AES key |

There is no session to “join”. No server hands out keys. A third device gets plaintext only if **you** add its public key — and then it is a different pair.

What **can** read the text: the pair’s devices with an unlocked vault; malware or a seized unlocked phone; a screenshot; a first-contact key swap if the fingerprint was not checked out of band.

## What it protects — and what it does not

**Protects** the text from the messenger server and from anyone who does not have the pair’s devices and identity secrets.

**Does not protect:** metadata (who, when, length), photos / voice / files, a seized unlocked device, first-contact MITM without a fingerprint check, screenshots.

Vault format `S256VAULT2`: password → PBKDF2-SHA256 (600,000 iterations) → AES-GCM. The password is never stored. Nobody can reset a forgotten password.

## Build

```bash
node scripts/test-protocol.mjs
node scripts/test-vault.mjs
node scripts/build-standalone.mjs    # single-file s256.html
node scripts/pack-extension.mjs      # zip for the Chrome Web Store
```

[MIT](./LICENSE) license.
