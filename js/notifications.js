/**
 * RoomChat — notifications.js
 * ─────────────────────────────────────────────
 * Zodpovědnost:
 *   • Service Worker registrace + komunikace
 *   • Push subscription (Web Push API)
 *   • App Badge API (počet nepřečtených)
 *   • Nerušit (DnD) — časový i trvalý
 *   • Notification permission flow
 *   • Zvukové notifikace
 *
 * Závislosti: config.js, utils.js, storage.js
 * ─────────────────────────────────────────────
 */


// ─────────────────────────────────────────────
// SERVICE WORKER
// ─────────────────────────────────────────────

/** Registrovaný ServiceWorkerRegistration objekt */
var _swReg = null;

/** Počet nepřečtených zpráv pro badge */
var _unreadCount = 0;

/**
 * Inicializuje Service Worker.
 * Registruje /sw.js a nastaví listener pro SW zprávy.
 * Volá se při startu aplikace (před DOMContentLoaded).
 */
async function _initSW() {
  if (!('serviceWorker' in navigator)) return;

  try {
    _swReg = await navigator.serviceWorker.register('/sw.js');

    // Listener pro zprávy ze SW (např. klik na notifikaci)
    navigator.serviceWorker.addEventListener('message', e => {
      if (e.data?.type === 'NOTIFICATION_CLICK' && e.data.roomId) {
        if (S.roomId === e.data.roomId) {
          // Jsme již ve správné místnosti → jen fokus
          window.focus();
        } else {
          // Přejdi do jiné místnosti
          window.location.href = '/?room=' + e.data.roomId;
        }
      }
    });

  } catch (e) {
    console.warn('Service Worker registrace selhala:', e);
  }
}

// Inicializuj SW ihned při načtení skriptu
_initSW();

// Vyčisti badge při fokus / visibility change
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    _clearBadge();
    _unreadCount = 0;
  }
});
window.addEventListener('focus', () => {
  _clearBadge();
  _unreadCount = 0;
});


// ─────────────────────────────────────────────
// PUSH SUBSCRIPTION
// ─────────────────────────────────────────────

/**
 * Konvertuje VAPID public key z base64url na Uint8Array.
 * Vyžadováno pro pushManager.subscribe().
 * @param {string} base64String
 * @returns {Uint8Array}
 * @private
 */
function _urlBase64ToUint8(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64  = (base64String + padding)
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from(Array.from(raw).map(c => c.charCodeAt(0)));
}

/**
 * Přihlásí uživatele k push notifikacím.
 * Uloží subscription do Firestore slotu.
 * Bezpečné volat opakovaně — vrátí existující subscription pokud existuje.
 * @returns {Promise<PushSubscription|null>}
 */
async function _subscribePush() {
  if (!_swReg) return null;

  try {
    let sub = await _swReg.pushManager.getSubscription();

    if (!sub) {
      sub = await _swReg.pushManager.subscribe({
        userVisibleOnly:      true,
        applicationServerKey: _urlBase64ToUint8(VAPID_PUBLIC_KEY),
      });
    }

    // Ulož subscription do Firestore (pro server-side push)
    if (S.roomId && S.slotId && sub) {
      const subJson = JSON.stringify(sub.toJSON());
      db.collection('rooms').doc(S.roomId)
        .collection('slots').doc(S.slotId)
        .update({ pushSub: subJson })
        .catch(() => {});
    }

    return sub;

  } catch (e) {
    console.warn('Push subscription selhala:', e);
    return null;
  }
}

/**
 * Odhlásí push subscription a vymaže ji z Firestore.
 * Volá se při odhlášení nebo zrušení notifikací.
 */
async function _unsubscribePush() {
  if (!_swReg) return;

  try {
    const sub = await _swReg.pushManager.getSubscription();
    if (sub) await sub.unsubscribe();

    // Vymaž ze Firestore
    if (S.roomId && S.slotId) {
      db.collection('rooms').doc(S.roomId)
        .collection('slots').doc(S.slotId)
        .update({ pushSub: null })
        .catch(() => {});
    }
  } catch (e) {
    console.warn('Unsubscribe selhalo:', e);
  }
}


// ─────────────────────────────────────────────
// APP BADGE API
// ─────────────────────────────────────────────

/**
 * Vymaže badge na ikoně aplikace.
 * Pošle zprávu do SW + volá Badge API přímo.
 */
function _clearBadge() {
  // Přes SW
  if (_swReg?.active) {
    _swReg.active.postMessage({ type: 'CLEAR_BADGE' });
  }
  // Přímé Badge API
  if ('clearAppBadge' in navigator) {
    navigator.clearAppBadge().catch(() => {});
  }
}

/**
 * Nastaví číselný badge na ikoně aplikace.
 * @param {number} count - počet (0 = vymaž)
 */
function _setBadge(count) {
  // Přes SW
  if (_swReg?.active) {
    _swReg.active.postMessage({ type: 'SET_BADGE', count });
  }
  // Přímé Badge API
  if ('setAppBadge' in navigator) {
    if (count > 0) {
      navigator.setAppBadge(count).catch(() => {});
    } else {
      navigator.clearAppBadge().catch(() => {});
    }
  }
}


