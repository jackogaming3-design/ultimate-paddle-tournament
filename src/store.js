'use strict';

// Storage: Postgres (Supabase) when DATABASE_URL is set, otherwise a local JSON file.
// Both keep an in-memory cache so live polling is cheap (the app runs as one instance).

const fs = require('fs');
const path = require('path');

class Locks {
  constructor() { this.chains = new Map(); }
  run(key, fn) {
    const prev = this.chains.get(key) || Promise.resolve();
    const next = prev.then(fn, fn);
    this.chains.set(key, next.catch(() => {}));
    return next;
  }
}

class FileStore {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'tournaments.json');
    this.photoDir = path.join(dir, 'photos');
    fs.mkdirSync(this.photoDir, { recursive: true });
    this.data = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : {};
    this.locks = new Locks();
    this.kind = 'file';
  }
  async init() {}
  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }
  async get(id) {
    const r = this.data[id];
    return r ? { doc: r.doc, version: r.version } : null;
  }
  async create(doc) {
    this.data[doc.id] = { doc, version: 1 };
    this.save();
    return { doc, version: 1 };
  }
  async mutate(id, fn) {
    return this.locks.run(id, async () => {
      const r = this.data[id];
      if (!r) throw Object.assign(new Error('Tournament not found'), { status: 404 });
      const doc = structuredClone(r.doc);
      const result = await fn(doc);
      r.doc = doc; r.version += 1;
      this.save();
      return { doc, version: r.version, result };
    });
  }
  async putPhoto(pid, tid, mime, buf) {
    fs.writeFileSync(path.join(this.photoDir, pid + '.bin'), buf);
    fs.writeFileSync(path.join(this.photoDir, pid + '.json'), JSON.stringify({ tid, mime }));
  }
  async getPhoto(pid) {
    const f = path.join(this.photoDir, pid + '.bin');
    if (!/^[\w-]+$/.test(pid) || !fs.existsSync(f)) return null;
    const meta = JSON.parse(fs.readFileSync(path.join(this.photoDir, pid + '.json'), 'utf8'));
    return { mime: meta.mime, data: fs.readFileSync(f) };
  }
}

class PgStore {
  constructor(url) {
    const { Pool } = require('pg');
    const local = /localhost|127\.0\.0\.1/.test(url);
    const flag = (process.env.PGSSL || '').toLowerCase();
    const ssl = flag === 'false' ? false : flag === 'true' || !local ? { rejectUnauthorized: false } : false;
    this.pool = new Pool({ connectionString: url, ssl, max: 5, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000 });
    this.pool.on('error', (e) => console.error('[db] idle client error:', e.message));
    this.cache = new Map();
    this.locks = new Locks();
    this.kind = 'postgres';
  }
  async init() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS upt_tournaments (
        id TEXT PRIMARY KEY,
        doc JSONB NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS upt_photos (
        player_id TEXT PRIMARY KEY,
        tournament_id TEXT NOT NULL,
        mime TEXT NOT NULL,
        data BYTEA NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
  }
  async get(id) {
    if (this.cache.has(id)) return this.cache.get(id);
    const { rows } = await this.pool.query('SELECT doc, version FROM upt_tournaments WHERE id = $1', [id]);
    if (!rows[0]) return null;
    const r = { doc: rows[0].doc, version: rows[0].version };
    this.cache.set(id, r);
    return r;
  }
  async create(doc) {
    await this.pool.query('INSERT INTO upt_tournaments (id, doc) VALUES ($1, $2)', [doc.id, doc]);
    const r = { doc, version: 1 };
    this.cache.set(doc.id, r);
    return r;
  }
  async mutate(id, fn) {
    return this.locks.run(id, async () => {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const { rows } = await client.query('SELECT doc, version FROM upt_tournaments WHERE id = $1 FOR UPDATE', [id]);
        if (!rows[0]) throw Object.assign(new Error('Tournament not found'), { status: 404 });
        const doc = rows[0].doc;
        const result = await fn(doc);
        const version = rows[0].version + 1;
        await client.query('UPDATE upt_tournaments SET doc = $2, version = $3, updated_at = now() WHERE id = $1', [id, doc, version]);
        await client.query('COMMIT');
        this.cache.set(id, { doc, version });
        return { doc, version, result };
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        this.cache.delete(id);
        throw e;
      } finally {
        client.release();
      }
    });
  }
  async putPhoto(pid, tid, mime, buf) {
    await this.pool.query(
      `INSERT INTO upt_photos (player_id, tournament_id, mime, data) VALUES ($1, $2, $3, $4)
       ON CONFLICT (player_id) DO UPDATE SET mime = EXCLUDED.mime, data = EXCLUDED.data`,
      [pid, tid, mime, buf]);
  }
  async getPhoto(pid) {
    const { rows } = await this.pool.query('SELECT mime, data FROM upt_photos WHERE player_id = $1', [pid]);
    return rows[0] ? { mime: rows[0].mime, data: rows[0].data } : null;
  }
}

function createStore() {
  const url = process.env.DATABASE_URL;
  if (url) return new PgStore(url);
  if (process.env.NODE_ENV === 'production') {
    console.warn('[store] DATABASE_URL is not set: using a local file. On Render this is wiped on every restart, so set DATABASE_URL to your Supabase connection string.');
  }
  return new FileStore(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
}

module.exports = { createStore };
