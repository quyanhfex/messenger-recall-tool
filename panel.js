// ============================================================
// MESSENGER RECALL — Unified panel
// 1 list duy nhất gộp DB messages + extras từ mpsLoadMessages
// ============================================================

// ---- State ----
const allMessages = new Map();    // messageId → MsgItem
const contactCache = new Map();   // userId → { name, avatarUrl }
let currentThreadKey = null;   // thread đang mở trên tab Messenger
let selectedViewThreadKey = null; // thread đang xem trong tab Xem
let myId = null;
let lastStatus = null;
let sortDesc = true;
let selectedIds = new Set();
let lastClickedId = null;          // anchor cho range select (shift-click)

// Load state
let loActiveRequestId = null;
let loRunning = false;
let loNewestTs = 0;
let loFromDateMs = 0;

// Revoke state
let rvRunning = false;
let rvAbort = false;

// ---- Helpers ----
const el = (id) => document.getElementById(id);

function rpc(action, params) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ target: 'page', request: { action, params } }, (resp) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(resp || { ok: false, error: 'no_response' });
      }
    });
  });
}

function logLine(msg, kind = 'info') {
  const div = document.createElement('div');
  div.className = kind;
  const ts = new Date().toTimeString().slice(0, 8);
  div.textContent = `[${ts}] ${msg}`;
  $log.appendChild(div);
  $log.scrollTop = $log.scrollHeight;
  if ($log.children.length > 200) $log.removeChild($log.firstChild);
}

function fmtTime(ms) {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return hh + ':' + mm;
}

function fmtDateKey(ms) {
  const d = new Date(ms);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yy = d.getFullYear();
  return `${dd}/${mm}/${yy}`;
}

function fmtFull(ms) {
  return new Date(ms).toLocaleString('vi-VN');
}

// ---- DOM refs ----
const $banner = el('banner');
const $statusDot = el('status-dot');
const $statusText = el('status-text');
const $threadInfo = el('thread-info');
const $userInfo = el('user-info');
const $log = el('log');
const $list = el('list');
const $listWrap = el('list-wrapper');

// Load section
const $loFrom = el('lo-from');
const $loSize = el('lo-size');
const $loDelay = el('lo-delay');
const $loStart = el('lo-start');
const $loStop = el('lo-stop');
const $loBar = el('lo-bar');
const $loState = el('lo-state');
const $loBatch = el('lo-batch');
const $loCount = el('lo-count');
const $loOldest = el('lo-oldest');

// Filter
const $fOnlyMine = el('f-onlymine');
const $fHideUnsent = el('f-hideunsent');
const $fHideAdmin = el('f-hideadmin');
const $fSearch = el('f-search');
const $fFrom = el('f-from');
const $fTo = el('f-to');

// Summary
const $sumTotal = el('sum-total');
const $sumMine = el('sum-mine');
const $sumDb = el('sum-db');
const $sumExtra = el('sum-extra');
const $sumSel = el('sum-sel');

// Revoke
const $dlMin = el('dlmin');
const $dlMax = el('dlmax');
const $btnRvSel = el('btn-rv-sel');
const $btnRvRange = el('btn-rv-range');
const $btnRvStop = el('btn-rv-stop');
const $rvProgress = el('rv-progress');
const $rvBar = el('rv-bar');

// ---- Banner / status ----
function setBanner(text, kind) {
  if (!text) { $banner.className = ''; $banner.textContent = ''; return; }
  $banner.className = 'show' + (kind === 'warn' ? ' warn' : '');
  $banner.textContent = text;
}

function updateStatusUI(status) {
  lastStatus = status;
  if (!status) {
    $statusDot.className = 'status-dot error';
    $statusText.textContent = 'Không kết nối được tab Messenger';
    return;
  }
  if (!status.isFacebook) {
    $statusDot.className = 'status-dot error';
    $statusText.textContent = 'Không phải tab Facebook';
    setBanner('Mở tab https://www.facebook.com/messages/ để dùng tool', 'warn');
    return;
  }
  if (!status.storeReady) {
    $statusDot.className = 'status-dot warn';
    $statusText.textContent = 'Đang chờ store...';
    setBanner(null);
    return;
  }
  if (!status.modulesReady) {
    const miss = Object.entries(status.modules).filter(([k, v]) => !v).map(([k]) => k);
    $statusDot.className = 'status-dot error';
    $statusText.textContent = 'Module thiếu: ' + miss.join(', ');
    setBanner('Một số module nội bộ Messenger không tìm thấy.', 'warn');
    return;
  }
  $statusDot.className = 'status-dot ok';
  $statusText.textContent = 'Sẵn sàng';
  setBanner(null);

  myId = status.myId;
  const prevThread = currentThreadKey;
  currentThreadKey = status.threadKey;
  // Nếu chưa chọn thread thủ công, tự động theo thread hiện tại
  if (!selectedViewThreadKey || selectedViewThreadKey === prevThread) selectedViewThreadKey = currentThreadKey;
  if (!selectedChatThreadKey || selectedChatThreadKey === prevThread) selectedChatThreadKey = currentThreadKey;
  $threadInfo.textContent = status.threadKey
    ? (status.threadName || 'Thread') + '  ·  ' + status.threadKey
    : 'Chưa mở thread cụ thể';
  const $userInfoText = el('user-info-text');
  if ($userInfoText) $userInfoText.textContent = 'ID người dùng: ' + (status.myId || '?') + '  ·  Đã giải mã: ' + status.plaintextCacheSize + ' tin nhắn';
}

