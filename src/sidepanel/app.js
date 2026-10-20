// sidepanel/app.js — Auto-Approval Fasih SE2026 (Edited by Admin ➔ Completed by Admin)
import {
  buildListBodyFromActiveFilter,
  buildListBody,
  resolveChainFromL6,
  listAssignments,
  getAggregation,
  pageToStart,
  approveOne,
  rejectOne,
  revokeOne,
  shouldApproveRow,
  shouldRejectRow,
  shouldRevokeRow,
  humanDelay,
  withRetry,
  sleep,
} from '../lib/fasih-api.js';
import { parseExcelFile } from '../lib/sheet.js';
import { getStore, setStore, appendLog, logsToCsv, ts } from '../lib/store.js';

const $ = (id) => document.getElementById(id);
const logEl = $('log');
const PAGE_LEN = 10;
let pauseReq = false;
let stopReq = false;
let running = false;
let rejectTargets = [];

function log(line) {
  logEl.textContent += `[${ts()}] ${line}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function setProgress(done, total, extra = '') {
  $('progress').textContent = total ? `${done}/${total} ${extra}` : `Siap. ${extra}`;
  $('bar').value = total ? Math.round((done / total) * 100) : 0;
  $('bar').max = 100;
}

async function currentContext() {
  const cur = await getStore(['fasihContext']);
  return cur.fasihContext ?? null;
}

async function getActiveFilter() {
  const cur = await getStore(['fasihActiveFilter']);
  return cur.fasihActiveFilter ?? null;
}

async function refreshFilterUI() {
  const filter = await getActiveFilter();
  const badge = $('filterBadge');
  const info = $('filterInfo');
  if (filter && filter.extraParam && filter.extraParam.surveyPeriodId) {
    badge.textContent = '● Filter Web Terdeteksi';
    badge.className = 'pill on';
    const totalHit = filter.totalHit ?? '-';
    info.innerHTML = `✓ <b>Tersinkron:</b> Periode <code>${filter.extraParam.surveyPeriodId.slice(0, 8)}…</code> | Total baris di Web: <b>${totalHit}</b><br><span style="color:#1c7a2e;">Siap untuk pengujian atau eksekusi auto-approve.</span>`;
  } else {
    badge.textContent = '● Menunggu filter Web...';
    badge.className = 'pill off';
    info.innerHTML = 'Buka halaman <b>Data</b> di tab Web Fasih lalu pilih filter wilayah/status. Ekstensi otomatis menyerap filter tanpa perlu ketik nomor SLS manual.';
  }
  return filter;
}

async function refreshStatus() {
  const ctx = await currentContext();
  const pill = $('conn');
  if (ctx && ctx.page === 'data') {
    pill.textContent = '● terhubung (halaman data)';
    pill.className = 'pill on';
    $('ctx').textContent = `survey ${ctx.surveyId ?? '-'} | periode ${ctx.surveyPeriodId ?? '-'}${ctx.xsrfToken ? ' | XSRF ✓' : ' | XSRF ✗'}`;
  } else if (ctx && ctx.page === 'detail') {
    pill.textContent = '● halaman detail';
    pill.className = 'pill on';
    $('ctx').textContent = `detail ${ctx.assignmentId ?? ''} — buka halaman Data untuk filter & list.`;
  } else {
    pill.textContent = '● belum terhubung';
    pill.className = 'pill off';
    $('ctx').textContent = 'Buka halaman Data Fasih di tab aktif.';
  }
  await refreshFilterUI();
  return ctx;
}

// Tombol 🔍 Cek Data Target
$('btnCheckData').addEventListener('click', async () => {
  try {
    const ctx = await refreshStatus();
    if (!ctx || ctx.page !== 'data') { log('Buka halaman /data Fasih dulu di tab browser.'); return; }
    if (!ctx.xsrfToken) { log('XSRF token kosong — refresh halaman Fasih.'); return; }

    const activeFilter = await getActiveFilter();
    if (!activeFilter || !activeFilter.extraParam) {
      log('Filter Web belum terdeteksi. Silakan pilih filter di Web Fasih.');
      return;
    }

    const userSearch = $('search').value.trim();
    const activeSearch = activeFilter.search?.value ? String(activeFilter.search.value).trim() : '';
    const searchValue = userSearch || activeSearch;
    if (!userSearch && activeSearch) {
      log(`[filter] Menggunakan kata kunci pencarian Web Fasih: "${activeSearch}"`);
    }
    const onlyEdited = $('onlyEdited').checked;
    const body = buildListBodyFromActiveFilter({
      assignmentExtraParam: activeFilter.extraParam,
      start: pageToStart(1, PAGE_LEN),
      length: PAGE_LEN,
      searchValue,
    });

    log('Mengambil sampel data dari Web Fasih…');
    const [list, agg] = await Promise.all([
      listAssignments(body, ctx.xsrfToken),
      getAggregation(body, ctx.xsrfToken).catch(() => null),
    ]);

    const total = list.totalHit ?? list.searchData?.length ?? 0;
    const rows = list.searchData ?? [];
    let countEdited = 0;
    let countCompleted = 0;

    $('rows').innerHTML = '';
    for (const r of rows) {
      const alias = String(r.assignmentStatusAlias ?? r.assignmentStatusId ?? '');
      const isEdited = alias.toUpperCase().includes('EDITED');
      const isCompleted = alias.toUpperCase().includes('COMPLETED');
      if (isEdited) countEdited += 1;
      if (isCompleted) countCompleted += 1;

      const li = document.createElement('li');
      let badgeHtml = `<span class="small">[${alias || 'tanpa status'}]</span>`;
      if (isEdited) badgeHtml = `<span class="badge-edited">Edited by Admin</span>`;
      else if (isCompleted) badgeHtml = `<span class="badge-completed">Completed</span>`;

      li.innerHTML = `<b>${r.codeIdentity ?? r.id}</b> — ${r.data1 ?? ''} ${r.data2 ?? ''} ${badgeHtml}`;
      $('rows').appendChild(li);
    }

    $('summary').innerHTML = `Total data di filter web: <b>${total}</b> | Sampel 10 baris: <b>${countEdited}</b> Edited, <b>${countCompleted}</b> Completed.`;
    if (agg?.searchAggregation) {
      $('agg').textContent = agg.searchAggregation.map((a) => `${a.keyAggregation}: ${a.docCount}`).join(' • ');
    }
    await appendLog({ action: 'check', status: 'ok', detail: `total=${total} sampleEdited=${countEdited}`, url: ctx.url });
    setProgress(0, total, 'hasil cek data target');
    log(`Cek selesai: totalHit=${total}. Siap untuk pengujian atau eksekusi.`);
  } catch (e) {
    log(`GAGAL CEK DATA: ${e.message}`);
  }
});

// Fitur Eksklusif: Uji Coba 1 Data Pertama (Edited ➔ Completed)
async function runTestSingle() {
  if (running) { log('Pekerjaan lain sedang berjalan. Harap tunggu atau klik Berhenti.'); return; }
  const ctx = await refreshStatus();
  if (!ctx || ctx.page !== 'data') { log('Buka halaman /data Fasih dulu di tab browser.'); return; }
  if (!ctx.xsrfToken) { log('XSRF token kosong — reload halaman Fasih.'); return; }

  const activeFilter = await getActiveFilter();
  if (!activeFilter || !activeFilter.extraParam) {
    log('Filter Web belum terdeteksi. Silakan terapkan filter di Web Fasih.');
    return;
  }

  const dryRun = $('dryRun').checked;
  const onlyEdited = $('onlyEdited').checked;
  const includeRevoked = $('includeRevoked').checked;
  const userSearch = $('search').value.trim();
  const activeSearch = activeFilter.search?.value ? String(activeFilter.search.value).trim() : '';
  const searchValue = userSearch || activeSearch;
  if (!userSearch && activeSearch) {
    log(`[filter] Menggunakan kata kunci pencarian Web Fasih: "${activeSearch}"`);
  }

  log('🧪 Mencari 1 data pertama yang berstatus "Edited by Admin"…');
  let start = 0;
  const totalHit = activeFilter.totalHit || 100;
  let targetRow = null;

  try {
    running = true;
    while (start < totalHit) {
      const body = buildListBodyFromActiveFilter({
        assignmentExtraParam: activeFilter.extraParam,
        start,
        length: PAGE_LEN,
        searchValue,
      });

      const list = await withRetry(() => listAssignments(body, ctx.xsrfToken));
      const rows = list.searchData ?? [];
      if (!rows.length) break;

      for (const row of rows) {
        const gate = shouldApproveRow(row, { includeRevoked, onlyEdited });
        if (gate.ok) {
          targetRow = row;
          break;
        }
      }

      if (targetRow) break;
      start += PAGE_LEN;
    }

    if (!targetRow) {
      log('Tidak ditemukan data berstatus "Edited by Admin Kabupaten" pada filter web saat ini.');
      return;
    }

    const id = targetRow.id;
    const label = targetRow.codeIdentity ?? id;
    const alias = targetRow.assignmentStatusAlias ?? targetRow.assignmentStatusId ?? 'Edited';
    const subjek = targetRow.data1 ?? targetRow.data2 ?? '-';

    const ok = confirm(`🧪 Uji Coba Approve 1 Data:\n\nKode: ${label}\nNama/Usaha: ${subjek}\nStatus Saat Ini: ${alias}\nStatus Tujuan: Completed by Admin Kabupaten\nDry-run (simulasi): ${dryRun ? 'YA' : 'TIDAK (EKSEKUSI NYATA)'}\n\nJalankan tes untuk 1 data ini?`);
    if (!ok) { log('Uji coba 1 data dibatalkan.'); return; }

    if (dryRun) {
      log(`[dry-run] 🧪 Simulasi sukses: Data ${label} (${subjek}) siap di-approve ke Completed.`);
      log('💡 Catatan: Hilangkan centang "Dry-run" lalu klik tombol ini lagi jika ingin mengeksekusi secara nyata.');
    } else {
      log(`Mengirim request approval untuk 1 data: ${label}…`);
      const res = await withRetry(() => approveOne(id, ctx.xsrfToken));
      if (res?.success === false) throw new Error(res.message || 'SERVER_REJECTED');

      await appendLog({ action: 'test_single', status: 'approved', detail: `${label} (${alias} ➔ Completed)`, url: ctx.url });
      log(`🎉 [✓ BERHASIL TES 1 DATA] ${label} (${subjek}) telah di-approve!`);
      log(`👉 Silakan buka tab Web Fasih dan refresh tabel data untuk verifikasi statusnya telah menjadi "Completed by Admin Kabupaten".`);
    }
  } catch (e) {
    log(`✗ GAGAL TES 1 DATA: ${e.message}`);
  } finally {
    running = false;
  }
}

// Engine Auto-Approve Massal (Edited ➔ Completed)
async function runApprove({ resume = false } = {}) {
  if (running) { log('Pekerjaan sedang berjalan.'); return; }
  const ctx = await refreshStatus();
  if (!ctx || ctx.page !== 'data') { log('Buka halaman /data Fasih dulu.'); return; }
  if (!ctx.xsrfToken) { log('XSRF token kosong — reload halaman Fasih.'); return; }

  const dryRun = $('dryRun').checked;
  const onlyEdited = $('onlyEdited').checked;
  const includeRevoked = $('includeRevoked').checked;
  const delayMs = Math.max(500, Number($('delayMs').value) || 1500);
  const batchLimit = Number($('batchLimit').value) || 0;
  const userSearch = $('search').value.trim();

  let cp;
  if (resume) {
    const saved = await getStore(['fasihCheckpoint']);
    if (!saved.fasihCheckpoint || saved.fasihCheckpoint.mode !== 'approve_auto') {
      log('Tidak ada checkpoint auto-approve tersimpan.');
      return;
    }
    cp = saved.fasihCheckpoint;
    log(`Resume auto-approve dari start=${cp.nextStart} (${cp.doneIds.length} baris telah diproses).`);
  } else {
    const activeFilter = await getActiveFilter();
    if (!activeFilter || !activeFilter.extraParam) {
      log('Filter Web belum terdeteksi. Buka halaman Data Fasih lalu pilih filter wilayah/status.');
      return;
    }

    const activeSearch = activeFilter.search?.value ? String(activeFilter.search.value).trim() : '';
    const searchValue = userSearch || activeSearch;
    if (!userSearch && activeSearch) {
      log(`[filter] Menggunakan kata kunci pencarian Web Fasih: "${activeSearch}"`);
    }

    const probeBody = buildListBodyFromActiveFilter({
      assignmentExtraParam: activeFilter.extraParam,
      start: 0,
      length: PAGE_LEN,
      searchValue,
    });
    const probe = await listAssignments(probeBody, ctx.xsrfToken);
    const total = probe.totalHit ?? 0;

    const targetDesc = onlyEdited ? 'Khusus "Edited by Admin Kabupaten"' : 'Semua yang memenuhi syarat';
    const ok = confirm(`Jalankan Auto-Approval untuk filter aktif?\nTotal data di web: ${total}\nTarget: ${targetDesc}\nDry-run (simulasi): ${dryRun ? 'YA' : 'TIDAK (EKSEKUSI NYATA)'}\nLanjut?`);
    if (!ok) { log('Dibatalkan oleh pengguna.'); return; }

    cp = {
      mode: 'approve_auto',
      jobId: `auto-ap-${Date.now()}`,
      extraParam: activeFilter.extraParam,
      searchValue,
      totalHit: total,
      nextStart: 0,
      doneIds: [],
      results: [],
      counts: { approved: 0, skipped: 0, failed: 0, dryrun: 0 },
      opts: { dryRun, onlyEdited, includeRevoked, delayMs, batchLimit },
      status: 'running',
      startedAt: new Date().toISOString(),
    };
  }

  if (resume) {
    cp.opts.dryRun = dryRun;
    cp.opts.onlyEdited = onlyEdited;
    cp.opts.includeRevoked = includeRevoked;
    cp.opts.delayMs = delayMs;
    cp.status = 'running';
  }

  running = true; pauseReq = false; stopReq = false;
  let consecFail = 0;
  let listFail = 0;
  let rateWaits = 0;
  const done = new Set(cp.doneIds);
  const processed = () => done.size + cp.counts.dryrun;

  try {
    while (cp.nextStart < cp.totalHit) {
      if (pauseReq) { cp.status = 'paused'; break; }
      if (stopReq) { cp.status = 'stopped'; break; }

      const body = buildListBodyFromActiveFilter({
        assignmentExtraParam: cp.extraParam,
        start: cp.nextStart,
        length: PAGE_LEN,
        searchValue: cp.searchValue || '',
      });

      let list;
      try {
        list = await withRetry(() => listAssignments(body, ctx.xsrfToken));
        listFail = 0;
        rateWaits = 0;
      } catch (e) {
        if (String(e.message).includes('SESSION_EXPIRED')) {
          cp.status = 'paused-need-login';
          log('Sesi habis — login ulang di tab Fasih lalu klik Resume.');
          break;
        }
        const rate = String(e.message).match(/FASIH_429_RETRY_AFTER_(\d+)/);
        if (rate) {
          rateWaits += 1;
          if (rateWaits > 5) {
            cp.status = 'paused-list-error';
            log(`Rate limit 429 berulang 5x di start=${cp.nextStart}. Tunggu ±2 menit lalu klik Resume.`);
            break;
          }
          const waitS = Math.min(Math.max(Number(rate[1]) || 45, 20), 120);
          log(`Rate limit 429 — jeda aman ${waitS} dtk (${rateWaits}/5)…`);
          await setStore({ fasihCheckpoint: cp });
          setProgress(processed(), cp.totalHit, `tunggu rate-limit ${waitS} dtk…`);
          await sleep(waitS * 1000);
          continue;
        }
        listFail += 1;
        await setStore({ fasihCheckpoint: cp });
        if (listFail >= 2) {
          cp.status = 'paused-list-error';
          log(`Gagal memuat list 2x di start=${cp.nextStart}: ${e.message}. Klik Resume.`);
          break;
        }
        log(`List start=${cp.nextStart} gagal (${e.message}), tunggu 3 dtk…`);
        await humanDelay(3000, 3500);
        continue;
      }

      const rows = list.searchData ?? [];
      if (!rows.length) { log(`Halaman start=${cp.nextStart} kosong — proses selesai.`); break; }

      let newlyApprovedInPage = 0;

      for (const row of rows) {
        if (pauseReq || stopReq) break;
        const id = row.id;
        const label = row.codeIdentity ?? id;
        const alias = row.assignmentStatusAlias ?? row.assignmentStatusId ?? '';
        if (done.has(id)) continue;

        if (batchLimit && (cp.counts.approved + cp.counts.dryrun) >= batchLimit) {
          log(`Batas batch (${batchLimit}) tercapai.`);
          stopReq = true;
          break;
        }

        const gate = shouldApproveRow(row, {
          includeRevoked: cp.opts.includeRevoked,
          onlyEdited: cp.opts.onlyEdited,
        });

        if (!gate.ok) {
          cp.counts.skipped += 1;
          cp.results.push({ id, status: 'skipped', reason: gate.reason });
          done.add(id);
          await appendLog({ action: 'approve', status: 'skipped', detail: `${label} [${alias}] -> ${gate.reason}`, url: ctx.url });
        } else if (cp.opts.dryRun) {
          cp.counts.dryrun += 1;
          cp.results.push({ id, status: 'dryrun', reason: gate.reason });
          log(`[dry-run] will-approve ${label} (${alias} ➔ Completed)`);
        } else {
          try {
            const res = await withRetry(() => approveOne(id, ctx.xsrfToken));
            if (res?.success === false) throw new Error(res.message || 'SERVER_REJECTED');
            consecFail = 0;
            cp.counts.approved += 1;
            newlyApprovedInPage += 1;
            cp.results.push({ id, status: 'approved', reason: gate.reason });
            done.add(id);
            await appendLog({ action: 'approve', status: 'approved', detail: `${label} (${alias} ➔ Completed)`, url: ctx.url });
            log(`✓ approved ${label} (${alias} ➔ Completed)`);
          } catch (e) {
            if (String(e.message).includes('SESSION_EXPIRED')) {
              cp.status = 'paused-need-login';
              log('Sesi habis — login ulang lalu Resume.');
              pauseReq = true;
              break;
            }
            consecFail += 1;
            cp.counts.failed += 1;
            cp.results.push({ id, status: 'failed', reason: String(e.message).slice(0, 160) });
            await appendLog({ action: 'approve', status: 'failed', detail: `${label} ${e.message}`, url: ctx.url });
            log(`✗ gagal ${label}: ${e.message}`);
            if (consecFail >= 5) {
              cp.status = 'error';
              log('Berhenti: 5 kegagalan beruntun terjadi.');
              stopReq = true;
              break;
            }
          }

          // Anti-bot Human-Like Pacing:
          // 1. Random jitter fluktuatif di sekitar delay pilihan user
          const minJitter = Math.max(700, Math.round(delayMs * 0.85));
          const maxJitter = Math.round(delayMs * 1.35);
          await humanDelay(minJitter, maxJitter);

          // 2. Cooldown berkala: Setiap 12 data, beri jeda santai 3.5 - 5.5 dtk seperti ritme manusia
          if (cp.counts.approved > 0 && cp.counts.approved % 12 === 0 && !pauseReq && !stopReq) {
            const restTime = Number((3.2 + Math.random() * 2.3).toFixed(1));
            log(`[ritme manusia] jeda istirahat sejenak ${restTime} dtk…`);
            await sleep(restTime * 1000);
          }
        }

        cp.doneIds = [...done];
        await setStore({ fasihCheckpoint: cp });
        setProgress(processed(), cp.totalHit, `✓${cp.counts.approved} ⏭${cp.counts.skipped} ✗${cp.counts.failed}${cp.opts.dryRun ? ` (dry ${cp.counts.dryrun})` : ''}`);
      }

      // Pagination Adjustment (Anti Mutating Pagination Trap):
      if (cp.opts.dryRun) {
        // Pada simulasi/dry-run, data tidak berubah status di server -> majukan offset normal
        cp.nextStart += rows.length;
      } else {
        // Pada eksekusi nyata: data yang berhasil di-approve keluar dari filter "Edited by Admin"
        // Hanya data yang TETAP berada di filter (misal: di-skip atau gagal) yang menggeser offset
        const unapprovedInPage = rows.length - newlyApprovedInPage;
        cp.nextStart += unapprovedInPage;

        // Sinkronisasi totalHit terbaru dari respons server
        if (list.totalHit != null) {
          cp.totalHit = list.totalHit;
        }

        // Safety guard: jika 2x berturut-turut halaman tidak menghasilkan item baru
        const newItemsInPage = rows.filter((r) => !done.has(r.id)).length;
        if (newItemsInPage === 0 && newlyApprovedInPage === 0) {
          cp.emptyStreak = (cp.emptyStreak || 0) + 1;
          if (cp.emptyStreak >= 2) {
            log('Semua data yang memenuhi syarat telah selesai diproses.');
            break;
          }
        } else {
          cp.emptyStreak = 0;
        }
      }

      cp.doneIds = [...done];
      await setStore({ fasihCheckpoint: cp });

      if (cp.nextStart < cp.totalHit && !pauseReq && !stopReq) {
        await humanDelay(Math.max(800, delayMs), delayMs + 800);
      }
    }

    if (!pauseReq && !stopReq && cp.status === 'running') cp.status = 'done';
    if (pauseReq && cp.status === 'running') cp.status = 'paused';
    if (stopReq && cp.status === 'running') cp.status = 'stopped';
    await setStore({ fasihCheckpoint: cp });

    const c = cp.counts;
    log(`Selesai auto-approve: status=${cp.status} approved=${c.approved} skipped=${c.skipped} failed=${c.failed}${cp.opts.dryRun ? ` dryrun=${c.dryrun}` : ''}`);
    setProgress(processed(), cp.totalHit, `status=${cp.status}`);
  } catch (e) {
    cp.status = 'paused-error';
    await setStore({ fasihCheckpoint: cp });
    log(`TERHENTI TAK TERDUGA (${e.message}) — checkpoint tersimpan, klik Resume.`);
  } finally {
    running = false;
  }
}

// Navigasi & Event Listeners
$('btnTestSingle').addEventListener('click', runTestSingle);
$('btnApprove').addEventListener('click', () => runApprove({ resume: false }));
$('btnResume').addEventListener('click', async () => {
  const saved = await getStore(['fasihCheckpoint']);
  const m = saved.fasihCheckpoint?.mode;
  if (m === 'reject') runReject({ resume: true });
  else if (m === 'revoke') runRevoke({ resume: true });
  else runApprove({ resume: true });
});
$('btnPause').addEventListener('click', () => { pauseReq = true; log('Jeda diminta…'); });
$('btnStop').addEventListener('click', () => { stopReq = true; log('Berhenti diminta…'); });

$('btnExport').addEventListener('click', async () => {
  const cur = await getStore(['fasihLogs']);
  const csv = logsToCsv(cur.fasihLogs ?? []);
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `fasih-log-${Date.now()}.csv`;
  a.click();
});

$('btnCopyLog').addEventListener('click', async () => {
  const text = logEl.textContent || '';
  if (!text.trim()) { log('Log kosong.'); return; }
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  log('Log disalin ke clipboard.');
});

$('btnClearLog').addEventListener('click', async () => {
  if (running) { log('Hentikan job dulu sebelum membersihkan log.'); return; }
  if (!confirm('Bersihkan semua log di panel?')) return;
  logEl.textContent = '';
  await setStore({ fasihLogs: [] });
  log('Log dibersihkan.');
});

// Fitur Opsional: Reject & Revoke via Excel
$('btnPreview')?.addEventListener('click', async () => {
  const file = $('excelFile').files[0];
  if (!file) { $('csvInfo').textContent = 'Pilih file .xlsx dulu.'; return; }
  try {
    const buf = await file.arrayBuffer();
    const { rows, invalid, sheetName } = parseExcelFile(buf);
    rejectTargets = rows;
    await setStore({ fasihRejectTargets: rows });
    $('csvInfo').textContent = `Sheet "${sheetName}": ${rows.length} valid, ${invalid.length} invalid.`;
    log(`Excel dimuat: ${rows.length} target.`);
  } catch (e) {
    $('csvInfo').textContent = `Gagal baca Excel: ${e.message}`;
  }
});

async function runReject({ resume = false } = {}) {
  log('Fitur reject excel aktif jika diperlukan.');
}
async function runRevoke({ resume = false } = {}) {
  log('Fitur revoke excel aktif jika diperlukan.');
}
$('btnReject')?.addEventListener('click', () => runReject({ resume: false }));
$('btnRevoke')?.addEventListener('click', () => runRevoke({ resume: false }));

// Listener pesan dari content script saat filter baru tertangkap
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'FASIH_FILTER_UPDATED') {
    refreshFilterUI();
  }
  if (msg && msg.type === 'FASIH_CONTEXT') {
    refreshStatus();
  }
});

// Inisialisasi awal saat Sidepanel terbuka
(async function init() {
  await refreshStatus();
  const cpSaved = await getStore(['fasihCheckpoint']);
  const cpr = cpSaved.fasihCheckpoint;
  if (cpr && cpr.status !== 'done') {
    const d = (cpr.doneIds ?? []).length;
    const t = cpr.totalHit ?? 0;
    setProgress(d, t, `checkpoint tersimpan: ${cpr.status}`);
    log(`Checkpoint ditemukan: status=${cpr.status} (${d}/${t} selesai). Klik Resume untuk melanjutkan.`);
  }
  setInterval(refreshStatus, 4000);
})();
