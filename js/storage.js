/**
 * RoomChat — storage.js
 * ─────────────────────────────────────────────
 * Zodpovědnost:
 *   • Veškerá lokální persistence dat
 *   • localStorage jako primární úložiště
 *   • Cookie jako fallback (iOS Safari PWA)
 *   • Nikdy neukládá citlivá data (hesla, tokeny)
 *
 * Závislosti: config.js, utils.js
 * ─────────────────────────────────────────────
 */


// ─────────────────────────────────────────────
// COOKIE HELPERS (fallback pro iOS Safari PWA)
// ─────────────────────────────────────────────

/**
 * Nastaví cookie.
 * @param {string} name  - název cookie
 * @param {string} value - hodnota
 * @param {number} days  - platnost ve dnech
 */
const _setCookie = (name, value, days) => {
  const expires = new Date(Date.now() + days * 86_400_000).toUTCString();
  document.cookie =
    `${name}=${encodeURIComponent(value)};expires=${expires};path=/;SameSite=Lax`;
};

/**
 * Přečte cookie podle názvu.
 * @param {string} name
 * @returns {string|null}
 */
const _getCookie = name => {
  const match = document.cookie.match(
    '(?:^|; )' + name + '=([^;]*)'
  );
  return match ? decodeURIComponent(match[1]) : null;
};

/**
 * Smaže cookie nastavením expirace do minulosti.
 * @param {string} name
 */
const _deleteCookie = name => {
  document.cookie =
    `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/;SameSite=Lax`;
};

/**
 * Bezpečně zapíše do localStorage s cookie fallbackem.
 * @param {string} key
 * @param {string} value
 * @param {number} [cookieDays=60] - platnost cookie fallbacku
 */
const _lsSet = (key, value, cookieDays = 60) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // localStorage nedostupný (private mode, plný disk)
  }
  _setCookie(key, value, cookieDays);
};

/**
 * Bezpečně přečte z localStorage s cookie fallbackem.
 * @param {string} key
 * @returns {string|null}
 */
const _lsGet = key => {
  try {
    const v = localStorage.getItem(key);
    if (v !== null) return v;
  } catch {
    // localStorage nedostupný
  }
  return _getCookie(key);
};

/**
 * Bezpečně smaže z localStorage i cookie.
 * @param {string} key
 */
const _lsDel = key => {
  try {
    localStorage.removeItem(key);
  } catch {
    // ignorujeme
  }
  _deleteCookie(key);
};


// ─────────────────────────────────────────────
// SESSION ID
// ─────────────────────────────────────────────

/**
 * Vrátí unikátní Session ID tohoto zařízení.
 * Pokud neexistuje, vygeneruje nové a uloží.
 * SID identifikuje zařízení, ne uživatele.
 * @returns {string}
 */
const getSid = () => {
  let sid = _lsGet('rc_sid');
  if (!sid) {
    sid = rnd(16);
    _lsSet('rc_sid', sid, 365);
  }
  return sid;
};


// ─────────────────────────────────────────────
// UŽIVATELSKÉ JMÉNO
// ─────────────────────────────────────────────

/**
 * Vrátí naposledy použitou přezdívku.
 * @returns {string|null}
 */
const getUsername = () => _lsGet('rc_username');

/**
 * Uloží naposledy použitou přezdívku.
 * @param {string} username
 */
const setUsername = username => _lsSet('rc_username', username, 60);


// ─────────────────────────────────────────────
// SEZNAM MÍSTNOSTÍ
// ─────────────────────────────────────────────

/**
 * @typedef {Object} RoomEntry
 * @property {string} roomId  - ID místnosti
 * @property {string} slotId  - ID slotu uživatele
 * @property {string} name    - název místnosti
 * @property {number} ts      - timestamp posledního vstupu
 */

/**
 * Vrátí seznam místností uložených na zařízení.
 * @returns {RoomEntry[]}
 */
const getRoomList = () => {
  try {
    const raw = _lsGet('rc_rooms');
    if (raw) return JSON.parse(raw);
  } catch {
    // poškozená data — vrátíme prázdný seznam
  }
  return [];
};

/**
 * Uloží seznam místností.
 * @param {RoomEntry[]} list
 */
const saveRoomList = list => {
  const json = JSON.stringify(list);
  _lsSet('rc_rooms', json, 60);
};

/**
 * Přidá nebo aktualizuje místnost v seznamu.
 * Nejnovější místnost je vždy na prvním místě.
 * @param {string} roomId
 * @param {string} slotId
 * @param {string} name
 */
