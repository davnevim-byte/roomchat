/**
 * RoomChat — config.js
 * ─────────────────────────────────────────────
 * Zodpovědnost:
 *   • Inicializace Firebase + Firestore
 *   • Všechny konstanty aplikace
 *   • Globální stav S{} — jediný zdroj pravdy
 *
 * Načítat PRVNÍ před všemi ostatními JS soubory.
 * ─────────────────────────────────────────────
 */

// ─────────────────────────────────────────────
// FIREBASE
// ─────────────────────────────────────────────

const firebaseConfig = {
  apiKey:            'AIzaSyBJjoNzhe9x6-9TKBBiMOqIXIr7TniqJ28',
  authDomain:        'roomchat-6092c.firebaseapp.com',
  projectId:         'roomchat-6092c',
  storageBucket:     'roomchat-6092c.appspot.com',
  messagingSenderId: '681715608200',
  appId:             '1:681715608200:web:cde43c08577bf279020d3d',
};

firebase.initializeApp(firebaseConfig);

/** @type {firebase.firestore.Firestore} Globální Firestore instance */
const db = firebase.firestore();


// ─────────────────────────────────────────────
// PUSH NOTIFICATIONS — VAPID
// ─────────────────────────────────────────────

const VAPID_PUBLIC_KEY =
  'BEv4FB_obIJQN0EKp9_ulz_uC_PgpqaFVZeJP2cCZa_wHBJzv73PeF-EcEJW8kT7Nls03vII1WFlk0p1BaGarD0';


// ─────────────────────────────────────────────
// BEZPEČNOST
// ─────────────────────────────────────────────

/**
 * SHA-256 hash hesla "admin" — uložen zde, nikdy plaintext.
 * Slouží k ověření admin session na klientovi.
 */
const ADMIN_HASH =
  '6c1d09e991650e6647d9c8abba921b5916a49af4f2c49b2bda1e497761284e7a';


// ─────────────────────────────────────────────
// ČASOVÉ KONSTANTY
// ─────────────────────────────────────────────

/** Lifetime místnosti v sekundách (30 dní) */
const ROOM_LIFETIME = 30 * 86_400;

/** Výchozí lifetime zprávy v milisekundách (24 hodin) */
const DEFAULT_MSG_LIFETIME = 86_400_000;

/**
 * Volitelné doby mazání zpráv — zobrazeno v admin nastavení.
 * Klíč = label, hodnota = ms (0 = nikdy nesmazat)
 */
const MSG_LIFETIME_OPTIONS = [
  { label: '1 hodina',           value: 3_600_000   },
  { label: '6 hodin',           value: 21_600_000  },
  { label: '24 hodin (výchozí)', value: 86_400_000  },
  { label: '3 dny',             value: 259_200_000 },
  { label: '7 dní',             value: 604_800_000 },
  { label: 'Nikdy',             value: 0            },
];


// ─────────────────────────────────────────────
// UI KONSTANTY
// ─────────────────────────────────────────────

/** Barvy avatarů uživatelů — přiřazeny náhodně při vytvoření slotu */
const COLORS = [
  '#5c6bff', '#00b4a0', '#e0415c', '#d97706',
  '#7c3aed', '#0891b2', '#059669', '#db2777',
];

/** Výchozí sada emoji pro rychlé reakce */
const DEFAULT_REACTIONS = [
  '👍', '❤️', '😂', '😮', '😢',
  '🔥', '🎉', '👏', '🤔', '💯',
];

/**
 * Všechny dostupné emoji pro výběr vlastních reakcí.
 * Uživatel si vybere max 10.
 */
const ALL_REACTIONS = [
  '👍','👎','❤️','🧡','💛','💚','💙','💜',
  '😀','😂','😮','😢','😡','😍','🤔','🙄',
  '🥳','🤩','😘','👏','🎉','🔥','💯','✅',
  '❌','⭐','🚀','💪','🤝','🙏','💫','🌟',
  '🎯','💬','🤯',
];

/**
 * Kategorie emoji pro emoji panel.
 * Struktura: { 'Název kategorie': ['emoji', ...] }
 */
