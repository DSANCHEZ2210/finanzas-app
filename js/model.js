// Datos iniciales, formato de dinero y cálculos.
import { db, uid } from './db.js';

export const CURRENCIES = ['MXN', 'EUR', 'USD'];

export const ACCOUNT_TYPES = {
  debito: 'Débito',
  credito: 'Tarjeta de crédito',
  efectivo: 'Efectivo',
  ahorro: 'Ahorro',
};

const DEFAULT_CATEGORIES = [
  ['Comida', 'gasto', '🍽️'], ['Súper', 'gasto', '🛒'], ['Transporte', 'gasto', '🚌'],
  ['Vivienda', 'gasto', '🏠'], ['Servicios', 'gasto', '💡'], ['Suscripciones', 'gasto', '📺'],
  ['Salud', 'gasto', '💊'], ['Ropa', 'gasto', '👕'], ['Ocio', 'gasto', '🎉'],
  ['Educación', 'gasto', '📚'], ['Viajes', 'gasto', '✈️'], ['Pago de deuda', 'gasto', '💳'],
  ['Comisiones', 'gasto', '🏦'], ['Otros gastos', 'gasto', '📦'],
  ['Sueldo', 'ingreso', '💼'], ['Freelance', 'ingreso', '🧑‍💻'], ['Reembolsos', 'ingreso', '↩️'],
  ['Otros ingresos', 'ingreso', '💰'],
];

const DEFAULT_ACCOUNTS = [
  ['BBVA Débito', 'debito', 'MXN'],
  ['Nu Débito', 'debito', 'MXN'],
  ['Nu Crédito', 'credito', 'MXN'],
  ['Expatrio', 'debito', 'EUR'],
  ['Efectivo', 'efectivo', 'MXN'],
];

export async function seedIfEmpty() {
  const cats = await db.all('categories');
  if (cats.length === 0) {
    await db.putMany('categories', DEFAULT_CATEGORIES.map(([name, kind, icon]) => ({ id: uid(), name, kind, icon })));
  }
  const accs = await db.all('accounts');
  if (accs.length === 0) {
    await db.putMany('accounts', DEFAULT_ACCOUNTS.map(([name, type, currency]) => ({ id: uid(), name, type, currency, openingBalance: 0 })));
  }
}

// Los importes se guardan en centavos (enteros) para evitar errores de redondeo.
export const toCents = (n) => Math.round(Number(n) * 100);
export const fromCents = (c) => (c || 0) / 100;

const fmtCache = {};
export function money(cents, currency = 'MXN') {
  const key = currency;
  fmtCache[key] ??= new Intl.NumberFormat('es-MX', { style: 'currency', currency, minimumFractionDigits: 2 });
  return fmtCache[key].format(fromCents(cents));
}

export const today = () => new Date().toISOString().slice(0, 10);
export const monthKey = (date) => date.slice(0, 7);
export function monthLabel(key) {
  const [y, m] = key.split('-').map(Number);
  const s = new Date(y, m - 1, 1).toLocaleDateString('es-MX', { month: 'long', year: 'numeric' });
  return s[0].toUpperCase() + s.slice(1);
}
export function shiftMonth(key, delta) {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
export function dateLabel(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('es-MX', { weekday: 'short', day: 'numeric', month: 'short' });
}

// Efecto de un movimiento sobre el saldo de cada cuenta.
export function balances(accounts, transactions) {
  const map = Object.fromEntries(accounts.map(a => [a.id, a.openingBalance || 0]));
  for (const t of transactions) {
    if (t.type === 'gasto') map[t.accountId] = (map[t.accountId] || 0) - t.amount;
    else if (t.type === 'ingreso') map[t.accountId] = (map[t.accountId] || 0) + t.amount;
    else if (t.type === 'transferencia') {
      map[t.accountId] = (map[t.accountId] || 0) - t.amount;
      map[t.toAccountId] = (map[t.toAccountId] || 0) + (t.toAmount ?? t.amount);
    }
  }
  return map;
}

// Totales del mes agrupados por moneda: { MXN: { ingresos, gastos } }.
export function monthTotals(accounts, transactions, month) {
  const cur = Object.fromEntries(accounts.map(a => [a.id, a.currency]));
  const out = {};
  for (const t of transactions) {
    if (monthKey(t.date) !== month || t.type === 'transferencia') continue;
    const c = cur[t.accountId] || 'MXN';
    out[c] ??= { ingresos: 0, gastos: 0 };
    if (t.type === 'ingreso') out[c].ingresos += t.amount;
    else out[c].gastos += t.amount;
  }
  return out;
}

// Gasto del mes por categoría y moneda: { [categoryId]: { MXN: cents } }.
export function spentByCategory(accounts, transactions, month) {
  const cur = Object.fromEntries(accounts.map(a => [a.id, a.currency]));
  const out = {};
  for (const t of transactions) {
    if (t.type !== 'gasto' || monthKey(t.date) !== month) continue;
    const c = cur[t.accountId] || 'MXN';
    out[t.categoryId] ??= {};
    out[t.categoryId][c] = (out[t.categoryId][c] || 0) + t.amount;
  }
  return out;
}

// Saldo restante de una deuda: saldo inicial menos los pagos vinculados.
export function debtRemaining(debt, transactions) {
  const paid = transactions.filter(t => t.debtId === debt.id).reduce((s, t) => s + t.amount, 0);
  return Math.max(0, debt.principal - paid);
}

export function nextDueDate(debt, from = new Date()) {
  if (!debt.dueDay) return null;
  const d = new Date(from.getFullYear(), from.getMonth(), debt.dueDay);
  if (d < new Date(from.getFullYear(), from.getMonth(), from.getDate())) d.setMonth(d.getMonth() + 1);
  return d;
}

// Aplica la primera regla cuyo texto aparezca en la descripción.
export function categorize(description, rules) {
  const text = (description || '').toLowerCase();
  const rule = rules.find(r => r.match && text.includes(r.match.toLowerCase()));
  return rule ? rule.categoryId : null;
}
