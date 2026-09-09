// lib/sync.ts
import { supabase } from './supabase'
import { query, execute, transaction } from '../db/index'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { isChordListPublic } from './chordListPrivacy'

const TABLES = [
  'user_profiles',
  'artists',
  'chord_lists',
  'songs',
  'lineups',
  'lineup_items',
  'messages',
  'file_droppers',
  'important_announcements',
  'important_messages',
  'version_droppers',
  'team_calendar_events',
  'contacts',
  'playlists',
  'playlist_items'
]

const PUBLIC_MANAGEMENT_TABLES = new Set([
  'lineups',
  'file_droppers',
  'important_announcements',
  'version_droppers',
  'important_messages',
  'team_calendar_events',
])

interface SyncOptions {
  includeOffline?: boolean
  maxRetries?: number
  conflictResolution?: 'server-wins' | 'client-wins'
}

type TableListener = () => void
const tableListeners: Map<string, Set<TableListener>> = new Map()

export function onTableChange(table: string, fn: TableListener): () => void {
  if (!tableListeners.has(table)) tableListeners.set(table, new Set())
  tableListeners.get(table)!.add(fn)
  return () => tableListeners.get(table)!.delete(fn)
}

function invalidateTable(table: string) {
  tableListeners.get(table)?.forEach(fn => fn())
}

let isSyncRunning = false

let syncQueue: Promise<void> = Promise.resolve()

async function guardedSync(userId: string, since: number) {
  syncQueue = syncQueue.then(async () => {
    if (isSyncRunning) return
    isSyncRunning = true
    try {
      await syncPullFromSupabase(userId, since)
    } finally {
      isSyncRunning = false
    }
  })
  await syncQueue
}

interface SyncStatus {
  isSyncing: boolean
  lastSyncTime: number
  syncError: string | null
  pendingChanges: number
}

let syncStatus: SyncStatus = {
  isSyncing: false,
  lastSyncTime: 0,
  syncError: null,
  pendingChanges: 0,
}

const syncListeners: Set<(status: SyncStatus) => void> = new Set()
const refreshListeners: Set<(table: string) => void> = new Set()

export function onDataRefresh(listener: (table: string) => void): () => void {
  refreshListeners.add(listener)
  return () => refreshListeners.delete(listener)
}

function notifyDataRefresh(table: string) {
  refreshListeners.forEach(l => l(table))
}

interface SyncLog {
  table: string
  lastSyncedAt: number
  recordsCount: number
}

export function onSyncStatusChange(listener: (status: SyncStatus) => void): () => void {
  syncListeners.add(listener)
  return () => syncListeners.delete(listener)
}

export function getSyncStatus(): SyncStatus {
  return { ...syncStatus }
}

function notifySyncStatusChange() {
  syncListeners.forEach(listener => listener({ ...syncStatus }))
}

function updateSyncStatus(partial: Partial<SyncStatus>) {
  syncStatus = { ...syncStatus, ...partial }
  notifySyncStatusChange()
}

function toSupabasePayload(record: any) {
  const { _synced, ...rest } = record
  return rest
}

function dedupeRowsById(rows: any[]) {
  const seen = new Set<string>()
  return rows.filter(row => {
    if (!row?.id || seen.has(row.id)) return false
    seen.add(row.id)
    return true
  })
}

async function upsertPulledRows(tableName: string, serverRecords: any[]) {
  if (!serverRecords.length) return

  for (const serverRecord of serverRecords) {
    try {
      const localRecord: any = await query(
        `SELECT * FROM ${tableName} WHERE id = ?`,
        [serverRecord.id]
      )
      const snakeCaseRecord = convertToSnakeCase(serverRecord)

      if (localRecord && localRecord.length > 0) {
        const localTime = localRecord[0].updated_at || 0
        const serverTime = serverRecord.updated_at || 0
        if (serverTime >= localTime) {
          const updates = Object.keys(snakeCaseRecord).map(k => `${k} = ?`).join(', ')
          await execute(
            `UPDATE ${tableName} SET ${updates}, _synced = 1 WHERE id = ?`,
            [...Object.values(snakeCaseRecord), serverRecord.id]
          )
        }
      } else {
        const columns = Object.keys(snakeCaseRecord).join(', ')
        const placeholders = Object.keys(snakeCaseRecord).map(() => '?').join(', ')
        await execute(
          `INSERT INTO ${tableName} (${columns}, _synced) VALUES (${placeholders}, 1)`,
          Object.values(snakeCaseRecord)
        )
      }
    } catch (err) {
      console.error(`Error upserting ${tableName}/${serverRecord.id}:`, err)
    }
  }
}

