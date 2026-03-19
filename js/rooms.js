/**
 * RoomChat — rooms.js
 * ─────────────────────────────────────────────
 * Zodpovědnost:
 *   • Vytvoření nové místnosti
 *   • Připojení kódem
 *   • Room switcher (admin)
 *   • Správa místnosti za běhu (admin):
 *     - zamknout/odemknout
 *     - změna max. uživatelů
 *     - změna hesla
 *     - změna doby mazání zpráv
 *     - invite-only toggle
 *   • Prodloužení a smazání místnosti
 *   • Pozvánky (vytvoření, zobrazení)
 *   • Kick uživatele
 *
 * Závislosti: config.js, utils.js, storage.js, auth.js
 * ─────────────────────────────────────────────
 */


// ─────────────────────────────────────────────
// VYTVOŘENÍ MÍSTNOSTI
// ─────────────────────────────────────────────

/**
 * Vytvoří novou místnost v Firestore.
 * Aktuální uživatel se stane adminem.
 * Volá se z tlačítka na #s-create screenu.
 */
async function createRoom() {
  const name     = $('cr-name').value.trim();
  const username = $('cr-user').value.trim();
  const password = $('cr-pass').value;
  const maxUsers = parseInt($('cr-max').value);
  const invOnly  = $('cr-inv').checked;

  hideErr('cr-err');

  if (!name)     return showErr('cr-err', 'Zadej název místnosti');
  if (!username) return showErr('cr-err', 'Zadej přezdívku');

  const roomId = rnd(6);
  const color  = rndColor();
  const now    = firebase.firestore.Timestamp.now();
  const expiresAt = new firebase.firestore.Timestamp(
    now.seconds + ROOM_LIFETIME,
    now.nanoseconds
  );

  try {
    // 1. Vytvoř dokument místnosti
    await db.collection('rooms').doc(roomId).set({
      name,
      password,
      maxUsers,
      inviteOnly:   invOnly,
      locked:       false,
      createdAt:    now,
      expiresAt,
      adminSession: S.sid,
      adminKey:     ADMIN_HASH,
      theme:        'dark',
      customBg:     null,
      msgLifetime:  DEFAULT_MSG_LIFETIME,
      pinnedMsg:    null,
      callActive:   false,
      callParticipants: [],
    });

    // 2. Vytvoř slot pro admina
    const slotRef = db.collection('rooms').doc(roomId).collection('slots').doc();
    await slotRef.set({
      username,
      color,
      sessionId:   S.sid,
      isAdmin:     true,
      online:      true,
      lastSeen:    now,
      typing:      false,
      typingAt:    null,
      joinedAt:    now,
      inviteToken: null,
      pushSub:     null,
    });

    // 3. Systémová zpráva
    await db.collection('rooms').doc(roomId)
      .collection('messages').add({
        text:      `${username} vytvořil/a místnost`,
        isSystem:  true,
        timestamp: firebase.firestore.FieldValue.serverTimestamp(),
      });

    // 4. Nastav globální stav
    S.roomId   = roomId;
    S.slotId   = slotRef.id;
    S.username = username;
    S.color    = color;
    S.isAdmin  = true;
    S.roomData = { name, password, maxUsers, inviteOnly: invOnly, expiresAt, locked: false, msgLifetime: DEFAULT_MSG_LIFETIME };

    addToRoomList(roomId, slotRef.id, name);
    setUsername(username);
    $('btn-switch-room').style.display = '';
    history.replaceState({}, '', '?room=' + roomId);
    enterChat();

  } catch (e) {
    showErr('cr-err', 'Chyba: ' + e.message);
  }
}


// ─────────────────────────────────────────────
// PŘIPOJENÍ KÓDEM
// ─────────────────────────────────────────────

/**
 * Multi-step join flow:
 *   Krok 1 (code):     ověří existenci místnosti
 *   Krok 2 (password): ověří heslo (pokud je nastaveno)
 *   Krok 3 (username): vytvoří slot a vstoupí
 */
