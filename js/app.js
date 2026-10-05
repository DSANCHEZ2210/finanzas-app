import { db, exportAll, importAll, persistStorage } from './db.js';
import {
  seedIfEmpty, money, toCents, fromCents, today, monthKey, monthLabel, shiftMonth, dateLabel,
  balances, monthTotals, spentByCategory, debtRemaining, nextDueDate, categorize,
  ACCOUNT_TYPES, CURRENCIES,
} from './model.js';
import { esc, $, $$, options, openSheet, closeSheet, toast, formData, download, readFileText } from './ui.js';
import { importView } from './import-view.js';

// Estado en memoria; se recarga de IndexedDB después de cada cambio.
export const S = { accounts: [], categories: [], transactions: [], budgets: [], debts: [], rules: [], importProfiles: [], month: monthKey(today()) };

export async function load() {
  for (const k of ['accounts', 'categories', 'transactions', 'budgets', 'debts', 'rules', 'importProfiles']) S[k] = await db.all(k);
  S.transactions.sort((a, b) => (b.date.localeCompare(a.date)) || ((b.createdAt || 0) - (a.createdAt || 0)));
  S.categories.sort((a, b) => a.name.localeCompare(b.name, 'es'));
}

const byId = (list, id) => list.find(x => x.id === id);
const accountName = (id) => byId(S.accounts, id)?.name || '—';
const accountCurrency = (id) => byId(S.accounts, id)?.currency || 'MXN';
const catLabel = (c) => c ? `${c.icon || ''} ${c.name}`.trim() : 'Sin categoría';

// ---------- Navegación ----------
const TABS = [
  ['inicio', 'Inicio', 'M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z'],
  ['movimientos', 'Movimientos', 'M4 6h16M4 12h16M4 18h10'],
  ['presupuestos', 'Presupuestos', 'M12 3a9 9 0 1 0 9 9h-9z M14 2.5V10h7.5A9 9 0 0 0 14 2.5z'],
  ['deudas', 'Deudas', 'M3 6h18v12H3z M3 10h18'],
  ['mas', 'Más', 'M5 12h.01M12 12h.01M19 12h.01'],
];

