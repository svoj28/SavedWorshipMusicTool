import { generateShortId } from '../lib/shortId'

// Find a user profile by shortId (searches all user_profiles)
export async function getUserProfileByShortId(shortId: string): Promise<UserProfile | null> {
  const results = await query('SELECT * FROM user_profiles')
  for (const row of results) {
    const r = row as any;
    if (generateShortId(r.user_id) === shortId.toUpperCase()) {
      return mapUserProfile(r)
    }
  }
  return null
}
// db/queries.ts
import { execute, query, queryOne, transaction } from './index'
import { Artist, ChordList, Song, Lineup, LineupItem, Message, FileDropper, ImportantAnnouncement, VersionDropper, CalendarEvent, CalendarAssignment, Contact, UserProfile, Playlist, PlaylistItem, ImportantMessage } from './models'
import { syncRowToSupabase, deleteRowFromSupabase } from '../lib/syncToSupabase'
import { supabase } from '../lib/supabase'
import { isOnline } from '../lib/networkStatus'
import uuid from 'react-native-uuid'

// ─── Helper ───────────────────────────────────────────────────────────────────
function camelToSnake(str: string): string {
  return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
}

// ─── ARTISTS ──────────────────────────────────────────────────────────────────
export async function createArtist(data: Omit<Artist, 'id'>): Promise<Artist> {
  const id = uuid.v4() as string
  const artist = { id, ...data }
  await execute(
    'INSERT INTO artists (id, name, user_id, created_at, updated_at, _synced) VALUES (?, ?, ?, ?, ?, ?)',
    [artist.id, artist.name, artist.userId, artist.createdAt, artist.updatedAt, 0]
  )
  await syncRowToSupabase('artists', artist)
  return artist
}

export async function deleteVersionDropper(id: string): Promise<void> {
  const { error } = await supabase.from('version_droppers').delete().eq('id', id)
  if (error) {
    console.warn('[deleteVersionDropper] remote delete failed:', error)
    await execute(`UPDATE version_droppers SET deleted_at = ?, _synced = 0 WHERE id = ?`, [Date.now(), id])
    return
  }
  await execute('DELETE FROM version_droppers WHERE id = ?', [id])
}

export async function getArtistById(id: string): Promise<Artist | null> {
  if (await isOnline()) {
    const { data } = await supabase.from('artists').select('*').eq('id', id).limit(1)
    if (data && data.length > 0) return mapArtist(data[0])
  }

  const result = await queryOne('SELECT * FROM artists WHERE id = ?', [id])
  return result ? mapArtist(result) : null
}

export async function getArtistsByUserId(userId: string): Promise<Artist[]> {
  if (await isOnline()) {
    const { data } = await supabase.from('artists').select('*').eq('user_id', userId).order('name')
    if (data && data.length > 0) return data.map(mapArtist)
  }

  const results = await query('SELECT * FROM artists WHERE user_id = ? ORDER BY name', [userId])
  return results.map(mapArtist)
}

export async function updateArtist(id: string, data: Partial<Artist>): Promise<void> {
  const filtered = Object.entries(data).filter(([key]) => !['id', 'userId', 'createdAt'].includes(key))
  const updates = filtered.map(([key]) => `${camelToSnake(key)} = ?`).join(', ')
  const values = filtered.map(([, val]) => val)
  if (!updates) return

  // Try to update via Supabase first so remote tables are authoritative for edits.
  const payload: any = {}
  for (const [k, v] of filtered) payload[camelToSnake(k)] = v
  try {
    const { data: supData, error } = await supabase.from('artists').update(payload).eq('id', id).select()
    if (error) throw error
    const row = Array.isArray(supData) ? supData[0] : supData
    if (row) {
      // persist authoritative row locally and mark synced
      await execute('UPDATE artists SET name = ?, user_id = ?, updated_at = ?, _synced = 1 WHERE id = ?', [row.name, row.user_id || '', Date.now(), id])
    }
    return
  } catch (err) {
    // fallback: update locally and schedule sync
    await execute(`UPDATE artists SET ${updates}, updated_at = ?, _synced = 0 WHERE id = ?`, [...values, Date.now(), id])
    const updated = await getArtistById(id)
    if (updated) await syncRowToSupabase('artists', updated)
  }
}

export async function deleteArtist(id: string): Promise<void> {
  await execute('DELETE FROM artists WHERE id = ?', [id])
  await deleteRowFromSupabase('artists', id)
}

// ─── CHORD LISTS ──────────────────────────────────────────────────────────────
export async function createChordList(data: Omit<ChordList, 'id'>): Promise<ChordList> {
  const id = uuid.v4() as string
  const list = { id, ...data }
  await execute(
    'INSERT INTO chord_lists (id, title, artist_id, user_id, is_private, created_at, updated_at, _synced) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [list.id, list.title, list.artistId, list.userId, list.isPrivate ? 1 : 0, list.createdAt, list.updatedAt, 0]
  )
  // Only sync if not private
  if (!list.isPrivate) {
    await syncRowToSupabase('chord_lists', list)
  }
  return list
}

export async function getChordListById(id: string): Promise<ChordList | null> {
  if (await isOnline()) {
    const { data } = await supabase.from('chord_lists').select('*').eq('id', id).limit(1)
    if (data && data.length > 0) return mapChordList(data[0])
  }

  const result = await queryOne('SELECT * FROM chord_lists WHERE id = ?', [id])
  return result ? mapChordList(result) : null
}

export async function getChordListsByUserId(userId: string): Promise<ChordList[]> {
  if (await isOnline()) {
    const { data } = await supabase.from('chord_lists').select('*').eq('user_id', userId).order('title')
    if (data && data.length > 0) return data.map(mapChordList)
  }

  const results = await query('SELECT * FROM chord_lists WHERE user_id = ? ORDER BY title', [userId])
  return results.map(mapChordList)
}