async function joinByCode() {
  const code = $('jn-code').value.trim().toUpperCase();
  hideErr('jn-err');
  $('jn-info')?.classList.remove('show');

  // ── Krok 1: Hledání místnosti ──
  if (S.jnState === 'code') {
    if (code.length < 4) return showErr('jn-err', 'Zadej kód místnosti');

    try {
      const snap = await db.collection('rooms').doc(code).get();
      if (!snap.exists) return showErr('jn-err', 'Místnost nenalezena');

      const data = snap.data();
      if (Date.now() > data.expiresAt.toDate().getTime()) {
        return showErr('jn-err', 'Tato místnost vypršela');
      }
      if (data.locked) {
        return showErr('jn-err', 'Místnost je uzamčena — nelze se připojit');
      }
      if (data.inviteOnly) {
        return showErr('jn-err', 'Místnost je pouze na pozvánku');
      }

      // Zkontroluj kapacitu
      const slotsSnap = await db.collection('rooms').doc(code)
        .collection('slots').get();
      if (slotsSnap.size >= data.maxUsers) {
        return showErr('jn-err', 'Místnost je plná');
      }

      S.jnRoomData = { ...data, id: code };

      if (data.password) {
        // Vyžaduje heslo
        $('jn-pass').style.display = '';
        $('jn-btn').textContent    = 'Ověřit →';
        S.jnState = 'password';
      } else {
        showInfo('jn-info', `Místnost „${data.name}" nalezena!`);
        $('jn-user').style.display = '';
        $('jn-btn').textContent    = 'Vstoupit →';
        S.jnState = 'username';
      }

    } catch (e) {
      showErr('jn-err', 'Chyba: ' + e.message);
    }
    return;
  }

  // ── Krok 2: Ověření hesla ──
  if (S.jnState === 'password') {
    if ($('jn-pass').value !== S.jnRoomData.password) {
      return showErr('jn-err', 'Špatné heslo');
    }
    showInfo('jn-info', 'Heslo správné!');
    $('jn-user').style.display = '';
    $('jn-btn').textContent    = 'Vstoupit →';
    S.jnState = 'username';
    return;
  }

  // ── Krok 3: Vstup s přezdívkou ──
  if (S.jnState === 'username') {
    const username = $('jn-user').value.trim();
    if (!username) return showErr('jn-err', 'Zadej přezdívku');

    // Znovu zkontroluj kapacitu (race condition)
    const slotsSnap = await db.collection('rooms').doc(S.jnRoomData.id)
      .collection('slots').get();
    if (slotsSnap.size >= S.jnRoomData.maxUsers) {
      return showErr('jn-err', 'Místnost je plná');
    }

    const color = rndColor();
    const now   = firebase.firestore.Timestamp.now();

    try {
      const slotRef = db.collection('rooms').doc(S.jnRoomData.id)
        .collection('slots').doc();
      await slotRef.set({
        username,
        color,
        sessionId:   S.sid,
        isAdmin:     false,
        online:      true,
        lastSeen:    now,
        typing:      false,
        typingAt:    null,
        joinedAt:    now,
        inviteToken: null,
        pushSub:     null,
      });

      await db.collection('rooms').doc(S.jnRoomData.id)
        .collection('messages').add({
          text:      `${username} se připojil/a`,
          isSystem:  true,
          timestamp: firebase.firestore.FieldValue.serverTimestamp(),
        });

      S.roomId   = S.jnRoomData.id;
      S.slotId   = slotRef.id;
      S.username = username;
      S.color    = color;
      S.isAdmin  = false;
      S.roomData = S.jnRoomData;

      addToRoomList(S.jnRoomData.id, slotRef.id, S.jnRoomData.name);
      setUsername(username);
      history.replaceState({}, '', '?room=' + S.jnRoomData.id);

      // Reset join state pro příští použití
      S.jnState    = 'code';
      S.jnRoomData = null;

      enterChat();

    } catch (e) {
      showErr('jn-err', 'Chyba: ' + e.message);
    }
  }
}