function route() {
  const [name = 'inicio', ...rest] = location.hash.replace(/^#\/?/, '').split('/');
  return { name, rest };
}

export async function render() {
  const { name, rest } = route();
  const views = { inicio: homeView, movimientos: txListView, presupuestos: budgetsView, deudas: debtsView, mas: moreView, importar: importView, cuentas: accountsView, categorias: categoriesView, reglas: rulesView, respaldo: backupView, instalar: installView };
  const view = views[name] || homeView;
  const main = $('#main');
  main.innerHTML = await view(rest);
  main.dataset.view = name;
  const activeTab = TABS.some(t => t[0] === name) ? name : 'mas';
  $('#tabbar').innerHTML = TABS.map(([id, label, path]) => `
    <a href="#/${id}" class="tab${id === activeTab ? ' active' : ''}" aria-label="${label}">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="${path}"/></svg><span>${label}</span>
    </a>`).join('');
  view.after?.(main, rest);
  bindCommon(main);
}

function bindCommon(root) {
  $$('[data-month]', root).forEach(b => b.addEventListener('click', () => { S.month = shiftMonth(S.month, +b.dataset.month); render(); }));
  $$('[data-add-tx]', root).forEach(b => b.addEventListener('click', () => txForm(null, JSON.parse(b.dataset.addTx || '{}'))));
  $$('[data-edit-tx]', root).forEach(b => b.addEventListener('click', () => txForm(byId(S.transactions, b.dataset.editTx))));
}

const monthNav = () => `
  <div class="month-nav">
    <button class="icon-btn" data-month="-1" aria-label="Mes anterior">‹</button>
    <span>${esc(monthLabel(S.month))}</span>
    <button class="icon-btn" data-month="1" aria-label="Mes siguiente">›</button>
  </div>`;

const fab = (preset = {}) => `<button class="fab" data-add-tx='${esc(JSON.stringify(preset))}' aria-label="Agregar movimiento">+</button>`;

function txRow(t) {
  const cat = byId(S.categories, t.categoryId);
  const cur = accountCurrency(t.accountId);
  const sign = t.type === 'gasto' ? '−' : t.type === 'ingreso' ? '+' : '';
  const icon = t.type === 'transferencia' ? '⇄' : (cat?.icon || '•');
  const title = t.description || (t.type === 'transferencia' ? 'Transferencia' : cat?.name || 'Movimiento');
  const sub = t.type === 'transferencia'
    ? `${esc(accountName(t.accountId))} → ${esc(accountName(t.toAccountId))}`
    : `${esc(cat?.name || 'Sin categoría')} · ${esc(accountName(t.accountId))}`;
  return `
    <button class="row" data-edit-tx="${t.id}">
      <span class="row-icon">${esc(icon)}</span>
      <span class="row-main"><span class="row-title">${esc(title)}</span><span class="row-sub">${sub}</span></span>
      <span class="row-amount ${t.type}">${sign}${money(t.amount, cur)}</span>
    </button>`;
}

function txGroups(list) {
  if (!list.length) return '<p class="empty">No hay movimientos.</p>';
  const groups = {};
  for (const t of list) (groups[t.date] ??= []).push(t);
  return Object.entries(groups).map(([d, items]) => `
    <h3 class="group-title">${esc(dateLabel(d))}</h3>
    <div class="card list">${items.map(txRow).join('')}</div>`).join('');
}

function progress(spent, limit) {
  const pct = limit > 0 ? Math.min(100, Math.round((spent / limit) * 100)) : 0;
  const cls = spent > limit ? 'over' : pct >= 80 ? 'warn' : 'ok';
  return `<div class="bar ${cls}"><span style="width:${pct}%"></span></div>`;
}

// ---------- Inicio ----------
async function homeView() {
  const totals = monthTotals(S.accounts, S.transactions, S.month);
  const bal = balances(S.accounts, S.transactions);
  const spent = spentByCategory(S.accounts, S.transactions, S.month);
  const currencies = Object.keys(totals).length ? Object.keys(totals) : [...new Set(S.accounts.map(a => a.currency))].slice(0, 1);

  const summary = currencies.map(c => {
    const t = totals[c] || { ingresos: 0, gastos: 0 };
    const net = t.ingresos - t.gastos;
    return `
      <div class="card summary">
        <div class="summary-label">Balance del mes · ${c}</div>
        <div class="summary-value ${net < 0 ? 'neg' : ''}">${money(net, c)}</div>
        <div class="summary-split">
          <div><span class="dot ingreso"></span>Ingresos<br><strong>${money(t.ingresos, c)}</strong></div>
          <div><span class="dot gasto"></span>Gastos<br><strong>${money(t.gastos, c)}</strong></div>
        </div>
      </div>`;
  }).join('');

  const atRisk = S.budgets.map(b => ({ b, cat: byId(S.categories, b.categoryId), s: spent[b.categoryId]?.[b.currency] || 0 }))
    .filter(x => x.s >= x.b.amount * 0.8)
    .sort((a, b) => b.s / b.b.amount - a.s / a.b.amount);

  const upcoming = S.debts.map(d => ({ d, due: nextDueDate(d), left: debtRemaining(d, S.transactions) }))
    .filter(x => x.due && x.left > 0 && (x.due - new Date()) / 864e5 <= 15)
    .sort((a, b) => a.due - b.due);

  return `
    <header class="page-head"><h1>Inicio</h1></header>
    ${monthNav()}
    ${summary}
    ${atRisk.length ? `<h3 class="section-title">Presupuestos en riesgo</h3><div class="card">${atRisk.map(({ b, cat, s }) => `
      <a class="budget" href="#/presupuestos">
        <div class="budget-line"><span>${esc(catLabel(cat))}</span><span>${money(s, b.currency)} / ${money(b.amount, b.currency)}</span></div>
        ${progress(s, b.amount)}
      </a>`).join('')}</div>` : ''}
    ${upcoming.length ? `<h3 class="section-title">Próximos pagos</h3><div class="card list">${upcoming.map(({ d, due, left }) => `
      <a class="row" href="#/deudas">
        <span class="row-icon">📅</span>
        <span class="row-main"><span class="row-title">${esc(d.name)}</span><span class="row-sub">${due.toLocaleDateString('es-MX', { day: 'numeric', month: 'short' })} · mínimo ${money(d.minPayment || 0, d.currency)}</span></span>
        <span class="row-amount">${money(left, d.currency)}</span>
      </a>`).join('')}</div>` : ''}
    <h3 class="section-title">Cuentas</h3>
    <div class="card list">${S.accounts.map(a => `
      <a class="row" href="#/movimientos/${a.id}">
        <span class="row-icon">${a.type === 'credito' ? '💳' : a.type === 'efectivo' ? '💵' : '🏦'}</span>
        <span class="row-main"><span class="row-title">${esc(a.name)}</span><span class="row-sub">${esc(ACCOUNT_TYPES[a.type] || a.type)}</span></span>
        <span class="row-amount ${bal[a.id] < 0 ? 'gasto' : ''}">${money(bal[a.id], a.currency)}</span>
      </a>`).join('')}</div>
    <h3 class="section-title">Últimos movimientos</h3>
    <div class="card list">${S.transactions.slice(0, 5).map(txRow).join('') || '<p class="empty">Aún no registras nada. Toca + para empezar.</p>'}</div>
    ${fab()}`;
}

// ---------- Movimientos ----------
let txFilter = { q: '', type: '' };
async function txListView(rest) {
  const accountId = rest[0] || '';
  const q = txFilter.q.toLowerCase();
  const list = S.transactions.filter(t =>
    monthKey(t.date) === S.month &&
    (!accountId || t.accountId === accountId || t.toAccountId === accountId) &&
    (!txFilter.type || t.type === txFilter.type) &&
    (!q || (t.description || '').toLowerCase().includes(q) || (byId(S.categories, t.categoryId)?.name || '').toLowerCase().includes(q)));
  return `
    <header class="page-head"><h1>Movimientos</h1></header>
    ${monthNav()}
    <div class="filters">
      <input type="search" id="tx-q" placeholder="Buscar" value="${esc(txFilter.q)}" aria-label="Buscar">
      <select id="tx-account" aria-label="Cuenta">${options(S.accounts, accountId, { empty: 'Todas las cuentas' })}</select>
      <select id="tx-type" aria-label="Tipo">${options([{ id: 'gasto', name: 'Gastos' }, { id: 'ingreso', name: 'Ingresos' }, { id: 'transferencia', name: 'Transferencias' }], txFilter.type, { empty: 'Todo' })}</select>
    </div>
    ${txGroups(list)}
    ${fab(accountId ? { accountId } : {})}`;
}
txListView.after = (root) => {
  const q = $('#tx-q', root);
  q.addEventListener('input', () => { txFilter.q = q.value; clearTimeout(q._t); q._t = setTimeout(async () => { await render(); const el = $('#tx-q'); el.focus(); el.setSelectionRange(el.value.length, el.value.length); }, 250); });
  $('#tx-account', root).addEventListener('change', (e) => { location.hash = `#/movimientos${e.target.value ? '/' + e.target.value : ''}`; });
  $('#tx-type', root).addEventListener('change', (e) => { txFilter.type = e.target.value; render(); });
};

// ---------- Formulario de movimiento ----------
export function txForm(tx, preset = {}) {
  const t = tx || { type: 'gasto', date: today(), accountId: S.accounts[0]?.id, ...preset };
  const sheet = openSheet(tx ? 'Editar movimiento' : 'Nuevo movimiento', `
    <form id="tx-form" class="form">
      <div class="segmented" role="radiogroup">
        ${['gasto', 'ingreso', 'transferencia'].map(k => `<label><input type="radio" name="type" value="${k}"${t.type === k ? ' checked' : ''}><span>${k[0].toUpperCase() + k.slice(1)}</span></label>`).join('')}
      </div>
      <label class="field amount-field"><span>Importe</span>
        <input name="amount" inputmode="decimal" required placeholder="0.00" value="${t.amount ? fromCents(t.amount) : ''}" autocomplete="off"></label>
      <label class="field"><span>Descripción</span><input name="description" value="${esc(t.description || '')}" placeholder="Ej. Tacos, renta, sueldo" autocomplete="off"></label>
      <label class="field"><span>Fecha</span><input type="date" name="date" required value="${esc(t.date)}"></label>
      <label class="field"><span data-from-label>Cuenta</span><select name="accountId" required>${options(S.accounts, t.accountId)}</select></label>
      <div data-only="transferencia">
        <label class="field"><span>Hacia la cuenta</span><select name="toAccountId">${options(S.accounts, t.toAccountId, { empty: 'Elegir' })}</select></label>
        <label class="field" data-to-amount><span>Importe recibido</span><input name="toAmount" inputmode="decimal" placeholder="Si cambia la moneda" value="${t.toAmount ? fromCents(t.toAmount) : ''}"></label>
      </div>
      <div data-only="gasto ingreso">
        <label class="field"><span>Categoría</span><select name="categoryId"></select></label>
      </div>
      <div data-only="gasto">
        <label class="field"><span>Abono a deuda</span><select name="debtId">${options(S.debts, t.debtId, { empty: 'Ninguna' })}</select></label>
      </div>
      <button class="btn primary" type="submit">Guardar</button>
      ${tx ? '<button class="btn danger" type="button" data-delete>Eliminar</button>' : ''}
    </form>`);
  const form = $('#tx-form', sheet);

  const sync = () => {
    const type = form.type.value;
    $$('[data-only]', form).forEach(el => { el.hidden = !el.dataset.only.split(' ').includes(type); });
    $('[data-from-label]', form).textContent = type === 'transferencia' ? 'Desde la cuenta' : 'Cuenta';
    const kind = type === 'ingreso' ? 'ingreso' : 'gasto';
    const current = form.categoryId.value || t.categoryId;
    form.categoryId.innerHTML = options(S.categories.filter(c => c.kind === kind), current, { label: catLabel, empty: 'Sin categoría' });
    const fromCur = accountCurrency(form.accountId.value);
    const toCur = form.toAccountId.value ? accountCurrency(form.toAccountId.value) : fromCur;
    $('[data-to-amount]', form).hidden = fromCur === toCur;
  };
  form.addEventListener('change', (e) => {
    if (e.target.name === 'debtId' && e.target.value) {
      const pago = S.categories.find(c => c.name === 'Pago de deuda');
      if (pago) form.categoryId.value = pago.id;
    }
    sync();
  });
  // Sugerir categoría según reglas al escribir la descripción.
  form.description.addEventListener('blur', () => {
    if (form.categoryId.value) return;
    const cat = categorize(form.description.value, S.rules);
    if (cat) form.categoryId.value = cat;
  });
  sync();
  if (!tx) setTimeout(() => form.amount.focus(), 250);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = formData(form);
    const amount = toCents(String(d.amount).replace(',', '.'));
    if (!(amount > 0)) return toast('Escribe un importe mayor a cero.');
    if (d.type === 'transferencia' && (!d.toAccountId || d.toAccountId === d.accountId)) return toast('Elige otra cuenta de destino.');
    const record = {
      ...(tx || {}), type: d.type, amount, date: d.date, accountId: d.accountId,
      description: d.description.trim(), createdAt: tx?.createdAt || Date.now(),
      categoryId: d.type === 'transferencia' ? null : (d.categoryId || null),
      debtId: d.type === 'gasto' ? (d.debtId || null) : null,
      toAccountId: d.type === 'transferencia' ? d.toAccountId : null,
      toAmount: d.type === 'transferencia' && d.toAmount ? toCents(String(d.toAmount).replace(',', '.')) : null,
    };
    await db.put('transactions', record);
    closeSheet(); toast('Guardado'); await load(); render();
  });
  $('[data-delete]', form)?.addEventListener('click', async () => {
    if (!confirm('¿Eliminar este movimiento?')) return;
    await db.del('transactions', tx.id);
    closeSheet(); toast('Eliminado'); await load(); render();
  });
}