const addToRoomList = (roomId, slotId, name) => {
  const list = getRoomList().filter(r => r.roomId !== roomId);
  list.unshift({ roomId, slotId, name, ts: Date.now() });
  saveRoomList(list);
};

/**
 * Odebere místnost ze seznamu (po vypršení nebo smazání).
 * @param {string} roomId
 */
const removeFromRoomList = roomId => {
  saveRoomList(getRoomList().filter(r => r.roomId !== roomId));
};

/**
 * Aktualizuje název místnosti v uloženém seznamu.
 * @param {string} roomId
 * @param {string} name
 */
const updateRoomName = (roomId, name) => {
  const list = getRoomList().map(r =>
    r.roomId === roomId ? { ...r, name } : r
  );
  saveRoomList(list);
};


// ─────────────────────────────────────────────
// ADMIN SESSION
// ─────────────────────────────────────────────

/**
 * Vrátí true pokud je na zařízení uložena admin session.
 * Admin session se ověřuje heslem při každém spuštění.
 * @returns {boolean}
 */
const isAdminStored = () => _lsGet('rc_admin') === '1';

/**
 * Uloží příznak admin session.
 */
const setAdminStored = () => _lsSet('rc_admin', '1', 365);

/**
 * Smaže admin session (odhlášení admina).
 */
const clearAdminStored = () => _lsDel('rc_admin');


// ─────────────────────────────────────────────
// LOKÁLNÍ PŘEZDÍVKY (nick overlay)
// ─────────────────────────────────────────────

/**
 * Klíč pro přezdívky dané místnosti v localStorage.
 * @param {string} roomId
 * @returns {string}
 */
const _nicksKey = roomId => `rc_nicks_${roomId}`;

/**
 * Vrátí mapu všech lokálních přezdívek pro místnost.
 * Lokální přezdívky vidí jen tento uživatel.
 * @param {string} roomId
 * @returns {{ [slotId: string]: string }}
 */
const getNicks = roomId => {
  try {
    return JSON.parse(localStorage.getItem(_nicksKey(roomId)) || '{}');
  } catch {
    return {};
  }
};

/**
 * Vrátí lokální přezdívku pro daný slot.
 * @param {string} roomId
 * @param {string} slotId
 * @returns {string|null}
 */
const getNick = (roomId, slotId) =>
  getNicks(roomId)[slotId] || null;

/**
 * Uloží lokální přezdívku pro daný slot.
 * @param {string} roomId
 * @param {string} slotId
 * @param {string} nick - prázdný string = smazání přezdívky
 */
const setNick = (roomId, slotId, nick) => {
  const nicks = getNicks(roomId);
  if (nick) {
    nicks[slotId] = nick;
  } else {
    delete nicks[slotId];
  }
  try {
    localStorage.setItem(_nicksKey(roomId), JSON.stringify(nicks));
  } catch {
    // ignorujeme
  }
};

/**
 * Smaže všechny lokální přezdívky pro místnost.
 * @param {string} roomId
 */
const clearNicks = roomId => {
  try {
    localStorage.removeItem(_nicksKey(roomId));
  } catch {
    // ignorujeme
  }
};


// ─────────────────────────────────────────────
// VLASTNÍ REAKCE
// ─────────────────────────────────────────────

/**
 * Vrátí uživatelem vybranou sadu emoji pro rychlé reakce.
 * Pokud není nastavena, vrátí DEFAULT_REACTIONS z config.js.
 * @returns {string[]}
 */
