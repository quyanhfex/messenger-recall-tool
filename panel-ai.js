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
const $aiApiKeyEye = el('ai-apikey-eye');
const $aiTemp = el('ai-temp');
const $aiTempVal = el('ai-temp-val');
const $aiMaxTokens = el('ai-max-tokens');
const $aiDelay = el('ai-delay');
const $aiContextSize = el('ai-context-size');
const $aiStatusDot = el('ai-status-dot');
const $aiStatusText = el('ai-status-text');
const $aiActiveList = el('ai-active-list');
const $aiActiveCount = el('ai-active-count');
const $aiLog = el('ai-log');
const $aiToggleLog = el('ai-toggle-log');

// ---- Init models dropdown ----
AI_MODELS.forEach(m => {
  const opt = document.createElement('option');
  opt.value = m.id;
  opt.textContent = m.label;
  $aiModel.appendChild(opt);
});

// ---- Settings toggle ----
$aiToggleSettings.addEventListener('click', () => {
  const isOpen = $aiSettingsPanel.classList.toggle('open');
  $aiToggleSettings.classList.toggle('active', isOpen);
});

// ---- Log toggle ----
$aiToggleLog.addEventListener('click', () => {
  const showingLog = $aiLog.classList.toggle('show');
  $aiToggleLog.classList.toggle('active', showingLog);
  $aiActiveList.style.display = showingLog ? 'none' : '';
});

// ---- Temp slider live ----
$aiTemp.addEventListener('input', () => {
  $aiTempVal.textContent = $aiTemp.value;
});

// ---- API key eye toggle ----
if ($aiApiKeyEye) {
  $aiApiKeyEye.addEventListener('click', () => {
    const showing = $aiApiKey.type === 'text';
    $aiApiKey.type = showing ? 'password' : 'text';
    $aiApiKeyEye.textContent = showing ? '👁' : '🙈';
  });
}

// ---- Toggle ON/OFF ----
$aiToggle.addEventListener('click', () => {
  aiEnabled ? stopAi() : startAi();
});