// ---------- Presupuestos ----------
async function budgetsView() {
  const spent = spentByCategory(S.accounts, S.transactions, S.month);
  const rows = S.budgets.map(b => ({ b, cat: byId(S.categories, b.categoryId), s: spent[b.categoryId]?.[b.currency] || 0 }))
    .sort((a, b) => (a.cat?.name || '').localeCompare(b.cat?.name || '', 'es'));
  const totals = {};
  for (const { b, s } of rows) { totals[b.currency] ??= { s: 0, l: 0 }; totals[b.currency].s += s; totals[b.currency].l += b.amount; }
  return `
    <header class="page-head"><h1>Presupuestos</h1><button class="link" id="add-budget">Agregar</button></header>
    ${monthNav()}
    ${Object.entries(totals).map(([c, t]) => `
      <div class="card summary">
        <div class="summary-label">Total presupuestado · ${c}</div>
        <div class="summary-value">${money(t.l - t.s, c)} <small>disponibles</small></div>
        ${progress(t.s, t.l)}
        <div class="muted">${money(t.s, c)} gastado de ${money(t.l, c)}</div>
      </div>`).join('')}
    <div class="card">${rows.map(({ b, cat, s }) => `
      <button class="budget" data-budget="${b.id}">
        <div class="budget-line"><span>${esc(catLabel(cat))}</span><span class="${s > b.amount ? 'neg' : ''}">${money(s, b.currency)} / ${money(b.amount, b.currency)}</span></div>
        ${progress(s, b.amount)}
        <div class="muted small">${s > b.amount ? `Te pasaste por ${money(s - b.amount, b.currency)}` : `Quedan ${money(b.amount - s, b.currency)}`}</div>
      </button>`).join('') || '<p class="empty">Define un límite mensual por categoría para ver cuánto te queda.</p>'}</div>`;
}
budgetsView.after = (root) => {
  $('#add-budget', root).addEventListener('click', () => budgetForm());
  $$('[data-budget]', root).forEach(b => b.addEventListener('click', () => budgetForm(byId(S.budgets, b.dataset.budget))));
};