const getMyReactions = () => {
  try {
    const raw = localStorage.getItem('rc_reactions');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch {
    // poškozená data
  }
  return [...DEFAULT_REACTIONS];
};

/**
 * Uloží uživatelem vybranou sadu reakcí.
 * @param {string[]} reactions - pole emoji (max 10)
 */
const saveMyReactions = reactions => {
  try {
    localStorage.setItem('rc_reactions', JSON.stringify(reactions));
  } catch {
    // ignorujeme
  }
};

/**
 * Obnoví výchozí sadu reakcí (smaže customizaci).
 */
const resetMyReactions = () => {
  try {
    localStorage.removeItem('rc_reactions');
  } catch {
    // ignorujeme
  }
};


// ─────────────────────────────────────────────
// TÉMA + POZADÍ
// ─────────────────────────────────────────────

/**
 * Vrátí uložené téma.
 * @returns {string} ID tématu (výchozí 'dark')
 */
const getStoredTheme = () =>
  localStorage.getItem('rc_theme') || 'dark';

/**
 * Uloží téma.
 * @param {string} themeId
 */
const setStoredTheme = themeId => {
  localStorage.setItem('rc_theme', themeId);
};

/**
 * Vrátí uložené vlastní pozadí (data URL nebo http URL).
 * @returns {string|null}
 */
const getStoredCustomBg = () =>
  localStorage.getItem('rc_custom_bg') || null;

/**
 * Uloží vlastní pozadí.
 * @param {string} url
 */
const setStoredCustomBg = url => {
  localStorage.setItem('rc_custom_bg', url);
};

/**
 * Smaže vlastní pozadí.
 */
const clearStoredCustomBg = () => {
  localStorage.removeItem('rc_custom_bg');
};


// ─────────────────────────────────────────────
// PIN OCHRANA
// ─────────────────────────────────────────────

/**
 * Vrátí klíč PINu pro danou místnost + slot.
 * PIN je vázán na kombinaci místnosti a slotu —
 * různé místnosti mohou mít různé PINy.
 * @param {string} roomId
 * @param {string} slotId
 * @returns {string}
 */
const getPinKey = (roomId, slotId) =>
  `rc_pin_${roomId}_${slotId}`;

/**
 * Vrátí true pokud má uživatel nastaven PIN pro tuto místnost.
 * @param {string} roomId
 * @param {string} slotId
 * @returns {boolean}
 */
const hasPin = (roomId, slotId) =>
  !!localStorage.getItem(getPinKey(roomId, slotId));

/**
 * Ověří zadaný PIN.
 * @param {string} roomId
 * @param {string} slotId
 * @param {string} pin - zadaný PIN (4 číslice jako string)
 * @returns {boolean}
 */
const verifyPin = (roomId, slotId, pin) =>
  localStorage.getItem(getPinKey(roomId, slotId)) === pin;

/**
 * Uloží PIN pro danou místnost + slot.
 * PIN se ukládá jako prostý text v localStorage —
 * slouží pouze k ochraně vstupu na tomto zařízení,
 * není to bezpečnostní token (není posílán na server).
 * @param {string} roomId
 * @param {string} slotId
 * @param {string} pin - 4 číslice jako string
 */
const savePin = (roomId, slotId, pin) => {
  localStorage.setItem(getPinKey(roomId, slotId), pin);
};

/**
 * Smaže PIN pro danou místnost + slot.
 * @param {string} roomId
 * @param {string} slotId
 */
const clearPin = (roomId, slotId) => {
  localStorage.removeItem(getPinKey(roomId, slotId));
};


// ─────────────────────────────────────────────
// AUTOMATICKÉ ODHLÁŠENÍ
// ─────────────────────────────────────────────

/**
 * Vrátí nastavenou dobu neaktivity pro auto-logout.
 * @returns {number} minuty (0 = vypnuto)
 */
const getAutoLogoutMins = () =>
  parseInt(localStorage.getItem('rc_auto_logout') || '0', 10);

/**
 * Uloží dobu neaktivity pro auto-logout.
 * @param {number} mins - minuty (0 = vypnout)
 */
const setAutoLogoutMins = mins => {
  localStorage.setItem('rc_auto_logout', String(mins));
};


// ─────────────────────────────────────────────
// PWA BANNER
// ─────────────────────────────────────────────

/**
 * Vrátí true pokud uživatel již zamítl PWA banner.
 * @returns {boolean}
 */
const isPwaDismissed = () =>
  !!localStorage.getItem('pwa_d');

/**
 * Uloží příznak zamítnutí PWA banneru.
 */
const setPwaDismissed = () => {
  localStorage.setItem('pwa_d', '1');
};


// ─────────────────────────────────────────────
// MIGRACE (přechod ze starého formátu)
// ─────────────────────────────────────────────

/**
 * Migruje stará data z původního monolitního index.html.
 * Původní kód ukládal roomId/slotId přímo — nyní používáme seznam.
 * Bezpečné volat opakovaně (idempotentní).
 */
const migrateOldStorage = () => {
  const oldRoom = localStorage.getItem('rc_room');
  const oldSlot = localStorage.getItem('rc_slot');
  if (oldRoom && oldSlot) {
    addToRoomList(oldRoom, oldSlot, '');
    localStorage.removeItem('rc_room');
    localStorage.removeItem('rc_slot');
  }
};