// ============================================================
// DATA: unified messages
// ============================================================
function isCipherText(s) {
  if (!s) return false;
  // E2EE ciphertext format: "<keyId>##<base64payload>" hoặc "mid.$..."
  if (/^\d+##/.test(s)) return true;
  if (/^[A-Za-z0-9+/=_-]{40,}$/.test(s)) return true; // base64 dài
  return false;
}

function dbToItem(m, plain) {
  let text = plain && plain.text ? plain.text : null;
  if (!text && m.text && !isCipherText(m.text)) text = m.text;
  // Derive threadIdAtMsgr + externalId tu messageId neu format "<prefix>@msgr.<num>"
  let tia = null, ext = null;
  if (typeof m.messageId === 'string' && m.messageId.includes('@msgr.')) {
    const parts = m.messageId.split('.');
    tia = parts[0];
    ext = parts[1];
  }
  return {
    messageId: m.messageId,
    threadKeyStr: m.threadKeyStr,
    senderIdStr: m.senderIdStr,
    isMine: m.senderIdStr === myId,
    isUnsent: !!m.isUnsent,
    isAdmin: !!m.isAdminMessage,
    timestampMs: m.timestampMsNum,
    text,
    senderName: plain && plain.senderName,
    source: 'db',
    cannotUnsendReason: m.cannotUnsendReason,
    threadIdAtMsgr: tia,
    externalId: ext,
  };
}

function extraToItem(e, threadKey) {
  return {
    messageId: e.messageId,                          // "100068...@msgr.7449..."
    threadKeyStr: threadKey || currentThreadKey,
    senderIdStr: e.senderId,
    isMine: e.isMine,
    isUnsent: false,
    isAdmin: false,
    timestampMs: e.timestampMs,
    text: e.text,
    senderName: null,
    source: 'extra',
    cannotUnsendReason: null,
    threadIdAtMsgr: e.threadIdAtMsgr,
    externalId: e.externalId,
  };
}

function mergeMsg(item) {
  const existing = allMessages.get(item.messageId);
  if (!existing) {
    allMessages.set(item.messageId, item);
    return;
  }
  if (item.source === 'db') {
    // DB ghi đè state (isUnsent, cannotUnsendReason) nhưng GIỮ text+ids extra nếu DB thiếu
    const merged = { ...existing, ...item };
    if (!item.text && existing.text) merged.text = existing.text;
    if (!item.threadIdAtMsgr && existing.threadIdAtMsgr) merged.threadIdAtMsgr = existing.threadIdAtMsgr;
    if (!item.externalId && existing.externalId) merged.externalId = existing.externalId;
    allMessages.set(item.messageId, merged);
  } else {
    if (!existing.text && item.text) existing.text = item.text;
    if (!existing.threadIdAtMsgr) existing.threadIdAtMsgr = item.threadIdAtMsgr;
    if (!existing.externalId) existing.externalId = item.externalId;
  }
}

// ============================================================
// FILTER
// ============================================================
function applyFilter() {
  const onlyMine = $fOnlyMine.checked;
  const hideUnsent = $fHideUnsent.checked;
  const hideAdmin = $fHideAdmin.checked;
  const search = $fSearch.value.trim().toLowerCase();
  const from = $fFrom.value ? new Date($fFrom.value).getTime() : null;
  const to = $fTo.value ? new Date($fTo.value).getTime() + 86400000 : null;

  const viewThread = selectedViewThreadKey || currentThreadKey;
  const out = [];
  for (const m of allMessages.values()) {
    if (m.threadKeyStr !== viewThread) continue;
    if (onlyMine && !m.isMine) continue;
    if (hideUnsent && m.isUnsent) continue;
    if (hideAdmin && m.isAdmin) continue;
    if (from && m.timestampMs < from) continue;
    if (to && m.timestampMs > to) continue;
    if (search) {
      if (!m.text || !m.text.toLowerCase().includes(search)) continue;
    }
    out.push(m);
  }
  out.sort((a, b) => sortDesc ? b.timestampMs - a.timestampMs : a.timestampMs - b.timestampMs);
  return out;
}

function isCallEvent(m) {
  return typeof m.text === 'string' && /^\[(cuộc gọi|video call)/.test(m.text);
}

// Có thể revoke không? (chỉ tin của mình, chưa thu hồi, không phải admin, không phải call event)
function canRevoke(m) {
  if (!m.isMine) return false;
  if (m.isUnsent) return false;
  if (m.isAdmin) return false;
  if (isCallEvent(m)) return false;
  if (m.source === 'db') {
    const r = m.cannotUnsendReason;
    if (r && r !== 0 && !(Array.isArray(r) && r[0] === 0 && r[1] === 0)) return false;
  }
  return true;
}

// ============================================================
// RENDER
// ============================================================
function renderList() {
  const filtered = applyFilter();
  const sortBtn = el('sort-time');
  if (sortBtn) sortBtn.textContent = 'Time ' + (sortDesc ? '↓' : '↑');

  $list.innerHTML = '';
  const frag = document.createDocumentFragment();
  let lastDateKey = null;

  for (const m of filtered) {
    const dateKey = fmtDateKey(m.timestampMs);
    if (dateKey !== lastDateKey) {
      const div = document.createElement('div');
      div.className = 'date-divider';
      div.textContent = dateKey;
      frag.appendChild(div);
      lastDateKey = dateKey;
    }

    const row = document.createElement('div');
    const revokable = canRevoke(m);
    row.className = 'msg-row';
    if (selectedIds.has(m.messageId)) row.classList.add('selected');
    if (lastClickedId === m.messageId) row.classList.add('range-anchor');
    if (!revokable) row.classList.add('norevoke');
    row.dataset.mid = m.messageId;
    row.title = `messageId: ${m.messageId}\ntime: ${fmtFull(m.timestampMs)}\nsenderId: ${m.senderIdStr || '?'}\nsource: ${m.source}`;

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = selectedIds.has(m.messageId);
    cb.disabled = !revokable;
    cb.addEventListener('click', (e) => {
      e.stopPropagation();
      handleCheckbox(m.messageId, cb.checked, e.shiftKey);
    });
    row.appendChild(cb);

    const time = document.createElement('div');
    time.className = 'time';
    time.textContent = fmtTime(m.timestampMs);
    row.appendChild(time);

    const sender = document.createElement('div');
    sender.className = 'sender' + (m.isMine ? ' me' : '');
    if (m.isMine) {
      sender.textContent = 'Bạn';
    } else {
      const c = contactCache.get(m.senderIdStr);
      const name = c?.name || c?.firstName || m.senderName || (m.senderIdStr || '?').slice(-6);
      sender.textContent = name;
      if (c?.name) sender.title = c.name + ' (' + m.senderIdStr + ')';
    }
    row.appendChild(sender);

    const text = document.createElement('div');
    text.className = 'text';
    if (m.isUnsent) {
      text.classList.add('unsent');
      text.textContent = '[đã thu hồi]';
    } else if (m.isAdmin) {
      text.classList.add('unsent');
      text.textContent = '[tin nhắn hệ thống]';
    } else if (m.text === '[ảnh]') {
      text.classList.add('media-link');
      text.textContent = '🖼️ [ảnh] — bấm để xem';
      text.title = 'Bấm để xem ảnh';
      text.addEventListener('click', (e) => {
        e.stopPropagation();
        openMediaPreview(m);
      });
    } else if (isCallEvent(m)) {
      text.classList.add('empty');
      text.textContent = '📞 ' + m.text;
      text.title = 'Cuộc gọi không thể thu hồi cho người khác';
    } else if (m.text) {
      // Nếu có stego payload → hiển thị phần visible, gắn icon 🔒
      if (window.StegoPanel && window.StegoPanel.hasHidden(m.text)) {
        const magicIdx = m.text.indexOf('‌​‌​');
        const visible = magicIdx >= 0 ? m.text.slice(0, magicIdx) : m.text;
        text.textContent = visible || '·';
        window.StegoPanel.attachLockIcon(text, m.text);
      } else {
        text.textContent = m.text;
      }
    } else {
      text.classList.add('empty');
      text.textContent = '[không giải mã được]';
    }
    if (!revokable && !m.isUnsent && !m.isMine) text.classList.add('notmine');
    row.appendChild(text);

    const flag = document.createElement('div');
    flag.className = 'flag';
    const src = document.createElement('span');
    src.className = 'src ' + m.source;
    src.textContent = m.source === 'db' ? '💾' : '☁️';
    src.title = m.source === 'db' ? 'Có trong LSDatabase' : 'Extra (vừa tải qua bridge)';
    flag.appendChild(src);
    if (revokable) {
      const btn = document.createElement('button');
      btn.className = 'revoke-btn';
      btn.textContent = '🗑';
      btn.title = 'Thu hồi tin nhắn này';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        revokeSingle(m);
      });
      flag.appendChild(btn);
    }
    row.appendChild(flag);

    frag.appendChild(row);
  }
  $list.appendChild(frag);
  updateSummary(filtered);
}

function handleCheckbox(mid, checked, shiftKey) {
  if (shiftKey && lastClickedId && lastClickedId !== mid) {
    // Range select
    const filtered = applyFilter();
    const idx1 = filtered.findIndex((m) => m.messageId === lastClickedId);
    const idx2 = filtered.findIndex((m) => m.messageId === mid);
    if (idx1 >= 0 && idx2 >= 0) {
      const [lo, hi] = idx1 < idx2 ? [idx1, idx2] : [idx2, idx1];
      for (let i = lo; i <= hi; i++) {
        const m = filtered[i];
        if (canRevoke(m)) {
          if (checked) selectedIds.add(m.messageId);
          else selectedIds.delete(m.messageId);
        }
      }
    }
  } else {
    if (checked) selectedIds.add(mid);
    else selectedIds.delete(mid);
  }
  lastClickedId = mid;
  renderList();
}

