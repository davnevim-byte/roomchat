/**
 * RoomChat — sidebar.js
 * ─────────────────────────────────────────────
 * Zodpovědnost:
 *   • Render sidebaru (desktop + mobilní)
 *   • Seznam uživatelů (online/offline)
 *   • Lokální přezdívky (nick overlay)
 *   • Invite sloty (admin)
 *   • Akční tlačítka sidebaru
 *   • Mobilní sidebar (overlay + swipe)
 *   • Typing indikátor
 *
 * Závislosti: config.js, utils.js, storage.js,
 *             rooms.js, notifications.js
 * ─────────────────────────────────────────────
 */


// ─────────────────────────────────────────────
// HLAVNÍ RENDER SIDEBARU
// ─────────────────────────────────────────────

/**
 * Renderuje celý sidebar — online/offline uživatelé,
 * invite sloty a akční tlačítka.
 * Volá se při každé změně slots kolekce v Firestore.
 */
function renderSidebar() {
  const online  = [];
  const offline = [];

  Object.values(S.slots).forEach(slot => {
    if (!slot.username) return; // invite slot bez uživatele
    if (isOnline(slot)) online.push(slot);
    else offline.push(slot);
  });

  // ── Desktop sidebar ──
  _renderUserSection(
    $('sb-on-lbl'),
    $('sb-on'),
    online,
    `online — ${online.length}`
  );

  const offSec = $('sb-off-sec');
  if (offSec) {
    offSec.style.display = offline.length ? '' : 'none';
    _renderUserSection(
      $('sb-off-lbl'),
      $('sb-off'),
      offline,
      `offline — ${offline.length}`
    );
  }

  if (S.isAdmin) renderInvSlots();

  // ── Mobilní sidebar ──
  _renderUserSection(
    $('mob-sb-on-lbl'),
    $('mob-sb-on'),
    online,
    `online — ${online.length}`
  );

  const mobOffSec = $('mob-sb-off-sec');
  if (mobOffSec) {
    mobOffSec.style.display = offline.length ? '' : 'none';
    _renderUserSection(
      $('mob-sb-off-lbl'),
      $('mob-sb-off'),
      offline,
      `offline — ${offline.length}`
    );
  }

  if (S.isAdmin) renderMobInvSlots();
}

/**
 * Renderuje sekci uživatelů (online nebo offline).
 * @param {HTMLElement} lblEl  - element popisku sekce
 * @param {HTMLElement} listEl - kontejner pro uživatele
 * @param {Object[]}    slots  - pole slot objektů
 * @param {string}      label  - text popisku
 * @private
 */
function _renderUserSection(lblEl, listEl, slots, label) {
  if (lblEl) lblEl.textContent = label;
  if (!listEl) return;
  listEl.innerHTML = slots.map(slot => _userItemHtml(slot)).join('');
}

/**
 * Sestaví HTML pro jednoho uživatele v sidebaru.
 * @param {Object} slot - data slotu
 * @returns {string} HTML string
 * @private
 */
function _userItemHtml(slot) {
  const isMe   = slot.id === S.slotId;
  const online = isOnline(slot);
  const nick   = getNick(S.roomId, slot.id);

  // Typing indikátor (tečka)
  const isTyping = slot.typing &&
    slot.typingAt &&
    (Date.now() - (slot.typingAt.toDate?.().getTime() ?? 0)) < 5_000;

  const dotCls = isTyping ? 'd-typing' : (online ? 'd-on' : 'd-off');

  // Naposledy viděn (offline uživatelé)
  const lastSeen = !online && slot.lastSeen
    ? `<div class="u-lastseen">byl/a: ${fmtDate(slot.lastSeen)}</div>`
    : '';

  // Kick tlačítko (admin, ne já, ne jiný admin)
  const kickBtn = S.isAdmin && !isMe && !slot.isAdmin
    ? `<button
         class="kick-btn"
         data-kick="${slot.id}"
         onclick="event.stopPropagation();kickUser('${slot.id}')"
         title="Vyhostit">✕</button>`
    : '';

  // DM tlačítko (ne já)
  const dmBtn = !isMe
    ? `<button
         class="dm-btn"
         onclick="event.stopPropagation();openDmModal('${slot.id}')"
         title="Soukromá zpráva">💬</button>`
    : '';

  // Badge
  let badge = '';
  if (isMe)          badge = `<span class="badge">${slot.isAdmin ? 'admin' : 'ty'}</span>`;
  else if (slot.isAdmin) badge = `<span class="badge">admin</span>`;

  // Kliknutí → otevře nick modal (ne pro sebe)
  const clickHandler = !isMe
    ? `onclick="openNickModal('${slot.id}')" title="Přezdívka / akce"`
    : '';

  return `
    <div class="u-item${isMe ? ' me' : ''}" ${clickHandler}>
      <div class="u-av" style="background:${slot.color}">
        ${initials(slot.username)}
        <div class="sdot ${dotCls}"></div>
      </div>
      <div class="u-info">
        <div class="u-name">
          ${escHtml(slot.username)}
          ${nick ? `<span class="nick-tag">(${escHtml(nick)})</span>` : ''}
        </div>
        <div class="u-sub">
          ${isTyping ? 'píše…' : (online ? 'online' : 'offline')}
        </div>
        ${lastSeen}
      </div>
      ${badge}
      ${dmBtn}
      ${kickBtn}
    </div>
  `;
}


