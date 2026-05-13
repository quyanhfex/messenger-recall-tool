// Open side panel on icon click
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// Background CHỈ forward request từ panel → tab content_script (vì panel không tự gửi tới tab được).
// Event ngược lại (content_script → panel) đi thẳng qua chrome.runtime.sendMessage,
// panel tự nhận qua chrome.runtime.onMessage — KHÔNG cần background relay.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.target === 'page') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab) { sendResponse({ ok: false, error: 'no active tab' }); return; }
      if (!/facebook\.com/.test(tab.url || '')) {
        sendResponse({ ok: false, error: 'not_messenger', url: tab.url });
        return;
      }
      chrome.tabs.sendMessage(tab.id, msg, (resp) => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse(resp);
        }
      });
    });
    return true;
  }
  // Các message khác (target=panel) không cần xử lý — panel tự nhận trực tiếp.
});