function updateSummary(filtered) {
  const viewThread = selectedViewThreadKey || currentThreadKey;
  const all = [...allMessages.values()].filter((m) => m.threadKeyStr === viewThread);
  $sumTotal.textContent = all.length;
  $sumMine.textContent = all.filter((m) => m.isMine).length;
  $sumDb.textContent = all.filter((m) => m.source === 'db').length;
  $sumExtra.textContent = all.filter((m) => m.source === 'extra').length;
  $sumSel.textContent = selectedIds.size;
  $btnRvSel.disabled = rvRunning || selectedIds.size === 0;
  $btnRvRange.disabled = rvRunning || selectedIds.size < 2;
}

// ============================================================
// REFRESH from LSDatabase
// ============================================================
async function refreshAll() {
  const st = await rpc('status');
  if (!st.ok) { logLine('Không kết nối được: ' + st.error, 'err'); updateStatusUI(null); return; }
  updateStatusUI(st.result);

  if (!st.result.storeReady || !st.result.threadKey) return;

  const [msgsResp, pcResp] = await Promise.all([
    rpc('getAllMessages'),
    rpc('refreshPlaintextCache'),
  ]);
  if (!msgsResp.ok) { logLine('Không lấy được tin nhắn: ' + msgsResp.error, 'err'); return; }

  const plain = pcResp.ok ? new Map(pcResp.result.entries) : new Map();

  // Reset DB items (giữ lại extras)
  for (const [k, m] of [...allMessages.entries()]) {
    if (m.source === 'db') allMessages.delete(k);
  }
  for (const m of msgsResp.result || []) {
    mergeMsg(dbToItem(m, plain.get(m.messageId)));
  }
  renderList();

  // Load persisted extras for current thread
  await loadExtrasFromStorage();
  loadChatPeer();
  buildThreadDropdown();

  // Load contact names (async, không block render)
  loadContactsInBackground();

  // Enrich tin DB chưa có text bằng cách fetch payload qua bridge (~2 batch)
  enrichDbInBackground();
}

async function loadContactsInBackground() {
  const ids = new Set();
  for (const m of allMessages.values()) {
    if (m.threadKeyStr === currentThreadKey && m.senderIdStr && !contactCache.has(m.senderIdStr)) {
      ids.add(m.senderIdStr);
    }
  }
  if (!ids.size) return;
  const resp = await rpc('getContactsByIds', { userIds: [...ids] });
  if (!resp.ok) return;
  let added = 0;
  for (const [id, info] of Object.entries(resp.result || {})) {
    contactCache.set(id, info);
    added++;
  }
  if (added) renderList();
}

async function enrichDbInBackground() {
  const needText = [...allMessages.values()].some((m) =>
    m.threadKeyStr === currentThreadKey && m.source === 'db' && !m.text && !m.isUnsent && !m.isAdmin
  );
  if (!needText) return;
  const resp = await rpc('enrichDbMessages', { numBatches: 2, batchSize: 50 });
  if (!resp.ok) { logLine('Enrich fail: ' + resp.error, 'err'); return; }
  let updated = 0;
  for (const e of (resp.result.enriched || [])) {
    const existing = allMessages.get(e.messageId);
    if (existing && !existing.text) {
      existing.text = e.text;
      updated++;
    }
  }
  if (updated) {
    renderList();
  }
}

// ============================================================
// PERSIST extras
// ============================================================
function extrasStorageKey(threadKey) {
  return 'mr-extras:' + threadKey;
}

async function saveExtrasToStorage(threadKey) {
  const saveThread = threadKey || currentThreadKey;
  if (!saveThread) return;
  const extras = [...allMessages.values()]
    .filter((m) => m.source === 'extra' && m.threadKeyStr === saveThread);
  if (!extras.length) return;
  try {
    await chrome.storage.local.set({
      [extrasStorageKey(saveThread)]: {
        savedAt: Date.now(),
        items: extras.map((m) => ({
          messageId: m.messageId,
          senderId: m.senderIdStr,
          isMine: m.isMine,
          timestampMs: m.timestampMs,
          text: m.text,
          threadIdAtMsgr: m.threadIdAtMsgr,
          externalId: m.externalId,
        })),
      },
    });
  } catch (e) {
    console.warn('saveExtras fail', e);
  }
}

async function loadExtrasFromStorage() {
  if (!currentThreadKey) return;
  try {
    const k = extrasStorageKey(currentThreadKey);
    const data = await chrome.storage.local.get(k);
    const entry = data[k];
    if (!entry || !entry.items) return;
    // TTL 7 ngày
    if (Date.now() - entry.savedAt > 7 * 86400000) {
      await chrome.storage.local.remove(k);
      return;
    }
    for (const e of entry.items) mergeMsg(extraToItem(e));
    logLine(`Đã tải lại ${entry.items.length} tin nhắn từ bộ nhớ`, 'info');
    renderList();
  } catch (e) {
    console.warn('loadExtras fail', e);
  }
}

async function clearExtras() {
  if (!confirm('Xoá toàn bộ tin nhắn đã tải thêm của cuộc trò chuyện này? (Tin nhắn có sẵn vẫn giữ)')) return;
  for (const [k, m] of [...allMessages.entries()]) {
    if (m.source === 'extra' && m.threadKeyStr === currentThreadKey) {
      allMessages.delete(k);
      selectedIds.delete(k);
    }
  }
  try {
    await chrome.storage.local.remove(extrasStorageKey(currentThreadKey));
  } catch (_) {}
  renderList();
  logLine('Đã xoá extras', 'ok');
}

// ============================================================
// LOAD OLDER
// ============================================================
function loSetRunning(running) {
  loRunning = running;
  $loStart.disabled = running;
  $loStop.disabled = !running;
  $loFrom.disabled = running;
  $loSize.disabled = running;
  $loDelay.disabled = running;
}

async function startLoad() {
  if (loRunning) return;
  $loBar.style.width = '0%';
  $loBatch.textContent = '0';
  $loCount.textContent = '0';
  $loOldest.textContent = '—';
  $loState.textContent = 'Đang tải...';

  const fromDate = $loFrom.value ? new Date($loFrom.value).getTime() : 0;
  const batchSize = parseInt($loSize.value) || 50;
  const delayMs = parseInt($loDelay.value) || 200;
  const requestId = 'lo-' + Date.now();
  loActiveRequestId = requestId;
  loFromDateMs = fromDate;
  loNewestTs = 0;
  loSetRunning(true);

  const loadThread = selectedViewThreadKey || currentThreadKey;
  logLine(`📥 Bắt đầu tải tin nhắn thread ${loadThread} (đến ngày ${$loFrom.value || 'không giới hạn'})`, 'info');
  const resp = await rpc('loadOlderMessages', { fromDate, maxBatches: 500, batchSize, delayMs, requestId, threadKey: loadThread });
  loSetRunning(false);
  loActiveRequestId = null;

  if (resp.ok) {
    const total = resp.result.totalFetched;
    const aborted = resp.result.aborted;
    $loState.textContent = aborted ? `Đã dừng (${total} tin nhắn)` : `✅ Hoàn thành (${total} tin nhắn)`;
    logLine(aborted ? `⏹ Đã dừng. Tải được ${total} tin nhắn.` : `✅ Tải xong ${total} tin nhắn.`, aborted ? 'info' : 'ok');
    saveExtrasToStorage(loadThread);
  } else {
    $loState.textContent = '❌ Lỗi: ' + resp.error;
    logLine('❌ Tải thất bại: ' + resp.error, 'err');
  }
}

async function stopLoad() {
  if (!loRunning) return;
  logLine('⏹ Yêu cầu dừng tải...', 'info');
  await rpc('abortLoadOlder');
}

$loStart.addEventListener('click', startLoad);
$loStop.addEventListener('click', stopLoad);
el('btn-refresh').addEventListener('click', refreshAll);
el('btn-view-refresh').addEventListener('click', refreshAll);
el('btn-header-refresh').addEventListener('click', refreshAll);
el('btn-clear-extra').addEventListener('click', clearExtras);

