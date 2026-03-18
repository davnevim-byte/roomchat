/**
 * RoomChat — auth.js
 * ─────────────────────────────────────────────
 * Zodpovědnost:
 *   • Boot sekvence aplikace (DOMContentLoaded)
 *   • Entry screen flow (přezdívka → vstup)
 *   • Rejoin existující místnosti
 *   • Invite flow (vstup přes pozvánkový odkaz)
 *   • Admin autentizace (heslo → hash)
 *   • PIN ochrana vstupu
 *
 * Závislosti: config.js, utils.js, storage.js, rooms.js
 * ─────────────────────────────────────────────
 */


// ─────────────────────────────────────────────
// BOOT — vstupní bod aplikace
// ─────────────────────────────────────────────

/**
 * Hlavní boot funkce — volána při DOMContentLoaded.
 * Rozhoduje kam uživatele nasměrovat na základě:
 *   1. URL parametrů (?room=, ?invite=)
 *   2. Uložených místností v localStorage
 *   3. Admin session
 */
window.addEventListener('DOMContentLoaded', async () => {
  // Inicializace session ID
  S.sid = getSid();

  // Migrace dat ze starého formátu
  migrateOldStorage();

  // Aplikuj uložené téma co nejdříve (zabrání bliknutí)
  _applyStoredTheme();

  const params   = new URLSearchParams(window.location.search);
  const roomParam  = params.get('room')?.toUpperCase() || null;
  const inviteParam = params.get('invite') || null;

  // Admin session — vyžaduje re-autentizaci při každém spuštění
  if (isAdminStored()) {
    $('loader').style.display = '';
    const adminBtn = $('admin-entry-btn');
    if (adminBtn) adminBtn.style.display = '';
    _setupAdminTap();

    // Zobraz entry screen a pak požádej o admin heslo
    show('s-entry');
    $('loader').style.display = 'none';

    _showAdminPromptWithCallback(async () => {
      $('loader').style.display = '';
      try {
        await _bootProceed(roomParam, inviteParam);
      } catch (e) {
        console.error('Boot error:', e);
        show('s-home');
        $('loader').style.display = 'none';
      }
    });
    return;
  }

  // Standardní boot
  try {
    await _bootProceed(roomParam, inviteParam);
  } catch (e) {
    console.error('Boot error:', e);
    saveRoomList([]);
    show('s-entry');
    $('loader').style.display = 'none';
  }
});

/**
 * Aplikuje uložené téma ihned při startu.
 * Odděleno od settings.js aby fungoval ještě před načtením ostatních souborů.
 */
function _applyStoredTheme() {
  const theme = getStoredTheme();
  document.documentElement.setAttribute('data-theme', theme);
}

/**
 * Rozhodovací logika bootu — kam nasměrovat uživatele.
 * @param {string|null} roomParam   - ?room= z URL
 * @param {string|null} inviteParam - ?invite= z URL
 */
async function _bootProceed(roomParam, inviteParam) {
  // Případ 1: URL obsahuje room + invite token → invite flow
  if (roomParam && inviteParam) {
    await _prepareInviteEntry(roomParam, inviteParam);
    return;
  }

  // Případ 2: URL obsahuje jen room ID → pokus o rejoin
  if (roomParam) {
    const stored = getRoomList().find(r => r.roomId === roomParam);
    if (stored?.slotId) {
      await tryRejoin(roomParam, stored.slotId, null, true);
    } else {
      // Neznámá místnost → přejdi na join screen s předvyplněným kódem
      $('jn-code').value = roomParam;
      show('s-join');
      $('loader').style.display = 'none';
    }
    return;
  }

  // Případ 3: Admin session → room switcher nebo home
  if (S.isAdminSession) {
    $('loader').style.display = 'none';
    const list = getRoomList();
    if (list.length === 0) {
      show('s-home');
    } else {
      await showRoomSwitcher();
    }
    return;
  }

  // Případ 4: Jedna uložená místnost → nabídni přímý vstup
  const list = getRoomList();
  if (list.length === 1) {
    S.entryContext = {
      type:   'rejoin',
      roomId: list[0].roomId,
      slotId: list[0].slotId,
    };
    const savedUsername = getUsername();
    if (savedUsername) {
      // Zkus tichý rejoin — pokud selže, zobraz entry screen
      await tryRejoin(list[0].roomId, list[0].slotId, savedUsername, false);
      return;
    }
    $('entry-desc').textContent = 'Uprav přezdívku nebo rovnou vstup';
  }

  // Případ 5: Více místností → entry screen (bez kontextu)
  show('s-entry');
  $('loader').style.display = 'none';
  _setupAdminTap();
}


