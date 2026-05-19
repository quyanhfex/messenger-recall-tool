// Bridge between MAIN-world injector and the extension's side panel.
// - Listens to window.postMessage from injector → forwards to panel via chrome.runtime
// - Receives chrome.runtime.onMessage (target=page) from panel → forwards to injector via window.postMessage

const pendingRpc = new Map(); // rpcId → sendResponse

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== 'mr-injector') return;

  // RPC result → resolve pending sendResponse
  if (data.type === 'rpcResult' && data.rpcId && pendingRpc.has(data.rpcId)) {
    const sendResponse = pendingRpc.get(data.rpcId);
    pendingRpc.delete(data.rpcId);
    sendResponse({ ok: data.ok, result: data.result, error: data.error });
    return;
  }

  // Async events (status, progress, autoCollectProgress, loadOlderProgress, newMsg) → broadcast to panel
  if (['status', 'progress', 'autoCollectProgress', 'loadOlderProgress', 'newMsg'].includes(data.type)) {
    chrome.runtime.sendMessage({
      target: 'panel',
      eventType: data.type,
      payload: data,
    }).catch(() => {});
  }
});

// Action có thể chạy lâu (multi-batch, multi-revoke) → cho timeout dài hơn
const LONG_ACTIONS = new Set(['loadOlderMessages', 'revokeMany', 'autoCollectPlaintext']);

// Actions xử lý local trong content script (không cần đi qua injector)
const LOCAL_ACTIONS = new Set(['stegoRescan']);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'page') return;

  // Local action: dispatch event để stego_overlay.js (cùng context) xử lý
  if (msg.request && LOCAL_ACTIONS.has(msg.request.action)) {
    window.dispatchEvent(new CustomEvent('mr-local-action', { detail: msg.request }));
    sendResponse({ ok: true });
    return;
  }

  const rpcId = Math.random().toString(36).slice(2);
  pendingRpc.set(rpcId, sendResponse);
  window.postMessage({ source: 'mr-panel-relay', rpcId, request: msg.request }, '*');
  const timeoutMs = (msg.request && LONG_ACTIONS.has(msg.request.action)) ? 600000 : 60000;
  setTimeout(() => {
    if (pendingRpc.has(rpcId)) {
      pendingRpc.delete(rpcId);
      sendResponse({ ok: false, error: 'timeout' });
    }
  }, timeoutMs);
  return true;
});

console.log('[MR] content_script loaded');