// ============================================================
// REVOKE single
// ============================================================
async function revokeSingle(m) {
  if (!canRevoke(m)) return;
  if (!confirm(`Thu hồi tin nhắn lúc ${fmtTime(m.timestampMs)}?\n\n"${m.text || '[không giải mã được]'}"`)) return;
  logLine(`Thu hồi: ${m.messageId.slice(-12)}`, 'info');
  const resp = await revokeByItem(m);
  if (resp.ok && resp.result && (resp.result.success !== false)) {
    logLine('✅ Đã thu hồi', 'ok');
    m.isUnsent = true;
    selectedIds.delete(m.messageId);
    renderList();
  } else {
    logLine('❌ Fail: ' + ((resp.result && resp.result.error) || resp.error || 'unknown'), 'err');
  }
}

function revokeByItem(m) {
  if (m.source === 'db') {
    return rpc('revokeOne', { messageId: m.messageId });
  }
  return rpc('revokeExternal', { threadIdAtMsgr: m.threadIdAtMsgr, externalId: m.externalId });
}

// ============================================================
// REVOKE bulk (selected / range)
// ============================================================
function getDelay() {
  const lo = parseInt($dlMin.value) || 0;
  const hi = parseInt($dlMax.value) || 0;
  if (lo >= hi) {
    alert('Delay min phải nhỏ hơn max');
    return null;
  }
  return { lo, hi };
}

async function revokeBulk(items) {
  if (!items.length) return;
  const delay = getDelay();
  if (!delay) return;

  if (items.length >= 20) {
    if (!confirm(`Bạn sắp thu hồi ${items.length} tin nhắn.\nHành động KHÔNG thể hoàn tác.\n\nNghỉ giữa các lần: ${delay.lo}-${delay.hi} mili giây\n\nTiếp tục?`)) return;
  } else if (items.length > 1) {
    if (!confirm(`Thu hồi ${items.length} tin nhắn? (nghỉ ${delay.lo}-${delay.hi} mili giây)`)) return;
  }

  rvRunning = true;
  rvAbort = false;
  $btnRvSel.disabled = true;
  $btnRvRange.disabled = true;
  $btnRvStop.disabled = false;
  $rvProgress.style.display = '';
  $rvBar.style.width = '0%';

  let ok = 0, fail = 0;
  for (let i = 0; i < items.length; i++) {
    if (rvAbort) { logLine('⏹ Đã dừng thu hồi hàng loạt', 'info'); break; }
    const m = items[i];
    const resp = await revokeByItem(m);
    if (resp.ok && resp.result && (resp.result.success !== false)) {
      ok++;
      m.isUnsent = true;
      selectedIds.delete(m.messageId);
      logLine(`[${i+1}/${items.length}] ✅ ${m.messageId.slice(-12)}`, 'ok');
    } else {
      fail++;
      logLine(`[${i+1}/${items.length}] ❌ ${m.messageId.slice(-12)} (${(resp.result && resp.result.error) || resp.error || '?'})`, 'err');
    }
    $rvBar.style.width = Math.round(((i + 1) / items.length) * 100) + '%';
    renderList();

    if (i < items.length - 1 && !rvAbort) {
      const ms = delay.lo + Math.floor(Math.random() * (delay.hi - delay.lo));
      await new Promise((r) => setTimeout(r, ms));
    }
  }

  rvRunning = false;
  $btnRvStop.disabled = true;
  $rvProgress.style.display = 'none';
  logLine(`Thu hồi hàng loạt xong: ✅ ${ok}, ❌ ${fail}`, fail ? 'err' : 'ok');
  saveExtrasToStorage();
  updateSummary([]);
}

$btnRvSel.addEventListener('click', () => {
  const items = [...allMessages.values()]
    .filter((m) => selectedIds.has(m.messageId) && canRevoke(m))
    .sort((a, b) => b.timestampMs - a.timestampMs); // mới → cũ
  revokeBulk(items);
});

$btnRvRange.addEventListener('click', () => {
  if (selectedIds.size < 2) return;
  const selectedItems = [...allMessages.values()].filter((m) => selectedIds.has(m.messageId));
  if (selectedItems.length < 2) return;
  selectedItems.sort((a, b) => a.timestampMs - b.timestampMs);
  const tLo = selectedItems[0].timestampMs;
  const tHi = selectedItems[selectedItems.length - 1].timestampMs;
  const inRange = [...allMessages.values()]
    .filter((m) => m.threadKeyStr === currentThreadKey
      && m.timestampMs >= tLo
      && m.timestampMs <= tHi
      && canRevoke(m))
    .sort((a, b) => b.timestampMs - a.timestampMs);
  revokeBulk(inRange);
});

$btnRvStop.addEventListener('click', () => { rvAbort = true; });

// ============================================================
// FILTER + SORT events
// ============================================================
$fOnlyMine.addEventListener('change', renderList);
$fHideUnsent.addEventListener('change', renderList);
$fHideAdmin.addEventListener('change', renderList);
$fSearch.addEventListener('input', renderList);
$fFrom.addEventListener('change', renderList);
$fTo.addEventListener('change', renderList);

el('check-all').addEventListener('change', (e) => {
  const filtered = applyFilter();
  if (e.target.checked) {
    for (const m of filtered) {
      if (canRevoke(m)) selectedIds.add(m.messageId);
    }
  } else {
    selectedIds.clear();
  }
  renderList();
});

document.addEventListener('click', (e) => {
  if (e.target && e.target.id === 'sort-time') {
    sortDesc = !sortDesc;
    renderList();
  }
});

// ============================================================
// Listen async events
// ============================================================
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.target !== 'panel') return;
  const ev = msg.eventType;
  const p = msg.payload;
  if (ev === 'status') {
    updateStatusUI(p.status);
  } else if (ev === 'loadOlderProgress') {
    if (p.requestId !== loActiveRequestId) return;
    if (p.status === 'running' && p.items) {
      for (const it of p.items) {
        mergeMsg(extraToItem(it, p.threadKey));
      }
      $loBatch.textContent = p.batch;
      $loCount.textContent = p.totalFetched;
      if (p.oldestTs) $loOldest.textContent = new Date(p.oldestTs).toLocaleDateString('vi-VN');
      if (!loNewestTs && p.oldestTs) loNewestTs = p.oldestTs;
      let pct = 0;
      if (loFromDateMs > 0 && loNewestTs > loFromDateMs && p.oldestTs) {
        pct = Math.min(100, Math.max(0, Math.round(((loNewestTs - p.oldestTs) / (loNewestTs - loFromDateMs)) * 100)));
      } else {
        pct = Math.min(100, Math.round((p.batch / 50) * 100));
      }
      $loBar.style.width = pct + '%';
      renderList();
    } else if (p.status === 'error') {
      logLine(`Batch ${p.batch} lỗi: ${p.error}`, 'err');
    }
  }
});

