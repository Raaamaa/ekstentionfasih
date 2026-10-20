// lib/fasih-api.js — kontrak TERKUNCI dari 3 HAR (M1 read-only).
// Semua request memakai sesi browser aktif: fetch(..., { credentials: 'include' }).
// approveOne/rejectOne didefinisikan untuk M2/M3, JANGAN dipanggil di M1.

export const API_BASE = 'https://fasih-sm.bps.go.id';
export const LIST_PATH = '/app/api/analytic/api/v2/assignment/datatable-all-user-survey-periode';
export const AGG_PATH = '/app/api/analytic/api/v2/assignment/datatable-all-user-survey-periode-aggregation';
export const APPROVAL_PATH = '/app/api/assignment-approval/api/v2/approval';
export const REVOKE_PATH = '/app/api/assignment-approval/api/v2/revoke-approval';
export const FIXED_COMMENT = '{"dataKey":"","notes":[]}';

export function regionPath(level) {
  if (level < 1 || level > 6) throw new Error('LEVEL_RANGE: 1..6');
  return `/app/api/region/api/v1/region/level${level}`;
}

export function regionParentParam(level) {
  return level <= 1 ? null : `level${level - 1}FullCode`;
}

export async function fasihFetch(path, { xsrf = '', init = {} } = {}) {
  const res = await fetch(API_BASE + path, {
    credentials: 'include',
    ...init,
    headers: { 'Content-Type': 'application/json', ...(xsrf ? { 'X-XSRF-TOKEN': xsrf } : {}), ...(init.headers ?? {}) },
  });
  if (res.status === 401 || res.status === 302) throw new Error('SESSION_EXPIRED: login ulang di tab Fasih lalu ulangi');
  if (res.status === 429) {
    const ra = Number(res.headers.get('Retry-After')) || 0;
    throw new Error(`FASIH_429_RETRY_AFTER_${ra}: ${path}`);
  }
  if (!res.ok) throw new Error(`FASIH_${res.status}: ${path}`);

  // Deteksi dini redirect sesi login habis (respons 200 berformat HTML atau diarahkan ke login/sso)
  const ct = (res.headers.get('Content-Type') || '').toLowerCase();
  const finalUrl = String(res.url || '');
  if (ct.includes('text/html') || finalUrl.includes('/login') || finalUrl.includes('/sso') || finalUrl.includes('/auth')) {
    throw new Error('SESSION_EXPIRED: Sesi login BPS habis (server mengembalikan halaman login HTML). Silakan login ulang di tab Web Fasih.');
  }

  try {
    return await res.json();
  } catch (parseErr) {
    if (String(parseErr?.message || '').includes('Unexpected token')) {
      throw new Error('SESSION_EXPIRED: Respons server bukan format JSON (kemungkinan sesi login habis). Silakan login ulang di tab Web Fasih.');
    }
    throw parseErr;
  }
}

export async function getRegionMetadata(groupId, xsrf) {
  const qs = new URLSearchParams({ id: groupId });
  return fasihFetch(`/app/api/region/api/v1/region-metadata?${qs}`, { xsrf });
}

export async function getRegion(level, groupId, parentFullCode, xsrf) {
  const qs = new URLSearchParams({ groupId });
  const parentKey = regionParentParam(level);
  if (parentKey) {
    if (!parentFullCode) throw new Error('FILTER_LEVEL_PARENT_REQUIRED');
    qs.set(parentKey, parentFullCode);
  }
  const json = await fasihFetch(`${regionPath(level)}?${qs}`, { xsrf });
  return Array.isArray(json) ? json : json.data ?? [];
}

// fullCodes: { l1..l5 } (fullCode parent berantai). Mengembalikan { ids, items }.
// ids = { region1Id..region6Id } (UUID untuk body list). items menyimpan opsi per level utk dropdown.
export async function resolveRegionChain({ groupId, fullCodes, xsrf }) {
  const ids = {};
  const items = {};
  let parent = '';
  for (let level = 1; level <= 6; level += 1) {
    const rows = await getRegion(level, groupId, parent, xsrf);
    items[`l${level}`] = rows;
    if (level <= 5) {
      const want = (fullCodes[`l${level}`] || '').trim();
      const hit = rows.find((r) => r.fullCode === want) ?? rows[0];
      if (!hit) throw new Error(`REGION_NOT_FOUND_L${level}: ${want}`);
      ids[`region${level}Id`] = hit.id;
      parent = hit.fullCode;
    } else {
      const want6 = (fullCodes.l6 || '').trim();
      if (!want6) throw new Error('FILTER_LEVEL6_REQUIRED');
      const hit6 = rows.find((r) => r.fullCode === want6) ?? null;
      if (!hit6) throw new Error(`REGION_NOT_FOUND_L6: ${want6}`);
      ids.region6Id = hit6.id;
    }
    await humanDelay(150, 400);
  }
  return { ids, items };
}