async function fetchPublicChordListRefs(lastSyncTime: number = 0) {
  let queryBuilder = supabase
    .from('chord_lists')
    .select('id, artist_id, is_private')

  if (lastSyncTime > 0) {
    queryBuilder = queryBuilder.gt('updated_at_iso', new Date(lastSyncTime).toISOString())
  }

  const { data, error } = await queryBuilder

  if (error) {
    console.error('Failed to fetch public chord list references:', error)
    return { chordListIds: [] as string[], artistIds: [] as string[] }
  }

  const publicRows = (data || []).filter(isChordListPublic)
  const chordListIds = [...new Set(publicRows.map(row => row.id).filter(Boolean))]
  const artistIds = [...new Set(publicRows.map(row => row.artist_id).filter(Boolean))]

  return { chordListIds, artistIds }
}

async function syncSharedChordLibraryTable(tableName: string, userId: string, lastSyncTime: number) {
  const lastSyncIso = lastSyncTime > 0 ? new Date(lastSyncTime).toISOString() : null

  if (tableName === 'artists') {
    const [{ data: ownArtists }, { artistIds }] = await Promise.all([
      (() => {
        let builder = supabase.from('artists').select('*').eq('user_id', userId)
        if (lastSyncIso) builder = builder.gt('updated_at_iso', lastSyncIso)
        return builder
      })(),
      fetchPublicChordListRefs(lastSyncTime),
    ])

    let publicArtists: any[] = []
    if (artistIds.length > 0) {
      let builder = supabase.from('artists').select('*').in('id', artistIds)
      if (lastSyncIso) builder = builder.gt('updated_at_iso', lastSyncIso)
      const { data } = await builder
      publicArtists = data || []
    }

    await upsertPulledRows(tableName, dedupeRowsById([...(ownArtists || []), ...publicArtists]))
    return true
  }

  if (tableName === 'chord_lists') {
    const [{ data: ownChordLists }, { data: allChordLists }] = await Promise.all([
      (() => {
        let builder = supabase.from('chord_lists').select('*').eq('user_id', userId)
        if (lastSyncIso) builder = builder.gt('updated_at_iso', lastSyncIso)
        return builder
      })(),
      (() => {
        let builder = supabase.from('chord_lists').select('*')
        if (lastSyncIso) builder = builder.gt('updated_at_iso', lastSyncIso)
        return builder
      })(),
    ])

    const publicChordLists = (allChordLists || []).filter(isChordListPublic)
    await upsertPulledRows(tableName, dedupeRowsById([...(ownChordLists || []), ...publicChordLists]))
    return true
  }

  if (tableName === 'songs') {
    const [{ data: ownSongs }, { chordListIds }] = await Promise.all([
      (() => {
        let builder = supabase.from('songs').select('*').eq('user_id', userId)
        if (lastSyncIso) builder = builder.gt('updated_at_iso', lastSyncIso)
        return builder
      })(),
      fetchPublicChordListRefs(lastSyncTime),
    ])

    let publicSongs: any[] = []
    if (chordListIds.length > 0) {
      let builder = supabase.from('songs').select('*').in('chord_list_id', chordListIds)
      if (lastSyncIso) builder = builder.gt('updated_at_iso', lastSyncIso)
      const { data } = await builder
      publicSongs = data || []
    }

    await upsertPulledRows(tableName, dedupeRowsById([...(ownSongs || []), ...publicSongs]))
    return true
  }

  return false
}

function isPublicManagementTable(tableName: string) {
  return PUBLIC_MANAGEMENT_TABLES.has(tableName)
}

async function countUnsyncedRecords(tableName: string, userId: string): Promise<number> {
  try {
    const results = await query(
      `SELECT COUNT(*) as count FROM ${tableName} WHERE _synced = 0 AND user_id = ?`,
      [userId]
    ) as { count: number }[]
    return results[0]?.count || 0
  } catch (err) {
    console.error(`Error counting unsynced records in ${tableName}:`, err)
    return 0
  }
}

export async function countPendingChanges(userId: string): Promise<number> {
  let total = 0
  for (const tableName of TABLES) {
    total += await countUnsyncedRecords(tableName, userId)
  }
  return total
}

