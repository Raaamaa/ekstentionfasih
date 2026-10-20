// Side panel M2 — read-only (M1) + approve-all XHR dengan checkpoint/resume.
import { resolveChainFromL6, buildListBody, listAssignments, getAggregation, pageToStart, approveOne, rejectOne, revokeOne, shouldApproveRow, shouldRejectRow, shouldRevokeRow, humanDelay, withRetry, sleep } from '../lib/fasih-api.js';
import { parseExcelFile } from '../lib/sheet.js';
import { getStore, setStore, appendLog, logsToCsv, ts } from '../lib/store.js';

const $ = (id) => document.getElementById(id);
const logEl = $('log');
const PAGE_LEN = 10;
let pauseReq = false;
let stopReq = false;
let running = false;

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
    $('ctx').textContent = `detail ${ctx.assignmentId ?? ''} — kembali ke halaman Data untuk list.`;
  } else {
    pill.textContent = '● belum terhubung';
    pill.className = 'pill off';
    $('ctx').textContent = 'Buka halaman Data Fasih di tab aktif.';
  }
  return ctx;
}

function readFilterForm() {
  return {
    groupId: $('groupId').value.trim(),
    l6: $('l6').value.trim(),
    searchValue: $('search').value.trim(),
  };
}

async function ensureResolved(ctx) {
  const saved = await getStore(['fasihLastFilter']);
  const form = readFilterForm();
  if (saved.fasihLastFilter && saved.fasihLastFilter.fullCodes?.l6 === form.l6 && saved.fasihLastFilter.groupId === form.groupId && saved.fasihLastFilter.surveyPeriodId === ctx.surveyPeriodId) {
    return saved.fasihLastFilter;
  }
  if (!form.groupId || !form.l6) throw new Error('FILTER_LEVEL6_REQUIRED: isi Group ID + kode L6');
  log(`kenali L1→L5 dari L6 ${form.l6} …`);
  const { ids, fullCodes } = await resolveChainFromL6({ groupId: form.groupId, l6: form.l6, xsrf: ctx.xsrfToken });
  log(`terpecah: ${fullCodes.l1} → ${fullCodes.l2} → ${fullCodes.l3} → ${fullCodes.l4} → ${fullCodes.l5} → ${fullCodes.l6}`);
  const filter = { groupId: form.groupId, fullCodes, regionIds: ids, surveyPeriodId: ctx.surveyPeriodId };
  await setStore({ fasihLastFilter: filter });
  return filter;
}

$('btnResolve').addEventListener('click', async () => {
  try {
    const ctx = await refreshStatus();
    if (!ctx || ctx.page !== 'data') { log('Buka halaman /data dulu.'); return; }
    if (!ctx.xsrfToken) { log('XSRF token kosong — reload halaman Fasih.'); return; }
    const filter = await ensureResolved(ctx);
    const form = readFilterForm();
    const body = buildListBody({ regionIds: filter.regionIds, surveyPeriodId: ctx.surveyPeriodId, start: pageToStart(1, PAGE_LEN), length: PAGE_LEN, searchValue: form.searchValue });
    const [list, agg] = await Promise.all([
      listAssignments(body, ctx.xsrfToken),
      getAggregation(body, ctx.xsrfToken).catch(() => null),
    ]);
    const total = list.totalHit ?? list.searchData?.length ?? 0;
    $('summary').textContent = `totalHit=${total} | halaman ini=${(list.searchData ?? []).length} | search="${form.searchValue || '-'}"`;
    $('rows').innerHTML = '';
    for (const r of (list.searchData ?? []).slice(0, 10)) {
      const li = document.createElement('li');
      li.textContent = `${r.codeIdentity ?? r.id} — ${r.data1 ?? ''} ${r.data2 ?? ''} [${r.assignmentStatusAlias ?? r.assignmentStatusId ?? ''}]`;
      $('rows').appendChild(li);
    }
    if (agg?.searchAggregation) {
      $('agg').textContent = agg.searchAggregation.map((a) => `${a.keyAggregation}: ${a.docCount}`).join(' • ');
    }
    await appendLog({ action: 'list', status: 'ok', detail: `totalHit=${total} l6=${filter.fullCodes.l6}`, url: ctx.url });
    setProgress(0, total, 'hasil list pertama');
    log('OK — angka di atas harus sama dengan tabel Fasih.');
  } catch (e) {
    log(`GAGAL: ${e.message}`);
  }
});

