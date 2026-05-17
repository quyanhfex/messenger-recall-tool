// ============================================================
// AI AUTO-REPLY — Theo dõi NHIỀU thread song song
// NewMsg từ bất kỳ thread → countdown riêng → AI reply
// ============================================================

const AI_MODELS = [
  { id: 'google/gemma-4-26B-A4B-it', label: 'Gemma 4 26B (nhanh)' },
  { id: 'meta-llama/Llama-4-Maverick-17B-128E-Instruct', label: 'Llama 4 Maverick 17B' },
  { id: 'meta-llama/Meta-Llama-3.1-70B-Instruct', label: 'Llama 3.1 70B' },
  { id: 'meta-llama/Meta-Llama-3.1-8B-Instruct', label: 'Llama 3.1 8B (siêu nhanh)' },
  { id: 'Qwen/Qwen3-235B-A22B', label: 'Qwen 3 235B' },
  { id: 'mistralai/Mistral-Small-24B-Instruct-2501', label: 'Mistral Small 24B' },
  { id: 'deepseek-ai/DeepSeek-V3', label: 'DeepSeek V3' },
];

// ---- State ----
let aiEnabled = false;
// Map<chatJid, { threadKey, name, lastMsg, countdownLeft, timer, pendingMsg, isReplying }>
const aiThreads = new Map();
// Map chatJid → threadKey (built from thread list)
let aiJidToThread = new Map();
let aiThreadToName = new Map();

// ---- DOM refs ----
const $aiToggle = el('ai-toggle');
const $aiToggleLabel = el('ai-toggle-label');
const $aiSettingsPanel = el('ai-settings');
const $aiToggleSettings = el('ai-toggle-settings');
const $aiSystemPrompt = el('ai-system-prompt');
const $aiModel = el('ai-model');
const $aiApiKey = el('ai-api-key');
const $aiTemp = el('ai-temp');
const $aiTempVal = el('ai-temp-val');
const $aiMaxTokens = el('ai-max-tokens');
const $aiDelay = el('ai-delay');
const $aiContextSize = el('ai-context-size');
const $aiStatusDot = el('ai-status-dot');
const $aiStatusText = el('ai-status-text');
const $aiActiveList = el('ai-active-list');
const $aiLog = el('ai-log');

// ---- Init models dropdown ----
AI_MODELS.forEach(m => {
  const opt = document.createElement('option');
  opt.value = m.id;
  opt.textContent = m.label;
  $aiModel.appendChild(opt);
});

// ---- Settings toggle ----
$aiToggleSettings.addEventListener('click', () => {
  $aiSettingsPanel.classList.toggle('open');
  $aiToggleSettings.textContent = $aiSettingsPanel.classList.contains('open') ? '⚙ Ẩn cài đặt' : '⚙ Cài đặt';
});
$aiTemp.addEventListener('input', () => { $aiTempVal.textContent = $aiTemp.value; });

// ---- Toggle ON/OFF ----
$aiToggle.addEventListener('click', () => {
  aiEnabled ? stopAi() : startAi();
});

function updateToggleUI() {
  if (aiEnabled) {
    $aiToggle.textContent = '⏸ TẮT';
    $aiToggle.className = 'ai-toggle-btn active';
    $aiToggleLabel.textContent = 'Đang hoạt động';
    $aiStatusDot.className = 'ai-dot on';
    $aiStatusText.textContent = 'Theo dõi tất cả thread — chờ tin mới...';
  } else {
    $aiToggle.textContent = '▶ BẬT';
    $aiToggle.className = 'ai-toggle-btn';
    $aiToggleLabel.textContent = 'Đã tắt';
    $aiStatusDot.className = 'ai-dot off';
    $aiStatusText.textContent = 'Không hoạt động';
  }
}

// ---- Build jid↔thread mapping ----
// chatJid (NewMsg event) → { threadKey, name }
// 1-on-1: chatJid = peerId@msgr
// Group:  chatJid = groupThreadId (lấy từ DB messages)
async function buildThreadMapping() {
  const list = await fetchThreadList();
  aiJidToThread.clear();
  aiThreadToName.clear();

  // 1-on-1 chats: chatJid = peerId@msgr
  for (const t of list) {
    if (t.peers && t.peers.length === 1) {
      const p = t.peers[0];
      if (p.id !== myId) {
        const jid = p.id + '@msgr';
        aiJidToThread.set(jid, t.threadKey);
        aiThreadToName.set(jid, t.name || p.name || p.id);
      }
    }
  }

  // Group chats: tìm chatJid (threadIdAtMsgr) từ DB messages
  const groupThreads = list.filter(t => t.peers && t.peers.length > 1);
  if (groupThreads.length) {
    try {
      const resp = await rpc('getAllMessages');
      if (resp.ok && resp.result) {
        // Map threadKey → chatJid (lấy từ messageId prefix)
        const threadKeyToJid = new Map();
        for (const m of resp.result) {
          if (!threadKeyToJid.has(m.threadKeyStr) && m.messageId) {
            const jid = m.messageId.split('.')[0];
            if (jid) threadKeyToJid.set(m.threadKeyStr, jid);
          }
        }
        for (const t of groupThreads) {
          const jid = threadKeyToJid.get(t.threadKey);
          if (jid) {
            aiJidToThread.set(jid, t.threadKey);
            aiThreadToName.set(jid, t.name);
          }
        }
      }
    } catch (_) {}
  }
}