// ============================================================
// EXPORT PDF (HTML → window.print → Save as PDF)
// ============================================================
async function exportPDF() {
  const items = applyFilter();
  if (!items.length) { alert('Không có tin nhắn nào để xuất'); return; }

  // Sort cũ → mới cho PDF
  items.sort((a, b) => a.timestampMs - b.timestampMs);

  logLine(`📄 Đang xuất ${items.length} tin nhắn ra PDF...`, 'info');

  // 1. Lấy contacts (name + avatar) cho mọi sender unique
  const senderIds = [...new Set(items.map((m) => m.senderIdStr).filter(Boolean))];
  const contactsResp = await rpc('getContactsByIds', { userIds: senderIds });
  const contacts = contactsResp.ok ? contactsResp.result : {};

  // 2. Fetch avatar base64 song song (chỉ 1 lần mỗi user)
  const avatarCache = {};
  await Promise.all(senderIds.map(async (id) => {
    const c = contacts[id];
    if (!c || !c.avatarUrl) return;
    const resp = await rpc('fetchAsBase64', { url: c.avatarUrl });
    if (resp.ok && resp.result) {
      avatarCache[id] = `data:${resp.result.mime};base64,${resp.result.base64}`;
    }
  }));

  // 3. Fetch ảnh cho các tin có text === '[ảnh]' (lazy, song song nhưng giới hạn)
  const imageCache = {};
  const imageMsgs = items.filter((m) => m.text === '[ảnh]' && m.threadIdAtMsgr && m.externalId);
  logLine(`Đang tải ${imageMsgs.length} ảnh nhúng vào PDF...`, 'info');

  // Bound concurrency = 4
  const queue = imageMsgs.slice();
  async function worker() {
    while (queue.length) {
      const m = queue.shift();
      try {
        const resp = await rpc('getMediaForMessage', {
          threadIdAtMsgr: m.threadIdAtMsgr, externalId: m.externalId,
        });
        if (resp.ok && resp.result) {
          imageCache[m.messageId] = `data:${resp.result.mime};base64,${resp.result.base64}`;
        }
      } catch (_) {}
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);

  // 4. Build HTML
  const threadName = lastStatus?.threadName || 'Thread';
  const threadKey = currentThreadKey || '?';
  const myName = contacts[myId]?.name || 'Bạn';
  const peerNames = senderIds.filter((id) => id !== myId).map((id) => contacts[id]?.name || id).join(', ');

  const html = buildExportHTML({
    items, contacts, avatarCache, imageCache,
    myId, myName, peerNames, threadName, threadKey,
  });

  // 5. Mở tab mới với HTML → user Ctrl+P
  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank');
  setTimeout(() => URL.revokeObjectURL(url), 60000);

  logLine(`✅ Đã mở tab xuất PDF. Bấm Ctrl+P → "Save as PDF"`, 'ok');
}

function escapeHTML(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function buildExportHTML(opts) {
  const { items, contacts, avatarCache, imageCache, myId, myName, peerNames, threadName, threadKey } = opts;
  const exportTime = new Date().toLocaleString('vi-VN');

  let body = '';
  let lastDate = null;
  for (const m of items) {
    const dateKey = fmtDateKey(m.timestampMs);
    if (dateKey !== lastDate) {
      body += `<div class="date-sep">${escapeHTML(dateKey)}</div>`;
      lastDate = dateKey;
    }

    const isMine = m.isMine;
    const c = contacts[m.senderIdStr];
    const senderName = isMine ? myName : (c?.name || m.senderIdStr?.slice?.(-6) || '?');
    const avatar = avatarCache[m.senderIdStr];
    const time = fmtTime(m.timestampMs);

    let bodyContent = '';
    if (m.isUnsent) {
      bodyContent = `<span class="meta">[đã thu hồi]</span>`;
    } else if (m.isAdmin) {
      bodyContent = `<span class="meta">[tin nhắn hệ thống]</span>`;
    } else if (isCallEvent(m)) {
      bodyContent = `<span class="meta">📞 ${escapeHTML(m.text)}</span>`;
    } else if (m.text === '[ảnh]' && imageCache[m.messageId]) {
      bodyContent = `<img class="msg-img" src="${imageCache[m.messageId]}" />`;
    } else if (m.text === '[ảnh]') {
      bodyContent = `<span class="meta">🖼️ [ảnh — không tải được]</span>`;
    } else if (m.text) {
      bodyContent = escapeHTML(m.text).replace(/\n/g, '<br>');
    } else {
      bodyContent = `<span class="meta">[không giải mã được]</span>`;
    }

    body += `
      <div class="msg ${isMine ? 'mine' : 'other'}">
        ${!isMine && avatar ? `<img class="avt" src="${avatar}" />` : !isMine ? '<div class="avt-ph"></div>' : ''}
        <div class="bubble-wrap">
          ${!isMine ? `<div class="name">${escapeHTML(senderName)}</div>` : ''}
          <div class="bubble">${bodyContent}</div>
          <div class="time">${escapeHTML(time)}</div>
        </div>
      </div>`;
  }

  return `<!DOCTYPE html>
<html lang="vi"><head>
<meta charset="UTF-8">
<title>Messenger Export — ${escapeHTML(threadName)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, 'Segoe UI', Roboto, "Helvetica Neue", Arial, sans-serif;
    background: #fff; color: #050505; padding: 30px 40px; max-width: 800px; margin: 0 auto;
    font-size: 14px; line-height: 1.45;
  }
  h1 { font-size: 20px; margin-bottom: 6px; }
  .header { border-bottom: 2px solid #e4e6eb; padding-bottom: 16px; margin-bottom: 20px; }
  .header .meta-info { color: #65676b; font-size: 12px; line-height: 1.7; }
  .meta-info b { color: #050505; }
  .date-sep {
    text-align: center; color: #65676b; font-size: 11px;
    margin: 20px 0 10px; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.5px;
  }
  .msg {
    display: flex; gap: 8px; margin-bottom: 4px;
    page-break-inside: avoid;
  }
  .msg.mine { justify-content: flex-end; }
  .msg.other { justify-content: flex-start; }
  .avt {
    width: 28px; height: 28px; border-radius: 50%; flex-shrink: 0;
    align-self: flex-end; object-fit: cover;
  }
  .avt-ph { width: 28px; flex-shrink: 0; }
  .bubble-wrap {
    display: flex; flex-direction: column; max-width: 70%;
    gap: 2px;
  }
  .msg.mine .bubble-wrap { align-items: flex-end; }
  .name {
    font-size: 11px; color: #65676b; padding: 0 12px 2px;
  }
  .bubble {
    padding: 8px 12px; border-radius: 18px; font-size: 14px;
    word-wrap: break-word; white-space: pre-wrap;
  }
  .msg.mine .bubble { background: #0084ff; color: #fff; }
  .msg.other .bubble { background: #e4e6eb; color: #050505; }
  .time {
    font-size: 10px; color: #65676b; padding: 0 12px;
  }
  .meta { font-style: italic; color: rgba(255,255,255,0.85); }
  .msg.other .meta { color: #65676b; }
  .msg-img {
    max-width: 280px; max-height: 360px; border-radius: 12px;
    display: block;
  }
  .bubble:has(.msg-img) { background: transparent !important; padding: 0; }
  @media print {
    body { padding: 20px; }
    .msg { break-inside: avoid; }
    .date-sep { break-after: avoid; }
  }
  @page { margin: 1.5cm; }
  .toolbar {
    position: sticky; top: 0; background: #fff;
    padding: 10px 0; margin: -10px 0 20px;
    border-bottom: 1px solid #e4e6eb;
    text-align: center;
  }
  .toolbar button {
    padding: 8px 20px; background: #0084ff; color: #fff;
    border: none; border-radius: 6px; font-size: 14px;
    cursor: pointer; font-weight: 600;
  }
  .toolbar button:hover { background: #0073e0; }
  @media print { .toolbar { display: none; } }
</style></head><body>
<div class="toolbar">
  <button onclick="window.print()">🖨️ In / Lưu PDF (Ctrl+P)</button>
</div>
<div class="header">
  <h1>💬 ${escapeHTML(threadName)}</h1>
  <div class="meta-info">
    <b>Bạn:</b> ${escapeHTML(myName)} (${escapeHTML(myId)})<br>
    <b>Đối phương:</b> ${escapeHTML(peerNames || '—')}<br>
    <b>Thread:</b> ${escapeHTML(threadKey)}<br>
    <b>Tổng số tin nhắn:</b> ${items.length}<br>
    <b>Xuất lúc:</b> ${escapeHTML(exportTime)}
  </div>
</div>
${body}
</body></html>`;
}

el('btn-export-pdf').addEventListener('click', exportPDF);

// ============================================================
// EXPORT JSON
// ============================================================
async function exportJSON() {
  const items = applyFilter();
  if (!items.length) { alert('Không có tin nhắn nào để xuất'); return; }
  items.sort((a, b) => a.timestampMs - b.timestampMs);

  // Lấy contacts để gắn name
  const senderIds = [...new Set(items.map((m) => m.senderIdStr).filter(Boolean))];
  const needFetch = senderIds.filter((id) => !contactCache.has(id));
  if (needFetch.length) {
    const resp = await rpc('getContactsByIds', { userIds: needFetch });
    if (resp.ok) {
      for (const [id, info] of Object.entries(resp.result || {})) {
        contactCache.set(id, info);
      }
    }
  }

  const data = {
    exportedAt: new Date().toISOString(),
    thread: {
      threadKey: currentThreadKey,
      threadName: lastStatus?.threadName || null,
    },
    me: {
      userId: myId,
      name: contactCache.get(myId)?.name || null,
    },
    participants: senderIds.map((id) => ({
      userId: id,
      name: contactCache.get(id)?.name || null,
      firstName: contactCache.get(id)?.firstName || null,
      isMe: id === myId,
    })),
    filter: {
      onlyMine: $fOnlyMine.checked,
      hideUnsent: $fHideUnsent.checked,
      hideAdmin: $fHideAdmin.checked,
      search: $fSearch.value.trim() || null,
      fromDate: $fFrom.value || null,
      toDate: $fTo.value || null,
    },
    count: items.length,
    messages: items.map((m) => ({
      messageId: m.messageId,
      timestampMs: m.timestampMs,
      timeISO: new Date(m.timestampMs).toISOString(),
      senderId: m.senderIdStr,
      senderName: contactCache.get(m.senderIdStr)?.name || null,
      isMine: m.isMine,
      text: m.text,
      isUnsent: m.isUnsent,
      isAdmin: m.isAdmin,
      isCall: isCallEvent(m),
      source: m.source,
      threadIdAtMsgr: m.threadIdAtMsgr,
      externalId: m.externalId,
    })),
  };

  const json = JSON.stringify(data, null, 2);
  const filename = `messages-${currentThreadKey}-${Date.now()}.json`;

  // Use chrome.downloads if available
  if (chrome.downloads && chrome.downloads.download) {
    const dataUrl = 'data:application/json;charset=utf-8;base64,' + btoa(unescape(encodeURIComponent(json)));
    try {
      await new Promise((resolve, reject) => {
        chrome.downloads.download({ url: dataUrl, filename, saveAs: false }, (id) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(id);
        });
      });
      logLine(`✅ Đã xuất ${items.length} tin nhắn → ${filename}`, 'ok');
      return;
    } catch (e) {
      logLine('chrome.downloads fail, fallback: ' + e.message, 'err');
    }
  }

  // Fallback blob URL
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  logLine(`✅ Đã xuất ${items.length} tin nhắn → ${filename}`, 'ok');
}

el('btn-export-json').addEventListener('click', exportJSON);

// ============================================================
// STATS DASHBOARD
// ============================================================
function computeStats() {
  const all = [...allMessages.values()].filter((m) => m.threadKeyStr === currentThreadKey);
  if (!all.length) return null;

  const total = all.length;
  const mine = all.filter((m) => m.isMine);
  const peers = all.filter((m) => !m.isMine && !m.isAdmin);
  const admin = all.filter((m) => m.isAdmin);

  const unsent = all.filter((m) => m.isUnsent);
  const photos = all.filter((m) => m.text === '[ảnh]');
  const videos = all.filter((m) => m.text === '[video]');
  const audio = all.filter((m) => m.text === '[âm thanh]');
  const calls = all.filter((m) => isCallEvent(m));

  // Tổng phút gọi
  let totalCallSec = 0;
  for (const m of calls) {
    const match = (m.text || '').match(/(\d+):(\d+)/);
    if (match) totalCallSec += parseInt(match[1]) * 60 + parseInt(match[2]);
  }

  // Theo giờ trong ngày (0-23)
  const byHour = new Array(24).fill(0);
  for (const m of all) {
    byHour[new Date(m.timestampMs).getHours()]++;
  }

  // Theo tháng (key: YYYY-MM)
  const byMonth = {};
  for (const m of all) {
    const d = new Date(m.timestampMs);
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    byMonth[k] = (byMonth[k] || 0) + 1;
  }

  // Per sender count
  const bySender = {};
  for (const m of all) {
    const id = m.senderIdStr || '?';
    bySender[id] = (bySender[id] || 0) + 1;
  }

  // Khoảng thời gian
  const sorted = all.slice().sort((a, b) => a.timestampMs - b.timestampMs);
  const firstMs = sorted[0].timestampMs;
  const lastMs = sorted[sorted.length - 1].timestampMs;
  const daySpan = Math.max(1, Math.round((lastMs - firstMs) / 86400000));
  const avgPerDay = (total / daySpan).toFixed(1);

  return {
    total, mineCount: mine.length, peersCount: peers.length, adminCount: admin.length,
    unsentCount: unsent.length, photosCount: photos.length, videosCount: videos.length,
    audioCount: audio.length, callsCount: calls.length, totalCallSec,
    byHour, byMonth, bySender,
    firstMs, lastMs, daySpan, avgPerDay,
  };
}

function fmtCallDuration(sec) {
  if (sec < 60) return sec + 's';
  if (sec < 3600) return Math.floor(sec / 60) + 'm ' + (sec % 60) + 's';
  return Math.floor(sec / 3600) + 'h ' + Math.floor((sec % 3600) / 60) + 'm';
}

function renderStats() {
  const s = computeStats();
  const $content = el('stats-content');
  if (!s) { $content.innerHTML = '<p>Không có dữ liệu</p>'; return; }

  const peerName = (id) => contactCache.get(id)?.name || contactCache.get(id)?.firstName || id.slice(-6);
  const peerLabel = (id) => id === myId ? 'Bạn' : peerName(id);

  // By hour bars
  const maxHour = Math.max(...s.byHour, 1);
  const hourBars = s.byHour.map((count, h) => {
    const pct = (count / maxHour) * 100;
    return `<div class="bar-row">
      <span>${String(h).padStart(2, '0')}:00</span>
      <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
      <span>${count}</span>
    </div>`;
  }).join('');

  // By month bars
  const monthKeys = Object.keys(s.byMonth).sort();
  const maxMonth = Math.max(...Object.values(s.byMonth), 1);
  const monthBars = monthKeys.map((k) => {
    const count = s.byMonth[k];
    const pct = (count / maxMonth) * 100;
    return `<div class="bar-row">
      <span>${k}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
      <span>${count}</span>
    </div>`;
  }).join('');

  // By sender bars
  const senderEntries = Object.entries(s.bySender).sort((a, b) => b[1] - a[1]);
  const maxSender = senderEntries[0]?.[1] || 1;
  const senderBars = senderEntries.map(([id, count]) => {
    const pct = (count / maxSender) * 100;
    const cls = id === myId ? '' : 'peer';
    return `<div class="bar-row">
      <span>${peerLabel(id)}</span>
      <div class="bar-track"><div class="bar-fill ${cls}" style="width:${pct}%"></div></div>
      <span>${count} (${((count / s.total) * 100).toFixed(0)}%)</span>
    </div>`;
  }).join('');

  // Tỉ lệ mine vs peer
  const minePct = s.total ? ((s.mineCount / s.total) * 100).toFixed(1) : '0';
  const peersPct = s.total ? ((s.peersCount / s.total) * 100).toFixed(1) : '0';

  $content.innerHTML = `
    <div class="stat-section">
      <h3>Tổng quan</h3>
      <div class="stat-grid">
        <div>Tổng số tin nhắn: <b>${s.total}</b></div>
        <div>Khoảng: <b>${s.daySpan} ngày</b></div>
        <div>Của bạn: <b>${s.mineCount}</b> (${minePct}%)</div>
        <div>Của đối phương: <b>${s.peersCount}</b> (${peersPct}%)</div>
        <div>Hệ thống: <b>${s.adminCount}</b></div>
        <div>Đã thu hồi: <b>${s.unsentCount}</b></div>
        <div>Trung bình/ngày: <b>${s.avgPerDay}</b></div>
        <div>Khoảng: <b>${new Date(s.firstMs).toLocaleDateString('vi-VN')} → ${new Date(s.lastMs).toLocaleDateString('vi-VN')}</b></div>
      </div>
    </div>

    <div class="stat-section">
      <h3>Media</h3>
      <div class="stat-grid">
        <div>📷 Ảnh: <b>${s.photosCount}</b></div>
        <div>🎬 Video: <b>${s.videosCount}</b></div>
        <div>🎵 Âm thanh: <b>${s.audioCount}</b></div>
        <div>📞 Cuộc gọi: <b>${s.callsCount}</b> (${fmtCallDuration(s.totalCallSec)})</div>
      </div>
    </div>

    <div class="stat-section">
      <h3>Theo người gửi</h3>
      ${senderBars}
    </div>

    <div class="stat-section">
      <h3>Theo giờ trong ngày</h3>
      ${hourBars}
    </div>

    <div class="stat-section">
      <h3>Theo tháng</h3>
      ${monthBars}
    </div>
  `;
}

const $statsBg = el('stats-bg');
el('btn-stats').addEventListener('click', () => {
  renderStats();
  $statsBg.classList.add('show');
});
el('stats-close').addEventListener('click', () => $statsBg.classList.remove('show'));
$statsBg.addEventListener('click', (e) => {
  if (e.target === $statsBg) $statsBg.classList.remove('show');
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $statsBg.classList.contains('show')) $statsBg.classList.remove('show');
});

