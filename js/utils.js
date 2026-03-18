/**
 * RoomChat — utils.js
 * ─────────────────────────────────────────────
 * Zodpovědnost:
 *   • Čisté pomocné funkce bez side-effectů
 *   • Žádné volání Firebase, žádná manipulace DOM screenů
 *   • Používáno všemi ostatními JS soubory
 *
 * Závislosti: config.js (S{} pro parseMentions)
 * ─────────────────────────────────────────────
 */


// ─────────────────────────────────────────────
// DOM ZKRATKY
// ─────────────────────────────────────────────

/**
 * Zkratka pro document.getElementById
 * @param {string} id
 * @returns {HTMLElement|null}
 */
const $ = id => document.getElementById(id);

/**
 * Zkratka pro document.querySelector
 * @param {string} sel
 * @returns {HTMLElement|null}
 */
const $q = sel => document.querySelector(sel);

/**
 * Zkratka pro document.querySelectorAll
 * @param {string} sel
 * @returns {NodeList}
 */
const $all = sel => document.querySelectorAll(sel);


// ─────────────────────────────────────────────
// GENERÁTORY
// ─────────────────────────────────────────────

/**
 * Generuje náhodný alfanumerický řetězec (uppercase)
 * @param {number} n - délka (výchozí 8)
 * @returns {string}
 */
const rnd = (n = 8) =>
  Math.random().toString(36).slice(2, 2 + n).toUpperCase();

/**
 * Vrátí náhodnou barvu z palety COLORS
 * @returns {string} #hex barva
 */
const rndColor = () =>
  COLORS[Math.floor(Math.random() * COLORS.length)];

/**
 * Vrátí iniciály z přezdívky (max 2 znaky, uppercase)
 * @param {string} name
 * @returns {string}
 */
const initials = name =>
  (name || '??').slice(0, 2).toUpperCase();


// ─────────────────────────────────────────────
// FORMÁTOVÁNÍ ČASU
// ─────────────────────────────────────────────

/**
 * Formátuje Firestore Timestamp nebo Date na HH:MM
 * @param {firebase.firestore.Timestamp|Date|null} ts
 * @returns {string}
 */
const fmtTime = ts => {
  if (!ts) return '';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleTimeString('cs', { hour: '2-digit', minute: '2-digit' });
};

/**
 * Formátuje timestamp na čitelný datum+čas.
 * Dnes → "dnes HH:MM", včera → "včera HH:MM", jinak "D.M. HH:MM"
 * @param {firebase.firestore.Timestamp|Date|null} ts
 * @returns {string}
 */
const fmtDate = ts => {
  if (!ts) return '';
  const d   = ts.toDate ? ts.toDate() : new Date(ts);
  const now = new Date();

  if (d.toDateString() === now.toDateString()) {
    return 'dnes ' + d.toLocaleTimeString('cs', { hour: '2-digit', minute: '2-digit' });
  }

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) {
    return 'včera ' + d.toLocaleTimeString('cs', { hour: '2-digit', minute: '2-digit' });
  }

  return (
    d.toLocaleDateString('cs', { day: 'numeric', month: 'numeric' }) +
    ' ' +
    d.toLocaleTimeString('cs', { hour: '2-digit', minute: '2-digit' })
  );
};

/**
 * Formátuje milisekundy na čitelný countdown.
 * Příklad: 90061000 → "1d 1h", 3661000 → "1h 01m"
 * @param {number} ms - zbývající milisekundy
 * @returns {string}
 */