// ─────────────────────────────────────────────
// ROOM SWITCHER (admin)
// ─────────────────────────────────────────────

/**
 * Zobrazí screen s přehledem všech místností admina.
 * Načítá místnosti z Firestore (admin query).
 */
async function showRoomSwitcher() {
  $('loader').style.display = 'none';
  show('s-rooms');

  const container = $('rooms-list');
  container.innerHTML =
    '<div style="color:var(--muted2);font-size:12px;text-align:center;padding:16px">Načítám…</div>';

  try {
    const seen = new Set();
    const docs = [];

    // Query 1: adminKey — funguje cross-device (stejný hash všude)
    try {
      const snap = await db.collection('rooms')
        .where('adminKey', '==', ADMIN_HASH).get();
      snap.docs.forEach(d => {
        if (!seen.has(d.id)) { seen.add(d.id); docs.push(d); }
      });
    } catch (e) {
      console.warn('[Rooms] adminKey query failed:', e.message);
    }

    // Query 2: adminSession — pro toto zařízení
    try {
      const snap = await db.collection('rooms')
        .where('adminSession', '==', S.sid).get();
      snap.docs.forEach(d => {
        if (!seen.has(d.id)) { seen.add(d.id); docs.push(d); }
      });
    } catch (e) {
      console.warn('[Rooms] adminSession query failed:', e.message);
    }

    // Query 3: záloha z localStorage — načti roomId ze storage a ověř v Firestore
    // Toto zachytí místnosti které nejsou v query výsledcích (jiné zařízení, starší formát)
    const storedRooms = getRoomList();
    for (const stored of storedRooms) {
      if (seen.has(stored.roomId)) continue;
      try {
        const snap = await db.collection('rooms').doc(stored.roomId).get();
        if (snap.exists) {
          const d = snap.data();
          // Ověř že jde o admin místnost
          if (d.adminKey === ADMIN_HASH || d.adminSession === S.sid) {
            seen.add(stored.roomId);
            docs.push(snap);
          }
        }
      } catch {}
    }

    // Seřaď od nejnovější
    docs.sort((a, b) =>
      (b.data().createdAt?.toDate?.() ?? 0) -
      (a.data().createdAt?.toDate?.() ?? 0)
    );

    container.innerHTML = '';

    if (!docs.length) {
      show('s-home');
      return;
    }

    const freshList = [];

    docs.forEach(doc => {
      const data    = doc.data();
      const expired = Date.now() > data.expiresAt.toDate().getTime();
      const msLeft  = data.expiresAt.toDate().getTime() - Date.now();
      const rem     = fmtCd(msLeft);
      const daysLeft = msLeft / 86_400_000;

      if (!expired) {
        const loc = getRoomList().find(r => r.roomId === doc.id);
        freshList.push({
          roomId: doc.id,
          slotId: loc?.slotId || null,
          name:   data.name,
          ts:     data.createdAt?.toDate?.().getTime() || 0,
        });
      }

      // Karta místnosti
      const card = document.createElement('div');
      card.className = 'room-card' + (expired ? ' expired' : '');

      const warnExpiry = !expired && daysLeft < 3;

      card.innerHTML = `
        <div class="room-card-icon">💬</div>
        <div class="room-card-info">
          <div class="room-card-name">
            ${escHtml(data.name || doc.id)}
            <span style="font-size:9px;font-weight:800;background:var(--accent-glow);color:var(--accent);border:1px solid var(--accent)44;border-radius:4px;padding:1px 6px;margin-left:6px">admin</span>
            ${data.locked ? '<span style="font-size:9px;font-weight:800;color:var(--orange);margin-left:4px">🔒</span>' : ''}
          </div>
          <div class="room-card-meta">
            ${expired
              ? '⚠️ vypršela'
              : (warnExpiry ? '⚠️ ' : '') + 'vyprší za ' + rem +
                (data.password ? ' · 🔑' : '') +
                (data.inviteOnly ? ' · 📨' : '')
            }
          </div>
        </div>
        ${warnExpiry
          ? `<button
               onclick="event.stopPropagation();extendRoomById('${doc.id}')"
               style="height:30px;padding:0 10px;border-radius:8px;background:#f0a03033;border:1px solid #f0a03066;color:var(--orange);cursor:pointer;font-size:11px;font-weight:700;flex-shrink:0">
               +30d
             </button>`
          : ''}
        <button
          data-rdel="${doc.id}"
          onclick="event.stopPropagation();deleteRoom('${doc.id}')"
          style="width:30px;height:30px;border-radius:8px;background:#ff5c5c11;border:1px solid #ff5c5c33;color:var(--red);cursor:pointer;font-size:14px;display:flex;align-items:center;justify-content:center;flex-shrink:0">
          🗑️
        </button>
        ${!expired ? '<div style="color:var(--muted);font-size:18px">›</div>' : ''}
      `;

      if (!expired) {
        card.onclick = () => _adminEnterRoom(doc.id, doc.data());
      }
      container.appendChild(card);
    });

    saveRoomList(freshList);

  } catch (e) {
    container.innerHTML =
      `<div style="color:var(--red);font-size:12px;text-align:center;padding:8px">Chyba: ${e.message}</div>`;
  }
}