export async function syncPushToSupabase(userId: string, options: SyncOptions = {}) {
  const { maxRetries = 3 } = options
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('role')
    .eq('user_id', userId)
    .single()

  if (!profile?.role) {
    console.warn('No role found for user — skipping push sync. Profile may not be initialized.')
    return
  }

  try {
    const unsyncedMessages: any[] = await query(
  `SELECT * FROM messages WHERE _synced = 0 AND sender_id = ?`,
  [userId]
)
for (const record of unsyncedMessages) {
  try {
    const payload = {
      id: record.id,
      sender_id: record.sender_id,
      receiver_id: record.receiver_id,
      text: record.text,
      created_at: record.created_at,
      updated_at: record.updated_at ?? Date.now(),
      is_deleted: record.is_deleted ?? 0,
      edited_at: record.edited_at ?? null,
      user_id: record.sender_id,   // ← maps sender_id → user_id for Supabase NOT NULL constraint
    }
    const { error } = await supabase
      .from('messages')
      .upsert(payload, { onConflict: 'id' })
    if (!error) {
      await execute(`UPDATE messages SET _synced = 1 WHERE id = ?`, [record.id])
    } else {
      console.warn(`Sync failed for messages/${record.id}:`, error)
    }
  } catch (err) {
    console.error(`Error pushing message ${record.id}:`, err)
  }
}

    for (const tableName of TABLES) {
      if (isPublicManagementTable(tableName)) {
        const unsyncedRecords: any[] = await query(
          `SELECT * FROM ${tableName} WHERE _synced = 0 AND user_id = ?`,
          [userId]
        )

        if (unsyncedRecords.length === 0) continue

        for (const record of unsyncedRecords) {
          let retries = 0
          let success = false

          while (retries < maxRetries && !success) {
            try {
              const data = toSupabasePayload(record)
              const timestamp = record.updated_at || Date.now()

              const { error } = await supabase.from(tableName).upsert(
                {
                  ...convertToSnakeCase(data),
                  user_id: userId,
                  updated_at: timestamp,
                  updated_at_iso: new Date(timestamp).toISOString(),
                },
                { onConflict: 'id' }
              )

              if (error) {
                console.warn(`Attempt ${retries + 1}: Failed to sync ${tableName}/${record.id}:`, error)
                retries++
                if (retries < maxRetries) {
                  await Promise.resolve()
                }
              } else {
                await execute(`UPDATE ${tableName} SET _synced = 1 WHERE id = ?`, [record.id])
                success = true
              }
            } catch (err) {
              console.error(`Error syncing ${tableName}/${record.id}:`, err)
              retries++
              if (retries < maxRetries) {
                await Promise.resolve()
              }
            }
          }

          if (!success) {
            console.error(`Failed to sync ${tableName}/${record.id} after ${maxRetries} retries`)
          }
        }

        continue
      }
      if (tableName === 'messages') continue
      const unsyncedRecords: any[] = await query(
        `SELECT * FROM ${tableName} WHERE _synced = 0 AND user_id = ?`,
        [userId]
      )

      if (unsyncedRecords.length === 0) continue

      for (const record of unsyncedRecords) {
        let retries = 0
        let success = false

        while (retries < maxRetries && !success) {
          try {
            const data = toSupabasePayload(record)
            const timestamp = record.updated_at || Date.now()
            const conflictColumn = tableName === 'user_profiles' ? 'user_id' : 'id'

            const { error } = await supabase.from(tableName).upsert(
              {
                ...convertToSnakeCase(data),
                user_id: userId,
                updated_at: timestamp,
                updated_at_iso: new Date(timestamp).toISOString(),
              },
              { onConflict: conflictColumn }
            )

              if (error) {
                console.warn(`Attempt ${retries + 1}: Failed to sync ${tableName}/${record.id}:`, error)
                retries++
                if (retries < maxRetries) {
                  await Promise.resolve()
                }
              } else {
              await execute(
                `UPDATE ${tableName} SET _synced = 1 WHERE id = ?`,
                [record.id]
              )
              success = true
            }
          } catch (err) {
            console.error(`Error syncing ${tableName}/${record.id}:`, err)
            retries++
            if (retries < maxRetries) {
              await Promise.resolve()
            }
          }
        }

        if (!success) {
          console.error(`Failed to sync ${tableName}/${record.id} after ${maxRetries} retries`)
        }
      }
    }
  } catch (err) {
    console.error('Error in syncPushToSupabase:', err)
    updateSyncStatus({ syncError: String(err) })
  }
}



