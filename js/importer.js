// Lectura de archivos del banco (CSV y OFX) y conversión a movimientos.

export function detectDelimiter(text) {
  const sample = text.split(/\r?\n/).slice(0, 10).join('\n');
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let inQuotes = false;
  for (const ch of sample) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch in counts) counts[ch]++;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

export function parseCSV(text, delimiter = detectDelimiter(text)) {
  text = text.replace(/^﻿/, '');
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === delimiter) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.map(r => r.map(c => c.trim())).filter(r => r.some(c => c !== ''));
}

// Busca la fila de encabezados: la primera con varias celdas de texto que parezcan nombres de columna.
export function guessHeaderRow(rows) {
  const keywords = /fecha|date|concepto|descrip|importe|monto|amount|cargo|abono|betrag|buchung|verwendung/i;
  const idx = rows.findIndex(r => r.filter(c => keywords.test(c)).length >= 2);
  return idx >= 0 ? idx : 0;
}

// Sugiere qué columna es cada cosa a partir de los encabezados.
export function guessMapping(headers) {
  const find = (re) => headers.findIndex(h => re.test(h));
  const m = {
    date: find(/fecha|date|buchungstag|datum/i),
    description: find(/concepto|descrip|detalle|movimiento|description|verwendungszweck|beschreibung|empfänger|payee/i),
    amount: find(/^(importe|monto|amount|betrag|cantidad)/i),
    debit: find(/cargo|retiro|debe|debit|soll/i),
    credit: find(/abono|dep[oó]sito|haber|credit|haben/i),
  };
  if (m.amount >= 0) { m.debit = -1; m.credit = -1; }
  return m;
}

// Convierte "1,234.56", "1.234,56", "-$45.00", "(45.00)" a centavos.
export function parseAmount(raw, decimal = 'auto') {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  let negative = /^\(.*\)$/.test(s) || /^-|-$/.test(s.replace(/[^\d\-()]/g, ''));
  s = s.replace(/[^\d.,]/g, '');
  if (!s) return null;
  let dec = decimal;
  if (dec === 'auto') {
    const lastDot = s.lastIndexOf('.'), lastComma = s.lastIndexOf(',');
    if (lastDot >= 0 && lastComma >= 0) dec = lastDot > lastComma ? '.' : ',';
    else if (lastComma >= 0) dec = /,\d{1,2}$/.test(s) ? ',' : '.';
    else dec = '.';
  }
  s = dec === ',' ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  const n = Number(s);
  if (!isFinite(n)) return null;
  const cents = Math.round(n * 100);
  return negative ? -cents : cents;
}

const MONTHS = { ene: 1, jan: 1, feb: 2, mar: 3, abr: 4, apr: 4, may: 5, mai: 5, jun: 6, jul: 7, ago: 8, aug: 8, sep: 9, set: 9, oct: 10, okt: 10, nov: 11, dic: 12, dec: 12, dez: 12 };

// Convierte varias formas de fecha a AAAA-MM-DD. dayFirst=true para 05/10/2026 = 5 de octubre.
export function parseDate(raw, dayFirst = true) {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase();
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[-/. ]([a-zé]{3})[a-zé]*\.?[-/. ](\d{2,4})/);
  if (m && MONTHS[m[2]]) return iso(year(+m[3]), MONTHS[m[2]], +m[1]);
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
  if (m) {
    const [a, b] = [+m[1], +m[2]];
    const monthFirst = dayFirst ? b > 12 : a <= 12;
    const [d, mo] = monthFirst ? [b, a] : [a, b];
    return iso(year(+m[3]), mo, d);
  }
  m = s.match(/^(\d{4})(\d{2})(\d{2})/); // OFX: 20261005
  if (m) return iso(+m[1], +m[2], +m[3]);
  return null;
}
const year = (y) => (y < 100 ? 2000 + y : y);
function iso(y, m, d) {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function parseOFX(text) {
  const items = [];
  const blocks = text.split(/<STMTTRN>/i).slice(1);
  for (const b of blocks) {
    const tag = (name) => (b.match(new RegExp(`<${name}>([^<\\r\\n]*)`, 'i')) || [])[1]?.trim();
    const amount = parseAmount(tag('TRNAMT'), '.');
    const date = parseDate(tag('DTPOSTED'));
    if (amount == null || !date) continue;
    items.push({ date, amount, description: tag('NAME') || tag('MEMO') || '', externalId: tag('FITID') });
  }
  return items;
}

// Convierte filas CSV a movimientos crudos { date, amount (con signo), description }.
export function rowsToItems(rows, mapping, opts = {}) {
  const items = [];
  for (const r of rows) {
    const date = parseDate(r[mapping.date], opts.dayFirst !== false);
    let amount = null;
    if (mapping.amount >= 0) {
      amount = parseAmount(r[mapping.amount], opts.decimal);
      if (amount != null && opts.invertSign) amount = -amount;
    } else {
      const debit = mapping.debit >= 0 ? parseAmount(r[mapping.debit], opts.decimal) : null;
      const credit = mapping.credit >= 0 ? parseAmount(r[mapping.credit], opts.decimal) : null;
      if (debit) amount = -Math.abs(debit);
      else if (credit) amount = Math.abs(credit);
    }
    if (!date || amount == null || amount === 0) continue;
    items.push({ date, amount, description: (r[mapping.description] || '').replace(/\s+/g, ' ').trim() });
  }
  return items;
}

// Huella para detectar duplicados entre importaciones o con movimientos manuales.
export function txHash(accountId, date, signedAmount, description) {
  const desc = (description || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 24);
  return `${accountId}|${date}|${signedAmount}|${desc}`;
}