async function runApprove({ resume = false } = {}) {
  if (running) { log('Job sudah berjalan.'); return; }
  const ctx = await refreshStatus();
  if (!ctx || ctx.page !== 'data') { log('Buka halaman /data dulu.'); return; }
  if (!ctx.xsrfToken) { log('XSRF token kosong — reload halaman Fasih.'); return; }

  const dryRun = $('dryRun').checked;
  const includeRevoked = $('includeRevoked').checked;
  const delayMs = Math.max(300, Number($('delayMs').value) || 1200);
  const batchLimit = Number($('batchLimit').value) || 0;

  let cp;
  if (resume) {
    const saved = await getStore(['fasihCheckpoint']);
    if (!saved.fasihCheckpoint || saved.fasihCheckpoint.mode !== 'approve') { log('Tidak ada checkpoint approve.'); return; }
    cp = saved.fasihCheckpoint;
    log(`Resume dari start=${cp.nextStart} (${cp.doneIds.length} sudah diproses).`);
  } else {
    const filter = await ensureResolved(ctx);
    const form = readFilterForm();
    const probe = await listAssignments(buildListBody({ regionIds: filter.regionIds, surveyPeriodId: ctx.surveyPeriodId, start: 0, length: PAGE_LEN, searchValue: form.searchValue }), ctx.xsrfToken);
    const total = probe.totalHit ?? 0;
    const ok = confirm(`Approve ${total} baris di SubSLS ${filter.fullCodes.l6}?\nDry-run: ${dryRun ? 'YA' : 'TIDAK (EKSEKUSI NYATA)'}\nTermasuk REVOKED: ${includeRevoked ? 'YA' : 'TIDAK'}\nLanjut?`);
    if (!ok) { log('Dibatalkan pengguna.'); return; }
    cp = { mode: 'approve', jobId: `ap-${Date.now()}`, filter, searchValue: form.searchValue, xsrfSnapshot: false, totalHit: total, nextStart: 0, doneIds: [], results: [], counts: { approved: 0, skipped: 0, failed: 0, dryrun: 0 }, opts: { dryRun, includeRevoked, delayMs, batchLimit }, status: 'running', startedAt: new Date().toISOString() };
  }
  // Terapkan opsi terbaru untuk dry-run/delay bila resume
  if (resume) { cp.opts.dryRun = dryRun; cp.opts.includeRevoked = includeRevoked; cp.opts.delayMs = delayMs; cp.status = 'running'; }

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
      const body = buildListBody({ regionIds: cp.filter.regionIds, surveyPeriodId: cp.filter.surveyPeriodId, start: cp.nextStart, length: PAGE_LEN, searchValue: cp.searchValue || '' });
      let list;
      try {
        list = await withRetry(() => listAssignments(body, ctx.xsrfToken));
        listFail = 0;
        rateWaits = 0;
      } catch (e) {
        if (String(e.message).includes('SESSION_EXPIRED')) { cp.status = 'paused-need-login'; log('Sesi habis — login ulang lalu Resume.'); break; }
        const rate = String(e.message).match(/FASIH_429_RETRY_AFTER_(\d+)/);
        if (rate) {
          // withRetry sudah menunggu sekali; di sini tunggu tambahan lalu ulangi start yang sama
          rateWaits += 1;
          if (rateWaits > 5) {
            cp.status = 'paused-list-error';
            log(`Rate limit 429 berulang 5x di start=${cp.nextStart}. Tunggu ±2 menit lalu klik Resume.`);
            break;
          }
          const waitS = Math.min(Math.max(Number(rate[1]) || 45, 20), 120);
          log(`Rate limit 429 — tunggu ${waitS} dtk (${rateWaits}/5), lalu lanjut start=${cp.nextStart}…`);
          await setStore({ fasihCheckpoint: cp });
          setProgress(processed(), cp.totalHit, `tunggu rate-limit ${waitS} dtk…`);
          await sleep(waitS * 1000);
          continue;
        }
        listFail += 1;
        await setStore({ fasihCheckpoint: cp });
        if (listFail >= 2) {
          cp.status = 'paused-list-error';
          log(`Gagal list 2x beruntun di start=${cp.nextStart}: ${e.message}. Checkpoint tersimpan — klik Resume untuk lanjut.`);
          break;
        }
        log(`List start=${cp.nextStart} gagal (${e.message}), tunggu 3 dtk lalu coba lagi…`);
        await humanDelay(3000, 3500);
        continue; // ulangi start yang sama tanpa maju
      }
      const rows = list.searchData ?? [];
      if (!rows.length) { log(`List start=${cp.nextStart} kosong — dianggap selesai.`); break; }
      for (const row of rows) {
        if (pauseReq || stopReq) break;
        const id = row.id;
        const label = row.codeIdentity ?? id;
        if (done.has(id)) continue;
        if (batchLimit && (cp.counts.approved + cp.counts.dryrun) >= batchLimit) { log(`Batas batch ${batchLimit} tercapai.`); stopReq = true; break; }
        const gate = shouldApproveRow(row, { includeRevoked: cp.opts.includeRevoked });
        if (!gate.ok) {
          cp.counts.skipped += 1;
          cp.results.push({ id, status: 'skipped', reason: gate.reason });
          done.add(id);
          await appendLog({ action: 'approve', status: 'skipped', detail: `${label} ${gate.reason}`, url: ctx.url });
        } else if (cp.opts.dryRun) {
          cp.counts.dryrun += 1;
          cp.results.push({ id, status: 'dryrun', reason: gate.reason });
          // dry-run tidak ditandai done agar run nyata memproses ulang
          log(`[dry-run] would-approve ${label}`);
        } else {
          try {
            const res = await withRetry(() => approveOne(id, ctx.xsrfToken));
            if (res?.success === false) throw new Error(res.message || 'SERVER_REJECTED');
            consecFail = 0;
            cp.counts.approved += 1;
            cp.results.push({ id, status: 'approved', reason: gate.reason });
            done.add(id);
            await appendLog({ action: 'approve', status: 'approved', detail: label, url: ctx.url });
            log(`✓ approved ${label}`);
          } catch (e) {
            if (String(e.message).includes('SESSION_EXPIRED')) { cp.status = 'paused-need-login'; log('Sesi habis — login ulang lalu Resume.'); pauseReq = true; break; }
            consecFail += 1;
            cp.counts.failed += 1;
            cp.results.push({ id, status: 'failed', reason: String(e.message).slice(0, 160) });
            await appendLog({ action: 'approve', status: 'failed', detail: `${label} ${e.message}`, url: ctx.url });
            log(`✗ gagal ${label}: ${e.message}`);
            if (consecFail >= 5) { cp.status = 'error'; log('Stop: 5 gagal beruntun.'); stopReq = true; break; }
          }
          await humanDelay(delayMs - 300 > 300 ? delayMs - 300 : 300, delayMs + 600);
        }
        cp.doneIds = [...done];
        await setStore({ fasihCheckpoint: cp });
        setProgress(processed(), cp.totalHit, `✓${cp.counts.approved} ⏭${cp.counts.skipped} ✗${cp.counts.failed}${cp.opts.dryRun ? ` (dry ${cp.counts.dryrun})` : ''}`);
      }
      cp.nextStart += PAGE_LEN;
      cp.doneIds = [...done];
      await setStore({ fasihCheckpoint: cp });
      // Pacing antar-halaman: tanpa ini, 22 list request bertubi-tubi → 429.
      if (cp.nextStart < cp.totalHit && !pauseReq && !stopReq) {
        await humanDelay(Math.max(800, delayMs), delayMs + 800);
      }
    }
    if (!pauseReq && !stopReq && cp.status === 'running') cp.status = 'done';
    if (pauseReq && cp.status === 'running') cp.status = 'paused';
    if (stopReq && cp.status === 'running') cp.status = 'stopped';
    await setStore({ fasihCheckpoint: cp });
    const c = cp.counts;
    log(`Selesai: status=${cp.status} approved=${c.approved} skipped=${c.skipped} failed=${c.failed}${cp.opts.dryRun ? ` dryrun=${c.dryrun}` : ''}`);
    setProgress(processed(), cp.totalHit, `status=${cp.status}`);
  } catch (e) {
    cp.status = 'paused-error';
    await setStore({ fasihCheckpoint: cp });
    log(`TERHENTI TAK TERDUGA (${e.message}) — checkpoint tersimpan di start=${cp.nextStart}, klik Resume.`);
  } finally {
    running = false;
  }
}

