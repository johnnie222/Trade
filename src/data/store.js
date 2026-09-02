/**
 * Storage adapters.
 *
 * The repository never touches IndexedDB directly. It talks to this tiny
 * interface, which has two implementations: IdbStore in the browser and
 * MemoryStore everywhere else. That is what makes every line of repository
 * logic testable in Node, where IndexedDB does not exist.
 *
 * Interface (all async):
 *   get(table, id)            -> record | null
 *   put(table, record)        -> record
 *   putMany(table, records)   -> records
 *   delete(table, id)         -> void
 *   all(table)                -> record[]
 *   where(table, field, val)  -> record[]
 *   clear(table)              -> void
 */

export const TABLES = ['trades', 'events', 'journal', 'settings'];

export class MemoryStore {
  constructor() {
    this.data = new Map(TABLES.map((t) => [t, new Map()]));
  }

  #table(name) {
    const t = this.data.get(name);
    if (!t) throw new Error(`Unknown table: ${name}`);
    return t;
  }

  async get(table, id) {
    return structuredClone(this.#table(table).get(id) ?? null);
  }

  async put(table, record) {
    if (!record?.id) throw new Error('Records need an id');
    this.#table(table).set(record.id, structuredClone(record));
    return record;
  }

  async putMany(table, records) {
    for (const r of records) await this.put(table, r);
    return records;
  }

  async delete(table, id) {
    this.#table(table).delete(id);
  }

  async all(table) {
    return structuredClone([...this.#table(table).values()]);
  }

  async where(table, field, value) {
    return (await this.all(table)).filter((r) => r[field] === value);
  }

  async clear(table) {
    this.#table(table).clear();
  }
}

/* ------------------------------------------------------------------ */
/* IndexedDB                                                           */
/* ------------------------------------------------------------------ */

const DB_NAME = 'trade-journal';
const DB_VERSION = 1;

/**
 * Browser implementation. Not exercised by the Node test suite for the obvious
 * reason; it is a thin mechanical translation of the same interface, and every
 * behaviour that could actually be wrong lives in the repository above it.
 */
export class IdbStore {
  constructor(db) {
    this.db = db;
  }

  static async open() {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('trades')) {
          d.createObjectStore('trades', { keyPath: 'id' });
        }
        if (!d.objectStoreNames.contains('events')) {
          const s = d.createObjectStore('events', { keyPath: 'id' });
          s.createIndex('tradeId', 'tradeId', { unique: false });
        }
        if (!d.objectStoreNames.contains('journal')) {
          d.createObjectStore('journal', { keyPath: 'id' });
        }
        if (!d.objectStoreNames.contains('settings')) {
          d.createObjectStore('settings', { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return new IdbStore(db);
  }

  #tx(table, mode) {
    return this.db.transaction(table, mode).objectStore(table);
  }

  #req(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async get(table, id) {
    return (await this.#req(this.#tx(table, 'readonly').get(id))) ?? null;
  }

  async put(table, record) {
    await this.#req(this.#tx(table, 'readwrite').put(record));
    return record;
  }

  async putMany(table, records) {
    // One transaction for the whole batch, so a partial write cannot survive.
    const tx = this.db.transaction(table, 'readwrite');
    const store = tx.objectStore(table);
    for (const r of records) store.put(r);
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    return records;
  }

  async delete(table, id) {
    await this.#req(this.#tx(table, 'readwrite').delete(id));
  }

  async all(table) {
    return this.#req(this.#tx(table, 'readonly').getAll());
  }

  async where(table, field, value) {
    const store = this.#tx(table, 'readonly');
    if (store.indexNames.contains(field)) {
      return this.#req(store.index(field).getAll(value));
    }
    return (await this.all(table)).filter((r) => r[field] === value);
  }

  async clear(table) {
    await this.#req(this.#tx(table, 'readwrite').clear());
  }
}
