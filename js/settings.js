/**
 * RoomChat — settings.js
 * ─────────────────────────────────────────────
 * Zodpovědnost:
 *   • Témata (předdefinovaná + vlastní pozadí)
 *   • Nahrání pozadí z galerie (canvas komprese)
 *   • Admin nastavení místnosti (modal)
 *   • Uživatelská nastavení (modal)
 *   • Změna vlastní přezdívky za běhu
 *   • Vlastní sada reakcí (emoji picker)
 *   • Automatické odhlášení po neaktivitě
 *   • PWA banner (přidat na plochu)
 *
 * Závislosti: config.js, utils.js, storage.js,
 *             rooms.js, auth.js
 * ─────────────────────────────────────────────
 */


// ─────────────────────────────────────────────
// TÉMATA
// ─────────────────────────────────────────────

/**
 * Definice dostupných témat.
 * id musí odpovídat CSS data-theme hodnotám.
 */
const THEMES = [
  { id: 'dark',   label: 'Tmavé',   bg: '#0d0f12',                             icon: '🌑' },
  { id: 'darker', label: 'Černé',   bg: '#050608',                             icon: '⚫' },
  { id: 'blue',   label: 'Modré',   bg: '#080d1a',                             icon: '💙' },
  { id: 'purple', label: 'Fialové', bg: '#0e0818',                             icon: '💜' },
  { id: 'forest', label: 'Les',     bg: '#080f08',                             icon: '🌿' },
  { id: 'custom', label: 'Vlastní', bg: 'linear-gradient(135deg,#0d0f12,#5c6bff)', icon: '🖼️' },
];

/**
 * Inicializuje téma při startu aplikace.
 * Volá se co nejdříve (v config.js nebo head).
 */
function initTheme() {
  const saved = getStoredTheme();
  document.documentElement.setAttribute('data-theme', saved);

  // Obnov vlastní pozadí pokud bylo uloženo
  const bg = getStoredCustomBg();
  if (bg && saved === 'custom') {
    _applyBgToDom(bg);
  }
}

/**
 * Aplikuje téma — uloží, nastaví DOM, sdílí přes Firestore.
 * @param {string} themeId
 */
function applyTheme(themeId) {
  // Vyčisti vlastní pozadí pokud přepínáme na jiné téma
  if (themeId !== 'custom') {
    const cm = $('chat-main');
    if (cm) {
      cm.classList.remove('has-bg');
      cm.style.removeProperty('--chat-bg-img');
    }
  }

  document.documentElement.setAttribute('data-theme', themeId);
  setStoredTheme(themeId);
  renderThemeGrid();

  // Sdílej téma přes Firestore (vidí všichni v místnosti)
  if (S.roomId) {
    db.collection('rooms').doc(S.roomId)
      .update({ theme: themeId, customBg: null })
      .catch(() => {});
  }
}

/**
 * Aplikuje vlastní pozadí (URL nebo data URL).
 * @param {string} url - http URL nebo data URL z galerie
 */
function applyCustomBg(url) {
  if (!url || url === '(nahrán z galerie)') {
    // Prázdné pole URL → nic nedělej (pozadí z galerie se nastavuje přímo)
    return;
  }
  _applyBgToDom(url);
  setStoredCustomBg(url);
  setStoredTheme('custom');
  document.documentElement.setAttribute('data-theme', 'custom');
  renderThemeGrid();

  // Sdílej přes Firestore
  if (S.roomId) {
    db.collection('rooms').doc(S.roomId)
      .update({ theme: 'custom', customBg: url })
      .catch(() => {});
  }
}

/**
 * Odstraní vlastní pozadí a vrátí tmavé téma.
 */
function clearCustomBg() {
  const cm = $('chat-main');
  if (cm) {
    cm.classList.remove('has-bg');
    cm.style.removeProperty('--chat-bg-img');
  }
  clearStoredCustomBg();
  applyTheme('dark');

  const inp = $('custom-bg-url');
  if (inp) inp.value = '';
}

