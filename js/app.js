(function () {
  const V = () => S256Vault;
  const P = () => S256Protocol;
  const app = document.getElementById("app");
  const isPopup = document.body.classList.contains("popup");
  const isExt = typeof chrome !== "undefined" && !!(chrome.runtime && chrome.runtime.id);
  const viaShortcut = location.protocol === "data:";
  let tab = "pad";
  let notice = "";
  let noticeType = "ok";
  let currentPeer = null;
  let bindNext = false;
  let padMode = "enc"; /* "enc" | "dec" */
  let padResult = null; /* { text, meta, kind } shown in the result box */
  let padWho = null; /* selected contact id */
  let chatId = undefined; /* undefined = auto from open VK dialog, null = list, string = thread */
  let showPad = false; /* old encrypt/decrypt pad */
  let chatDraft = "";
  let chatPoll = null;
  let chatSel = { start: 0, end: 0, focused: false };
  let chatStick = true;
  let chatForceBottom = false;
  let chatScrollTop = 0;
  let obStep = 1; /* onboarding: 1 send key → 2 wait/pair → 3 verify codes */
  let obContactId = null; /* contact added during the wizard */
  let obKeySent = false; /* user marked / copied their key in step 1 */
  let verifyId = null; /* contact being verified from the People tab */
  let chatVerify = false; /* voice fingerprint check inside an open chat thread */
  let wizardForced = false; /* user re-opened the wizard manually */
  let rotateStep = 0; /* 0 off, 1–3 confirm screens */
  let peopleDelId = null; /* contact awaiting delete confirm */
  let peopleManual = false; /* show rare manual-add form */
  function lsGet(key) {
    try {
      return localStorage.getItem(key);
    } catch (_) {
      return null;
    }
  }
  function lsSet(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (_) {
      /* iPhone file:// */
    }
  }

  let lang = lsGet("s256.lang") || (navigator.language && navigator.language.startsWith("ru") ? "ru" : "en");

  const I18N = {
    ru: {
      title: "Pairlock",
      tag: "Ключи только на этом устройстве. Сервера нет. Исходный код открыт.",
      first: "первый запуск",
      locked: "заблокировано",
      open: "открыто",
      createTitle: "Создать хранилище",
      createLead: "Пароль закрывает ключи на этом компьютере. Сервера у Pairlock нет: если пароль забыть, восстановить нельзя. Весь клиент открыт (MIT) — смотрите сами.",
      howTitle: "Сначала — пара",
      how1t: "Оба добавляют друг друга",
      how1: "Пока человека нет в контактах, его сообщения не открыть. Шифрование только для пары, не «для всех в чате».",
      how2t: "Третий не подключится",
      how2: "Посторонний не заходит в переписку, как в обычной беседе. Без ключа с вашего устройства шифр так и остаётся шифром.",
      how3t: "Криптография здесь, сети Pairlock нет",
      how3: "Ключи никуда не уходят. В VK едет только шифр. Интернет нужен лишь чтобы мессенджер доставил его другу.",
      how4t: "Исходный код открыт",
      how4: "MIT, без чёрного ящика и без своего сервера. Протокол, хранилище и расширение лежат в этой папке — их можно читать, собирать и форкать.",
      pw: "Пароль (от 8 символов, лучше длинная фраза)",
      pw2: "Ещё раз",
      create: "Создать ключи",
      phoneHint: "На iPhone локальный HTML не запускается. Нужна ссылка https:// в Safari. После первого открытия можно поставить на Домой; без сети PWA часто ограничен.",
      extHint: "На компьютере: расширение само закрывает веб-VK и веб-MAX.",
      qrHint: "Три шага: отправьте этот ключ другу в чат (это не секрет) → он пришлёт свой → отпечаток сверьте голосом, не в том же чате.",
      unlockTitle: "Разблокировать",
      unlockLead: "Пока замок закрыт, текст в VK и MAX уходит открытым. Введите пароль, чтобы снова шифровать.",
      unlock: "Открыть",
      tabPad: "Чат",
      tabKeys: "Ключи",
      tabPeople: "Люди",
      tabHelp: "Справка",
      plain: "Открытый текст — его нельзя вставлять в VK/MAX",
      to: "Кому",
      needContact: "Сначала добавьте человека",
      enc: "Зашифровать",
      cipher: "Шифротекст — это видит сервер",
      dec: "Расшифровать",
      copy: "Копировать",
      share: "Поделиться",
      pub: "Публичный ключ",
      fp: "Отпечаток",
      copyKey: "Текст ключа в MAX/VK",
      shareKey: "Поделиться текстом",
      saveQr: "QR-картинка в чат",
      qrShareCaption: "Мой публичный ключ Pairlock. Это не секрет — кидай в MAX/VK. Отпечаток сверим голосом.",
      export: "Экспорт хранилища",
      import: "Импортировать",
      backup: "Резервная копия (вставьте blob)",
      backupPw: "Пароль этой копии",
      lock: "Заблокировать",
      name: "Имя",
      theirKey: "Его открытый ключ",
      add: "Сохранить",
      nobody: "Пока никого",
      peopleHint: "Откройте личный чат в VK или MAX. Плашка Pairlock внизу экрана сама проведёт шаги: ключ → его ключ → создать пару.",
      peopleAddManual: "Добавить вручную",
      peopleHideManual: "Скрыть форму",
      peopleNoChat: "чат не привязан",
      peopleCodesOk: "коды сверены",
      peopleCodesNo: "сверьте коды голосом",
      del: "Удалить",
      delConfirmT: "Удалить этого человека?",
      delConfirmL: "Ключи с «{name}» сотрутся только в Pairlock. Переписка в VK/MAX останется, но шифр вы больше не прочитаете. Чтобы снова писать закрыто — создайте пару заново.",
      delYes: "Да, удалить",
      rename: "Переименовать",
      thisChat: "Привязать этот чат",
      nextChat: "Привязать следующий чат",
      copied: "Скопировано",
      created: "Хранилище готово. Дальше — откройте VK или MAX.",
      goSiteT: "Дальше — чат с другом",
      goSiteL: "Хранилище готово. Пару создаёте не здесь, а на сайте: откройте диалог — внизу плашка Pairlock. Нажимайте синюю кнопку, она скажет, что делать.",
      goSite1t: "Откройте VK или MAX",
      goSite1: "В браузере: vk.ru или web.max.ru → «Чаты».",
      goSite2t: "Зайдите в диалог с другом",
      goSite2: "Плашка снизу: шаг 1 — отправить ключ, шаг 2 — ждать его, шаг 3 — «Создать пару».",
      goSite3t: "Сверьте коды голосом и пишите",
      goSite3: "Пишите в зелёном поле Pairlock. На сервер уйдёт только шифр.",
      goVk: "Открыть VK",
      goMax: "Открыть MAX",
      goOk: "Понятно",
      goPairHere: "Создать пару здесь",
      addFirst: "Откройте диалог в VK/MAX — плашка Pairlock проведёт шаги. Или сохраните человека здесь.",
      startWizard: "Создать пару здесь",
      verifyInChat: "Сверить коды",
      verifyHide: "К сообщениям",
      obDone: "Коды совпали. Можно писать — лучше через VK/MAX и плашку Pairlock.",
      added: "Человек сохранён. Сверьте коды голосом — не по чату, где менялись ключами.",
      helpLead: "Pairlock шифрует текст у вас на устройстве. MAX и VK только везут уже готовый шифр: содержимое они не видят и не умеют открыть.",
      helpCrypto: "Всё построено на криптографии: X25519, AES-256-GCM, HKDF-SHA256. На каждое сообщение — новый одноразовый ключ. Своего сервера нет, считается только у вас.",
      schemeKeysT: "У каждого два ключа",
      schemeSecret: "Секретный",
      schemeSecretH: "никогда не отправляется — только на вашем устройстве",
      schemePublic: "Открытый",
      schemePublicH: "его как раз и кидают другу в чат",
      schemeWhyPub: "Открытый ключ — как номер почтового ящика. Им нельзя прочитать ваши сообщения. Расшифровать умеет только секретный, а он с устройства не уходит. Поэтому слать открытый ключ прямо в MAX — нормально и так задумано.",
      schemeExT: "Как появляется пара",
      schemeExLead: "Пара — это не «зашёл в беседу». Это когда вы оба сохранили друг друга. Один открытый ключ в чате ещё ничего не расшифровывает.",
      schemeYou: "Вы",
      schemeFriend: "Друг",
      schemePipe: "MAX",
      schemeKeyWire: "открытый ключ",
      schemeThen: "Оба нажали «Создать пару» — готово. Дальше шифруете только ему, не «всем в чате».",
      schemeThirdT: "Почему третий не подключится",
      schemeThird: "В обычном VK любой может войти в беседу и читать. Здесь текст зашифрован под конкретного человека. Кто просто сидит в том же диалоге, видит тот же шифр и не открывает его: нет секретного ключа ни вашей пары.",
      schemeThirdNeed: "Чтобы третий начал читать, мало добавить его в чат. Нужно обоюдно создать пару: вы сохраняете его ключ, он — ваш. Без этого шага с обеих сторон вы ему не шифруете, а чужой шифр он не расшифрует. Сам он в пару не войдёт.",
      schemeThirdPair: "Вы и друг — пара",
      schemeThirdOut: "Третий без пары — только шифр",
      schemeMsgT: "Что уходит в мессенджер",
      schemeMsgLead: "Пишете обычный текст в зелёном поле Pairlock. На устройство друга уходит уже шифр. MAX его доставляет, но расшифровать не может.",
      schemePlain: "содержимое",
      schemeLock: "шифрование",
      schemeNoise: "шифр",
      schemeOnlyPair: "читает только пара",
      schemeServer: "Сервер, логи, перехват канала — всё это видит шифр, не ваш текст.",
      helpDoT: "Что сделать",
      helpStep1t: "Отправьте свой открытый ключ",
      helpStep1: "Кнопка на плашке. Это не пароль и не секрет хранилища — его специально шлют в том же чате.",
      helpStep2t: "Создайте пару, когда придёт его ключ",
      helpStep2: "Плашка сама предложит. Если у друга срок (15 минут и т.п.) — примете сразу, в настройки лезть не нужно.",
      helpStep3t: "Сверьте коды голосом",
      helpStep3: "Короткий звонок или лично. Если сверять только в том же чате, подмену ключа можно не заметить.",
      helpMore: "Ещё по делу",
      faqVoiceT: "Зачем звонок, если ключ уже в чате?",
      faqVoice: "Тот же чат теоретически могут подменить: вы сохраните не его ключ, а чужой, и шифровать будете не тому. Совпали коды голосом — ключ настоящий. Не совпали — не пишите, обменяйтесь заново.",
      faqLocalT: "Pairlock сам куда-то ходит?",
      faqLocal: "Нет. Своего сервера, аккаунта и облака нет. Ключи никуда не загружаются. Интернет нужен только мессенджеру, чтобы довезти шифр до друга.",
      faqNoT: "Что не шифруется?",
      faqNo: "Фото, файлы, голосовые — скрепка сайта уходит как есть. Кто кому пишет и когда — сервер видит. Если устройство разблокировано и хранилище открыто — на экране обычный текст.",
      faqOssT: "Можно ли проверить, что нет подвоха?",
      faqOss: "Да. Код открыт (MIT), криптография стандартная (X25519, AES-256-GCM). Своего сервера нет — некуда прятать бэкдор. Протокол и хранилище лежат в этой папке.",
      ttlTitle: "Срок ключей",
      ttlHelp: "Срок только для следующей пары. После срока стирается этот чат, не всё хранилище.",
      burnTitle: "Сжечь хранилище",
      burnHelp: "Редкое: сжечь всё хранилище на этом устройстве. Не то же самое, что срок пары.",
      burnOff: "Выкл",
      burn1h: "1 час",
      burn1d: "Сутки",
      burnLeft: "До сжигания",
      burnConfirm: "Включить сжигание?",
      burnDone: "Хранилище сожжено. Создайте новое.",
      pairModeTitle: "Срок следующей пары",
      pairSafe: "С автосжиганием ключей",
      pairSafeHint: "Только для этой пары: через срок сессия и история чата сотрутся. Другие контакты не трогаем.",
      pairSafeWarn: "Выберите срок до обмена ключами. Оба должны совпасть. По истечении стирается только этот чат — не всё хранилище. Скрин до срока всё ещё риск.",
      pairOfferHint: "Действует на ваш QR и новые пары. Уже созданные контакты не меняются — у каждого свой срок.",
      burnChatTitle: "Сгорающая переписка",
      burnChatHint: "На пару создаётся свой сессионный ключ. Каждое сообщение после прочтения живёт 30 с / 1 мин / 2 мин — потом Pairlock его больше не откроет. Чат может идти сутками, сгорают отдельные фразы. Скрин до таймера — риск.",
      burnChatOff: "Выкл",
      burnChat30: "30 с",
      burnChat60: "1 мин",
      burnChat120: "2 мин",
      burnChatOn: "сгорает",
      pairForever: "Бессрочно",
      pairForeverHint: "Ключи с этим человеком живут, пока не сотрёте сами.",
      pairBurnLeft: "Сжигание хранилища через",
      pairPickTtl: "Срок",
      pairTtl15: "15 мин",
      pairTtl1h: "1 час",
      pairTtl1d: "сутки",
      pairTtl1w: "неделя",
      pairExportOff: "Экспорт недоступен, пока горит всё хранилище",
      pairLocked: "Идёт сжигание всего хранилища",
      pairNeedsRekey: "Чтобы сменить срок с контактом — обменяйтесь ключами заново с новым сроком.",
      pairSafeConfirm: "unused",
      pairSafeConfirmEmpty: "unused",
      keysMore: "Ещё",
      keysIdentity: "Ваш ключ",
      copyKeyShort: "Копировать",
      ttlForever: "Бессрочно",
      ttl15: "15 минут",
      ttl30: "30 минут",
      ttl1h: "1 час",
      ttl1d: "сутки",
      ttl1w: "неделя",
      ttlOn: "срок",
      ttlDead: "срок вышел",
      rotate: "Новый ключ",
      rotateT1: "Это нельзя отменить",
      rotateL1: "Будет новый бессрочный ключ и новый отпечаток. Старый секрет на этом устройстве сотрётся.",
      rotateW1a: "Все текущие контакты будут удалены — их нужно добавить заново.",
      rotateW1b: "Старые сообщения S256M1 этим ключом больше не откроются — ни входящие, ни ваши копии.",
      rotateW1c: "Друзья продолжат писать на старый ключ, пока вы не отправите им новый.",
      rotateNext: "Понятно, дальше",
      rotateT2: "Ещё раз, своими словами",
      rotateL2: "Это не смена срока (15 мин / сутки). Срок крутит сессию. Здесь меняется сам identity — как будто вы завели Pairlock с нуля, пароль хранилища тот же.",
      rotateW2a: "Экспорт, который вы делали раньше, содержит СТАРЫЙ ключ. Не импортируйте его поверх нового, если не хотите откатиться.",
      rotateW2b: "Если кто-то уже сохранил ваш старый S256K1, он больше не ваш. Скажите собеседникам, что ключ сменили.",
      rotateTypeLabel: "Чтобы продолжить, наберите слово ниже как есть:",
      rotatePhrase: "СБРОСИТЬ",
      rotateT3: "Подтвердите паролем",
      rotateL3: "Последний шаг. Пароль хранилища не меняется — проверяем, что это вы.",
      rotateGo: "Стереть старый ключ и выпустить новый",
      rotateDone: "Новый ключ готов. Отправьте его друзьям и сверьте отпечатки заново.",
      rotateNeedPhrase: "Наберите слово в точности как показано",
      cancel: "Отмена",
      faqDomT: "Почему не в пузырях VK?",
      faqDom: "Страница VK — их код. По умолчанию читаете в «Чате» Pairlock, чтобы скрипты сайта не видели содержимое.",
      pageDecrypt: "Показывать расшифровку в пузырях VK/MAX",
      pageDecryptHelp: "По умолчанию выключено: на странице остаётся шифр, читаете в «Чате». Если включить, открытый текст окажется в самой странице VK/MAX. Их скрипты могут его увидеть — шанс, что фразу снимут, уже есть. Сервер по-прежнему получает только шифр, ключ с устройства так не узнают. Гарантии «никто на сайте это не прочитал» в таком режиме нет.",
      stealthWire: "Стелс-формат (без метки S256M1.)",
      stealthWireHelp: "В чат уходит случайно выглядящая строка без постоянного начала S256M1. Старые сообщения с S256M1. по-прежнему читаются. Это прячет бренд, но не делает пакет «обычным текстом»: длинная каша с высокой энтропией всё ещё заметна.",
      imEmpty: "Пока пусто. Напишите первым — или откройте этот диалог в VK, чтобы подтянуть входящие.",
      imJump: "К последним",
      imPh: "Сообщение",
      imYou: "Вы",
      imManual: "Вручную (шифр)",
      imBackList: "Чаты",
      imSent: "Отправлено в открытый диалог",
      imCopied: "Шифр скопирован. Откройте диалог с этим человеком в VK/MAX — или вставьте сами.",
      imWrong: "Откройте в VK/MAX именно этот диалог. Шифр скопирован, вставлять в чужой чат нельзя.",
      imStandalone: "Здесь нет вкладки VK. Шифр копируется — вставьте его в мессенджер.",
      imNeedBind: "Привяжите этот контакт к диалогу VK/MAX во вкладке «Люди», иначе уйдёт только копия шифра.",
      s1: "Android/ПК: s256.html или расширение Chrome. iPhone: только https:// в Safari.",
      s2: "Создайте хранилище. Ключ/QR киньте другу в MAX или VK.",
      s3: "Сверьте отпечаток голосом.",
      s4: "В расширении пишите в зелёном поле поверх VK. Иначе: сюда текст → в чат только S256M1.",
      s5: "Входящее S256M1 вставьте сюда и расшифруйте.",
      s6: "Расширение Chrome закрывает веб-VK и веб-MAX само.",
      s7: "Метаданные и вложения сервер видит.",
      s8: "Блокируйте хранилище, когда отошли.",
      install: "Сайт в Safari: Поделиться → На экран «Домой». Android: меню браузера → На главный экран.",
      homeHint: "Нужна обычная ссылка https:// — локальный файл на iPhone не закрепить.",
      persistWarn: "Этот просмотр не умеет запомнить ключи. После закрытия хранилище пропадёт — сразу сделайте экспорт.",
      mismatch: "Пароли не совпали",
      window: "Окно",
      noCrypto: "Нет Web Crypto. Откройте в Chrome или в Safari по https://.",
      obStep: "Шаг",
      obOf: "из",
      obT1: "1 · Отправьте свой ключ",
      obL1: "Это не секрет — публичная половина. Отправьте другу в VK/MAX текстом или QR. Пока он не пришлёт свой, сопряжения нет.",
      obSent: "Ключ отправлен — жду ответ друга",
      obSentHint: "Когда друг пришлёт свой ключ в чат, нажмите «Дальше» и вставьте его. На странице VK плашка Pairlock подхватит ключ сама.",
      obSendGo: "Отправить ключ (скопировать)",
      obT2: "2 · Создайте пару",
      obL2: "Вставьте ключ друга (S256K1.… из чата). Нажмите «Сохранить» — вы запишете друг друга. Третий без этого шага не подключится.",
      obPair: "Сохранить",
      obWait: "Ждём ключ друга…",
      obT3: "3 · Сверьте коды",
      obL3: "Позвоните или спросите лично — не в том же чате. Прочитайте коды вслух. Совпали — это он. Не совпали — ключ могли подменить, сопряжение сбросим.",
      obMine: "Ваш код — читаете вы",
      obTheirs: "Его код — читает он",
      obMatch: "Коды совпали",
      obMismatch: "Не совпали",
      obLater: "Проверю позже",
      obNext: "Дальше",
      obBack: "Назад",
      obSkip: "Пропустить мастер",
      obDone: "Коды совпали. Можно писать — лучше через VK/MAX и плашку Pairlock.",
      obMismatchMsg: "Пара сброшена. Кто-то мог подменить ключ. Попросите друга прислать ключ другим каналом.",
      obNeedSend: "Сначала отправьте (или скопируйте) свой ключ другу",
      obWhy: "Зачем пара?",
      obWhyText: "Расшифровать может только тот, с кем у вас пара. Третий без этих ключей не читает. Сервер VK видит шифр, не текст. Ключи остаются на устройстве.",
      verified: "сверен",
      unverified: "не сверен",
      verify: "Сверить коды",
      unverifiedWarn: "Коды с этим контактом ещё не сверили голосом. Если ключ в чате подменили — читать будет чужой. Сверьте в окне чата или во вкладке «Люди».",
      unknownSender: "Внимание: отправитель не в ваших контактах. Это не значит, что текст фальшивый, но кто он — неизвестно.",
      fromUnverified: "Отправитель есть в контактах, но коды не сверены.",
      addFirst: "Откройте диалог в VK/MAX — плашка Pairlock проведёт шаги. Или сохраните человека здесь.",
      startWizard: "Создать пару здесь",
      padEnc: "Зашифровать",
      padDec: "Расшифровать",
      s1To: "1 · Кому",
      s2Text: "2 · Твой текст",
      encGo: "Зашифровать и скопировать",
      s3Paste: "3 · Вставь это в чат VK/MAX и отправь",
      resultEmpty: "Шифр появится здесь",
      d1Paste: "1 · Вставь S256M1.… из чата",
      d2Text: "2 · Расшифрованный текст",
      decEmpty: "Текст появится здесь",
      encDone: "Скопировано. Вставь в чат и отправь.",
      from: "от",
      stNoChat: "Откройте диалог на vk.ru или web.max.ru — тут появится его статус.",
      stEnc: "Шифруется",
      stPlain: "Текст уходит ОТКРЫТЫМ",
      stChat: "Диалог",
      bindTo: "Привязать:",
      unbind: "Отвязать",
      stHint: "Один раз нажмите «Привязать». Дальше пишите в зелёном поле Pairlock — оно закрывает поле VK, чтобы не перепутать.",
      stAuto: "Если друг напишет первым, чат привяжется сам.",
    },
    en: {
      title: "Pairlock",
      tag: "Keys stay on this device. There is no server. The source is open.",
      first: "first run",
      locked: "locked",
      open: "unlocked",
      createTitle: "Create a vault",
      createLead: "The password locks the keys on this computer. Pairlock has no server: if you forget it, nothing can be recovered. The whole client is open (MIT) — read it yourself.",
      howTitle: "First — a pair",
      how1t: "You both add each other",
      how1: "Until someone is in your contacts, their messages will not decrypt. Encryption is for a pair, not “everyone in the chat”.",
      how2t: "A third party cannot join",
      how2: "A stranger does not walk into the thread like a group chat. Without the key on your device, ciphertext stays ciphertext.",
      how3t: "Crypto stays here. Pairlock has no network",
      how3: "Keys never leave. VK only carries ciphertext. The internet is only needed so the messenger can deliver it.",
      how4t: "The source is open",
      how4: "MIT, no black box, no Pairlock server. Protocol, vault and extension live in this folder — read, build, fork.",
      pw: "Password (8+ characters, a passphrase is better)",
      pw2: "Repeat",
      create: "Create keys",
      phoneHint: "iPhone will not run a local HTML file. Use an https:// link in Safari. After Add to Home Screen, offline mode is limited to what the service worker cached.",
      extHint: "On desktop the extension encrypts web VK and web MAX for you.",
      qrHint: "Three steps: send this key to your friend (it is not a secret) → they send theirs → check fingerprints by voice, not in that same chat.",
      unlockTitle: "Unlock",
      unlockLead: "While locked, VK/MAX messages go out in the clear. Enter the password to encrypt again.",
      unlock: "Unlock",
      tabPad: "Chat",
      tabKeys: "Keys",
      tabPeople: "People",
      tabHelp: "Help",
      plain: "Plaintext — never paste this into VK/MAX",
      to: "To",
      needContact: "Add a person first",
      enc: "Encrypt",
      cipher: "Ciphertext — this is what the server sees",
      dec: "Decrypt",
      copy: "Copy",
      share: "Share",
      pub: "Public key",
      fp: "Fingerprint",
      copyKey: "Key text for MAX/VK",
      shareKey: "Share text",
      saveQr: "QR image into chat",
      qrShareCaption: "My Pairlock public key. Not a secret — send it in MAX/VK. We’ll match fingerprints by voice.",
      export: "Export vault",
      import: "Import",
      backup: "Backup blob",
      backupPw: "Password for this backup",
      lock: "Lock",
      name: "Name",
      theirKey: "Their public key",
      add: "Save",
      nobody: "Nobody yet",
      peopleHint: "Open a 1-to-1 chat in VK or MAX. The Pairlock bar at the bottom walks you through: your key → theirs → make a pair.",
      peopleAddManual: "Add manually",
      peopleHideManual: "Hide form",
      peopleNoChat: "chat not linked",
      peopleCodesOk: "codes checked",
      peopleCodesNo: "check codes by voice",
      del: "Remove",
      delConfirmT: "Remove this person?",
      delConfirmL: "Keys with “{name}” are wiped in Pairlock only. The VK/MAX thread stays, but you will not decrypt ciphertext. To write privately again, make a new pair.",
      delYes: "Yes, remove",
      rename: "Rename",
      thisChat: "Link this chat",
      nextChat: "Link next chat",
      copied: "Copied",
      created: "Vault is ready. Next — open VK or MAX.",
      goSiteT: "Next — open the chat",
      goSiteL: "The vault is ready. Pairing is not here: open a dialog and use the Pairlock bar at the bottom. Press the blue button — it tells you what to do.",
      goSite1t: "Open VK or MAX",
      goSite1: "In the browser: vk.ru or web.max.ru → Chats.",
      goSite2t: "Open a dialog with your friend",
      goSite2: "The bar: step 1 send your key, step 2 wait for theirs, step 3 Make a pair.",
      goSite3t: "Check codes by voice, then type",
      goSite3: "Type in the green Pairlock field. Only ciphertext reaches the server.",
      goVk: "Open VK",
      goMax: "Open MAX",
      goOk: "Got it",
      goPairHere: "Make a pair here",
      addFirst: "Open a dialog in VK/MAX — the Pairlock bar will walk you through. Or save a person here.",
      startWizard: "Make a pair here",
      verifyInChat: "Check codes",
      verifyHide: "Back to messages",
      obDone: "Codes match. You can write — best via VK/MAX and the Pairlock bar.",
      added: "Person saved. Check the codes by voice — not in the same chat you used to exchange keys.",
      helpLead: "Pairlock encrypts the text on your device. MAX and VK only carry the finished ciphertext: they cannot see or open the content.",
      helpCrypto: "Built on cryptography: X25519, AES-256-GCM, HKDF-SHA256. Every message gets a fresh one-time key. There is no Pairlock server — it is computed on your device.",
      schemeKeysT: "Everyone has two keys",
      schemeSecret: "Secret",
      schemeSecretH: "never sent — stays on your device",
      schemePublic: "Public",
      schemePublicH: "this is what you send in the chat",
      schemeWhyPub: "The public key is like a mailbox number. It cannot read your messages. Only the secret can decrypt, and it never leaves the device. So sending the public key in MAX is normal — that is how pairing works.",
      schemeExT: "How a pair is made",
      schemeExLead: "A pair is not “joined the chat”. It is both of you saving each other. One public key sitting in the thread does not decrypt anything yet.",
      schemeYou: "You",
      schemeFriend: "Friend",
      schemePipe: "MAX",
      schemeKeyWire: "public key",
      schemeThen: "Both tap Make a pair — done. After that you encrypt only to them, not to “everyone in the chat”.",
      schemeThirdT: "Why a third person cannot join",
      schemeThird: "In ordinary VK anyone can enter a chat and read. Here the text is encrypted for one specific person. Someone sitting in the same dialog only sees the same ciphertext and cannot open it: they have neither secret key of the pair.",
      schemeThirdNeed: "For a third person to read, adding them to the chat is not enough. You must mutually make a pair: you save their key, they save yours. Without that step on both sides you do not encrypt to them, and they cannot decrypt someone else’s ciphertext. They cannot walk into the pair on their own.",
      schemeThirdPair: "You and friend — a pair",
      schemeThirdOut: "A third with no pair — only ciphertext",
      schemeMsgT: "What goes into the messenger",
      schemeMsgLead: "You type ordinary text in the green Pairlock field. What reaches your friend’s device is already ciphertext. MAX delivers it and cannot decrypt it.",
      schemePlain: "content",
      schemeLock: "encryption",
      schemeNoise: "ciphertext",
      schemeOnlyPair: "only the pair can read",
      schemeServer: "The server, logs, and anyone tapping the channel all see ciphertext — not your text.",
      helpDoT: "What to do",
      helpStep1t: "Send your public key",
      helpStep1: "The button on the bar. It is not a password and not the vault secret — it is meant to be sent in that same chat.",
      helpStep2t: "Make a pair when their key arrives",
      helpStep2: "The bar will offer it. If they chose a lifetime (15 minutes, etc.), you accept it there — no need to open settings.",
      helpStep3t: "Check codes by voice",
      helpStep3: "A short call or in person. If you only check in the same chat, a swapped key can go unnoticed.",
      helpMore: "A bit more",
      faqVoiceT: "Why call if the key is already in the chat?",
      faqVoice: "That same chat can theoretically be swapped: you would save someone else’s key and encrypt to the wrong person. Matching codes by voice means the key is real. Mismatch — stop writing and exchange again.",
      faqLocalT: "Does Pairlock go somewhere online?",
      faqLocal: "No. There is no Pairlock server, account, or cloud. Keys are never uploaded. The internet is only for the messenger to carry ciphertext to your friend.",
      faqNoT: "What is not encrypted?",
      faqNo: "Photos, files, voice notes — the site’s paperclip goes as-is. Who talks to whom and when is visible to the server. If the device is unlocked and the vault is open, the screen shows ordinary text.",
      faqOssT: "Can I check there is no trick?",
      faqOss: "Yes. The code is open (MIT), the crypto is standard (X25519, AES-256-GCM). There is no Pairlock server, so there is nowhere to hide a backdoor. Protocol and vault live in this folder.",
      ttlTitle: "Key lifetime",
      ttlHelp: "Lifetime applies to the next pair only. When it ends that chat’s session is wiped — not the whole vault.",
      ttlForever: "Forever — as before",
      ttl15: "15 minutes",
      ttl30: "30 minutes",
      ttl1h: "1 hour",
      ttl1d: "1 day",
      ttl1w: "1 week",
      ttlOn: "timed keys",
      ttlDead: "expired",
      burnTitle: "Burn the vault",
      burnHelp: "Rare: wipe the entire vault on this device. Not the same as a per-contact lifetime.",
      burnOff: "Off — keys live until you wipe them",
      burn1h: "In 1 hour — full wipe",
      burn1d: "In 24 hours — full wipe",
      burnLeft: "Burn in",
      burnConfirm: "Enable vault burn? After the delay, private keys and history on THIS device are erased with no recovery.",
      burnDone: "Vault burned. Create a new one.",
      pairModeTitle: "Next pair lifetime",
      pairSafe: "Auto-burn keys",
      pairSafeHint: "For this pair only: when time is up the session and chat history are wiped. Other contacts stay.",
      pairSafeWarn: "Pick a lifetime before exchanging keys. Both sides must match. Only that chat is wiped — not the whole vault. Screenshots before the deadline are still a risk.",
      pairOfferHint: "Applies to your QR and new pairs. Existing contacts keep their own lifetime.",
      burnChatTitle: "Disappearing thread",
      burnChatHint: "The pair gets its own session key. After you read a message it lives 30s / 1m / 2m — then Pairlock cannot open it again. The chat can run for days; only the phrases burn. A screenshot before the timer is still a risk.",
      burnChatOff: "Off",
      burnChat30: "30s",
      burnChat60: "1 min",
      burnChat120: "2 min",
      burnChatOn: "burns",
      pairForever: "Forever",
      pairForeverHint: "Keys with this person live until you wipe them.",
      pairBurnLeft: "Whole vault burns in",
      pairPickTtl: "Lifetime",
      pairTtl15: "15 min",
      pairTtl1h: "1 hour",
      pairTtl1d: "1 day",
      pairTtl1w: "1 week",
      pairExportOff: "Export unavailable while whole-vault burn is running",
      pairLocked: "Whole-vault burn in progress",
      pairNeedsRekey: "To change a contact’s lifetime, re-exchange keys with the new lifetime.",
      pairSafeConfirm: "unused",
      pairSafeConfirmEmpty: "unused",
      keysMore: "More",
      keysIdentity: "Your key",
      copyKeyShort: "Copy",
      rotate: "Issue a new key",
      rotateT1: "This cannot be undone",
      rotateL1: "You will get a new long-term key and fingerprint. The old secret on this device will be wiped.",
      rotateW1a: "Every current contact will be deleted — you will have to add them again.",
      rotateW1b: "Old S256M1 messages will not decrypt with the new key — not theirs, not your local copies.",
      rotateW1c: "Friends will keep writing to the old key until you send them the new one.",
      rotateNext: "I understand, continue",
      rotateT2: "Once more, in plain words",
      rotateL2: "This is not the 15-minute / 1-day lifetime. That only rotates a session. This replaces the identity itself — like starting Pairlock from scratch, with the same vault password.",
      rotateW2a: "Any backup you exported earlier holds the OLD key. Importing it would roll you back.",
      rotateW2b: "Anyone who saved your old S256K1 no longer has your current key. Tell them you rotated.",
      rotateTypeLabel: "Type this word exactly to continue:",
      rotatePhrase: "RESET",
      rotateT3: "Confirm with your password",
      rotateL3: "Last step. The vault password does not change — we check that it is you.",
      rotateGo: "Wipe the old key and issue a new one",
      rotateDone: "New key is ready. Send it to your friends and verify fingerprints again.",
      rotateNeedPhrase: "Type the word exactly as shown",
      cancel: "Cancel",
      faqDomT: "Why not in VK bubbles?",
      faqDom: "The VK page is their code. By default you read in Pairlock Chat so site scripts never see the content.",
      pageDecrypt: "Show decrypted bubbles on VK/MAX",
      pageDecryptHelp: "Off by default: the page keeps ciphertext; you read in Chat. If you turn this on, plaintext is written into the VK/MAX page. Their scripts may see it — there is a real chance the phrase is captured. The server still gets only ciphertext; the device key is not recovered that way. There is no guarantee that “nobody on the site read this.”",
      stealthWire: "Stealth wire (no S256M1. tag)",
      stealthWireHelp: "Chat gets a random-looking string without a fixed S256M1. brand. Old S256M1. messages still decrypt. This hides the brand, not the fact that it is high-entropy ciphertext.",
      imEmpty: "Nothing yet. Write first — or open this dialog in VK so incoming messages can be pulled in.",
      imJump: "Latest",
      imPh: "Message",
      imYou: "You",
      imManual: "Manual (ciphertext)",
      imBackList: "Chats",
      imSent: "Sent in the open dialog",
      imCopied: "Ciphertext copied. Open this person’s dialog in VK/MAX — or paste it yourself.",
      imWrong: "Open this exact dialog in VK/MAX. Ciphertext is copied; do not paste it into someone else’s chat.",
      imStandalone: "No VK tab here. Ciphertext is copied — paste it into the messenger.",
      imNeedBind: "Bind this contact to a VK/MAX dialog in People, or only a ciphertext copy is made.",
      s1: "Android/desktop: s256.html or the Chrome extension. iPhone: https:// in Safari only.",
      s2: "Create a vault. Send the key/QR in MAX or VK.",
      s3: "Verify the fingerprint by voice.",
      s4: "In the extension, type in the green field over VK. Otherwise: encrypt here; only S256M1 goes into the chat.",
      s5: "Paste incoming S256M1 here and decrypt.",
      s6: "The Chrome extension covers web VK and web MAX.",
      s7: "Metadata and attachments stay visible to the server.",
      s8: "Lock the vault when you step away.",
      install: "In Safari over https://: Share → Add to Home Screen. Android: browser menu → Add to Home screen.",
      homeHint: "You need a normal https:// URL — a local file cannot be pinned on iPhone.",
      persistWarn: "This view cannot remember keys. The vault vanishes when you close it — export now.",
      mismatch: "Passwords do not match",
      window: "Window",
      noCrypto: "No Web Crypto. Open in Chrome, or in Safari over https://.",
      obStep: "Step",
      obOf: "of",
      obT1: "1 · Send your key",
      obL1: "Not a secret — the public half. Send it to your friend in VK/MAX as text or QR. Until they send theirs, there is no pair.",
      obSent: "Key sent — waiting for their reply",
      obSentHint: "When your friend sends their key in the chat, tap Next and paste it. On the VK page the Pairlock bar can catch it automatically.",
      obSendGo: "Send key (copy)",
      obT2: "2 · Make a pair",
      obL2: "Paste their key (S256K1.… from the chat). Tap Save — you record each other. A third party cannot join without this step.",
      obPair: "Save",
      obWait: "Waiting for their key…",
      obT3: "3 · Check the codes",
      obL3: "Call or ask in person — not in that same chat. Read the codes aloud. Match = it is them. Mismatch = the key may have been swapped; we will reset the pair.",
      obMine: "Your code — you read this",
      obTheirs: "Their code — they read this",
      obMatch: "Codes match",
      obMismatch: "Do not match",
      obLater: "Verify later",
      obNext: "Next",
      obBack: "Back",
      obSkip: "Skip the wizard",
      obDone: "Codes match. You can write — best via VK/MAX and the Pairlock bar.",
      obMismatchMsg: "Pairing reset. Someone may have swapped the key. Ask your friend to resend through another channel.",
      obNeedSend: "Send (or copy) your key to your friend first",
      obWhy: "Why pair?",
      obWhyText: "Only someone you paired with can decrypt. A third party without those keys cannot read. The VK server sees ciphertext, not text. Keys stay on the device.",
      verified: "verified",
      unverified: "unverified",
      verify: "Check codes",
      unverifiedWarn: "Codes with this contact were not verified by voice. If the key was swapped in the chat, a stranger will read this. Check in the Chat window or the People tab.",
      unknownSender: "Warning: the sender is not in your contacts. The text is authentic for that key, but who owns it is unknown.",
      fromUnverified: "Sender is in your contacts, but codes were not verified.",
      addFirst: "Open a dialog in VK/MAX — the Pairlock bar will walk you through. Or save a person here.",
      startWizard: "Make a pair here",
      padEnc: "Encrypt",
      padDec: "Decrypt",
      s1To: "1 · To",
      s2Text: "2 · Your text",
      encGo: "Encrypt and copy",
      s3Paste: "3 · Paste this into the VK/MAX chat and send",
      resultEmpty: "Ciphertext will appear here",
      d1Paste: "1 · Paste S256M1.… from the chat",
      d2Text: "2 · Decrypted text",
      decEmpty: "Text will appear here",
      encDone: "Copied. Paste into the chat and send.",
      from: "from",
      stNoChat: "Open a dialog on vk.ru or web.max.ru — its status will show here.",
      stEnc: "Encrypted",
      stPlain: "Text goes out in PLAINTEXT",
      stChat: "Dialog",
      bindTo: "Bind to:",
      unbind: "Unbind",
      stHint: "Bind the chat once. Then type in the green Pairlock field — it covers VK’s box so you don’t mix them up.",
      stAuto: "If your friend writes first, the chat binds itself.",
    },
  };

  function t(k) {
    return (I18N[lang] && I18N[lang][k]) || I18N.ru[k] || k;
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function initials(name) {
    const s = String(name || "?").trim();
    const parts = s.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0].charAt(0) + parts[1].charAt(0)).toUpperCase();
    return s.slice(0, 2).toUpperCase() || "?";
  }

  function fmtChatTime(ts) {
    if (!ts) return "";
    const d = new Date(ts);
    const now = new Date();
    const loc = lang === "en" ? "en-GB" : "ru-RU";
    if (d.toDateString() === now.toDateString()) {
      return d.toLocaleTimeString(loc, { hour: "2-digit", minute: "2-digit" });
    }
    return d.toLocaleDateString(loc, { day: "numeric", month: "short" });
  }

  function fmtBurnLeft(burnAt) {
    const ms = Math.max(0, burnAt - Date.now());
    const sec = Math.floor(ms / 1000);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (h >= 24) {
      const d = Math.floor(h / 24);
      return d + (lang === "en" ? "d " : "д ") + (h % 24) + (lang === "en" ? "h" : "ч");
    }
    if (h > 0) return h + (lang === "en" ? "h " : "ч ") + m + (lang === "en" ? "m" : "м");
    return m + (lang === "en" ? "m" : "м");
  }

  function previewText(s) {
    const v = String(s || "").replace(/\s+/g, " ").trim();
    return v.length > 72 ? v.slice(0, 71) + "…" : v;
  }

  function msgsNearBottom(el) {
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 72;
  }

  function resolveChatId() {
    if (showPad) return null;
    if (typeof chatId === "string" && chatId) return chatId;
    if (chatId === null) return null;
    if (isPopup && currentPeer) {
      try {
        const b = V().findByBinding(currentPeer.platform, currentPeer.peer);
        if (b) return b.id;
      } catch (_) {
        /* ignore */
      }
    }
    return null;
  }

  const TAB_URLS = [
    "https://vk.ru/*",
    "https://*.vk.ru/*",
    "https://vk.com/*",
    "https://*.vk.com/*",
    "https://vk.me/*",
    "https://*.vk.me/*",
    "https://web.max.ru/*",
    "https://*.max.ru/*",
  ];

  async function deliverCipher(packetOrPackets, bindings) {
    const packets = Array.isArray(packetOrPackets)
      ? packetOrPackets.filter(Boolean)
      : packetOrPackets
        ? [packetOrPackets]
        : [];
    if (!packets.length) return "copy";
    if (!isExt || !chrome.tabs) {
      try {
        await navigator.clipboard.writeText(packets.join("\n\n"));
      } catch (_) {
        /* ignore */
      }
      return "copy";
    }
    let delivered = false;
    let wrong = false;
    try {
      const tabs = await chrome.tabs.query({ url: TAB_URLS });
      for (let i = 0; i < tabs.length; i++) {
        try {
          for (let p = 0; p < packets.length; p++) {
            const r = await chrome.tabs.sendMessage(tabs[i].id, {
              type: "S256_INJECT",
              text: packets[p],
              bindings: bindings || {},
            });
            if (r && r.ok) delivered = true;
            else if (r && r.wrongChat) wrong = true;
            if (p + 1 < packets.length) await new Promise((r) => setTimeout(r, 450));
          }
        } catch (_) {
          /* frame without content script */
        }
      }
    } catch (_) {
      /* query failed */
    }
    if (delivered) return "sent";
    try {
      await navigator.clipboard.writeText(packets.join("\n\n"));
    } catch (_) {
      /* ignore */
    }
    return wrong ? "wrong" : "copy";
  }

  function setNotice(text, type) {
    notice = text;
    noticeType = type || "ok";
  }

  /* Extension: vault lives in the service worker. Popup/page only mirrors session. */
  async function vaultCreate(password) {
    if (isExt && chrome.runtime && chrome.runtime.id) {
      const r = await chrome.runtime.sendMessage({ type: "S256_CREATE", password });
      if (!r || !r.ok) throw new Error((r && r.error) || "не удалось создать");
      await V().restoreSession();
      return;
    }
    await V().create(password);
  }

  async function vaultUnlock(password) {
    if (isExt && chrome.runtime && chrome.runtime.id) {
      const r = await chrome.runtime.sendMessage({ type: "S256_UNLOCK", password });
      if (!r || !r.ok) throw new Error((r && r.error) || "Неверный пароль");
      await V().restoreSession();
      return;
    }
    await V().unlock(password);
  }

  async function vaultLock() {
    if (isExt && chrome.runtime && chrome.runtime.id) {
      try {
        await chrome.runtime.sendMessage({ type: "S256_LOCK" });
      } catch (_) {
        /* ignore */
      }
    }
    await V().lock();
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    setNotice(t("copied"), "ok");
    await render();
  }

  async function share(text, title) {
    if (navigator.share) {
      try {
        await navigator.share({ title: title || "Pairlock", text });
        return;
      } catch (e) {
        if (e && e.name === "AbortError") return;
      }
    }
    await copy(text);
  }

  function downloadText(name, text) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function drawQr(id, text) {
    const el = document.getElementById(id);
    if (!el || typeof qrcode !== "function") return;
    try {
      const q = qrcode(0, "M");
      q.addData(text, "Byte");
      q.make();
      el.innerHTML = q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
    } catch {
      el.innerHTML = "";
    }
  }

  async function qrPngBlob() {
    const svg = document.querySelector("#qr svg");
    if (!svg) return null;
    const xml = new XMLSerializer().serializeToString(svg);
    const url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(xml);
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 640;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, 640, 640);
    ctx.drawImage(img, 0, 0, 640, 640);
    return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  }

  async function shareQrPng() {
    const blob = await qrPngBlob();
    if (!blob) throw new Error("QR");
    const file = new File([blob], "s256-qr.png", { type: "image/png" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: "Pairlock", text: t("qrShareCaption") });
        return;
      } catch (e) {
        if (e && e.name === "AbortError") return;
      }
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "s256-qr.png";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1500);
  }

  function header(extra) {
    return `
      <div class="top">
        <div class="brand">
          <div class="logo" aria-hidden="true"></div>
          <div>
            <h1>${esc(t("title"))}</h1>
            <p>${esc(t("tag"))}</p>
          </div>
        </div>
        <div class="top-actions">
          <button class="lang" id="lang">${lang === "ru" ? "EN" : "RU"}</button>
          ${extra || ""}
        </div>
      </div>`;
  }

  function bindLang() {
    const b = document.getElementById("lang");
    if (!b) return;
    b.onclick = () => {
      lang = lang === "ru" ? "en" : "ru";
      lsSet("s256.lang", lang);
      render();
    };
  }

  function standaloneHint() {
    const standalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone;
    if (standalone || isPopup || viaShortcut) return "";
    return `<p class="install">${esc(t("install"))}</p>`;
  }

  function persistBanner() {
    try {
      if (V().persistMode && V().persistMode() === "memory") {
        return `<p class="err">${esc(t("persistWarn"))}</p>`;
      }
    } catch (_) {
      /* ignore */
    }
    return "";
  }

  function phoneBanner() {
    if (isExt) return persistBanner();
    const ios = /iPhone|iPad|iPod/i.test(navigator.userAgent || "");
    if (ios || viaShortcut) return persistBanner() + `<p class="note">${esc(t("phoneHint"))}</p>`;
    return persistBanner();
  }

  async function viewLocked() {
    const exists = await V().hasVault();
    if (!exists) {
      app.innerHTML = `
        ${header(`<span class="pill">${esc(t("first"))}</span>`)}
        <div class="card">
          <h2>${esc(t("createTitle"))}</h2>
          <p class="lead">${esc(t("createLead"))}</p>
          ${howItWorksHtml()}
          <label>${esc(t("pw"))}</label>
          <input id="pw1" type="password" autocomplete="new-password" />
          <label>${esc(t("pw2"))}</label>
          <input id="pw2" type="password" autocomplete="new-password" />
          <div class="row">
            <button class="btn" id="create">${esc(t("create"))}</button>
          </div>
          ${phoneBanner()}
          ${isExt ? `<p class="note">${esc(t("extHint"))}</p>` : ""}
          ${standaloneHint()}
          <div class="${noticeType}">${esc(notice)}</div>
        </div>`;
      bindLang();
      document.getElementById("create").onclick = async () => {
        const a = document.getElementById("pw1").value;
        const b = document.getElementById("pw2").value;
        if (a !== b) {
          setNotice(t("mismatch"), "err");
          return viewLocked();
        }
        try {
          await vaultCreate(a);
          setNotice(t("created"), "ok");
          /* after keys: guide to VK/MAX overlay — not the in-popup wizard */
          tab = "pad";
          obStep = 1;
          obContactId = null;
          obKeySent = false;
          wizardForced = false;
          chatVerify = false;
          await render();
        } catch (e) {
          setNotice(e.message, "err");
          await viewLocked();
        }
      };
      return;
    }

    app.innerHTML = `
      ${header(`<span class="pill">${esc(t("locked"))}</span>`)}
      <div class="card">
        <h2>${esc(t("unlockTitle"))}</h2>
        <p class="lead">${esc(t("unlockLead"))}</p>
        <label>${esc(t("pw"))}</label>
        <input id="pw" type="password" autocomplete="current-password" />
        <div class="row">
          <button class="btn" id="unlock">${esc(t("unlock"))}</button>
        </div>
        <div class="${noticeType}">${esc(notice)}</div>
      </div>`;
    bindLang();
    document.getElementById("pw").focus();
    document.getElementById("unlock").onclick = async () => {
      try {
        await vaultUnlock(document.getElementById("pw").value);
        setNotice("", "ok");
        await render();
      } catch (e) {
        setNotice(e.message, "err");
        await viewLocked();
      }
    };
    document.getElementById("pw").addEventListener("keydown", (e) => {
      if (e.key === "Enter") document.getElementById("unlock").click();
    });
  }

  function tabsHtml() {
    const icons = {
      pad: '<svg viewBox="0 0 24 24"><path d="M4 4h16v12H7l-3 3V4z"/></svg>',
      keys: '<svg viewBox="0 0 24 24"><path d="M3 11v2h2v8h2v-8h2v8h2v-8h2v-2H3zm4-8h8v2H7V3zm-2 4h12v2H5V7z"/></svg>',
      people: '<svg viewBox="0 0 24 24"><path d="M12 12a4 4 0 100-8 4 4 0 000 8zm0 2c-4 0-8 2-8 4v2h16v-2c0-2-4-4-8-4z"/></svg>',
      help: '<svg viewBox="0 0 24 24"><path d="M11 18h2v-2h-2v2zm1-16C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>',
    };
    const items = [
      ["pad", t("tabPad")],
      ["keys", t("tabKeys")],
      ["people", t("tabPeople")],
      ["help", t("tabHelp")],
    ];
    return `<nav class="tabs">${items
      .map(([id, name]) => `<button class="tab ${tab === id ? "active" : ""}" data-tab="${id}">${icons[id]}<span>${esc(name)}</span></button>`)
      .join("")}</nav>`;
  }

  function stepsHtml(cur, total) {
    let dots = "";
    for (let i = 1; i <= total; i++) dots += `<span class="dot ${i === cur ? "on" : i < cur ? "done" : ""}"></span>`;
    return `<div class="steps-bar"><span class="steps-label">${esc(t("obStep"))} ${cur} ${esc(t("obOf"))} ${total}</span><span class="dots">${dots}</span></div>`;
  }

  function fpBlock(label, fp) {
    return `<div class="fp-card"><div class="fp-label">${esc(label)}</div><div class="fp">${esc(fp)}</div></div>`;
  }

  function verifyCardHtml(contact, myFp, opts) {
    const o = opts || {};
    return `
      <div class="wizard">
        ${o.steps || ""}
        <h2>${esc(t("obT3"))}</h2>
        <p class="lead">${esc(t("obL3"))}</p>
        ${fpBlock(t("obMine"), myFp)}
        ${fpBlock(t("obTheirs") + " · " + contact.name, contact.fingerprint)}
        <div class="row">
          <button class="btn" id="vf-match">${esc(t("obMatch"))}</button>
          <button class="btn danger" id="vf-mismatch">${esc(t("obMismatch"))}</button>
          <button class="btn ghost" id="vf-later">${esc(t("obLater"))}</button>
        </div>
      </div>`;
  }

  function helpPageHtml() {
    return `
      <div class="help-page">
        <p class="help-lead">${esc(t("helpLead"))}</p>
        <p class="help-crypto">${esc(t("helpCrypto"))}</p>

        <section class="scheme" aria-label="${esc(t("schemeKeysT"))}">
          <h3 class="scheme-cap">${esc(t("schemeKeysT"))}</h3>
          <div class="scheme-keys">
            <div class="sk sk-sec">
              <span class="sk-name">${esc(t("schemeSecret"))}</span>
              <span class="sk-hint">${esc(t("schemeSecretH"))}</span>
            </div>
            <div class="sk-join" aria-hidden="true">+</div>
            <div class="sk sk-pub">
              <span class="sk-name">${esc(t("schemePublic"))}</span>
              <span class="sk-hint">${esc(t("schemePublicH"))}</span>
            </div>
          </div>
          <p class="scheme-note">${esc(t("schemeWhyPub"))}</p>
        </section>

        <section class="scheme" aria-label="${esc(t("schemeExT"))}">
          <h3 class="scheme-cap">${esc(t("schemeExT"))}</h3>
          <p class="scheme-note scheme-lead">${esc(t("schemeExLead"))}</p>
          <div class="scheme-flow">
            <div class="sf-line">
              <span class="sf-who">${esc(t("schemeYou"))}</span>
              <span class="sf-wire">${esc(t("schemeKeyWire"))}</span>
              <span class="sf-pipe">${esc(t("schemePipe"))}</span>
              <span class="sf-arrow" aria-hidden="true">→</span>
              <span class="sf-who">${esc(t("schemeFriend"))}</span>
            </div>
            <div class="sf-line sf-back">
              <span class="sf-who">${esc(t("schemeFriend"))}</span>
              <span class="sf-wire">${esc(t("schemeKeyWire"))}</span>
              <span class="sf-pipe">${esc(t("schemePipe"))}</span>
              <span class="sf-arrow" aria-hidden="true">→</span>
              <span class="sf-who">${esc(t("schemeYou"))}</span>
            </div>
          </div>
          <p class="scheme-note scheme-ok">${esc(t("schemeThen"))}</p>
        </section>

        <section class="scheme scheme-third" aria-label="${esc(t("schemeThirdT"))}">
          <h3 class="scheme-cap">${esc(t("schemeThirdT"))}</h3>
          <div class="third-row">
            <div class="third-box on">${esc(t("schemeThirdPair"))}</div>
            <div class="third-box off">${esc(t("schemeThirdOut"))}</div>
          </div>
          <p class="scheme-note">${esc(t("schemeThird"))}</p>
          <p class="scheme-note">${esc(t("schemeThirdNeed"))}</p>
        </section>

        <section class="scheme" aria-label="${esc(t("schemeMsgT"))}">
          <h3 class="scheme-cap">${esc(t("schemeMsgT"))}</h3>
          <p class="scheme-note scheme-lead">${esc(t("schemeMsgLead"))}</p>
          <div class="scheme-msg">
            <span class="sm-plain">${esc(t("schemePlain"))}</span>
            <span class="sm-arr" aria-hidden="true">→</span>
            <span class="sm-lock">${esc(t("schemeLock"))}</span>
            <span class="sm-arr" aria-hidden="true">→</span>
            <span class="sm-noise">${esc(t("schemeNoise"))}</span>
            <span class="sm-arr" aria-hidden="true">→</span>
            <span class="sm-pipe">${esc(t("schemePipe"))}</span>
            <span class="sm-arr" aria-hidden="true">→</span>
            <span class="sm-ok">${esc(t("schemeOnlyPair"))}</span>
          </div>
          <p class="scheme-note">${esc(t("schemeServer"))}</p>
        </section>

        <section class="scheme">
          <h3 class="scheme-cap">${esc(t("helpDoT"))}</h3>
          <ol class="help-steps">
            <li><b>${esc(t("helpStep1t"))}</b> ${esc(t("helpStep1"))}</li>
            <li><b>${esc(t("helpStep2t"))}</b> ${esc(t("helpStep2"))}</li>
            <li><b>${esc(t("helpStep3t"))}</b> ${esc(t("helpStep3"))}</li>
          </ol>
        </section>

        <details class="help-more">
          <summary>${esc(t("helpMore"))}</summary>
          <div class="help-qa"><b>${esc(t("faqVoiceT"))}</b><p>${esc(t("faqVoice"))}</p></div>
          <div class="help-qa"><b>${esc(t("faqLocalT"))}</b><p>${esc(t("faqLocal"))}</p></div>
          <div class="help-qa"><b>${esc(t("faqNoT"))}</b><p>${esc(t("faqNo"))}</p></div>
          <div class="help-qa"><b>${esc(t("faqDomT"))}</b><p>${esc(t("faqDom"))}</p></div>
          <div class="help-qa"><b>${esc(t("faqOssT"))}</b><p>${esc(t("faqOss"))}</p></div>
        </details>
      </div>`;
  }

  function howItWorksHtml() {
    return `
      <div class="how">
        <div class="how-title">${esc(t("howTitle"))}</div>
        <div class="how-item"><span class="how-n">1</span><div><b>${esc(t("how1t"))}</b><p>${esc(t("how1"))}</p></div></div>
        <div class="how-item"><span class="how-n">2</span><div><b>${esc(t("how2t"))}</b><p>${esc(t("how2"))}</p></div></div>
        <div class="how-item"><span class="how-n">3</span><div><b>${esc(t("how3t"))}</b><p>${esc(t("how3"))}</p></div></div>
        <div class="how-item"><span class="how-n">4</span><div><b>${esc(t("how4t"))}</b><p>${esc(t("how4"))}</p></div></div>
      </div>`;
  }

  function goSiteHtml() {
    return `
      <div class="wizard">
        <h2>${esc(t("goSiteT"))}</h2>
        <p class="lead">${esc(t("goSiteL"))}</p>
        <div class="how">
          <div class="how-item"><span class="how-n">1</span><div><b>${esc(t("goSite1t"))}</b><p>${esc(t("goSite1"))}</p></div></div>
          <div class="how-item"><span class="how-n">2</span><div><b>${esc(t("goSite2t"))}</b><p>${esc(t("goSite2"))}</p></div></div>
          <div class="how-item"><span class="how-n">3</span><div><b>${esc(t("goSite3t"))}</b><p>${esc(t("goSite3"))}</p></div></div>
        </div>
        <div class="row" style="flex-wrap:wrap">
          <a class="btn" href="https://vk.ru/im" target="_blank" rel="noopener noreferrer">${esc(t("goVk"))}</a>
          <a class="btn secondary" href="https://web.max.ru" target="_blank" rel="noopener noreferrer">${esc(t("goMax"))}</a>
        </div>
        <div class="row wizard-nav">
          <button type="button" class="btn" id="go-ok">${esc(t("goOk"))}</button>
          <button type="button" class="btn ghost" id="go-pair-here">${esc(t("goPairHere"))}</button>
        </div>
      </div>`;
  }

  function onboardingHtml(state, fp, pub) {
    const total = 3;
    if (obStep === 1) {
      return `
        <div class="wizard">
          ${stepsHtml(1, total)}
          <h2>${esc(t("obT1"))}</h2>
          <p class="lead">${esc(t("obL1"))}</p>
          <div class="key-card">
            <div class="qr" id="qr"></div>
            <div class="keybox" id="pub">${esc(pub)}</div>
            <div class="row" style="justify-content:center">
              <button class="btn" id="ob-send">${esc(t("obSendGo"))}</button>
              <button class="btn secondary" id="save-qr">${esc(t("saveQr"))}</button>
              <button class="btn ghost" id="share-pub">${esc(t("shareKey"))}</button>
            </div>
          </div>
          ${obKeySent ? `<div class="wait-box"><b>${esc(t("obSent"))}</b><p>${esc(t("obSentHint"))}</p></div>` : ""}
          <div class="row wizard-nav">
            <button class="btn" id="ob-next"${obKeySent ? "" : " disabled"}>${esc(t("obNext"))}</button>
            <button class="btn ghost" id="ob-skip">${esc(t("obSkip"))}</button>
          </div>
        </div>`;
    }
    if (obStep === 2) {
      return `
        <div class="wizard">
          ${stepsHtml(2, total)}
          <h2>${esc(t("obT2"))}</h2>
          <p class="lead">${esc(t("obL2"))}</p>
          <div class="wait-box"><b>${esc(t("obWait"))}</b><p>${esc(t("obSentHint"))}</p></div>
          <label>${esc(t("name"))}</label>
          <input id="cname" type="text" placeholder="Саша" />
          <label>${esc(t("theirKey"))}</label>
          <textarea id="ckey" placeholder="S256K1.…"></textarea>
          <div class="row wizard-nav">
            <button class="btn" id="ob-add">${esc(t("obPair"))}</button>
            <button class="btn ghost" id="ob-back">${esc(t("obBack"))}</button>
          </div>
        </div>`;
    }
    const contact = state.contacts.find((c) => c.id === obContactId) || state.contacts[state.contacts.length - 1];
    if (!contact) {
      obStep = 2;
      return onboardingHtml(state, fp, pub);
    }
    return verifyCardHtml(contact, fp, { steps: stepsHtml(3, total) });
  }

  async function finishOnboarding() {
    try {
      await V().setSetting("onboarded", true);
    } catch (_) {
      /* read-only session */
    }
    wizardForced = false;
    obStep = 1;
    obContactId = null;
    obKeySent = false;
    tab = "pad";
  }

  function bindVerifyButtons(contactId, after) {
    const match = document.getElementById("vf-match");
    const mismatch = document.getElementById("vf-mismatch");
    const later = document.getElementById("vf-later");
    if (match)
      match.onclick = async () => {
        try {
          await V().setVerified(contactId, true);
          setNotice(t("obDone"), "ok");
        } catch (e) {
          setNotice(e.message, "err");
        }
        await after("match");
      };
    if (mismatch)
      mismatch.onclick = async () => {
        try {
          await V().removeContact(contactId);
        } catch (_) {
          /* ignore */
        }
        setNotice(t("obMismatchMsg"), "err");
        await after("mismatch");
      };
    if (later)
      later.onclick = async () => {
        setNotice(t("unverifiedWarn"), "warn");
        await after("later");
      };
  }

  function markKeySent() {
    obKeySent = true;
    render();
  }

  function bindOnboarding(pub, fp) {
    const sendBtn = document.getElementById("ob-send");
    if (sendBtn)
      sendBtn.onclick = async () => {
        try {
          await copy(pub);
          setNotice(t("copied"), "ok");
        } catch (_) {
          /* clipboard may fail — still allow continue after share */
        }
        obKeySent = true;
        await render();
      };
    const next = document.getElementById("ob-next");
    if (next)
      next.onclick = () => {
        if (!obKeySent) {
          setNotice(t("obNeedSend"), "warn");
          return;
        }
        obStep = 2;
        notice = "";
        render();
      };
    const back = document.getElementById("ob-back");
    if (back)
      back.onclick = () => {
        obStep = 1;
        notice = "";
        render();
      };
    const skip = document.getElementById("ob-skip");
    if (skip)
      skip.onclick = async () => {
        await finishOnboarding();
        render();
      };
    const add = document.getElementById("ob-add");
    if (add)
      add.onclick = async () => {
        try {
          const c = await V().addContact(document.getElementById("cname").value, document.getElementById("ckey").value);
          obContactId = c.id;
          obStep = 3;
          notice = "";
        } catch (e) {
          setNotice(e.message, "err");
        }
        await render();
      };
    if (obStep === 3 && obContactId) {
      bindVerifyButtons(obContactId, async (outcome) => {
        if (outcome === "mismatch") {
          obStep = 2;
          obContactId = null;
        } else {
          await finishOnboarding();
        }
        await render();
      });
    }
    if (obStep === 1) drawQr("qr", pub);
    const sharePub = document.getElementById("share-pub");
    if (sharePub)
      sharePub.onclick = async () => {
        await share(pub + "\n" + fp, "Pairlock");
        obKeySent = true;
        setNotice(t("obSent"), "ok");
        await render();
      };
    const saveQr = document.getElementById("save-qr");
    if (saveQr)
      saveQr.onclick = async () => {
        try {
          await shareQrPng();
          obKeySent = true;
          setNotice(t("obSent"), "ok");
          await render();
        } catch (e) {
          setNotice(e.message, "err");
        }
      };
  }

  async function viewApp() {
    const prevTa = document.getElementById("im-text");
    if (prevTa) {
      chatDraft = prevTa.value;
      chatSel = {
        start: prevTa.selectionStart,
        end: prevTa.selectionEnd,
        focused: document.activeElement === prevTa,
      };
    }
    const prevMsgs = document.getElementById("im-msgs");
    if (prevMsgs) {
      chatStick = msgsNearBottom(prevMsgs);
      chatScrollTop = prevMsgs.scrollTop;
    }
    try {
      await V().expireSessions();
    } catch {
      /* locked */
    }
    const state = V().getState();
    const fp = await V().myFingerprint();
    const pub = await V().publicKeyText();
    const settings = state.settings || {};
    const showWizard = tab === "pad" && (wizardForced || (obStep === 3 && obContactId));
    const showGoSite = tab === "pad" && !showWizard && !settings.onboarded && state.contacts.length === 0;

    let chatFocus = false;
    let body = "";
    if (showWizard) {
      body = onboardingHtml(state, fp, pub);
    } else if (showGoSite) {
      body = goSiteHtml();
    } else if (tab === "pad") {
      const unverifiedNote =
        state.contacts.length && state.contacts.some((c) => !c.verified)
          ? `<div class="callout warn" id="unverified-note">${esc(t("unverifiedWarn"))}</div>`
          : "";
      let statusCard = "";
      if (isPopup) {
        if (!currentPeer) {
          statusCard = `<div class="status-card off"><div class="st-title">${esc(t("stNoChat"))}</div><p class="note">${esc(t("stHint"))}</p></div>`;
        } else {
          let bound = null;
          try {
            bound = V().findByBinding(currentPeer.platform, currentPeer.peer);
          } catch (_) {
            bound = null;
          }
          const where = `${esc(currentPeer.host || currentPeer.platform)} · ${esc(t("stChat"))} ${esc(currentPeer.peer)}`;
          if (bound) {
            statusCard = `
              <div class="status-card ok">
                <div class="st-title"><span class="status-dot"></span>${where}</div>
                <div class="st-line">🔒 ${esc(t("stEnc"))} · <b>${esc(bound.name)}</b> ${bound.verified ? "✓" : `<span class="badge warn">${esc(t("unverified"))}</span>`}</div>
              </div>`;
          } else {
            statusCard = `
              <div class="status-card warn">
                <div class="st-title"><span class="status-dot warn"></span>${where}</div>
                <div class="st-line">${esc(t("stPlain"))}</div>
                ${
                  state.contacts.length
                    ? `<div class="st-bind"><span>${esc(t("bindTo"))}</span>${state.contacts
                        .map((c) => `<button class="btn" data-bind="${esc(c.id)}">${esc(c.name)}</button>`)
                        .join("")}</div><p class="note">${esc(t("stAuto"))}</p>`
                    : `<p class="note">${esc(t("needContact"))}</p>`
                }
              </div>`;
          }
        }
      }

      if (!state.contacts.length) {
        body = `
          ${statusCard}
          <div class="callout">
            ${esc(t("addFirst"))}
            <div class="row" style="flex-wrap:wrap;margin-top:10px">
              <a class="btn" href="https://vk.ru/im" target="_blank" rel="noopener noreferrer">${esc(t("goVk"))}</a>
              <a class="btn secondary" href="https://web.max.ru" target="_blank" rel="noopener noreferrer">${esc(t("goMax"))}</a>
              <button type="button" class="btn ghost" id="start-wizard">${esc(t("startWizard"))}</button>
            </div>
          </div>`;
      } else if (showPad) {
        const whoOptions = state.contacts
          .map(
            (c) =>
              `<option value="${esc(c.id)}" ${padWho === c.id ? "selected" : ""}>${esc(c.name)} ${c.verified ? "✓" : "· " + esc(t("unverified"))}</option>`
          )
          .join("");
        const seg = `
          <div class="seg">
            <button class="seg-btn ${padMode === "enc" ? "on" : ""}" data-mode="enc">${esc(t("padEnc"))}</button>
            <button class="seg-btn ${padMode === "dec" ? "on" : ""}" data-mode="dec">${esc(t("padDec"))}</button>
          </div>`;
        let padBody;
        if (padMode === "enc") {
          const res = padResult && padResult.kind === "enc" ? padResult : null;
          padBody = `
            <label>${esc(t("s1To"))}</label>
            <select id="who">${whoOptions}</select>
            <label>${esc(t("s2Text"))}</label>
            <textarea id="plain" placeholder="…"></textarea>
            <button class="btn big" id="enc">${esc(t("encGo"))}</button>
            <label>${esc(t("s3Paste"))}</label>
            <div class="result cipher ${res ? "" : "empty"}" id="cipher-out">${res ? esc(res.text) : esc(t("resultEmpty"))}</div>
            ${
              res
                ? `<div class="row"><button class="btn secondary" id="copy-c">${esc(t("copy"))}</button><button class="btn ghost" id="share-c">${esc(t("share"))}</button></div>`
                : ""
            }`;
        } else {
          const res = padResult && padResult.kind === "dec" ? padResult : null;
          padBody = `
            <label>${esc(t("d1Paste"))}</label>
            <textarea id="cipher" placeholder="S256M1.…"></textarea>
            <button class="btn big" id="dec">${esc(t("padDec"))}</button>
            <label>${esc(t("d2Text"))}</label>
            <div class="result plain ${res ? "" : "empty"}" id="plain-out">${res ? esc(res.text) : esc(t("decEmpty"))}</div>
            ${res && res.meta ? `<p class="note ${res.metaType || ""}">${esc(res.meta)}</p>` : ""}`;
        }
        body = `
          <div class="row" style="margin:0 0 10px"><button class="btn ghost" id="im-back">${esc(t("imBackList"))}</button></div>
          ${statusCard}
          ${seg}
          ${padBody}
          ${unverifiedNote}`;
      } else {
        const openId = resolveChatId();
        if (!openId) {
          const rows = V().listChats();
          const list = rows
            .map((r) => {
              const prev = r.lastText
                ? (r.lastOutgoing ? esc(t("imYou")) + ": " : "") + esc(previewText(r.lastText))
                : esc(r.fingerprint);
              const mark = r.verified ? "" : `<span class="badge warn">${esc(t("unverified"))}</span>`;
              return `<button type="button" class="im-row" data-chat="${esc(r.id)}">
                <div class="im-ava">${esc(initials(r.name))}</div>
                <div class="im-meta">
                  <div class="im-top"><span class="im-name">${esc(r.name)} ${mark}</span><span class="im-time">${esc(fmtChatTime(r.lastTs))}</span></div>
                  <div class="im-preview">${prev}</div>
                </div>
              </button>`;
            })
            .join("");
          const hideStatus = !!(isPopup && currentPeer && (function () {
            try {
              return !!V().findByBinding(currentPeer.platform, currentPeer.peer);
            } catch (_) {
              return false;
            }
          })());
          body = `
            ${hideStatus ? "" : statusCard}
            <div class="im">
              <div class="im-list">${list}</div>
              <div class="row im-tools"><button class="btn ghost" id="pad-manual">${esc(t("imManual"))}</button></div>
            </div>`;
        } else {
          chatFocus = true;
          const thread = V().getThread(openId);
          const c = thread.contact;
          const sess = thread.session || {};
          const ttlBit = sess.ttlSec
            ? sess.expired
              ? `<span class="badge warn">${esc(t("ttlDead"))}</span>`
              : `<span class="badge ok">${esc(t("ttlOn"))}</span>`
            : "";
          const msgs = (thread.messages || [])
            .map(
              (m) =>
                `<div class="im-msg ${m.outgoing ? "out" : "in"}"><div class="im-body">${esc(m.text)}</div><div class="im-stamp">${esc(fmtChatTime(m.ts))}</div></div>`
            )
            .join("");
          const showChatVerify = chatVerify && !c.verified;
          body = `
            <div class="im im-open">
              <div class="im-head">
                <button type="button" class="im-back" id="im-back" aria-label="${esc(t("imBackList"))}">←</button>
                <div class="im-ava sm">${esc(initials(c.name))}</div>
                <div class="im-head-meta">
                  <div class="im-name">${esc(c.name)} ${c.verified ? "✓" : `<span class="badge warn">${esc(t("unverified"))}</span>`} ${ttlBit}</div>
                  <div class="im-sub">${esc(c.fingerprint)}</div>
                </div>
                ${
                  c.verified
                    ? ""
                    : showChatVerify
                      ? `<button type="button" class="btn ghost" id="im-verify-hide" style="padding:6px 10px;flex-shrink:0">${esc(t("verifyHide"))}</button>`
                      : `<button type="button" class="btn" id="im-verify" style="padding:6px 10px;flex-shrink:0">${esc(t("verify"))}</button>`
                }
              </div>
              ${
                showChatVerify
                  ? `<div class="im-stage im-verify">${verifyCardHtml(c, fp, {})}</div>`
                  : `<div class="im-stage">
                <div class="im-msgs" id="im-msgs">${msgs || `<div class="im-empty">${esc(t("imEmpty"))}</div>`}</div>
                <button type="button" class="im-jump" id="im-jump" hidden title="${esc(t("imJump"))}">↓</button>
              </div>
              <div class="im-bar">
                <textarea id="im-text" rows="1" placeholder="${esc(t("imPh"))}"></textarea>
                <button type="button" class="send" id="im-send" aria-label="${esc(t("enc"))}">
                  <svg viewBox="0 0 24 24"><path d="M3.4 20.4l17.4-8.4L3.4 3.6 3 10.3l11 1.7-11 1.7z"/></svg>
                </button>
              </div>
              ${isExt ? "" : `<p class="note">${esc(t("imStandalone"))}</p>`}`
              }
            </div>`;
        }
      }
    } else if (tab === "keys") {
      if (rotateStep === 1) {
        body = `
          <h2 style="margin:0 0 8px">${esc(t("rotateT1"))}</h2>
          <p class="lead">${esc(t("rotateL1"))}</p>
          <div class="callout warn">${esc(t("rotateW1a"))}</div>
          <div class="callout warn">${esc(t("rotateW1b"))}</div>
          <div class="callout warn">${esc(t("rotateW1c"))}</div>
          <div class="row">
            <button class="btn ghost" id="rotate-cancel">${esc(t("cancel"))}</button>
            <button class="btn danger" id="rotate-next">${esc(t("rotateNext"))}</button>
          </div>`;
      } else if (rotateStep === 2) {
        body = `
          <h2 style="margin:0 0 8px">${esc(t("rotateT2"))}</h2>
          <p class="lead">${esc(t("rotateL2"))}</p>
          <div class="callout warn">${esc(t("rotateW2a"))}</div>
          <div class="callout warn">${esc(t("rotateW2b"))}</div>
          <label>${esc(t("rotateTypeLabel"))}</label>
          <div class="fp">${esc(t("rotatePhrase"))}</div>
          <input id="rotate-phrase" type="text" autocomplete="off" spellcheck="false" />
          <div class="row">
            <button class="btn ghost" id="rotate-cancel">${esc(t("cancel"))}</button>
            <button class="btn danger" id="rotate-next">${esc(t("rotateNext"))}</button>
          </div>`;
      } else if (rotateStep === 3) {
        body = `
          <h2 style="margin:0 0 8px">${esc(t("rotateT3"))}</h2>
          <p class="lead">${esc(t("rotateL3"))}</p>
          <div class="callout warn">${esc(t("rotateW1b"))}</div>
          <label>${esc(t("pw"))}</label>
          <input id="rotate-pw" type="password" autocomplete="current-password" />
          <div class="row">
            <button class="btn ghost" id="rotate-cancel">${esc(t("cancel"))}</button>
            <button class="btn danger" id="rotate-go">${esc(t("rotateGo"))}</button>
          </div>`;
      } else {
        const pairView = V().pairModeView ? V().pairModeView() : { mode: "forever", locked: false, keyTtlSec: 0 };
        const offerTtl = pairView.keyTtlSec || 0;
        const offerBurn = pairView.keyBurnTtlSec || 0;
        const vaultBurnLeft =
          settings.burnAt && settings.burnAt > Date.now()
            ? `<div class="keys-burn">${esc(t("pairBurnLeft"))} <b>${esc(fmtBurnLeft(settings.burnAt))}</b></div>`
            : "";
        const ttlChips = [
          [0, "pairForever"],
          [900, "pairTtl15"],
          [3600, "pairTtl1h"],
          [86400, "pairTtl1d"],
          [604800, "pairTtl1w"],
        ]
          .map(
            ([sec, key]) =>
              `<button type="button" class="ttl-chip ${offerTtl === sec ? "on" : ""}" data-offer-ttl="${sec}">${esc(t(key))}</button>`
          )
          .join("");
        const burnChips = [
          [0, "burnChatOff"],
          [30, "burnChat30"],
          [60, "burnChat60"],
          [120, "burnChat120"],
        ]
          .map(
            ([sec, key]) =>
              `<button type="button" class="ttl-chip ${offerBurn === sec ? "on" : ""}" data-offer-burn="${sec}">${esc(t(key))}</button>`
          )
          .join("");
        body = `
        <div class="keys-mini">
          <div class="key-card keys-id">
            <div class="keys-id-top">
              <div class="qr" id="qr"></div>
              <div class="keys-id-meta">
                <div class="keys-label">${esc(t("keysIdentity"))}</div>
                <div class="fp">${esc(fp)}</div>
                <div class="row keys-id-actions">
                  <button type="button" class="btn" id="copy-pub">${esc(t("copyKeyShort"))}</button>
                  <button type="button" class="btn ghost" id="save-qr">${esc(t("saveQr"))}</button>
                </div>
              </div>
            </div>
            <details class="keys-raw">
              <summary>${esc(t("pub"))}</summary>
              <div class="keybox" id="pub">${esc(pub)}</div>
              <div class="row" style="margin-top:8px">
                <button type="button" class="btn ghost" id="share-pub">${esc(t("shareKey"))}</button>
              </div>
            </details>
          </div>

          <div class="keys-modes">
            <div class="keys-label">${esc(t("pairModeTitle"))}</div>
            <div class="ttl-row">${ttlChips}</div>
            <p class="note">${esc(t("pairOfferHint"))}</p>
            <div class="keys-label" style="margin-top:14px">${esc(t("burnChatTitle"))}</div>
            <div class="ttl-row">${burnChips}</div>
            <p class="note">${esc(t("burnChatHint"))}</p>
            ${
              offerTtl > 0
                ? `<div class="callout warn keys-safe-warn">${esc(t("pairSafeWarn"))}</div>`
                : ""
            }
            ${vaultBurnLeft}
          </div>

          <div class="row keys-bar">
            <button type="button" class="btn ghost" id="lock">${esc(t("lock"))}</button>
            ${pairView.burnMode ? "" : `<button type="button" class="btn ghost" id="export">${esc(t("export"))}</button>`}
          </div>

          <details class="keys-more">
            <summary>${esc(t("keysMore"))}</summary>
            <label class="check">
              <input type="checkbox" id="stealth-wire" ${settings.stealthWire !== false ? "checked" : ""} />
              <span>${esc(t("stealthWire"))}</span>
            </label>
            <label class="check">
              <input type="checkbox" id="page-decrypt" ${settings.pageDecrypt ? "checked" : ""} />
              <span>${esc(t("pageDecrypt"))}</span>
            </label>
            ${
              pairView.burnMode
                ? `<p class="note">${esc(t("pairExportOff"))}</p>`
                : `<label>${esc(t("backup"))}</label>
            <textarea id="backup" rows="3" placeholder="S256VAULT2…"></textarea>
            <label>${esc(t("backupPw"))}</label>
            <input id="backup-pw" type="password" />
            <div class="row">
              <button type="button" class="btn secondary" id="import">${esc(t("import"))}</button>
            </div>`
            }
            <div class="row" style="margin-top:12px">
              <button type="button" class="btn danger" id="rotate-start">${esc(t("rotate"))}</button>
            </div>
          </details>
        </div>`;
      }
    } else if (tab === "people") {
      const verifying = verifyId ? state.contacts.find((c) => c.id === verifyId) : null;
      if (verifying) {
        body = verifyCardHtml(verifying, fp, {});
      } else {
        const platName = (k) => (k === "vk" ? "VK" : k === "max" ? "MAX" : k);
        const list = state.contacts.length
          ? state.contacts
              .map((c) => {
                const chats = Object.keys(c.bindings || {})
                  .map(platName)
                  .join(" · ");
                const sess = V().sessionView(c);
                const bits = [
                  c.verified ? t("peopleCodesOk") : t("peopleCodesNo"),
                  chats || t("peopleNoChat"),
                  sess.ttlSec ? (sess.expired ? t("ttlDead") : sess.label) : "",
                ].filter(Boolean);
                const confirm = peopleDelId === c.id;
                return `<div class="item item-person">
                  <div class="person-head">
                    <b>${esc(c.name)}</b>
                    <span class="person-meta">${esc(bits.join(" · "))}</span>
                  </div>
                  ${
                    confirm
                      ? `<div class="item-confirm">
                    <b>${esc(t("delConfirmT"))}</b>
                    <p>${esc(t("delConfirmL").replace("{name}", c.name))}</p>
                    <div class="row">
                      <button type="button" class="btn ghost" data-del-cancel="1">${esc(t("cancel"))}</button>
                      <button type="button" class="btn danger" data-del-yes="${esc(c.id)}">${esc(t("delYes"))}</button>
                    </div>
                  </div>`
                      : `<div class="row person-actions">
                    ${c.verified ? "" : `<button type="button" class="btn" data-verify="${esc(c.id)}">${esc(t("verify"))}</button>`}
                    ${isPopup && currentPeer ? `<button type="button" class="btn secondary" data-bind="${esc(c.id)}">${esc(t("thisChat"))}</button>` : ""}
                    <button type="button" class="btn ghost" data-rename="${esc(c.id)}" data-name="${esc(c.name)}">${esc(t("rename"))}</button>
                    <button type="button" class="btn ghost" data-del="${esc(c.id)}">${esc(t("del"))}</button>
                  </div>`
                  }
                </div>`;
              })
              .join("")
          : `<div class="people-empty">
              <p class="lead">${esc(t("nobody"))}</p>
              <p class="note">${esc(t("peopleHint"))}</p>
            </div>`;
        const manual = peopleManual
          ? `<div class="people-manual">
              <label>${esc(t("name"))}</label>
              <input id="cname" type="text" autocomplete="off" />
              <label>${esc(t("theirKey"))}</label>
              <textarea id="ckey" placeholder="S256K1.…"></textarea>
              <div class="row"><button type="button" class="btn" id="add">${esc(t("add"))}</button></div>
            </div>`
          : "";
        body = `
          ${state.contacts.length ? `<div class="list">${list}</div>` : list}
          <div class="people-foot">
            <button type="button" class="btn ghost" id="people-manual">${esc(peopleManual ? t("peopleHideManual") : t("peopleAddManual"))}</button>
          </div>
          ${manual}`;
      }
    } else {
      body = `
        ${helpPageHtml()}
        ${standaloneHint()}`;
    }

    app.classList.toggle("im-focus", chatFocus);
    app.innerHTML = `
      ${chatFocus ? "" : header(`<div class="row" style="margin:0">${isPopup ? `<button class="btn ghost" id="full" style="padding:8px 12px">${esc(t("window"))}</button>` : ""}<span class="pill"><span class="status-dot"></span>${esc(t("open"))}</span></div>`)}
      ${tabsHtml()}
      <div class="card${chatFocus ? " card-im" : ""}">
        ${body}
        ${notice ? `<div class="${noticeType}">${esc(notice)}</div>` : ""}
      </div>`;

    bindLang();
    if (showWizard) {
      bindOnboarding(pub, fp);
    } else if (showGoSite) {
      const goOk = document.getElementById("go-ok");
      if (goOk)
        goOk.onclick = async () => {
          await finishOnboarding();
          setNotice("", "ok");
          await render();
        };
      const goPair = document.getElementById("go-pair-here");
      if (goPair)
        goPair.onclick = () => {
          wizardForced = true;
          obStep = 1;
          obContactId = null;
          obKeySent = false;
          notice = "";
          render();
        };
    } else if (tab === "keys" && rotateStep === 0) {
      drawQr("qr", pub);
    }
    const rotatePhrase = document.getElementById("rotate-phrase");
    if (rotatePhrase) rotatePhrase.focus();
    const rotatePw = document.getElementById("rotate-pw");
    if (rotatePw) rotatePw.focus();

    const startWizard = document.getElementById("start-wizard");
        if (startWizard)
      startWizard.onclick = () => {
        wizardForced = true;
        obStep = 1;
        obContactId = null;
        obKeySent = false;
        tab = "pad";
        notice = "";
        render();
      };

    if (verifyId) {
      bindVerifyButtons(verifyId, async () => {
        verifyId = null;
        await render();
      });
    }
    if (chatVerify && chatFocus) {
      const openId = resolveChatId();
      if (openId)
        bindVerifyButtons(openId, async (result) => {
          chatVerify = false;
          if (result === "mismatch") chatId = null;
          await render();
        });
    }
    const imVerify = document.getElementById("im-verify");
    if (imVerify)
      imVerify.onclick = () => {
        chatVerify = true;
        notice = "";
        render();
      };
    const imVerifyHide = document.getElementById("im-verify-hide");
    if (imVerifyHide)
      imVerifyHide.onclick = () => {
        chatVerify = false;
        notice = "";
        render();
      };
    app.querySelectorAll("[data-verify]").forEach((el) => {
      el.onclick = () => {
        verifyId = el.dataset.verify;
        notice = "";
        render();
      };
    });

    const full = document.getElementById("full");
    if (full && isExt && chrome.runtime) {
      full.onclick = () => {
        const url = chrome.runtime.getURL("index.html");
        if (chrome.windows && chrome.windows.create) {
          chrome.windows.create({ url, type: "popup", width: 400, height: 680, focused: true });
          return;
        }
        chrome.tabs.create({ url });
      };
    }
    app.querySelectorAll(".tab").forEach((el) => {
      el.onclick = () => {
        tab = el.dataset.tab;
        verifyId = null;
        wizardForced = false;
        rotateStep = 0;
        peopleDelId = null;
        notice = "";
        render();
      };
    });

    const keepFields = async (fn) => {
      const plain = document.getElementById("plain") && document.getElementById("plain").value;
      const cipher = document.getElementById("cipher") && document.getElementById("cipher").value;
      await fn();
      await render();
      const p = document.getElementById("plain");
      const c = document.getElementById("cipher");
      if (p && plain != null) p.value = plain;
      if (c && cipher != null) c.value = cipher;
    };

    app.querySelectorAll(".seg-btn").forEach((el) => {
      el.onclick = () =>
        keepFields(async () => {
          padMode = el.dataset.mode;
          notice = "";
        });
    });
    const who = document.getElementById("who");
    if (who) who.onchange = () => (padWho = who.value);

    const enc = document.getElementById("enc");
    if (enc) {
      enc.onclick = () =>
        keepFields(async () => {
          try {
            const id = document.getElementById("who").value;
            if (!id) throw new Error(t("needContact"));
            padWho = id;
            const text = document.getElementById("plain").value;
            if (!text.trim()) throw new Error(t("s2Text"));
            const packets = await V().encryptForContact(id, text);
            padResult = { kind: "enc", text: packets.join("\n\n") };
            try {
              await navigator.clipboard.writeText(packets.join("\n\n"));
              setNotice(packets.length > 1 ? "Частей: " + packets.length : t("encDone"), "ok");
            } catch (_) {
              setNotice(t("copied"), "ok");
            }
          } catch (e) {
            setNotice(e.message, "err");
          }
        });
    }
    const dec = document.getElementById("dec");
    if (dec) {
      dec.onclick = () =>
        keepFields(async () => {
          const cipher = document.getElementById("cipher").value;
          try {
            const res = await V().decryptPacket(cipher);
            let meta = "";
            let metaType = "ok";
            if (res.outgoing) meta = t("padEnc") + " → " + (res.contact ? res.contact.name : "");
            else if (!res.known) {
              meta = t("unknownSender");
              metaType = "warn";
            } else if (!res.verified) {
              meta = t("from") + " " + res.contact.name + " · " + t("fromUnverified");
              metaType = "warn";
            } else meta = t("from") + " " + res.contact.name + " ✓";
            padResult = { kind: "dec", text: res.text, meta, metaType };
            setNotice("", "ok");
          } catch (e) {
            padResult = null;
            setNotice(e.message, "err");
          }
        });
    }
    const copyC = document.getElementById("copy-c");
    if (copyC) copyC.onclick = () => copy(padResult ? padResult.text : "");
    const shareC = document.getElementById("share-c");
    if (shareC) shareC.onclick = () => share(padResult ? padResult.text : "", "Pairlock");

    app.querySelectorAll("[data-chat]").forEach((el) => {
      el.onclick = () => {
        chatId = el.dataset.chat;
        showPad = false;
        chatDraft = "";
        chatVerify = false;
        chatStick = true;
        chatForceBottom = true;
        notice = "";
        render();
      };
    });
    const padManual = document.getElementById("pad-manual");
    if (padManual)
      padManual.onclick = () => {
        showPad = true;
        notice = "";
        render();
      };
    const imBack = document.getElementById("im-back");
    if (imBack)
      imBack.onclick = () => {
        chatId = null;
        showPad = false;
        chatDraft = "";
        chatVerify = false;
        notice = "";
        render();
      };
    const imText = document.getElementById("im-text");
    const imMsgs = document.getElementById("im-msgs");
    const imJump = document.getElementById("im-jump");
    if (imMsgs) {
      if (chatForceBottom || chatStick) {
        imMsgs.scrollTop = imMsgs.scrollHeight;
        chatForceBottom = false;
        chatStick = true;
      } else {
        imMsgs.scrollTop = chatScrollTop;
      }
      const syncJump = () => {
        chatStick = msgsNearBottom(imMsgs);
        if (imJump) imJump.hidden = chatStick;
      };
      syncJump();
      imMsgs.onscroll = syncJump;
      if (imJump)
        imJump.onclick = () => {
          chatStick = true;
          chatForceBottom = false;
          imMsgs.scrollTop = imMsgs.scrollHeight;
          imJump.hidden = true;
        };
    }
    if (imText) {
      imText.value = chatDraft;
      if (chatSel && chatSel.focused) {
        imText.focus();
        try {
          imText.setSelectionRange(chatSel.start, chatSel.end);
        } catch (_) {
          /* ignore */
        }
      }
      const grow = () => {
        imText.style.height = "auto";
        imText.style.height = Math.min(160, Math.max(42, imText.scrollHeight)) + "px";
      };
      grow();
      imText.oninput = () => {
        chatDraft = imText.value;
        grow();
      };
      imText.onkeydown = (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          document.getElementById("im-send") && document.getElementById("im-send").click();
        }
      };
    }
    const imSend = document.getElementById("im-send");
    if (imSend) {
      imSend.onclick = async () => {
        const ta = document.getElementById("im-text");
        const text = ta ? ta.value : chatDraft;
        if (!String(text).trim()) return;
        const id = resolveChatId();
        if (!id) return;
        imSend.disabled = true;
        chatDraft = "";
        chatSel = { start: 0, end: 0, focused: true };
        chatStick = true;
        chatForceBottom = true;
        if (ta) {
          ta.value = "";
          ta.style.height = "";
        }
        try {
          const packets = await V().encryptForContact(id, text.trim());
          const thread = V().getThread(id);
          const how = await deliverCipher(packets, thread.contact.bindings);
          if (how === "wrong") setNotice(t("imWrong"), "warn");
          else if (how === "copy" && !Object.keys(thread.contact.bindings || {}).length) setNotice(t("imNeedBind"), "warn");
          else if (how === "copy") setNotice(t("imCopied"), "ok");
          else if (packets.length > 1) setNotice("Отправлено частями: " + packets.length, "ok");
          else setNotice("", "ok");
        } catch (e) {
          chatDraft = text;
          if (ta) ta.value = text;
          setNotice(e.message, "err");
        } finally {
          imSend.disabled = false;
        }
        await render();
      };
    }

    const unbind = document.getElementById("unbind");
    if (unbind)
      unbind.onclick = async () => {
        try {
          await V().unbindPeer(unbind.dataset.cid, currentPeer.platform);
        } catch (e) {
          setNotice(e.message, "err");
        }
        await render();
      };
    if (!showWizard) {
      const copyPub = document.getElementById("copy-pub");
      if (copyPub) copyPub.onclick = () => copy(pub);
      const sharePub = document.getElementById("share-pub");
      if (sharePub) sharePub.onclick = () => share(pub + "\n" + fp, "Pairlock");
      const saveQr = document.getElementById("save-qr");
      if (saveQr) {
        saveQr.onclick = async () => {
          try {
            await shareQrPng();
            setNotice(t("copied"), "ok");
          } catch (e) {
            setNotice(e.message, "err");
          }
        };
      }
    }
    const lock = document.getElementById("lock");
    if (lock)
      lock.onclick = async () => {
        await vaultLock();
        setNotice("", "ok");
        await render();
      };
    const ttl = document.getElementById("ttl");
    if (ttl) {
      ttl.onchange = async () => {
        try {
          await V().setSetting("keyTtlSec", Number(ttl.value));
        } catch (e) {
          setNotice(e.message, "err");
        }
        await render();
      };
    }
    const burn = document.getElementById("burn");
    if (burn) {
      burn.onchange = async () => {
        const n = Number(burn.value);
        if (n > 0 && !window.confirm(t("burnConfirm"))) {
          await render();
          return;
        }
        try {
          await V().setSetting("burnVaultSec", n);
          setNotice(n ? t("burnTitle") + " · " + (n === 86400 ? t("burn1d") : t("burn1h")) : t("burnOff"), "ok");
        } catch (e) {
          setNotice(e.message, "err");
        }
        await render();
      };
    }
    const modeSafe = document.getElementById("mode-safe");
    if (modeSafe) modeSafe.onclick = null;
    const modeForever = document.getElementById("mode-forever");
    if (modeForever) modeForever.onclick = null;
    app.querySelectorAll("[data-offer-burn]").forEach((el) => {
      el.onclick = async () => {
        const ttl = Number(el.dataset.offerBurn);
        try {
          if (isExt && chrome.runtime && chrome.runtime.id) {
            const r = await chrome.runtime.sendMessage({ type: "S256_SET_BURN_TTL", ttlSec: ttl });
            if (!r || !r.ok) throw new Error((r && r.error) || "error");
            await V().restoreSession();
          } else {
            await V().setSetting("keyBurnTtlSec", ttl);
          }
          setNotice(ttl > 0 ? t("burnChatTitle") + ": " + el.textContent : t("burnChatOff"), "ok");
        } catch (e) {
          setNotice(e.message, "err");
        }
        await render();
      };
    });
    app.querySelectorAll("[data-offer-ttl]").forEach((el) => {
      el.onclick = async () => {
        const ttl = Number(el.dataset.offerTtl);
        try {
          if (isExt && chrome.runtime && chrome.runtime.id) {
            const r = await chrome.runtime.sendMessage({
              type: "S256_SET_PAIR_MODE",
              mode: ttl > 0 ? "safe" : "forever",
              ttlSec: ttl > 0 ? ttl : 0,
            });
            if (!r || !r.ok) throw new Error((r && r.error) || "error");
            await V().restoreSession();
          } else if (ttl > 0) {
            await V().setPairMode("safe", ttl);
          } else {
            await V().setPairMode("forever");
          }
          setNotice(ttl > 0 ? t("pairPickTtl") + ": " + el.textContent : t("pairForever"), "ok");
        } catch (e) {
          setNotice(e.message, "err");
        }
        await render();
      };
    });
    app.querySelectorAll("[data-safe-ttl]").forEach((el) => {
      el.onclick = null;
    });
    const pageDecrypt = document.getElementById("page-decrypt");
    if (pageDecrypt) {
      pageDecrypt.onchange = async () => {
        try {
          await V().setSetting("pageDecrypt", pageDecrypt.checked);
        } catch (e) {
          setNotice(e.message, "err");
        }
        await render();
      };
    }
    const stealthWire = document.getElementById("stealth-wire");
    if (stealthWire) {
      stealthWire.onchange = async () => {
        try {
          await V().setSetting("stealthWire", stealthWire.checked);
          setNotice(stealthWire.checked ? t("stealthWire") : "S256M1.", "ok");
        } catch (e) {
          setNotice(e.message, "err");
        }
        await render();
      };
    }
    const rotateStart = document.getElementById("rotate-start");
    if (rotateStart)
      rotateStart.onclick = () => {
        rotateStep = 1;
        notice = "";
        render();
      };
    const rotateCancel = document.getElementById("rotate-cancel");
    if (rotateCancel)
      rotateCancel.onclick = () => {
        rotateStep = 0;
        notice = "";
        render();
      };
    const rotateNext = document.getElementById("rotate-next");
    if (rotateNext)
      rotateNext.onclick = () => {
        if (rotateStep === 2) {
          const typed = (document.getElementById("rotate-phrase") && document.getElementById("rotate-phrase").value) || "";
          if (typed.trim() !== t("rotatePhrase")) {
            setNotice(t("rotateNeedPhrase"), "err");
            return;
          }
        }
        rotateStep += 1;
        notice = "";
        render();
      };
    const rotateGo = document.getElementById("rotate-go");
    if (rotateGo)
      rotateGo.onclick = async () => {
        const pw = (document.getElementById("rotate-pw") && document.getElementById("rotate-pw").value) || "";
        try {
          await V().rotateIdentity(pw);
          rotateStep = 0;
          wizardForced = true;
          obStep = 1;
          obContactId = null;
          obKeySent = false;
          tab = "pad";
          setNotice(t("rotateDone"), "ok");
        } catch (e) {
          setNotice(e.message, "err");
        }
        await render();
      };
    const add = document.getElementById("add");
    if (add) {
      add.onclick = async () => {
        try {
          const c = await V().addContact(document.getElementById("cname").value, document.getElementById("ckey").value);
          /* go straight to the voice check for the new contact */
          verifyId = c.id;
          peopleManual = false;
          setNotice(t("added"), "ok");
        } catch (e) {
          setNotice(e.message, "err");
        }
        await render();
      };
    }
    app.querySelectorAll("[data-del]").forEach((el) => {
      el.onclick = () => {
        peopleDelId = el.dataset.del;
        notice = "";
        render();
      };
    });
    app.querySelectorAll("[data-del-cancel]").forEach((el) => {
      el.onclick = () => {
        peopleDelId = null;
        render();
      };
    });
    app.querySelectorAll("[data-del-yes]").forEach((el) => {
      el.onclick = async () => {
        try {
          await V().removeContact(el.dataset.delYes);
          peopleDelId = null;
          setNotice("", "ok");
        } catch (e) {
          setNotice(e.message, "err");
        }
        await render();
      };
    });
    const peopleManualBtn = document.getElementById("people-manual");
    if (peopleManualBtn)
      peopleManualBtn.onclick = () => {
        peopleManual = !peopleManual;
        peopleDelId = null;
        notice = "";
        render();
      };
    app.querySelectorAll("[data-rename]").forEach((el) => {
      el.onclick = async () => {
        const cur = el.dataset.name || "";
        const next = window.prompt(t("name"), cur);
        if (next == null) return;
        try {
          await V().renameContact(el.dataset.rename, next);
          setNotice(t("copied"), "ok");
        } catch (e) {
          setNotice(e.message, "err");
        }
        await render();
      };
    });
    app.querySelectorAll("[data-bind]").forEach((el) => {
      el.onclick = async () => {
        if (!currentPeer) return;
        try {
          await V().bindPeer(el.dataset.bind, currentPeer.platform, currentPeer.peer);
          setNotice("🔒 " + t("stEnc"), "ok");
        } catch (e) {
          setNotice(e.message, "err");
        }
        await render();
      };
    });
    app.querySelectorAll("[data-bind-next]").forEach((el) => {
      el.onclick = async () => {
        bindNext = true;
        if (isExt) chrome.runtime.sendMessage({ type: "S256_BIND_NEXT", contactId: el.dataset.bindNext });
        setNotice("…", "ok");
        await render();
      };
    });
    const exp = document.getElementById("export");
    if (exp) {
      exp.onclick = async () => {
        const blob = await V().exportBackup();
        downloadText("s256-vault.txt", blob);
        setNotice(t("copied"), "ok");
      };
    }
    const imp = document.getElementById("import");
    if (imp) {
      imp.onclick = async () => {
        try {
          await V().importBackup(document.getElementById("backup").value, document.getElementById("backup-pw").value);
          setNotice("ok", "ok");
        } catch (e) {
          setNotice(e.message, "err");
        }
        await render();
      };
    }
  }

  async function loadPeerFromTab() {
    if (!isPopup || !isExt || !chrome.tabs) return;
    try {
      const [tabInfo] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tabInfo) return;
      const r = await chrome.tabs.sendMessage(tabInfo.id, { type: "S256_GET_PEER" });
      if (r && r.peer) {
        currentPeer = r;
        try {
          currentPeer.host = new URL(tabInfo.url || "").hostname;
        } catch (_) {
          /* no tab url permission */
        }
      }
    } catch {
      currentPeer = null;
    }
  }

  async function render() {
    if (!(crypto && crypto.subtle)) {
      app.innerHTML = `<div class="card"><h2>${esc(t("noCrypto"))}</h2></div>`;
      return;
    }
    try {
      if (V().enforceBurn && (await V().enforceBurn())) {
        setNotice(t("burnDone"), "warn");
      }
    } catch {
      /* ignore */
    }
    try {
      if (V().probeStore) await V().probeStore();
    } catch {
      /* ignore */
    }
    try {
      await V().restoreSession();
    } catch {
      /* ignore */
    }
    if (!V().isUnlocked()) return viewLocked();
    if (tab === "pad" && !showPad && !chatPoll) {
      chatPoll = setInterval(() => {
        if (tab !== "pad" || showPad || document.hidden) return;
        render();
      }, 2500);
    }
    return viewApp();
  }

  if (location.protocol === "https:" && "serviceWorker" in navigator && !isExt) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  try {
    loadPeerFromTab().finally(render);
  } catch (e) {
    if (app) app.innerHTML = "<div class='card'><p class='err'>" + String(e && e.message ? e.message : e) + "</p></div>";
  }
})();