/**
 * Admin vstoupí do vybrané místnosti.
 * Pokud má tam slot → použije ho. Jinak vytvoří nový.
 * @param {string} roomId
 * @param {Object} roomData - data z Firestore
 */
async function _adminEnterRoom(roomId, roomData) {
  try {
    $('loader').style.display = '';

    // Zkus najít existující slot tohoto SID
    const ss = await db.collection('rooms').doc(roomId)
      .collection('slots')
      .where('sessionId', '==', S.sid)
      .limit(1)
      .get();

    if (!ss.empty) {
      const sdoc = ss.docs[0];
      const slot = sdoc.data();
      S.roomId   = roomId;
      S.slotId   = sdoc.id;
      S.username = slot.username;
      S.color    = slot.color;
      S.isAdmin  = true;
      S.roomData = roomData;
      addToRoomList(roomId, sdoc.id, roomData.name);
      $('btn-switch-room').style.display = '';
      history.replaceState({}, '', '?room=' + roomId);
      enterChat();
      return;
    }

    // Vytvoř nový slot pro admina
    const username = getUsername() || 'Admin';
    const color    = rndColor();
    const now      = firebase.firestore.Timestamp.now();
    const slotRef  = db.collection('rooms').doc(roomId).collection('slots').doc();

    await slotRef.set({
      username,
      color,
      sessionId:   S.sid,
      isAdmin:     true,
      online:      true,
      lastSeen:    now,
      typing:      false,
      typingAt:    null,
      joinedAt:    now,
      inviteToken: null,
      pushSub:     null,
    });

    S.roomId   = roomId;
    S.slotId   = slotRef.id;
    S.username = username;
    S.color    = color;
    S.isAdmin  = true;
    S.roomData = roomData;

    addToRoomList(roomId, slotRef.id, roomData.name);
    $('btn-switch-room').style.display = '';
    history.replaceState({}, '', '?room=' + roomId);
    enterChat();

  } catch (e) {
    $('loader').style.display = 'none';
    toast('Chyba vstupu: ' + e.message, 'err');
  }
}

/**
 * Opustí aktuální místnost a přejde na room switcher.
 * Vyčistí veškeré listenery a stav.
 */
