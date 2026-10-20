// lib/sheet.js — parser daftar reject (tanpa alasan): kode_level6 + keyword_nama.
// Sumber utama: file Excel (.xlsx) sheet pertama. Inti parser bekerja pada matrix
// (array of array sel string) sehingga sama untuk Excel maupun CSV.

export function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',' || ch === ';') { out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function normHeader(h) {
  const s = String(h ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (['kodelevel6', 'kode', 'level6', 'subsls', 'fullcode', 'kodesubsls', 'kodesls', 'wilayah'].includes(s)) return 'kode_level6';
  if (['keywordnama', 'nama', 'namakeluarga', 'keluarga', 'bangunan', 'usaha', 'namabangunan', 'namausaha', 'keyword', 'target', 'namatarget'].includes(s)) return 'keyword_nama';
  return s;
}

const cell = (v) => String(v ?? '').trim();

// Terima matrix[row][col] (mis. dari XLSX.utils.sheet_to_json(ws, { header: 1 })).
export function parseSheetMatrix(matrix) {
  const grid = (matrix ?? []).map((r) => (Array.isArray(r) ? r : [r]).map(cell)).filter((r) => r.some((c) => c !== ''));
  if (!grid.length) return { rows: [], invalid: [] };
  const header = grid[0].map(normHeader);
  const hasHeader = header.includes('kode_level6') || header.includes('keyword_nama');
  const body = hasHeader ? grid.slice(1) : grid;
  const idxKode = hasHeader ? header.indexOf('kode_level6') : 0;
  const idxNama = hasHeader ? header.indexOf('keyword_nama') : 1;
  const rows = [];
  const invalid = [];
  const seen = new Set();
  body.forEach((cells, i) => {
    const kode = cell(cells[idxKode]).replace(/\.0$/, ''); // jaga kode numerik Excel 3.3E+15
    const nama = cell(cells[idxNama]);
    if (!kode || !nama) { invalid.push({ line: i + (hasHeader ? 2 : 1), raw: cells.join(' | '), reason: 'EMPTY_FIELD' }); return; }
    const key = `${kode}||${nama.toLowerCase()}`;
    if (seen.has(key)) return; // dedup diam-diam
    seen.add(key);
    rows.push({ kode_level6: kode, keyword_nama: nama });
  });
  return { rows, invalid };
}

export function parseRejectCsv(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return parseSheetMatrix(lines.map(splitCsvLine));
}

// Baca file .xlsx/.xls via SheetJS global (src/lib/vendor/xlsx.full.min.js).
// Mengembalikan { rows, invalid, sheetName } dari sheet pertama yang berisi data.
export function parseExcelFile(arrayBuffer) {
  if (typeof XLSX === 'undefined') throw new Error('XLSX_LIB_MISSING: reload extension');
  const wb = XLSX.read(arrayBuffer, { type: 'array' });
  const name = wb.SheetNames.find((n) => {
    const m = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1 });
    return m.some((r) => Array.isArray(r) && r.some((c) => String(c ?? '').trim() !== ''));
  }) ?? wb.SheetNames[0];
  if (!name) throw new Error('EXCEL_EMPTY: tidak ada sheet berisi data');
  const matrix = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '', raw: false });
  return { ...parseSheetMatrix(matrix), sheetName: name };
}