// ============================================================
// Media preview modal
// ============================================================
const $modalBg = el('modal-bg');
const $modalImg = el('modal-img');
const $modalLoading = el('modal-loading');
const $modalInfo = el('modal-info');
const $modalDownload = el('modal-download');
const $modalClose = el('modal-close');
let modalCurrent = null;

async function openMediaPreview(m) {
  if (!m.threadIdAtMsgr || !m.externalId) {
    logLine('Thiếu thông tin tin nhắn để tải media', 'err');
    return;
  }
  modalCurrent = null;
  $modalBg.classList.add('show');
  $modalImg.style.display = 'none';
  $modalImg.src = '';
  $modalLoading.style.display = '';
  $modalLoading.textContent = 'Đang tải ảnh...';
  $modalInfo.textContent = '';
  $modalDownload.disabled = true;

  $modalLoading.textContent = 'Đang tải và giải mã ảnh...';
  const resp = await rpc('getMediaForMessage', {
    threadIdAtMsgr: m.threadIdAtMsgr,
    externalId: m.externalId,
  });
  if (!resp.ok || !resp.result) {
    $modalLoading.innerHTML = '❌ Không tải được ảnh.<br>'
      + '<small>Có thể ảnh đã hết hạn trên CDN, hoặc payload không chứa key.</small>';
    $modalDownload.disabled = true;
    return;
  }
  const { mime, base64, size, source } = resp.result;
  modalCurrent = { mime, base64, size, mid: m.messageId };
  $modalImg.src = `data:${mime};base64,${base64}`;
  $modalImg.style.display = '';
  $modalLoading.style.display = 'none';
  const srcLabel = source === 'cdn-decrypted' ? ' (CDN decrypted)' : source === 'embedded' ? ' (embedded)' : '';
  $modalInfo.textContent = `${mime} · ${(size / 1024).toFixed(1)} KB${srcLabel} · ${fmtFull(m.timestampMs)}`;
  $modalDownload.disabled = false;
}

