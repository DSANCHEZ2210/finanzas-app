// Pantalla de importación de archivos del banco.
import { db } from './db.js';
import { S, load, render } from './app.js';
import { money, categorize, dateLabel } from './model.js';
import { parseCSV, parseOFX, guessHeaderRow, guessMapping, rowsToItems, txHash } from './importer.js';
import { esc, $, $$, options, toast, readFileText } from './ui.js';

const FIELDS = [
  ['date', 'Fecha', true],
  ['description', 'Descripción', true],
  ['amount', 'Importe (una sola columna con signo)', false],
  ['debit', 'Cargo / retiro', false],
  ['credit', 'Abono / depósito', false],
];

// Estado de la importación en curso (se pierde al salir de la pantalla, a propósito).
let st = null;
const reset = () => { st = { accountId: S.accounts[0]?.id, fileName: '', kind: null, rows: [], headerRow: 0, mapping: {}, opts: { dayFirst: true, decimal: 'auto', invertSign: false }, preview: [] }; };

function headers() { return st.rows[st.headerRow] || []; }

function buildPreview() {
  let items = [];
  if (st.kind === 'ofx') items = st.ofxItems;
  else if (st.kind === 'csv') items = rowsToItems(st.rows.slice(st.headerRow + 1), st.mapping, st.opts);
  const existing = S.transactions.filter(t => t.accountId === st.accountId);
  const hashes = new Set(existing.map(t => t.hash).filter(Boolean));
  const near = new Set(existing.map(t => `${t.date}|${t.type === 'gasto' ? -t.amount : t.amount}`));
  const externalIds = new Set(existing.map(t => t.externalId).filter(Boolean));
  st.preview = items.map((it, i) => {
    const hash = txHash(st.accountId, it.date, it.amount, it.description);
    const dup = hashes.has(hash) || (it.externalId && externalIds.has(it.externalId));
    const maybe = !dup && near.has(`${it.date}|${it.amount}`);
    return { ...it, i, hash, dup, maybe, include: !dup && !maybe, categoryId: categorize(it.description, S.rules), changed: false };
  });
}

function mappingFromProfile(profile) {
  const h = headers();
  const m = {};
  for (const [key] of FIELDS) m[key] = profile.mapping[key] ? h.indexOf(profile.mapping[key]) : -1;
  return m;
}

function saveProfile() {
  const h = headers();
  const mapping = {};
  for (const [key] of FIELDS) mapping[key] = st.mapping[key] >= 0 ? h[st.mapping[key]] : null;
  return db.put('importProfiles', { id: st.accountId, mapping, opts: st.opts });
}

export async function importView() {
  if (!st) reset();
  const account = S.accounts.find(a => a.id === st.accountId);
  const h = headers();
  const counts = { total: st.preview.length, sel: st.preview.filter(p => p.include).length, dup: st.preview.filter(p => p.dup).length };

  const colSelect = (key) => `<select data-map="${key}">${options(h.map((name, i) => ({ id: i, name: name || `Columna ${i + 1}` })), st.mapping[key], { empty: '—' })}</select>`;

  return `
    <a class="back" href="#/mas">‹ Más</a>
    <header class="page-head"><h1>Importar</h1></header>
    <div class="card pad form">
      <label class="field"><span>Cuenta</span><select id="imp-account">${options(S.accounts, st.accountId, { label: a => `${a.name} (${a.currency})` })}</select></label>
      <label class="btn">${st.fileName ? `📄 ${esc(st.fileName)} · cambiar` : 'Elegir archivo del banco'}<input type="file" id="imp-file" accept=".csv,.txt,.ofx,.qfx,text/csv" hidden></label>
      <p class="hint">Descarga tus movimientos en CSV u OFX desde la banca en línea y elígelo aquí desde Archivos.</p>
    </div>

    ${st.kind === 'csv' ? `
      <h3 class="section-title">Columnas</h3>
      <div class="card pad form">
        <label class="field"><span>Fila de encabezados</span><select id="imp-header">${options(st.rows.slice(0, 15).map((r, i) => ({ id: i, name: `${i + 1}: ${r.slice(0, 3).join(' | ')}` })), st.headerRow)}</select></label>
        ${FIELDS.map(([key, label]) => `<label class="field"><span>${label}</span>${colSelect(key)}</label>`).join('')}
        <label class="field"><span>Formato de fecha</span><select id="imp-dayfirst">${options([{ id: '1', name: 'Día/Mes/Año' }, { id: '0', name: 'Mes/Día/Año' }], st.opts.dayFirst ? '1' : '0')}</select></label>
        <label class="field"><span>Decimales</span><select id="imp-decimal">${options([{ id: 'auto', name: 'Detectar' }, { id: '.', name: '1,234.56' }, { id: ',', name: '1.234,56' }], st.opts.decimal)}</select></label>
        ${st.mapping.amount >= 0 ? `<label class="check"><input type="checkbox" id="imp-invert"${st.opts.invertSign ? ' checked' : ''}> Los cargos vienen en positivo (común en tarjetas de crédito)</label>` : ''}
      </div>` : ''}

    ${st.kind ? `
      <h3 class="section-title">Vista previa · ${counts.sel} de ${counts.total} seleccionados${counts.dup ? ` · ${counts.dup} ya existían` : ''}</h3>
      ${st.preview.length ? `<div class="card list">${st.preview.map(p => `
        <div class="imp-row${p.include ? '' : ' off'}">
          <label class="imp-check"><input type="checkbox" data-inc="${p.i}"${p.include ? ' checked' : ''} aria-label="Incluir"></label>
          <div class="imp-main">
            <div class="row-title">${esc(p.description || '(sin descripción)')}</div>
            <div class="row-sub">${esc(dateLabel(p.date))}${p.dup ? ' · <span class="tag">ya importado</span>' : p.maybe ? ' · <span class="tag warn">posible duplicado</span>' : ''}</div>
            <select data-cat="${p.i}" aria-label="Categoría">${options(S.categories.filter(c => c.kind === (p.amount < 0 ? 'gasto' : 'ingreso')), p.categoryId, { label: c => `${c.icon || ''} ${c.name}`, empty: 'Sin categoría' })}</select>
          </div>
          <div class="row-amount ${p.amount < 0 ? 'gasto' : 'ingreso'}">${p.amount < 0 ? '−' : '+'}${money(Math.abs(p.amount), account?.currency)}</div>
        </div>`).join('')}</div>
        <button class="btn primary sticky" id="imp-go"${counts.sel ? '' : ' disabled'}>Importar ${counts.sel} movimientos</button>`
      : '<p class="empty">No se encontraron movimientos. Revisa qué columna es cada cosa.</p>'}` : ''}`;
}

