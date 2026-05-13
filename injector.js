// ============================================================
// MESSENGER RECALL TOOL — Engine
// Chạy trong MAIN world của tab Messenger.
// Giao tiếp với panel qua window.postMessage (relayed bởi content_script).
// ============================================================

(function () {
  if (window.__MR_INJECTED__) return;
  window.__MR_INJECTED__ = true;

  // ---- State ----
  let store = null;
  let plaintextCache = new Map(); // messageId → { text, ariaLabel, timeStr, senderName }
  let storeCaptureAttempts = 0;
  const MAX_CAPTURE_ATTEMPTS = 30;

  // ---- Helpers ----
  function tryRequire(name) {
    try { return window.require(name); } catch (_) { return null; }
  }

  function getMods() {
    return {
      LSTasks: tryRequire('LSTasks'),
      LSTaskType: tryRequire('LSTaskType'),
      LSIntEnum: tryRequire('LSIntEnum'),
      LSDict: tryRequire('LSDict'),
      I64: tryRequire('I64'),
      MAWBridgeSendAndReceive: tryRequire('MAWBridgeSendAndReceive'),
      MAWDbMsg: tryRequire('MAWDbMsg'),
      MAWGetProtocolMsgIdByMsgIdInUI: tryRequire('MAWGetProtocolMsgIdByMsgIdInUI'),
      CurrentUserInitialData: tryRequire('CurrentUserInitialData'),
    };
  }

  // Capture store qua React Fiber walk
  function captureStore() {
    const RDT = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    if (!RDT) return null;
    const roots = [...RDT.getFiberRoots(1)];
    if (!roots.length) return null;
    const rootFiber = roots[0].current;

    let found = null;
    function walk(fiber, depth = 0) {
      if (!fiber || found || depth > 500) return;
      const v = fiber.memoizedProps && fiber.memoizedProps.value;
      if (v && typeof v === 'object' && typeof v.runInTransaction === 'function') {
        found = v;
        return;
      }
      walk(fiber.child, depth + 1);
      walk(fiber.sibling, depth + 1);
    }
    walk(rootFiber);
    return found;
  }

  function ensureStore() {
    if (store && typeof store.runInTransaction === 'function') return store;
    store = captureStore();
    return store;
  }

  // ---- Plaintext cache via fiber walk ----
  // 2 strategy:
  //   1. Bắt props.nameForModality + props.ariaLabel (mọi component, không filter name)
  //   2. Bắt props.text trên MWXMessageBaseMessageListText / MWXMessageTextWithEntities,
  //      đi LÊN cha tìm fiber có messageId/nameForModality để link
  function scanPlaintext() {
    const RDT = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    if (!RDT) return new Map();
    const roots = [...RDT.getFiberRoots(1)];
    if (!roots.length) return new Map();
    const rootFiber = roots[0].current;

    const localCache = new Map();

    // Regex linh hoạt: time có thể là "11:52", "Thứ Sáu 15:10ch", "Hôm qua 23:50s"...
    // Pattern: "Lúc <anything except ','>, <sender no ':'>: <text>"
    const reVn = /^Lúc ([^,]+), ([^:]+): ([\s\S]+)$/;
    const reEn = /^(?:At |)([^,]+), ([^:]+?)(?:\s+said|): ([\s\S]+)$/;
    function parseAria(ariaLabel) {
      let m = ariaLabel.match(reVn);
      if (!m) m = ariaLabel.match(reEn);
      if (m) return { timeStr: m[1].trim(), senderName: m[2].trim(), text: m[3] };
      return null;
    }

    function findMessageIdInAncestors(fiber, depth = 0) {
      let cur = fiber;
      for (let i = 0; i < 10 && cur; i++) {
        const p = cur.memoizedProps;
        if (p) {
          if (p.nameForModality) return p.nameForModality;
          if (p.messageId && typeof p.messageId === 'string' && p.messageId.includes('@msgr')) {
            return p.messageId;
          }
          if (p.message && p.message.messageId) return p.message.messageId;
        }
        cur = cur.return;
      }
      return null;
    }

    function walk(f, depth = 0) {
      if (!f || depth > 1000) return;
      const p = f.memoizedProps;
      if (p) {
        // Strategy 1: bất kỳ component nào có (nameForModality + ariaLabel)
        if (p.nameForModality && typeof p.ariaLabel === 'string') {
          const parsed = parseAria(p.ariaLabel);
          if (parsed) {
            localCache.set(p.nameForModality, {
              messageId: p.nameForModality,
              ariaLabel: p.ariaLabel,
              timeStr: parsed.timeStr,
              senderName: parsed.senderName,
              text: parsed.text,
            });
          }
        }
        // Strategy 2: component có props.text (plaintext thuần) → leo lên tìm messageId
        if (typeof p.text === 'string' && p.text.length > 0
            && !p.text.startsWith('7975345652##')
            && !p.text.startsWith('mid.')) {
          // Heuristic: text < 2000 ký tự, không phải class CSS
          if (p.text.length < 2000 && !/^x[0-9a-z]/.test(p.text)) {
            const mid = findMessageIdInAncestors(f);
            if (mid && mid.includes('@msgr')) {
              const existing = localCache.get(mid);
              if (!existing || !existing.text) {
                localCache.set(mid, Object.assign(existing || { messageId: mid }, {
                  text: p.text,
                }));
              }
            }
          }
        }
      }
      walk(f.child, depth + 1);
      walk(f.sibling, depth + 1);
    }
    walk(rootFiber);
    return localCache;
  }

  function refreshPlaintextCache() {
    const fresh = scanPlaintext();
    for (const [mid, entry] of fresh) plaintextCache.set(mid, entry);
    return plaintextCache.size;
  }

  // ---- Get all messages from LSDatabase ----
  function getAllMessages() {
    const s = ensureStore();
    if (!s) return Promise.reject(new Error('store_not_ready'));
    const { I64 } = getMods();
    if (!I64) return Promise.reject(new Error('module_missing:I64'));

    return s.runInTransaction(function (txn) {
      const tbl = s.table('messages');
      const it = tbl.entries(txn);
      const out = [];
      while (true) {
        const { value, done } = it.next();
        if (done) break;
        const [key, val] = value;
        out.push({
          key,
          threadKey: val.threadKey,
          threadKeyStr: I64.to_string(val.threadKey),
          timestampMs: val.timestampMs,
          timestampMsNum: parseInt(I64.to_string(val.timestampMs)),
          messageId: val.messageId,
          senderId: val.senderId,
          senderIdStr: val.senderId ? I64.to_string(val.senderId) : null,
          text: val.text,
          isUnsent: val.isUnsent,
          sendStatus: val.sendStatus,
          cannotUnsendReason: val.cannotUnsendReason,
          isAdminMessage: val.isAdminMessage,
        });
      }
      return Promise.resolve(out);
    }, 'readonly', undefined, undefined, 'MR.getAllMessages');
  }

  // ---- Phat hien call event tu payload (JSON marker) ----
  // Tim chuoi "XMSGXmaCallingTemplateData" trong payload → call event
  // Tra label co them call_state + duration neu parse duoc
  function detectCallEventLabel(bytes) {
    // Quick scan: tim ASCII "Calling" hoac "call_state"
    const needle1 = [0x43, 0x61, 0x6c, 0x6c, 0x69, 0x6e, 0x67]; // "Calling"
    const needle2 = [0x63, 0x61, 0x6c, 0x6c, 0x5f, 0x73, 0x74, 0x61, 0x74, 0x65]; // "call_state"
    function hasNeedle(needle) {
      outer: for (let i = 0; i < bytes.length - needle.length; i++) {
        for (let j = 0; j < needle.length; j++) {
          if (bytes[i + j] !== needle[j]) continue outer;
        }
        return true;
      }
      return false;
    }
    if (!hasNeedle(needle1) && !hasNeedle(needle2)) return null;

    // Parse JSON region để lấy call_state, duration
    try {
      const txt = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      const startIdx = txt.indexOf('{"content":');
      if (startIdx >= 0) {
        let depth = 0, end = -1;
        for (let i = startIdx; i < txt.length; i++) {
          if (txt[i] === '{') depth++;
          else if (txt[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
        }
        if (end > startIdx) {
          const json = txt.slice(startIdx, end);
          const data = JSON.parse(json);
          const tpl = data && data.content && data.content.custom_template_data;
          if (tpl) {
            const state = tpl.call_state || '';
            const type = tpl.call_type || '';
            const dur = parseInt(tpl.call_duration_sec) || 0;
            const stateLabel = {
              'MISSED': 'nhỡ',
              'ANSWERED': '',
              'DECLINED': 'từ chối',
              'CANCELED': 'hủy',
              'ENDED': '',
            }[state] || state.toLowerCase();
            const typeLabel = type === 'VIDEO' ? 'video call' : 'cuộc gọi';
            if (dur > 0) {
              const min = Math.floor(dur / 60), sec = dur % 60;
              return `[${typeLabel} ${stateLabel ? stateLabel + ' ' : ''}${min}:${String(sec).padStart(2,'0')}]`;
            }
            return `[${typeLabel}${stateLabel ? ' ' + stateLabel : ''}]`;
          }
        }
      }
    } catch (_) {}
    return '[cuộc gọi]';
  }

  // ---- Phat hien media trong payload ----
  // Return: '[\u1EA3nh]' | '[video]' | '[file]' | null
  function detectMediaLabel(bytes) {
    // 0. MIME string trong payload (anh/video qua CDN)
    const txt = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    if (/image\/(jpeg|png|gif|webp|heic)/i.test(txt)) return '[\u1EA3nh]';
    if (/video\/(mp4|webm|quicktime|ogg)/i.test(txt)) return '[video]';
    if (/audio\/(mpeg|mp4|ogg|webm|aac|wav)/i.test(txt)) return '[\u00E2m thanh]';
    // JPEG: ff d8 ff
    for (let i = 0; i < bytes.length - 2; i++) {
      if (bytes[i] === 0xff && bytes[i+1] === 0xd8 && bytes[i+2] === 0xff) return '[\u1EA3nh]';
    }
    // PNG: 89 50 4E 47 0D 0A 1A 0A
    for (let i = 0; i < bytes.length - 7; i++) {
      if (bytes[i] === 0x89 && bytes[i+1] === 0x50 && bytes[i+2] === 0x4E && bytes[i+3] === 0x47) return '[\u1EA3nh]';
    }
    // GIF: 47 49 46 38 (GIF8)
    for (let i = 0; i < bytes.length - 3; i++) {
      if (bytes[i] === 0x47 && bytes[i+1] === 0x49 && bytes[i+2] === 0x46 && bytes[i+3] === 0x38) return '[\u1EA3nh]';
    }
    // WebP: 52 49 46 46 ... 57 45 42 50
    for (let i = 0; i < bytes.length - 11; i++) {
      if (bytes[i] === 0x52 && bytes[i+1] === 0x49 && bytes[i+2] === 0x46 && bytes[i+3] === 0x46
          && bytes[i+8] === 0x57 && bytes[i+9] === 0x45 && bytes[i+10] === 0x42 && bytes[i+11] === 0x50) return '[\u1EA3nh]';
    }
    return null;
  }

  // ---- Kiem tra text co the la text nguoi dung khong ----
  // Loai: control chars (tru \t\n\r), DEL (0x7F-0x9F)
  function isReadableText(s) {
    if (!s) return false;
    for (let i = 0; i < s.length; i++) {
      const code = s.charCodeAt(i);
      if (code < 0x20) {
        if (code !== 0x09 && code !== 0x0A && code !== 0x0D) return false;
      } else if (code >= 0x7F && code < 0xA0) {
        return false;
      }
    }
    return true;
  }

  // ---- Protobuf walker: trich plaintext tu payload ArrayBuffer ----
  function extractTextFromPayload(buf) {
    if (!buf) return null;
    if (!(buf instanceof ArrayBuffer || ArrayBuffer.isView(buf))) return null;
    const bytes = buf instanceof ArrayBuffer
      ? new Uint8Array(buf)
      : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    if (bytes.length === 0) return null;

    // 1a. Detect call event truoc \u2014 payload nho chua JSON marker
    {
      const callLabel = detectCallEventLabel(bytes);
      if (callLabel) return callLabel;
    }

    // 1b. Detect media (anh/video/audio) \u2014 chay cho moi payload > 200 byte
    if (bytes.length > 200) {
      const label = detectMediaLabel(bytes);
      if (label) return label;
    }

    if (bytes.length > 8192) return null; // payload qua lon va khong phai anh -> bo qua

    const MAX_NODES = 5000;
    const MAX_DEPTH = 14;
    let nodes = 0;
    let best = null;

    function isMeta(s) {
      if (/^\d{10,25}$/.test(s)) return true;
      if (/@(msgr|s\.whatsapp\.net|c\.us)$/i.test(s)) return true;
      if (/^mid\.\$/.test(s)) return true;
      // JSON object/array
      if (/^\s*[{\[]/.test(s) && /["\}\]]/.test(s)) return true;
      // base64-like id (dai, khong space, chi ascii alphanumeric)
      if (s.length >= 16 && !/\s/.test(s) && /^[A-Za-z0-9+/=_-]+$/.test(s)) return true;
      return false;
    }

    function walk(off, end, depth) {
      if (depth > MAX_DEPTH || nodes > MAX_NODES) return;
      let p = off;
      while (p < end) {
        if (++nodes > MAX_NODES) return;
        let tag = 0, s = 0, sh = 0;
        while (p < end && sh < 10) {
          const b = bytes[p++];
          tag |= (b & 0x7f) << s;
          if (!(b & 0x80)) break;
          s += 7; sh++;
        }
        const wire = tag & 7;
        const field = tag >> 3;
        if (wire === 2) {
          let len = 0; s = 0; sh = 0;
          while (p < end && sh < 10) {
            const b = bytes[p++];
            len |= (b & 0x7f) << s;
            if (!(b & 0x80)) break;
            s += 7; sh++;
          }
          if (len < 0 || p + len > end) return;
          if (len > 0 && len < 2048) {
            try {
              const txt = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(p, p + len));
              if (txt.length >= 1 && isReadableText(txt) && !isMeta(txt)) {
                // Chap nhan depth >= 4 (giam tu 5) de bat tin wrap mong
                if (depth >= 4 && field === 1) {
                  if (!best || depth > best.depth || (depth === best.depth && txt.length > best.text.length)) {
                    best = { depth, text: txt };
                  }
                }
              }
            } catch (_) {}
            walk(p, p + len, depth + 1);
          }
          p += len;
        } else if (wire === 0) {
          let sh2 = 0;
          while (p < end && sh2 < 10 && (bytes[p++] & 0x80)) sh2++;
        } else if (wire === 1) {
          p += 8;
        } else if (wire === 5) {
          p += 4;
        } else {
          return;
        }
      }
    }
    walk(0, bytes.length, 0);
    return best ? best.text : null;
  }

  // State for running load-older loop
  let _loadOlderActive = false;
  let _loadOlderAbort = false;

  async function loadOlderMessages(opts) {
    opts = opts || {};
    const fromDate = opts.fromDate || 0;
    const maxBatches = opts.maxBatches || 30;
    const batchSize = opts.batchSize || 50;
    const delayMs = opts.delayMs == null ? 200 : opts.delayMs;
    const requestId = opts.requestId;
    const myId = getMyId();

    if (_loadOlderActive) throw new Error('already_running');
    _loadOlderActive = true;
    _loadOlderAbort = false;

    try {
      const urlThread = getCurrentThreadKey();
      if (!urlThread) throw new Error('no_thread_open');

      // Bắt đầu fetch từ tin mới nhất trong DB, lùi dần về quá khứ.
      // Mục tiêu: tải tất cả tin trong khoảng [fromDate, now].
      const allDb = await getAllMessages();
      const inThread = allDb.filter((m) => m.threadKeyStr === urlThread);
      if (!inThread.length) throw new Error('thread_empty_in_db');
      inThread.sort((a, b) => b.timestampMsNum - a.timestampMsNum); // mới → cũ
      const newestDb = inThread[0];
      const threadIdAtMsgr = newestDb.messageId.split('.')[0];
      // Cursor = tin mới nhất + 1ms để bao gồm cả tin đó trong fetch
      let cursorTs = newestDb.timestampMsNum + 1;
      let cursorId = newestDb.messageId.split('.')[1];

      const mods = getMods();
      const bridge = mods.MAWBridgeSendAndReceive;
      const collected = [];

      for (let i = 0; i < maxBatches; i++) {
        if (_loadOlderAbort) break;

        const resp = await bridge.sendAndReceive('mps', 'mpsLoadMessages', {
          debug: { purpose: 'load-more' },
          direction: 'desc',
          from: [cursorTs, String(cursorId)],
          numMessages: batchSize,
          threadId: threadIdAtMsgr,
        });

        if (!resp || !resp.success) {
          if (requestId) {
            window.postMessage({
              source: 'mr-injector', type: 'loadOlderProgress', requestId,
              status: 'error', batch: i + 1, maxBatches, totalFetched: collected.length,
              error: 'bridge_fail',
            }, '*');
          }
          break;
        }
        const msgs = resp.value && resp.value.messages || [];
        if (!msgs.length) break;

        const rawItems = msgs.map((m) => {
          const text = extractTextFromPayload(m.toplevelProtobuf.payload);
          return {
            messageId: threadIdAtMsgr + '.' + m.toplevelProtobuf.messageId,
            externalId: m.toplevelProtobuf.messageId,
            threadIdAtMsgr,
            senderId: m.toplevelProtobuf.senderId,
            isMine: m.toplevelProtobuf.senderId === myId,
            timestampMs: m.toplevelProtobuf.timestampMs,
            text,
          };
        });
        // Chỉ giữ tin >= fromDate để gửi về panel
        const items = fromDate > 0
          ? rawItems.filter((m) => m.timestampMs >= fromDate)
          : rawItems;
        collected.push(...items);

        const sorted = rawItems.slice().sort((a, b) => a.timestampMs - b.timestampMs);
        const oldestInBatch = sorted[0];

        if (requestId) {
          window.postMessage({
            source: 'mr-injector', type: 'loadOlderProgress', requestId,
            status: 'running', batch: i + 1, maxBatches,
            batchSize: msgs.length, totalFetched: collected.length,
            oldestTs: oldestInBatch.timestampMs,
            items, // gửi batch để panel append live
          }, '*');
        }

        if (oldestInBatch.timestampMs < fromDate) break;
        if (!resp.value.cursorInfo || !resp.value.cursorInfo.hasPrevious) break;

        cursorTs = oldestInBatch.timestampMs;
        cursorId = oldestInBatch.externalId;

        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      }

      return { totalFetched: collected.length, aborted: _loadOlderAbort };
    } finally {
      _loadOlderActive = false;
    }
  }

  function abortLoadOlder() {
    _loadOlderAbort = true;
    return { ok: true };
  }

  // ---- Lay text cho tin DB qua bridge mpsLoadMessages (1 batch tron quanh tin cu nhat) ----
  // Goi 1-2 batch nho de cover toan bo tin DB, parse payload tung tin -> tra ve {messageId, text}.
  async function enrichDbMessages(opts) {
    opts = opts || {};
    const numBatches = opts.numBatches || 2;
    const batchSize = opts.batchSize || 50;

    const urlThread = getCurrentThreadKey();
    if (!urlThread) throw new Error('no_thread_open');

    const allDb = await getAllMessages();
    const inThread = allDb.filter((m) => m.threadKeyStr === urlThread);
    if (!inThread.length) return { enriched: [] };

    inThread.sort((a, b) => b.timestampMsNum - a.timestampMsNum);
    const newestDb = inThread[0];
    const threadIdAtMsgr = newestDb.messageId.split('.')[0];

    const mods = getMods();
    if (!mods.MAWBridgeSendAndReceive) throw new Error('module_missing');
    const bridge = mods.MAWBridgeSendAndReceive;

    // Cursor far in the future to bao gom ca tin newest
    let cursorTs = Date.now() + 86400000;
    let cursorId = '0';
    const enriched = [];

    for (let i = 0; i < numBatches; i++) {
      const resp = await bridge.sendAndReceive('mps', 'mpsLoadMessages', {
        debug: { purpose: 'load-more' },
        direction: 'desc',
        from: [cursorTs, String(cursorId)],
        numMessages: batchSize,
        threadId: threadIdAtMsgr,
      });
      if (!resp || !resp.success) break;
      const msgs = resp.value && resp.value.messages || [];
      if (!msgs.length) break;

      for (const m of msgs) {
        const text = extractTextFromPayload(m.toplevelProtobuf.payload);
        if (text) {
          enriched.push({
            messageId: threadIdAtMsgr + '.' + m.toplevelProtobuf.messageId,
            text,
          });
        }
      }

      const sorted = msgs.slice().sort((a, b) => a.toplevelProtobuf.timestampMs - b.toplevelProtobuf.timestampMs);
      const oldestInBatch = sorted[0];
      if (!resp.value.cursorInfo || !resp.value.cursorInfo.hasPrevious) break;
      cursorTs = oldestInBatch.toplevelProtobuf.timestampMs;
      cursorId = oldestInBatch.toplevelProtobuf.messageId;
    }
    return { enriched };
  }

  // ---- HKDF SHA-256 (WhatsApp / Messenger media key derivation) ----
  async function hkdfExpand(keyBytes, infoStr, length) {
    const cryptoKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'HKDF' }, false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({
      name: 'HKDF', hash: 'SHA-256',
      salt: new Uint8Array(32),
      info: new TextEncoder().encode(infoStr),
    }, cryptoKey, length * 8);
    return new Uint8Array(bits);
  }

  async function aesCbcDecrypt(key, iv, ct) {
    const k = await crypto.subtle.importKey('raw', key, { name: 'AES-CBC' }, false, ['decrypt']);
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, k, ct));
  }

  // ---- Tim cac 32-byte chunk co tag protobuf (tag in {0a,12,1a,22}) trong payload ----
  function findKeyCandidates(bytes) {
    const found = new Map(); // hex → offset
    for (let i = 0; i < bytes.length - 33; i++) {
      if (bytes[i+1] === 0x20 && (bytes[i] === 0x0a || bytes[i] === 0x12 || bytes[i] === 0x1a || bytes[i] === 0x22)) {
        const hex = Array.from(bytes.slice(i+2, i+34)).map(b => b.toString(16).padStart(2,'0')).join('');
        if (!found.has(hex)) found.set(hex, i);
      }
    }
    return Array.from(found.keys()).map(hex => {
      const arr = new Uint8Array(32);
      for (let j = 0; j < 32; j++) arr[j] = parseInt(hex.substr(j*2, 2), 16);
      return arr;
    });
  }

  // ---- Magic byte detect ----
  function detectImageMime(bytes) {
    if (bytes.length < 4) return null;
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return 'image/png';
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif';
    if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
        && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
    return null;
  }

  // ---- Thu decrypt blob CDN bang HKDF + cac candidate key + cac info string ----
  async function tryDecryptCdnBlob(ctBytes, keyCandidates) {
    const infoStrings = [
      'WhatsApp Image Keys',
      'WhatsApp Video Keys',
      'Messenger Image Keys',
      'MMS Image Keys',
    ];
    for (const key of keyCandidates) {
      for (const info of infoStrings) {
        try {
          const derived = await hkdfExpand(key, info, 112);
          const iv = derived.slice(0, 16);
          const cipherKey = derived.slice(16, 48);
          // WhatsApp: tail 10 bytes = HMAC-truncated, skip
          const ct = ctBytes.slice(0, ctBytes.length - 10);
          const decrypted = await aesCbcDecrypt(cipherKey, iv, ct);
          const mime = detectImageMime(decrypted);
          if (mime) return { mime, bytes: decrypted, info };
        } catch (_) {}
      }
    }
    return null;
  }

  // ---- Lay anh: thu embedded truoc, fail thi decrypt CDN ----
  async function getMediaForMessage(threadIdAtMsgr, externalId) {
    const mods = getMods();
    if (!mods.MAWBridgeSendAndReceive) throw new Error('module_missing');
    const bridge = mods.MAWBridgeSendAndReceive;

    const resp = await bridge.sendAndReceive('mps', 'mpsLoadMessage', {
      config: { shouldFetchSupplementals: true, strategy: 'local-first' },
      debug: { trigger: 'MR.getMedia' },
      messageId: String(externalId),
      threadId: threadIdAtMsgr,
    });
    if (!resp || !resp.success || !resp.value || !resp.value.toplevelProtobuf) return null;
    const buf = resp.value.toplevelProtobuf.payload;
    if (!buf || !buf.byteLength) return null;
    const bytes = new Uint8Array(buf);

    function findRange(bytes) {
      // JPEG: ff d8 ff … ff d9
      let s = -1, e = -1;
      for (let i = 0; i < bytes.length - 2; i++) {
        if (bytes[i] === 0xff && bytes[i+1] === 0xd8 && bytes[i+2] === 0xff) { s = i; break; }
      }
      if (s >= 0) {
        for (let i = bytes.length - 2; i > s; i--) {
          if (bytes[i] === 0xff && bytes[i+1] === 0xd9) { e = i + 2; break; }
        }
        if (e > s) return { mime: 'image/jpeg', start: s, end: e };
      }
      // PNG: 89 50 4E 47 0D 0A 1A 0A … IEND chunk + CRC (49 45 4E 44 ae 42 60 82)
      s = -1; e = -1;
      for (let i = 0; i < bytes.length - 7; i++) {
        if (bytes[i] === 0x89 && bytes[i+1] === 0x50 && bytes[i+2] === 0x4E && bytes[i+3] === 0x47
            && bytes[i+4] === 0x0D && bytes[i+5] === 0x0A && bytes[i+6] === 0x1A && bytes[i+7] === 0x0A) {
          s = i; break;
        }
      }
      if (s >= 0) {
        for (let i = s + 8; i < bytes.length - 7; i++) {
          if (bytes[i] === 0x49 && bytes[i+1] === 0x45 && bytes[i+2] === 0x4E && bytes[i+3] === 0x44
              && bytes[i+4] === 0xAE && bytes[i+5] === 0x42 && bytes[i+6] === 0x60 && bytes[i+7] === 0x82) {
            e = i + 8; break;
          }
        }
        if (e > s) return { mime: 'image/png', start: s, end: e };
      }
      // GIF: 47 49 46 38 (7|9) 61 ... 3B (trailer)
      s = -1; e = -1;
      for (let i = 0; i < bytes.length - 5; i++) {
        if (bytes[i] === 0x47 && bytes[i+1] === 0x49 && bytes[i+2] === 0x46 && bytes[i+3] === 0x38
            && (bytes[i+4] === 0x37 || bytes[i+4] === 0x39) && bytes[i+5] === 0x61) {
          s = i; break;
        }
      }
      if (s >= 0) {
        for (let i = bytes.length - 1; i > s + 5; i--) {
          if (bytes[i] === 0x3B) { e = i + 1; break; }
        }
        if (e > s) return { mime: 'image/gif', start: s, end: e };
      }
      // WebP: RIFF size WEBP ... (size = uint32 LE tu offset+4)
      s = -1; e = -1;
      for (let i = 0; i < bytes.length - 11; i++) {
        if (bytes[i] === 0x52 && bytes[i+1] === 0x49 && bytes[i+2] === 0x46 && bytes[i+3] === 0x46
            && bytes[i+8] === 0x57 && bytes[i+9] === 0x45 && bytes[i+10] === 0x42 && bytes[i+11] === 0x50) {
          const size = bytes[i+4] | (bytes[i+5] << 8) | (bytes[i+6] << 16) | (bytes[i+7] << 24);
          s = i; e = i + 8 + size;
          if (e <= bytes.length) return { mime: 'image/webp', start: s, end: e };
        }
      }
      return null;
    }

    function bytesToBase64(slice) {
      let bin = '';
      for (let i = 0; i < slice.length; i++) bin += String.fromCharCode(slice[i]);
      return btoa(bin);
    }

    // 1. Thu embedded inline
    const range = findRange(bytes);
    if (range) {
      const slice = bytes.subarray(range.start, range.end);
      return { mime: range.mime, base64: bytesToBase64(slice), size: slice.length, source: 'embedded' };
    }

    // 2. Detect CDN URL .enc trong payload
    const txt = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    const urlPathMatch = txt.match(/\/v\/t\d+\.\d+-\d+\/[^\s"]+\.enc\?[^\s"]+/);
    if (!urlPathMatch) return null;
    let urlPath = urlPathMatch[0];
    // Stop at first non-URL byte (controll/non-printable)
    urlPath = urlPath.replace(/[^\x20-\x7E].*/, '');

    // Try multiple CDN hosts that Facebook uses; pick first that works
    const hosts = [
      'video.fluh1-1.fna.fbcdn.net',
      'scontent.fluh1-1.fna.fbcdn.net',
      'video-sin6-3.xx.fbcdn.net',
      'scontent.xx.fbcdn.net',
    ];
    let blob = null;
    for (const host of hosts) {
      try {
        const r = await fetch('https://' + host + urlPath);
        if (r.ok) {
          blob = new Uint8Array(await r.arrayBuffer());
          if (blob.length > 50) break;
        }
      } catch (_) {}
    }
    if (!blob) return null;

    // 3. Thu decrypt voi cac candidate key 32-byte trong payload
    const candidates = findKeyCandidates(bytes);
    const dec = await tryDecryptCdnBlob(blob, candidates);
    if (!dec) return null;

    return {
      mime: dec.mime,
      base64: bytesToBase64(dec.bytes),
      size: dec.bytes.length,
      source: 'cdn-decrypted',
      info: dec.info,
    };
  }

  // ---- Revoke 1 tin extra (ngoài DB) bằng externalId ----
  async function revokeExternal(threadIdAtMsgr, externalId) {
    const mods = getMods();
    if (!mods.MAWBridgeSendAndReceive) throw new Error('module_missing:MAWBridgeSendAndReceive');
    const payload = {
      msgId: { author: '@me', chat: threadIdAtMsgr, externalId: String(externalId) },
      qplEventType: { i: 25313175, r: 32 },
      qplInstanceKey: Date.now() + Math.floor(Math.random() * 10000) + 10000,
    };
    return mods.MAWBridgeSendAndReceive.sendAndReceive('backend', 'sendRevokeMsg', payload);
  }

  // ---- Lay contact info (name + avatar) cho danh sach userId ----
  async function getContactsByIds(userIdStrs) {
    const s = ensureStore();
    if (!s) throw new Error('store_not_ready');
    const mods = getMods();
    if (!mods.I64) throw new Error('module_missing:I64');
    const I64 = mods.I64;
    const wanted = new Set(userIdStrs.map(String));
    return s.runInTransaction(function (txn) {
      const tbl = s.table('contacts');
      const it = tbl.entries(txn);
      const out = {};
      while (true) {
        const { value, done } = it.next();
        if (done) break;
        const [, val] = value;
        if (!val.id) continue;
        const idStr = I64.to_string(val.id);
        if (wanted.has(idStr)) {
          out[idStr] = {
            id: idStr,
            name: val.name || null,
            firstName: val.firstName || null,
            avatarUrl: val.profilePictureUrl || null,
            avatarFallback: val.profilePictureFallbackUrl || null,
          };
          if (Object.keys(out).length === wanted.size) break;
        }
      }
      return Promise.resolve(out);
    }, 'readonly', undefined, undefined, 'MR.getContacts');
  }

  // ---- Fetch URL → base64 (dung cho avatar trong PDF) ----
  async function fetchAsBase64(url) {
    try {
      const r = await fetch(url);
      if (!r.ok) return null;
      const buf = await r.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let bin = '';
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      const mime = r.headers.get('content-type') || 'image/jpeg';
      return { mime, base64: btoa(bin) };
    } catch (_) {
      return null;
    }
  }

  // ---- Get current thread key from URL ----
  function getCurrentThreadKey() {
    const m = location.pathname.match(/\/messages\/(?:e2ee\/)?t\/(\d+)/);
    return m ? m[1] : null;
  }

  // ---- Get current user ID ----
  function getMyId() {
    const mods = getMods();
    return mods.CurrentUserInitialData ? mods.CurrentUserInitialData.USER_ID : null;
  }

  // ---- Revoke 1 message ----
  async function revokeOne(uiMessageId) {
    const mods = getMods();
    if (!mods.MAWDbMsg || !mods.MAWGetProtocolMsgIdByMsgIdInUI || !mods.MAWBridgeSendAndReceive) {
      throw new Error('module_missing:MAW*');
    }
    const dbMsgId = mods.MAWDbMsg.toMsgId(uiMessageId);
    if (dbMsgId == null) throw new Error('bad_msg_id:' + uiMessageId);
    const protocolMsgId = await mods.MAWGetProtocolMsgIdByMsgIdInUI.getProtocolMsgIdByMsgIdUI(dbMsgId);
    if (protocolMsgId == null) throw new Error('no_protocol_id');
    const payload = {
      msgId: protocolMsgId,
      qplEventType: { i: 25313175, r: 32 },
      qplInstanceKey: Date.now() + Math.floor(Math.random() * 10000) + 10000,
    };
    return mods.MAWBridgeSendAndReceive.sendAndReceive('backend', 'sendRevokeMsg', payload);
  }

  // ---- Batch revoke with progress streaming ----
  // requestId is used to stream progress back to the panel
  async function revokeMany(uiMessageIds, opts) {
    opts = opts || {};
    const delayMs = opts.delayMs == null ? 1000 : opts.delayMs;
    const requestId = opts.requestId;
    const results = [];
    for (let i = 0; i < uiMessageIds.length; i++) {
      const mid = uiMessageIds[i];
      let success = false, error = null;
      try {
        await revokeOne(mid);
        success = true;
      } catch (e) {
        error = (e && e.message) || String(e);
      }
      results.push({ messageId: mid, success, error });
      if (requestId) {
        window.postMessage({
          source: 'mr-injector',
          type: 'progress',
          requestId,
          i: i + 1,
          total: uiMessageIds.length,
          messageId: mid,
          success,
          error,
        }, '*');
      }
      if (i < uiMessageIds.length - 1 && delayMs > 0) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    return results;
  }

  // ---- Get thread name from DOM (best effort) ----
  function getCurrentThreadName() {
    // Header chứa tên: h1 hoặc heading có aria-label gần icon call
    const h = document.querySelector('h1, [role="main"] h2, [role="main"] h3');
    return h ? h.textContent.trim() : null;
  }

  // ---- Auto scroll thread to collect plaintext ----
  async function autoCollectPlaintext(opts) {
    opts = opts || {};
    const maxIterations = opts.maxIterations || 30;
    const interval = opts.interval || 700;
    const requestId = opts.requestId;

    // Tìm scroller — thường là div có role="grid" trong khu vực messages
    const scroller = document.querySelector('[role="grid"]')
      || document.querySelector('[aria-label*="Tin nhắn"]')
      || document.querySelector('[aria-label*="Messages"]');
    if (!scroller) return { success: false, error: 'scroller_not_found' };

    let prevSize = plaintextCache.size;
    let stable = 0;
    for (let i = 0; i < maxIterations; i++) {
      scroller.scrollTop = 0;
      await new Promise((r) => setTimeout(r, interval));
      refreshPlaintextCache();
      if (requestId) {
        window.postMessage({
          source: 'mr-injector',
          type: 'autoCollectProgress',
          requestId,
          iteration: i + 1,
          maxIterations,
          cacheSize: plaintextCache.size,
        }, '*');
      }
      if (plaintextCache.size === prevSize) {
        stable++;
        if (stable >= 3) break;
      } else {
        stable = 0;
      }
      prevSize = plaintextCache.size;
    }
    return { success: true, cacheSize: plaintextCache.size };
  }

  // ---- Status check ----
  function getStatus() {
    const mods = getMods();
    const moduleCheck = {};
    for (const k of Object.keys(mods)) moduleCheck[k] = !!mods[k];
    const allModulesOk = Object.values(moduleCheck).every(Boolean);
    const storeOk = !!ensureStore();
    return {
      isFacebook: /facebook\.com/.test(location.hostname),
      isMessengerThread: !!getCurrentThreadKey(),
      threadKey: getCurrentThreadKey(),
      threadName: getCurrentThreadName(),
      myId: getMyId(),
      storeReady: storeOk,
      modulesReady: allModulesOk,
      modules: moduleCheck,
      plaintextCacheSize: plaintextCache.size,
      url: location.href,
    };
  }

  // ---- RPC handler ----
  async function handleRequest(req) {
    const { action, params } = req;
    switch (action) {
      case 'status':
        return getStatus();
      case 'getAllMessages':
        return getAllMessages();
      case 'getThreadMessages': {
        const all = await getAllMessages();
        return all.filter((m) => m.threadKeyStr === String(params.threadKeyStr));
      }
      case 'refreshPlaintextCache':
        return { size: refreshPlaintextCache(), entries: Array.from(plaintextCache.entries()) };
      case 'getPlaintextCache':
        return { entries: Array.from(plaintextCache.entries()) };
      case 'revokeOne':
        return revokeOne(params.messageId);
      case 'revokeMany':
        return revokeMany(params.messageIds, { delayMs: params.delayMs, requestId: params.requestId });
      case 'autoCollectPlaintext':
        return autoCollectPlaintext({ requestId: params && params.requestId, maxIterations: params && params.maxIterations });
      case 'loadOlderMessages':
        return loadOlderMessages(params || {});
      case 'abortLoadOlder':
        return abortLoadOlder();
      case 'revokeExternal':
        return revokeExternal(params.threadIdAtMsgr, params.externalId);
      case 'enrichDbMessages':
        return enrichDbMessages(params || {});
      case 'getMediaForMessage':
        return getMediaForMessage(params.threadIdAtMsgr, params.externalId);
      case 'getContactsByIds':
        return getContactsByIds(params.userIds || []);
      case 'fetchAsBase64':
        return fetchAsBase64(params.url);
      default:
        throw new Error('unknown_action:' + action);
    }
  }

  // ---- Message listener (page world ↔ content script) ----
  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== 'mr-panel-relay') return;

    const { rpcId, request } = data;
    try {
      const result = await handleRequest(request);
      window.postMessage({ source: 'mr-injector', type: 'rpcResult', rpcId, ok: true, result }, '*');
    } catch (e) {
      window.postMessage({
        source: 'mr-injector',
        type: 'rpcResult',
        rpcId,
        ok: false,
        error: (e && e.message) || String(e),
      }, '*');
    }
  });

  // ---- Auto-capture store + signal ready ----
  function tryCaptureAndAnnounce() {
    storeCaptureAttempts++;
    ensureStore();
    const status = getStatus();
    window.postMessage({ source: 'mr-injector', type: 'status', status }, '*');
    if (!status.storeReady && storeCaptureAttempts < MAX_CAPTURE_ATTEMPTS) {
      setTimeout(tryCaptureAndAnnounce, 1000);
    }
  }
  // Delay 2s sau DOMContentLoaded để React render xong
  setTimeout(tryCaptureAndAnnounce, 2000);

  // Expose for manual console use
  window.__MR__ = {
    getStatus, getAllMessages, revokeOne, revokeMany,
    refreshPlaintextCache, autoCollectPlaintext,
    loadOlderMessages, abortLoadOlder, revokeExternal,
    enrichDbMessages, getMediaForMessage,
    getContactsByIds, fetchAsBase64,
    extractTextFromPayload,
    get plaintextCache() { return plaintextCache; },
    get store() { return store; },
  };

  console.log('[MR] Messenger Recall Tool injector loaded');
})();