export async function getPrivateChordLists(userId: string): Promise<ChordList[]> {
  const results = await query('SELECT * FROM chord_lists WHERE user_id = ? AND is_private = 1 ORDER BY title', [userId])
  return results.map(mapChordList)
}

export async function updateChordList(id: string, data: Partial<ChordList>): Promise<void> {
  const filtered = Object.entries(data).filter(([key]) => !['id', 'userId', 'createdAt'].includes(key))
  const updates = filtered.map(([key]) => `${camelToSnake(key)} = ?`).join(', ')
  const values = filtered.map(([, val]) => val)
  if (!updates) return
  await execute(`UPDATE chord_lists SET ${updates}, updated_at = ?, _synced = 0 WHERE id = ?`, [...values, Date.now(), id])
  const updated = await getChordListById(id)
  // Only sync if not private
  if (updated && !updated.isPrivate) {
    await syncRowToSupabase('chord_lists', updated)
  }
}

export async function deleteChordList(id: string): Promise<void> {
  const list = await getChordListById(id)
  const songs = await query('SELECT id FROM songs WHERE chord_list_id = ?', [id]) as { id: string }[]
  // Only delete from Supabase if it was a public chord list
  if (list && !list.isPrivate) {
    for (const song of songs) {
      await deleteRowFromSupabase('songs', song.id)
    }
    await deleteRowFromSupabase('chord_lists', id)
  }
  await execute('DELETE FROM songs WHERE chord_list_id = ?', [id])
  await execute('DELETE FROM chord_lists WHERE id = ?', [id])
}

export async function deleteChordListRecord(id: string): Promise<void> {
  await execute('DELETE FROM chord_lists WHERE id = ?', [id])
  await deleteRowFromSupabase('chord_lists', id)
}

// ─── SONGS ────────────────────────────────────────────────────────────────────
export async function createSong(data: Omit<Song, 'id'>): Promise<Song> {
  const id = uuid.v4() as string
  const song = { id, ...data }
  await execute(
    'INSERT INTO songs (id, chord_list_id, user_id, title, content, key, youtube_url, created_at, updated_at, _synced) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [song.id, song.chordListId, song.userId || '', song.title, song.content, song.key, song.youtubeUrl || '', song.createdAt, song.updatedAt, 0]
  )
  try {
    await syncRowToSupabase('songs', song)
    console.log('[createSong] synced to Supabase:', song.id)
  } catch (err) {
    console.warn('[createSong] sync to Supabase failed (will retry):', err)
  }
  return song
}

export async function getSongById(id: string): Promise<Song | null> {
  if (await isOnline()) {
    const { data } = await supabase.from('songs').select('*').eq('id', id).limit(1)
    if (data && data.length > 0) return mapSong(data[0])
  }

  const result = await queryOne('SELECT * FROM songs WHERE id = ?', [id])
  return result ? mapSong(result) : null
}

export async function getSongsByChordListId(chordListId: string): Promise<Song[]> {
  if (await isOnline()) {
    const { data, error } = await supabase.from('songs').select('*').eq('chord_list_id', chordListId).order('title')
    console.log('[getSongsByChordListId] supabase data:', data?.length, 'error:', error)
    if (data && data.length > 0) return data.map(mapSong)
  }

  const results = await query('SELECT * FROM songs WHERE chord_list_id = ? ORDER BY title', [chordListId])
  console.log('[getSongsByChordListId] sqlite results:', results?.length)
  return results.map(mapSong)
}

export async function updateSong(id: string, data: Partial<Song>): Promise<void> {
  const filtered = Object.entries(data).filter(([key]) => !['id', 'chordListId', 'createdAt'].includes(key))
  const updates = filtered.map(([key]) => `${camelToSnake(key)} = ?`).join(', ')
  const values = filtered.map(([, val]) => val)
  if (!updates) return

  // Try to update via Supabase first so edits use the remote songs table.
  const payload: any = {}
  for (const [k, v] of filtered) payload[camelToSnake(k)] = v
  try {
    const { data: supData, error } = await supabase.from('songs').update(payload).eq('id', id).select()
    if (error) throw error
    const row = Array.isArray(supData) ? supData[0] : supData
    if (row) {
      // update local DB to reflect authoritative remote row and mark synced
      await execute('UPDATE songs SET title = ?, content = ?, key = ?, youtube_url = ?, updated_at = ?, _synced = 1 WHERE id = ?', [row.title || '', row.content || '', row.key || '', row.youtube_url || '', Date.now(), id])
    }
    return
  } catch (err) {
    // fallback: update locally and schedule sync
    await execute(`UPDATE songs SET ${updates}, updated_at = ?, _synced = 0 WHERE id = ?`, [...values, Date.now(), id])
    const updated = await getSongById(id)
    if (updated) await syncRowToSupabase('songs', updated)
  }
}

export async function deleteSong(id: string): Promise<void> {
  // delete locally first
  try {
    await execute('DELETE FROM songs WHERE id = ?', [id])
    console.log('[deleteSong] deleted locally:', id)
  } catch (err) {
    console.error('[deleteSong] failed local delete:', err)
    throw err
  }

  try {
    await deleteRowFromSupabase('songs', id)
    console.log('[deleteSong] deleteRowFromSupabase completed for:', id)
  } catch (err) {
    console.warn('[deleteSong] deleteRowFromSupabase failed (queued):', err)
  }
}

// ─── LINEUPS ──────────────────────────────────────────────────────────────────
export async function createLineup(data: Omit<Lineup, 'id' | 'items'>): Promise<Lineup> {
  const id = uuid.v4() as string
  const lineup = { id, ...data }
  await execute(
    'INSERT INTO lineups (id, title, user_id, description, created_at, updated_at, _synced) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [lineup.id, lineup.title, lineup.userId, lineup.description || '', lineup.createdAt, lineup.updatedAt, 0]
  )
  void syncRowToSupabase('lineups', lineup).catch(err => console.warn('Background sync failed for lineups:', err))
  return lineup
}