importView.after = (root) => {
  $('#imp-account', root).addEventListener('change', (e) => {
    st.accountId = e.target.value;
    applyProfile();
    if (st.kind) buildPreview();
    render();
  });
  $('#imp-file', root).addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const text = await readFileText(file);
    st.fileName = file.name;
    if (/<OFX>|<STMTTRN>/i.test(text)) {
      st.kind = 'ofx'; st.ofxItems = parseOFX(text);
    } else {
      st.kind = 'csv';
      st.rows = parseCSV(text);
      st.headerRow = guessHeaderRow(st.rows);
      st.mapping = guessMapping(headers());
      applyProfile();
    }
    buildPreview(); render();
  });
  $('#imp-header', root)?.addEventListener('change', (e) => { st.headerRow = +e.target.value; st.mapping = guessMapping(headers()); buildPreview(); render(); });
  $$('[data-map]', root).forEach(sel => sel.addEventListener('change', () => {
    st.mapping[sel.dataset.map] = sel.value === '' ? -1 : +sel.value;
    if (sel.dataset.map === 'amount' && st.mapping.amount >= 0) { st.mapping.debit = -1; st.mapping.credit = -1; }
    if ((sel.dataset.map === 'debit' || sel.dataset.map === 'credit') && sel.value !== '') st.mapping.amount = -1;
    buildPreview(); render();
  }));
  $('#imp-dayfirst', root)?.addEventListener('change', (e) => { st.opts.dayFirst = e.target.value === '1'; buildPreview(); render(); });
  $('#imp-decimal', root)?.addEventListener('change', (e) => { st.opts.decimal = e.target.value; buildPreview(); render(); });
  $('#imp-invert', root)?.addEventListener('change', (e) => { st.opts.invertSign = e.target.checked; buildPreview(); render(); });
  $$('[data-inc]', root).forEach(cb => cb.addEventListener('change', () => { st.preview[+cb.dataset.inc].include = cb.checked; render(); }));
  $$('[data-cat]', root).forEach(sel => sel.addEventListener('change', () => {
    const p = st.preview[+sel.dataset.cat];
    // Aplica la misma categoría a los movimientos con la misma descripción.
    for (const q of st.preview) if (q.description === p.description && Math.sign(q.amount) === Math.sign(p.amount)) { q.categoryId = sel.value || null; q.changed = true; }
    render();
  }));
  $('#imp-go', root)?.addEventListener('click', doImport);
};

function applyProfile() {
  const profile = S.importProfiles.find(p => p.id === st.accountId);
  if (!profile || st.kind !== 'csv') return;
  const m = mappingFromProfile(profile);
  if (m.date >= 0 && m.description >= 0) { st.mapping = m; st.opts = { ...st.opts, ...profile.opts }; }
}

// Toma el inicio de la descripción antes de números (folios, referencias) como texto de la regla.
function ruleKey(description) {
  const key = (description || '').split(/\d/)[0].replace(/[*#\-/]+$/, '').trim();
  return key.length >= 3 ? key : null;
}

async function doImport() {
  const chosen = st.preview.filter(p => p.include);
  const now = Date.now();
  await db.putMany('transactions', chosen.map((p, n) => ({
    type: p.amount < 0 ? 'gasto' : 'ingreso',
    amount: Math.abs(p.amount),
    date: p.date,
    accountId: st.accountId,
    categoryId: p.categoryId || null,
    description: p.description,
    source: 'importado',
    hash: p.hash,
    externalId: p.externalId || null,
    createdAt: now + n,
  })));
  // Aprende reglas a partir de las categorías que corregiste.
  const known = new Set(S.rules.map(r => r.match.toLowerCase()));
  const newRules = [];
  for (const p of chosen) {
    if (!p.changed || !p.categoryId) continue;
    const key = ruleKey(p.description);
    if (key && !known.has(key.toLowerCase())) { known.add(key.toLowerCase()); newRules.push({ match: key, categoryId: p.categoryId }); }
  }
  if (newRules.length) await db.putMany('rules', newRules);
  if (st.kind === 'csv') await saveProfile();
  await load();
  toast(`${chosen.length} movimientos importados${newRules.length ? ` · ${newRules.length} ${newRules.length === 1 ? 'regla nueva' : 'reglas nuevas'}` : ''}`);
  const accountId = st.accountId;
  const latest = chosen.map(p => p.date).sort().pop();
  if (latest) S.month = latest.slice(0, 7);
  reset();
  location.hash = `#/movimientos/${accountId}`;
}
