/**
 * RoomChat — invite.js
 * ─────────────────────────────────────────────
 * Hromadná pozvánka + QR kód místnosti.
 * QR se generuje lokálně přes qrcode.js (CDN).
 * ─────────────────────────────────────────────
 */

// ─────────────────────────────────────────────
// OTEVŘENÍ INVITE MODALU
// ─────────────────────────────────────────────

/**
 * Otevře modal s možnostmi pozvání:
 *   1. Hromadná pozvánka (kód místnosti + QR)
 *   2. Individuální pozvánka (invite slot)
 */
function openInviteModal() {
  _renderInviteModal();
  openM('m-invite');
}

function _renderInviteModal() {
  const modal = document.getElementById('m-invite-content');
  if (!modal) return;

  const roomUrl  = `${location.origin}/?room=${S.roomId}`;
  const hasPass  = !!S.roomData?.password;
  const invOnly  = !!S.roomData?.inviteOnly;

  modal.innerHTML = `
    <!-- HROMADNÁ POZVÁNKA -->
    <div style="display:flex;flex-direction:column;gap:12px">

      <div style="font-size:9px;font-weight:800;color:var(--muted);
                  letter-spacing:1.5px;text-transform:uppercase">
        Hromadná pozvánka
      </div>

      ${invOnly ? `
        <div style="background:#f0a03011;border:1px solid #f0a03033;border-radius:8px;
                    padding:10px 14px;font-size:12px;color:var(--orange);font-weight:600">
          ⚠️ Místnost je invite-only — hromadný kód nefunguje.<br>
          <span style="font-weight:400">Použij individuální pozvánku níže nebo vypni invite-only v nastavení.</span>
        </div>
      ` : ''}

      <!-- Kód místnosti -->
      <div style="background:var(--surface2);border:1px solid var(--border2);
                  border-radius:10px;padding:14px;text-align:center">
        <div style="font-size:11px;color:var(--muted2);margin-bottom:6px">Kód místnosti</div>
        <div style="font-size:32px;font-weight:900;letter-spacing:8px;
                    color:var(--accent);font-family:var(--fm)">
          ${S.roomId}
        </div>
        ${hasPass ? `<div style="font-size:11px;color:var(--muted2);margin-top:6px">
          🔒 Heslo je vyžadováno
        </div>` : ''}
      </div>

      <!-- URL odkaz -->
      <div style="display:flex;gap:6px">
        <div style="flex:1;background:var(--surface2);border:1px solid var(--border2);
                    border-radius:10px;padding:10px 12px;font-size:11px;
                    color:var(--accent);overflow:hidden;text-overflow:ellipsis;
                    white-space:nowrap;cursor:pointer"
             onclick="copyInviteUrl()"
             title="Kopírovat odkaz">
          ${roomUrl}
        </div>
        <button onclick="copyInviteUrl()"
          style="padding:10px 14px;border-radius:10px;background:var(--accent);
                 border:none;color:#fff;font-family:var(--fh);font-weight:700;
                 font-size:12px;cursor:pointer;white-space:nowrap;flex-shrink:0">
          📋 Kopírovat
        </button>
      </div>

      <!-- QR kód -->
      <div style="display:flex;flex-direction:column;align-items:center;gap:10px">
        <div style="font-size:11px;color:var(--muted2)">QR kód pro vstup do místnosti:</div>
        <div id="qr-canvas-wrap"
          style="background:#fff;border-radius:12px;padding:16px;
                 display:inline-block;box-shadow:0 4px 20px #0004">
          <div id="qr-div"></div>
        </div>
        <div style="display:flex;gap:8px">
          <button onclick="downloadQR()"
            style="padding:9px 18px;border-radius:10px;background:var(--surface2);
                   border:1px solid var(--border2);color:var(--text);
                   font-family:var(--fh);font-weight:700;font-size:12px;cursor:pointer">
            💾 Stáhnout QR
          </button>
          <button onclick="shareInvite()"
            id="share-btn"
            style="padding:9px 18px;border-radius:10px;background:var(--accent);
                   border:none;color:#fff;
                   font-family:var(--fh);font-weight:700;font-size:12px;cursor:pointer;
                   display:${typeof navigator.share !== 'undefined' ? '' : 'none'}">
            🔗 Sdílet
          </button>
        </div>
        <div style="font-size:10px;color:var(--muted);text-align:center">
          Nasměruj kameru telefonu na QR kód<br>nebo poddrž prst pro uložení obrázku
        </div>
      </div>

      ${S.isAdmin ? `
      <!-- INDIVIDUÁLNÍ POZVÁNKA -->
      <div style="border-top:1px solid var(--border);padding-top:12px;margin-top:4px">
        <div style="font-size:9px;font-weight:800;color:var(--muted);
                    letter-spacing:1.5px;text-transform:uppercase;margin-bottom:8px">
          Individuální pozvánka (jen pro jednu osobu)
        </div>
        <button onclick="closeM('m-invite');openNewInvModal()"
          style="width:100%;padding:11px;border-radius:10px;
                 background:var(--surface2);border:1px dashed var(--border2);
                 color:var(--muted2);font-family:var(--fh);font-weight:700;
                 font-size:13px;cursor:pointer">
          + Vytvořit individuální pozvánku
        </button>
      </div>
      ` : ''}
    </div>
  `;

  // Vygeneruj QR kód
  _generateQR(roomUrl);
}


// ─────────────────────────────────────────────
// QR KÓD GENEROVÁNÍ
// ─────────────────────────────────────────────