function budgetForm(b) {
  const cats = S.categories.filter(c => c.kind === 'gasto');
  const sheet = openSheet(b ? 'Editar presupuesto' : 'Nuevo presupuesto', `
    <form class="form">
      <label class="field"><span>Categoría</span><select name="categoryId" required>${options(cats, b?.categoryId, { label: catLabel })}</select></label>
      <label class="field"><span>Límite mensual</span><input name="amount" inputmode="decimal" required value="${b ? fromCents(b.amount) : ''}" placeholder="0.00"></label>
      <label class="field"><span>Moneda</span><select name="currency">${options(CURRENCIES, b?.currency || 'MXN')}</select></label>
      <button class="btn primary">Guardar</button>
      ${b ? '<button type="button" class="btn danger" data-delete>Eliminar</button>' : ''}
    </form>`);
  const form = $('form', sheet);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = formData(form);
    const amount = toCents(d.amount.replace(',', '.'));
    if (!(amount > 0)) return toast('Escribe un límite mayor a cero.');
    if (!b && S.budgets.some(x => x.categoryId === d.categoryId && x.currency === d.currency)) return toast('Esa categoría ya tiene presupuesto.');
    await db.put('budgets', { ...(b || {}), categoryId: d.categoryId, amount, currency: d.currency });
    closeSheet(); await load(); render();
  });
  $('[data-delete]', form)?.addEventListener('click', async () => { await db.del('budgets', b.id); closeSheet(); await load(); render(); });
}