export async function syncPullFromSupabase(userId: string, lastSyncTime: number = 0, options: SyncOptions = {}) {
  const { conflictResolution = 'server-wins' } = options

  try {
    for (const tableName of TABLES) {
      try {
        if (await syncSharedChordLibraryTable(tableName, userId, lastSyncTime)) {
          continue
        }

        // ─── MESSAGES ─────────────────────────────────────────────────────
        if (tableName === 'messages') {
          const { data: sentMessages } = await supabase
            .from('messages')
            .select('*')
            .eq('sender_id', userId)

          const { data: receivedMessages } = await supabase
            .from('messages')
            .select('*')
            .eq('receiver_id', userId)

          const { data: overallMessages } = await supabase
            .from('messages')
            .select('*')
            .eq('receiver_id', 'overall-chat')

          const combined = [
            ...(sentMessages || []),
            ...(receivedMessages || []),
            ...(overallMessages || []),
          ]

          const seen = new Set()
          const data = combined.filter(row => {
            if (seen.has(row.id)) return false
            seen.add(row.id)
            return true
          })

          const serverIds = new Set<string>(data.map(row => row.id).filter(Boolean))

          if (data.length > 0) {
            for (const serverRecord of data) {
              try {
                const localRecord: any = await query(
                  `SELECT * FROM messages WHERE id = ?`,
                  [serverRecord.id]
                )
                const snakeCaseRecord = convertToSnakeCase(serverRecord)

                if (localRecord && localRecord.length > 0) {
                  const localTime = localRecord[0].updated_at || 0
                  const serverTime = serverRecord.updated_at || 0
                  if (conflictResolution === 'server-wins' || serverTime >= localTime) {
                    const updates = Object.keys(snakeCaseRecord).map(k => `${k} = ?`).join(', ')
                    await execute(
                      `UPDATE messages SET ${updates}, _synced = 1 WHERE id = ?`,
                      [...Object.values(snakeCaseRecord), serverRecord.id]
                    )
                  }
                } else {
                  const columns = Object.keys(snakeCaseRecord).join(', ')
                  const placeholders = Object.keys(snakeCaseRecord).map(() => '?').join(', ')
                  await execute(
                    `INSERT INTO messages (${columns}, _synced) VALUES (${placeholders}, 1)`,
                    Object.values(snakeCaseRecord)
                  )
                }
              } catch (err) {
                console.error(`Error upserting messages/${serverRecord.id}:`, err)
              }
            }
          }

          const localScopeRows: any[] = await query(
            `SELECT id, _synced FROM messages WHERE sender_id = ? OR receiver_id = ? OR receiver_id = 'overall-chat'`,
            [userId, userId]
          )

          for (const localRow of localScopeRows) {
            if (localRow.id && !serverIds.has(localRow.id)) {
              await execute(`DELETE FROM messages WHERE id = ?`, [localRow.id])
            }
          }
          continue
        }

        // ─── CONTACTS ─────────────────────────────────────────────────────
        if (tableName === 'contacts') {
          const { data: sentContacts } = await supabase
            .from('contacts')
            .select('*')
            .eq('user_id', userId)

          const { data: receivedContacts } = await supabase
            .from('contacts')
            .select('*')
            .eq('contact_user_id', userId)

          const combined = [
            ...(sentContacts || []),
            ...(receivedContacts || []),
          ]

          const seen = new Set()
          const data = combined.filter(row => {
            if (seen.has(row.id)) return false
            seen.add(row.id)
            return true
          })

          if (data.length > 0) {
            for (const serverRecord of data) {
              try {
                const localRecord: any = await query(
                  `SELECT * FROM contacts WHERE id = ?`,
                  [serverRecord.id]
                )
                const snakeCaseRecord = convertToSnakeCase(serverRecord)

                if (localRecord && localRecord.length > 0) {
                  const localTime = localRecord[0].updated_at || 0
                  const serverTime = serverRecord.updated_at || 0
                  if (conflictResolution === 'server-wins' || serverTime >= localTime) {
                    const updates = Object.keys(snakeCaseRecord).map(k => `${k} = ?`).join(', ')
                    await execute(
                      `UPDATE contacts SET ${updates}, _synced = 1 WHERE id = ?`,
                      [...Object.values(snakeCaseRecord), serverRecord.id]
                    )
                  }
                } else {
                  const columns = Object.keys(snakeCaseRecord).join(', ')
                  const placeholders = Object.keys(snakeCaseRecord).map(() => '?').join(', ')
                  await execute(
                    `INSERT INTO contacts (${columns}, _synced) VALUES (${placeholders}, 1)`,
                    Object.values(snakeCaseRecord)
                  )
                }
              } catch (err) {
                console.error(`Error upserting contacts/${serverRecord.id}:`, err)
              }
            }
          }
          continue
        }

        // ─── USER_PROFILES ────────────────────────────────────────────────
        if (tableName === 'user_profiles') {
          const { data, error } = await supabase
            .from('user_profiles')
            .select('*')

          if (error) {
            console.error(`Failed to fetch user_profiles:`, error)
            continue
          }

          if (!data || data.length === 0) continue

          for (const serverRecord of data) {
            try {
              const localRecord: any = await query(
                `SELECT * FROM user_profiles WHERE user_id = ?`,
                [serverRecord.user_id]
              )
              const snakeCaseRecord = convertToSnakeCase(serverRecord)

              if (localRecord && localRecord.length > 0) {
                const localTime = localRecord[0].updated_at || 0
                const serverTime = serverRecord.updated_at || 0
                if (conflictResolution === 'server-wins' || serverTime >= localTime) {
                  const updates = Object.keys(snakeCaseRecord).map(k => `${k} = ?`).join(', ')
                  await execute(
                    `UPDATE user_profiles SET ${updates}, _synced = 1 WHERE user_id = ?`,
                    [...Object.values(snakeCaseRecord), serverRecord.user_id]
                  )
                }
              } else {
                const columns = Object.keys(snakeCaseRecord).join(', ')
                const placeholders = Object.keys(snakeCaseRecord).map(() => '?').join(', ')
                await execute(
                  `INSERT OR REPLACE INTO user_profiles (${columns}, _synced) VALUES (${placeholders}, 1)`,
                  Object.values(snakeCaseRecord)
                )
              }
            } catch (err) {
              console.error(`Error upserting user_profiles/${serverRecord.id}:`, err)
            }
          }
          continue
        }

        if (isPublicManagementTable(tableName)) {
          let supabaseQuery = supabase
            .from(tableName)
            .select('*')

          if (lastSyncTime > 0) {
            const lastSyncIso = new Date(lastSyncTime).toISOString()
            supabaseQuery = supabaseQuery.gt('updated_at_iso', lastSyncIso)
          }

          const { data, error } = await supabaseQuery

          if (error) {
            console.error(`Failed to fetch ${tableName}:`, error)
            continue
          }

          if (!data || data.length === 0) continue

          for (const serverRecord of data) {
            try {
              const localRecord: any = await query(
                `SELECT * FROM ${tableName} WHERE id = ?`,
                [serverRecord.id]
              )
              const snakeCaseRecord = convertToSnakeCase(serverRecord)

              if (localRecord && localRecord.length > 0) {
                const localTime = localRecord[0].updated_at || 0
                const serverTime = serverRecord.updated_at || 0
                if (conflictResolution === 'server-wins' || serverTime >= localTime) {
                  const updates = Object.keys(snakeCaseRecord).map(k => `${k} = ?`).join(', ')
                  await execute(
                    `UPDATE ${tableName} SET ${updates}, _synced = 1 WHERE id = ?`,
                    [...Object.values(snakeCaseRecord), serverRecord.id]
                  )
                }
              } else {
                const columns = Object.keys(snakeCaseRecord).join(', ')
                const placeholders = Object.keys(snakeCaseRecord).map(() => '?').join(', ')
                await execute(
                  `INSERT INTO ${tableName} (${columns}, _synced) VALUES (${placeholders}, 1)`,
                  Object.values(snakeCaseRecord)
                )
              }
            } catch (err) {
              console.error(`Error upserting ${tableName}/${serverRecord.id}:`, err)
            }
          }
          continue
        }

        // ─── ALL OTHER TABLES ─────────────────────────────────────────────
        let supabaseQuery = supabase
          .from(tableName)
          .select('*')
          .eq('user_id', userId)

        if (lastSyncTime > 0) {
          const lastSyncIso = new Date(lastSyncTime).toISOString()
          supabaseQuery = supabaseQuery.gt('updated_at_iso', lastSyncIso)
        }

        const { data, error } = await supabaseQuery

        if (error) {
          console.error(`Failed to fetch ${tableName}:`, error)
          continue
        }

        if (!data || data.length === 0) continue

        for (const serverRecord of data) {
          try {
            const localRecord: any = await query(
              `SELECT * FROM ${tableName} WHERE id = ?`,
              [serverRecord.id]
            )
            const snakeCaseRecord = convertToSnakeCase(serverRecord)

            if (localRecord && localRecord.length > 0) {
              const localTime = localRecord[0].updated_at || 0
              const serverTime = serverRecord.updated_at || 0
              if (conflictResolution === 'server-wins' || serverTime >= localTime) {
                const updates = Object.keys(snakeCaseRecord).map(k => `${k} = ?`).join(', ')
                await execute(
                  `UPDATE ${tableName} SET ${updates}, _synced = 1 WHERE id = ?`,
                  [...Object.values(snakeCaseRecord), serverRecord.id]
                )
              }
            } else {
              const columns = Object.keys(snakeCaseRecord).join(', ')
              const placeholders = Object.keys(snakeCaseRecord).map(() => '?').join(', ')
              await execute(
                `INSERT INTO ${tableName} (${columns}, _synced) VALUES (${placeholders}, 1)`,
                Object.values(snakeCaseRecord)
              )
            }
          } catch (err) {
            console.error(`Error upserting ${tableName}/${serverRecord.id}:`, err)
          }
        }

      } catch (err) {
        console.error(`Error pulling ${tableName}:`, err)
      }
    }
  } catch (err) {
    console.error('Error in syncPullFromSupabase:', err)
    updateSyncStatus({ syncError: String(err) })
  }
}