/**
 * Aplikuje pozadí do DOM chat-main elementu.
 * @param {string} url
 * @private
 */
function _applyBgToDom(url) {
  const cm = $('chat-main');
  if (!cm) return;
  cm.classList.add('has-bg');
  cm.style.setProperty('--chat-bg-img', `url('${url}')`);
}

/**
 * Renderuje grid témat v modal okně.
 * Zvýrazní aktuálně aktivní téma.
 */
function renderThemeGrid() {
  const grid = $('theme-grid');
  if (!grid) return;

  const current = document.documentElement.getAttribute('data-theme') || 'dark';

  grid.innerHTML = THEMES.map(t => `
    <div class="theme-sw ${current === t.id ? 'active' : ''}"
         onclick="applyTheme('${t.id}')">
      <div class="theme-sw-bg" style="background:${t.bg}">
        ${t.icon}
      </div>
      <div class="theme-sw-lbl">${t.label}</div>
    </div>
  `).join('');
}


// ─────────────────────────────────────────────
// NAHRÁNÍ POZADÍ Z GALERIE
// ─────────────────────────────────────────────

/**
 * Otevře file picker a nahraje obrázek z galerie jako pozadí.
 * Komprimuje na max 640px a JPEG 55% kvalitu.
 * Výsledek uloží jako data URL (bez externího serveru).
 */
function openGalleryPicker() {
  const input = document.createElement('input');
  input.type   = 'file';
  input.accept = 'image/*';

  input.onchange = async e => {
    const file = e.target.files[0];
    if (!file) return;

    // Limit velikosti vstupního souboru
    if (file.size > 15 * 1024 * 1024) {
      toast('Obrázek je příliš velký (max 15 MB)', 'err');
      return;
    }

    try {
      toast('Zpracovávám obrázek…');
      const dataUrl = await _compressImage(file, 640, 0.55);

      // Aplikuj a ulož
      _applyBgToDom(dataUrl);
      setStoredCustomBg(dataUrl);
      setStoredTheme('custom');
      document.documentElement.setAttribute('data-theme', 'custom');
      renderThemeGrid();

      // Sdílej přes Firestore (data URL — pozor na 1MB limit Firestore doc)
      // Pokud je příliš velké, ulož jen lokálně
      if (dataUrl.length < 900_000) {
        if (S.roomId) {
          db.collection('rooms').doc(S.roomId)
            .update({ theme: 'custom', customBg: dataUrl })
            .catch(() => {});
        }
      } else {
        toast('Pozadí uloženo lokálně (příliš velké pro sdílení)', 'ok');
      }

      const inp = $('custom-bg-url');
      if (inp) inp.value = '(nahrán z galerie)';

      toast('Pozadí nastaveno 🖼️', 'ok');

    } catch (e) {
      toast('Chyba zpracování obrázku: ' + e.message, 'err');
    }
  };

  input.click();
}

/**
 * Komprimuje obrázek pomocí Canvas API.
 * @param {File}   file     - vstupní soubor
 * @param {number} maxSize  - max délka delší strany v px
 * @param {number} quality  - JPEG kvalita 0–1
 * @returns {Promise<string>} data URL (JPEG)
 * @private
 */