function goToRooms() {
  // Ukonči případný hovor
  if (typeof endCall === 'function') endCall();
  if (typeof cleanupMediaBlobUrls === 'function') cleanupMediaBlobUrls();

  // Odhlás Firestore listenery
  S.unsubs.forEach(u => u());
  S.unsubs = [];

  // Ukonči DM listener
  if (S.dmUnsub) { S.dmUnsub(); S.dmUnsub = null; }

  // Zastav timery
  clearInterval(S.heartbeat);
  clearInterval(S.countdown);
  clearTimeout(S.activityTO);

  // Reset stavu
  S.roomId    = null;
  S.slotId    = null;
  S.isAdmin   = false;
  S.roomData  = null;
  S.username  = null;
  S.color     = null;
  S.replyTo   = null;
  S.dmTarget  = null;
  S.pinnedMsg = null;

  // Reset UI
  $('btn-switch-room').style.display = 'none';
  $('sb-inv').style.display          = 'none';
  $('mob-sb-inv').style.display      = 'none';
  $('room-expiry-banner').classList.remove('show');
  $('pin-bar').style.display         = 'none';

  showRoomSwitcher();
}


// ─────────────────────────────────────────────
// PRODLOUŽENÍ A SMAZÁNÍ MÍSTNOSTI
// ─────────────────────────────────────────────

/**
 * Prodlouží expiraci aktuální místnosti o 30 dní.
 * Volá se z expiry banneru.
 */
async function adminFindRoom() {
  const inp  = $('admin-room-search');
  const err  = $('admin-room-search-err');
  const code = inp?.value.trim().toUpperCase();

  if (err) err.classList.remove('show');
  if (!code || code.length < 4) {
    if (err) { err.textContent = 'Zadej kód místnosti'; err.classList.add('show'); }
    return;
  }

  try {
    const snap = await db.collection('rooms').doc(code).get();

    if (!snap.exists) {
      if (err) { err.textContent = 'Místnost nenalezena'; err.classList.add('show'); }
      return;
    }

    const data = snap.data();

    if (data.adminKey !== ADMIN_HASH) {
      if (err) { err.textContent = 'Tato místnost není tvoje'; err.classList.add('show'); }
      return;
    }

    if (Date.now() > data.expiresAt.toDate().getTime()) {
      if (err) { err.textContent = 'Místnost vypršela'; err.classList.add('show'); }
      return;
    }

    addToRoomList(code, null, data.name);
    if (inp) inp.value = '';
    toast(`Vstupuji do "${data.name}"…`);
    await _adminEnterRoom(code, data);

  } catch (e) {
    if (err) { err.textContent = 'Chyba: ' + e.message; err.classList.add('show'); }
  }
}

async function extendRoom() {
  const rid = S.roomId ||
    new URLSearchParams(window.location.search).get('room')?.toUpperCase();
  if (!rid) return;

  try {
    const snap = await db.collection('rooms').doc(rid).get();
    if (!snap.exists) return toast('Místnost nenalezena', 'err');

    const exp    = snap.data().expiresAt.toDate();
    const newExp = new firebase.firestore.Timestamp(
      Math.floor(exp.getTime() / 1000) + ROOM_LIFETIME,
      0
    );

    await db.collection('rooms').doc(rid).update({ expiresAt: newExp });
    if (S.roomData) S.roomData.expiresAt = newExp;

    dismissExpiryBanner();
    $('h-dot')?.classList.remove('warn');
    toast('Místnost prodloužena o 30 dní ✓', 'ok');
    updateHeaderBadge();

  } catch (e) {
    toast('Chyba: ' + e.message, 'err');
  }
}

/**
 * Prodlouží expiraci místnosti podle ID (z room switcheru).
 * @param {string} roomId
 */
async function extendRoomById(roomId) {
  try {
    const snap = await db.collection('rooms').doc(roomId).get();
    if (!snap.exists) return toast('Nenalezena', 'err');

    const exp    = snap.data().expiresAt.toDate();
    const newExp = new firebase.firestore.Timestamp(
      Math.floor(exp.getTime() / 1000) + ROOM_LIFETIME,
      0
    );

    await db.collection('rooms').doc(roomId).update({ expiresAt: newExp });
    toast('Prodloužena o 30 dní ✓', 'ok');
    showRoomSwitcher();

  } catch (e) {
    toast('Chyba: ' + e.message, 'err');
  }
}

