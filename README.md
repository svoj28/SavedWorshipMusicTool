# Saved Worship Music Tool

A React Native + Expo app for managing chord lists, lyrics, and worship music setlists with offline support and real-time sync.

Runs on Android, iOS **and the web** from this one project - the same screens, the same SQL, one codebase. The web build differs in exactly one way: **it has no offline mode.** See [Web build](#web-build).

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React Native + Expo (web via react-native-web) |
| Local DB | expo-sqlite on device; sql.js in memory on web |
| Backend | Supabase (PostgreSQL, Auth, Realtime) |
| Audio | Expo AV |
| Navigation | React Navigation (Tab + Stack) |
| Language | TypeScript |

---

## Project Structure

```
SavedWorshipMusicTool/
├── App.tsx                          # Root component with auth & navigation
├── index.ts                         # App entry point
├── package.json                     # Dependencies
├── tsconfig.json                    # TypeScript config
│
├── assets/
│   ├── SavedLOGO.png               # App logo
│   └── sounds/
│       └── click.wav               # Metronome click sound
│
├── db/
│   ├── index.ts                    # Database initialization
│   ├── schema.ts                   # WatermelonDB schema definition
│   └── models.ts                   # WatermelonDB model classes
│
├── lib/
│   ├── supabase.ts                 # Supabase client (DO NOT COMMIT)
│   ├── supabase.example.ts         # Supabase client template
│   ├── auth.ts                     # Authentication utilities
│   ├── sync.ts                     # Sync adapter (pull/push to Supabase)
│   └── transpose.ts                # Pure chord transposition logic
│
└── screens/
    ├── SignInScreen.tsx             # Email + Google login
    ├── SignUpScreen.tsx             # Email registration
    ├── ChordListsHomeScreen.tsx     # Browse chord lists
    ├── ChordListScreen.tsx          # View/edit song with transpose
    ├── AddSongScreen.tsx            # Add new song
    ├── MetronomeScreen.tsx          # BPM slider + tap tempo + audio
    ├── ManualTransposeScreen.tsx    # Manual chord transposition
    ├── PersonalNotesScreen.tsx      # Private user-only chord lists
    ├── ManagementScreen.tsx         # App management
    ├── ConversationScreen.tsx       # Real-time chat
    ├── AddContactsScreen.tsx        # Add contacts
    ├── EditAccountScreen.tsx        # Edit user profile
    └── AudioToolsScreen.tsx         # Audio utilities
```

---

## Features

### Chord Lists with Lyrics/Chords Toggle
- **Display Modes**: Lyrics only, Chords only, or Both
- **Transpose**: Shift all chords up/down by semitones
- **Format**: Chords embedded in `[chord]` format — e.g. `[G]Amazing [D]grace`

### Auto-Transpose Utility
- `transposeChord("G", 2)` → `"A"`
- `transposeText("[G]Song", -3)` → `"[Eb]Song"`
- Handles sharps/flats, minor chords, extended chords
- Full 12-note chromatic scale with wraparound

### Metronome
- BPM slider (40–300)
- Tap tempo with averaging
- Audio click via Expo AV
- Preset tempos: 60, 90, 120, 140, 160
- Visual beat indicator

### Offline Sync (WatermelonDB)
- All reads/writes go to local SQLite first
- UI never queries Supabase directly
- Sync adapter pushes/pulls changes in the background
- `_synced` boolean tracks sync status per record

### Web build
The browser runs the same app, with every feature it has. The only difference is that **nothing is stored**.

- **Native** keeps SQLite in a file and copies imported audio into its own directory. That is what lets the app work with no signal and pick up where it left off.
- **Web** opens SQLite (via sql.js, SQLite compiled to WebAssembly) **in memory**, and keeps imported audio as object URLs belonging to the page. Both die with the tab, so the web build requires a connection and has no offline queue to reconcile.

Nothing is switched off for being on the web. Chord lists, lineups, chat, the pad, metronome, tuner, Audio Tools, importing your own pads and scanning a QR code all work in a browser. Where a feature needs a file, the file lives for the session instead of forever.

Keeping SQL on both sides is what makes one project possible: every screen, `db/queries.ts` and `lib/sync.ts` are shared verbatim. The platform differences live in a handful of files picked up by extension:

| Concern | Native | Web |
|---|---|---|
| Database | `db/index.ts` | `db/index.web.ts` (in memory) |
| Schema | `db/bootstrapSql.ts` (shared) | same |
| WebView-hosted audio engines | `components/EngineWebView.tsx` | `components/EngineWebView.web.tsx` (iframe) |
| QR scanner | `components/ScannerCamera.tsx` (expo-camera) | `components/ScannerCamera.web.tsx` (getUserMedia + jsQR) |
| Imported audio | `lib/audioFileManager.ts` (cache dir) | `lib/audioFileManager.web.ts` (object URLs) |
| Connectivity | `lib/networkStatus.ts` | `lib/networkStatus.web.ts` |
| Reconnect catch-up | `lib/networkSync.ts` | `lib/networkSync.web.ts` (no-op) |
| Offline warning | `components/WebOfflineNotice.tsx` (renders nothing) | `components/WebOfflineNotice.web.tsx` |
| Alert dialogs | React Native's `Alert` | `lib/webAlert.web.ts` (RNW's is a no-op) |

`lib/platform.ts` exposes the single flag this rests on, `SUPPORTS_OFFLINE`. It decides **how long something is kept, never whether it is offered**.

