// screens/SongEditorScreen.tsx
// Unified Add + Edit screen — pass `songId` to edit, omit to add.
import React, { useState, useEffect, useRef , useMemo} from 'react'
import {
  View,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  Text,
  Alert,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  StatusBar,
  ActivityIndicator,
  RefreshControl,
} from 'react-native'
import { useAppTheme, type AppColors } from '../lib/theme'
import { execute, query } from '../db/index'
import { getCurrentUser } from '../lib/auth'
import uuid from 'react-native-uuid'
import Ionicons from '@expo/vector-icons/Ionicons'
import { usePullToRefresh } from '../lib/usePullToRefresh'

interface Props {
  route: any
  navigation: any
}

const NASHVILLE_CHORDS = [
  'I', 'ii', 'iii', 'IV', 'V', 'vi', 'viiD',
  'bI', 'bii', 'biii', 'bIV', 'bV', 'bvi', 'bviiD',
]
const COMMON_CHORDS = [
  'C', 'G', 'D', 'A', 'E', 'B', 'F', 'Bb',
  'Dm', 'Am', 'Em', 'Gm', 'Cm', 'FM', 'C7', 'G7',
]
const ALL_KEYS = [
  'C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B',
  'Db', 'Eb', 'Gb', 'Ab', 'Bb',
  'Cm', 'Dm', 'Em', 'Fm', 'Gm', 'Am', 'Bm',
]
const SONG_SECTIONS = [
  'Intro', 'Verse 1', 'Verse 2', 'Verse 3',
  'Pre-Chorus', 'Chorus 1', 'Chorus 2', 'Bridge', 'Outro',
]

