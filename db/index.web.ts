// db/index.web.ts
/**
 * The same database API as ./index.ts, on the web, with one deliberate
 * difference: nothing is written to disk.
 *
 * The app is built around SQL. Every screen, every function in queries.ts and
 * the whole of sync.ts speak it, so the cheapest honest way to run all of that
 * in a browser is to give it a real SQLite - sql.js, which is SQLite compiled
 * to WebAssembly - rather than to write a second data layer against Supabase
 * and then keep the two agreeing forever.
 *
 * What makes this "no offline mode" is where the database lives. It is opened
 * in memory, never persisted, and dies with the tab. So:
 *
 *   - a reload starts empty, and the app must pull from Supabase to show
 *     anything at all, which means the web build genuinely requires a network;
 *   - there is no store of work from a previous session that could still be
 *     waiting to go up, so there is no offline queue to reconcile;
 *   - a write still lands here first, because that is what the screens expect,
 *     but it is pushed immediately rather than parked for later.
 *
 * The database is a session cache, not storage. Treating it as anything more
 * is the mistake this file exists to prevent - which is why it is deliberately
 * not backed by OPFS or localStorage even though sql.js could be.
 */

import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js'
import { CREATE_TABLES_SQL, MIGRATIONS } from './bootstrapSql'
import { Artist, ChordList, Song, Lineup, LineupItem, Message, CalendarEvent } from './models'

let dbInstance: Database | null = null
let sqlJs: SqlJsStatic | null = null

/**
 * sql.js loads its WebAssembly as a separate file, which the bundler does not
 * fingerprint for us, so it is served from the CDN pinned to the exact version
 * in package.json. A mismatch between the JS and the .wasm fails at load.
 */
const SQL_JS_VERSION = '1.14.2'
const wasmUrl = (file: string) =>
  `https://cdnjs.cloudflare.com/ajax/libs/sql.js/${SQL_JS_VERSION}/${file}`

export async function initializeDatabase() {
  try {
    if (!sqlJs) {
      sqlJs = await initSqlJs({ locateFile: wasmUrl })
    }

    // No filename: SQLite opens this purely in memory.
    dbInstance = new sqlJs.Database()

    dbInstance.run(CREATE_TABLES_SQL)

    // A fresh database already has every column, so all of these are expected
    // to fail here. They are still run so that the schema this build uses is
    // the same statement list native uses, rather than a copy that can drift.
    for (const statement of MIGRATIONS) {
      try {
        dbInstance.run(statement)
      } catch (e) {}
    }

    console.log('Database initialized successfully (web, in-memory)')
    return dbInstance

  } catch (err) {
    console.error('Error initializing database:', err)
    throw err
  }
}

export function getDatabase() {
  if (!dbInstance) {
    throw new Error('Database not initialized. Call initializeDatabase() first.')
  }
  return dbInstance
}

/**
 * Throw away everything held for this session.
 *
 * Called on sign-out. On native the same data is kept on purpose - it is what
 * the user works from next time they open the app with no signal. Here it must
 * not be, because the next person to use this browser is not necessarily the
 * person who just signed out.
 *
 * The database is rebuilt rather than closed: signing back in without
 * reloading the page is an ordinary thing to do, and every caller after this
 * point still expects a database to be there.
 */
export async function resetDatabase(): Promise<void> {
  try {
    dbInstance?.close()
  } catch (e) {}
  dbInstance = null
  await initializeDatabase()
}

// ─── Single DB Queue (all reads and writes serialized) ────────────────────────
let dbQueue: Promise<any> = Promise.resolve()

export function queueDb<T>(fn: () => Promise<T>): Promise<T> {
  const next = dbQueue.then(() => fn())
  dbQueue = next.then(() => {}, () => {})
  return next
}

/**
 * Make a value something sql.js will accept.
 *
 * sql.js takes only numbers, strings, null and byte arrays. expo-sqlite is
 * looser, so values that native quietly coerced arrive here as errors instead -
 * and because syncPullFromSupabase catches per row, an unbindable value would
 * not look like a failure. It would look like that row was never on the server,
 * which is the worst way for the two platforms to disagree.
 *
 * The conversions match how the columns are already defined and read back:
 *
 *   undefined  -> NULL      optional fields are passed straight through by
 *                           screens; expo-sqlite treats these as NULL.
 *   boolean    -> 1 / 0     Postgres returns is_private and is_deleted as
 *                           booleans, while the columns are INTEGER and are
 *                           read back through Boolean(row.is_private).
 *   object     -> JSON      jsonb columns (assignments, instruments) come back
 *                           as objects or arrays, but are stored as TEXT and
 *                           parsed on read - the same JSON.stringify the push
 *                           side already applies in syncToSupabase.ts.
 */
function bindable(params: any[]): any[] {
  return params.map(p => {
    if (p === undefined) return null
    if (typeof p === 'boolean') return p ? 1 : 0
    if (p !== null && typeof p === 'object' && !ArrayBuffer.isView(p)) {
      return JSON.stringify(p)
    }
    return p
  })
}

// ─── RAW helpers (no queue wrapping) ─────────────────────────────────────────
async function rawQuery(sql: string, params: any[] = []) {
  const db = getDatabase()
  const stmt = db.prepare(sql)
  try {
    stmt.bind(bindable(params))
    const rows: any[] = []
    while (stmt.step()) rows.push(stmt.getAsObject())
    return rows
  } finally {
    stmt.free()
  }
}

async function rawExecute(sql: string, params: any[] = []) {
  const db = getDatabase()
  db.run(sql, bindable(params))
  // expo-sqlite resolves with { lastInsertRowId, changes }. Nothing in the app
  // reads either, but the shape is kept so the two platforms stay swappable.
  return { lastInsertRowId: 0, changes: db.getRowsModified() }
}

// ─── Public API (each call is queued) ────────────────────────────────────────
export function query(sql: string, params: any[] = []) {
  return queueDb(() => rawQuery(sql, params))
}

export function execute(sql: string, params: any[] = []) {
  return queueDb(() => rawExecute(sql, params))
}

export function queryOne(sql: string, params: any[] = []) {
  return queueDb(async () => {
    const rows = await rawQuery(sql, params)
    return rows[0] ?? null
  })
}

export function transaction(callback: (raw: {
  query: typeof rawQuery,
  execute: typeof rawExecute
}) => Promise<void>) {
  return queueDb(async () => {
    const db = getDatabase()
    try {
      db.run('BEGIN TRANSACTION')
      await callback({ query: rawQuery, execute: rawExecute })
      db.run('COMMIT')
    } catch (err) {
      try { db.run('ROLLBACK') } catch {}
      throw err
    }
  })
}

export async function getOrInitDatabase() {
  if (!dbInstance) {
    await initializeDatabase()
  }
  return dbInstance!
}

export type { Artist, ChordList, Song, Lineup, LineupItem, Message, CalendarEvent }