// ─────────────────────────────────────────────
// REJOIN — návrat do existující místnosti
// ─────────────────────────────────────────────

/**
 * Pokusí se znovu připojit uživatele do místnosti.
 * Kontroluje existenci místnosti i slotu v Firestore.
 *
 * @param {string}      roomId           - ID místnosti
 * @param {string}      slotId           - ID slotu uživatele
 * @param {string|null} usernameOverride - přezdívka (null = použij uloženou)
 * @param {boolean}     silentMode       - true = při chybě jen toast, ne redirect
 */
async function tryRejoin(roomId, slotId, usernameOverride, silentMode) {
  try {
    const [slotSnap, roomSnap] = await Promise.all([
      db.collection('rooms').doc(roomId).collection('slots').doc(slotId).get(),
      db.collection('rooms').doc(roomId).get(),
    ]);

    // Místnost neexistuje nebo vypršela
    if (!roomSnap.exists) {
      throw new Error('Místnost neexistuje');
    }
    const roomData = roomSnap.data();
    if (Date.now() > roomData.expiresAt.toDate().getTime()) {
      throw new Error('Místnost vypršela');
    }

    // Slot neexistuje
    if (!slotSnap.exists) {
      throw new Error('Slot neexistuje');
    }
    const slotData = slotSnap.data();

    // Urči přezdívku
    const username = usernameOverride || slotData.username || getUsername();
    if (!username) {
      // Nemáme přezdívku → zobraz entry screen
      S.entryContext = { type: 'rejoin', roomId, slotId };
      S.roomData = { ...roomData };
      show('s-entry');
      $('loader').style.display = 'none';
      return;
    }

    // Místnost je uzamčena a nejde o rejoin existujícího slotu
    if (roomData.locked && slotData.sessionId !== S.sid) {
      throw new Error('Místnost je uzamčena');
    }

    // Zkontroluj PIN před vstupem
    if (hasPin(roomId, slotId)) {
      show('s-entry');
      $('loader').style.display = 'none';
      showPinVerify(
        roomId,
        slotId,
        // onSuccess → pokračuj ve vstupu
        async () => {
          $('loader').style.display = '';
          await _finalizeRejoin(roomId, slotId, slotData, roomData, username);
        },
        // onSkip → vstup bez PINu (PIN se neuplatní)
        async () => {
          $('loader').style.display = '';
          await _finalizeRejoin(roomId, slotId, slotData, roomData, username);
        }
      );
      return;
    }

    await _finalizeRejoin(roomId, slotId, slotData, roomData, username);

  } catch (e) {
    // Vyčisti neplatný záznam
    removeFromRoomList(roomId);
    S.entryContext = null;

    if (silentMode) {
      show('s-home');
      $('loader').style.display = 'none';
      toast('Místnost nenalezena nebo vypršela', 'err');
    } else {
      show('s-entry');
      $('loader').style.display = 'none';
    }
  }
}

/**
 * Dokončí rejoin — aktualizuje Firestore a vstoupí do chatu.
 * @private
 */