export async function getLineupById(id: string): Promise<Lineup | null> {
  const result = await queryOne('SELECT * FROM lineups WHERE id = ?', [id])
  return result ? mapLineup(result) : null
}

export async function getLineupsByUserId(userId: string): Promise<Lineup[]> {
  const results = await query('SELECT * FROM lineups WHERE user_id = ? ORDER BY created_at DESC', [userId])
  return results.map(mapLineup)
}

export async function getAllLineups(): Promise<Lineup[]> {
  if (await isOnline()) {
    try {
      const { data, error } = await supabase
        .from('lineups')
        .select('*')
        .order('created_at', { ascending: false })
      if (!error && data && data.length > 0) return data.map(mapLineup)
    } catch (err) {
      console.warn('[getAllLineups] Supabase fetch failed, using local cache:', err)
    }
  }

  const results = await query('SELECT * FROM lineups ORDER BY created_at DESC')
  return results.map(mapLineup)
}

// export async function getAllLineupItems(): Promise<LineupItem[]> {
//   if (await isOnline()) {
//     try {
//       const { data, error } = await supabase
//         .from('lineup_items')
//         .select('*')
//         .order('position', { ascending: true })
//       if (!error && data && data.length > 0) return data.map(mapLineupItem)
//     } catch (err) {
//       console.warn('[getAllLineupItems] Supabase fetch failed, using local cache:', err)
//     }
//   }

//   const results = await query('SELECT * FROM lineup_items ORDER BY position ASC')
//   return results.map(mapLineupItem)
// }

// ─── LINEUP ITEMS ────────────────────────────────────────────────────────────
export async function createLineupItem(data: Omit<LineupItem, 'id'>): Promise<LineupItem> {
  const id = uuid.v4() as string
  const item = { id, songId: '', ...data }
  await execute(
    'INSERT INTO lineup_items (id, lineup_id, song_id, user_id, position, created_at, updated_at, artist, song_title, song_key, version_url, category, _synced) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      item.id,
      item.lineupId,
      item.songId || '',
      item.userId || '',
      item.position,
      item.createdAt,
      item.updatedAt,
      item.artist || '',
      item.songTitle || '',
      item.key || '',
      item.versionUrl || '',
      item.category || 'any',
      0,
    ]
  )
  void syncRowToSupabase('lineup_items', item).catch(err => console.warn('Background sync failed for lineup items:', err))
  return item
}

export async function getLineupItemsByLineupId(lineupId: string): Promise<LineupItem[]> {
  const { data } = await supabase.from('lineup_items').select('*').eq('lineup_id', lineupId).order('position', { ascending: true })
  if (data && data.length > 0) return data.map(mapLineupItem)

  const results = await query('SELECT * FROM lineup_items WHERE lineup_id = ? ORDER BY position ASC', [lineupId])
  return results.map(mapLineupItem)
}

export async function getAllLineupItems(): Promise<LineupItem[]> {
  if (await isOnline()) {
    try {
      const { data, error } = await supabase
        .from('lineup_items')
        .select('*')
        .order('position', { ascending: true })
      if (!error && data && data.length > 0) return data.map(mapLineupItem)
    } catch (err) {
      console.warn('[getAllLineupItems] Supabase fetch failed, using local cache:', err)
    }
  }

  const results = await query('SELECT * FROM lineup_items ORDER BY position ASC')
  return results.map(mapLineupItem)
}

export async function updateLineupItem(id: string, data: Partial<LineupItem>): Promise<void> {
  const filtered = Object.entries(data).filter(([key]) => !['id', 'lineupId', 'userId', 'synced', 'createdAt'].includes(key))
  const updates = filtered.map(([key]) => `${camelToSnake(key)} = ?`).join(', ')
  const values = filtered.map(([, val]) => val)
  if (!updates) return
  await execute(`UPDATE lineup_items SET ${updates}, updated_at = ?, _synced = 0 WHERE id = ?`, [...values, Date.now(), id])
  const updated = await queryOne('SELECT * FROM lineup_items WHERE id = ?', [id])
  if (updated) void syncRowToSupabase('lineup_items', mapLineupItem(updated)).catch(err => console.warn('Background sync failed for lineup item:', err))
}

export async function deleteLineupItem(id: string): Promise<void> {
  await execute('DELETE FROM lineup_items WHERE id = ?', [id])
  void deleteRowFromSupabase('lineup_items', id).catch(err => console.warn('Background delete sync failed for lineup item:', err))
}

export async function updateLineup(id: string, data: Partial<Lineup>): Promise<void> {
  const filtered = Object.entries(data).filter(([key]) => !['id', 'userId', 'synced', 'createdAt', 'items'].includes(key))
  const updates = filtered.map(([key]) => `${camelToSnake(key)} = ?`).join(', ')
  const values = filtered.map(([, val]) => val)
  if (!updates) return

  // Build Supabase payload
  const payload: any = {}
  for (const [k, v] of filtered) payload[camelToSnake(k)] = v

  try {
    const { data: supData, error } = await supabase
      .from('lineups')
      .update(payload)
      .eq('id', id)
      .select()
    if (error) throw error

    const row = Array.isArray(supData) ? supData[0] : supData
    if (row) {
      await execute(
        'UPDATE lineups SET title = ?, description = ?, updated_at = ?, _synced = 1 WHERE id = ?',
        [row.title, row.description || '', Date.now(), id]
      )
    }
    return
  } catch (err) {
    // Offline fallback
    await execute(
      `UPDATE lineups SET ${updates}, updated_at = ?, _synced = 0 WHERE id = ?`,
      [...values, Date.now(), id]
    )
    const updated = await getLineupById(id)
    if (updated) void syncRowToSupabase('lineups', updated).catch(err =>
      console.warn('Background sync failed for lineups:', err)
    )
  }
}

