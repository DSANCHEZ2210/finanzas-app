// Almacenamiento local con IndexedDB. Todo vive en el teléfono.
const DB_NAME = 'finanzas';
const DB_VERSION = 1;
export const STORES = ['accounts', 'categories', 'transactions', 'budgets', 'debts', 'rules', 'importProfiles', 'settings'];

let dbPromise;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) {
          const store = db.createObjectStore(name, { keyPath: 'id' });
          if (name === 'transactions') {
            store.createIndex('date', 'date');
            store.createIndex('hash', 'hash');
          }
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    Promise.resolve(fn(s)).then(r => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

function reqP(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export const db = {
  all: (store) => tx(store, 'readonly', s => reqP(s.getAll())),
  get: (store, id) => tx(store, 'readonly', s => reqP(s.get(id))),
  put: (store, obj) => {
    if (!obj.id) obj.id = uid();
    return tx(store, 'readwrite', s => reqP(s.put(obj))).then(() => obj);
  },
  putMany: (store, list) => tx(store, 'readwrite', s => {
    for (const obj of list) { if (!obj.id) obj.id = uid(); s.put(obj); }
    return list;
  }),
  del: (store, id) => tx(store, 'readwrite', s => reqP(s.delete(id))),
  clear: (store) => tx(store, 'readwrite', s => reqP(s.clear())),
};

export async function exportAll() {
  const data = { app: 'finanzas-app', version: DB_VERSION, exportedAt: new Date().toISOString() };
  for (const name of STORES) data[name] = await db.all(name);
  return data;
}

export async function importAll(data) {
  if (!data || data.app !== 'finanzas-app') throw new Error('El archivo no es un respaldo de esta app.');
  for (const name of STORES) {
    await db.clear(name);
    if (Array.isArray(data[name])) await db.putMany(name, data[name]);
  }
}

export async function persistStorage() {
  // Pide al navegador no borrar los datos cuando haya poco espacio.
  try { if (navigator.storage?.persist) return await navigator.storage.persist(); } catch { /* sin soporte */ }
  return false;
}
