// db/bootstrapSql.ts
/**
 * The schema, in one place, for both platforms.
 *
 * Native opens a file on disk that may have been created by any older version
 * of the app, so it needs the migrations as well as the tables. Web builds a
 * fresh in-memory database on every load and could skip them - but running the
 * same statements on both is the only way the two stay honestly identical, and
 * an ALTER against a column that is already there is caught and ignored either
 * way.
 */

/** Tables and indexes. Safe to re-run: everything is IF NOT EXISTS. */
export const CREATE_TABLES_SQL = `
      
      CREATE TABLE IF NOT EXISTS artists (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        user_id TEXT NOT NULL,
        created_at INTEGER,
        updated_at INTEGER,
        _synced INTEGER DEFAULT 0
      );
      
      CREATE TABLE IF NOT EXISTS chord_lists (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        artist_id TEXT,
        user_id TEXT NOT NULL,
        is_private INTEGER DEFAULT 0,
        created_at INTEGER,
        updated_at INTEGER,
        _synced INTEGER DEFAULT 0
      );
      
      CREATE TABLE IF NOT EXISTS songs (
        id TEXT PRIMARY KEY,
        chord_list_id TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT,
        key TEXT,
        created_at INTEGER,
        updated_at INTEGER,
        _synced INTEGER DEFAULT 0,
        youtube_url TEXT
      );
        
      CREATE TABLE IF NOT EXISTS important_messages (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        content TEXT,
        user_id TEXT,
        created_at INTEGER,
        updated_at INTEGER,
        deleted_at INTEGER,
        _synced INTEGER DEFAULT 0
      );
      
      CREATE TABLE IF NOT EXISTS lineups (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        user_id TEXT NOT NULL,
        description TEXT,
        created_at INTEGER,
        updated_at INTEGER,
        _synced INTEGER DEFAULT 0
      );
      
      CREATE TABLE IF NOT EXISTS lineup_items (
        id TEXT PRIMARY KEY,
        lineup_id TEXT NOT NULL,
        song_id TEXT NOT NULL DEFAULT '',
        user_id TEXT DEFAULT '',
        position INTEGER,
        created_at INTEGER,
        updated_at INTEGER,
        artist TEXT,
        song_title TEXT,
        song_key TEXT,
        version_url TEXT,
        category TEXT DEFAULT 'any',
        _synced INTEGER DEFAULT 0
      );
      
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        sender_id TEXT NOT NULL,
        receiver_id TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at INTEGER,
        updated_at INTEGER,
        is_deleted INTEGER DEFAULT 0,
        edited_at INTEGER,
        _synced INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS file_droppers (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        user_id TEXT NOT NULL,
        file_url TEXT NOT NULL,
        description TEXT,
        created_at INTEGER,
        updated_at INTEGER,
        _synced INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS important_announcements (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        user_id TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER,
        updated_at INTEGER,
        _synced INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS version_droppers (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        user_id TEXT NOT NULL,
        youtube_url TEXT NOT NULL,
        description TEXT,
        created_at INTEGER,
        updated_at INTEGER,
        _synced INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS team_calendar_events (
        id TEXT PRIMARY KEY,
        event_date TEXT NOT NULL,
        title TEXT NOT NULL,
        assignments TEXT,
        notes TEXT,
        user_id TEXT NOT NULL,
        created_at INTEGER,
        updated_at INTEGER,
        _synced INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS contacts (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        contact_user_id TEXT NOT NULL,
        contact_email TEXT,
        contact_name TEXT,
        status TEXT DEFAULT 'pending',
        created_at INTEGER,
        updated_at INTEGER,
        _synced INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS user_profiles (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL UNIQUE,
        nickname TEXT,
        bio TEXT,
        avatar_url TEXT,
        instruments TEXT,
        created_at INTEGER,
        updated_at INTEGER,
        _synced INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS playlists (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        created_at INTEGER,
        updated_at INTEGER,
        _synced INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS playlist_items (
        id TEXT PRIMARY KEY,
        playlist_id TEXT NOT NULL,
        chord_list_id TEXT,
        song_id TEXT,
        position INTEGER,
        created_at INTEGER,
        _synced INTEGER DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_artists_user_id ON artists(user_id);
      CREATE INDEX IF NOT EXISTS idx_chord_lists_user_id ON chord_lists(user_id);
      CREATE INDEX IF NOT EXISTS idx_chord_lists_artist_id ON chord_lists(artist_id);
      CREATE INDEX IF NOT EXISTS idx_songs_chord_list_id ON songs(chord_list_id);
      CREATE INDEX IF NOT EXISTS idx_lineups_user_id ON lineups(user_id);
      CREATE INDEX IF NOT EXISTS idx_lineup_items_lineup_id ON lineup_items(lineup_id);
      CREATE INDEX IF NOT EXISTS idx_messages_sender_id ON messages(sender_id);
      CREATE INDEX IF NOT EXISTS idx_file_droppers_user_id ON file_droppers(user_id);
      CREATE INDEX IF NOT EXISTS idx_announcements_user_id ON important_announcements(user_id);
      CREATE INDEX IF NOT EXISTS idx_version_droppers_user_id ON version_droppers(user_id);
      CREATE INDEX IF NOT EXISTS idx_team_calendar_events_date ON team_calendar_events(event_date);
      CREATE INDEX IF NOT EXISTS idx_team_calendar_events_user_id ON team_calendar_events(user_id);
      CREATE INDEX IF NOT EXISTS idx_contacts_user_id ON contacts(user_id);
      CREATE INDEX IF NOT EXISTS idx_playlists_user_id ON playlists(user_id);
      CREATE INDEX IF NOT EXISTS idx_playlist_items_playlist_id ON playlist_items(playlist_id);
      CREATE INDEX IF NOT EXISTS idx_contacts_contact_user_id ON contacts(contact_user_id);
      CREATE INDEX IF NOT EXISTS idx_user_profiles_user_id ON user_profiles(user_id);
`

