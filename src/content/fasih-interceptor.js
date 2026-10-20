// content/fasih-interceptor.js
// Berjalan di MAIN world halaman https://fasih-sm.bps.go.id/app/*
// Mencegat request DataTables Web Fasih untuk mendeteksi filter wilayah & status aktif secara otomatis.

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
      if (url.includes('/datatable-all-user-survey-periode')) {
        const init = args[1] || {};
        if (init.body && typeof init.body === 'string') {
          const parsed = JSON.parse(init.body);
          if (parsed && parsed.assignmentExtraParam) {
            res.clone().json().then((json) => {
              notifyFilter(parsed.assignmentExtraParam, parsed.search, json.totalHit || json.recordsTotal || 0, {
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
    if (this._fasihUrl && this._fasihUrl.includes('/datatable-all-user-survey-periode')) {
      try {
        if (body && typeof body === 'string') {
          const parsed = JSON.parse(body);
          if (parsed && parsed.assignmentExtraParam) {
            this.addEventListener('load', function () {
              try {
                const json = JSON.parse(this.responseText);
                notifyFilter(parsed.assignmentExtraParam, parsed.search, json.totalHit || json.recordsTotal || 0, {
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

  // Dengarkan sinyal refresh dari extension content script
  window.addEventListener('FASIH_REQUEST_REFRESH_FILTER', () => {
    try {
      // Jika halaman menggunakan jQuery DataTables, reload agar request terpancing
      if (window.$ && typeof window.$.fn?.DataTable === 'function') {
        const dt = window.$('.dataTable').DataTable();
        if (dt && typeof dt.ajax?.reload === 'function') {
          dt.ajax.reload(null, false);
        }
      }
    } catch (_) {}
  });
})();
