// Content script: deteksi konteks halaman + ambil XSRF token dari cookie.
// Berjalan di https://fasih-sm.bps.go.id/app/* — tidak memanggil API, hanya membaca.
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
        try { return decodeURIComponent(p.slice('XSRF-TOKEN='.length)); } catch (e) { return p.slice('XSRF-TOKEN='.length); }
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
    } catch (e) { /* extension context invalidated */ }
  }

  report();
  let last = location.href;
  setInterval(() => { if (location.href !== last) { last = location.href; report(); } }, 1500);
})();