function closeModal() {
  $modalBg.classList.remove('show');
  $modalImg.src = '';
  modalCurrent = null;
}

$modalClose.addEventListener('click', closeModal);
$modalBg.addEventListener('click', (e) => {
  if (e.target === $modalBg) closeModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $modalBg.classList.contains('show')) closeModal();
});

$modalDownload.addEventListener('click', async () => {
  if (!modalCurrent) return;
  const { mime, base64, mid } = modalCurrent;
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const ext = mime.split('/')[1] || 'bin';
  const filename = `msg-${mid.slice(-12)}.${ext}`;

  // Uu tien chrome.downloads (luu vao Downloads folder that, khong bi xoa)
  if (chrome.downloads && chrome.downloads.download) {
    const dataUrl = `data:${mime};base64,${base64}`;
    try {
      await new Promise((resolve, reject) => {
        chrome.downloads.download({ url: dataUrl, filename, saveAs: false }, (id) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(id);
        });
      });
      logLine('💾 Đã tải: ' + filename, 'ok');
      return;
    } catch (e) {
      logLine('chrome.downloads fail, fallback blob: ' + e.message, 'err');
    }
  }
  // Fallback: blob URL
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 30000);
});

// ============================================================
// CHAT TAB
// ============================================================
const $chatMessages = el('chat-messages');
const $chatInput = el('chat-input');
const $chatSend = el('chat-send');
const $chatPeerName = el('chat-peer-name');
const $chatPeerId = el('chat-peer-id');

let selectedChatThreadKey = null; // thread đang chọn trong tab Chat (độc lập với currentThreadKey)

// ---- Thread dropdown (dùng chung cho cả Xem và Chat) ----
function buildDropdown(dropdownEl, activeKey, onSelect) {
  const threadMap = getThreadList();
  if (!threadMap.size) {
    dropdownEl.innerHTML = '<div class="tab-dropdown-inner"><div class="thread-dropdown-empty">Chưa có dữ liệu — tải tin nhắn trước</div></div>';
    return;
  }
  const inner = document.createElement('div');
  inner.className = 'tab-dropdown-inner';
  inner.innerHTML = '<div class="tab-dropdown-header">Chọn cuộc trò chuyện</div>';
  dropdownEl.innerHTML = '';
  dropdownEl.appendChild(inner);
  for (const { threadKey, peerIds } of threadMap.values()) {
    const label = threadLabel(threadKey, peerIds);
    const initials = label.slice(0, 2).toUpperCase();
    // avatar: ưu tiên ảnh từ contactCache
    const peerId = [...peerIds][0];
    const avatarUrl = peerId ? contactCache.get(peerId)?.avatarUrl : null;
    const avatarHtml = avatarUrl
      ? `<img src="${avatarUrl}" />`
      : initials;

    const item = document.createElement('div');
    item.className = 'thread-item' + (threadKey === activeKey ? ' active' : '');
    item.innerHTML = `
      <div class="ti-avatar">${avatarHtml}</div>
      <div class="ti-info">
        <span class="ti-name">${label}</span>
        <span class="ti-key">${threadKey}</span>
      </div>`;
    item.addEventListener('click', () => onSelect(threadKey, label));
    inner.appendChild(item);
  }
}

let _threadListCache = null;

async function fetchThreadList() {
  const resp = await rpc('getThreadList');
  if (resp.ok && resp.result) {
    _threadListCache = resp.result;
    // Cập nhật contactCache từ danh sách thread
    for (const t of _threadListCache) {
      for (const p of t.peers) {
        if (p.name && !contactCache.has(p.id)) {
          contactCache.set(p.id, { name: p.name, avatarUrl: p.avatarUrl });
        }
      }
    }
  }
  return _threadListCache || [];
}