export async function deleteLineup(id: string): Promise<void> {
  const items = await query('SELECT id FROM lineup_items WHERE lineup_id = ?', [id]) as { id: string }[]
  for (const item of items) {
    await deleteRowFromSupabase('lineup_items', item.id)
  }
  await execute('DELETE FROM lineup_items WHERE lineup_id = ?', [id])
  await execute('DELETE FROM lineups WHERE id = ?', [id])
  void deleteRowFromSupabase('lineups', id).catch(err => console.warn('Background delete sync failed for lineups:', err))
}

// ─── MESSAGES ─────────────────────────────────────────────────────────────────
export async function createMessage(data: Omit<Message, 'id'>): Promise<Message> {
  const id = uuid.v4() as string
  const message = { id, ...data, userId: data.senderId }
  await execute(
    'INSERT INTO messages (id, sender_id, receiver_id, user_id, text, created_at, updated_at, is_deleted, _synced) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [message.id, message.senderId, message.receiverId, message.senderId, message.text, message.createdAt, message.updatedAt, message.isDeleted ? 1 : 0, 0]
  )
  await syncRowToSupabase('messages', message)
  return message
}

export async function editMessage(id: string, newText: string): Promise<void> {
  const editedAt = Date.now()
  await execute(
    'UPDATE messages SET text = ?, updated_at = ?, edited_at = ?, _synced = 0 WHERE id = ?',
    [newText, editedAt, editedAt, id]
  )
  const updated = await queryOne('SELECT * FROM messages WHERE id = ?', [id]) as any
  if (updated) {
    await syncRowToSupabase('messages', {
      ...mapMessage(updated),
      userId: updated.user_id ?? updated.sender_id,
    })
  }
}

export async function deleteMessage(id: string): Promise<void> {
  await execute(
    'UPDATE messages SET is_deleted = 1, updated_at = ?, _synced = 0 WHERE id = ?',
    [Date.now(), id]
  )
  const updated = await queryOne('SELECT * FROM messages WHERE id = ?', [id]) as any
  if (updated) {
    await syncRowToSupabase('messages', {
      ...mapMessage(updated),
      userId: updated.user_id ?? updated.sender_id,
    })
  }
}

// ─── FILE DROPPERS ────────────────────────────────────────────────────────────
export async function createFileDropper(data: Omit<FileDropper, 'id'>): Promise<FileDropper> {
  const id = uuid.v4() as string
  const file = { id, ...data }
  await execute(
    'INSERT INTO file_droppers (id, title, user_id, file_url, description, created_at, updated_at, _synced) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [file.id, file.title, file.userId, file.fileUrl, file.description || '', file.createdAt, file.updatedAt, 0]
  )
  void syncRowToSupabase('file_droppers', file).catch(err => console.warn('Background sync failed for file_droppers:', err))
  return file
}

export async function getFileDropperById(id: string): Promise<FileDropper | null> {
  const result = await queryOne('SELECT * FROM file_droppers WHERE id = ?', [id])
  return result ? mapFileDropper(result) : null
}

export async function getFileDroppersByUserId(userId: string): Promise<FileDropper[]> {
  const results = await query('SELECT * FROM file_droppers WHERE user_id = ? ORDER BY created_at DESC', [userId])
  return results.map(mapFileDropper)
}

export async function getAllFileDroppers(): Promise<FileDropper[]> {
  const { data } = await supabase.from('file_droppers').select('*').order('created_at', { ascending: false })
  if (data && data.length > 0) return data.map(mapFileDropper)

  const results = await query('SELECT * FROM file_droppers ORDER BY created_at DESC')
  return results.map(mapFileDropper)
}

export async function updateFileDropper(id: string, data: Partial<FileDropper>): Promise<void> {
  const filtered = Object.entries(data).filter(([key]) => !['id', 'userId', 'createdAt'].includes(key))
  const updates = filtered.map(([key]) => `${camelToSnake(key)} = ?`).join(', ')
  const values = filtered.map(([, val]) => val)
  if (!updates) return
  await execute(`UPDATE file_droppers SET ${updates}, updated_at = ?, _synced = 0 WHERE id = ?`, [...values, Date.now(), id])
  const updated = await getFileDropperById(id)
  if (updated) void syncRowToSupabase('file_droppers', updated).catch(err => console.warn('Background sync failed for file_droppers:', err))
}

export async function deleteFileDropper(id: string): Promise<void> {
  const { error } = await supabase.from('file_droppers').delete().eq('id', id)
  if (error) {
    console.warn('[deleteFileDropper] remote delete failed:', error)
    await execute(`UPDATE file_droppers SET deleted_at = ?, _synced = 0 WHERE id = ?`, [Date.now(), id])
    return
  }
  await execute('DELETE FROM file_droppers WHERE id = ?', [id])
}

// ─── IMPORTANT ANNOUNCEMENTS ──────────────────────────────────────────────────
export async function createImportantAnnouncement(data: Omit<ImportantAnnouncement, 'id'>): Promise<ImportantAnnouncement> {
  const id = uuid.v4() as string
  const announcement = { id, ...data }
  await execute(
    'INSERT INTO important_announcements (id, title, user_id, content, created_at, updated_at, _synced) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [announcement.id, announcement.title, announcement.userId, announcement.content, announcement.createdAt, announcement.updatedAt, 0]
  )
  void syncRowToSupabase('important_announcements', announcement).catch(err => console.warn('Background sync failed for important_announcements:', err))
  return announcement
}

export async function getAnnouncementById(id: string): Promise<ImportantAnnouncement | null> {
  const result = await queryOne('SELECT * FROM important_announcements WHERE id = ?', [id])
  return result ? mapImportantAnnouncement(result) : null
}