// ---------- Deudas ----------
async function debtsView() {
  const bal = balances(S.accounts, S.transactions);
  const cards = S.accounts.filter(a => a.type === 'credito');
  const totals = {};
  const debts = S.debts.map(d => {
    const left = debtRemaining(d, S.transactions);
    totals[d.currency] = (totals[d.currency] || 0) + left;
    return { d, left, due: nextDueDate(d) };
  });
  for (const a of cards) if (bal[a.id] < 0) totals[a.currency] = (totals[a.currency] || 0) - bal[a.id];
  return `
    <header class="page-head"><h1>Deudas</h1><button class="link" id="add-debt">Agregar</button></header>
    ${Object.keys(totals).length ? `<div class="card summary"><div class="summary-label">Debes en total</div>
      ${Object.entries(totals).map(([c, v]) => `<div class="summary-value neg">${money(v, c)}</div>`).join('')}</div>` : ''}
    ${cards.length ? `<h3 class="section-title">Tarjetas de crédito</h3><div class="card list">${cards.map(a => `
      <a class="row" href="#/movimientos/${a.id}">
        <span class="row-icon">💳</span>
        <span class="row-main"><span class="row-title">${esc(a.name)}</span><span class="row-sub">${bal[a.id] < 0 ? 'Saldo por pagar' : 'Sin saldo pendiente'}</span></span>
        <span class="row-amount ${bal[a.id] < 0 ? 'gasto' : ''}">${money(Math.abs(bal[a.id]), a.currency)}</span>
      </a>`).join('')}</div>
      <p class="hint">Para pagar la tarjeta registra una transferencia desde tu cuenta de débito hacia la tarjeta.</p>` : ''}
    <h3 class="section-title">Préstamos y otras deudas</h3>
    ${debts.map(({ d, left, due }) => `
      <div class="card debt">
        <button class="debt-head" data-debt="${d.id}">
          <span><strong>${esc(d.name)}</strong><br><span class="muted small">${esc(d.creditor || '')}${d.rate ? ` · ${d.rate}% anual` : ''}</span></span>
          <span class="right"><strong>${money(left, d.currency)}</strong><br><span class="muted small">de ${money(d.principal, d.currency)}</span></span>
        </button>
        ${progress(d.principal - left, d.principal)}
        <div class="debt-foot">
          <span class="muted small">${left === 0 ? '¡Pagada! 🎉' : due ? `Próximo pago: ${due.toLocaleDateString('es-MX', { day: 'numeric', month: 'short' })}${d.minPayment ? ` · mínimo ${money(d.minPayment, d.currency)}` : ''}` : ''}</span>
          ${left > 0 ? `<button class="btn small" data-pay="${d.id}">Registrar pago</button>` : ''}
        </div>
      </div>`).join('') || '<p class="empty">Agrega préstamos o deudas para seguir cuánto te falta.</p>'}`;
}
debtsView.after = (root) => {
  $('#add-debt', root).addEventListener('click', () => debtForm());
  $$('[data-debt]', root).forEach(b => b.addEventListener('click', () => debtForm(byId(S.debts, b.dataset.debt))));
  $$('[data-pay]', root).forEach(b => b.addEventListener('click', () => {
    const d = byId(S.debts, b.dataset.pay);
    const pago = S.categories.find(c => c.name === 'Pago de deuda');
    const acc = S.accounts.find(a => a.currency === d.currency && a.type !== 'credito') || S.accounts[0];
    txForm(null, { type: 'gasto', debtId: d.id, categoryId: pago?.id, accountId: acc?.id, amount: d.minPayment || 0, description: `Pago ${d.name}` });
  }));
};