function updateToggleUI() {
  if (aiEnabled) {
    $aiToggle.firstChild.textContent = '⏸ ';
    $aiToggleLabel.textContent = 'TẮT';
    $aiToggle.className = 'ai-toggle-btn active';
    $aiStatusDot.className = 'ai-dot on';
    $aiStatusText.textContent = 'Đang theo dõi tin mới';
  } else {
    $aiToggle.firstChild.textContent = '▶ ';
    $aiToggleLabel.textContent = 'BẬT';
    $aiToggle.className = 'ai-toggle-btn';
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
  if ($aiActiveCount) $aiActiveCount.textContent = aiThreads.size;

  if (!aiThreads.size) {
    $aiActiveList.innerHTML = `
      <div class="ai-empty">
        <div class="ai-empty-icon">💤</div>
        <div>Chưa có tin nhắn chờ xử lý</div>
      </div>`;
    return;
  }

  let html = '';
  for (const [jid, s] of aiThreads) {
    const pct = s.countdownTotal > 0 ? Math.max(0, (s.countdownLeft / s.countdownTotal) * 100) : 0;
    const statusIcon = s.isReplying ? '🤖' : (s.countdownLeft > 0 ? '⏳' : '✅');
    const statusText = s.isReplying ? 'Đang trả lời…' : (s.countdownLeft > 0 ? s.countdownLeft + 's' : 'Đã trả lời');
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

// ============================================================
// AI v2 — Decision engine, stego signature, tool calling, multi-msg
// ============================================================

// Fetch context tin nhắn từ bridge, normalize text
async function fetchContext(threadKey, count) {
  try {
    const resp = await rpc('getRecentMessages', { threadKey, count });
    if (resp.ok && Array.isArray(resp.result)) {
      return resp.result.filter(m => m.text); // chỉ giữ tin có text
    }
  } catch (_) {}
  return [];
}

// Models không support function calling — fallback prompt-only mode
// Models DeepInfra không route tool_calls dù model gốc hỗ trợ
const MODELS_NO_TOOLS = new Set([]);

// Gọi LLM với optional tools (tự fallback nếu model không support)
async function callLLM({ apiKey, model, temperature, maxTokens, messages, tools }) {
  const body = { model, messages, temperature, max_tokens: maxTokens };
  const useTools = tools && tools.length && !MODELS_NO_TOOLS.has(model);
  if (useTools) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  console.log('[AI callLLM] useTools=', useTools, 'model=', model, 'body keys=', Object.keys(body));
  const resp = await fetch('https://api.deepinfra.com/v1/openai/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey,
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const err = await resp.text();
    // Auto-fallback: nếu lỗi do tools → retry không có tools
    if (useTools && /tool|function/i.test(err)) {
      delete body.tools;
      delete body.tool_choice;
      const retry = await fetch('https://api.deepinfra.com/v1/openai/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + apiKey,
        },
        body: JSON.stringify(body),
      });
      if (!retry.ok) {
        const err2 = await retry.text();
        throw new Error('API ' + retry.status + ' (no-tools retry): ' + err2.slice(0, 200));
      }
      return retry.json();
    }
    throw new Error('API ' + resp.status + ': ' + err.slice(0, 200));
  }
  return resp.json();
}


const AI_SIGNATURE = 'AI'; // Plaintext payload nhúng vào mỗi tin AI gửi
const MAX_CONTEXT_FETCH = 100;
const MAX_TOOL_ROUNDS = 2;

// Tool definition cho OpenAI function calling
const AI_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'fetch_more_messages',
      description: `Lấy thêm tin nhắn cũ hơn từ cuộc trò chuyện. Mặc định bạn có 10 tin gần nhất. Nếu tin nhắn hiện tại đề cập đến nội dung trước đó (vd: "hôm qua tao nói gì", "lúc nãy", "cái mày bảo lúc trước", "vụ kia thế nào"...), bạn PHẢI gọi tool này để lấy đủ ngữ cảnh trước khi trả lời.

CÁCH DÙNG:
- count = tổng số tin muốn có (KHÔNG phải số tin thêm). Vd count=50 nghĩa là load 50 tin gần nhất.
- Tối thiểu 10, tối đa 100. Vượt 100 sẽ bị cap về 100.
- Mỗi tin có timestamp [YYYY-MM-DD HH:MM] → bạn tự nhẩm để biết "hôm qua", "tuần trước"...
- Bạn được gọi tool tối đa 2 lần / 1 lượt reply. Cân nhắc trước khi gọi.

KHI NÀO KHÔNG CẦN GỌI:
- Tin nhắn chỉ là greeting đơn giản ("hi", "alo", "ê").
- Tin nhắn độc lập, không tham chiếu quá khứ.
- 10 tin có sẵn đã đủ trả lời.`,
      parameters: {
        type: 'object',
        properties: {
          count: {
            type: 'integer',
            description: 'Tổng số tin muốn có sau khi load (không phải số tin thêm). Từ 10 đến 100.',
            minimum: 10,
            maximum: 100,
          },
        },
        required: ['count'],
      },
    },
  },
];