// ─────────────────────────────────────────────
// LOKÁLNÍ PŘEZDÍVKY
// ─────────────────────────────────────────────

/**
 * Otevře modal pro nastavení lokální přezdívky uživatele.
 * Lokální přezdívka je viditelná jen pro aktuálního uživatele.
 * @param {string} slotId - ID slotu
 */
function openNickModal(slotId) {
  const slot = S.slots[slotId];
  if (!slot) return;

  S.nickEditSlotId = slotId;
  $('nick-desc').textContent =
    `Přezdívka pro ${slot.username} — vidíš jen ty.`;
  $('nick-inp').value = getNick(S.roomId, slotId) || '';

  openM('m-nick');
  setTimeout(() => $('nick-inp').focus(), 200);
}

/**
 * Uloží nebo smaže lokální přezdívku.
 * @param {boolean} [del=false] - true = smaž přezdívku
 */
function saveNick(del = false) {
  if (!S.nickEditSlotId) return;
  const value = $('nick-inp').value.trim();

  if (del || !value) {
    setNick(S.roomId, S.nickEditSlotId, '');
    toast('Přezdívka smazána', 'ok');
  } else {
    setNick(S.roomId, S.nickEditSlotId, value);
    toast('Přezdívka uložena ✓', 'ok');
  }

  S.nickEditSlotId = null;
  closeM('m-nick');
  renderSidebar();
}


// ─────────────────────────────────────────────
// INVITE SLOTY (admin)
// ─────────────────────────────────────────────

/**
 * Renderuje invite sloty v desktop sidebaru.
 */
function renderInvSlots() {
  const total   = S.roomData?.maxUsers ?? 5;
  const used    = Object.values(S.slots).length;
  const invSlots = Object.values(S.slots).filter(s => s.inviteToken);

  $('sb-inv-list').innerHTML = _invSlotsHtml(invSlots);

  // Schovej tlačítko "nová pozvánka" pokud je plno
  const newBtn = $('sb-new-inv');
  if (newBtn) newBtn.style.display = used >= total ? 'none' : '';
}

/**
 * Renderuje invite sloty v mobilním sidebaru.
 */
function renderMobInvSlots() {
  const invSlots = Object.values(S.slots).filter(s => s.inviteToken);
  const el = $('mob-sb-inv-list');
  if (el) el.innerHTML = _invSlotsHtml(invSlots);
}

/**
 * Sestaví HTML pro invite sloty.
 * @param {Object[]} invSlots - sloty s inviteToken
 * @returns {string} HTML string
 * @private
 */
function _invSlotsHtml(invSlots) {
  if (!invSlots.length) {
    return `<div style="font-size:11px;color:var(--muted);padding:4px">
              Žádné pozvánky
            </div>`;
  }

  return invSlots.map(slot => {
    const active = !!(slot.username && slot.sessionId);
    const label  = active ? '✓ připojen/a' : 'čeká';

    return `
      <div
        class="inv-slot ${active ? 'used' : 'pending'}"
        ${!active
          ? `onclick="showCopyInvModal('${slot.inviteToken}','${escHtml(slot.name || '?')}')" title="Zobrazit odkaz"`
          : ''}
      >
        <div style="flex:1;min-width:0">
          <div style="font-weight:700;font-size:12px">${escHtml(slot.name || '?')}</div>
          <div style="font-size:9px;color:var(--muted);margin-top:2px">${label}</div>
        </div>
        ${!active
          ? `<svg width="11" height="11" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" stroke-width="2">
               <rect x="9" y="9" width="13" height="13" rx="2"/>
               <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
             </svg>`
          : ''}
      </div>
    `;
  }).join('');
}


// ─────────────────────────────────────────────
// AKČNÍ TLAČÍTKA SIDEBARU
// ─────────────────────────────────────────────

/**
 * Renderuje sekci akčních tlačítek v obou sidebarech.
 * Volá se při změně stavu (notifikace, DnD, admin...).
 */
function renderSidebarActions() {
  const html = _buildActionsHtml();
  const a    = $('sb-actions');
  const b    = $('mob-sb-actions');
  if (a) a.innerHTML = html;
  if (b) b.innerHTML = html;
}

/**
 * Sestaví HTML pro akční tlačítka.
 * @returns {string} HTML string
 * @private
 */