function debtForm(d) {
  const sheet = openSheet(d ? 'Editar deuda' : 'Nueva deuda', `
    <form class="form">
      <label class="field"><span>Nombre</span><input name="name" required value="${esc(d?.name || '')}" placeholder="Ej. Préstamo auto"></label>
      <label class="field"><span>Acreedor</span><input name="creditor" value="${esc(d?.creditor || '')}" placeholder="Banco o persona"></label>
      <label class="field"><span>Saldo inicial</span><input name="principal" inputmode="decimal" required value="${d ? fromCents(d.principal) : ''}" placeholder="0.00"></label>
      <label class="field"><span>Moneda</span><select name="currency">${options(CURRENCIES, d?.currency || 'MXN')}</select></label>
      <label class="field"><span>Tasa anual (%)</span><input name="rate" inputmode="decimal" value="${d?.rate ?? ''}" placeholder="Opcional"></label>
      <label class="field"><span>Pago mínimo</span><input name="minPayment" inputmode="decimal" value="${d?.minPayment ? fromCents(d.minPayment) : ''}" placeholder="Opcional"></label>
      <label class="field"><span>Día de pago</span><input name="dueDay" type="number" min="1" max="31" value="${d?.dueDay || ''}" placeholder="1 a 31"></label>
      <button class="btn primary">Guardar</button>
      ${d ? '<button type="button" class="btn danger" data-delete>Eliminar</button>' : ''}
    </form>`);
  const form = $('form', sheet);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = formData(form);
    const principal = toCents(v.principal.replace(',', '.'));
    if (!(principal > 0)) return toast('Escribe un saldo mayor a cero.');
    await db.put('debts', {
      ...(d || {}), name: v.name.trim(), creditor: v.creditor.trim(), principal, currency: v.currency,
      rate: v.rate ? Number(v.rate.replace(',', '.')) : null,
      minPayment: v.minPayment ? toCents(v.minPayment.replace(',', '.')) : 0,
      dueDay: v.dueDay ? Number(v.dueDay) : null,
    });
    closeSheet(); await load(); render();
  });
  $('[data-delete]', form)?.addEventListener('click', async () => {
    if (!confirm('¿Eliminar esta deuda? Los pagos registrados se conservan como gastos.')) return;
    await db.del('debts', d.id);
    for (const t of S.transactions.filter(t => t.debtId === d.id)) await db.put('transactions', { ...t, debtId: null });
    closeSheet(); await load(); render();
  });
}

// ---------- Más ----------
async function moreView() {
  const item = (href, icon, title, sub) => `<a class="row" href="${href}"><span class="row-icon">${icon}</span><span class="row-main"><span class="row-title">${title}</span><span class="row-sub">${sub}</span></span><span class="chev">›</span></a>`;
  return `
    <header class="page-head"><h1>Más</h1></header>
    <div class="card list">
      ${item('#/importar', '📥', 'Importar del banco', 'Archivo CSV u OFX de BBVA, Nu, Expatrio…')}
      ${item('#/cuentas', '🏦', 'Cuentas', `${S.accounts.length} cuentas`)}
      ${item('#/categorias', '🏷️', 'Categorías', `${S.categories.length} categorías`)}
      ${item('#/reglas', '🪄', 'Reglas automáticas', `${S.rules.length} reglas para categorizar`)}
      ${item('#/respaldo', '💾', 'Respaldo', 'Exportar o restaurar tus datos')}
      ${item('#/instalar', '📱', 'Instalar en el iPhone', 'Añadir a la pantalla de inicio')}
    </div>
    <p class="hint">Tus datos se guardan solo en este teléfono. Haz un respaldo de vez en cuando.</p>`;
}

