// content/fasih-interceptor.js
// Berjalan di MAIN world halaman https://fasih-sm.bps.go.id/app/*
// Mencegat request DataTables Web Fasih untuk mendeteksi filter wilayah & status aktif secara pasif dan otomatis.

(function () {
  if (window.__FASIH_INTERCEPTOR_ACTIVE__) return;
  window.__FASIH_INTERCEPTOR_ACTIVE__ = true;

  function notifyFilter(extraParam, search, totalHit, extraData = {}) {
    if (!extraParam) return;
    window.postMessage({
      type: 'FASIH_CAPTURED_FILTER',
      payload: {
        extraParam,
        search: search || { value: '', regex: false },
        totalHit: Number(totalHit) || 0,
        extraData,
        capturedAt: Date.now(),
      },
    }, '*');
  }

  // Hook window.fetch
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
      // Pastikan hanya menangkap datatable utama, bukan endpoint aggregasi
      if (url.includes('/datatable-all-user-survey-periode') && !url.includes('-aggregation')) {
        const init = args[1] || {};
        if (init.body && typeof init.body === 'string') {
          const parsed = JSON.parse(init.body);
          if (parsed && parsed.assignmentExtraParam) {
            res.clone().json().then((json) => {
              const total = json.totalHit ?? json.recordsTotal ?? json.recordsFiltered ?? 0;
              notifyFilter(parsed.assignmentExtraParam, parsed.search, total, {
                recordsFiltered: json.recordsFiltered,
              });
            }).catch(() => {
              notifyFilter(parsed.assignmentExtraParam, parsed.search, 0);
            });
          }
        }
      }
    } catch (_) {}
    return res;
  };

  // Hook XMLHttpRequest
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._fasihUrl = String(url || '');
    this._fasihMethod = method;
    return origOpen.apply(this, [method, url, ...rest]);
  };

  XMLHttpRequest.prototype.send = function (body) {
    if (this._fasihUrl && this._fasihUrl.includes('/datatable-all-user-survey-periode') && !this._fasihUrl.includes('-aggregation')) {
      try {
        if (body && typeof body === 'string') {
          const parsed = JSON.parse(body);
          if (parsed && parsed.assignmentExtraParam) {
            this.addEventListener('load', function () {
              try {
                const json = JSON.parse(this.responseText);
                const total = json.totalHit ?? json.recordsTotal ?? json.recordsFiltered ?? 0;
                notifyFilter(parsed.assignmentExtraParam, parsed.search, total, {
                  recordsFiltered: json.recordsFiltered,
                });
              } catch (_) {
                notifyFilter(parsed.assignmentExtraParam, parsed.search, 0);
              }
            });
          }
        }
      } catch (_) {}
    }
    return origSend.apply(this, [body]);
  };
})();