export async function fullSync(userId: string, options: SyncOptions = {}): Promise<boolean> {
  if (isSyncRunning) {
    console.warn('Sync already in progress')
    return false
  }

  // Safety: force-reset stuck flag after 30 seconds
  const timeout = setTimeout(() => {
    if (isSyncRunning) {
      console.warn('Sync timed out — force resetting')
      isSyncRunning = false
    }
  }, 30000)

  isSyncRunning = true

  try {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) {
      console.warn('No Supabase session found, skipping sync')
      return false
    }

    updateSyncStatus({ isSyncing: true, syncError: null })

    const lastSync = await getLastSyncTime()
    await syncPullFromSupabase(userId, lastSync, options)
    await syncPushToSupabase(userId, options)
    await setLastSyncTime(Date.now())

    let pending = 0
    try {
      pending = await countPendingChanges(userId)
    } catch (err) {
      console.warn('Could not count pending changes:', err)
    }

    updateSyncStatus({
      isSyncing: false,
      lastSyncTime: Date.now(),
      pendingChanges: pending,
      syncError: null
    })

    console.log('Full sync completed successfully')
    return true
  } catch (err) {
    console.error('Error in fullSync:', err)
    updateSyncStatus({ isSyncing: false, syncError: String(err) })
    return false
  } finally {
    clearTimeout(timeout)
    isSyncRunning = false  // always reset, even on error
  }
}

