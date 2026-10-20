// lib/store.js — checkpoint + log via chrome.storage.local (M1 read-only).
export async function getStore(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

export async function setStore(obj) {
  return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
}

export function ts() {
  return new Date().toLocaleTimeString('id-ID', { hour12: false });
}

export async function appendLog(entry) {
  const cur = await getStore(['fasihLogs']);
  const logs = Array.isArray(cur.fasihLogs) ? cur.fasihLogs : [];
  logs.push({ at: new Date().toISOString(), ...entry });
  await setStore({ fasihLogs: logs.slice(-2000) });
  return logs.slice(-200);
}

export function logsToCsv(logs) {
  const head = 'at,action,status,detail,url';
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  return [head, ...logs.map((l) => [l.at, l.action, l.status, l.detail, l.url].map(esc).join(','))].join('\n');
}