// Build system prompt với instruction về decision/multi-msg/signature
// noTools=true → bỏ phần hướng dẫn tool, thay bằng fallback "không nhớ rõ"
function buildSystemPrompt(userPrompt, noTools = false) {
  const today = new Date().toISOString().slice(0, 10);

  const toolSection = noTools
    ? `═══ NGỮ CẢNH ═══

Bạn chỉ có các tin nhắn gần nhất được cung cấp. Nếu người dùng hỏi về nội dung cũ hơn mà bạn không thấy trong lịch sử, hãy trả lời thật thà "tao không nhớ rõ / hôm đó nói gì tao quên mất rồi" thay vì bịa đặt.`
    : `═══ TOOL fetch_more_messages ═══

Mặc định bạn chỉ có 10 tin gần nhất. Nếu tin hiện tại đề cập tới nội dung cũ ("hôm qua", "tuần trước", "cái mày bảo lúc nãy", "vụ X thế nào rồi"...) mà 10 tin không đủ → BẮT BUỘC gọi tool fetch_more_messages.

Quyết định tham khảo:
• Họ hỏi "hôm qua" → fetch 50 tin
• Họ hỏi "tuần trước" → fetch 100 tin
• Họ hỏi "lúc nãy", "ban nãy" → fetch 30 tin
• Tin trống không, độc lập (greeting, bye...) → KHÔNG cần fetch
Tool gọi tối đa 2 lần / lượt — cân nhắc kỹ.`;

  return `${userPrompt}

═══ HƯỚNG DẪN HỆ THỐNG ═══

Bạn đóng vai chủ tài khoản Messenger. Hôm nay là ${today}.

Mỗi tin trong lịch sử được gắn nhãn:
• [BẠN ĐÃ TỰ NHẮN] = chủ tài khoản tự gõ tay (không qua AI)
• [AI ĐÃ NHẮN HỘ] = bạn (AI) đã trả lời thay chủ trước đó
• [HỌ NHẮN] = người đối diện
Mỗi tin có timestamp [YYYY-MM-DD HH:MM] → tự nhẩm để biết khoảng cách thời gian.

${toolSection}

═══ QUY TẮC REPLY ═══

1. Họ chào tạm biệt ("bye", "ngủ ngon", "gặp sau"...) → decision="no_reply"
2. [BẠN ĐÃ TỰ NHẮN] xuất hiện gần đây (chủ đang tự chat tay) → decision="no_reply"
3. Tin spam/repeat (họ nhắn cùng câu nhiều lần) → decision="no_reply"
4. Tin có ngữ cảnh rõ ràng → reply 1-3 tin tự nhiên

═══ FORMAT OUTPUT (BẮT BUỘC) ═══

Chỉ JSON thuần, KHÔNG markdown, KHÔNG \`\`\`json:

{
  "decision": "reply" | "no_reply",
  "reason": "lý do ngắn gọn (1 câu)",
  "messages": ["tin 1", "tin 2", "tin 3"]
}

• no_reply → messages = []
• reply → messages có 1 đến 3 phần tử (mỗi phần tử gửi tách thành 1 bubble, cách nhau 1-3 giây)
• Mỗi tin ngắn gọn, văn nói tự nhiên, không formal`;
}

// Format 1 message thành line context cho LLM
function formatContextLine(m, myId) {
  const ts = m.timestampMs ? new Date(m.timestampMs).toISOString().slice(0, 16).replace('T', ' ') : '?';
  let label;
  if (m.isMine) {
    // Check stego signature để biết AI tự gửi hay chủ nhân tự nhắn
    if (window.Stego && Stego.hasHidden(m.text || '')) {
      label = '[AI ĐÃ NHẮN HỘ]';
    } else {
      label = '[BẠN ĐÃ TỰ NHẮN]';
    }
  } else {
    label = '[HỌ NHẮN]';
  }
  // Strip stego chars khỏi text khi feed cho AI để không lẫn
  let text = m.text || '';
  if (window.Stego) {
    const magicIdx = text.indexOf('‌​‌​');
    if (magicIdx >= 0) text = text.slice(0, magicIdx);
  }
  return `[${ts}] ${label} ${text}`;
}

// Build messages array cho OpenAI API từ context tin nhắn
function buildLLMMessages(context, systemPrompt, latestMsgText, noTools = false) {
  const messages = [{ role: 'system', content: buildSystemPrompt(systemPrompt, noTools) }];
  const historyLines = context.map(m => formatContextLine(m));
  // Đảm bảo tin trigger luôn xuất hiện ở cuối — tránh trường hợp DB chưa cập nhật
  const lastLine = historyLines[historyLines.length - 1] || '';
  if (latestMsgText && !lastLine.includes(latestMsgText.slice(0, 20))) {
    const now = new Date().toISOString().slice(0, 16).replace('T', ' ');
    historyLines.push(`[${now}] [HỌ NHẮN] ${latestMsgText}`);
  }
  const historyText = historyLines.join('\n');
  messages.push({
    role: 'user',
    content: `Đây là lịch sử trò chuyện (mới nhất ở cuối):\n\n${historyText}\n\nHãy quyết định có nên trả lời không. Trả về JSON.`,
  });
  return messages;
}

