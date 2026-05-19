const NEEDED = ['c_user', 'xs', 'fr', 'sb', 'datr', 'ps_l', 'ps_n', 'wd', 'dpr'];

// ---- Tab switching ----
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
  });
});

// ---- Export tab — PIN validation ----
const $pin = document.getElementById('pin-input');
const $pinHint = document.getElementById('pin-hint');
const $btnExport = document.getElementById('btn-export');

$pin.addEventListener('input', () => {
  // Chỉ cho phép số
  $pin.value = $pin.value.replace(/\D/g, '');
  const v = $pin.value;
  if (v.length === 0) {
    $pin.className = '';
    $pinHint.className = 'parse-hint';
    $pinHint.textContent = 'Nhập 6 chữ số';
    $btnExport.disabled = true;
  } else if (v.length === 6) {
    $pin.className = 'valid';
    $pinHint.className = 'parse-hint ok';
    $pinHint.textContent = '✅ Hợp lệ';
    $btnExport.disabled = false;
  } else {
    $pin.className = 'invalid';
    $pinHint.className = 'parse-hint err';
    $pinHint.textContent = `❌ Còn ${6 - v.length} chữ số`;
    $btnExport.disabled = true;
  }
});

// ---- Export tab — click ----
$btnExport.addEventListener('click', async () => {
  const status = document.getElementById('export-status');
  const preview = document.getElementById('cookie-preview');
  const pinCode = $pin.value;

  if (pinCode.length !== 6) return;

  $btnExport.disabled = true;
  $btnExport.classList.add('loading');
  $btnExport.textContent = '⏳ Đang đọc...';
  status.className = 'status';
  status.textContent = '';

  chrome.cookies.getAll({ domain: '.facebook.com' }, async (cookies) => {
    const found = cookies.filter(c => NEEDED.includes(c.name)).map(c => ({
      name: c.name,
      value: c.value,
      httpOnly: c.httpOnly,
      sameSite: c.sameSite,
    }));

    const payload = { cookies: found, pinCode };
    const json = JSON.stringify(payload, null, 2);

    preview.classList.add('show');
    preview.innerHTML = [
      `<div style="color:#8b949e;margin-bottom:4px">🍪 ${found.length} cookies</div>`,
      ...found.map(c => `<div><b style="color:#58a6ff">${c.name}</b>: ${c.value.slice(0, 35)}${c.value.length > 35 ? '…' : ''}</div>`),
      `<div style="color:#8b949e;margin-top:4px">🔐 PIN: ••••••</div>`,
    ].join('');

    try {
      await navigator.clipboard.writeText(json);
      status.className = 'status ok';
      status.textContent = `✅ Đã copy ${found.length} cookies + PIN!`;
    } catch (e) {
      status.className = 'status err';
      status.textContent = '❌ Không copy được: ' + e.message;
    }

    $btnExport.disabled = false;
    $btnExport.classList.remove('loading');
    $btnExport.textContent = '📋 Export & Copy';
  });
});

// ---- Inject tab — parse & validate ----
const $input = document.getElementById('cookie-input');
const $hint = document.getElementById('parse-hint');
const $btnInject = document.getElementById('btn-inject');

let parsedCookies = null;

$input.addEventListener('input', () => {
  const raw = $input.value.trim();
  if (!raw) {
    $input.className = '';
    $hint.className = 'parse-hint';
    $hint.textContent = 'Chờ input...';
    $btnInject.disabled = true;
    parsedCookies = null;
    return;
  }
  try {
    const obj = JSON.parse(raw);
    // Hỗ trợ cả format mới { cookies, pinCode } lẫn array cũ
    const arr = Array.isArray(obj) ? obj : obj.cookies;
    if (!Array.isArray(arr) || arr.length === 0) throw new Error('Không phải array');
    const names = arr.map(c => c.name);
    const missing = ['c_user', 'xs'].filter(n => !names.includes(n));
    if (missing.length) throw new Error('Thiếu: ' + missing.join(', '));
    parsedCookies = arr;
    $input.className = 'valid';
    $hint.className = 'parse-hint ok';
    $hint.textContent = `✅ ${arr.length} cookies hợp lệ`;
    $btnInject.disabled = false;
  } catch (e) {
    parsedCookies = null;
    $input.className = 'invalid';
    $hint.className = 'parse-hint err';
    $hint.textContent = '❌ ' + e.message;
    $btnInject.disabled = true;
  }
});

// ---- Inject tab — start ----
$btnInject.addEventListener('click', async () => {
  if (!parsedCookies) return;

  const status = document.getElementById('inject-status');
  $btnInject.disabled = true;
  $btnInject.classList.add('loading');
  $btnInject.textContent = '⏳ Đang inject...';
  status.className = 'status';
  status.textContent = '';

  let ok = 0, fail = 0;
  for (const c of parsedCookies) {
    try {
      await chrome.cookies.set({
        url: 'https://www.facebook.com',
        name: c.name,
        value: c.value,
        domain: '.facebook.com',
        path: '/',
        secure: true,
        httpOnly: c.httpOnly || false,
        sameSite: c.sameSite || 'no_restriction',
      });
      ok++;
    } catch (e) {
      fail++;
    }
  }

  status.className = 'status ok';
  status.textContent = `✅ Inject xong ${ok} cookies${fail ? `, lỗi ${fail}` : ''}. Đang mở Messenger...`;

  setTimeout(async () => {
    await chrome.tabs.create({ url: 'https://www.facebook.com/messages/' });
    window.close();
  }, 800);

  $btnInject.classList.remove('loading');
  $btnInject.textContent = '🚀 Start Inject';
});