// Cari baris parent: fullCode-nya harus awalan (prefix) dari target. Pilih yang terpanjang.
export function findPrefixRow(rows, targetFullCode) {
  let best = null;
  for (const r of rows) {
    const fc = String(r?.fullCode ?? '');
    if (fc && targetFullCode.startsWith(fc) && (!best || fc.length > String(best.fullCode).length)) best = r;
  }
  return best;
}

// Resolve rantai hanya dari kode L6: L1–L5 dikenali otomatis via prefix.
// Contoh: 3328170008000100 → L1=33, L2=3328, L3=3328170, L4=3328170008, L5=33281700080001.
export async function resolveChainFromL6({ groupId, l6, xsrf }) {
  const target = String(l6 ?? '').trim();
  if (!target) throw new Error('FILTER_LEVEL6_REQUIRED');
  const ids = {};
  const items = {};
  const fullCodes = {};
  let parent = '';
  for (let level = 1; level <= 5; level += 1) {
    const rows = await getRegion(level, groupId, parent, xsrf);
    items[`l${level}`] = rows;
    const hit = findPrefixRow(rows, target);
    if (!hit) throw new Error(`REGION_PARENT_NOT_FOUND_L${level}: tidak ada opsi yang menjadi awalan ${target}`);
    ids[`region${level}Id`] = hit.id;
    fullCodes[`l${level}`] = hit.fullCode;
    parent = hit.fullCode;
    await humanDelay(150, 400);
  }
  const rows6 = await getRegion(6, groupId, parent, xsrf);
  items.l6 = rows6;
  const hit6 = rows6.find((r) => r.fullCode === target) ?? null;
  if (!hit6) throw new Error(`REGION_NOT_FOUND_L6: ${target} (bukan SubSLS di bawah ${parent})`);
  ids.region6Id = hit6.id;
  fullCodes.l6 = hit6.fullCode;
  return { ids, fullCodes, items };
}

const LIST_COLUMNS = ['id', 'codeIdentity', 'data1', 'data2', 'data3', 'data4', 'data5', 'data6', 'data7', 'data8', 'data9', 'data10'];

export function buildListBody({ regionIds, surveyPeriodId, start = 0, length = 10, searchValue = '' }) {
  for (let n = 1; n <= 6; n += 1) {
    if (!regionIds[`region${n}Id`]) throw new Error(`FILTER_LEVEL${n}_ID_REQUIRED`);
  }
  return {
    start, length,
    columns: LIST_COLUMNS.map((data) => ({ data })),
    order: [],
    search: { value: searchValue, regex: false },
    assignmentExtraParam: {
      ...regionIds, surveyPeriodId,
      assignmentErrorStatusType: -1,
      filterTargetType: 'TARGET_ONLY',
    },
  };
}

export function buildListBodyFromActiveFilter({ assignmentExtraParam, start = 0, length = 10, searchValue = '' }) {
  if (!assignmentExtraParam || !assignmentExtraParam.surveyPeriodId) {
    throw new Error('FILTER_ACTIVE_MISSING: Filter Web Fasih belum terdeteksi. Buka halaman Data Fasih dan pilih filter wilayah/status.');
  }
  return {
    start,
    length,
    columns: LIST_COLUMNS.map((data) => ({ data })),
    order: [],
    search: { value: searchValue, regex: false },
    assignmentExtraParam: {
      ...assignmentExtraParam,
      assignmentErrorStatusType: assignmentExtraParam.assignmentErrorStatusType ?? -1,
      filterTargetType: assignmentExtraParam.filterTargetType ?? 'TARGET_ONLY',
    },
  };
}

export const pageToStart = (page, length) => (page - 1) * length;

export async function listAssignments(body, xsrf) {
  return fasihFetch(LIST_PATH, { xsrf, init: { method: 'POST', body: JSON.stringify(body) } });
}

export async function getAggregation(body, xsrf) {
  const { search, assignmentExtraParam } = body;
  return fasihFetch(AGG_PATH, { xsrf, init: { method: 'POST', body: JSON.stringify({ search, assignmentExtraParam }) } });
}

// --- M2/M3 ---
export async function getButtonApproval(assignmentId, xsrf) {
  const qs = new URLSearchParams({ assignmentId });
  return fasihFetch(`/app/api/assignment-approval/api/v2/get-button-approval?${qs}`, { xsrf, init: { method: 'POST' } });
}

export async function approveOne(assignmentId, xsrf) {
  return fasihFetch(APPROVAL_PATH, { xsrf, init: { method: 'POST', body: JSON.stringify({ assignmentId, statusApproval: 'true', comment: FIXED_COMMENT }) } });
}

export async function rejectOne(assignmentId, xsrf) {
  // Keputusan: tanpa field reason/alasan.
  return fasihFetch(APPROVAL_PATH, { xsrf, init: { method: 'POST', body: JSON.stringify({ assignmentId, statusApproval: 'false', comment: FIXED_COMMENT }) } });
}