// ─────────────────────────────────────────────
// NOTIFICATION PERMISSION
// ─────────────────────────────────────────────

/**
 * Vyžádá povolení pro notifikace.
 * Po povolení automaticky přihlásí push subscription.
 * @returns {Promise<boolean>} true = povoleno
 */
async function requestNotifPerm() {
  if (!('Notification' in window)) return false;

  if (Notification.permission === 'default') {
    await Notification.requestPermission();
  }

  const granted = Notification.permission === 'granted';

  if (granted) {
    // Přihlas push v pozadí
    _subscribePush().catch(() => {});
  }

  return granted;
}

/**
 * Přepne notifikace — pokud nejsou povoleny, požádá o povolení.
 * Pokud jsou blokovány, informuje uživatele.
 * Volá se z tlačítka v sidebaru.
 */
async function toggleNotifications() {
  if (!('Notification' in window)) {
    toast('Notifikace nejsou v tomto prohlížeči podporovány', 'err');
    return;
  }

  switch (Notification.permission) {
    case 'granted':
      toast('Notifikace jsou zapnuty ✓', 'ok');
      break;

    case 'denied':
      toast('Notifikace blokovány — povol je v nastavení prohlížeče', 'err');
      break;

    case 'default': {
      const ok = await requestNotifPerm();
      toast(ok ? 'Notifikace povoleny ✓' : 'Notifikace nebyly povoleny');
      break;
    }
  }

  renderSidebarActions();
}


// ─────────────────────────────────────────────
// PUSH NOTIFIKACE (in-app)
// ─────────────────────────────────────────────

/**
 * Zobrazí push notifikaci pro novou zprávu.
 * Respektuje DnD nastavení.
 * Nenotifikuje pokud je appka viditelná a má fokus (kromě @mention).
 *
 * @param {boolean} [mentionMe=false] - true pokud zpráva obsahuje @moje_jméno
 */
async function showPup(mentionMe = false) {
  if (isDnd()) return;
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;

  // Nenotifikuj při aktivní appce (kromě přímé zmínky)
  if (
    document.visibilityState === 'visible' &&
    document.hasFocus() &&
    !mentionMe
  ) return;

  _unreadCount++;
  _setBadge(_unreadCount);

  const title = 'PUP';
  const body  = mentionMe
    ? 'Někdo tě zmínil! 📣'
    : 'Nová zpráva v místnosti';
  const tag   = 'rc-' + Date.now();

  try {
    if (_swReg) {
      // Přes SW — spolehlivější, funguje i při zavřené appce
      await _swReg.showNotification(title, {
        body,
        icon:    '/icons/icon-192x192.png',
        badge:   '/icons/icon-72x72.png',
        tag,
        silent:  true,
        vibrate: [200, 100, 200],
        data:    {
          url:    location.href,
          roomId: S.roomId,
        },
      });
    } else {
      // Fallback — přímá Notification API
      new Notification(title, { body, tag, silent: true });
    }
  } catch (e) {
    // Ignorujeme — notifikace není kritická
  }
}


// ─────────────────────────────────────────────
// ZVUKOVÉ NOTIFIKACE
// ─────────────────────────────────────────────

/**
 * Přehraje krátký zvukový signál pro novou zprávu.
 * Používá Web Audio API — nevyžaduje audio soubor.
 * Tiché pokud je zapnutý DnD.
 */
function playNotifSound() {
  if (isDnd()) return;

  try {
    const ctx  = new (window.AudioContext || window.webkitAudioContext)();
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.type            = 'sine';
    osc.frequency.value = 800;

    gain.gain.setValueAtTime(0.12, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);

    osc.start();
    osc.stop(ctx.currentTime + 0.25);

  } catch {
    // Web Audio API není dostupné — ignorujeme
  }
}


// ─────────────────────────────────────────────
// NERUŠIT (DnD)
// ─────────────────────────────────────────────

/**
 * Nastaví nebo zruší režim Nerušit.
 * @param {number} ms - délka DnD v ms (0 = zrušit)
 */
function setDnd(ms) {
  if (ms === 0) {
    localStorage.removeItem('rc_dnd');
    toast('Nerušit vypnuto 🔔');
  } else {
    localStorage.setItem('rc_dnd', String(Date.now() + ms));
    const label = _dndLabel(ms);
    toast(`Nerušit zapnuto — ${label} 🔕`);
  }
  renderSidebarActions();
}

/**
 * Nastaví DnD do rána (7:00 následujícího dne).
 */
function dndUntilMorning() {
  const morning = new Date();
  morning.setDate(morning.getDate() + 1);
  morning.setHours(7, 0, 0, 0);
  setDnd(morning.getTime() - Date.now());
}

/**
 * Vrátí čitelný popis délky DnD.
 * @param {number} ms
 * @returns {string}
 * @private
 */
function _dndLabel(ms) {
  if (ms <= 3_600_000)   return '1 hodina';
  if (ms <= 14_400_000)  return '4 hodiny';
  return 'do rána';
}