/**
 * Columns added after the original schema shipped.
 *
 * SQLite has no ADD COLUMN IF NOT EXISTS, so each of these is expected to fail
 * on a database that already has the column. Callers run them one at a time and
 * swallow the error - the failure is the check.
 */
export const MIGRATIONS: string[] = [
  "ALTER TABLE user_profiles ADD COLUMN created_at_iso TEXT",
  "ALTER TABLE user_profiles ADD COLUMN updated_at_iso TEXT",
  "ALTER TABLE artists ADD COLUMN created_at_iso TEXT",
  "ALTER TABLE artists ADD COLUMN updated_at_iso TEXT",
  "ALTER TABLE chord_lists ADD COLUMN created_at_iso TEXT",
  "ALTER TABLE chord_lists ADD COLUMN updated_at_iso TEXT",
  "ALTER TABLE songs ADD COLUMN created_at_iso TEXT",
  "ALTER TABLE songs ADD COLUMN updated_at_iso TEXT",
  "ALTER TABLE songs ADD COLUMN youtube_url TEXT",
  "ALTER TABLE lineups ADD COLUMN created_at_iso TEXT",
  "ALTER TABLE lineups ADD COLUMN updated_at_iso TEXT",
  "ALTER TABLE lineup_items ADD COLUMN created_at_iso TEXT",
  "ALTER TABLE lineup_items ADD COLUMN updated_at_iso TEXT",
  "ALTER TABLE messages ADD COLUMN created_at_iso TEXT",
  "ALTER TABLE messages ADD COLUMN updated_at_iso TEXT",
  "ALTER TABLE file_droppers ADD COLUMN created_at_iso TEXT",
  "ALTER TABLE file_droppers ADD COLUMN updated_at_iso TEXT",
  "ALTER TABLE important_announcements ADD COLUMN created_at_iso TEXT",
  "ALTER TABLE important_announcements ADD COLUMN updated_at_iso TEXT",
  "ALTER TABLE version_droppers ADD COLUMN created_at_iso TEXT",
  "ALTER TABLE version_droppers ADD COLUMN updated_at_iso TEXT",
  "ALTER TABLE team_calendar_events ADD COLUMN created_at_iso TEXT",
  "ALTER TABLE team_calendar_events ADD COLUMN updated_at_iso TEXT",
  "ALTER TABLE contacts ADD COLUMN created_at_iso TEXT",
  "ALTER TABLE contacts ADD COLUMN updated_at_iso TEXT",
  "ALTER TABLE playlists ADD COLUMN created_at_iso TEXT",
  "ALTER TABLE playlists ADD COLUMN updated_at_iso TEXT",
  "ALTER TABLE playlist_items ADD COLUMN created_at_iso TEXT",
  "ALTER TABLE playlist_items ADD COLUMN updated_at_iso TEXT",
  "ALTER TABLE user_profiles ADD COLUMN role TEXT DEFAULT 'user'",
  "ALTER TABLE chord_lists ADD COLUMN content TEXT",
  "ALTER TABLE messages ADD COLUMN updated_at INTEGER",
  "ALTER TABLE messages ADD COLUMN is_deleted INTEGER DEFAULT 0",
  "ALTER TABLE messages ADD COLUMN edited_at INTEGER",
  "ALTER TABLE songs ADD COLUMN user_id TEXT DEFAULT ''",
  "ALTER TABLE lineup_items ADD COLUMN user_id TEXT DEFAULT ''",
  "ALTER TABLE lineup_items ADD COLUMN artist TEXT",
  "ALTER TABLE lineup_items ADD COLUMN song_title TEXT",
  "ALTER TABLE lineup_items ADD COLUMN song_key TEXT",
  "ALTER TABLE lineup_items ADD COLUMN version_url TEXT",
  "ALTER TABLE lineup_items ADD COLUMN category TEXT DEFAULT 'any'",
  "ALTER TABLE messages ADD COLUMN user_id TEXT DEFAULT ''",
  "ALTER TABLE playlist_items ADD COLUMN user_id TEXT DEFAULT ''",
  "ALTER TABLE lineup_items ADD COLUMN updated_at INTEGER",
  "ALTER TABLE playlist_items ADD COLUMN updated_at INTEGER",
  "ALTER TABLE artists ADD COLUMN deleted_at INTEGER",
  "ALTER TABLE chord_lists ADD COLUMN deleted_at INTEGER",
  "ALTER TABLE songs ADD COLUMN deleted_at INTEGER",
  "ALTER TABLE lineups ADD COLUMN deleted_at INTEGER",
  "ALTER TABLE lineup_items ADD COLUMN deleted_at INTEGER",
  "ALTER TABLE messages ADD COLUMN deleted_at INTEGER",
  "ALTER TABLE file_droppers ADD COLUMN deleted_at INTEGER",
  "ALTER TABLE important_announcements ADD COLUMN deleted_at INTEGER",
  "ALTER TABLE version_droppers ADD COLUMN deleted_at INTEGER",
  "ALTER TABLE team_calendar_events ADD COLUMN deleted_at INTEGER",
  "ALTER TABLE contacts ADD COLUMN deleted_at INTEGER",
  "ALTER TABLE playlists ADD COLUMN deleted_at INTEGER",
  "ALTER TABLE playlist_items ADD COLUMN deleted_at INTEGER",
  "ALTER TABLE user_profiles ADD COLUMN deleted_at INTEGER",
]