const fmtCd = ms => {
  if (ms <= 0) return 'vypršela';
  const d = Math.floor(ms / 86_400_000);
  const h = Math.floor((ms % 86_400_000) / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return d > 0
    ? `${d}d ${h}h`
    : `${h}h ${String(m).padStart(2, '0')}m`;
};

/**
 * Formátuje sekundy na čitelnou expiraci zprávy.
 * Příklad: 30 → "30s", 300 → "5m", 3600 → "1h"
 * @param {number} s - sekundy
 * @returns {string|null} null pokud s <= 0
 */
const fmtExp = s => {
  if (!s || s <= 0) return null;
  if (s < 60)       return `${s}s`;
  if (s < 3_600)    return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3_600)}h`;
};


// ─────────────────────────────────────────────
// STAV UŽIVATELE
// ─────────────────────────────────────────────

/**
 * Vrátí true pokud je slot považován za online.
 * Threshold: lastSeen < 50 sekund.
 * @param {Object} slot - data slotu z Firestore
 * @returns {boolean}
 */
const isOnline = slot => {
  if (!slot.lastSeen) return false;
  const t = slot.lastSeen.toDate
    ? slot.lastSeen.toDate()
    : new Date(slot.lastSeen);
  return Date.now() - t.getTime() < 50_000;
};

/**
 * Vrátí aktuální lifetime zpráv místnosti (ms).
 * Pokud není nastaveno, použije DEFAULT_MSG_LIFETIME.
 * @returns {number}
 */
const getMsgLifetime = () =>
  S.roomData?.msgLifetime ?? DEFAULT_MSG_LIFETIME;


// ─────────────────────────────────────────────
// BEZPEČNOST
// ─────────────────────────────────────────────

/**
 * Vrátí SHA-256 hash stringu jako hex string.
 * Asynchronní — používá Web Crypto API.
 * @param {string} str
 * @returns {Promise<string>}
 */
const hashStr = async str => {
  const buf = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(str)
  );
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
};


// ─────────────────────────────────────────────
// TEXT ZPRACOVÁNÍ
// ─────────────────────────────────────────────

/**
 * Escapuje HTML speciální znaky (XSS ochrana).
 * Vždy volat před vložením user contentu do innerHTML.
 * @param {string} str
 * @returns {string}
 */
const escHtml = str =>
  (str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * Parsuje @mention v textu zprávy a obalí je <span> elementy.
 * - @vlastní_username → .mention-me (zvýrazněná)
 * - @jiný_username    → .mention-hi
 * Volá escHtml interně — bezpečné pro innerHTML.
 * @param {string} text - surový text zprávy
 * @returns {string} HTML string
 */
const parseMentions = text => {
  if (!text) return '';
  const esc = escHtml(text);
  return esc.replace(/@(\w+)/g, (match, name) => {
    const cls = name === S.username ? 'mention-me' : 'mention-hi';
    return `<span class="${cls}">${match}</span>`;
  });
};


// ─────────────────────────────────────────────
// UI HELPERS
// ─────────────────────────────────────────────

/**
 * Přepne aktivní screen aplikace.
 * Skryje všechny .screen elementy, zobrazí cílový.
 * Schová expiry banner pokud nejsme v chatu.
 * @param {string} id - ID screenu (např. 's-chat', 's-home')
 */
const show = id => {
  $all('.screen').forEach(s => s.classList.remove('active'));
  $(id)?.classList.add('active');
  if (id !== 's-chat') {
    $('room-expiry-banner')?.classList.remove('show');
  }
};

/**
 * Zobrazí chybovou hlášku v elementu s daným ID.
 * Element musí mít třídu .err
 * @param {string} id - ID error elementu
 * @param {string} msg - text chyby
 */
const showErr = (id, msg) => {
  const el = $(id);
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
};

/**
 * Skryje chybovou hlášku.
 * @param {string} id - ID error elementu
 */
const hideErr = id => {
  $(id)?.classList.remove('show');
};

/**
 * Zobrazí info hlášku v elementu s daným ID.
 * Element musí mít třídu .info
 * @param {string} id - ID info elementu
 * @param {string} msg - text info
 */
const showInfo = (id, msg) => {
  const el = $(id);
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
};

/**
 * Otevře modální okno (přidá třídu .show).
 * @param {string} id - ID modal overlay elementu
 */
const openM = id => {
  $(id)?.classList.add('show');
};

/**
 * Zavře modální okno (odebere třídu .show).
 * @param {string} id - ID modal overlay elementu
 */
const closeM = id => {
  $(id)?.classList.remove('show');
};

/**
 * Zobrazí toast notifikaci.
 * Automaticky zmizí po 3.2 sekundách.
 * @param {string} msg - text toastu
 * @param {string} [type=''] - 'ok' (zelená) | 'err' (červená) | '' (výchozí)
 */
const toast = (msg, type = '') => {
  const t = $('toast');
  if (!t) return;
  t.textContent = msg;
  t.className   = 'toast show' + (type ? ' ' + type : '');
  setTimeout(() => { t.className = 'toast'; }, 3_200);
};


// ─────────────────────────────────────────────
// CLIPBOARD
// ─────────────────────────────────────────────

/**
 * Zkopíruje text do schránky.
 * Fallback na execCommand pro starší prohlížeče.
 * @param {string} text
 * @param {string} [successMsg='Zkopírováno 📋'] - toast zpráva po úspěchu
 */
const copyToClipboard = async (text, successMsg = 'Zkopírováno 📋') => {
  try {
    await navigator.clipboard.writeText(text);
    toast(successMsg, 'ok');
  } catch {
    // Fallback pro starší prohlížeče / iOS
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    toast(successMsg, 'ok');
  }
};


// ─────────────────────────────────────────────
// LIGHTBOX
// ─────────────────────────────────────────────

/**
 * Otevře lightbox s obrázkem.
 * @param {string} url - URL obrázku
 */
const openLightbox = url => {
  const lb  = $('lightbox');
  const img = $('lb-img');
  if (!lb || !img) return;
  img.src = url;
  lb.classList.add('show');
};

/**
 * Zavře lightbox a vymaže src obrázku.
 */
const closeLightbox = () => {
  const lb  = $('lightbox');
  const img = $('lb-img');
  if (!lb || !img) return;
  lb.classList.remove('show');
  img.src = '';
};


// ─────────────────────────────────────────────
// ZVUK
// ─────────────────────────────────────────────

/**
 * Přehraje krátký notifikační pípnutí přes Web Audio API.
 * Tiché pokud je zapnutý DnD — kontrolu DnD dělá notifications.js.
 */
const playNotifSound = () => {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 800;
    osc.type = 'sine';
    gain.gain.setValueAtTime(0.12, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
    osc.start();
    osc.stop(ctx.currentTime + 0.25);
  } catch {
    // Web Audio API není dostupné — ignorujeme
  }
};


// ─────────────────────────────────────────────
// DEBOUNCE
// ─────────────────────────────────────────────

/**
 * Vrátí debounced verzi funkce.
 * @param {Function} fn
 * @param {number} delay - ms
 * @returns {Function}
 */
const debounce = (fn, delay) => {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
};

// ─────────────────────────────────────────────
// EARLY FALLBACKS
// Definovány zde brzy aby byly dostupné ihned.
// Plné verze jsou přepsány v notifications.js
// ─────────────────────────────────────────────

/**
 * Vrátí true pokud je aktivní režim Nerušit.
 * @returns {boolean}
 */
function isDnd() {
  return Date.now() < parseInt(localStorage.getItem('rc_dnd') || '0', 10);
}