const back = (href = '#/mas') => `<a class="back" href="${href}">‹ Más</a>`;

// ---------- Cuentas ----------
async function accountsView() {
  const bal = balances(S.accounts, S.transactions);
  return `
    ${back()}
    <header class="page-head"><h1>Cuentas</h1><button class="link" id="add-account">Agregar</button></header>
    <div class="card list">${S.accounts.map(a => `
      <button class="row" data-account="${a.id}">
        <span class="row-main"><span class="row-title">${esc(a.name)}</span><span class="row-sub">${esc(ACCOUNT_TYPES[a.type])} · ${a.currency}</span></span>
        <span class="row-amount">${money(bal[a.id], a.currency)}</span>
      </button>`).join('')}</div>
    <p class="hint">El saldo inicial es lo que tenía la cuenta antes del primer movimiento que registraste. En tarjetas de crédito escribe la deuda como número negativo.</p>`;
}
accountsView.after = (root) => {
  $('#add-account', root).addEventListener('click', () => accountForm());
  $$('[data-account]', root).forEach(b => b.addEventListener('click', () => accountForm(byId(S.accounts, b.dataset.account))));
};

function accountForm(a) {
  const sheet = openSheet(a ? 'Editar cuenta' : 'Nueva cuenta', `
    <form class="form">
      <label class="field"><span>Nombre</span><input name="name" required value="${esc(a?.name || '')}"></label>
      <label class="field"><span>Tipo</span><select name="type">${options(Object.entries(ACCOUNT_TYPES).map(([id, name]) => ({ id, name })), a?.type || 'debito')}</select></label>
      <label class="field"><span>Moneda</span><select name="currency">${options(CURRENCIES, a?.currency || 'MXN')}</select></label>
      <label class="field"><span>Saldo inicial</span><input name="openingBalance" inputmode="decimal" value="${a ? fromCents(a.openingBalance) : '0'}"></label>
      <button class="btn primary">Guardar</button>
      ${a ? '<button type="button" class="btn danger" data-delete>Eliminar</button>' : ''}
    </form>`);
  const form = $('form', sheet);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = formData(form);
    await db.put('accounts', { ...(a || {}), name: v.name.trim(), type: v.type, currency: v.currency, openingBalance: toCents(String(v.openingBalance || 0).replace(',', '.')) });
    closeSheet(); await load(); render();
  });
  $('[data-delete]', form)?.addEventListener('click', async () => {
    if (S.transactions.some(t => t.accountId === a.id || t.toAccountId === a.id)) return toast('La cuenta tiene movimientos; elimínalos primero.');
    await db.del('accounts', a.id); closeSheet(); await load(); render();
  });
}

// ---------- Categorías ----------
async function categoriesView() {
  const list = (kind) => S.categories.filter(c => c.kind === kind).map(c => `
    <button class="row" data-cat="${c.id}"><span class="row-icon">${esc(c.icon || '•')}</span><span class="row-main"><span class="row-title">${esc(c.name)}</span></span><span class="chev">›</span></button>`).join('');
  return `
    ${back()}
    <header class="page-head"><h1>Categorías</h1><button class="link" id="add-cat">Agregar</button></header>
    <h3 class="section-title">Gastos</h3><div class="card list">${list('gasto')}</div>
    <h3 class="section-title">Ingresos</h3><div class="card list">${list('ingreso')}</div>`;
}
categoriesView.after = (root) => {
  $('#add-cat', root).addEventListener('click', () => catForm());
  $$('[data-cat]', root).forEach(b => b.addEventListener('click', () => catForm(byId(S.categories, b.dataset.cat))));
};

