// ===== API client =====
// Cấu hình base URL & API key từ localStorage (UI sẽ cho user setup)
const API_BASE = localStorage.getItem('apiBase') || '';
const API_KEY = localStorage.getItem('apiKey') || '';

function apiFetch(path, opts = {}) {
  const url = API_BASE ? API_BASE.replace(/\/$/, '') + path : path;
  const headers = { ...(opts.headers || {}) };
  if (API_KEY) headers['X-API-Key'] = API_KEY;
  return fetch(url, { ...opts, headers });
}

const api = {
  list: () => apiFetch('/api/accounts').then((r) => r.json()),
  add: (body) => apiFetch('/api/accounts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(async (r) => {
    if (!r.ok) throw new Error((await r.json()).error || 'add failed');
    return r.json();
  }),
  start: (id) => apiFetch(`/api/accounts/${id}/start`, { method: 'POST' }).then(async (r) => {
    if (!r.ok) throw new Error((await r.json()).error || 'start failed');
    return r.json();
  }),
  stop: (id) => apiFetch(`/api/accounts/${id}/stop`, { method: 'POST' }).then((r) => r.json()),
  remove: (id) => apiFetch(`/api/accounts/${id}`, { method: 'DELETE' }).then((r) => r.json()),
  getAI: (id) => apiFetch(`/api/accounts/${id}/ai`).then((r) => r.json()),
  saveAI: (id, body) => apiFetch(`/api/accounts/${id}/ai`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json()),
  refresh: (id, body) => apiFetch(`/api/accounts/${id}/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  }).then(async (r) => {
    if (!r.ok) throw new Error((await r.json()).error || 'refresh failed');
    return r.json();
  }),
};

const $ = (id) => document.getElementById(id);
const $list = $('accounts-list');

// ===== Render =====
// (refresh là alias của tick — định nghĩa bên dưới)

function renderCard(a) {
  const aiOn = a.aiConfig?.enabled;
  const p = a.progress || { percent: 0, label: '' };
  const showProgress = a.status === 'starting' || (a.status === 'running' && p.percent === 100 && p.label);
  return `
    <div class="account-card ${a.status === 'error' ? 'error' : ''}" data-id="${a.id}">
      <div class="account-info">
        <div class="account-id">${a.id}</div>
        <div class="account-meta">
          <span class="status-badge status-${a.status}">${a.status.toUpperCase()}</span>
          <span>🍪 <b>${a.cookieCount}</b> cookies</span>
          <span class="ai-toggle ${aiOn ? 'on' : ''}">
            ${aiOn ? '🤖 AI ON' : '⚪ AI OFF'} • ${a.aiConfig?.model || ''}
          </span>
        </div>
        ${a.error ? `<div class="account-error">⚠ ${a.error}</div>` : ''}
        ${a.status === 'starting' ? `
          <div class="progress">
            <div class="progress-bar">
              <div class="progress-bar-fill" style="width: ${p.percent}%"></div>
            </div>
            <div class="progress-label">
              <span>${p.label || '...'}</span>
              <span class="pct">${p.percent}%</span>
            </div>
          </div>
        ` : ''}
      </div>
      <div class="account-actions">
        <div class="account-actions-row">
          ${a.status === 'running' || a.status === 'starting'
            ? `<button onclick="onStop('${a.id}')" class="danger">⏹ Stop</button>`
            : `<button onclick="onStart('${a.id}')" class="success">▶ Start</button>`
          }
          <button onclick="onRefresh('${a.id}')" ${a.status !== 'running' ? 'disabled' : ''}>↻ Tải lại</button>
          <button onclick="onConfigAI('${a.id}')">⚙ AI</button>
          <button onclick="onToggleAI('${a.id}', ${!aiOn})" ${a.status !== 'running' ? 'disabled' : ''}>
            ${aiOn ? '⏸ AI OFF' : '▶ AI ON'}
          </button>
          <button onclick="onRemove('${a.id}')" class="danger">🗑</button>
        </div>
      </div>
    </div>
  `;
}

// ===== Actions =====
window.onStart = async (id) => {
  try { await api.start(id); } catch (e) { alert('Start failed: ' + e.message); }
  refresh();
};
window.onStop = async (id) => { await api.stop(id); refresh(); };
window.onRefresh = async (id) => {
  const threadKey = prompt('Nhập threadKey (số ID thread):', localStorage.getItem('lastThreadKey') || '');
  if (!threadKey) return;
  localStorage.setItem('lastThreadKey', threadKey);
  try {
    const r = await api.refresh(id, { threadKey: threadKey.trim(), numMessages: 20 });
    const lines = [];
    if (r.status) {
      lines.push(`✅ myId=${r.status.myId}`);
    }
    if (r.success !== undefined) lines.push(`Bridge success: ${r.success} | Tin nhắn: ${r.messageCount}`);
    if (r.sample?.length) {
      lines.push('\n--- Tin nhắn ---');
      r.sample.forEach((m, i) => lines.push(`${i+1}. [${m.ts}] ${m.sender}: ${(m.text || '[no text]').slice(0, 80)}`));
    }
    if (r.error) lines.push(`❌ ${r.error}`);
    alert(lines.join('\n'));
  } catch (e) {
    alert('Refresh failed: ' + e.message);
  }
};
window.onRemove = async (id) => {
  if (!confirm('Xoá account ' + id + '?')) return;
  await api.remove(id); refresh();
};
window.onToggleAI = async (id, enabled) => {
  await api.saveAI(id, { enabled });
  refresh();
};
window.onConfigAI = async (id) => {
  const cfg = await api.getAI(id);
  $('ai-acc-id').textContent = id;
  $('ai-acc-id').dataset.id = id;
  $('ai-api-key').value = cfg.apiKey === '***' ? '' : (cfg.apiKey || '');
  $('ai-model').value = cfg.model || 'google/gemma-4-26B-A4B-it';
  $('ai-temp').value = cfg.temperature ?? 0.7;
  $('ai-max-tokens').value = cfg.maxTokens ?? 512;
  $('ai-delay').value = cfg.delaySec ?? 30;
  $('ai-context-size').value = cfg.contextSize ?? 20;
  $('ai-system-prompt').value = cfg.systemPrompt || '';
  openModal('modal-ai');
};

// ===== Modal handling =====
function openModal(id) { $(id).classList.add('open'); }
function closeModal(id) { $(id).classList.remove('open'); }
document.querySelectorAll('[data-close]').forEach((el) => {
  el.addEventListener('click', () => closeModal(el.dataset.close));
});

// ===== Add account =====
$('btn-add').addEventListener('click', () => {
  $('add-input').value = '';
  $('add-hint').textContent = 'Chờ input...';
  $('add-hint').className = 'hint';
  $('add-confirm').disabled = true;
  openModal('modal-add');
});
$('btn-refresh').addEventListener('click', refresh);

// Server config
$('btn-config').addEventListener('click', () => {
  $('cfg-api-base').value = API_BASE;
  $('cfg-api-key').value = API_KEY;
  openModal('modal-config');
});
$('cfg-save').addEventListener('click', () => {
  localStorage.setItem('apiBase', $('cfg-api-base').value.trim());
  localStorage.setItem('apiKey', $('cfg-api-key').value.trim());
  location.reload();
});

let parsedAdd = null;
$('add-input').addEventListener('input', () => {
  const raw = $('add-input').value.trim();
  if (!raw) {
    parsedAdd = null;
    $('add-hint').textContent = 'Chờ input...';
    $('add-hint').className = 'hint';
    $('add-confirm').disabled = true;
    return;
  }
  try {
    const o = JSON.parse(raw);
    if (!o.cookies || !Array.isArray(o.cookies) || !o.cookies.length) throw new Error('Thiếu cookies array');
    if (!o.pinCode || o.pinCode.length !== 6) throw new Error('pinCode phải 6 chữ số');
    const cUser = o.cookies.find((c) => c.name === 'c_user');
    if (!cUser) throw new Error('Thiếu c_user cookie');
    parsedAdd = o;
    $('add-hint').textContent = `✅ ${o.cookies.length} cookies, account ${cUser.value}`;
    $('add-hint').className = 'hint ok';
    $('add-confirm').disabled = false;
  } catch (e) {
    parsedAdd = null;
    $('add-hint').textContent = '❌ ' + e.message;
    $('add-hint').className = 'hint err';
    $('add-confirm').disabled = true;
  }
});
$('add-confirm').addEventListener('click', async () => {
  if (!parsedAdd) return;
  try {
    await api.add(parsedAdd);
    closeModal('modal-add');
    tick();
  } catch (e) {
    $('add-hint').textContent = '❌ ' + e.message;
    $('add-hint').className = 'hint err';
  }
});

// ===== AI save =====
$('ai-save').addEventListener('click', async () => {
  const id = $('ai-acc-id').dataset.id;
  const apiKey = $('ai-api-key').value.trim();
  const patch = {
    model: $('ai-model').value,
    temperature: parseFloat($('ai-temp').value),
    maxTokens: parseInt($('ai-max-tokens').value),
    delaySec: parseInt($('ai-delay').value),
    contextSize: parseInt($('ai-context-size').value),
    systemPrompt: $('ai-system-prompt').value,
  };
  if (apiKey) patch.apiKey = apiKey;
  await api.saveAI(id, patch);
  closeModal('modal-ai');
  refresh();
});

// ===== Init =====
let lastAccounts = [];
async function tick() {
  try {
    const accounts = await api.list();
    lastAccounts = accounts;
    if (!accounts.length) {
      $list.innerHTML = `<div class="empty">Chưa có account. Bấm <b>Thêm account</b> để bắt đầu.</div>`;
      return;
    }
    $list.innerHTML = accounts.map(renderCard).join('');
  } catch (e) {
    $list.innerHTML = `<div class="empty">Lỗi tải danh sách: ${e.message}</div>`;
  }
}
const refresh = tick; // alias
tick();
// 1s khi có account starting, 5s khi không
setInterval(() => {
  const hasStarting = lastAccounts.some((a) => a.status === 'starting');
  // Always tick — interval is 1s, just throttle when idle
  tick();
}, 1000);