// M4 revoke (dari revoke.har): endpoint BEDA, body SAMA dengan reject → status 1 REVOKED.
export async function revokeOne(assignmentId, xsrf) {
  return fasihFetch(REVOKE_PATH, { xsrf, init: { method: 'POST', body: JSON.stringify({ assignmentId, statusApproval: 'false', comment: FIXED_COMMENT }) } });
}

// Gate Approval:
// - Status COMPLETED (Completed by Admin Kabupaten) -> Sudah selesai -> SKIP (ALREADY_COMPLETED).
// - Status APPROVED / REJECTED -> SKIP.
// - Status EDITED (Edited by Admin Kabupaten) -> Target utama approval admin -> OK.
// - Status SUBMITTED -> Target approval standar (jika onlyEdited = false) -> OK.
// - Status REVOKED -> Perlu opt-in includeRevoked.
export function shouldApproveRow(row, { includeRevoked = false, onlyEdited = true } = {}) {
  const alias = String(row?.assignmentStatusAlias ?? row?.assignmentStatusId ?? '').toUpperCase();
  if (alias.includes('COMPLETED')) return { ok: false, reason: 'ALREADY_COMPLETED' };
  if (alias.includes('APPROVED')) return { ok: false, reason: 'ALREADY_APPROVED' };
  if (alias.includes('REJECTED')) return { ok: false, reason: 'ALREADY_REJECTED' };

  if (alias.includes('EDITED')) return { ok: true, reason: 'EDITED_BY_ADMIN' };
  if (!onlyEdited && alias.includes('SUBMITTED')) return { ok: true, reason: 'SUBMITTED' };
  if (alias.includes('REVOKED')) {
    return includeRevoked ? { ok: true, reason: 'REVOKED_INCLUDED' } : { ok: false, reason: 'REVOKED_NEEDS_OPTIN' };
  }
  return { ok: false, reason: 'UNKNOWN_STATUS' };
}

// Gate M3: REJECTED selalu skip; SUBMITTED/APPROVED dieksekusi; REVOKED opsional.
// APPROVED ikut dieksekusi (override keputusan lama) dan dicatat OVERRIDE_APPROVED.
export function shouldRejectRow(row, { includeRevoked = false } = {}) {
  const alias = String(row?.assignmentStatusAlias ?? row?.assignmentStatusId ?? '').toUpperCase();
  if (alias.includes('REJECTED')) return { ok: false, reason: 'ALREADY_REJECTED' };
  if (alias.includes('SUBMITTED')) return { ok: true, reason: 'SUBMITTED' };
  if (alias.includes('APPROVED')) return { ok: true, reason: 'OVERRIDE_APPROVED' };
  if (alias.includes('REVOKED')) {
    return includeRevoked ? { ok: true, reason: 'REVOKED_INCLUDED' } : { ok: false, reason: 'REVOKED_NEEDS_OPTIN' };
  }
  return { ok: false, reason: 'UNKNOWN_STATUS' };
}

// Gate M4: hanya APPROVED yang di-revoke. SUBMITTED → pakai reject; lainnya skip.
export function shouldRevokeRow(row) {
  const alias = String(row?.assignmentStatusAlias ?? row?.assignmentStatusId ?? '').toUpperCase();
  if (alias.includes('APPROVED')) return { ok: true, reason: 'REVOKEABLE_APPROVED' };
  if (alias.includes('REVOKED')) return { ok: false, reason: 'ALREADY_REVOKED' };
  if (alias.includes('REJECTED')) return { ok: false, reason: 'REJECTED_NO_REVOKE' };
  if (alias.includes('SUBMITTED')) return { ok: false, reason: 'SUBMITTED_USE_REJECT' };
  if (alias.includes('COMPLETED')) return { ok: false, reason: 'COMPLETED_FINAL' };
  return { ok: false, reason: 'UNKNOWN_STATUS' };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function humanDelay(minMs = 1200, maxMs = 2400) {
  const jitter = Math.random() * Math.max(0, maxMs - minMs);
  await sleep(minMs + jitter);
}

export async function withRetry(fn, { tries = 3, baseMs = 800, rateLimitWaitMs = 30000 } = {}) {
  let last;
  for (let i = 1; i <= tries; i += 1) {
    try { return await fn(); } catch (e) {
      last = e;
      const m = String(e?.message ?? '');
      const ra = m.match(/FASIH_429_RETRY_AFTER_(\d+)/);
      if (ra) {
        // 429: hormati Retry-After server (default 30 dtk, maks 120 dtk)
        const wait = (Number(ra[1]) || rateLimitWaitMs / 1000) * 1000;
        await sleep(Math.min(Math.max(wait, 5000), 120000));
      } else if (i < tries) await sleep(baseMs * i);
    }
  }
  throw last;
}