// ---- Start/Stop ----
async function startAi() {
  if (!myId) {
    // Chờ status load xong
    const st = await rpc('status');
    if (st.ok && st.result) myId = st.result.myId;
  }
  if (!myId) {
    alert('Chưa lấy được user ID. Thử tải lại trang Messenger.');
    return;
  }
  aiEnabled = true;
  await buildThreadMapping();
  updateToggleUI();
  aiAddLog('🟢 BẬT auto-reply — theo dõi <b>' + aiJidToThread.size + ' thread</b>');
}

function stopAi() {
  aiEnabled = false;
  // Clear tất cả countdowns
  for (const [jid, state] of aiThreads) {
    if (state.timer) clearInterval(state.timer);
  }
  aiThreads.clear();
  renderActiveList();
  updateToggleUI();
  aiAddLog('🔴 Đã TẮT auto-reply');
}

// ---- Listen NewMsg events ----
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.target !== 'panel' || msg.eventType !== 'newMsg') return;
  if (!aiEnabled) return;

  const p = msg.payload;
  const chatJid = p.chatJid || '';
  if (!chatJid) return;

  const threadKey = aiJidToThread.get(chatJid);
  const threadName = aiThreadToName.get(chatJid) || chatJid.split('@')[0].slice(-6);

  if (p.isMine) {
    // Chủ nhân gửi tin → cancel countdown cho thread này
    const state = aiThreads.get(chatJid);
    if (state && state.timer) {
      clearInterval(state.timer);
      aiThreads.delete(chatJid);
      renderActiveList();
      aiAddLog(`✅ <b>${threadName}</b> — bạn đã trả lời, huỷ auto-reply`);
    }
    return;
  }

  // Tin từ người khác
  const senderName = getSenderName(p.sender) || threadName;
  const preview = (p.text || '[media]').slice(0, 50);
  const delay = parseInt($aiDelay.value) || 30;

  // Nếu thread đang countdown, reset timer
  const existing = aiThreads.get(chatJid);
  if (existing && existing.timer) {
    clearInterval(existing.timer);
  }

  const state = {
    chatJid,
    threadKey: threadKey || null,
    name: threadName,
    senderName,
    lastMsg: preview,
    lastMsgFull: p.text || '',
    countdownLeft: delay,
    countdownTotal: delay,
    timer: null,
    isReplying: false,
    startedAt: Date.now(),
  };

  // Start countdown
  state.timer = setInterval(() => {
    state.countdownLeft--;
    renderActiveList();
    if (state.countdownLeft <= 0) {
      clearInterval(state.timer);
      state.timer = null;
      state.isReplying = true;
      renderActiveList();
      aiAutoReply(chatJid, state);
    }
  }, 1000);

  aiThreads.set(chatJid, state);
  renderActiveList();
  aiAddLog(`📩 <b>${senderName}:</b> "${preview}" — ${delay}s`);
});

function getSenderName(senderId) {
  if (!senderId) return '?';
  const c = contactCache.get(senderId);
  return c?.name || c?.firstName || senderId.slice(-6);
}

// ---- Render active countdowns UI ----
function renderActiveList() {
  if (!aiThreads.size) {
    $aiActiveList.innerHTML = '<div style="color:#6e7681;font-size:11px;padding:8px 12px;">Chưa có tin nhắn chờ xử lý</div>';
    return;
  }

  let html = '';
  for (const [jid, s] of aiThreads) {
    const pct = s.countdownTotal > 0 ? Math.max(0, (s.countdownLeft / s.countdownTotal) * 100) : 0;
    const statusIcon = s.isReplying ? '🤖' : (s.countdownLeft > 0 ? '⏳' : '✅');
    const statusText = s.isReplying ? 'Đang trả lời...' : (s.countdownLeft > 0 ? s.countdownLeft + 's' : 'Đã trả lời');
    const barColor = s.countdownLeft > 10 ? '#8b5cf6' : (s.countdownLeft > 5 ? '#d29922' : '#f85149');

    html += `
      <div class="ai-thread-card">
        <div class="ai-tc-header">
          <span class="ai-tc-name">${statusIcon} ${s.name}</span>
          <span class="ai-tc-countdown" style="color:${barColor}">${statusText}</span>
        </div>
        <div class="ai-tc-msg">${s.senderName}: ${s.lastMsg}</div>
        <div class="ai-tc-bar-track"><div class="ai-tc-bar" style="width:${pct}%;background:${barColor}"></div></div>
      </div>`;
  }
  $aiActiveList.innerHTML = html;
}