// Engine M3 — reject per target Excel: resolve L6 → list search → tepat 1 → rejectOne.
async function runReject({ resume = false } = {}) {
  if (running) { log('Job sudah berjalan.'); return; }
  const ctx = await refreshStatus();
  if (!ctx || ctx.page !== 'data') { log('Buka halaman /data dulu.'); return; }
  if (!ctx.xsrfToken) { log('XSRF token kosong — reload halaman Fasih.'); return; }

  const dryRun = $('dryRunReject').checked;
  $('dryRun').checked = dryRun; // cerminkan ke opsi §4
  const includeRevoked = $('includeRevoked').checked;
  const delayMs = Math.max(300, Number($('delayMs').value) || 1200);
  const batchLimit = Number($('batchLimit').value) || 0;

  let cp;
  if (resume) {
    const saved = await getStore(['fasihCheckpoint']);
    if (!saved.fasihCheckpoint || saved.fasihCheckpoint.mode !== 'reject') { log('Tidak ada checkpoint reject.'); return; }
    cp = saved.fasihCheckpoint;
    log(`Resume reject: ${cp.doneKeys.length}/${cp.targets.length} target sudah diproses.`);
  } else {
    const stored = await getStore(['fasihRejectTargets']);
    const targets = stored.fasihRejectTargets ?? rejectTargets;
    if (!targets.length) { log('Muat Excel dulu (§3 Pratinjau).'); return; }
    const groupId = $('groupId').value.trim();
    if (!groupId) { log('Isi Group ID.'); return; }
    const ok = confirm(`Reject ${targets.length} target dari Excel?\nDry-run: ${dryRun ? 'YA' : 'TIDAK (EKSEKUSI NYATA)'}\nLanjut?`);
    if (!ok) { log('Dibatalkan pengguna.'); return; }
    cp = { mode: 'reject', jobId: `rj-${Date.now()}`, groupId, surveyPeriodId: ctx.surveyPeriodId, targets, nextIndex: 0, doneKeys: [], results: [], regionCache: {}, counts: { rejected: 0, skipped: 0, failed: 0, dryrun: 0, notFound: 0, ambiguous: 0 }, opts: { dryRun, includeRevoked, delayMs, batchLimit }, status: 'running', startedAt: new Date().toISOString() };
  }
  if (resume) { cp.opts.dryRun = dryRun; cp.opts.includeRevoked = includeRevoked; cp.opts.delayMs = delayMs; cp.status = 'running'; }

  running = true; pauseReq = false; stopReq = false;
  let consecFail = 0;
  let listFail = 0;
  let rateWaits = 0;
  const done = new Set(cp.doneKeys);
  const processed = () => done.size + cp.counts.dryrun;
  const keyOf = (t) => `${t.kode_level6}||${t.keyword_nama.toLowerCase()}`;
  const summary = () => `✓${cp.counts.rejected} ⏭${cp.counts.skipped} ✗${cp.counts.failed}${cp.opts.dryRun ? ` (dry ${cp.counts.dryrun})` : ''}`;
  try {
    while (cp.nextIndex < cp.targets.length) {
      if (pauseReq) { cp.status = 'paused'; break; }
      if (stopReq) { cp.status = 'stopped'; break; }
      const t = cp.targets[cp.nextIndex];
      const key = keyOf(t);
      if (done.has(key)) { cp.nextIndex += 1; continue; }
      if (batchLimit && (cp.counts.rejected + cp.counts.dryrun) >= batchLimit) { log(`Batas batch ${batchLimit} tercapai.`); stopReq = true; break; }

      // 1. resolve region kode ini (cache per kode unik)
      let reg = cp.regionCache[t.kode_level6];
      if (!reg) {
        try {
          const r = await resolveChainFromL6({ groupId: cp.groupId, l6: t.kode_level6, xsrf: ctx.xsrfToken });
          reg = { regionIds: r.ids };
          cp.regionCache[t.kode_level6] = reg;
        } catch (e) {
          cp.counts.failed += 1;
          cp.results.push({ key, status: 'failed', reason: `REGION: ${e.message}`.slice(0, 160) });
          done.add(key);
          cp.nextIndex += 1; cp.doneKeys = [...done];
          await appendLog({ action: 'reject', status: 'failed', detail: `${t.kode_level6} ${t.keyword_nama} REGION_FAIL`, url: ctx.url });
          await setStore({ fasihCheckpoint: cp });
          log(`✗ region gagal ${t.kode_level6}: ${e.message}`);
          setProgress(processed(), cp.targets.length, summary());
          continue;
        }
      }

      // 2. list dengan filter L6 + search nama
      const body = buildListBody({ regionIds: reg.regionIds, surveyPeriodId: cp.surveyPeriodId, start: 0, length: 10, searchValue: t.keyword_nama });
      let list;
      try {
        list = await withRetry(() => listAssignments(body, ctx.xsrfToken));
        listFail = 0;
        rateWaits = 0;
      } catch (e) {
        if (String(e.message).includes('SESSION_EXPIRED')) { cp.status = 'paused-need-login'; log('Sesi habis — login ulang lalu Resume.'); break; }
        const rate = String(e.message).match(/FASIH_429_RETRY_AFTER_(\d+)/);
        if (rate) {
          rateWaits += 1;
          if (rateWaits > 5) { cp.status = 'paused-list-error'; log('Rate limit 429 berulang 5x. Tunggu ±2 menit lalu Resume.'); break; }
          const waitS = Math.min(Math.max(Number(rate[1]) || 45, 20), 120);
          log(`Rate limit 429 — tunggu ${waitS} dtk (${rateWaits}/5)…`);
          await setStore({ fasihCheckpoint: cp });
          setProgress(processed(), cp.targets.length, `tunggu rate-limit ${waitS} dtk…`);
          await sleep(waitS * 1000);
          continue;
        }
        listFail += 1;
        if (listFail >= 2) { cp.status = 'paused-list-error'; log(`Gagal list 2x beruntun: ${e.message}. Klik Resume.`); break; }
        log(`List gagal (${e.message}), tunggu 3 dtk…`);
        await humanDelay(3000, 3500);
        continue;
      }

      const finish = async (status, reason, line) => {
        if (status === 'rejected') cp.counts.rejected += 1;
        else if (status === 'dryrun') cp.counts.dryrun += 1;
        else if (status === 'failed') cp.counts.failed += 1;
        else { cp.counts.skipped += 1; if (reason === 'NOT_FOUND') cp.counts.notFound += 1; if (reason === 'AMBIGUOUS') cp.counts.ambiguous += 1; }
        cp.results.push({ key, status, reason });
        if (status !== 'dryrun') done.add(key);
        cp.nextIndex += 1; cp.doneKeys = [...done];
        await appendLog({ action: 'reject', status, detail: `${t.kode_level6} ${t.keyword_nama} ${reason}`, url: ctx.url });
        if (line) log(line);
        setProgress(processed(), cp.targets.length, summary());
        await setStore({ fasihCheckpoint: cp });
      };

      const total = list.totalHit ?? (list.searchData ?? []).length;
      if (total === 0) {
        await finish('skipped', 'NOT_FOUND', `⏭ not_found: ${t.keyword_nama}`);
      } else if (total > 1) {
        await finish('skipped', 'AMBIGUOUS', `⏭ ambiguous (${total} cocok): ${t.keyword_nama}`);
      } else {
        const row = list.searchData[0];
        const gate = shouldRejectRow(row, { includeRevoked: cp.opts.includeRevoked });
        const label = row.codeIdentity ?? row.id;
        if (!gate.ok) {
          await finish('skipped', gate.reason, `⏭ skip ${label}: ${gate.reason}`);
        } else if (cp.opts.dryRun) {
          await finish('dryrun', gate.reason, `[dry-run] would-reject ${label} (${t.keyword_nama})`);
        } else {
          try {
            const res = await withRetry(() => rejectOne(row.id, ctx.xsrfToken));
            if (res?.success === false) throw new Error(res.message || 'SERVER_REJECTED');
            consecFail = 0;
            await finish('rejected', gate.reason, `✓ rejected ${label}`);
          } catch (e) {
            if (String(e.message).includes('SESSION_EXPIRED')) { cp.status = 'paused-need-login'; log('Sesi habis — login ulang lalu Resume.'); pauseReq = true; break; }
            consecFail += 1;
            await finish('failed', String(e.message).slice(0, 160), `✗ gagal ${label}: ${e.message}`);
            if (consecFail >= 5) { cp.status = 'error'; log('Stop: 5 gagal beruntun.'); stopReq = true; break; }
          }
        }
      }
      if (!pauseReq && !stopReq && cp.nextIndex < cp.targets.length) {
        await humanDelay(Math.max(800, delayMs), delayMs + 800);
      }
    }
    if (!pauseReq && !stopReq && cp.status === 'running') cp.status = 'done';
    if (pauseReq && cp.status === 'running') cp.status = 'paused';
    if (stopReq && cp.status === 'running') cp.status = 'stopped';
    await setStore({ fasihCheckpoint: cp });
    const c = cp.counts;
    log(`Selesai reject: status=${cp.status} rejected=${c.rejected} skipped=${c.skipped} (not_found=${c.notFound}, ambiguous=${c.ambiguous}) failed=${c.failed}${cp.opts.dryRun ? ` dryrun=${c.dryrun}` : ''}`);
    setProgress(processed(), cp.targets.length, `status=${cp.status}`);
  } catch (e) {
    cp.status = 'paused-error';
    await setStore({ fasihCheckpoint: cp });
    log(`TERHENTI TAK TERDUGA (${e.message}) — klik Resume.`);
  } finally {
    running = false;
  }
}

