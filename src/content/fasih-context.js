// content/fasih-context.js
// Berjalan di context https://fasih-sm.bps.go.id/app/*
// Merekam konteks halaman, XSRF token, serta menyerap filter aktif dari fasih-interceptor.

(function () {
  function parseDataUrl(url) {
    const m = url.match(/\/app\/surveys\/([^/]+)\/([^/]+)\/data/);
    if (m) return { page: 'data', surveyId: m[1], surveyPeriodId: m[2] };
    const a = url.match(/\/app\/assignment\/([^/]+)\/([^/?#]+)/);
    if (a) return { page: 'detail', surveyPeriodId: a[1], assignmentId: a[2] };
    return { page: 'other' };
  }

  function getXsrfToken() {
    const parts = (document.cookie || '').split(';').map((s) => s.trim());
    for (const p of parts) {
      if (p.startsWith('XSRF-TOKEN=')) {
        try { return decodeURIComponent(p.slice('XSRF-TOKEN='.length)); } catch (_) { return p.slice('XSRF-TOKEN='.length); }
      }
    }
    return '';
  }

  function report() {
    const ctx = {
      url: location.href,
      ...parseDataUrl(location.href),
      xsrfToken: getXsrfToken(),
      hasSession: /(session|sid|laravel_session|remember)/i.test(document.cookie || ''),
    };
    try {
      chrome.runtime.sendMessage({ type: 'FASIH_CONTEXT', payload: ctx });
      chrome.storage.local.set({ fasihContext: { ...ctx, at: Date.now() } });
    } catch (_) { /* extension context invalidated */ }
  }

  // Fallback: pastikan interceptor termuat ke main world jika belum terdaftar via manifest
  try {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('content/fasih-interceptor.js');
    script.onload = () => script.remove();
    (document.head || document.documentElement).appendChild(script);
  } catch (_) {}

  // Dengarkan pesan tangkapan filter dari main world
  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data) return;
    if (event.data.type === 'FASIH_CAPTURED_FILTER') {
      const payload = event.data.payload;
      try {
        chrome.storage.local.set({ fasihActiveFilter: payload });
        chrome.runtime.sendMessage({ type: 'FASIH_FILTER_UPDATED', payload });
      } catch (_) {}
    }
  });

  // Dengarkan pesan dari sidepanel untuk memicu reload tabel jika filter belum tertangkap
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'FASIH_TRIGGER_TABLE_RELOAD') {
      window.dispatchEvent(new CustomEvent('FASIH_REQUEST_REFRESH_FILTER'));
      report();
      sendResponse({ ok: true });
      return true;
    }
  });

  report();
  let last = location.href;
  setInterval(() => { if (location.href !== last) { last = location.href; report(); } }, 1500);
})();
