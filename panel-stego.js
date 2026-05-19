// ============================================================
// Panel Stego — UI mới: chỉ ⚙ Setting + 🔒 hover-popup compose
// ============================================================

(function () {
  const $menuBtn = el('stego-menu-btn');
  const $settingsPanel = el('stego-settings-panel');
  const $defaultPw = el('stego-default-pw');
  const $defaultPwEye = el('stego-default-pw-eye');
  const $saveSettings = el('stego-save-settings');
  const $saveStatus = el('stego-save-status');

  // Popup compose (icon 🔒 nổi trên nút Gửi)
  const $hoverIcon = el('stego-hover-icon');
  const $composePopup = el('stego-compose-popup');
  const $hidden = el('stego-hidden');
  const $password = el('stego-password');
  const $composeOk = el('stego-compose-ok');
  const $composeClear = el('stego-compose-clear');
  const $composeStatus = el('stego-compose-status');

  // ---- Toggle Settings panel ----
  $menuBtn.addEventListener('click', () => {
    const open = $settingsPanel.classList.toggle('open');
    $menuBtn.classList.toggle('active', open);
  });

  // ---- Load/save khoá mặc định ----
  async function loadDefaultPw() {
    try {
      const data = await chrome.storage.local.get('stego-default-pw');
      if (data['stego-default-pw']) $defaultPw.value = data['stego-default-pw'];
    } catch (_) {}
  }
  async function saveDefaultPw() {
    try {
      await chrome.storage.local.set({ 'stego-default-pw': $defaultPw.value });
      $saveStatus.textContent = '✓ Đã lưu';
      $saveStatus.style.color = '#3fb950';
      setTimeout(() => { $saveStatus.textContent = ''; }, 2000);
    } catch (e) {
      $saveStatus.textContent = '❌ Lỗi: ' + e.message;
      $saveStatus.style.color = '#f85149';
    }
  }
  $saveSettings.addEventListener('click', saveDefaultPw);

  if ($defaultPwEye) {
    $defaultPwEye.addEventListener('click', () => {
      const showing = $defaultPw.type === 'text';
      $defaultPw.type = showing ? 'password' : 'text';
      $defaultPwEye.textContent = showing ? '👁' : '🙈';
    });
  }
  loadDefaultPw();

  // ---- Hover icon 🔒 trên nút Gửi → click mở popup compose ----
  let pendingHidden = '';
  let pendingPassword = '';

  function updateHoverIcon() {
    if (pendingHidden) {
      $hoverIcon.classList.add('has-content');
      $hoverIcon.classList.add('visible'); // luôn hiện khi có tin ẩn pending
      $hoverIcon.title = 'Có tin ẩn đang chờ — click để chỉnh';
    } else {
      $hoverIcon.classList.remove('has-content');
      $hoverIcon.title = 'Soạn tin ẩn';
      // chỉ ẩn nếu không đang hover
      if (!hoverState.inputBar && !hoverState.icon) {
        $hoverIcon.classList.remove('visible');
      }
    }
  }

  // ---- Show/hide icon với delay khi rời chuột ----
  const $inputBar = el('chat-input-bar');
  const hoverState = { inputBar: false, icon: false };
  let hideTimer = null;

  function showIcon() {
    clearTimeout(hideTimer);
    $hoverIcon.classList.add('visible');
  }

  function scheduleHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      // Không ẩn nếu có tin ẩn pending hoặc popup đang mở
      if (pendingHidden) return;
      if ($composePopup.classList.contains('open')) return;
      if (hoverState.inputBar || hoverState.icon) return;
      $hoverIcon.classList.remove('visible');
    }, 400);
  }

  $inputBar.addEventListener('mouseenter', () => {
    hoverState.inputBar = true;
    showIcon();
  });
  $inputBar.addEventListener('mouseleave', () => {
    hoverState.inputBar = false;
    scheduleHide();
  });
  $hoverIcon.addEventListener('mouseenter', () => {
    hoverState.icon = true;
    showIcon();
  });
  $hoverIcon.addEventListener('mouseleave', () => {
    hoverState.icon = false;
    scheduleHide();
  });

  $hoverIcon.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = $composePopup.classList.toggle('open');
    if (isOpen) {
      $hidden.value = pendingHidden;
      $password.value = pendingPassword;
      $composeStatus.textContent = '';
      setTimeout(() => $hidden.focus(), 50);
    }
  });

  $composeOk.addEventListener('click', () => {
    pendingHidden = $hidden.value;
    pendingPassword = $password.value;
    $composePopup.classList.remove('open');
    updateHoverIcon();
  });

  $composeClear.addEventListener('click', () => {
    $hidden.value = '';
    $password.value = '';
    pendingHidden = '';
    pendingPassword = '';
    $composePopup.classList.remove('open');
    updateHoverIcon();
  });

  // Click ngoài popup → đóng
  document.addEventListener('click', (e) => {
    if (!$composePopup.contains(e.target) && e.target !== $hoverIcon) {
      $composePopup.classList.remove('open');
    }
  });

  // ---- Expose để panel.js gọi khi gửi ----
  window.StegoPanel = {
    async wrapOutgoing(visibleText) {
      if (!pendingHidden) return visibleText;
      try {
        // Dùng pass riêng nếu có, fallback về khoá mặc định
        const password = pendingPassword || $defaultPw.value || null;
        const wrapped = await Stego.encode(visibleText, pendingHidden, password);
        // Reset sau khi gửi
        pendingHidden = '';
        pendingPassword = '';
        updateHoverIcon();
        return wrapped;
      } catch (e) {
        alert('Lỗi mã hoá tin ẩn: ' + e.message);
        throw e;
      }
    },
    hasHiddenPending() {
      return !!pendingHidden;
    },
    attachLockIcon: maybeAttachLockIcon,
    openModal: openStegoModal,
    hasHidden: (t) => Stego.hasHidden(t),
  };

  // ---- Stego modal (gọi từ icon 🔒 ở tab Xem hoặc bubble chat) ----
  const $modalBg = el('stego-modal-bg');
  const $modalPw = el('stego-modal-password');
  const $modalResult = el('stego-modal-result');
  const $modalDecode = el('stego-modal-decode');
  const $modalClose = el('stego-modal-close');
  let currentModalText = '';

  function openStegoModal(fullText) {
    currentModalText = fullText;
    // Auto-fill khoá mặc định
    $modalPw.value = $defaultPw.value || '';
    $modalResult.textContent = '';
    $modalResult.classList.remove('error');
    $modalBg.classList.add('show');
    setTimeout(() => $modalPw.focus(), 50);
  }

  async function runModalDecode() {
    $modalResult.classList.remove('error');
    $modalResult.textContent = '⏳ Đang giải mã...';
    try {
      const result = await Stego.decode(currentModalText, $modalPw.value);
      if (result.error) {
        $modalResult.classList.add('error');
        $modalResult.textContent = '❌ ' + result.error +
          (result.encrypted ? ' (tin đã mã hoá AES-GCM)' : '');
        return;
      }
      if (result.hidden == null) {
        $modalResult.classList.add('error');
        $modalResult.textContent = 'ℹ️ Không tìm thấy tin ẩn.';
        return;
      }
      const icon = result.encrypted ? '🔐' : '🔓';
      const visPart = result.visible
        ? `\n\n── Visible ──\n${result.visible}`
        : '';
      $modalResult.textContent = `${icon} ${result.hidden}${visPart}`;
    } catch (e) {
      $modalResult.classList.add('error');
      $modalResult.textContent = '❌ Lỗi: ' + e.message;
    }
  }

  $modalDecode.addEventListener('click', runModalDecode);
  $modalPw.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runModalDecode();
  });
  $modalClose.addEventListener('click', () => $modalBg.classList.remove('show'));
  $modalBg.addEventListener('click', (e) => {
    if (e.target === $modalBg) $modalBg.classList.remove('show');
  });

  // ---- Helper: gắn icon 🔒 vào element nếu text chứa hidden payload ----
  function maybeAttachLockIcon(containerEl, text) {
    if (!text || !Stego.hasHidden(text)) return false;
    const icon = document.createElement('span');
    icon.className = 'stego-lock-icon';
    icon.textContent = '🔒';
    icon.title = 'Tin có nội dung ẩn — click để giải mã';
    icon.addEventListener('click', (e) => {
      e.stopPropagation();
      openStegoModal(text);
    });
    containerEl.appendChild(icon);
    return true;
  }
})();
