// ============================================================
// Stego Overlay — Quét bubble Messenger, gắn icon 🔒 + popup decode
// Chạy trong page (isolated world content script).
// ============================================================

(function () {
  if (window.__MR_STEGO_OVERLAY__) return;
  window.__MR_STEGO_OVERLAY__ = true;

  // ---- Stego core (copy từ stego.js — content script không share scope với page) ----
  const ZW0 = '​'; // ZWSP
  const ZW1 = '‌'; // ZWNJ
  const MAGIC = '‌​‌​';
  const FLAG_ENCRYPTED = 0x01;
  const FALLBACK_VISIBLE = '·';

  function bytesToZw(bytes) {
    let out = '';
    for (const b of bytes) {
      for (let i = 7; i >= 0; i--) {
        out += (b >> i) & 1 ? ZW1 : ZW0;
      }
    }
    return out;
  }

  function zwToBytes(zwStr) {
    let clean = '';
    for (const c of zwStr) {
      if (c === ZW0 || c === ZW1) clean += c;
    }
    clean = clean.slice(0, clean.length - (clean.length % 8));
    const bytes = new Uint8Array(clean.length / 8);
    for (let i = 0; i < bytes.length; i++) {
      let b = 0;
      for (let j = 0; j < 8; j++) {
        b = (b << 1) | (clean[i * 8 + j] === ZW1 ? 1 : 0);
      }
      bytes[i] = b;
    }
    return bytes;
  }

  async function deriveKey(password, salt) {
    const enc = new TextEncoder();
    const baseKey = await crypto.subtle.importKey(
      'raw', enc.encode(password),
      { name: 'PBKDF2' }, false, ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false, ['encrypt', 'decrypt']
    );
  }

  async function encryptText(plaintext, password) {
    const enc = new TextEncoder();
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(password, salt);
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext))
    );
    const out = new Uint8Array(16 + 12 + ciphertext.length);
    out.set(salt, 0);
    out.set(iv, 16);
    out.set(ciphertext, 28);
    return out;
  }

  async function encodeText(visibleText, hiddenText, password) {
    if (!hiddenText) return visibleText;
    let payloadBytes;
    let flag = 0;
    if (password) {
      payloadBytes = await encryptText(hiddenText, password);
      flag = FLAG_ENCRYPTED;
    } else {
      payloadBytes = new TextEncoder().encode(hiddenText);
    }
    const withFlag = new Uint8Array(1 + payloadBytes.length);
    withFlag[0] = flag;
    withFlag.set(payloadBytes, 1);
    const carrier = visibleText && visibleText.length > 0 ? visibleText : FALLBACK_VISIBLE;
    return carrier + MAGIC + bytesToZw(withFlag);
  }

  async function decryptBytes(bytes, password) {
    if (bytes.length < 28) throw new Error('Payload quá ngắn');
    const salt = bytes.slice(0, 16);
    const iv = bytes.slice(16, 28);
    const ciphertext = bytes.slice(28);
    const key = await deriveKey(password, salt);
    try {
      const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
      return new TextDecoder().decode(plainBuf);
    } catch (e) {
      throw new Error('Sai mật khẩu hoặc payload hỏng');
    }
  }

  function hasHidden(text) {
    return !!text && text.indexOf(MAGIC) >= 0;
  }

  async function decodeText(fullText, password) {
    if (!fullText) return { visible: '', hidden: null };
    const magicIdx = fullText.indexOf(MAGIC);
    if (magicIdx < 0) return { visible: fullText, hidden: null };
    let visible = fullText.slice(0, magicIdx);
    if (visible === FALLBACK_VISIBLE) visible = '';
    const zwPart = fullText.slice(magicIdx + MAGIC.length);
    const bytes = zwToBytes(zwPart);
    if (bytes.length < 1) return { visible, hidden: null, error: 'Payload rỗng' };
    const flag = bytes[0];
    const payload = bytes.slice(1);
    const encrypted = (flag & FLAG_ENCRYPTED) !== 0;
    if (encrypted) {
      if (!password) return { visible, hidden: null, encrypted: true, error: 'Cần mật khẩu' };
      try {
        const hidden = await decryptBytes(payload, password);
        return { visible, hidden, encrypted: true };
      } catch (e) {
        return { visible, hidden: null, encrypted: true, error: e.message };
      }
    } else {
      try {
        return { visible, hidden: new TextDecoder().decode(payload), encrypted: false };
      } catch (e) {
        return { visible, hidden: null, error: 'Decode UTF-8 lỗi' };
      }
    }
  }

  // ---- Đọc mật khẩu mặc định từ chrome.storage ----
  let cachedDefaultPw = '';
  async function loadDefaultPassword() {
    try {
      const data = await chrome.storage.local.get('stego-default-pw');
      cachedDefaultPw = data['stego-default-pw'] || '';
    } catch (_) {}
  }
  loadDefaultPassword();
  // Re-sync khi user đổi pass trong panel
  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes['stego-default-pw']) {
        cachedDefaultPw = changes['stego-default-pw'].newValue || '';
      }
    });
  }

  // ---- Inject CSS ----
  const css = `
    .mr-stego-icon {
      position: absolute !important;
      top: -10px !important;
      left: -10px !important;
      width: 18px !important;
      height: 18px !important;
      border-radius: 50% !important;
      background: #8b5cf6 !important;
      color: #fff !important;
      font-size: 9px !important;
      line-height: 1 !important;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      cursor: pointer !important;
      z-index: 9999 !important;
      box-shadow: 0 2px 6px rgba(0,0,0,0.4) !important;
      border: 1.5px solid #fff !important;
      transition: transform 0.15s, opacity 0.15s !important;
      user-select: none !important;
      opacity: 0.85 !important;
      pointer-events: auto !important;
    }
    .mr-stego-icon:hover {
      transform: scale(1.2) !important;
      opacity: 1 !important;
    }
    .mr-stego-icon.decoded { background: #3fb950 !important; }

    #mr-stego-popup-bg {
      position: fixed; inset: 0; background: rgba(0,0,0,0.6);
      z-index: 999998; display: none; align-items: center; justify-content: center;
      font-family: -apple-system, 'Segoe UI', Roboto, sans-serif;
    }
    #mr-stego-popup-bg.show { display: flex; }
    #mr-stego-popup {
      background: #161b22; color: #c9d1d9;
      border: 1px solid #30363d; border-radius: 12px;
      padding: 18px; width: 420px; max-width: 92vw;
      box-shadow: 0 12px 40px rgba(0,0,0,0.6);
      display: flex; flex-direction: column; gap: 12px;
    }
    #mr-stego-popup h3 {
      margin: 0; font-size: 14px; color: #c4b5fd;
      display: flex; align-items: center; gap: 8px;
    }
    #mr-stego-popup label {
      display: block; font-size: 10px; color: #6e7681;
      text-transform: uppercase; letter-spacing: 0.5px;
      font-weight: 600; margin-bottom: 5px;
    }
    #mr-stego-popup input[type="password"] {
      background: #0d1117; border: 1px solid #21262d; border-radius: 6px;
      color: #c9d1d9; padding: 8px 10px; font-size: 13px;
      width: 100%; box-sizing: border-box; font-family: inherit;
    }
    #mr-stego-popup input:focus { outline: none; border-color: #8b5cf6; }
    #mr-stego-popup .mr-result {
      background: #0d1117; border: 1px solid #21262d; border-radius: 6px;
      padding: 10px 12px; font-size: 13px; color: #c9d1d9;
      white-space: pre-wrap; word-wrap: break-word;
      max-height: 240px; overflow-y: auto; line-height: 1.5;
      min-height: 30px;
    }
    #mr-stego-popup .mr-result:empty::before {
      content: 'Nhấn Giải mã để xem nội dung'; color: #484f58; font-style: italic;
    }
    #mr-stego-popup .mr-result.error { color: #f85149; border-color: #f85149; }
    #mr-stego-popup .mr-actions { display: flex; gap: 8px; justify-content: flex-end; }
    #mr-stego-popup button {
      background: #21262d; border: 1px solid #30363d; border-radius: 6px;
      color: #c9d1d9; padding: 7px 16px; font-size: 12px;
      cursor: pointer; font-family: inherit; font-weight: 500;
    }
    #mr-stego-popup button:hover { background: #2d333b; }
    #mr-stego-popup button.primary { background: #8b5cf6; border-color: #8b5cf6; color: #fff; }
    #mr-stego-popup button.primary:hover { background: #7c4ef0; }

    /* Toast lỗi nổi phía trên header button khi chưa có password */
    .mr-stego-toast {
      position: absolute; bottom: calc(100% + 8px); right: 0;
      background: #da3633; color: #fff; padding: 6px 10px;
      border-radius: 6px; font-size: 12px; font-weight: 500;
      white-space: nowrap; z-index: 100000;
      box-shadow: 0 4px 12px rgba(0,0,0,0.4);
      animation: mr-toast-in 0.2s ease-out;
      pointer-events: none;
    }
    .mr-stego-toast::after {
      content: ''; position: absolute; top: 100%; right: 12px;
      border: 6px solid transparent; border-top-color: #da3633;
    }
    @keyframes mr-toast-in {
      from { opacity: 0; transform: translateY(4px); }
      to { opacity: 1; transform: translateY(0); }
    }

    /* Phần tin đã giải mã chèn thẳng vào bubble — kế thừa màu/font Messenger */
    .mr-stego-inline {
      display: block;
      margin-top: 4px;
      padding-top: 4px;
      font-style: italic;
      opacity: 0.95;
      word-wrap: break-word;
    }
    .mr-stego-inline::before {
      content: '────────';
      display: block;
      letter-spacing: 2px;
      opacity: 0.4;
      margin-bottom: 4px;
      font-style: normal;
    }
    .mr-stego-inline.error {
      color: #ffb3b0 !important;
    }
  `;
  const styleEl = document.createElement('style');
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  // ---- Popup ----
  const popupBg = document.createElement('div');
  popupBg.id = 'mr-stego-popup-bg';
  popupBg.innerHTML = `
    <div id="mr-stego-popup">
      <h3>🔒 Giải mã tin ẩn</h3>
      <div>
        <label>Mật khẩu (nếu có)</label>
        <input type="password" id="mr-stego-pw" placeholder="Để trống nếu tin không mã hoá" />
      </div>
      <div>
        <label>Nội dung tin ẩn</label>
        <div class="mr-result" id="mr-stego-result"></div>
      </div>
      <div class="mr-actions">
        <button id="mr-stego-decode" class="primary">🔓 Giải mã</button>
        <button id="mr-stego-close">Đóng</button>
      </div>
    </div>
  `;
  document.body.appendChild(popupBg);

  const $pw = popupBg.querySelector('#mr-stego-pw');
  const $result = popupBg.querySelector('#mr-stego-result');
  const $decodeBtn = popupBg.querySelector('#mr-stego-decode');
  const $closeBtn = popupBg.querySelector('#mr-stego-close');
  let currentText = '';

  function openPopup(text) {
    currentText = text;
    $pw.value = '';
    $result.textContent = '';
    $result.classList.remove('error');
    popupBg.classList.add('show');
    setTimeout(() => $pw.focus(), 50);
  }

  async function runDecode() {
    $result.classList.remove('error');
    $result.textContent = '⏳ Đang giải mã...';
    try {
      const r = await decodeText(currentText, $pw.value);
      if (r.error) {
        $result.classList.add('error');
        $result.textContent = '❌ ' + r.error +
          (r.encrypted ? ' (tin đã mã hoá AES-GCM)' : '');
        return;
      }
      if (r.hidden == null) {
        $result.classList.add('error');
        $result.textContent = 'ℹ️ Không tìm thấy nội dung ẩn.';
        return;
      }
      const icon = r.encrypted ? '🔐' : '🔓';
      $result.textContent = `${icon} ${r.hidden}`;
    } catch (e) {
      $result.classList.add('error');
      $result.textContent = '❌ Lỗi: ' + e.message;
    }
  }

  $decodeBtn.addEventListener('click', runDecode);
  $pw.addEventListener('keydown', (e) => { if (e.key === 'Enter') runDecode(); });
  $closeBtn.addEventListener('click', () => popupBg.classList.remove('show'));
  popupBg.addEventListener('click', (e) => {
    if (e.target === popupBg) popupBg.classList.remove('show');
  });

  // ---- Scan bubble + gắn icon ----
  // Messenger render text trong các <div dir="auto"> hoặc <span> sâu trong cây.
  // Strategy: tìm mọi text node chứa MAGIC → đi lên tìm bubble container → gắn icon.
  const TAGGED = new WeakSet();

  function findBubbleAncestor(node) {
    // Đi lên cây, ghi nhận bubble cuối cùng (element có border-radius + background).
    // Sau đó tiếp tục lên thêm vài cấp để tìm wrapper (không có overflow:hidden)
    // để mount icon — tránh bị clip bên trong bubble.
    let el = node.parentElement;
    let depth = 0;
    let bubble = null;
    while (el && depth < 12) {
      const cs = getComputedStyle(el);
      const br = parseFloat(cs.borderRadius) || 0;
      const hasBg = cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent';
      if (br >= 10 && hasBg) {
        bubble = el;
        break;
      }
      el = el.parentElement;
      depth++;
    }
    if (!bubble) return null;

    // Tìm wrapper: leo lên thêm 1-3 cấp, chọn cấp không có overflow:hidden
    let wrapper = bubble.parentElement;
    let upDepth = 0;
    while (wrapper && upDepth < 3) {
      const cs = getComputedStyle(wrapper);
      if (cs.overflow !== 'hidden' && cs.overflowX !== 'hidden' && cs.overflowY !== 'hidden') {
        return { bubble, wrapper };
      }
      wrapper = wrapper.parentElement;
      upDepth++;
    }
    // Fallback: dùng chính bubble (icon có thể bị clip nhưng vẫn hiện 1 phần)
    return { bubble, wrapper: bubble };
  }

  function tagBubble(textNode) {
    const txt = textNode.nodeValue;
    if (!hasHidden(txt)) return;
    const found = findBubbleAncestor(textNode);
    if (!found) return;
    const { bubble, wrapper } = found;
    if (TAGGED.has(bubble)) return;
    TAGGED.add(bubble);

    // Đảm bảo wrapper có position relative để icon absolute neo theo
    const wcs = getComputedStyle(wrapper);
    if (wcs.position === 'static') {
      wrapper.style.position = 'relative';
    }

    const icon = document.createElement('div');
    icon.className = 'mr-stego-icon';
    icon.textContent = '🔒';
    icon.title = 'Tin có nội dung ẩn — click để giải mã';
    icon.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      openPopup(textNode.nodeValue);
    });
    wrapper.appendChild(icon);
  }

  function scanRoot(root) {
    if (!root || root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) return;
    try {
      const walker = document.createTreeWalker(
        root, NodeFilter.SHOW_TEXT,
        {
          acceptNode: (n) => {
            return hasHidden(n.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
          }
        }
      );
      let n;
      while ((n = walker.nextNode())) {
        tagBubble(n);
      }
    } catch (_) {}
  }

  function scanAll() {
    scanRoot(document.body);
  }

  // ---- MutationObserver: theo dõi tin mới ----
  let scanScheduled = false;
  function scheduleScan(target) {
    if (scanScheduled) return;
    scanScheduled = true;
    requestIdleCallback ? requestIdleCallback(() => {
      scanScheduled = false;
      scanRoot(target || document.body);
    }, { timeout: 500 }) : setTimeout(() => {
      scanScheduled = false;
      scanRoot(target || document.body);
    }, 300);
  }

  const observer = new MutationObserver((mutations) => {
    for (const mut of mutations) {
      for (const node of mut.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          scheduleScan(node);
        } else if (node.nodeType === Node.TEXT_NODE && hasHidden(node.nodeValue)) {
          tagBubble(node);
        }
      }
      // Text node bị thay đổi nội dung (Messenger có thể re-render bubble)
      if (mut.type === 'characterData' && hasHidden(mut.target.nodeValue)) {
        tagBubble(mut.target);
      }
    }
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  // Scan ban đầu (delay 1s cho Messenger render xong)
  setTimeout(scanAll, 1000);
  setTimeout(scanAll, 3000);

  // ---- Listen lệnh "quét lại" từ panel (qua content_script bridge) ----
  window.addEventListener('mr-local-action', (e) => {
    if (e.detail && e.detail.action === 'stegoRescan') {
      scanAll();
    }
  });

  // ---- Inject nút "Quét lại" vào header Messenger (cạnh nút gọi thoại) ----
  // Style đồng bộ với 3 nút sẵn có (call/video/info) — clone container của nút call.
  const HEADER_BTN_ID = 'mr-stego-header-btn';

  function injectHeaderButton() {
    if (document.getElementById(HEADER_BTN_ID)) return true;

    // Tìm nút "Bắt đầu gọi thoại" làm mốc
    const callBtn = document.querySelector('[aria-label="Bắt đầu gọi thoại"], [aria-label="Start voice call"]');
    if (!callBtn) return false;

    // Đi lên cây để tìm container ngoài cùng của nút (chứa <span><div role=button>)
    // Cấu trúc Messenger: <div wrapper> > <span> > <div __fb-light-mode> > <div role=button>
    let container = callBtn;
    for (let i = 0; i < 5; i++) {
      if (!container.parentElement) break;
      container = container.parentElement;
      // Container "ô" của 1 nút action có class chứa "xn3w4p2" hoặc "x187nhsf"
      if (container.className && /x187nhsf|xn3w4p2/.test(container.className)) {
        break;
      }
    }

    // Clone container làm khung cho nút mới (giữ nguyên CSS atomic của Messenger)
    const newSlot = container.cloneNode(true);

    // Lấy ref đến <div role="button"> trong slot mới
    const newBtnEl = newSlot.querySelector('[role="button"]');
    if (!newBtnEl) return false;

    newBtnEl.id = HEADER_BTN_ID;
    newBtnEl.setAttribute('aria-label', 'Quét lại tin ẩn (Stego)');

    // Thay icon SVG thành icon ổ khoá
    const oldSvg = newBtnEl.querySelector('svg');
    if (oldSvg) {
      // Tạo SVG ổ khoá đơn giản, dùng cùng size & color variable
      const newSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      newSvg.setAttribute('viewBox', '0 0 24 24');
      newSvg.setAttribute('width', '20');
      newSvg.setAttribute('height', '20');
      newSvg.setAttribute('fill', 'currentColor');
      newSvg.setAttribute('aria-hidden', 'true');
      newSvg.style.setProperty('--x-color', 'var(--primary-icon)');
      // Copy class để theme color đúng
      newSvg.setAttribute('class', oldSvg.getAttribute('class') || '');
      newSvg.innerHTML = `
        <path d="M12 1a5 5 0 0 0-5 5v3H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2h-2V6a5 5 0 0 0-5-5zm-3 8V6a3 3 0 1 1 6 0v3H9zm3 5a1.5 1.5 0 0 1 1 2.6V19a1 1 0 0 1-2 0v-2.4a1.5 1.5 0 0 1 1-2.6z"/>
      `;
      oldSvg.replaceWith(newSvg);
    }

    // Click trực tiếp → quét bình thường (không decode-all)
    let busy = false;
    newBtnEl.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      if (busy) return;
      busy = true;

      const svg = newBtnEl.querySelector('svg');
      const originalOpacity = svg ? svg.style.opacity : '';
      if (svg) svg.style.opacity = '0.4';
      try {
        scanAll();
      } finally {
        setTimeout(() => {
          if (svg) svg.style.opacity = originalOpacity;
          busy = false;
        }, 800);
      }
    });

    // ---- Hover → drop ra nút 🗝 (giải mã toàn bộ bằng pass mặc định) ----
    // Wrapper container cần position relative để dropdown neo
    newSlot.style.position = 'relative';

    // Tạo dropdown nút 🗝
    const dropBtn = document.createElement('div');
    dropBtn.setAttribute('role', 'button');
    dropBtn.setAttribute('aria-label', 'Giải mã toàn bộ tin ẩn');
    dropBtn.title = 'Giải mã toàn bộ tin ẩn bằng mật khẩu mặc định';
    dropBtn.style.cssText = `
      position: absolute; top: calc(100% + 4px); left: 50%;
      transform: translateX(-50%) translateY(-4px);
      background: #8b5cf6; color: #fff;
      width: 32px; height: 32px; border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      cursor: pointer; font-size: 16px; line-height: 1;
      box-shadow: 0 4px 12px rgba(0,0,0,0.4);
      border: 2px solid #fff;
      opacity: 0; pointer-events: none;
      transition: opacity 0.2s, transform 0.2s;
      z-index: 9999;
    `;
    dropBtn.textContent = '🗝';
    newSlot.appendChild(dropBtn);

    let hoverTimer = null;
    function showDrop() {
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(() => {
        dropBtn.style.opacity = '1';
        dropBtn.style.pointerEvents = 'auto';
        dropBtn.style.transform = 'translateX(-50%) translateY(0)';
      }, 300);
    }
    function hideDrop() {
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(() => {
        dropBtn.style.opacity = '0';
        dropBtn.style.pointerEvents = 'none';
        dropBtn.style.transform = 'translateX(-50%) translateY(-4px)';
      }, 250);
    }
    newSlot.addEventListener('mouseenter', showDrop);
    newSlot.addEventListener('mouseleave', hideDrop);
    dropBtn.addEventListener('mouseenter', showDrop);
    dropBtn.addEventListener('mouseleave', hideDrop);

    dropBtn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      if (!cachedDefaultPw) {
        showToast(newSlot, '⚠️ Chưa lưu mật khẩu mặc định');
        return;
      }
      hideDrop();
      await decodeAllVisible(cachedDefaultPw);
    });

    // Chèn ngay TRƯỚC container nút gọi thoại
    container.parentElement.insertBefore(newSlot, container);
    return true;
  }

  // ---- Toast nổi trên header button ----
  function showToast(anchor, message) {
    // Xoá toast cũ nếu có
    const existing = anchor.querySelector('.mr-stego-toast');
    if (existing) existing.remove();
    const toast = document.createElement('div');
    toast.className = 'mr-stego-toast';
    toast.textContent = message;
    anchor.style.position = 'relative';
    anchor.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
  }

  // ---- Giải mã toàn bộ tin ẩn đã được tag, append khối kết quả dưới bubble ----
  const DECODED_BUBBLES = new WeakSet();
  async function decodeAllVisible(password) {
    // Đảm bảo scan trước để có tất cả icon
    scanAll();
    // Tìm tất cả bubble đã tag (TAGGED) — duyệt qua các icon trên page
    const icons = document.querySelectorAll('.mr-stego-icon');
    let count = 0;
    for (const icon of icons) {
      const bubble = icon.parentElement;
      if (!bubble || DECODED_BUBBLES.has(bubble)) continue;
      // Lấy text gốc từ text node bên trong bubble
      const fullText = extractTextWithZw(bubble);
      if (!hasHidden(fullText)) continue;
      try {
        const result = await decodeText(fullText, password);
        appendDecodedBlock(bubble, result);
        DECODED_BUBBLES.add(bubble);
        // Đổi icon thành màu xanh (đã decode)
        icon.classList.add('decoded');
        icon.textContent = '🔓';
        count++;
      } catch (_) {}
    }
    return count;
  }

  // Trích text (kể cả zero-width chars) từ một subtree
  function extractTextWithZw(root) {
    let result = '';
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      result += n.nodeValue;
    }
    return result;
  }

  function appendDecodedBlock(bubble, result) {
    // Xoá khối cũ nếu có (cho phép decode lại với pass khác sau này)
    const old = bubble.querySelector('.mr-stego-inline');
    if (old) old.remove();

    // Tìm element chứa text gốc — element cuối cùng chứa text node visible
    // (thường là <div dir="auto"> sâu nhất). Append vào đó để text decode
    // hiển thị cùng dòng với text gốc, kế thừa toàn bộ style của Messenger.
    const textHost = findTextHost(bubble) || bubble;

    const inline = document.createElement('span');
    inline.className = 'mr-stego-inline';

    if (result.error) {
      inline.classList.add('error');
      inline.textContent = '⚠️ ' + result.error;
    } else if (result.hidden == null) {
      inline.classList.add('error');
      inline.textContent = 'ℹ️ Không có nội dung ẩn';
    } else {
      inline.textContent = result.hidden;
    }

    textHost.appendChild(inline);
  }

  // Tìm element chứa text node visible (text không phải ZW chars)
  // Thường là <div dir="auto"> hoặc <span> sâu nhất bên trong bubble
  function findTextHost(bubble) {
    const walker = document.createTreeWalker(
      bubble, NodeFilter.SHOW_TEXT,
      {
        acceptNode: (n) => {
          // Bỏ qua node chỉ có ZW chars
          const t = n.nodeValue;
          if (!t) return NodeFilter.FILTER_REJECT;
          // Loại ZW chars rồi xem còn gì
          const visible = t.replace(/[​‌﻿]/g, '');
          return visible.length > 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        }
      }
    );
    const firstVisible = walker.nextNode();
    return firstVisible ? firstVisible.parentElement : null;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Header có thể chưa render lúc script chạy → poll
  function tryInjectHeaderButton(retries = 30) {
    if (injectHeaderButton()) return;
    if (retries > 0) {
      setTimeout(() => tryInjectHeaderButton(retries - 1), 1000);
    }
  }

  // Re-inject khi user chuyển thread (Messenger SPA re-render header).
  setInterval(() => {
    if (!document.getElementById(HEADER_BTN_ID)) {
      injectHeaderButton();
    }
    if (!document.getElementById(COMPOSER_BTN_ID)) {
      injectComposerButton();
    }
  }, 2000);

  setTimeout(() => tryInjectHeaderButton(), 1500);
  setTimeout(() => injectComposerButton(), 1500);

  // ============================================================
  // COMPOSER: nút 🔒 cạnh nút emoji + popup soạn tin ẩn
  // ============================================================
  const COMPOSER_BTN_ID = 'mr-stego-composer-btn';

  // CSS cho composer button + popup
  const composerCss = `
    #${COMPOSER_BTN_ID} {
      display: inline-flex; align-items: center; justify-content: center;
      width: 32px; height: 32px; border-radius: 50%;
      background: transparent; cursor: pointer;
      margin: 0 2px; transition: background 0.15s;
      position: relative;
    }
    #${COMPOSER_BTN_ID}:hover { background: rgba(0,0,0,0.06); }
    #${COMPOSER_BTN_ID}.has-content::after {
      content: ''; position: absolute; top: 3px; right: 3px;
      width: 8px; height: 8px; border-radius: 50%;
      background: #3fb950; border: 1.5px solid #fff;
    }

    #mr-stego-composer-popup {
      position: fixed; display: none;
      background: #fff; color: #050505;
      border: 1px solid #dadde1; border-radius: 12px;
      padding: 14px; width: 320px;
      box-shadow: 0 12px 28px rgba(0,0,0,0.2);
      z-index: 999999;
      font-family: -apple-system, 'Segoe UI', Roboto, sans-serif;
    }
    #mr-stego-composer-popup.dark {
      background: #242526; color: #e4e6eb; border-color: #3a3b3c;
    }
    #mr-stego-composer-popup.show { display: block; }
    #mr-stego-composer-popup h4 {
      margin: 0 0 10px; font-size: 14px; font-weight: 600;
      display: flex; align-items: center; gap: 6px;
    }
    #mr-stego-composer-popup textarea {
      width: 100%; box-sizing: border-box;
      background: #f0f2f5; border: 1px solid transparent; border-radius: 8px;
      color: #050505; padding: 8px 10px; font-size: 13px;
      font-family: inherit; line-height: 1.4; resize: vertical;
      min-height: 60px; max-height: 120px;
    }
    #mr-stego-composer-popup.dark textarea {
      background: #3a3b3c; color: #e4e6eb;
    }
    #mr-stego-composer-popup textarea:focus {
      outline: none; border-color: #af4620;
    }
    #mr-stego-composer-popup input {
      width: 100%; box-sizing: border-box;
      background: #f0f2f5; border: 1px solid transparent; border-radius: 8px;
      color: #050505; padding: 7px 10px; font-size: 12px;
      font-family: inherit; margin-top: 8px;
    }
    #mr-stego-composer-popup.dark input {
      background: #3a3b3c; color: #e4e6eb;
    }
    #mr-stego-composer-popup input:focus { outline: none; border-color: #af4620; }
    #mr-stego-composer-popup .mr-cp-actions {
      display: flex; gap: 8px; margin-top: 10px; justify-content: flex-end;
    }
    #mr-stego-composer-popup button {
      background: #e4e6eb; border: none; border-radius: 6px;
      color: #050505; padding: 6px 14px; font-size: 12px;
      font-weight: 600; cursor: pointer; font-family: inherit;
    }
    #mr-stego-composer-popup.dark button { background: #4e4f50; color: #e4e6eb; }
    #mr-stego-composer-popup button:hover { filter: brightness(0.95); }
    #mr-stego-composer-popup button.primary {
      background: var(--mwp-primary-theme-color, #1877f2); color: #fff;
    }
    #mr-stego-composer-popup .mr-cp-hint {
      font-size: 11px; color: #65676b; margin-top: 8px; line-height: 1.4;
    }
    #mr-stego-composer-popup.dark .mr-cp-hint { color: #b0b3b8; }
  `;
  const composerStyleEl = document.createElement('style');
  composerStyleEl.textContent = composerCss;
  document.head.appendChild(composerStyleEl);

  // Popup compose
  const composerPopup = document.createElement('div');
  composerPopup.id = 'mr-stego-composer-popup';
  composerPopup.setAttribute('role', 'dialog');
  composerPopup.setAttribute('aria-modal', 'true');
  composerPopup.setAttribute('aria-label', 'Soạn tin ẩn');
  composerPopup.innerHTML = `
    <h4>🔒 Soạn tin ẩn</h4>
    <label for="mr-stego-cp-hidden" class="sr-only" style="display:none;">Nội dung tin nhắn tàng hình</label>
    <textarea id="mr-stego-cp-hidden" placeholder="Nội dung sẽ nhúng vào tin gửi đi..."></textarea>
    <label for="mr-stego-cp-pw" class="sr-only" style="display:none;">Mật khẩu mã hóa</label>
    <input type="password" id="mr-stego-cp-pw" placeholder="Khoá (trống = dùng khoá mặc định)" />
    <div class="mr-cp-actions">
      <button id="mr-stego-cp-clear">Xoá</button>
      <button class="primary" id="mr-stego-cp-ok">Lưu &amp; đóng</button>
    </div>
    <div class="mr-cp-hint">
      💡 Sau khi lưu, gõ tin nhắn vào ô soạn và bấm Gửi như bình thường — tin ẩn sẽ tự nhúng.
    </div>
  `;
  document.body.appendChild(composerPopup);

  const $cpHidden = composerPopup.querySelector('#mr-stego-cp-hidden');
  const $cpPw = composerPopup.querySelector('#mr-stego-cp-pw');
  const $cpOk = composerPopup.querySelector('#mr-stego-cp-ok');
  const $cpClear = composerPopup.querySelector('#mr-stego-cp-clear');

  // State: tin ẩn pending sẽ nhúng vào tin gửi tiếp theo
  let pendingComposerHidden = '';
  let pendingComposerPw = '';

  function updateComposerBtn() {
    const btn = document.getElementById(COMPOSER_BTN_ID);
    if (!btn) return;
    btn.classList.toggle('has-content', !!pendingComposerHidden);
  }

  function showComposerPopup(anchorEl) {
    // Detect dark mode
    const isDark = document.documentElement.classList.contains('__fb-dark-mode') ||
                   getComputedStyle(document.body).backgroundColor.match(/rgb\((1[0-9]|[0-9])/);
    composerPopup.classList.toggle('dark', !!isDark);

    // Pre-fill state hiện tại
    $cpHidden.value = pendingComposerHidden;
    $cpPw.value = pendingComposerPw;

    // Position popup phía trên anchor
    const rect = anchorEl.getBoundingClientRect();
    composerPopup.classList.add('show');
    // Đợi 1 frame để có kích thước thật
    requestAnimationFrame(() => {
      const popupRect = composerPopup.getBoundingClientRect();
      let top = rect.top - popupRect.height - 10;
      if (top < 10) top = rect.bottom + 10; // fallback xuống dưới nếu hết space trên
      let left = rect.left + rect.width / 2 - popupRect.width / 2;
      left = Math.max(10, Math.min(left, window.innerWidth - popupRect.width - 10));
      composerPopup.style.top = top + 'px';
      composerPopup.style.left = left + 'px';
    });

    setTimeout(() => $cpHidden.focus(), 50);
  }

  function hideComposerPopup() {
    composerPopup.classList.remove('show');
  }

  $cpOk.addEventListener('click', () => {
    pendingComposerHidden = $cpHidden.value;
    pendingComposerPw = $cpPw.value;
    hideComposerPopup();
    updateComposerBtn();
  });

  $cpClear.addEventListener('click', () => {
    pendingComposerHidden = '';
    pendingComposerPw = '';
    $cpHidden.value = '';
    $cpPw.value = '';
    hideComposerPopup();
    updateComposerBtn();
  });

  // Click ngoài popup → đóng
  document.addEventListener('click', (e) => {
    if (composerPopup.classList.contains('show') &&
        !composerPopup.contains(e.target) &&
        !e.target.closest(`#${COMPOSER_BTN_ID}`)) {
      hideComposerPopup();
    }
  });

  function injectComposerButton() {
    if (document.getElementById(COMPOSER_BTN_ID)) return true;

    const emojiBtn = document.querySelector('[aria-label="Chọn biểu tượng cảm xúc"], [aria-label="Choose an emoji"]');
    if (!emojiBtn) return false;

    // Container của nút emoji (đi lên 1-2 cấp để tìm slot)
    let slot = emojiBtn;
    for (let i = 0; i < 3; i++) {
      if (slot.parentElement && slot.parentElement.tagName === 'SPAN') {
        slot = slot.parentElement;
        break;
      }
      slot = slot.parentElement;
    }
    if (!slot || !slot.parentElement) return false;

    // Tạo nút mới
    const btn = document.createElement('div');
    btn.id = COMPOSER_BTN_ID;
    btn.setAttribute('role', 'button');
    btn.setAttribute('aria-label', 'Soạn tin nhắn tàng hình');
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-controls', 'mr-stego-composer-popup');
    btn.setAttribute('tabindex', '0');
    btn.title = 'Soạn tin ẩn — nội dung sẽ nhúng vào tin gửi đi';
    btn.innerHTML = `
      <svg viewBox="0 0 24 24" width="20" height="20" style="display:block;">
        <path fill="var(--chat-composer-button-color, #65676b)"
          d="M12 1a5 5 0 0 0-5 5v3H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2h-2V6a5 5 0 0 0-5-5zm-3 8V6a3 3 0 1 1 6 0v3H9zm3 5a1.5 1.5 0 0 1 1 2.6V19a1 1 0 0 1-2 0v-2.4a1.5 1.5 0 0 1 1-2.6z"/>
      </svg>
    `;
    const toggleComposer = (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (composerPopup.classList.contains('show')) {
        hideComposerPopup();
        btn.setAttribute('aria-expanded', 'false');
      } else {
        showComposerPopup(btn);
        btn.setAttribute('aria-expanded', 'true');
      }
    };
    btn.addEventListener('click', toggleComposer);
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        toggleComposer(e);
      }
    });

    // Chèn TRƯỚC slot của nút emoji
    slot.parentElement.insertBefore(btn, slot);
    updateComposerBtn();
    return true;
  }

  // ============================================================
  // INTERCEPT GỬI TIN MESSENGER: tự inject tin ẩn vào nội dung
  // ============================================================
  // Chiến lược: hook keydown Enter trên contenteditable + click nút gửi
  // Khi user gửi → modify nội dung composer thêm hidden payload trước khi gửi
  function findComposerEditor() {
    return document.querySelector('[contenteditable="true"][data-lexical-editor="true"]');
  }
  function findSendButton() {
    return document.querySelector('[aria-label="Nhấn Enter để gửi"], [aria-label="Press enter to send"]');
  }

  async function injectHiddenIntoComposer() {
    if (!pendingComposerHidden) return false;
    const editor = findComposerEditor();
    if (!editor) return false;
    const visibleText = editor.innerText.replace(/\n$/, '');
    const password = pendingComposerPw || cachedDefaultPw || null;
    let wrapped;
    try {
      wrapped = await encodeText(visibleText, pendingComposerHidden, password);
    } catch (e) {
      console.error('[MR Stego] encode error:', e);
      return false;
    }
    // Replace text trong editor với version đã wrap
    // Lexical editor: dùng InputEvent insertText không đủ → dùng execCommand
    editor.focus();
    // Select all + delete + insert
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand('insertText', false, wrapped);
    // Reset pending
    pendingComposerHidden = '';
    pendingComposerPw = '';
    updateComposerBtn();
    return true;
  }

  // Hook: capture Enter trước khi Lexical xử lý
  document.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter' || e.shiftKey) return;
    if (!pendingComposerHidden) return;
    const editor = findComposerEditor();
    if (!editor || !editor.contains(e.target) && e.target !== editor) return;

    // Chặn gửi mặc định, tự inject rồi gửi lại
    e.stopPropagation();
    e.preventDefault();
    const ok = await injectHiddenIntoComposer();
    if (ok) {
      // Sau khi inject xong, fire lại Enter để Lexical gửi tin
      setTimeout(() => {
        const newEvent = new KeyboardEvent('keydown', {
          key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
          bubbles: true, cancelable: true,
        });
        editor.dispatchEvent(newEvent);
      }, 50);
    }
  }, true);

  // Hook: click nút gửi
  document.addEventListener('click', async (e) => {
    if (!pendingComposerHidden) return;
    const sendBtn = e.target.closest('[aria-label="Nhấn Enter để gửi"], [aria-label="Press enter to send"]');
    if (!sendBtn) return;
    e.stopPropagation();
    e.preventDefault();
    const ok = await injectHiddenIntoComposer();
    if (ok) {
      setTimeout(() => sendBtn.click(), 50);
    }
  }, true);

  console.log('[MR Stego Overlay] loaded');
})();