/**
 * Vygeneruje QR kód na canvas element.
 * Používá qrcode.js z CDN (načteno v index.html).
 * @param {string} url - URL pro QR kód
 */
function _generateQR(url) {
  const wrap = document.getElementById('qr-canvas-wrap');
  if (!wrap) return;

  if (typeof QRCode === 'undefined') {
    _loadQRLib(() => _generateQR(url));
    return;
  }

  try {
    // qrcodejs API — vytváří div s img/canvas uvnitř
    wrap.innerHTML = '<div id="qr-div"></div>';
    new QRCode(document.getElementById('qr-div'), {
      text:         url,
      width:        200,
      height:       200,
      colorDark:    '#000000',
      colorLight:   '#ffffff',
      correctLevel: QRCode.CorrectLevel.M,
    });
  } catch (e) {
    console.error('[QR] Error:', e);
    _showQRFallback(url);
  }
}

/**
 * Dynamicky načte qrcode.js z CDN pokud ještě není.
 * @param {Function} cb - callback po načtení
 */
function _loadQRLib(cb) {
  if (typeof QRCode !== 'undefined') { cb(); return; }

  const wrap = document.getElementById('qr-canvas-wrap');
  if (wrap) wrap.innerHTML = '<div style="padding:20px;color:#666;font-size:12px;text-align:center">Načítám QR…</div>';

  const script   = document.createElement('script');
  script.src     = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
  script.onload  = () => {
    const wrap2 = document.getElementById('qr-canvas-wrap');
    if (wrap2) wrap2.innerHTML = '<div id="qr-div"></div>';
    cb();
  };
  script.onerror = () => _showQRFallback('');
  document.head.appendChild(script);
}

/**
 * Fallback pokud QR knihovna selže — zobrazí text.
 */
function _showQRFallback(url) {
  const wrap = document.getElementById('qr-canvas-wrap');
  if (!wrap) return;
  wrap.innerHTML = `
    <div style="padding:20px;text-align:center;color:#000;font-size:12px">
      <div style="font-size:24px;margin-bottom:8px">📷</div>
      QR kód nelze vygenerovat<br>
      <span style="font-size:10px;color:#666">Použij tlačítko Kopírovat</span>
    </div>
  `;
}


// ─────────────────────────────────────────────
// AKCE
// ─────────────────────────────────────────────

/**
 * Zkopíruje URL pozvánky do schránky.
 */
function copyInviteUrl() {
  const url = `${location.origin}/?room=${S.roomId}`;
  copyToClipboard(url, 'Odkaz zkopírován! 📋');
}

/**
 * Stáhne QR kód jako PNG soubor.
 */
function downloadQR() {
  // qrcodejs generuje <img> nebo <canvas> uvnitř #qr-div
  const qrDiv  = document.getElementById('qr-div');
  const qrImg  = qrDiv?.querySelector('img');
  const qrCvs  = qrDiv?.querySelector('canvas');

  if (!qrImg && !qrCvs) {
    toast('QR kód není dostupný', 'err');
    return;
  }

  try {
    const out  = document.createElement('canvas');
    const size = 240;
    const pad  = 20;
    out.width  = size + pad * 2;
    out.height = size + pad * 2 + 20;
    const ctx  = out.getContext('2d');

    // Bílé pozadí
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, out.width, out.height);

    // Nakresli QR
    const drawAndSave = src => {
      const tmpImg    = new Image();
      tmpImg.onload   = () => {
        ctx.drawImage(tmpImg, pad, pad, size, size);
        // Text s kódem
        ctx.fillStyle = '#333333';
        ctx.font      = 'bold 13px Arial';
        ctx.textAlign = 'center';
        ctx.fillText('RoomChat · ' + S.roomId, out.width / 2, out.height - 6);
        // Stáhni
        const a    = document.createElement('a');
        a.href     = out.toDataURL('image/png');
        a.download = 'roomchat-' + S.roomId + '-qr.png';
        a.click();
        toast('QR kód stažen 💾', 'ok');
      };
      tmpImg.onerror = () => toast('Stažení selhalo', 'err');
      tmpImg.src     = src;
    };

    if (qrImg) {
      drawAndSave(qrImg.src);
    } else {
      drawAndSave(qrCvs.toDataURL('image/png'));
    }

  } catch (e) {
    console.error('[QR] download error:', e);
    toast('Poddrž QR kód pro uložení obrázku', 'err');
  }
}

/**
 * Sdílí pozvánku přes Web Share API (mobil).
 */
async function shareInvite() {
  const url  = `${location.origin}/?room=${S.roomId}`;
  const text = `Připoj se do místnosti "${S.roomData?.name || S.roomId}" na RoomChat!`;

  try {
    const qrDiv = document.getElementById('qr-div');
    const qrImg = qrDiv?.querySelector('img');
    const qrCvs = qrDiv?.querySelector('canvas');

    if ((qrImg || qrCvs) && navigator.canShare) {
      const src  = qrImg ? qrImg.src : qrCvs.toDataURL('image/png');
      const res  = await fetch(src);
      const blob = await res.blob();
      const file = new File([blob], 'roomchat-qr.png', { type: 'image/png' });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ title: 'RoomChat pozvánka', text, url, files: [file] });
        return;
      }
    }
    await navigator.share({ title: 'RoomChat pozvánka', text, url });
  } catch (e) {
    if (e.name !== 'AbortError') copyInviteUrl();
  }
}