async function _finalizeRejoin(roomId, slotId, slotData, roomData, username) {
  // Aktualizuj slot v Firestore pokud se něco změnilo
  const updates = {};
  if (slotData.sessionId !== S.sid)   updates.sessionId = S.sid;
  if (username !== slotData.username) updates.username   = username;
  if (Object.keys(updates).length > 0) {
    await db.collection('rooms').doc(roomId)
      .collection('slots').doc(slotId)
      .update(updates);
  }

  // Nastav globální stav
  S.roomId   = roomId;
  S.slotId   = slotId;
  S.username = username;
  S.color    = slotData.color;
  S.isAdmin  = S.isAdminSession && roomData.adminSession === S.sid;
  S.roomData = { ...roomData };

  // Aktualizuj lokální seznam místností
  addToRoomList(roomId, slotId, roomData.name);
  setUsername(username);

  if (S.isAdmin) $('btn-switch-room').style.display = '';
  history.replaceState({}, '', '?room=' + roomId);

  // Vstup do chatu
  enterChat();
}


// ─────────────────────────────────────────────
// ENTRY SCREEN — přezdívka a vstup
// ─────────────────────────────────────────────

/**
 * Handler tlačítka "Vstoupit" na entry screenu.
 * Zpracovává oba kontexty: invite i rejoin.
 */
async function entrySubmit() {
  const username = $('entry-user').value.trim();
  hideErr('entry-err');

  if (!username) {
    showErr('entry-err', 'Zadej přezdívku');
    return;
  }

  setUsername(username);
  const ctx = S.entryContext;

  if (!ctx) {
    showErr('entry-err', 'Žádná místnost k dispozici');
    return;
  }

  if (ctx.type === 'invite') {
    await _finalizeInviteJoin(username, ctx);
  } else if (ctx.type === 'rejoin') {
    await tryRejoin(ctx.roomId, ctx.slotId, username, false);
  }
}


// ─────────────────────────────────────────────
// INVITE FLOW — vstup přes pozvánkový odkaz
// ─────────────────────────────────────────────

/**
 * Připraví entry screen pro vstup přes pozvánku.
 * Validuje místnost a token v Firestore.
 *
 * @param {string} roomId - ID místnosti
 * @param {string} token  - invite token ze URL
 */
async function _prepareInviteEntry(roomId, token) {
  try {
    const [roomSnap, slotSnap] = await Promise.all([
      db.collection('rooms').doc(roomId).get(),
      db.collection('rooms').doc(roomId)
        .collection('slots')
        .where('inviteToken', '==', token)
        .limit(1)
        .get(),
    ]);

    // Validace místnosti
    if (!roomSnap.exists) {
      show('s-entry');
      toast('Místnost nenalezena', 'err');
      $('loader').style.display = 'none';
      return;
    }
    const roomData = roomSnap.data();
    if (Date.now() > roomData.expiresAt.toDate().getTime()) {
      show('s-entry');
      toast('Místnost vypršela', 'err');
      $('loader').style.display = 'none';
      return;
    }

    // Validace tokenu
    if (slotSnap.empty) {
      show('s-entry');
      toast('Neplatná pozvánka', 'err');
      $('loader').style.display = 'none';
      return;
    }

    const slotDoc  = slotSnap.docs[0];
    const slotData = slotDoc.data();

    // Slot již byl použit z tohoto zařízení → rovnou vstup
    if (slotData.sessionId === S.sid && slotData.username) {
      S.roomId   = roomId;
      S.slotId   = slotDoc.id;
      S.username = slotData.username;
      S.color    = slotData.color;
      S.isAdmin  = false;
      S.roomData = roomData;
      addToRoomList(roomId, slotDoc.id, roomData.name);
      history.replaceState({}, '', '?room=' + roomId);
      enterChat();
      return;
    }

    // Slot byl použit z jiného zařízení
    if (slotData.sessionId && slotData.sessionId !== S.sid && slotData.username) {
      show('s-entry');
      toast('Odkaz byl již použit z jiného zařízení', 'err');
      $('loader').style.display = 'none';
      return;
    }

    // Slot volný → připrav entry screen
    S.entryContext = {
      type:     'invite',
      roomId,
      token,
      slotId:   slotDoc.id,
      roomData,
    };
    S.roomData = roomData;

    $('entry-desc').textContent = `Připojuješ se do „${roomData.name}"`;
    const savedUsername = getUsername();
    if (savedUsername) $('entry-user').value = savedUsername;

    history.replaceState({}, '', '?room=' + roomId);
    show('s-entry');
    $('loader').style.display = 'none';
    _setupAdminTap();

  } catch (e) {
    show('s-entry');
    toast('Chyba: ' + e.message, 'err');
    $('loader').style.display = 'none';
  }
}