const EMOJI_CATS = {
  '😀 Smajlíci': [
    '😀','😃','😄','😁','😅','🤣','😂','😊','😇','🥰',
    '😍','🤩','😘','😜','🤪','😎','🤓','🥳','😤','😡',
    '😈','💀','😭','😢','🥺','😱','😳','🤯','😴','🤢',
    '🥵','🥶','😵','🤠','😏','🙄','🤫','🤭','🫡',
  ],
  '👍 Gesta': [
    '👍','👎','👋','🤝','🙏','👏','✊','💪','🫶','✌️',
    '🤞','🤟','🤘','👆','👇','👉','👈','☝️','🤙','🖖',
    '🫵','💅','🫂',
  ],
  '❤️ Symboly': [
    '❤️','🧡','💛','💚','💙','💜','🖤','🤍','💔','💕',
    '💞','💓','💗','💖','💘','💝','💯','🔥','✨','⭐',
    '🌟','💫','🎯','🚀','🎉','🎊','✅','❌','⚠️','💤',
    '💬','💭','♾️',
  ],
  '🐱 Příroda': [
    '🐱','🐶','🦊','🐸','🐼','🐨','🦁','🐯','🐮','🐷',
    '🦄','🐲','🌸','🌺','🌻','🍀','🌈','☀️','🌙','⭐',
    '🌊','🔥','❄️','⛄','🌍','🦋','🐝','🌵','🌴',
  ],
  '🍕 Jídlo': [
    '🍕','🍔','🍟','🌮','🌯','🍜','🍣','🍩','🍪','🎂',
    '🍫','🍬','🍭','☕','🧃','🥤','🍺','🥂','🍷','🧋',
    '🍓','🍑','🍌','🍉','🍎','🍇','🥑','🧀','🍳','🥞',
  ],
  '🎮 Aktivity': [
    '🎮','🕹️','🎲','🎯','🏆','🥇','🎭','🎨','🎬','🎤',
    '🎧','🎼','🎹','🥁','🎸','🎻','🚀','✈️','🚗','⚽',
    '🏀','🎾','🏊','🧗','🎿','🛹','🛼',
  ],
};


// ─────────────────────────────────────────────
// EXTERNAL API KLÍČE
// ─────────────────────────────────────────────

/** Giphy API klíč pro GIF vyhledávání */
const GIPHY_KEY = 'BZPzm9boeWEPc2HBRsg4m2JlvMSNjmDE';

/** Metered.live TURN server pro WebRTC */
const METERED_HOST = 'roomchat.metered.live';
const METERED_KEY  = 'de4d2a11b1e75f3a5ef7547ccc338163f44c';


// ─────────────────────────────────────────────
// GLOBÁLNÍ STAV APLIKACE — S{}
// ─────────────────────────────────────────────

/**
 * S = Session State
 *
 * Jediný zdroj pravdy pro aktuální session uživatele.
 * Všechny JS soubory čtou/píší sem.
 * Nikdy se persistuje celý — jednotlivá pole se ukládají
 * do localStorage přes storage.js dle potřeby.
 */