function _buildActionsHtml() {
  const notifOk = 'Notification' in window &&
    Notification.permission === 'granted';
  const dndActive = isDnd();
  const dndLabel  = dndActive ? ' (aktivní)' : '';

  let html = '';

  // ── Admin sekce ──
  if (S.isAdmin) {
    html += `
      <button class="sb-act-btn"
        onclick="openRoomSettings();closeMobSidebar()">
        <span class="ico">⚙️</span>
        <span class="lbl">Nastavení místnosti
          <span class="sub">heslo, max. lidí, mazání…</span>
        </span>
      </button>
      <button class="sb-act-btn"
        onclick="goToRooms();closeMobSidebar()">
        <span class="ico">🏠</span>
        <span class="lbl">Přepnout místnost</span>
      </button>
    `;
  }

  // ── Moje nastavení ──
  html += `
    <button class="sb-act-btn"
      onclick="openUserSettings();closeMobSidebar()">
      <span class="ico">👤</span>
      <span class="lbl">Moje nastavení
        <span class="sub">přezdívka, PIN, reakce…</span>
      </span>
    </button>
  `;

  // ── Notifikace ──
  html += `
    <button class="sb-act-btn ${notifOk ? 'active' : ''}"
      onclick="toggleNotifications()">
      <span class="ico">${notifOk ? '🔔' : '🔕'}</span>
      <span class="lbl">
        ${notifOk ? 'Notifikace: ON' : 'Zapnout notifikace'}
        <span class="sub">${dndActive ? 'nerušit aktivní' : ''}</span>
      </span>
    </button>
  `;

  // ── Téma ──
  html += `
    <button class="sb-act-btn"
      onclick="openM('m-theme');closeMobSidebar()">
      <span class="ico">🎨</span>
      <span class="lbl">Změnit téma
        <span class="sub">barva, vlastní pozadí</span>
      </span>
    </button>
  `;

  // ── Přidat na plochu ──
  html += `
    <button class="sb-act-btn"
      onclick="addToHomeScreen()">
      <span class="ico">📲</span>
      <span class="lbl">Přidat na plochu</span>
    </button>
  `;

  // ── Nerušit ──
  const dndOpts = [
    { label: '1h',  val: 3_600_000   },
    { label: '4h',  val: 14_400_000  },
    { label: 'ráno', val: 'morning'  },
    { label: 'vyp',  val: 0          },
  ];

  html += `
    <div style="padding:2px 0">
      <div style="font-size:9px;font-weight:800;color:var(--muted);
                  letter-spacing:1.5px;padding:2px 4px 6px;
                  text-transform:uppercase">
        Nerušit${dndLabel}
      </div>
      <div class="dnd-opts">
        ${dndOpts.map(o => `
          <div class="dnd-opt ${dndActive && o.val === 3_600_000 ? 'active' : ''}"
            onclick="${o.val === 'morning'
              ? 'dndUntilMorning()'
              : `setDnd(${o.val})`}">
            ${o.label}
          </div>
        `).join('')}
      </div>
    </div>
  `;

  return html;
}


// ─────────────────────────────────────────────
// MOBILNÍ SIDEBAR
// ─────────────────────────────────────────────

/**
 * Otevře mobilní sidebar overlay.
 */
function openMobSidebar() {
  $('mob-sb-ov').classList.add('open');
  document.body.style.overflow = 'hidden';
}

/**
 * Zavře mobilní sidebar overlay.
 */
function closeMobSidebar() {
  $('mob-sb-ov')?.classList.remove('open');
  document.body.style.overflow = '';
}

/**
 * Nastaví swipe-to-open gesto pro mobilní sidebar.
 * Swipe doprava z levého okraje (< 60px) → otevře sidebar.
 * Volá se z enterChat().
 */
function _setupSwipeSidebar() {
  const main = $('chat-main');
  if (!main) return;

  let startX = 0;
  let startY = 0;
  let tracking = false;

  main.addEventListener('touchstart', e => {
    startX   = e.touches[0].clientX;
    startY   = e.touches[0].clientY;
    tracking = startX < 60;
  }, { passive: true });

  main.addEventListener('touchmove', e => {
    if (!tracking) return;
    const dx = e.touches[0].clientX - startX;
    const dy = Math.abs(e.touches[0].clientY - startY);
    if (dx > 50 && dy < 40) {
      openMobSidebar();
      tracking = false;
    }
  }, { passive: true });

  main.addEventListener('touchend', () => {
    tracking = false;
  }, { passive: true });
}


// ─────────────────────────────────────────────
// TYPING INDIKÁTOR
// ─────────────────────────────────────────────

/**
 * Renderuje typing indikátor pod zprávami.
 * Zobrazí animované tečky a jména píšících uživatelů.
 * Volá se při každé změně slots kolekce.
 */
function renderTyping() {
  const typers = Object.values(S.slots).filter(slot => {
    if (slot.id === S.slotId) return false;
    if (!slot.typing || !slot.typingAt) return false;
    const since = slot.typingAt.toDate?.().getTime() ?? 0;
    return Date.now() - since < 5_000;
  });

  const el = $('typing');
  if (!el) return;

  if (!typers.length) {
    el.innerHTML = '';
    return;
  }

  const names = typers.map(s => escHtml(s.username)).join(', ');
  const verb  = typers.length === 1 ? 'píše' : 'píší';

  el.innerHTML = `
    <div class="td">
      <span></span><span></span><span></span>
    </div>
    <span>${names} ${verb}…</span>
  `;
}