export async function getAnnouncementsByUserId(userId: string): Promise<ImportantAnnouncement[]> {
  const results = await query('SELECT * FROM important_announcements WHERE user_id = ? ORDER BY created_at DESC', [userId])
  return results.map(mapImportantAnnouncement)
}

export async function getAllAnnouncements(): Promise<ImportantAnnouncement[]> {
  const { data } = await supabase.from('important_announcements').select('*').order('created_at', { ascending: false })
  if (data && data.length > 0) return data.map(mapImportantAnnouncement)

  const results = await query('SELECT * FROM important_announcements ORDER BY created_at DESC')
  return results.map(mapImportantAnnouncement)
}

export async function updateAnnouncement(id: string, data: Partial<ImportantAnnouncement>): Promise<void> {
  const filtered = Object.entries(data).filter(([key]) => !['id', 'userId', 'createdAt'].includes(key))
  const updates = filtered.map(([key]) => `${camelToSnake(key)} = ?`).join(', ')
  const values = filtered.map(([, val]) => val)
  if (!updates) return
  await execute(`UPDATE important_announcements SET ${updates}, updated_at = ?, _synced = 0 WHERE id = ?`, [...values, Date.now(), id])
  const updated = await getAnnouncementById(id)
  if (updated) void syncRowToSupabase('important_announcements', updated).catch(err => console.warn('Background sync failed for important_announcements:', err))
}

export async function deleteAnnouncement(id: string): Promise<void> {
  const { error } = await supabase.from('important_announcements').delete().eq('id', id)
  if (error) {
    console.warn('[deleteAnnouncement] remote delete failed:', error)
    await execute(`UPDATE important_announcements SET deleted_at = ?, _synced = 0 WHERE id = ?`, [Date.now(), id])
    return
  }
  await execute('DELETE FROM important_announcements WHERE id = ?', [id])
}

// ─── VERSION DROPPERS ─────────────────────────────────────────────────────────
export async function createVersionDropper(data: Omit<VersionDropper, 'id'>): Promise<VersionDropper> {
  const id = uuid.v4() as string
  const version = { id, ...data }
  await execute(
    'INSERT INTO version_droppers (id, title, user_id, youtube_url, description, created_at, updated_at, _synced) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [version.id, version.title, version.userId, version.youtubeUrl, version.description || '', version.createdAt, version.updatedAt, 0]
  )
  void syncRowToSupabase('version_droppers', version).catch(err => console.warn('Background sync failed for version_droppers:', err))
  return version
}

export async function getVersionDropperById(id: string): Promise<VersionDropper | null> {
  const result = await queryOne('SELECT * FROM version_droppers WHERE id = ?', [id])
  return result ? mapVersionDropper(result) : null
}

export async function getVersionDroppersByUserId(userId: string): Promise<VersionDropper[]> {
  const results = await query('SELECT * FROM version_droppers WHERE user_id = ? ORDER BY created_at DESC', [userId])
  return results.map(mapVersionDropper)
}

export async function getAllVersionDroppers(): Promise<VersionDropper[]> {
  const { data } = await supabase.from('version_droppers').select('*').order('created_at', { ascending: false })
  if (data && data.length > 0) return data.map(mapVersionDropper)

  const results = await query('SELECT * FROM version_droppers ORDER BY created_at DESC')
  return results.map(mapVersionDropper)
}

export async function updateVersionDropper(id: string, data: Partial<VersionDropper>): Promise<void> {
  const filtered = Object.entries(data).filter(([key]) => !['id', 'userId', 'createdAt'].includes(key))
  const updates = filtered.map(([key]) => `${camelToSnake(key)} = ?`).join(', ')
  const values = filtered.map(([, val]) => val)
  if (!updates) return
  await execute(`UPDATE version_droppers SET ${updates}, updated_at = ?, _synced = 0 WHERE id = ?`, [...values, Date.now(), id])
  const updated = await getVersionDropperById(id)
  if (updated) void syncRowToSupabase('version_droppers', updated).catch(err => console.warn('Background sync failed for version_droppers:', err))
}

// ─── TEAM CALENDAR EVENTS ────────────────────────────────────────────────────
function serializeCalendarAssignments(assignments: CalendarAssignment[] | undefined): string {
  return JSON.stringify(Array.isArray(assignments) ? assignments : [])
}