const S = {

  // ── Identita ──────────────────────────────
  /** Unikátní session ID tohoto zařízení (localStorage) */
  sid:       null,

  /** ID aktuální místnosti (6 znaků uppercase) */
  roomId:    null,

  /** ID slotu tohoto uživatele v místnosti */
  slotId:    null,

  /** Přezdívka uživatele (viditelná ostatním) */
  username:  null,

  /** Barva avataru (#hex) */
  color:     null,

  // ── Role ──────────────────────────────────
  /** Je aktuální uživatel admin místnosti? */
  isAdmin:         false,

  /** Je aktuální session ověřena admin heslem? */
  isAdminSession:  false,

  // ── Data místnosti ────────────────────────
  /**
   * Snapshot dat místnosti z Firestore.
   * Strukturu viz Firestore schéma níže.
   * @type {Object|null}
   */
  roomData: null,

  /**
   * Všechny sloty v místnosti { slotId: slotData }
   * Aktualizováno real-time přes onSnapshot.
   */
  slots: {},

  /**
   * Read receipts { msgId: { slotId: timestamp } }
   * Aktualizováno real-time přes onSnapshot.
   */
  reads: {},

  // ── Firestore unsubscribe funkce ──────────
  /**
   * Pole unsubscribe funkcí z onSnapshot listenerů.
   * Volány při opuštění místnosti (goToRooms).
   * @type {Function[]}
   */
  unsubs: [],

  // ── Timery ────────────────────────────────
  /** setInterval ID pro heartbeat (online přítomnost) */
  heartbeat: null,

  /** setInterval ID pro odpočet expirace v headeru */
  countdown: null,

  /** setTimeout ID pro reset typing indikátoru */
  typingTO: null,

  /** setTimeout ID pro automatické odhlášení */
  activityTO: null,

  // ── Join flow stav ────────────────────────
  /**
   * Krok v join flow: 'code' | 'password' | 'username'
   */
  jnState: 'code',

  /** Data místnosti nalezené v join flow */
  jnRoomData: null,

  // ── UI stav ───────────────────────────────
  /**
   * Citovaná zpráva pro reply.
   * @type {{ id, text, username }|null}
   */
  replyTo: null,

  /**
   * Kontext pro entry screen.
   * @type {{ type: 'invite'|'rejoin', roomId, slotId, roomData? }|null}
   */
  entryContext: null,

  /** slotId uživatele jehož přezdívku právě editujeme */
  nickEditSlotId: null,

  /** Index začátku @mention v input poli */
  mentionStart: -1,

  // ── DM (soukromé zprávy) ──────────────────
  /**
   * Aktuálně otevřený DM target.
   * @type {{ slotId, username, color }|null}
   */
  dmTarget: null,

  /** Unsubscribe funkce pro DM listener */
  dmUnsub: null,

  // ── Pinnutá zpráva ────────────────────────
  /**
   * Data aktuálně pinnuté zprávy.
   * @type {{ id, text, username, pinnedBy }|null}
   */
  pinnedMsg: null,

};


// ─────────────────────────────────────────────
// FIRESTORE SCHÉMA (dokumentace, nekód)
// ─────────────────────────────────────────────
//
// rooms/{roomId}
//   name           string
//   password       string (prázdné = bez hesla)
//   maxUsers       number (2–10)
//   inviteOnly     boolean
//   locked         boolean       ← NOVÉ: zamknutá místnost
//   expiresAt      Timestamp
//   adminSession   string        ← sid admina
//   adminKey       string        ← ADMIN_HASH (pro query)
//   theme          string
//   customBg       string|null
//   msgLifetime    number (ms)   ← NOVÉ: nastavitelná doba mazání
//   pinnedMsg      object|null   ← NOVÉ: pinnutá zpráva
//   callActive     boolean
//   callSignals/   subcollection ← WebRTC signaling
//
//   slots/{slotId}
//     username     string
//     color        string
//     sessionId    string
//     isAdmin      boolean
//     online       boolean
//     lastSeen     Timestamp
//     typing       boolean
//     typingAt     Timestamp
//     joinedAt     Timestamp
//     inviteToken  string|null
//     pushSub      string|null   ← JSON push subscription
//
//   messages/{msgId}
//     type         'text'|'gif'
//     text         string
//     mediaUrl     string
//     slotId       string
//     username     string
//     color        string
//     timestamp    Timestamp
//     reactions    { emoji: count }
//     replyTo      { id, text, username }|null
//     expiresAt    Timestamp|null     ← časovaná zpráva
//     disappearOnRead boolean|null    ← NOVÉ: zmizí po přečtení
//     edited       boolean
//     editHistory  [{ text, editedAt }]
//
//   reads/{msgId}
//     {slotId}     number (timestamp)
//
//   dms/{dmId}                        ← NOVÉ: soukromé zprávy
//     messages/{msgId}
//       text       string
//       fromSlotId string
//       timestamp  Timestamp
//
// ─────────────────────────────────────────────