export async function syncTable(tableName: string, userId: string, options: SyncOptions = {}): Promise<boolean> {
  if (tableName === 'messages') {
    await syncPushToSupabase(userId, options)
    return true
  }
  
  if (!TABLES.includes(tableName)) {
    console.error(`Unknown table: ${tableName}`)
    return false
  }

  try {
    updateSyncStatus({ isSyncing: true, syncError: null })

    const lastSync = await getLastSyncTime()
    if (await syncSharedChordLibraryTable(tableName, userId, lastSync)) {
      updateSyncStatus({ isSyncing: false, lastSyncTime: Date.now(), syncError: null })
      return true
    }

    if (isPublicManagementTable(tableName)) {
      let supabaseQuery = supabase
        .from(tableName)
        .select('*')

      if (lastSync > 0) {
        const lastSyncIso = new Date(lastSync).toISOString()
        supabaseQuery = supabaseQuery.gt('updated_at_iso', lastSyncIso)
      }

      const { data, error } = await supabaseQuery
      if (error) throw error

      if (data && data.length > 0) {
        for (const serverRecord of data) {
          const snakeCaseRecord = convertToSnakeCase(serverRecord)
          const localRecord: any = await query(
            `SELECT id FROM ${tableName} WHERE id = ?`,
            [serverRecord.id]
          )

          if (localRecord && localRecord.length > 0) {
            const updates = Object.keys(snakeCaseRecord).map(key => `${key} = ?`).join(', ')
            const values = Object.values(snakeCaseRecord)
            await execute(
              `UPDATE ${tableName} SET ${updates}, _synced = 1 WHERE id = ?`,
              [...values, serverRecord.id]
            )
          } else {
            const columns = Object.keys(snakeCaseRecord).join(', ')
            const placeholders = Object.keys(snakeCaseRecord).map(() => '?').join(', ')
            const values = Object.values(snakeCaseRecord)
            await execute(
              `INSERT INTO ${tableName} (${columns}, _synced) VALUES (${placeholders}, 1)`,
              values
            )
          }
        }
      }

      const unsyncedRecords: any[] = await query(
        `SELECT * FROM ${tableName} WHERE _synced = 0 AND user_id = ?`,
        [userId]
      )

      for (const record of unsyncedRecords) {
        const data = toSupabasePayload(record)
        const timestamp = record.updated_at || Date.now()

        const { error: upsertError } = await supabase.from(tableName).upsert(
          {
            ...convertToSnakeCase(data),
            user_id: userId,
            updated_at: timestamp,
            updated_at_iso: new Date(timestamp).toISOString(),
          },
          { onConflict: 'id' }
        )

        if (!upsertError) {
          await execute(`UPDATE ${tableName} SET _synced = 1 WHERE id = ?`, [record.id])
        }
      }

      updateSyncStatus({ isSyncing: false })
      return true
    }

    let supabaseQuery = supabase
      .from(tableName)
      .select('*')
      .eq('user_id', userId)

    if (lastSync > 0) {
      const lastSyncIso = new Date(lastSync).toISOString()
      supabaseQuery = supabaseQuery.gt('updated_at_iso', lastSyncIso)
    }

    const { data, error } = await supabaseQuery
    if (error) throw error

    if (data && data.length > 0) {
      for (const serverRecord of data) {
        const snakeCaseRecord = convertToSnakeCase(serverRecord)
        const localRecord: any = await query(
          `SELECT id FROM ${tableName} WHERE id = ?`,
          [serverRecord.id]
        )

        if (localRecord && localRecord.length > 0) {
          const updates = Object.keys(snakeCaseRecord).map(key => `${key} = ?`).join(', ')
          const values = Object.values(snakeCaseRecord)
          await execute(
            `UPDATE ${tableName} SET ${updates}, _synced = 1 WHERE id = ?`,
            [...values, serverRecord.id]
          )
        } else {
          const columns = Object.keys(snakeCaseRecord).join(', ')
          const placeholders = Object.keys(snakeCaseRecord).map(() => '?').join(', ')
          const values = Object.values(snakeCaseRecord)
          await execute(
            `INSERT INTO ${tableName} (${columns}, _synced) VALUES (${placeholders}, 1)`,
            values
          )
        }
      }
    }

    const unsyncedRecords: any[] = await query(
      `SELECT * FROM ${tableName} WHERE _synced = 0 AND user_id = ?`,
      [userId]
    )

    for (const record of unsyncedRecords) {
      const data = toSupabasePayload(record)
      const timestamp = record.updated_at || Date.now()
      const conflictColumn = tableName === 'user_profiles' ? 'user_id' : 'id'

      const { error } = await supabase.from(tableName).upsert(
        {
          ...convertToSnakeCase(data),
          user_id: userId,
          updated_at: timestamp,
          updated_at_iso: new Date(timestamp).toISOString(),
        },
        { onConflict: conflictColumn }
      )

      if (!error) {
        await execute(`UPDATE ${tableName} SET _synced = 1 WHERE id = ?`, [record.id])
      }
    }

    updateSyncStatus({ isSyncing: false })
    return true
  } catch (err) {
    console.error(`Error syncing ${tableName}:`, err)
    updateSyncStatus({ isSyncing: false, syncError: String(err) })
    return false
  }
}