// Engine M4 — revoke per target Excel: sama seperti reject, tapi gate APPROVED + revokeOne.
async function runRevoke({ resume = false } = {}) {
  if (running) { log('Job sudah berjalan.'); return; }
  const ctx = await refreshStatus();
  if (!ctx || ctx.page !== 'data') { log('Buka halaman /data dulu.'); return; }
  if (!ctx.xsrfToken) { log('XSRF token kosong — reload halaman Fasih.'); return; }

  const dryRun = $('dryRunReject').checked;
  const delayMs = Math.max(300, Number($('delayMs').value) || 1200);
  const batchLimit = Number($('batchLimit').value) || 0;

  let cp;
  if (resume) {
    const saved = await getStore(['fasihCheckpoint']);
    if (!saved.fasihCheckpoint || saved.fasihCheckpoint.mode !== 'revoke') { log('Tidak ada checkpoint revoke.'); return; }
    cp = saved.fasihCheckpoint;
    log(`Resume revoke: ${cp.doneKeys.length}/${cp.targets.length} target sudah diproses.`);
  } else {
    const stored = await getStore(['fasihRejectTargets']);
    const targets = stored.fasihRejectTargets ?? rejectTargets;
    if (!targets.length) { log('Muat Excel dulu (§3 Pratinjau).'); return; }
    const groupId = $('groupId').value.trim();
    if (!groupId) { log('Isi Group ID.'); return; }
    const ok = confirm(`Revoke ${targets.length} target dari Excel? (hanya yg APPROVED)\nDry-run: ${dryRun ? 'YA' : 'TIDAK (EKSEKUSI NYATA)'}\nLanjut?`);
    if (!ok) { log('Dibatalkan pengguna.'); return; }
    cp = { mode: 'revoke', jobId: `rv-${Date.now()}`, groupId, surveyPeriodId: ctx.surveyPeriodId, targets, nextIndex: 0, doneKeys: [], results: [], regionCache: {}, counts: { revoked: 0, skipped: 0, failed: 0, dryrun: 0, notFound: 0, ambiguous: 0 }, opts: { dryRun, delayMs, batchLimit }, status: 'running', startedAt: new Date().toISOString() };
  }
  if (resume) { cp.opts.dryRun = dryRun; cp.opts.delayMs = delayMs; cp.status = 'running'; }

  running = true; pauseReq = false; stopReq = false;
  let consecFail = 0;
  let listFail = 0;
  let rateWaits = 0;
  const done = new Set(cp.doneKeys);
  const processed = () => done.size + cp.counts.dryrun;
  const keyOf = (t) => `${t.kode_level6}||${t.keyword_nama.toLowerCase()}`;
  const summary = () => `↩${cp.counts.revoked} ⏭${cp.counts.skipped} ✗${cp.counts.failed}${cp.opts.dryRun ? ` (dry ${cp.counts.dryrun})` : ''}`;
  try {
    while (cp.nextIndex < cp.targets.length) {
      if (pauseReq) { cp.status = 'paused'; break; }
      if (stopReq) { cp.status = 'stopped'; break; }
      const t = cp.targets[cp.nextIndex];
      const key = keyOf(t);
      if (done.has(key)) { cp.nextIndex += 1; continue; }
      if (batchLimit && (cp.counts.revoked + cp.counts.dryrun) >= batchLimit) { log(`Batas batch ${batchLimit} tercapai.`); stopReq = true; break; }

      let reg = cp.regionCache[t.kode_level6];
      if (!reg) {
        try {
          const r = await resolveChainFromL6({ groupId: cp.groupId, l6: t.kode_level6, xsrf: ctx.xsrfToken });
          reg = { regionIds: r.ids };
          cp.regionCache[t.kode_level6] = reg;
        } catch (e) {
          cp.counts.failed += 1;
          cp.results.push({ key, status: 'failed', reason: `REGION: ${e.message}`.slice(0, 160) });
          done.add(key);
          cp.nextIndex += 1; cp.doneKeys = [...done];
          await appendLog({ action: 'revoke', status: 'failed', detail: `${t.kode_level6} ${t.keyword_nama} REGION_FAIL`, url: ctx.url });
          await setStore({ fasihCheckpoint: cp });
          log(`✗ region gagal ${t.kode_level6}: ${e.message}`);
          setProgress(processed(), cp.targets.length, summary());
          continue;
        }
      }

      const body = buildListBody({ regionIds: reg.regionIds, surveyPeriodId: cp.surveyPeriodId, start: 0, length: 10, searchValue: t.keyword_nama });
      let list;
      try {
        list = await withRetry(() => listAssignments(body, ctx.xsrfToken));
        listFail = 0;
        rateWaits = 0;
      } catch (e) {
        if (String(e.message).includes('SESSION_EXPIRED')) { cp.status = 'paused-need-login'; log('Sesi habis — login ulang lalu Resume.'); break; }
        const rate = String(e.message).match(/FASIH_429_RETRY_AFTER_(\d+)/);
        if (rate) {
          rateWaits += 1;
          if (rateWaits > 5) { cp.status = 'paused-list-error'; log('Rate limit 429 berulang 5x. Tunggu ±2 menit lalu Resume.'); break; }
          const waitS = Math.min(Math.max(Number(rate[1]) || 45, 20), 120);
          log(`Rate limit 429 — tunggu ${waitS} dtk (${rateWaits}/5)…`);
          await setStore({ fasihCheckpoint: cp });
          setProgress(processed(), cp.targets.length, `tunggu rate-limit ${waitS} dtk…`);
          await sleep(waitS * 1000);
          continue;
        }
        listFail += 1;
        if (listFail >= 2) { cp.status = 'paused-list-error'; log(`Gagal list 2x beruntun: ${e.message}. Klik Resume.`); break; }
        log(`List gagal (${e.message}), tunggu 3 dtk…`);
        await humanDelay(3000, 3500);
        continue;
      }

      const finish = async (status, reason, line) => {
        if (status === 'revoked') cp.counts.revoked += 1;
        else if (status === 'dryrun') cp.counts.dryrun += 1;
        else if (status === 'failed') cp.counts.failed += 1;
        else { cp.counts.skipped += 1; if (reason === 'NOT_FOUND') cp.counts.notFound += 1; if (reason === 'AMBIGUOUS') cp.counts.ambiguous += 1; }
        cp.results.push({ key, status, reason });
        if (status !== 'dryrun') done.add(key);
        cp.nextIndex += 1; cp.doneKeys = [...done];
        await appendLog({ action: 'revoke', status, detail: `${t.kode_level6} ${t.keyword_nama} ${reason}`, url: ctx.url });
        if (line) log(line);
        setProgress(processed(), cp.targets.length, summary());
        await setStore({ fasihCheckpoint: cp });
      };

      const total = list.totalHit ?? (list.searchData ?? []).length;
      if (total === 0) {
        await finish('skipped', 'NOT_FOUND', `⏭ not_found: ${t.keyword_nama}`);
      } else if (total > 1) {
        await finish('skipped', 'AMBIGUOUS', `⏭ ambiguous (${total} cocok): ${t.keyword_nama}`);
      } else {
        const row = list.searchData[0];
        const gate = shouldRevokeRow(row);
        const label = row.codeIdentity ?? row.id;
        if (!gate.ok) {
          await finish('skipped', gate.reason, `⏭ skip ${label}: ${gate.reason}`);
        } else if (cp.opts.dryRun) {
          await finish('dryrun', gate.reason, `[dry-run] would-revoke ${label} (${t.keyword_nama})`);
        } else {
          try {
            const res = await withRetry(() => revokeOne(row.id, ctx.xsrfToken));
            if (res?.success === false) throw new Error(res.message || 'SERVER_REJECTED');
            consecFail = 0;
            await finish('revoked', gate.reason, `↩ revoked ${label}`);
          } catch (e) {
            if (String(e.message).includes('SESSION_EXPIRED')) { cp.status = 'paused-need-login'; log('Sesi habis — login ulang lalu Resume.'); pauseReq = true; break; }
            consecFail += 1;
            await finish('failed', String(e.message).slice(0, 160), `✗ gagal ${label}: ${e.message}`);
            if (consecFail >= 5) { cp.status = 'error'; log('Stop: 5 gagal beruntun.'); stopReq = true; break; }
          }
        }
      }
      if (!pauseReq && !stopReq && cp.nextIndex < cp.targets.length) {
        await humanDelay(Math.max(800, delayMs), delayMs + 800);
      }
    }
    if (!pauseReq && !stopReq && cp.status === 'running') cp.status = 'done';
    if (pauseReq && cp.status === 'running') cp.status = 'paused';
    if (stopReq && cp.status === 'running') cp.status = 'stopped';
    await setStore({ fasihCheckpoint: cp });
    const c = cp.counts;
    log(`Selesai revoke: status=${cp.status} revoked=${c.revoked} skipped=${c.skipped} (not_found=${c.notFound}, ambiguous=${c.ambiguous}) failed=${c.failed}${cp.opts.dryRun ? ` dryrun=${c.dryrun}` : ''}`);
    setProgress(processed(), cp.targets.length, `status=${cp.status}`);
  } catch (e) {
    cp.status = 'paused-error';
    await setStore({ fasihCheckpoint: cp });
    log(`TERHENTI TAK TERDUGA (${e.message}) — klik Resume.`);
  } finally {
    running = false;
  }
}