function parseCalendarAssignments(value: any): CalendarAssignment[] {
  if (!value) return []
  if (Array.isArray(value)) return value as CalendarAssignment[]
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function mapCalendarEvent(row: any): CalendarEvent {
  return {
    id: row.id,
    eventDate: row.event_date,
    title: row.title,
    assignments: parseCalendarAssignments(row.assignments),
    notes: row.notes || '',
    userId: row.user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    synced: Boolean(row._synced),
  }
}

export async function createCalendarEvent(data: Omit<CalendarEvent, 'id'>): Promise<CalendarEvent> {
  const id = uuid.v4() as string
  const event = { id, ...data }
  await execute(
    'INSERT INTO team_calendar_events (id, event_date, title, assignments, notes, user_id, created_at, updated_at, _synced) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [event.id, event.eventDate, event.title, serializeCalendarAssignments(event.assignments), event.notes || '', event.userId, event.createdAt, event.updatedAt, 0]
  )
  void syncRowToSupabase('team_calendar_events', event).catch(err => console.warn('Background sync failed for team_calendar_events:', err))
  return event
}

export async function getCalendarEventById(id: string): Promise<CalendarEvent | null> {
  const result = await queryOne('SELECT * FROM team_calendar_events WHERE id = ?', [id])
  return result ? mapCalendarEvent(result) : null
}

export async function getAllCalendarEvents(): Promise<CalendarEvent[]> {
  const { data } = await supabase.from('team_calendar_events').select('*').order('event_date', { ascending: true }).order('created_at', { ascending: true })
  if (data && data.length > 0) return data.map(mapCalendarEvent)

  const results = await query('SELECT * FROM team_calendar_events ORDER BY event_date ASC, created_at ASC')
  return results.map(mapCalendarEvent)
}

export async function updateCalendarEvent(id: string, data: Partial<CalendarEvent>): Promise<void> {
  const filtered = Object.entries(data).filter(([key]) => !['id', 'userId', 'synced', 'createdAt'].includes(key))
  const updates = filtered.map(([key]) => `${camelToSnake(key)} = ?`).join(', ')
  const values = filtered.map(([key, val]) => key === 'assignments' ? serializeCalendarAssignments(val as CalendarAssignment[]) : val)
  if (!updates) return
  await execute(`UPDATE team_calendar_events SET ${updates}, updated_at = ?, _synced = 0 WHERE id = ?`, [...values, Date.now(), id])
  const updated = await getCalendarEventById(id)
  if (updated) void syncRowToSupabase('team_calendar_events', updated).catch(err => console.warn('Background sync failed for team_calendar_events:', err))
}

export async function deleteCalendarEvent(id: string): Promise<void> {
  await execute('DELETE FROM team_calendar_events WHERE id = ?', [id])
  void deleteRowFromSupabase('team_calendar_events', id).catch(err => console.warn('Background delete sync failed for team_calendar_events:', err))
}

// ─── CONTACTS ─────────────────────────────────────────────────────────────────
export async function addContact(data: Omit<Contact, 'id'>): Promise<Contact> {
  const id = uuid.v4() as string
  const contact = { id, ...data }
  await execute(
    'INSERT INTO contacts (id, user_id, contact_user_id, contact_email, contact_name, status, created_at, updated_at, _synced) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [contact.id, contact.userId, contact.contactUserId, contact.contactEmail || '', contact.contactName || '', contact.status, contact.createdAt, contact.updatedAt, 0]
  )
  await syncRowToSupabase('contacts', contact)
  return contact
}

export async function getContactById(id: string): Promise<Contact | null> {
  if (await isOnline()) {
    const { data } = await supabase.from('contacts').select('*').eq('id', id).limit(1)
    if (data && data.length > 0) return mapContact(data[0])
  }

  const result = await queryOne('SELECT * FROM contacts WHERE id = ?', [id])
  return result ? mapContact(result) : null
}

export async function getContactsByUserId(userId: string): Promise<Contact[]> {
  if (await isOnline()) {
    const { data } = await supabase.from('contacts').select('*').eq('user_id', userId).order('created_at', { ascending: false })
    if (data && data.length > 0) return data.map(mapContact)
  }

  const results = await query('SELECT * FROM contacts WHERE user_id = ? ORDER BY created_at DESC', [userId])
  return results.map(mapContact)
}

export async function getContactByUserIdAndContactUserId(userId: string, contactUserId: string): Promise<Contact | null> {
  if (await isOnline()) {
    const { data } = await supabase
      .from('contacts')
      .select('*')
      .eq('user_id', userId)
      .eq('contact_user_id', contactUserId)
      .limit(1)
    if (data && data.length > 0) return mapContact(data[0])
  }

  const result = await queryOne(
    'SELECT * FROM contacts WHERE user_id = ? AND contact_user_id = ?',
    [userId, contactUserId]
  )
  return result ? mapContact(result) : null
}

export async function updateContact(id: string, data: Partial<Contact>): Promise<void> {
  const filtered = Object.entries(data).filter(([key]) => !['id', 'userId', 'createdAt'].includes(key))
  const updates = filtered.map(([key]) => `${camelToSnake(key)} = ?`).join(', ')
  const values = filtered.map(([, val]) => val)
  if (!updates) return
  await execute(`UPDATE contacts SET ${updates}, updated_at = ?, _synced = 0 WHERE id = ?`, [...values, Date.now(), id])
  const updated = await getContactById(id)
  if (updated) await syncRowToSupabase('contacts', updated)
}

export async function deleteContact(id: string): Promise<void> {
  await execute('DELETE FROM contacts WHERE id = ?', [id])
  await deleteRowFromSupabase('contacts', id)
}

// ─── USER PROFILES ────────────────────────────────────────────────────────────
export async function createUserProfile(data: Omit<UserProfile, 'id'>): Promise<UserProfile> {
  const id = uuid.v4() as string
  const profile = { id, ...data }
  await execute(
    'INSERT INTO user_profiles (id, user_id, nickname, bio, avatar_url, instruments, role, created_at, updated_at, _synced) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [profile.id, profile.userId, profile.nickname || '', profile.bio || '', profile.avatarUrl || '', profile.instruments || '', profile.role || 'user', profile.createdAt, profile.updatedAt, 0]
  )
  await syncRowToSupabase('user_profiles', profile)
  return profile
}

export async function getUserProfileByUserId(userId: string): Promise<UserProfile | null> {
  const result = await queryOne('SELECT * FROM user_profiles WHERE user_id = ?', [userId])
  return result ? mapUserProfile(result) : null
}

export async function updateUserProfile(userId: string, data: Partial<UserProfile>): Promise<void> {
  const filtered = Object.entries(data).filter(([key]) => 
    !['id', 'userId', 'synced', 'createdAt', 'updatedAt'].includes(key)
  )
  const updates = filtered.map(([key]) => `${camelToSnake(key)} = ?`).join(', ')
  const values = filtered.map(([, val]) => val)
  if (!updates) return
  await execute(`UPDATE user_profiles SET ${updates}, updated_at = ?, _synced = 0 WHERE user_id = ?`, [...values, Date.now(), userId])
  const updated = await getUserProfileByUserId(userId)
  if (updated) await syncRowToSupabase('user_profiles', updated)
}

export async function deleteUserProfile(userId: string): Promise<void> {
  const profile = await getUserProfileByUserId(userId)
  if (profile) await deleteRowFromSupabase('user_profiles', profile.id)
  await execute('DELETE FROM user_profiles WHERE user_id = ?', [userId])
}

// ─── PLAYLISTS ────────────────────────────────────────────────────────────────
export async function createPlaylist(data: Omit<Playlist, 'id'>): Promise<Playlist> {
  const id = uuid.v4() as string
  const playlist = { id, ...data }
  await execute(
    'INSERT INTO playlists (id, user_id, title, description, created_at, updated_at, _synced) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [playlist.id, playlist.userId, playlist.title, playlist.description || '', playlist.createdAt, playlist.updatedAt, 0]
  )
  await syncRowToSupabase('playlists', playlist)
  return playlist
}

export async function getPlaylistById(id: string): Promise<Playlist | null> {
  if (await isOnline()) {
    const { data } = await supabase.from('playlists').select('*').eq('id', id).limit(1)
    if (data && data.length > 0) return mapPlaylist(data[0])
  }

  const result = await queryOne('SELECT * FROM playlists WHERE id = ?', [id])
  return result ? mapPlaylist(result) : null
}

export async function getPlaylistsByUserId(userId: string): Promise<Playlist[]> {
  if (await isOnline()) {
    const { data } = await supabase.from('playlists').select('*').eq('user_id', userId).order('created_at', { ascending: false })
    if (data && data.length > 0) return data.map(mapPlaylist)
  }

  const results = await query('SELECT * FROM playlists WHERE user_id = ? ORDER BY created_at DESC', [userId])
  return results.map(mapPlaylist)
}

export async function updatePlaylist(id: string, data: Partial<Playlist>): Promise<void> {
  const filtered = Object.entries(data).filter(([key]) => !['id', 'userId', 'synced', 'createdAt'].includes(key))
  const updates = filtered.map(([key]) => `${camelToSnake(key)} = ?`).join(', ')
  const values = filtered.map(([, val]) => val)
  if (!updates) return
  await execute(`UPDATE playlists SET ${updates}, updated_at = ?, _synced = 0 WHERE id = ?`, [...values, Date.now(), id])
  const updated = await getPlaylistById(id)
  if (updated) await syncRowToSupabase('playlists', updated)
}

export async function deletePlaylist(id: string): Promise<void> {
  const items = await query('SELECT id FROM playlist_items WHERE playlist_id = ?', [id]) as { id: string }[]
  for (const item of items) {
    await deleteRowFromSupabase('playlist_items', item.id)
  }
  await execute('DELETE FROM playlist_items WHERE playlist_id = ?', [id])
  await execute('DELETE FROM playlists WHERE id = ?', [id])
  await deleteRowFromSupabase('playlists', id)
}

// ─── PLAYLIST ITEMS ───────────────────────────────────────────────────────────
export async function addToPlaylist(data: Omit<PlaylistItem, 'id'>): Promise<PlaylistItem> {
  const id = uuid.v4() as string
  const item = { id, ...data }
   await execute(
    'INSERT INTO playlist_items (id, playlist_id, user_id, chord_list_id, song_id, position, created_at, updated_at, _synced) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [item.id, item.playlistId, item.userId || '', item.chordListId || null, item.songId || null, item.position, item.createdAt, Date.now(), 0]
  )
  await syncRowToSupabase('playlist_items', item)
  return item
}

export async function getPlaylistItems(playlistId: string): Promise<PlaylistItem[]> {
  // Always read from local DB first — addToPlaylist writes locally then syncs async,
  // so Supabase may not have the new row yet when we immediately reload.
  const localResults = await query(
    'SELECT * FROM playlist_items WHERE playlist_id = ? ORDER BY position ASC',
    [playlistId]
  )
  if (localResults && localResults.length > 0) return localResults.map(mapPlaylistItem)

  // Fallback: if local is empty (e.g. fresh install), try Supabase
  if (await isOnline()) {
    const { data } = await supabase
      .from('playlist_items')
      .select('*')
      .eq('playlist_id', playlistId)
      .order('position', { ascending: true })
    if (data && data.length > 0) return data.map(mapPlaylistItem)
  }

  return []
}

export async function removeFromPlaylist(id: string): Promise<void> {
  await execute('DELETE FROM playlist_items WHERE id = ?', [id])
  await deleteRowFromSupabase('playlist_items', id)
}

export async function updatePlaylistItemPosition(id: string, position: number): Promise<void> {
  await execute('UPDATE playlist_items SET position = ?, _synced = 0 WHERE id = ?', [position, id])
  const updated = await queryOne('SELECT * FROM playlist_items WHERE id = ?', [id])
  if (updated) await syncRowToSupabase('playlist_items', mapPlaylistItem(updated))
}

export async function getUnsyncedRecords(table: string): Promise<any[]> {
  return await query(`SELECT * FROM ${table} WHERE _synced = 0`)
}

// ─── MAPPERS ──────────────────────────────────────────────────────────────────
function mapArtist(row: any): Artist {
  return {
    id: row.id,
    name: row.name,
    userId: row.user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    synced: Boolean(row._synced),
  }
}

function mapChordList(row: any): ChordList {
  return {
    id: row.id,
    title: row.title,
    artistId: row.artist_id,
    userId: row.user_id,
    isPrivate: Boolean(row.is_private),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    synced: Boolean(row._synced),
  }
}

function mapSong(row: any): Song {
  return {
    id: row.id,
    chordListId: row.chord_list_id,
    userId: row.user_id,
    title: row.title,
    content: row.content,
    key: row.key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    synced: Boolean(row._synced),
    youtubeUrl: row.youtube_url,
  }
    
}

function mapLineup(row: any): Lineup {
  return {
    id: row.id,
    title: row.title,
    userId: row.user_id,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    synced: Boolean(row._synced),
  }
}

function mapLineupItem(row: any): LineupItem {
  return {
    id: row.id,
    lineupId: row.lineup_id,
    songId: row.song_id || '',
    userId: row.user_id,
    position: row.position,
    artist: row.artist || '',
    songTitle: row.song_title || '',
    key: row.song_key || '',
    versionUrl: row.version_url || row.youtube_url || '',
    category: row.category || 'any',
    createdAt: row.created_at,
    updatedAt: row.updated_at || row.created_at || Date.now(),
    synced: Boolean(row._synced),
  }
}

function mapMessage(row: any): Message {
  return {
    id: row.id,
    senderId: row.sender_id,
    receiverId: row.receiver_id,
    text: row.text,
    createdAt: row.created_at,
    updatedAt: row.updated_at || row.created_at,
    isDeleted: Boolean(row.is_deleted),
    editedAt: row.edited_at || undefined,
    synced: Boolean(row._synced),
  }
}

function mapFileDropper(row: any): FileDropper {
  return {
    id: row.id,
    title: row.title,
    userId: row.user_id,
    fileUrl: row.file_url,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    synced: Boolean(row._synced),
  }
}

function mapImportantAnnouncement(row: any): ImportantAnnouncement {
  return {
    id: row.id,
    title: row.title,
    userId: row.user_id,
    content: row.content,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    synced: Boolean(row._synced),
  }
}

function mapImportantMessage(row: any): ImportantMessage {
  return {
    id: row.id,
    title: row.title,
    userId: row.user_id,
    content: row.content,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    synced: Boolean(row._synced),
  }
}

function mapVersionDropper(row: any): VersionDropper {
  return {
    id: row.id,
    title: row.title,
    userId: row.user_id,
    youtubeUrl: row.youtube_url,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    synced: Boolean(row._synced),
  }
}

function mapContact(row: any): Contact {
  return {
    id: row.id,
    userId: row.user_id,
    contactUserId: row.contact_user_id,
    contactEmail: row.contact_email,
    contactName: row.contact_name,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    synced: Boolean(row._synced),
  }
}

function mapUserProfile(row: any): UserProfile {
  return {
    id: row.id,
    userId: row.user_id,
    nickname: row.nickname,
    bio: row.bio,
    avatarUrl: row.avatar_url,
    instruments: row.instruments,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    synced: Boolean(row._synced),
    role: row.role ?? 'user',
  }
}

function mapPlaylist(row: any): Playlist {
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    synced: Boolean(row._synced),
  }
}