// ─── Sync Queue ───────────────────────────────────────────────────────────────


export function subscribeToChanges(userId: string, onUpdate: () => void) {
  const channels: any[] = []
  const stamp = Date.now()

  const handleChange = async (tableName: string) => {
    console.log(`[realtime] change detected in ${tableName}`)
    // invalidateTable(tableName)  // immediately notify UI
    await guardedSync(userId, Date.now() - 10000)
    invalidateTable(tableName)  // notify again after sync writes to SQLite
    onUpdate()
  }

  const subscribeTable = (channelName: string, tableName: string, filter?: string) => {
    let channel = supabase
      .channel(channelName)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: tableName,
        ...(filter ? { filter } : {}),
      }, () => handleChange(tableName))
      .subscribe((status) => {
        console.log(`[realtime] ${tableName} subscription status:`, status)
      })

    return channel
  }

  // All user-owned tables
  for (const tableName of TABLES) {
    const filter = isPublicManagementTable(tableName) ? undefined : `user_id=eq.${userId}`
    channels.push(subscribeTable(`${tableName}-${userId}-${stamp}`, tableName, filter))
  }

  // Shared chord-library content can change on another device and must refresh quickly.
  channels.push(subscribeTable(`artists-shared-${userId}-${stamp}`, 'artists'))
  channels.push(subscribeTable(`chord_lists-shared-${userId}-${stamp}`, 'chord_lists'))
  channels.push(subscribeTable(`songs-shared-${userId}-${stamp}`, 'songs'))

  // Incoming contacts
  const contactsChannel = supabase
    .channel(`contacts-in-${userId}-${stamp}`)
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'contacts',
      filter: `contact_user_id=eq.${userId}`,
    }, () => handleChange('contacts'))
    .subscribe()
  channels.push(contactsChannel)

  // Incoming direct messages
  const dmChannel = supabase
    .channel(`messages-dm-${userId}-${stamp}`)
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'messages',
      filter: `receiver_id=eq.${userId}`,
    }, () => handleChange('messages'))
    .subscribe()
  channels.push(dmChannel)

  // Overall chat
  const overallChannel = supabase
    .channel(`messages-overall-${stamp}`)
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'messages',
      filter: `receiver_id=eq.overall-chat`,
    }, () => handleChange('messages'))
    .subscribe()
  channels.push(overallChannel)

  return () => {
    channels.forEach(ch => supabase.removeChannel(ch))
  }
}