$('btnApprove').addEventListener('click', () => runApprove({ resume: false }));
$('btnReject').addEventListener('click', () => runReject({ resume: false }));
$('btnRevoke').addEventListener('click', () => runRevoke({ resume: false }));
$('btnResume').addEventListener('click', async () => {
  const saved = await getStore(['fasihCheckpoint']);
  const m = saved.fasihCheckpoint?.mode;
  if (m === 'reject') runReject({ resume: true });
  else if (m === 'revoke') runRevoke({ resume: true });
  else runApprove({ resume: true });
});
$('btnPause').addEventListener('click', () => { pauseReq = true; log('Jeda diminta…'); });
$('btnStop').addEventListener('click', () => { stopReq = true; log('Berhenti diminta…'); });

$('btnPresetSave').addEventListener('click', async () => {
  await setStore({ fasihPreset: { groupId: $('groupId').value, l6: $('l6').value } });
  log('Preset tersimpan.');
});

let rejectTargets = []; // hasil parse Excel, dipakai engine M3

$('btnPreview').addEventListener('click', async () => {
  const file = $('excelFile').files[0];
  if (!file) { $('csvInfo').textContent = 'Pilih file .xlsx dulu.'; return; }
  try {
    const buf = await file.arrayBuffer();
    const { rows, invalid, sheetName } = parseExcelFile(buf);
    rejectTargets = rows;
    await setStore({ fasihRejectTargets: rows });
    $('csvInfo').textContent = `Sheet "${sheetName}": ${rows.length} valid, ${invalid.length} invalid${invalid.length ? ' → baris ' + invalid[0].line + ': ' + invalid[0].raw : ''}. Contoh: ${rows.slice(0, 3).map((r) => r.keyword_nama).join(' | ') || '-'}`;
    log(`Excel dimuat: ${rows.length} target reject.`);
  } catch (e) {
    $('csvInfo').textContent = `Gagal baca Excel: ${e.message}`;
  }
});