function mapPlaylistItem(row: any): PlaylistItem {
  return {
    id: row.id,
    playlistId: row.playlist_id,
    userId: row.user_id,
    chordListId: row.chord_list_id,
    songId: row.song_id,
    position: row.position,
    createdAt: row.created_at,
    synced: Boolean(row._synced),
  }
}

// db/queries.ts — add this alongside getContactsByUserId
export async function getContactsByRecipientId(recipientId: string): Promise<Contact[]> {
  const results = await query('SELECT * FROM contacts WHERE contact_user_id = ? ORDER BY created_at DESC', [recipientId])
  return results.map(mapContact)
}

// ─── IMPORTANT MESSAGES ────────────────────────────────────────────────────
export async function createImportantMessage(data: Omit<ImportantMessage, 'id'>): Promise<ImportantMessage> {
  const id = uuid.v4() as string
  const message = { id, ...data }
  await execute(
    'INSERT INTO important_messages (id, title, user_id, content, created_at, updated_at, _synced) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [message.id, message.title, message.userId, message.content, message.createdAt, message.updatedAt, 0]
  )
  void syncRowToSupabase('important_messages', message).catch(err => console.warn('Background sync failed for important_messages:', err))
  return message
}

export async function getImportantMessageById(id: string): Promise<ImportantMessage | null> {
  const result = await queryOne('SELECT * FROM important_messages WHERE id = ?', [id])
  return result ? mapImportantMessage(result) : null
}