export default function SongEditorScreen({ route, navigation }: Props) {
  const { colors: c } = useAppTheme()
  const styles = useMemo(() => makeStyles(c), [c])

  // ── Params ─────────────────────────────────────────────────────────────
  const { chordListId, songId } = route.params || {}
  const isEditing = Boolean(songId)

  // ── Form State ─────────────────────────────────────────────────────────
  const [title, setTitle]               = useState('')
  const [artist, setArtist]             = useState('')
  const [originalKey, setOriginalKey]   = useState('C')
  const [content, setContent]           = useState('')
  const [youtubeUrl, setYoutubeUrl]     = useState('')
  const [loading, setLoading]           = useState(false)
  const [initialLoading, setInitialLoading] = useState(isEditing)
  const [useNashville, setUseNashville] = useState(false)
  const [showKeyPicker, setShowKeyPicker] = useState(false)

  // ── Refs ───────────────────────────────────────────────────────────────
  const artistRef  = useRef<TextInput>(null)
  const contentRef = useRef<TextInput>(null)
  const cursorPosRef = useRef<{ start: number; end: number }>({ start: 0, end: 0 })

  // ── Load existing song if editing ──────────────────────────────────────
  useEffect(() => {
    if (isEditing) loadSong()
  }, [])

  const loadSong = async ({ silent = false }: { silent?: boolean } = {}) => {
    try {
      if (!silent) setInitialLoading(true)
      const rows: any[] = await query('SELECT * FROM songs WHERE id = ?', [songId])
      if (!rows || rows.length === 0) {
        if (!silent) Alert.alert('Error', 'Song not found')
        navigation.goBack()
        return
      }
      const song = rows[0]
      setTitle(song.title || '')
      setOriginalKey(song.key || 'C')
      setContent(song.content || '')
      setYoutubeUrl(song.youtube_url || '')

      // Optionally load artist name for display
      if (song.chord_list_id) {
        const clRows: any[] = await query(
          `SELECT a.name FROM chord_lists cl JOIN artists a ON cl.artist_id = a.id WHERE cl.id = ?`,
          [song.chord_list_id]
        )
        if (clRows && clRows.length > 0) setArtist(clRows[0].name || '')
      }
    } catch (err) {
      console.error('Error loading song:', err)
      if (!silent) Alert.alert('Error', 'Failed to load song')
    } finally {
      if (!silent) setInitialLoading(false)
    }
  }

  const { refreshing, onRefresh } = usePullToRefresh(() => (isEditing ? loadSong({ silent: true }) : Promise.resolve()))

  // ── Insert chord at cursor ─────────────────────────────────────────────
  const handleInsertChord = (chord: string) => {
    const { start, end } = cursorPosRef.current
    const before = content.slice(0, start)
    const after  = content.slice(end)
    const insertion = `[${chord}]`
    setContent(before + insertion + after)
    const newPos = start + insertion.length
    cursorPosRef.current = { start: newPos, end: newPos }
    contentRef.current?.focus()
  }

  // ── Insert section header at cursor line ───────────────────────────────
  const handleInsertSection = (section: string) => {
    const { start } = cursorPosRef.current
    const before = content.slice(0, start)
    const lineStart = before.lastIndexOf('\n') + 1
    const beforeLine = content.slice(0, lineStart)
    const afterCursor = content.slice(lineStart)

    const header = `[${section}]`
    const prefix =
      beforeLine.length > 0
        ? beforeLine.endsWith('\n\n')
          ? ''
          : beforeLine.endsWith('\n')
          ? '\n'
          : '\n\n'
        : ''
    const newContent = beforeLine + prefix + header + '\n' + afterCursor
    setContent(newContent)
    const newPos = beforeLine.length + prefix.length + header.length + 1
    cursorPosRef.current = { start: newPos, end: newPos }
    contentRef.current?.focus()
  }

  // ── Save (add or update) ───────────────────────────────────────────────
  const handleSave = async () => {
    if (!title.trim() || !originalKey.trim()) {
      Alert.alert('Error', 'Please fill in Title and Key')
      return
    }
    if (!isEditing && !chordListId && !artist.trim()) {
      Alert.alert('Error', 'Please enter an Artist name')
      return
    }
    if (!content.trim()) {
      Alert.alert('Error', 'Please add chords or lyrics')
      return
    }

    const cleanedYoutubeUrl = youtubeUrl.trim()
    setLoading(true)

    try {
      const now = Date.now()

      if (isEditing) {
        // ── UPDATE ────────────────────────────────────────────────────
        await execute(
          'UPDATE songs SET title = ?, content = ?, key = ?, youtube_url = ?, updated_at = ?, _synced = 0 WHERE id = ?',
          [title, content.trim(), originalKey, cleanedYoutubeUrl, now, songId]
        )
      } else {
        // ── INSERT ────────────────────────────────────────────────────
        const newSongId = uuid.v4() as string
        let finalChordListId = chordListId

        if (!chordListId) {
          const user = await getCurrentUser()
          if (!user) { Alert.alert('Error', 'User not found'); setLoading(false); return }

          const artistRows: any[] = await query(
            'SELECT id FROM artists WHERE name = ?',
            [artist.trim()]
          )
          let artistId: string
          if (artistRows && artistRows.length > 0) {
            artistId = artistRows[0].id
          } else {
            artistId = uuid.v4() as string
            await execute(
              'INSERT INTO artists (id, name, user_id, created_at, updated_at, _synced) VALUES (?, ?, ?, ?, ?, ?)',
              [artistId, artist.trim(), user.id, now, now, 0]
            )
          }

          finalChordListId = uuid.v4() as string
          await execute(
            'INSERT INTO chord_lists (id, title, artist_id, user_id, is_private, created_at, updated_at, _synced) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [finalChordListId, title, artistId, user.id, 0, now, now, 0]
          )
        }

        await execute(
          'INSERT INTO songs (id, chord_list_id, title, content, key, youtube_url, created_at, updated_at, _synced) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [newSongId, finalChordListId, title, content.trim(), originalKey, cleanedYoutubeUrl, now, now, 0]
        )
      }

      navigation.goBack()
    } catch (err) {
      console.error('Error saving song:', err)
      Alert.alert('Error', `Failed to ${isEditing ? 'update' : 'add'} song`)
    } finally {
      setLoading(false)
    }
  }

  const chordSet = useNashville ? NASHVILLE_CHORDS : COMMON_CHORDS

  // ── Loading skeleton while fetching song data ──────────────────────────
  if (initialLoading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={c.text} />
        <Text style={styles.loadingText}>Loading song…</Text>
      </View>
    )
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={styles.container}
    >
      <StatusBar barStyle="dark-content" backgroundColor={c.surface} />

      {/* ─── HEADER ─── */}
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backBtn}
          onPress={() => navigation.goBack()}
          activeOpacity={0.7}
        >
          <Ionicons name="arrow-back" size={16} color={c.text} />
        </TouchableOpacity>
        <View style={styles.headerMeta}>
          <Text style={styles.headerEyebrow}>
            {isEditing ? 'EDIT SONG' : 'NEW SONG'}
          </Text>
          <Text style={styles.headerTitle}>
            {isEditing ? (title || 'Edit Song') : 'Add Song'}
          </Text>
        </View>
        <TouchableOpacity
          style={[styles.saveHeaderBtn, loading && styles.saveHeaderBtnDisabled]}
          onPress={handleSave}
          disabled={loading}
          activeOpacity={0.8}
        >
          <Text style={[styles.saveHeaderBtnText, loading && styles.saveHeaderBtnTextDisabled]}>
            {loading ? 'Saving…' : isEditing ? 'Update' : 'Save'}
          </Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        refreshControl={isEditing ? <RefreshControl refreshing={refreshing} onRefresh={onRefresh} /> : undefined}
      >
        {/* ─── SONG INFO ─── */}
        <Text style={styles.sectionLabel}>SONG INFO</Text>
        <View style={styles.card}>
          {/* Title */}
          <View style={styles.fieldRow}>
            <Text style={styles.fieldLabel}>
              Title <Text style={styles.required}>*</Text>
            </Text>
            <TextInput
              style={styles.fieldInput}
              placeholder="Song title"
              placeholderTextColor={c.textMuted}
              value={title}
              onChangeText={setTitle}
              editable={!loading}
              returnKeyType="next"
              onSubmitEditing={() => artistRef.current?.focus()}
            />
          </View>

          <View style={styles.fieldDivider} />

          {/* Artist — always shown; required only on new-song without a chordListId */}
          <View style={styles.fieldRow}>
            <Text style={styles.fieldLabel}>
              Artist{!chordListId && !isEditing ? <Text style={styles.required}> *</Text> : null}
            </Text>
            <TextInput
              ref={artistRef}
              style={[styles.fieldInput, isEditing && styles.fieldInputReadonly]}
              placeholder={!chordListId && !isEditing ? 'Required' : 'Optional'}
              placeholderTextColor={c.textMuted}
              value={artist}
              onChangeText={setArtist}
              editable={!loading && !isEditing}   // artist comes from chord_list, read-only when editing
              returnKeyType="next"
            />
          </View>

          <View style={styles.fieldDivider} />

          {/* YouTube */}
          <View style={styles.fieldRow}>
            <Text style={styles.fieldLabel}>YouTube</Text>
            <TextInput
              style={styles.fieldInput}
              placeholder="https://youtube.com/watch?…"
              placeholderTextColor={c.textMuted}
              value={youtubeUrl}
              onChangeText={setYoutubeUrl}
              editable={!loading}
              returnKeyType="next"
              autoCapitalize="none"
              keyboardType="url"
            />
          </View>

          <View style={styles.fieldDivider} />

          {/* Key picker */}
          <TouchableOpacity
            style={styles.fieldRow}
            onPress={() => setShowKeyPicker(!showKeyPicker)}
            activeOpacity={0.7}
          >
            <Text style={styles.fieldLabel}>
              Key <Text style={styles.required}>*</Text>
            </Text>
            <View style={styles.keyPickerTrigger}>
              <Text style={styles.keyPickerValue}>{originalKey}</Text>
              <Ionicons
                name={showKeyPicker ? 'chevron-up' : 'chevron-down'}
                size={14}
                color={c.textMuted}
              />
            </View>
          </TouchableOpacity>

          {showKeyPicker && (
            <View style={styles.keyGrid}>
              {ALL_KEYS.map((key) => (
                <TouchableOpacity
                  key={key}
                  style={[styles.keyCell, originalKey === key && styles.keyCellActive]}
                  onPress={() => { setOriginalKey(key); setShowKeyPicker(false) }}
                  activeOpacity={0.7}
                >
                  <Text
                    style={[
                      styles.keyCellText,
                      originalKey === key && styles.keyCellTextActive,
                    ]}
                  >
                    {key}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          )}
        </View>

        {/* ─── CHORDS & LYRICS ─── */}
        <Text style={[styles.sectionLabel, { marginTop: 24 }]}>CHORDS & LYRICS</Text>

        {/* Chord system toggle */}
        <View style={styles.segmentedControl}>
          <TouchableOpacity
            style={[styles.segment, !useNashville && styles.segmentActive]}
            onPress={() => setUseNashville(false)}
            activeOpacity={0.75}
          >
            <Text style={[styles.segmentText, !useNashville && styles.segmentTextActive]}>
              Standard
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.segment, useNashville && styles.segmentActive]}
            onPress={() => setUseNashville(true)}
            activeOpacity={0.75}
          >
            <Text style={[styles.segmentText, useNashville && styles.segmentTextActive]}>
              Nashville
            </Text>
          </TouchableOpacity>
        </View>

        {/* ─── EDITOR CARD ─── */}
        <View style={styles.editorCard}>

          {/* Chord chips */}
          <View style={styles.editorToolbar}>
            <Text style={styles.editorToolbarLabel}>CHORDS</Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.chipRow}
            >
              {chordSet.map((chord) => (
                <TouchableOpacity
                  key={chord}
                  style={styles.chordChip}
                  onPress={() => handleInsertChord(chord)}
                  activeOpacity={0.7}
                >
                  <Text style={styles.chordChipText}>{chord}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>

          <View style={styles.editorDivider} />

          {/* Section chips */}
          <View style={styles.editorToolbar}>
            <Text style={styles.editorToolbarLabel}>SECTIONS</Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.chipRow}
            >
              {SONG_SECTIONS.map((section) => (
                <TouchableOpacity
                  key={section}
                  style={[styles.chordChip, styles.sectionChip]}
                  onPress={() => handleInsertSection(section)}
                  activeOpacity={0.7}
                >
                  <Text style={[styles.chordChipText, styles.sectionChipText]}>
                    {section}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>

          <View style={styles.editorDivider} />

          {/* Format hint */}
          <View style={styles.formatHintRow}>
            <Ionicons name="information-circle-outline" size={12} color={c.iconInactive} />
            <Text style={styles.formatHintText}>
              Chords: [G]Amazing [D]grace · Sections: [Verse 1]
            </Text>
          </View>

          {/* Main text area */}
          <TextInput
            ref={contentRef}
            style={styles.editorInput}
            placeholder={
              '[Verse 1]\n[G]Amazing [D]grace, how [Em]sweet the [C]sound…\n\n[Chorus]\n[G]That saved a [D]wretch like [C]me…'
            }
            placeholderTextColor={c.textMuted}
            value={content}
            onChangeText={setContent}
            onSelectionChange={(e) => {
              cursorPosRef.current = e.nativeEvent.selection
            }}
            multiline
            editable={!loading}
            textAlignVertical="top"
            autoCorrect={false}
            autoCapitalize="none"
          />
        </View>

        {/* ─── SUBMIT BUTTON ─── */}
        <TouchableOpacity
          style={[styles.submitBtn, loading && styles.submitBtnDisabled]}
          onPress={handleSave}
          disabled={loading}
          activeOpacity={0.82}
        >
          {loading ? (
            <Text style={styles.submitBtnText}>Saving…</Text>
          ) : (
            <>
              <Ionicons
                name={isEditing ? 'checkmark' : 'add'}
                size={18}
                color={c.accentText}
                style={{ marginRight: 8 }}
              />
              <Text style={styles.submitBtnText}>
                {isEditing ? 'Update Song' : 'Add Song'}
              </Text>
            </>
          )}
        </TouchableOpacity>

        <View style={{ height: 50 }} />
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

const makeStyles = (c: AppColors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.surfaceAlt },

  loadingContainer: {
    flex: 1,
    backgroundColor: c.surfaceAlt,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 14,
  },
  loadingText: {
    fontSize: 12,
    letterSpacing: 1.4,
    color: c.textMuted,
    textTransform: 'uppercase',
    fontWeight: '600',
  },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: c.surface,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: c.hairline,
    gap: 12,
  },
  backBtn: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: c.surfaceAlt,
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerMeta: { flex: 1, gap: 2 },
  headerEyebrow: { fontSize: 9, fontWeight: '700', color: c.iconInactive, letterSpacing: 2 },
  headerTitle: { fontSize: 16, fontWeight: '800', color: c.text, letterSpacing: -0.4 },
  saveHeaderBtn: {
    backgroundColor: c.accent,
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 8,
    minWidth: 66,
    alignItems: 'center',
  },
  saveHeaderBtnDisabled: { backgroundColor: c.border },
  saveHeaderBtnText: { fontSize: 13, fontWeight: '700', color: c.accentText },
  saveHeaderBtnTextDisabled: { color: c.accentText },

  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 16, paddingTop: 20 },

  sectionLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: c.iconInactive,
    letterSpacing: 1.8,
    marginBottom: 10,
  },
  required: { color: c.textMuted },

  // Info card
  card: {
    backgroundColor: c.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: c.hairline,
    overflow: 'hidden',
    paddingHorizontal: 14,
  },
  fieldRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    gap: 12,
  },
  fieldDivider: { height: 1, backgroundColor: c.surfaceAlt },
  fieldLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: c.text,
    width: 56,
    flexShrink: 0,
  },
  fieldInput: {
    flex: 1,
    fontSize: 14,
    color: c.text,
    fontWeight: '500',
    padding: 0,
    textAlign: 'right',
  },
  fieldInputReadonly: { color: c.textMuted },

  keyPickerTrigger: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 6,
  },
  keyPickerValue: { fontSize: 14, fontWeight: '700', color: c.text },
  keyGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingVertical: 14,
    gap: 8,
    borderTopWidth: 1,
    borderTopColor: c.hairline,
  },
  keyCell: {
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 10,
    backgroundColor: c.surfaceAlt,
    borderWidth: 1,
    borderColor: c.hairline,
    minWidth: 44,
    alignItems: 'center',
  },
  keyCellActive: { backgroundColor: c.accent, borderColor: c.accent },
  keyCellText: { fontSize: 13, fontWeight: '700', color: c.textSub },
  keyCellTextActive: { color: c.accentText },

  // Segmented control
  segmentedControl: {
    flexDirection: 'row',
    backgroundColor: c.surfaceAlt,
    borderRadius: 12,
    padding: 3,
    marginBottom: 14,
    gap: 2,
  },
  segment: {
    flex: 1,
    paddingVertical: 9,
    alignItems: 'center',
    borderRadius: 9,
  },
  segmentActive: {
    backgroundColor: c.surface,
    shadowColor: c.shadow,
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.07,
    shadowRadius: 3,
    elevation: 2,
  },
  segmentText: { fontSize: 13, fontWeight: '600', color: c.textMuted },
  segmentTextActive: { color: c.text },

  // Editor card
  editorCard: {
    backgroundColor: c.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: c.hairline,
    overflow: 'hidden',
  },
  editorToolbar: {
    paddingTop: 12,
    paddingBottom: 10,
    paddingHorizontal: 14,
    gap: 8,
  },
  editorToolbarLabel: {
    fontSize: 9,
    fontWeight: '700',
    color: c.iconInactive,
    letterSpacing: 1.8,
  },
  editorDivider: { height: 1, backgroundColor: c.surfaceAlt },
  chipRow: { flexDirection: 'row', gap: 7, paddingRight: 14 },
  chordChip: {
    paddingHorizontal: 13,
    paddingVertical: 8,
    borderRadius: 9,
    backgroundColor: c.surfaceAlt,
    borderWidth: 1,
    borderColor: c.hairline,
  },
  chordChipText: { fontSize: 13, fontWeight: '700', color: c.text, letterSpacing: 0.1 },
  sectionChip: { backgroundColor: c.warningBg, borderColor: c.warning },
  sectionChipText: { color: c.warning },

  formatHintRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: c.surfaceAlt,
  },
  formatHintText: {
    fontSize: 11,
    color: c.iconInactive,
    fontWeight: '500',
    fontFamily: 'Courier New',
    flex: 1,
  },

  editorInput: {
    fontSize: 14,
    color: c.text,
    lineHeight: 24,
    minHeight: 220,
    paddingHorizontal: 14,
    paddingTop: 14,
    paddingBottom: 18,
    fontFamily: 'Courier New',
    textAlignVertical: 'top',
    borderTopWidth: 1,
    borderTopColor: c.hairline,
  },

  // Submit
  submitBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 28,
    paddingVertical: 16,
    borderRadius: 16,
    backgroundColor: c.accent,
  },
  submitBtnDisabled: { backgroundColor: c.border },
  submitBtnText: { fontSize: 15, fontWeight: '800', color: c.accentText, letterSpacing: -0.2 },
})