export async function startPeriodicSync(userId: string, intervalMs: number = 10000) {
  await fullSync(userId)

  const syncInterval = setInterval(async () => {
    await fullSync(userId)
  }, intervalMs)

  return () => clearInterval(syncInterval)
}

export async function getUnsyncedRecords(tableName: string, userId: string): Promise<any[]> {
  try {
    return await query(
      `SELECT * FROM ${tableName} WHERE _synced = 0 AND user_id = ?`,
      [userId]
    )
  } catch (err) {
    console.error(`Error getting unsynced records from ${tableName}:`, err)
    return []
  }
}

export async function markAsUnsynced(tableName: string, recordId: string): Promise<void> {
  try {
    await execute(
      `UPDATE ${tableName} SET _synced = 0, updated_at = ? WHERE id = ?`,
      [Date.now(), recordId]
    )
  } catch (err) {
    console.error(`Error marking ${tableName}/${recordId} as unsynced:`, err)
  }
}

export function clearSyncError(): void {
  updateSyncStatus({ syncError: null })
}

function convertToCamelCase(obj: any): any {
  const result: any = {}
  for (const [key, value] of Object.entries(obj)) {
    const camelKey = key.replace(/_([a-z])/g, (g) => g[1].toUpperCase())
    result[camelKey] = value
  }
  return result
}

function convertToSnakeCase(obj: any): any {
  const result: any = {}
  for (const [key, value] of Object.entries(obj)) {
    const snakeKey = key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
    result[snakeKey] = value
  }
  return result
}

export async function getLastSyncTime(): Promise<number> {
  try {
    const time = await AsyncStorage.getItem('lastSyncTime')
    return time ? parseInt(time) : 0
  } catch (err) {
    console.error('Error getting lastSyncTime:', err)
    return 0
  }
}

export async function setLastSyncTime(time: number) {
  try {
    await AsyncStorage.setItem('lastSyncTime', time.toString())
  } catch (err) {
    console.error('Error setting lastSyncTime:', err)
  }
}

export async function stampUserIdOnUnsyncedRows(userId: string) {
  for (const tableName of TABLES) {
    // messages table uses sender_id, not user_id — handle separately
    if (tableName === 'messages') continue   // ← add this skip
    try {
      await execute(
        `UPDATE ${tableName} SET user_id = ? WHERE user_id IS NULL OR user_id = ''`,
        [userId]
      )
    } catch (err) {
      console.error(`Failed to stamp user_id on ${tableName}:`, err)
    }
  }
}

export async function removeOrphanedUnsyncedRows(userId: string) {
  for (const tableName of TABLES) {
    try {
      await execute(
        `DELETE FROM ${tableName} WHERE _synced = 0 AND user_id != ? AND user_id != ''`,
        [userId]
      )
    } catch (err) {
      console.error(`Failed to clean orphaned rows in ${tableName}:`, err)
    }
  }

  try {
    await execute(
      `DELETE FROM messages WHERE _synced = 0 AND sender_id != ? AND sender_id != ''`,
      [userId]
    )
  } catch (err) {
    console.error('Failed to clean orphaned messages:', err)
  }
}