function catForm(c) {
  const sheet = openSheet(c ? 'Editar categoría' : 'Nueva categoría', `
    <form class="form">
      <label class="field"><span>Nombre</span><input name="name" required value="${esc(c?.name || '')}"></label>
      <label class="field"><span>Ícono (emoji)</span><input name="icon" maxlength="4" value="${esc(c?.icon || '')}" placeholder="🙂"></label>
      <label class="field"><span>Tipo</span><select name="kind">${options([{ id: 'gasto', name: 'Gasto' }, { id: 'ingreso', name: 'Ingreso' }], c?.kind || 'gasto')}</select></label>
      <button class="btn primary">Guardar</button>
      ${c ? '<button type="button" class="btn danger" data-delete>Eliminar</button>' : ''}
    </form>`);
  const form = $('form', sheet);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = formData(form);
    await db.put('categories', { ...(c || {}), name: v.name.trim(), icon: v.icon.trim(), kind: v.kind });
    closeSheet(); await load(); render();
  });
  $('[data-delete]', form)?.addEventListener('click', async () => {
    if (S.transactions.some(t => t.categoryId === c.id) || S.budgets.some(b => b.categoryId === c.id)) return toast('La categoría está en uso.');
    await db.del('categories', c.id); closeSheet(); await load(); render();
  });
}

// ---------- Reglas ----------
async function rulesView() {
  return `
    ${back()}
    <header class="page-head"><h1>Reglas</h1></header>
    <p class="hint">Si la descripción de un movimiento contiene el texto, se le asigna la categoría. Se crean solas cuando corriges categorías al importar.</p>
    <form class="card form inline-form" id="rule-form">
      <input name="match" placeholder="Texto, ej. OXXO" required aria-label="Texto">
      <select name="categoryId" required aria-label="Categoría">${options(S.categories, '', { label: catLabel })}</select>
      <button class="btn primary small">Agregar</button>
    </form>
    <div class="card list">${S.rules.map(r => `
      <div class="row"><span class="row-main"><span class="row-title">“${esc(r.match)}”</span><span class="row-sub">${esc(catLabel(byId(S.categories, r.categoryId)))}</span></span>
      <button class="icon-btn" data-del-rule="${r.id}" aria-label="Eliminar regla">✕</button></div>`).join('') || '<p class="empty">Sin reglas todavía.</p>'}</div>`;
}
rulesView.after = (root) => {
  $('#rule-form', root).addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = formData(e.target);
    await db.put('rules', { match: v.match.trim(), categoryId: v.categoryId });
    await load(); render();
  });
  $$('[data-del-rule]', root).forEach(b => b.addEventListener('click', async () => { await db.del('rules', b.dataset.delRule); await load(); render(); }));
};

// ---------- Respaldo ----------
async function backupView() {
  return `
    ${back()}
    <header class="page-head"><h1>Respaldo</h1></header>
    <div class="card pad">
      <p>Guarda una copia de todos tus datos en un archivo. En el iPhone puedes guardarlo en Archivos o en iCloud Drive.</p>
      <button class="btn primary" id="export">Exportar respaldo</button>
    </div>
    <div class="card pad">
      <p>Restaurar reemplaza todos los datos actuales con los del archivo.</p>
      <label class="btn">Restaurar desde archivo<input type="file" id="restore" accept=".json,application/json" hidden></label>
    </div>`;
}
backupView.after = (root) => {
  $('#export', root).addEventListener('click', async () => {
    const data = await exportAll();
    await download(`finanzas-respaldo-${today()}.json`, JSON.stringify(data));
  });
  $('#restore', root).addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await readFileText(file));
      if (!confirm('Esto reemplazará todos tus datos actuales. ¿Continuar?')) return;
      await importAll(data);
      await load(); toast('Datos restaurados'); location.hash = '#/inicio';
    } catch (err) { toast(err.message || 'No se pudo leer el archivo.'); }
  });
};

// ---------- Instalar ----------
async function installView() {
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  return `
    ${back()}
    <header class="page-head"><h1>Instalar</h1></header>
    <div class="card pad">
      ${standalone ? '<p>✅ Ya estás usando la app instalada.</p>' : `
      <ol class="steps">
        <li>Abre esta página en <strong>Safari</strong>.</li>
        <li>Toca el botón <strong>Compartir</strong> (el cuadro con la flecha hacia arriba).</li>
        <li>Elige <strong>Añadir a pantalla de inicio</strong> y luego <strong>Añadir</strong>.</li>
        <li>Abre la app desde el nuevo ícono. Funciona sin internet.</li>
      </ol>`}
    </div>`;
}

// ---------- Arranque ----------
async function start() {
  await seedIfEmpty();
  await load();
  persistStorage();
  window.addEventListener('hashchange', () => { closeSheet(); render(); window.scrollTo(0, 0); });
  await render();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

start();
