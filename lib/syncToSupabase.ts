import { supabase } from './supabase'
import { execute, query } from '../db/index'
import { isOnline } from './networkStatus'
import { isChordListPublic } from './chordListPrivacy'

type TableName =
  | 'artists'
  | 'chord_lists'
  | 'songs'
  | 'lineups'
  | 'lineup_items'
  | 'messages'
  | 'file_droppers'
  | 'important_announcements'
  | 'important_messages'
  | 'version_droppers'
  | 'team_calendar_events'
  | 'contacts'
  | 'user_profiles'
  | 'playlists'
  | 'playlist_items'

const ALL_TABLES: TableName[] = [
  'user_profiles', 'artists', 'chord_lists', 'songs', 'lineups',
  'lineup_items', 'messages', 'file_droppers', 'important_announcements', 'important_messages',
  'version_droppers', 'team_calendar_events', 'contacts', 'playlists', 'playlist_items'
]

function convertToSnakeCase(obj: any): any {
  const result: any = {}
  for (const [key, value] of Object.entries(obj)) {
    const snakeKey = key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
    result[snakeKey] = value
  }
  return result
}

function toSupabaseRow(row: any) {
  const { _synced, synced, deleted_at, deletedAt, ...rest } = row
  const payload = convertToSnakeCase(rest)
  if (Array.isArray(payload.assignments)) {
    payload.assignments = JSON.stringify(payload.assignments)
  }
  const createdAt = row.createdAt ?? row.created_at
  const updatedAt = row.updatedAt ?? row.updated_at

  if (typeof createdAt === 'number' && !payload.created_at_iso) {
    payload.created_at_iso = new Date(createdAt).toISOString()
  }
  if (typeof updatedAt === 'number' && !payload.updated_at_iso) {
    payload.updated_at_iso = new Date(updatedAt).toISOString()
  }

  return payload
}

export async function syncRowToSupabase(table: TableName, row: any) {
  if (!(await isOnline())) {
    console.log(`Offline — ${table}/${row.id} queued`)
    return
  }

  const conflictColumn = table === 'user_profiles' ? 'user_id' : 'id'
  const payload = toSupabaseRow(row)

  const { error } = await supabase
    .from(table)
    .upsert(payload, { onConflict: conflictColumn })

  if (error) {
    if (error.code === '42501') {
      console.warn(`RLS blocked ${table}/${row.id} — skipping retries`)
      return
    }
    console.warn(`Sync failed for ${table}/${row.id}:`, error)
    return
  }

  await execute(`UPDATE ${table} SET _synced = 1 WHERE id = ?`, [row.id])
}

export async function deleteRowFromSupabase(table: TableName, id: string) {
  if (!(await isOnline())) {
    // Mark for deletion when back online
    try {
      await execute(
        `UPDATE ${table} SET deleted_at = ?, _synced = 0 WHERE id = ?`,
        [Date.now(), id]
      )
    } catch (e) {
      // deleted_at column may not exist on all tables yet — just delete locally
      await execute(`DELETE FROM ${table} WHERE id = ?`, [id])
    }
    console.log(`Offline — delete of ${table}/${id} queued`)
    return
  }

  const { error } = await supabase.from(table).delete().eq('id', id)
  if (error) {
    console.warn(`Delete failed for ${table}/${id}:`, error)
    // Queue for retry
    try {
      await execute(
        `UPDATE ${table} SET deleted_at = ?, _synced = 0 WHERE id = ?`,
        [Date.now(), id]
      )
    } catch (e) {
      await execute(`DELETE FROM ${table} WHERE id = ?`, [id])
    }
    return
  }

  // Confirmed deleted in Supabase — remove locally
  await execute(`DELETE FROM ${table} WHERE id = ?`, [id])
}

export async function syncAllUnsyncedRows() {
  if (!(await isOnline())) return

  for (const table of ALL_TABLES) {
    try {
      // 1. Push pending deletes
      let pendingDeletes: any[] = []
      try {
        pendingDeletes = await query(
          `SELECT id FROM ${table} WHERE deleted_at IS NOT NULL AND _synced = 0`
        )
      } catch (e) {
        // deleted_at column may not exist yet
      }

      for (const row of pendingDeletes) {
        const { error } = await supabase.from(table).delete().eq('id', row.id)
        if (!error) {
          await execute(`DELETE FROM ${table} WHERE id = ?`, [row.id])
        } else {
          console.warn(`Delete retry failed for ${table}/${row.id}:`, error)
        }
      }

      // 2. Push unsynced upserts — skip orphaned rows from other users
      let unsynced: any[] = await query(
        `SELECT * FROM ${table} WHERE _synced = 0 AND (deleted_at IS NULL OR deleted_at = '')`
      )

      if (table === 'chord_lists') {
        unsynced = unsynced.filter(isChordListPublic)
      }


      for (const row of unsynced) {
        const conflictColumn = table === 'user_profiles' ? 'user_id' : 'id'
        const payload = toSupabaseRow(row)

        const { error } = await supabase
          .from(table)
          .upsert(payload, { onConflict: conflictColumn })

        if (!error) {
          await execute(`UPDATE ${table} SET _synced = 1 WHERE id = ?`, [row.id])
        } else if (error.code === '42501') {
          // RLS block — this row belongs to another user, skip permanently
          console.warn(`RLS blocked ${table}/${row.id} — marking as synced to stop retrying`)
          await execute(`UPDATE ${table} SET _synced = 1 WHERE id = ?`, [row.id])
        } else {
          console.warn(`Upsert failed for ${table}/${row.id}:`, error)
        }
      }
    } catch (err) {
      console.error(`Error syncing table ${table}:`, err)
    }
  }
}