/**
 * Smaže místnost i všechny podkolekce.
 * Vyžaduje double-confirm (klik → potvrdit → klik).
 * @param {string} roomId
 */
async function deleteRoom(roomId) {
  const btn = document.querySelector(`[data-rdel="${roomId}"]`);

  // První klik → žádej potvrzení
  if (btn && !btn.dataset.confirmed) {
    btn.dataset.confirmed = '1';
    btn.textContent       = '✓?';
    btn.style.background  = '#ff5c5c33';
    btn.style.borderColor = '#ff5c5c88';
    btn.style.width       = '42px';
    setTimeout(() => {
      if (btn.dataset.confirmed) {
        delete btn.dataset.confirmed;
        btn.textContent       = '🗑️';
        btn.style.width       = '30px';
        btn.style.background  = '#ff5c5c11';
        btn.style.borderColor = '#ff5c5c33';
      }
    }, 3_000);
    return;
  }

  // Druhý klik → smaž
  try {
    const batch = db.batch();
    const [msgs, slots, reads, sigs] = await Promise.all([
      db.collection('rooms').doc(roomId).collection('messages').limit(500).get(),
      db.collection('rooms').doc(roomId).collection('slots').limit(500).get(),
      db.collection('rooms').doc(roomId).collection('reads').limit(500).get(),
      db.collection('rooms').doc(roomId).collection('callSignals').limit(100).get(),
    ]);

    msgs.forEach(d  => batch.delete(d.ref));
    slots.forEach(d => batch.delete(d.ref));
    reads.forEach(d => batch.delete(d.ref));
    sigs.forEach(d  => batch.delete(d.ref));
    batch.delete(db.collection('rooms').doc(roomId));

    await batch.commit();
    removeFromRoomList(roomId);
    toast('Místnost smazána', 'ok');
    showRoomSwitcher();

  } catch (e) {
    toast('Chyba: ' + e.message, 'err');
  }
}


// ─────────────────────────────────────────────
// ADMIN — NASTAVENÍ MÍSTNOSTI ZA BĚHU
// ─────────────────────────────────────────────

/**
 * Přepne uzamčení místnosti (nikdo nový se nemůže připojit).
 */
async function toggleRoomLock() {
  if (!S.isAdmin || !S.roomId) return;
  const newVal = !S.roomData?.locked;
  try {
    await db.collection('rooms').doc(S.roomId).update({ locked: newVal });
    if (S.roomData) S.roomData.locked = newVal;
    const cb = $('rs-lock-cb');
    if (cb) cb.checked = newVal;
    toast(newVal ? '🔒 Místnost uzamčena' : '🔓 Místnost odemčena', 'ok');
    // Aktualizuj lock banner v chatu
    _updateLockBanner();
  } catch (e) {
    toast('Chyba: ' + e.message, 'err');
  }
}

/**
 * Přepne invite-only mód místnosti.
 */
async function toggleInviteOnly() {
  if (!S.isAdmin || !S.roomId) return;
  const newVal = !S.roomData?.inviteOnly;
  try {
    await db.collection('rooms').doc(S.roomId).update({ inviteOnly: newVal });
    if (S.roomData) S.roomData.inviteOnly = newVal;
    const cb = $('rs-invonly-cb');
    if (cb) cb.checked = newVal;
    toast(newVal ? '📨 Pouze na pozvánku' : '🔓 Otevřená místnost', 'ok');
  } catch (e) {
    toast('Chyba: ' + e.message, 'err');
  }
}

/**
 * Nastaví maximální počet uživatelů (2–10).
 * @param {string|number} value
 */
