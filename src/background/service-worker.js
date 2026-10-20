// M1 read-only: buka side panel saat ikon diklik + simpan konteks dari content script.
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ fasihCheckpoints: {}, fasihLogs: [] });
});

try {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
} catch (e) { /* pre-114 fallback: user buka manual */ }

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'FASIH_CONTEXT') {
    chrome.storage.local.set({ fasihContext: { ...msg.payload, at: Date.now() } });
    sendResponse({ ok: true });
    return true;
  }
  if (msg && msg.type === 'FASIH_LOG') {
    chrome.storage.local.get(['fasihLogs'], (cur) => {
      const logs = Array.isArray(cur.fasihLogs) ? cur.fasihLogs : [];
      logs.push(msg.entry);
      chrome.storage.local.set({ fasihLogs: logs.slice(-2000) });
    });
    sendResponse({ ok: true });
    return true;
  }
});