function buildDropdownFromList(dropdownEl, threadList, activeKey, onSelect) {
  if (!threadList.length) {
    dropdownEl.innerHTML = '<div class="tab-dropdown-inner"><div class="thread-dropdown-empty">Chưa có dữ liệu</div></div>';
    return;
  }
  const inner = document.createElement('div');
  inner.className = 'tab-dropdown-inner';
  inner.innerHTML = '<div class="tab-dropdown-header">Chọn cuộc trò chuyện</div>';
  dropdownEl.innerHTML = '';
  dropdownEl.appendChild(inner);

  for (const t of threadList) {
    const initials = t.name.slice(0, 2).toUpperCase();
    const avatarHtml = t.avatarUrl
      ? `<img src="${t.avatarUrl}" />`
      : initials;
    const item = document.createElement('div');
    item.className = 'thread-item' + (t.threadKey === activeKey ? ' active' : '');
    item.innerHTML = `
      <div class="ti-avatar">${avatarHtml}</div>
      <div class="ti-info">
        <span class="ti-name">${t.name}</span>
        <span class="ti-key">${t.threadKey}</span>
      </div>`;
    item.addEventListener('click', () => onSelect(t.threadKey, t.name));
    inner.appendChild(item);
  }
}

async function buildThreadDropdown() {
  const threadList = await fetchThreadList();

  buildDropdownFromList(el('chat-thread-dropdown'), threadList, selectedChatThreadKey, (threadKey) => {
    selectedChatThreadKey = threadKey;
    switchToTab('chat');
    const d = el('chat-thread-dropdown');
    d.style.display = 'none';
    setTimeout(() => { d.style.display = ''; }, 300);
    loadChatPeer();
  });

  buildDropdownFromList(el('view-thread-dropdown'), threadList, selectedViewThreadKey, (threadKey) => {
    selectedViewThreadKey = threadKey;
    selectedIds.clear();
    switchToTab('view');
    const d = el('view-thread-dropdown');
    d.style.display = 'none';
    setTimeout(() => { d.style.display = ''; }, 300);
    renderList();
  });
}

function switchToTab(tabName) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  el(tabName + '-panel').classList.add('active');
  document.querySelector('[data-tab="' + tabName + '"]').classList.add('active');
}

function chatAddBubble(text, isMine, senderName, ts, state) {
  const wrap = document.createElement('div');
  wrap.className = 'chat-bubble-wrap ' + (isMine ? 'me' : 'other');

  if (!isMine && senderName) {
    const nameEl = document.createElement('div');
    nameEl.className = 'chat-sender';
    nameEl.textContent = senderName;
    wrap.appendChild(nameEl);
  }

  const bubble = document.createElement('div');
  bubble.className = 'chat-bubble' + (state === 'pending' ? ' pending' : state === 'error' ? ' error' : '');
  // Stego: hiện phần visible + icon 🔒 nếu có payload ẩn
  if (window.StegoPanel && window.StegoPanel.hasHidden(text)) {
    const magicIdx = text.indexOf('‌​‌​');
    const visible = magicIdx >= 0 ? text.slice(0, magicIdx) : text;
    bubble.textContent = visible || '·';
    window.StegoPanel.attachLockIcon(bubble, text);
  } else {
    bubble.textContent = text;
  }
  wrap.appendChild(bubble);

  if (ts) {
    const tsEl = document.createElement('div');
    tsEl.className = 'chat-ts';
    tsEl.textContent = fmtTime(ts);
    wrap.appendChild(tsEl);
  }

  $chatMessages.appendChild(wrap);
  $chatMessages.scrollTop = $chatMessages.scrollHeight;
  return bubble;
}

async function loadChatPeer() {
  // Ưu tiên selectedChatThreadKey, fallback về currentThreadKey
  const threadKey = selectedChatThreadKey || currentThreadKey;
  if (!threadKey) return;
  if (!selectedChatThreadKey) selectedChatThreadKey = threadKey;

  try {
    // Tìm peer từ allMessages trước
    let peerIds = [...new Set(
      [...allMessages.values()]
        .filter(m => m.threadKeyStr === threadKey && m.senderIdStr && m.senderIdStr !== myId)
        .map(m => m.senderIdStr)
    )];

    // Nếu không có messages, tìm từ thread list (dropdown data)
    if (!peerIds.length) {
      const threadList = await fetchThreadList();
      const found = threadList.find(t => t.threadKey === threadKey);
      if (found && found.peers) {
        peerIds = found.peers.map(p => p.id).filter(id => id !== myId);
        // Đã có tên từ thread list
        if (found.name) {
          $chatPeerName.textContent = found.name;
          $chatPeerId.textContent = '(' + threadKey + ')';
          $chatSend.disabled = false;
          return;
        }
      }
    }

    if (!peerIds.length) {
      $chatPeerName.textContent = threadKey === currentThreadKey ? (lastStatus?.threadName || threadKey) : threadKey;
      $chatPeerId.textContent = '';
      $chatSend.disabled = false;
      return;
    }

    // Fetch contacts chưa có trong cache
    const needFetch = peerIds.filter(id => !contactCache.has(id));
    if (needFetch.length) {
      const r = await rpc('getContactsByIds', { userIds: needFetch });
      if (r.ok) for (const [id, info] of Object.entries(r.result || {})) contactCache.set(id, info);
    }

    if (peerIds.length === 1) {
      const c = contactCache.get(peerIds[0]);
      const name = c?.name || c?.firstName || (threadKey === currentThreadKey ? lastStatus?.threadName : null) || peerIds[0].slice(-6);
      $chatPeerName.textContent = name;
      $chatPeerId.textContent = '(' + peerIds[0] + ')';
    } else {
      const names = peerIds.map(id => { const c = contactCache.get(id); return c?.firstName || c?.name || id.slice(-4); }).join(', ');
      $chatPeerName.textContent = (threadKey === currentThreadKey ? lastStatus?.threadName : null) || names;
      $chatPeerId.textContent = '(' + peerIds.length + ' người)';
    }
    $chatSend.disabled = false;
    buildThreadDropdown();
  } catch (e) {
    $chatPeerName.textContent = '—';
    $chatSend.disabled = false;
  }
}

async function doSendChat() {
  const text = $chatInput.value.trim();
  const hasHidden = window.StegoPanel && window.StegoPanel.hasHiddenPending();
  if (!text && !hasHidden) return;
  $chatInput.value = '';
  $chatInput.style.height = '';
  $chatSend.disabled = true;

  // Nhúng tin ẩn vào nếu có
  let textToSend = text;
  if (window.StegoPanel) {
    try {
      textToSend = await window.StegoPanel.wrapOutgoing(text);
    } catch (e) {
      $chatSend.disabled = false;
      return;
    }
  }

  // Bubble vẫn hiển thị text gốc (visible) cho UX rõ ràng
  const bubble = chatAddBubble(text || '🔒 (chỉ có tin ẩn)', true, null, Date.now(), 'pending');
  const chatThreadKey = selectedChatThreadKey || currentThreadKey;
  try {
    const resp = await rpc('sendMessage', { text: textToSend, threadKey: chatThreadKey });
    if (resp.ok && resp.result && resp.result.success !== false) {
      bubble.classList.remove('pending');
    } else {
      bubble.classList.remove('pending');
      bubble.classList.add('error');
      bubble.textContent = '❌ Gửi thất bại: ' + (resp.error || 'unknown');
      logLine('Chat send fail: ' + (resp.error || JSON.stringify(resp.result)), 'err');
    }
  } catch (e) {
    bubble.classList.add('error');
    bubble.textContent = '❌ Lỗi: ' + e.message;
  } finally {
    $chatSend.disabled = false;
  }
}

$chatSend.addEventListener('click', doSendChat);
$chatInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSendChat(); }
});
$chatInput.addEventListener('input', () => {
  $chatInput.style.height = 'auto';
  $chatInput.style.height = Math.min($chatInput.scrollHeight, 80) + 'px';
});
el('btn-chat-refresh').addEventListener('click', loadChatPeer);

// ============================================================
// Init
// ============================================================
logLine('Panel loaded', 'info');
refreshAll();
setInterval(async () => {
  const st = await rpc('status');
  if (st.ok) updateStatusUI(st.result);
}, 5000);
