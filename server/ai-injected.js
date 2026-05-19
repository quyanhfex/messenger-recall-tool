// ============================================================
// AI Page Runtime — chỉ listen newMsg + forward sang Node + send reply
// LLM call chạy ở Node để vượt CSP của Facebook
// ============================================================

(function () {
  if (window.__AI_STARTED__) return;
  window.__AI_STARTED__ = true;

  const log = (...a) => console.log('[AI]', ...a);

  const cfg = window.__AI_CONFIG__ = Object.assign({
    enabled: false,
    delaySec: 1,
  }, window.__AI_CONFIG__ || {});

  window.__updateAIConfig = function (patch) {
    Object.assign(cfg, patch || {});
    log('Config updated:', Object.keys(patch || {}));
  };

  const threads = new Map(); // chatJid → { timer, lastMsg, name, ... }

  function bridge() {
    return window.require && window.require('MAWBridgeSendAndReceive');
  }

  async function sendMessage(threadIdAtMsgr, text) {
    const b = bridge();
    if (!b) throw new Error('bridge_not_ready');
    const ts = Date.now();
    const msgId = String(ts) + String(Math.floor(Math.random() * 100000));
    const payload = {
      args: {
        content: text,
        initiatingSource: 'KEYBOARD_SHORTCUT',
        optimisticMsg: { msgId, ts },
        source: 'inbox',
        mentionedJids: [],
        commands: [],
      },
      chatJid: threadIdAtMsgr,
      externalId: msgId,
      qplEventType: { i: 25313175, r: 32 },
      qplInstanceKey: ts + Math.floor(Math.random() * 10000) + 10000,
    };
    return await b.sendAndReceive('backend', 'sendMsg', payload);
  }

  async function loadMessages(threadId, count) {
    const b = bridge();
    if (!b) throw new Error('bridge_not_ready');
    const resp = await b.sendAndReceive('mps', 'mpsLoadMessages', {
      debug: { purpose: 'ai_context' },
      direction: 'desc',
      from: [Date.now() + 86400000, '0'],
      numMessages: count,
      threadId,
    });
    return (resp?.value?.messages || []).map((m) => ({
      text: window.__MR__?.extractTextFromPayload?.(m.toplevelProtobuf.payload) || '',
      ts: Number(m.toplevelProtobuf.timestampMs),
      senderId: m.toplevelProtobuf.senderId,
    }));
  }

  // Expose cho Node gọi vào để load messages
  window.__aiLoadMessages = loadMessages;
  window.__aiSendMessage = sendMessage;

  async function aiReply(chatJid, state) {
    try {
      log(`Asking Node LLM for ${state.name}: "${state.lastMsg.slice(0, 60)}"`);

      // Gọi binding Node — Node sẽ build context + call LLM + trả reply text
      // exposeBinding tên 'nodeAIReply' được setup ở Node side
      const reply = await window.nodeAIReply({
        chatJid,
        threadId: state.threadId,
        lastMsg: state.lastMsg,
        senderId: state.senderId,
      });

      if (!reply || !reply.text) {
        log('Node returned empty reply, skip');
        return;
      }

      await sendMessage(state.threadId, reply.text);
      log(`✅ Sent to ${state.name}: "${reply.text.slice(0, 80)}"`);
    } catch (e) {
      log(`❌ AI reply error for ${state.name}:`, e.message);
    } finally {
      threads.delete(chatJid);
    }
  }

  function handleNewMsg(p) {
    if (!cfg.enabled) return;
    const chatJid = p.chatJid;
    if (!chatJid) return;
    if (p.isMine) {
      const s = threads.get(chatJid);
      if (s?.timer) clearInterval(s.timer);
      threads.delete(chatJid);
      log(`Cancel countdown for ${chatJid} (I replied)`);
      return;
    }
    const existing = threads.get(chatJid);
    if (existing?.timer) clearInterval(existing.timer);

    const state = {
      chatJid,
      threadId: p.chatJid,
      name: p.chatJid?.split('@')[0]?.slice(-8) || 'unknown',
      lastMsg: (p.text || '').slice(0, 500),
      senderId: p.sender,
      countdownLeft: cfg.delaySec,
      timer: null,
    };
    state.timer = setInterval(() => {
      state.countdownLeft--;
      if (state.countdownLeft <= 0) {
        clearInterval(state.timer);
        state.timer = null;
        aiReply(chatJid, state);
      }
    }, 1000);
    threads.set(chatJid, state);
    log(`📩 ${state.name}: "${state.lastMsg.slice(0, 50)}" — ${cfg.delaySec}s countdown`);
  }

  function hookNewMsg() {
    window.addEventListener('message', (ev) => {
      const d = ev.data;
      if (!d || d.source !== 'mr-injector' || d.type !== 'newMsg') return;
      handleNewMsg(d);
    });
    log('NewMsg listener installed');
  }

  hookNewMsg();
  log('AI page runtime ready, enabled=', cfg.enabled);
})();