// ---- AI Auto Reply for a specific thread ----
async function aiAutoReply(chatJid, state) {
  if (!state) return;
  $aiStatusDot.className = 'ai-dot thinking';
  $aiStatusText.textContent = '🤖 Trả lời ' + state.name + '...';

  try {
    const systemPrompt = $aiSystemPrompt.value.trim();
    const apiKey = $aiApiKey.value.trim();
    const model = $aiModel.value;
    const temperature = parseFloat($aiTemp.value);
    const maxTokens = parseInt($aiMaxTokens.value) || 512;
    const ctxSize = parseInt($aiContextSize.value) || 10;

    // Lấy context qua bridge (plaintext!)
    let context = [];
    if (state.threadKey) {
      try {
        const resp = await rpc('getRecentMessages', { threadKey: state.threadKey, count: ctxSize });
        if (resp.ok && Array.isArray(resp.result)) {
          context = resp.result;
        }
      } catch (_) {}
    }

    // Build messages: đảo role (AI đóng vai tôi)
    const messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });

    for (const m of context) {
      if (!m.text) continue;
      messages.push({
        role: m.isMine ? 'assistant' : 'user',
        content: m.text,
      });
    }

    if (!messages.some(m => m.role === 'user')) {
      messages.push({ role: 'user', content: state.lastMsgFull || 'Hi' });
    }

    // Call API
    const resp = await fetch('https://api.deepinfra.com/v1/openai/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
      },
      body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error('API ' + resp.status + ': ' + err.slice(0, 200));
    }

    const data = await resp.json();
    let aiReply = data.choices?.[0]?.message?.content || '';
    aiReply = aiReply.replace(/^<think>[\s\S]*?<\/think>\s*/i, '').trim();
    if (!aiReply) throw new Error('AI trả về rỗng');

    // Gửi Messenger
    const threadKey = state.threadKey;
    if (!threadKey) throw new Error('Không biết threadKey');

    const sendResp = await rpc('sendMessage', { text: aiReply, threadKey, chatJid: state.chatJid });
    if (sendResp.ok && sendResp.result?.success !== false) {
      aiAddLog(`🤖 → <b>${state.name}:</b> "${aiReply.slice(0, 80)}${aiReply.length > 80 ? '...' : ''}"`);
      logLine(`AI → ${state.name}: "${aiReply.slice(0, 60)}"`, 'ok');
    } else {
      throw new Error('Gửi thất bại: ' + (sendResp.error || 'unknown'));
    }
  } catch (e) {
    aiAddLog(`❌ <b>${state.name}:</b> ${e.message}`);
    logLine('AI error: ' + e.message, 'err');
  } finally {
    aiThreads.delete(chatJid);
    renderActiveList();
    if (aiEnabled) {
      $aiStatusDot.className = 'ai-dot on';
      $aiStatusText.textContent = 'Theo dõi tất cả thread — chờ tin mới...';
    }
  }
}

// ---- Log ----
function aiAddLog(html) {
  const ts = new Date().toTimeString().slice(0, 8);
  const div = document.createElement('div');
  div.className = 'ai-log-line';
  div.innerHTML = `<span class="ai-log-ts">[${ts}]</span> ${html}`;
  $aiLog.appendChild(div);
  $aiLog.scrollTop = $aiLog.scrollHeight;
  if ($aiLog.children.length > 200) $aiLog.removeChild($aiLog.firstChild);
}

// ---- Save/load settings ----
async function aiSaveSettings() {
  try {
    await chrome.storage.local.set({
      'ai-settings': {
        systemPrompt: $aiSystemPrompt.value,
        model: $aiModel.value,
        apiKey: $aiApiKey.value,
        temperature: $aiTemp.value,
        maxTokens: $aiMaxTokens.value,
        delay: $aiDelay.value,
        contextSize: $aiContextSize.value,
      }
    });
  } catch (_) {}
}

async function aiLoadSettings() {
  try {
    const data = await chrome.storage.local.get('ai-settings');
    const s = data['ai-settings'];
    if (!s) return;
    if (s.systemPrompt != null) $aiSystemPrompt.value = s.systemPrompt;
    if (s.model) $aiModel.value = s.model;
    if (s.apiKey) $aiApiKey.value = s.apiKey;
    if (s.temperature != null) { $aiTemp.value = s.temperature; $aiTempVal.textContent = s.temperature; }
    if (s.maxTokens) $aiMaxTokens.value = s.maxTokens;
    if (s.delay) $aiDelay.value = s.delay;
    if (s.contextSize) $aiContextSize.value = s.contextSize;
  } catch (_) {}
}

[$aiSystemPrompt, $aiModel, $aiApiKey, $aiTemp, $aiMaxTokens, $aiDelay, $aiContextSize].forEach(el => {
  el.addEventListener('change', aiSaveSettings);
});

aiLoadSettings();
updateToggleUI();
renderActiveList();