/**
 * Dokončí vstup přes pozvánku — zapíše username do slotu.
 * @param {string} username
 * @param {Object} ctx - entryContext
 */
async function _finalizeInviteJoin(username, ctx) {
  const { roomId, slotId, roomData } = ctx;
  const color = rndColor();
  const now   = firebase.firestore.Timestamp.now();

  try {
    await db.collection('rooms').doc(roomId)
      .collection('slots').doc(slotId)
      .update({
        username,
        color,
        sessionId: S.sid,
        online:    true,
        lastSeen:  now,
        joinedAt:  now,
      });

    await db.collection('rooms').doc(roomId)
      .collection('messages').add({
        text:      `${username} se připojil/a přes pozvánku`,
        isSystem:  true,
        timestamp: firebase.firestore.FieldValue.serverTimestamp(),
      });

    S.roomId   = roomId;
    S.slotId   = slotId;
    S.username = username;
    S.color    = color;
    S.isAdmin  = false;
    S.roomData = roomData;

    addToRoomList(roomId, slotId, roomData.name);
    setUsername(username);
    history.replaceState({}, '', '?room=' + roomId);
    enterChat();

  } catch (e) {
    showErr('entry-err', 'Chyba: ' + e.message);
  }
}


// ─────────────────────────────────────────────
// ADMIN AUTENTIZACE
// ─────────────────────────────────────────────

/**
 * Nastaví listener pro tajný tap na entry kartě.
 * 4 rychlé tapy → zobrazí admin prompt.
 * Bezpečnostní vrstva — admin heslo je stále vyžadováno.
 */
function _setupAdminTap() {
  const card = $('entry-card');
  if (!card) return;

  let taps = 0;
  let timer = null;

  const onTap = () => {
    taps++;
    clearTimeout(timer);
    timer = setTimeout(() => { taps = 0; }, 800);
    if (taps >= 4) {
      taps = 0;
      _showAdminPrompt();
    }
  };

  card.addEventListener('click', onTap);
  card.addEventListener('touchend', e => {
    if (e.changedTouches.length === 1) onTap();
  }, { passive: true });
}

/**
 * Zobrazí prompt pro zadání admin hesla.
 * Po úspěchu přesměruje na room switcher.
 */
function _showAdminPrompt() {
  _showAdminPromptWithCallback(async () => {
    const list = getRoomList();
    if (list.length === 0) {
      show('s-home');
    } else {
      $('loader').style.display = '';
      await showRoomSwitcher();
    }
  });
}

/**
 * Zobrazí prompt pro zadání admin hesla s custom callback.
 * @param {Function|null} onSuccess - volá se po úspěšném ověření
 */
function _showAdminPromptWithCallback(onSuccess) {
  const pw = prompt('🔐 Admin heslo:');
  if (!pw) return;

  hashStr(pw).then(hash => {
    if (hash === ADMIN_HASH) {
      setAdminStored();
      S.isAdminSession = true;

      const adminBtn = $('admin-entry-btn');
      if (adminBtn) adminBtn.style.display = '';

      toast('✓ Admin aktivován', 'ok');

      if (onSuccess) {
        setTimeout(onSuccess, 300);
      }
    } else {
      toast('Špatné heslo', 'err');
    }
  });
}


// ─────────────────────────────────────────────
// PIN MODAL
// ─────────────────────────────────────────────

/**
 * Interní stav PIN modalu.
 * @private
 */
const _pin = {
  buffer:   '',        // aktuálně zadané číslice
  mode:     'verify',  // 'verify' | 'setup'
  onSuccess: null,     // callback po úspěšném zadání
  onSkip:    null,     // callback při přeskočení
};