async function setMaxUsers(value) {
  if (!S.isAdmin || !S.roomId) return;
  const max = parseInt(value);
  if (isNaN(max) || max < 2 || max > 10) return;

  try {
    await db.collection('rooms').doc(S.roomId).update({ maxUsers: max });
    if (S.roomData) S.roomData.maxUsers = max;
    toast(`Max. uživatelů: ${max} ✓`, 'ok');
  } catch (e) {
    toast('Chyba: ' + e.message, 'err');
  }
}

/**
 * Nastaví dobu mazání zpráv.
 * @param {string|number} value - ms (0 = nikdy)
 */
async function setMsgLifetime(value) {
  if (!S.isAdmin || !S.roomId) return;
  const ms = parseInt(value);
  if (isNaN(ms)) return;

  try {
    await db.collection('rooms').doc(S.roomId).update({ msgLifetime: ms });
    if (S.roomData) S.roomData.msgLifetime = ms;
    const label = MSG_LIFETIME_OPTIONS.find(o => o.value === ms)?.label || `${ms}ms`;
    toast(`Mazání zpráv: ${label} ✓`, 'ok');
  } catch (e) {
    toast('Chyba: ' + e.message, 'err');
  }
}

/**
 * Změní heslo místnosti.
 * Prázdné heslo = bez hesla.
 */
async function changeRoomPassword() {
  if (!S.isAdmin || !S.roomId) return;
  const newPass = $('rs-password').value;

  try {
    await db.collection('rooms').doc(S.roomId).update({ password: newPass });
    if (S.roomData) S.roomData.password = newPass;
    $('rs-password').value = '';

    // Aktualizuj lock badge v headeru
    const lockBadge = $('h-lock');
    if (lockBadge) lockBadge.style.display = newPass ? '' : 'none';

    toast(newPass ? 'Heslo změněno ✓' : 'Heslo odstraněno ✓', 'ok');
  } catch (e) {
    toast('Chyba: ' + e.message, 'err');
  }
}

/**
 * Aktualizuje lock banner v chatu.
 * @private
 */
function _updateLockBanner() {
  const banner = $('lock-banner');
  if (!banner) return;
  banner.classList.toggle('show', !!S.roomData?.locked);
}


// ─────────────────────────────────────────────
// POZVÁNKY
// ─────────────────────────────────────────────

/**
 * Otevře modal pro vytvoření nové pozvánky.
 */
function openNewInvModal() {
  $('ni-name').value = '';
  hideErr('ni-err');
  openM('m-new-inv');
}

/**
 * Vytvoří nový invite slot v Firestore.
 * Slot bude mít inviteToken ale žádné username dokud se nepřipojí.
 */
async function createInvite() {
  const name = $('ni-name').value.trim();
  hideErr('ni-err');
  if (!name) return showErr('ni-err', 'Zadej jméno slotu');

  // Zkontroluj kapacitu
  const slotsSnap = await db.collection('rooms').doc(S.roomId)
    .collection('slots').get();
  if (slotsSnap.size >= S.roomData.maxUsers) {
    return showErr('ni-err', 'Místnost je plná');
  }

  const token = rnd(12).toLowerCase();

  try {
    await db.collection('rooms').doc(S.roomId)
      .collection('slots').doc().set({
        name,
        username:    null,
        color:       null,
        sessionId:   null,
        isAdmin:     false,
        online:      false,
        lastSeen:    null,
        typing:      false,
        typingAt:    null,
        joinedAt:    null,
        inviteToken: token,
        pushSub:     null,
      });

    closeM('m-new-inv');
    showCopyInvModal(token, name);

  } catch (e) {
    showErr('ni-err', 'Chyba: ' + e.message);
  }
}

/**
 * Zobrazí modal s URL pozvánky ke zkopírování.
 * @param {string} token - invite token
 * @param {string} name  - jméno slotu
 */