function _compressImage(file, maxSize, quality) {
  return new Promise((resolve, reject) => {
    const img    = new Image();
    const reader = new FileReader();

    reader.onerror = reject;
    reader.onload  = e2 => {
      img.onerror = reject;
      img.onload  = () => {
        let w = img.width;
        let h = img.height;

        // Zachovej poměr stran
        if (w > h) {
          if (w > maxSize) { h = Math.round(h * maxSize / w); w = maxSize; }
        } else {
          if (h > maxSize) { w = Math.round(w * maxSize / h); h = maxSize; }
        }

        const canvas = document.createElement('canvas');
        canvas.width  = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = e2.target.result;
    };
    reader.readAsDataURL(file);
  });
}


// ─────────────────────────────────────────────
// ADMIN — NASTAVENÍ MÍSTNOSTI (MODAL)
// ─────────────────────────────────────────────

/**
 * Otevře admin modal nastavení místnosti.
 * Předvyplní aktuální hodnoty ze S.roomData.
 */
function openRoomSettings() {
  if (!S.isAdmin) return;

  const rd = S.roomData || {};

  // Přístup
  const lockCb   = $('rs-lock-cb');
  const invCb    = $('rs-invonly-cb');
  if (lockCb) lockCb.checked = !!rd.locked;
  if (invCb)  invCb.checked  = !!rd.inviteOnly;

  // Max uživatelů
  const maxSel = $('rs-max-users');
  if (maxSel) maxSel.value = String(rd.maxUsers ?? 5);

  // Mazání zpráv
  const ltSel = $('rs-msg-lifetime');
  if (ltSel) {
    // Najdi nejbližší option
    const lifetime = rd.msgLifetime ?? DEFAULT_MSG_LIFETIME;
    const opts     = Array.from(ltSel.options).map(o => parseInt(o.value));
    const closest  = opts.reduce((a, b) =>
      Math.abs(b - lifetime) < Math.abs(a - lifetime) ? b : a
    );
    ltSel.value = String(closest);
  }

  openM('m-room-settings');
  closeMobSidebar();
}


// ─────────────────────────────────────────────
// UŽIVATELSKÁ NASTAVENÍ (MODAL)
// ─────────────────────────────────────────────

/**
 * Otevře modal uživatelských nastavení.
 * Předvyplní aktuální přezdívku a auto-logout nastavení.
 */
function openUserSettings() {
  // Předvyplň přezdívku
  const nameInp = $('us-name');
  if (nameInp) nameInp.value = S.username || '';

  // Předvyplň auto-logout
  const alSel = $('us-auto-logout');
  if (alSel) alSel.value = String(getAutoLogoutMins());

  // Renderuj reaction picker
  renderReactionPicker();

  openM('m-user-settings');
  closeMobSidebar();
}

/**
 * Změní vlastní přezdívku uživatele.
 * Aktualizuje Firestore slot i lokální stav.
 */
async function changeOwnUsername() {
  const inp      = $('us-name');
  const newName  = inp?.value.trim();

  if (!newName) {
    toast('Zadej přezdívku', 'err');
    return;
  }
  if (newName === S.username) {
    toast('Přezdívka je stejná', 'err');
    return;
  }
  if (newName.length > 20) {
    toast('Přezdívka je příliš dlouhá (max 20 znaků)', 'err');
    return;
  }

  const oldName = S.username;

  try {
    // Aktualizuj Firestore slot
    await db.collection('rooms').doc(S.roomId)
      .collection('slots').doc(S.slotId)
      .update({ username: newName });

    // Systémová zpráva o změně
    await db.collection('rooms').doc(S.roomId)
      .collection('messages').add({
        text:      `${oldName} změnil/a přezdívku na ${newName}`,
        isSystem:  true,
        timestamp: firebase.firestore.FieldValue.serverTimestamp(),
      });

    // Aktualizuj lokální stav
    S.username = newName;
    setUsername(newName);

    toast('Přezdívka změněna ✓', 'ok');
    closeM('m-user-settings');

  } catch (e) {
    toast('Chyba: ' + e.message, 'err');
  }
}


// ─────────────────────────────────────────────
// VLASTNÍ REAKCE
// ─────────────────────────────────────────────

/**
 * Renderuje picker pro výběr vlastních reakcí.
 * Uživatel může vybrat max 10 emoji z ALL_REACTIONS.
 */
function renderReactionPicker() {
  const grid = $('custom-reactions-grid');
  if (!grid) return;

  const current = getMyReactions();

  grid.innerHTML = ALL_REACTIONS.map(emoji => `
    <div
      class="re-pick ${current.includes(emoji) ? 'selected' : ''}"
      onclick="toggleReactionPick('${emoji}')"
      title="${emoji}">
      ${emoji}
    </div>
  `).join('');
}

/**
 * Přepne výběr emoji reakce (přidá / odebere).
 * Max 10 vybraných emoji.
 * @param {string} emoji
 */
function toggleReactionPick(emoji) {
  let current = getMyReactions();

  if (current.includes(emoji)) {
    current = current.filter(e => e !== emoji);
  } else {
    if (current.length >= 10) {
      toast('Lze vybrat max. 10 reakcí', 'err');
      return;
    }
    current.push(emoji);
  }

  saveMyReactions(current);
  renderReactionPicker();
}

/**
 * Obnoví výchozí sadu reakcí.
 */
function resetReactions() {
  resetMyReactions();
  renderReactionPicker();
  toast('Reakce obnoveny ✓', 'ok');
}


// ─────────────────────────────────────────────
// AUTOMATICKÉ ODHLÁŠENÍ
// ─────────────────────────────────────────────

/**
 * Nastaví dobu neaktivity pro auto-logout.
 * @param {string|number} mins - minuty (0 = vypnuto)
 */
function setAutoLogout(mins) {
  const m = parseInt(mins);
  setAutoLogoutMins(m);
  resetActivityTimer();

  toast(
    m === 0
      ? 'Automatické odhlášení vypnuto'
      : `Automatické odhlášení za ${m} min ✓`,
    'ok'
  );
}

/**
 * Resetuje timer automatického odhlášení.
 * Volá se při každé aktivitě uživatele (click, keypress, touch).
 * Volá se také při focus / visibilitychange.
 */
function resetActivityTimer() {
  clearTimeout(S.activityTO);

  const mins = getAutoLogoutMins();
  if (!mins || !S.roomId) return;

  S.activityTO = setTimeout(() => {
    toast('Automatické odhlášení po neaktivitě ⏱️', 'err');
    setTimeout(() => goToRooms(), 1_500);
  }, mins * 60_000);
}

// Aktivita uživatele resetuje timer
['click', 'keypress', 'touchstart', 'mousemove'].forEach(ev => {
  document.addEventListener(ev, () => {
    if (S.roomId) resetActivityTimer();
  }, { passive: true });
});


// ─────────────────────────────────────────────
// PWA — PŘIDAT NA PLOCHU
// ─────────────────────────────────────────────

/** Uložený beforeinstallprompt event */
let _deferredPrompt = null;

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  _deferredPrompt = e;
  if (!isPwaDismissed()) showPwaBanner('android');
});

/**
 * Detekuje iOS Safari (pro ruční install instrukce).
 * @returns {boolean}
 */
function isIos() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) &&
    !window.navigator.standalone;
}

/**
 * Zobrazí PWA install banner.
 * @param {string} type - 'android' | 'ios'
 */
function showPwaBanner(type) {
  const sub = $('pwa-sub');
  if (sub && type === 'ios') {
    sub.textContent = 'Safari → Sdílet → Přidat na plochu';
  }
  $('pwa-banner')?.classList.add('show');
}

/**
 * Skryje PWA banner a uloží dismiss příznak.
 */
function pwaDismiss() {
  $('pwa-banner')?.classList.remove('show');
  setPwaDismissed();
}

/**
 * Spustí nativní install prompt nebo zobrazí instrukce.
 */
function addToHomeScreen() {
  if (_deferredPrompt) {
    _deferredPrompt.prompt();
    _deferredPrompt.userChoice.then(() => {
      _deferredPrompt = null;
      pwaDismiss();
    });
  } else if (isIos()) {
    toast('Safari → Sdílet → Přidat na plochu 📱');
  } else {
    toast('Aplikace je již nainstalována nebo použij Chrome');
  }
  renderSidebarActions();
}