// Parse JSON response từ LLM (tolerant với markdown wrapper)
function parseAiDecision(raw) {
  if (!raw) return null;
  let s = raw.replace(/^<think>[\s\S]*?<\/think>\s*/i, '').trim();
  // Strip markdown code fence nếu có
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  // Tìm JSON object đầu tiên
  const startIdx = s.indexOf('{');
  const endIdx = s.lastIndexOf('}');
  if (startIdx < 0 || endIdx < 0) return null;
  try {
    return JSON.parse(s.slice(startIdx, endIdx + 1));
  } catch (e) {
    return null;
  }
}

// ---- AI Auto Reply for a specific thread ----
async function aiAutoReply(chatJid, state) {
  if (!state) return;
  $aiStatusDot.className = 'ai-dot thinking';
  $aiStatusText.textContent = '🤖 Suy nghĩ cho ' + state.name + '...';

  try {
    const systemPrompt = $aiSystemPrompt.value.trim();
    const apiKey = $aiApiKey.value.trim();
    const model = $aiModel.value;
    const temperature = parseFloat($aiTemp.value);
    const maxTokens = parseInt($aiMaxTokens.value) || 512;
    let ctxSize = parseInt($aiContextSize.value) || 10;

    if (!state.threadKey) throw new Error('Không biết threadKey');

    const noTools = MODELS_NO_TOOLS.has(model);
    aiAddLog(`🚀 <b>${state.name}:</b> bắt đầu pipeline (model=<code>${model}</code>, ctx=${ctxSize}, temp=${temperature}${noTools ? ', no-tools mode' : ''})`, { cls: 'event' });

    // Lấy context ban đầu
    let context = await fetchContext(state.threadKey, ctxSize);
    aiAddLog(`📥 <b>${state.name}:</b> load ${context.length}/${ctxSize} tin gốc`, {
      cls: 'debug',
      details: context.map(m => formatContextLine(m)).join('\n'),
    });

    // Build messages + call LLM (có thể có nhiều round nếu LLM gọi tool)
    let messages = buildLLMMessages(context, systemPrompt, state.lastMsgFull, noTools);
    aiAddLog(`📤 <b>${state.name}:</b> messages gửi LLM (${messages.length} msg)`, {
      cls: 'debug',
      details: messages,
    });

    let decision = null;
    let toolRounds = 0;
    let totalLatency = 0;
    while (true) {
      // Round cuối (hết quota tool) → bỏ tools để force LLM trả content
      const allowTools = toolRounds < MAX_TOOL_ROUNDS;
      const roundLabel = `Round ${toolRounds + 1}${allowTools ? '' : ' (no-tools, forced answer)'}`;
      aiAddLog(`🔄 <b>${state.name}:</b> ${roundLabel} — gọi LLM...`, { cls: 'event' });

      const t0 = Date.now();
      const llmResp = await callLLM({
        apiKey, model, temperature, maxTokens,
        messages,
        tools: allowTools ? AI_TOOLS : null,
      });
      const latency = Date.now() - t0;
      totalLatency += latency;

      const choice = llmResp.choices?.[0];
      if (!choice) throw new Error('LLM trả về rỗng');

      const usage = llmResp.usage || {};
      aiAddLog(
        `📨 <b>${state.name}:</b> ${roundLabel} response (${latency}ms, ` +
        `prompt=${usage.prompt_tokens || '?'} tok, completion=${usage.completion_tokens || '?'} tok)`,
        { cls: 'debug', details: choice.message }
      );

      // Trường hợp 1: LLM gọi tool fetch_more_messages
      const toolCalls = choice.message?.tool_calls || [];
      if (toolCalls.length > 0 && allowTools) {
        // Append assistant message với tool_calls — chỉ giữ fields OpenAI chuẩn
        messages.push({
          role: 'assistant',
          content: choice.message.content || null,
          tool_calls: choice.message.tool_calls,
        });
        // Xử lý từng tool call
        for (const tc of toolCalls) {
          if (tc.function?.name === 'fetch_more_messages') {
            let args = {};
            try { args = JSON.parse(tc.function.arguments || '{}'); } catch (_) {}
            // Tôn trọng count của AI, chỉ cap min 10 / max 100
            const requestedCount = Math.min(MAX_CONTEXT_FETCH, Math.max(10, args.count || 20));
            ctxSize = requestedCount;
            aiAddLog(
              `🔧 <b>${state.name}:</b> tool call <code>fetch_more_messages</code>(count=${requestedCount})`,
              { cls: 'tool', details: { tool_call_id: tc.id, raw_args: tc.function.arguments, parsed: args } }
            );
            context = await fetchContext(state.threadKey, requestedCount);
            const historyText = context.map(m => formatContextLine(m)).join('\n');
            // Báo cho LLM biết còn bao nhiêu lần gọi tool còn lại
            const remaining = MAX_TOOL_ROUNDS - toolRounds - 1;
            const remainHint = remaining > 0
              ? `Bạn còn ${remaining} lần gọi tool. Nếu đã đủ context, hãy trả JSON ngay.`
              : `ĐÂY LÀ LẦN GỌI TOOL CUỐI. Lần tiếp theo bạn BẮT BUỘC trả JSON decision (không gọi tool nữa).`;
            const toolContent = `Đã load ${context.length} tin nhắn gần nhất (bạn yêu cầu ${requestedCount}):\n\n${historyText}\n\n${remainHint}`;
            messages.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: toolContent,
            });
            $aiStatusText.textContent = `📚 Đọc ${context.length} tin cho ${state.name}...`;
            aiAddLog(
              `📚 <b>${state.name}:</b> tool result — ${context.length} tin (còn ${remaining} lần gọi)`,
              { cls: 'tool', details: historyText }
            );
          } else {
            aiAddLog(
              `⚠️ <b>${state.name}:</b> tool lạ: <code>${tc.function?.name}</code> — bỏ qua`,
              { cls: 'err', details: tc }
            );
          }
        }
        toolRounds++;
        continue; // Gọi LLM lại với context mở rộng
      }

      // Trường hợp 2: LLM trả về answer cuối
      const raw = choice.message?.content || '';
      aiAddLog(`📝 <b>${state.name}:</b> LLM trả content (raw)`, { cls: 'debug', details: raw });

      decision = parseAiDecision(raw);
      if (!decision) {
        aiAddLog(`❌ <b>${state.name}:</b> parse JSON FAIL`, { cls: 'err', details: raw });
        throw new Error('Không parse được JSON từ LLM: ' + raw.slice(0, 200));
      }
      aiAddLog(
        `✅ <b>${state.name}:</b> parsed decision = <b>${decision.decision}</b>, ` +
        `${(decision.messages || []).length} tin (tổng ${totalLatency}ms, ${toolRounds} tool round)`,
        { cls: 'ok', details: decision }
      );
      break;
    }

    if (!decision) throw new Error('Không nhận được decision');

    // Xử lý decision
    if (decision.decision === 'no_reply') {
      aiAddLog(
        `⏭️ <b>${state.name}:</b> AI quyết định KHÔNG reply — <i>${decision.reason || '(không lý do)'}</i>`,
        { cls: 'event', details: decision }
      );
      logLine(`AI no-reply ${state.name}: ${decision.reason}`, 'info');
      return;
    }

    if (decision.decision !== 'reply' || !Array.isArray(decision.messages) || decision.messages.length === 0) {
      throw new Error('Decision không hợp lệ: ' + JSON.stringify(decision));
    }

    // Gửi từng tin với delay 1-3s
    const msgs = decision.messages.slice(0, 3); // cap 3 tin
    aiAddLog(`📨 <b>${state.name}:</b> bắt đầu gửi ${msgs.length} tin`, { cls: 'event' });
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i].trim();
      if (!m) continue;
      // Nhúng stego signature "AI" vào mỗi tin
      const wrapped = await Stego.encode(m, AI_SIGNATURE, null);
      const sendResp = await rpc('sendMessage', {
        text: wrapped, threadKey: state.threadKey, chatJid: state.chatJid,
      });
      if (!(sendResp.ok && sendResp.result?.success !== false)) {
        aiAddLog(
          `❌ <b>${state.name}:</b> send tin ${i + 1} FAIL`,
          { cls: 'err', details: sendResp }
        );
        throw new Error('Gửi tin ' + (i + 1) + ' thất bại: ' + (sendResp.error || 'unknown'));
      }
      const preview = m.slice(0, 60) + (m.length > 60 ? '...' : '');
      aiAddLog(
        `🤖 → <b>${state.name}</b> [${i + 1}/${msgs.length}]: "${preview}"`,
        { cls: 'ok', details: { full_text: m, stego_signature: AI_SIGNATURE, wrapped_length: wrapped.length } }
      );
      logLine(`AI ${i + 1}/${msgs.length} → ${state.name}: "${preview}"`, 'ok');
      // Delay random 1-3s giữa các tin (trừ tin cuối)
      if (i < msgs.length - 1) {
        const delay = Math.round(1000 + Math.random() * 2000);
        $aiStatusText.textContent = `💭 Đang gõ... (${i + 1}/${msgs.length})`;
        aiAddLog(`⏳ <b>${state.name}:</b> chờ ${delay}ms trước tin tiếp theo`, { cls: 'debug' });
        await new Promise(r => setTimeout(r, delay));
      }
    }
    aiAddLog(`🏁 <b>${state.name}:</b> hoàn tất pipeline`, { cls: 'event' });
  } catch (e) {
    aiAddLog(`❌ <b>${state.name}:</b> ${e.message}`, { cls: 'err', details: e.stack || String(e) });
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
function aiAddLog(html, opts) {
  const ts = new Date().toTimeString().slice(0, 8);
  const div = document.createElement('div');
  div.className = 'ai-log-line';
  if (opts && opts.cls) div.className += ' ' + opts.cls;

  let body = `<span class="ai-log-ts">[${ts}]</span> ${html}`;

  // Nếu có details (JSON / payload dài) → render collapse
  if (opts && opts.details != null) {
    let detailsStr;
    if (typeof opts.details === 'string') {
      detailsStr = opts.details;
    } else {
      try { detailsStr = JSON.stringify(opts.details, null, 2); }
      catch (_) { detailsStr = String(opts.details); }
    }
    // Escape HTML
    detailsStr = detailsStr
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    body += ` <span class="ai-log-collapse" data-state="collapsed">[xem chi tiết ▼]</span>` +
            `<div class="ai-log-details collapsed">${detailsStr}</div>`;
  }

  div.innerHTML = body;
  $aiLog.appendChild(div);
  $aiLog.scrollTop = $aiLog.scrollHeight;
  if ($aiLog.children.length > 500) $aiLog.removeChild($aiLog.firstChild);

  // Wire collapse toggle
  const toggle = div.querySelector('.ai-log-collapse');
  const details = div.querySelector('.ai-log-details');
  if (toggle && details) {
    toggle.addEventListener('click', () => {
      const collapsed = details.classList.toggle('collapsed');
      toggle.textContent = collapsed ? '[xem chi tiết ▼]' : '[thu gọn ▲]';
      if (!collapsed) {
        // Khi mở, đảm bảo log scroll xuống để thấy
        $aiLog.scrollTop = div.offsetTop + div.offsetHeight - $aiLog.clientHeight;
      }
    });
  }
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