function showCopyInvModal(token, name) {
  const url = `${location.origin}${location.pathname}?room=${S.roomId}&invite=${token}`;
  $('ci-title').textContent = `Pozvánka pro ${name}`;
  $('ci-url').textContent   = url;
  openM('m-copy-inv');
}

/**
 * Zkopíruje URL pozvánky do schránky.
 */
function doCopyInv() {
  copyToClipboard($('ci-url').textContent, 'Odkaz zkopírován! 📋');
}

/**
 * Zkopíruje kód místnosti do schránky.
 */
function copyCode() {
  copyToClipboard(S.roomId, `Kód ${S.roomId} zkopírován!`);
}


// ─────────────────────────────────────────────
// KICK UŽIVATELE
// ─────────────────────────────────────────────

/**
 * Vyhodí uživatele z místnosti (smaže jeho slot).
 * Vyžaduje double-confirm.
 * @param {string} slotId - ID slotu k vyhození
 */
async function kickUser(slotId) {
  const btn = document.querySelector(`.kick-btn[data-kick="${slotId}"]`);

  // První klik → žádej potvrzení
  if (btn && !btn.dataset.confirmed) {
    btn.dataset.confirmed = '1';
    btn.textContent       = '✓?';
    btn.style.background  = '#ff5c5c33';
    setTimeout(() => {
      if (btn.dataset.confirmed) {
        delete btn.dataset.confirmed;
        btn.textContent      = '✕';
        btn.style.background = '';
      }
    }, 2_500);
    return;
  }

  try {
    const slot = S.slots[slotId];
    await db.collection('rooms').doc(S.roomId)
      .collection('slots').doc(slotId).delete();

    if (slot?.username) {
      await db.collection('rooms').doc(S.roomId)
        .collection('messages').add({
          text:      `${slot.username} byl/a odstraněn/a adminem`,
          isSystem:  true,
          timestamp: firebase.firestore.FieldValue.serverTimestamp(),
        });
    }
    toast('Uživatel vyhozen', 'ok');

  } catch (e) {
    toast('Chyba: ' + e.message, 'err');
  }
}


// ─────────────────────────────────────────────
// EXPIRY BANNER
// ─────────────────────────────────────────────

/**
 * Zkontroluje expiraci místnosti a zobrazí banner pokud < 3 dny.
 * Volá se při vstupu do chatu.
 */
function checkRoomExpiry() {
  if (!S.isAdmin || !S.roomData?.expiresAt) return;
  const exp    = S.roomData.expiresAt.toDate
    ? S.roomData.expiresAt.toDate()
    : new Date(S.roomData.expiresAt);
  const msLeft = exp.getTime() - Date.now();
  const days   = msLeft / 86_400_000;

  if (days < 3 && !sessionStorage.getItem('reb_d')) {
    $('reb-text').textContent = days < 1
      ? '⚠️ Místnost vyprší za méně než 24 hodin!'
      : `⚠️ Místnost vyprší za ${Math.ceil(days)} dny`;
    $('h-dot')?.classList.add('warn');
    $('room-expiry-banner').classList.add('show');
  }
}

/**
 * Skryje expiry banner a uloží dismiss do session storage.
 */
function dismissExpiryBanner() {
  $('room-expiry-banner').classList.remove('show');
  sessionStorage.setItem('reb_d', '1');
}

/**
 * Aktualizuje countdown badge v headeru.
 */
function updateHeaderBadge() {
  const exp = S.roomData?.expiresAt?.toDate?.();
  if (!exp) return;

  const ms   = exp.getTime() - Date.now();
  const days = ms / 86_400_000;

  if (S.isAdmin && days < 3) {
    $('h-badge-text').textContent = `⚠️ vyprší za ${fmtCd(ms)}`;
    $('h-dot')?.classList.add('warn');
  } else {
    $('h-badge-text').textContent = `${todayMsgCount} zpráv dnes · 🗑️ po 24h`;
    $('h-dot')?.classList.remove('warn');
  }
}