export async function getImportantMessagesByUserId(userId: string): Promise<ImportantMessage[]> {
  const results = await query('SELECT * FROM important_messages WHERE user_id = ? ORDER BY created_at DESC', [userId])
  return results.map(mapImportantMessage)
}

export async function getAllImportantMessages(): Promise<ImportantMessage[]> {
  const { data } = await supabase.from('important_messages').select('*').order('created_at', { ascending: false })
  if (data && data.length > 0) return data.map(mapImportantMessage)

  const results = await query('SELECT * FROM important_messages ORDER BY created_at DESC')
  return results.map(mapImportantMessage)
}

export async function updateImportantMessage(id: string, data: Partial<ImportantMessage>): Promise<void> {
  const filtered = Object.entries(data).filter(([key]) => !['id', 'userId', 'createdAt'].includes(key))
  const updates = filtered.map(([key]) => `${camelToSnake(key)} = ?`).join(', ')
  const values = filtered.map(([, val]) => val)
  if (!updates) return
  await execute(`UPDATE important_messages SET ${updates}, updated_at = ?, _synced = 0 WHERE id = ?`, [...values, Date.now(), id])
  const updated = await getImportantMessageById(id)
  if (updated) void syncRowToSupabase('important_messages', updated).catch(err => console.warn('Background sync failed for important_messages:', err))
}

export async function deleteImportantMessage(id: string): Promise<void> {
  const { error } = await supabase.from('important_messages').delete().eq('id', id)
  if (error) {
    console.warn('[deleteImportantMessage] remote delete failed:', error)
    await execute(`UPDATE important_messages SET deleted_at = ?, _synced = 0 WHERE id = ?`, [Date.now(), id])
    return
  }
  await execute('DELETE FROM important_messages WHERE id = ?', [id])
}

// ─── RE-EXPORTS ───────────────────────────────────────────────────────────────
export { query, queryOne, execute, transaction }