Web notes:
- **Sign-in is required.** Native falls back to a cached identity, or an `offline-guest`, when the session check fails — that is how it keeps working with no signal. Neither applies in a browser, so on web a live Supabase session is the only thing that counts as signed in.
- Signing out clears the in-memory database, so a shared computer does not hand the next person the last one's data. Native keeps its copy on purpose.
- expo-camera cannot read barcodes on web, so the scanner is built on `getUserMedia` + `jsQR` behind the same component API.
- `Alert.alert` is an empty function in react-native-web. `lib/webAlert.web.ts` installs a real dialog over it at startup, so the app's existing alerts, confirmations and their `onPress` handlers behave the same on both platforms.

### Auth (Supabase)
- Email + password sign up / sign in
- Google OAuth
- Persistent sessions via AsyncStorage
- Reactive auth state listener

### Personal Notes
- Private chord lists scoped to logged-in user
- Created via modal on PersonalNotesScreen

---

## Setup

### 1. Prerequisites
```bash
npm install -g expo-cli
node --version  # Node 16+ required
```

### 2. Install Dependencies
```bash
cd SavedWorshipMusicTool
npm install
```

### 3. Configure Supabase

Copy the example file and fill in your keys:
```bash
cp lib/supabase.example.ts lib/supabase.ts
```

Edit `lib/supabase.ts`:
```ts
const supabaseUrl = 'YOUR_SUPABASE_URL'
const supabaseAnonKey = 'YOUR_SUPABASE_ANON_KEY'
```

> ⚠️ `lib/supabase.ts` is gitignored. Never commit your real keys.

Get your keys from: [supabase.com](https://supabase.com) → Project → **Settings → API**

### 4. Create Supabase Tables

Run this SQL in your Supabase SQL editor:

```sql
CREATE TABLE artists (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  user_id UUID NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  _synced BOOLEAN DEFAULT false
);

CREATE TABLE chord_lists (
  id UUID PRIMARY KEY,
  title TEXT NOT NULL,
  artist_id UUID REFERENCES artists(id),
  user_id UUID NOT NULL,
  is_private BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  _synced BOOLEAN DEFAULT false
);

CREATE TABLE songs (
  id UUID PRIMARY KEY,
  chord_list_id UUID REFERENCES chord_lists(id),
  title TEXT NOT NULL,
  content TEXT,
  key TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  _synced BOOLEAN DEFAULT false
);

CREATE TABLE lineups (
  id UUID PRIMARY KEY,
  title TEXT NOT NULL,
  user_id UUID NOT NULL,
  description TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  _synced BOOLEAN DEFAULT false
);

CREATE TABLE lineup_items (
  id UUID PRIMARY KEY,
  lineup_id UUID REFERENCES lineups(id),
  song_id UUID REFERENCES songs(id),
  position INTEGER,
  created_at TIMESTAMP DEFAULT NOW(),
  _synced BOOLEAN DEFAULT false
);

CREATE TABLE messages (
  id UUID PRIMARY KEY,
  sender_id UUID NOT NULL,
  receiver_id UUID NOT NULL,
  text TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  _synced BOOLEAN DEFAULT false
);
```

### 5. Enable Auth Providers
- Supabase dashboard → **Authentication → Providers**
- Enable **Email**
- Configure **Google OAuth** (requires Google Cloud project)

### 6. Add Metronome Audio
Place a click sound at `assets/sounds/click.wav`.

### 7. Run the App
```bash
npm start           # Expo dev server
npm run android     # Android emulator
npm run ios         # iOS simulator
npm run web         # Browser (no offline mode - see Web build)
```

To produce a deployable web bundle:
```bash
npm run build:web   # static site in dist/
```

---

## Building an APK

```bash
# Make sure android/local.properties has your SDK path:
# sdk.dir=C\:/Users/YourName/AppData/Local/Android/Sdk

cd android
./gradlew assembleDebug
```

Output: `android/app/build/outputs/apk/debug/app-debug.apk`

---

## Sync Strategy

```typescript
// Push local changes to Supabase
await syncPushToSupabase(userId)

// Pull server changes to local
await syncPullFromSupabase(userId, lastSyncTime)

// Full sync (pull first, then push)
await fullSync(userId)
```

---

## Usage Examples

```typescript
// Transpose a single chord
transposeChord('Dm', 2)  // → "Em"

// Transpose an entire lyrics block
transposeText("[G]Amazing [D]grace how [A]sweet", 3)
// → "[Bb]Amazing [F]grace how [C]sweet"

// Query songs by chord list
const songs = await database
  .get('songs')
  .query()
  .where('chord_list_id', chordListId)
  .fetch()

// Get private notes
const myNotes = await database
  .get('chord_lists')
  .query()
  .where('user_id', userId)
  .where('is_private', true)
  .fetch()
```

---

## Troubleshooting

**Database not syncing** — Check `_synced` field, verify Supabase connection, and review RLS policies.

**Auth session lost** — Verify AsyncStorage is configured in `supabase.ts` and check Supabase dashboard for active sessions.

**Metronome audio not playing** — Ensure `assets/sounds/click.wav` exists and audio permissions are set in `app.json`.

**Transpose not working** — Verify chord format uses `[chord]` pattern and check `lib/transpose.ts` for supported note formats.

**Android build fails (SDK not found)** — Make sure `android/local.properties` contains the correct `sdk.dir` path.

---

## Future Features

- [ ] Song lyrics search
- [ ] Playlist creation
- [ ] Social sharing (lineups)
- [x] In-app activity feed for shared updates
- [ ] Audio recording for practice
- [ ] Chord diagram visualizations

---

## References

- [WatermelonDB Docs](https://nozbe.github.io/WatermelonDB/)
- [Supabase Docs](https://supabase.com/docs)
- [React Navigation](https://reactnavigation.org/)
- [Expo AV](https://docs.expo.dev/versions/latest/sdk/av/)
- [EAS Build](https://docs.expo.dev/build/setup/)
