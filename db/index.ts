// db/index.ts
/**
 * Database initialization using expo-sqlite instead of WatermelonDB native modules
 * WatermelonDB requires native module linking which doesn't work in Expo managed workflow
 * This simplified approach provides SQLite persistence compatible with Expo
 *
 * This is the native database: a real file on disk, which is what lets the app
 * work with no network at all. The web build resolves to ./index.web.ts
 * instead, which keeps the same API over a database that only lives in memory.
 */

import * as SQLite from 'expo-sqlite'
import { CREATE_TABLES_SQL, MIGRATIONS } from './bootstrapSql'
import { Artist, ChordList, Song, Lineup, LineupItem, Message, FileDropper, ImportantAnnouncement, VersionDropper, CalendarEvent } from './models'

let dbInstance: SQLite.SQLiteDatabase | null = null

export async function initializeDatabase() {
  try {
    // Open database (creates if doesn't exist)
    dbInstance = await SQLite.openDatabaseAsync('savedworshipmusictool.db')

    await dbInstance.execAsync(`PRAGMA journal_mode = WAL;`)
    await dbInstance.execAsync(CREATE_TABLES_SQL)

    // Each of these fails when the column is already present. That is the check.
    for (const statement of MIGRATIONS) {
      try {
        await dbInstance.execAsync(statement)
      } catch (e) {}
    }

    console.log('Database initialized successfully')
    return dbInstance

  } catch (err) {
    console.error('Error initializing database:', err)
    throw err
  }
}
/**
 * The web build wipes its database on sign-out. Native deliberately does not.
 *
 * What is stored here is the thing that makes the app work with no signal, and
 * it belongs to a phone with one owner. Clearing it at sign-out would mean a
 * user who signs out and opens the app again on a train has nothing to play
 * from - so this is a no-op, and exists only so that sign-out can call it
 * without asking which platform it is on.
 */
export async function resetDatabase(): Promise<void> {}

export function getDatabase() {
  if (!dbInstance) {
    throw new Error('Database not initialized. Call initializeDatabase() first.')
  }
  return dbInstance
}

// ─── Single DB Queue (all reads and writes serialized) ────────────────────────
let dbQueue: Promise<any> = Promise.resolve()

export function queueDb<T>(fn: () => Promise<T>): Promise<T> {
  const next = dbQueue.then(() => fn())
  dbQueue = next.then(() => {}, () => {})
  return next
}

// ─── RAW helpers (no queue wrapping) ─────────────────────────────────────────
async function rawQuery(sql: string, params: any[] = []) {
  const db = getDatabase()
  const result = await db.getAllAsync(sql, params)
  return result || []
}

async function rawExecute(sql: string, params: any[] = []) {
  const db = getDatabase()
  return await db.runAsync(sql, params)
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
    const db = getDatabase()
    return (await db.getFirstAsync(sql, params)) ?? null
  })
}

export function transaction(callback: (raw: {
  query: typeof rawQuery,
  execute: typeof rawExecute
}) => Promise<void>) {
  return queueDb(async () => {
    const db = getDatabase()
    try {
      await db.execAsync('BEGIN TRANSACTION')
      await callback({ query: rawQuery, execute: rawExecute })
      await db.execAsync('COMMIT')
    } catch (err) {
      try { await db.execAsync('ROLLBACK') } catch {}
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