/**
 * Zobrazí PIN modal pro ověření vstupu.
 * @param {string}        roomId    - ID místnosti
 * @param {string}        slotId    - ID slotu
 * @param {Function}      onSuccess - volá se po správném PINu
 * @param {Function|null} onSkip    - volá se při přeskočení (null = nelze přeskočit)
 */
function showPinVerify(roomId, slotId, onSuccess, onSkip) {
  _pin.buffer    = '';
  _pin.mode      = 'verify';
  _pin.roomId    = roomId;
  _pin.slotId    = slotId;
  _pin.onSuccess = onSuccess;
  _pin.onSkip    = onSkip;

  $('pin-entry-desc').textContent = 'Zadej PIN pro vstup do místnosti:';
  $('pin-skip-btn').style.display = onSkip ? '' : 'none';
  hideErr('pin-entry-err');
  _updatePinDots();
  openM('m-pin-entry');
}

/**
 * Otevře PIN modal pro nastavení nového PINu.
 * Volá se z user settings.
 */
function setupUserPin() {
  _pin.buffer    = '';
  _pin.mode      = 'setup';
  _pin.roomId    = S.roomId;
  _pin.slotId    = S.slotId;
  _pin.onSuccess = pin => {
    savePin(S.roomId, S.slotId, pin);
    closeM('m-pin-entry');
    toast('PIN nastaven 🔐', 'ok');
  };
  _pin.onSkip = null;

  $('pin-entry-desc').textContent = 'Zadej nový 4-místný PIN:';
  $('pin-skip-btn').style.display = 'none';
  hideErr('pin-entry-err');
  _updatePinDots();
  openM('m-pin-entry');
}

/**
 * Handler přeskočení PINu.
 */
function skipPin() {
  closeM('m-pin-entry');
  _pin.buffer = '';
  if (_pin.onSkip) {
    const cb = _pin.onSkip;
    _pin.onSkip = null;
    cb();
  }
}

/**
 * Handler klávesnice PIN modalu.
 * @param {string} val - '0'-'9' | 'del' | 'ok'
 */
function pinInput(val) {
  hideErr('pin-entry-err');

  if (val === 'del') {
    _pin.buffer = _pin.buffer.slice(0, -1);
    _updatePinDots();
    return;
  }

  if (val === 'ok') {
    _pinConfirm();
    return;
  }

  // Číslice
  if (_pin.buffer.length >= 4) return;
  _pin.buffer += val;
  _updatePinDots();

  // Auto-potvrzení při verify módu po zadání 4. číslice
  if (_pin.buffer.length === 4 && _pin.mode === 'verify') {
    setTimeout(_pinConfirm, 80);
  }
}

/**
 * Potvrdí zadaný PIN (interní helper).
 * @private
 */
function _pinConfirm() {
  if (_pin.buffer.length < 4) {
    showErr('pin-entry-err', 'PIN musí mít 4 číslice');
    return;
  }

  if (_pin.mode === 'verify') {
    // Ověř PIN
    if (!verifyPin(_pin.roomId, _pin.slotId, _pin.buffer)) {
      showErr('pin-entry-err', 'Špatný PIN ❌');
      _pin.buffer = '';
      _updatePinDots();
      return;
    }
  }

  // Úspěch
  const cb  = _pin.onSuccess;
  const pin = _pin.buffer;
  _pin.buffer    = '';
  _pin.onSuccess = null;
  closeM('m-pin-entry');
  if (cb) cb(pin);
}

/**
 * Aktualizuje vizuální tečky PIN modalu.
 * @private
 */
function _updatePinDots() {
  for (let i = 0; i < 4; i++) {
    $('pd' + i)?.classList.toggle('filled', i < _pin.buffer.length);
  }
}

/**
 * Smaže PIN pro aktuálního uživatele.
 * Volá se z user settings.
 */
function clearUserPin() {
  if (!S.roomId || !S.slotId) return;
  clearPin(S.roomId, S.slotId);
  toast('PIN smazán ✓', 'ok');
}