$('btnExport').addEventListener('click', async () => {
  const cur = await getStore(['fasihLogs']);
  const csv = logsToCsv(cur.fasihLogs ?? []);
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'fasih-log.csv';
  a.click();
});

$('btnCopyLog').addEventListener('click', async () => {
  const text = logEl.textContent || '';
  if (!text.trim()) { log('Log kosong — tidak ada yang disalin.'); return; }
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
  if (!confirm('Bersihkan semua log di panel dan arsip tersimpan? (Checkpoint tidak ikut terhapus)')) return;
  logEl.textContent = '';
  await setStore({ fasihLogs: [] });
  log('Log dibersihkan.');
});

// Dry-run §3 dan §4 selalu sinkron (satu opsi yang sama).
$('dryRun').addEventListener('change', () => { $('dryRunReject').checked = $('dryRun').checked; });
$('dryRunReject').addEventListener('change', () => { $('dryRun').checked = $('dryRunReject').checked; });

(async function init() {
  const saved = await getStore(['fasihPreset']);
  if (saved.fasihPreset) {
    if (saved.fasihPreset.groupId !== undefined) $('groupId').value = saved.fasihPreset.groupId;
    if (saved.fasihPreset.l6 !== undefined) $('l6').value = saved.fasihPreset.l6;
  }
  const cpSaved = await getStore(['fasihCheckpoint']);
  const cpr = cpSaved.fasihCheckpoint;
  if (cpr && cpr.status !== 'done') {
    const d = (cpr.doneIds ?? cpr.doneKeys ?? []).length;
    const t = cpr.totalHit ?? cpr.targets?.length ?? 0;
    setProgress(d, t, `checkpoint ${cpr.mode}: ${cpr.status}`);
  }
  await refreshStatus();
  setInterval(refreshStatus, 3000);
})();
