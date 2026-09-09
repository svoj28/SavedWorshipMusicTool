// screens/AddSongScreen.tsx
import React, { useState, useEffect, useRef , useMemo} from 'react'
import * as Clipboard from 'expo-clipboard'
import { parseSongText } from '../lib/songImport'
import { importSongFromUrl, sourceForUrl } from '../lib/chordSources'
import SongImportModal from '../components/SongImportModal'
import {
  ActivityIndicator,
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
} from 'react-native'
import { useAppTheme, type AppColors } from '../lib/theme'
import { execute, query } from '../db/index'
import { getCurrentUser } from '../lib/auth'
import uuid from 'react-native-uuid'
import Ionicons from '@expo/vector-icons/Ionicons'
import { createSong } from '../db/queries'

interface Props {
  route: any
  navigation: any
}

const NASHVILLE_CHORDS = ['I', 'ii', 'iii', 'IV', 'V', 'vi', 'viiD', 'bI', 'bii', 'biii', 'bIV', 'bV', 'bvi', 'bviiD']
const COMMON_CHORDS    = ['C', 'G', 'D', 'A', 'E', 'B', 'F', 'Bb', 'Dm', 'Am', 'Em', 'Gm', 'Cm', 'FM', 'C7', 'G7']
const ALL_KEYS         = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B',
                          'Db', 'Eb', 'Gb', 'Ab', 'Bb',
                          'Cm', 'Dm', 'Em', 'Fm', 'Gm', 'Am', 'Bm']
const SONG_SECTIONS = [
  'Intro',
  'Verse 1', 'Verse 2', 'Verse 3',
  'Pre-Chorus',
  'Chorus', 'Chorus 2', 'Chorus 3',
  'Bridge',
  'Instrumental',
  'Outro',
  'Interlude',
  'Tag',
]

/** Name the site a song came from, so the note below says where it is from. */
function importedFrom(url: string): string {
  return sourceForUrl(url)?.name || 'the web'
}

export default function AddSongScreen({ route, navigation }: Props) {
  const { colors: c } = useAppTheme()
  const styles = useMemo(() => makeStyles(c), [c])

  const { chordListId } = route.params || {}
  const [title, setTitle]               = useState('')
  const [artist, setArtist]             = useState('')
  const [originalKey, setOriginalKey]   = useState('C')
  const [content, setContent]           = useState('') // unified editor
  const [youtubeUrl, setYoutubeUrl]     = useState('')
  const [loading, setLoading]           = useState(false)
  const [useNashville, setUseNashville] = useState(false)
  const [showKeyPicker, setShowKeyPicker] = useState(false)
  const [importUrl, setImportUrl]         = useState('')
  const [importing, setImporting]         = useState(false)
  const [importNote, setImportNote]       = useState('')
  const [showImport, setShowImport]       = useState(false)
  const [showSearch, setShowSearch]       = useState(false)

  const artistRef  = useRef<TextInput>(null)
  const contentRef = useRef<TextInput>(null)
  // Track cursor position for chord/section insertion
  const cursorPosRef = useRef<{ start: number; end: number }>({ start: 0, end: 0 })

  /**
   * Bring a song in from the web.
   *
   * Whatever comes back lands in the fields below as ordinary editable text -
   * the import is a starting point, not a locked-in document, so anything the
   * parser gets wrong can be fixed by hand before saving.
   */
  const applyImported = (
    song: { title: string; artist: string; key: string; content: string },
    from: string,
  ) => {
    if (song.title && !title.trim()) setTitle(song.title)
    if (song.artist && !artist.trim()) setArtist(song.artist)
    if (song.key) setOriginalKey(song.key)
    setContent(prev => (prev.trim() ? prev.replace(/\s+$/, '') + '\n\n' + song.content : song.content))
    const chordCount = (song.content.match(/\[[^\]]+\]/g) || []).length
    setImportNote(
      chordCount > 0
        ? 'Brought in from ' + from + ' - ' + chordCount + ' chords found. Edit anything below before saving.'
        : 'Brought in from ' + from + ', but no chords were recognised. Check the text below.',
    )
  }

  const handleImportFromWeb = async () => {
    if (!importUrl.trim()) { Alert.alert('Enter a link', 'Paste the web address of the chord sheet.'); return }
    setImporting(true)
    setImportNote('')
    try {
      const song = await importSongFromUrl(importUrl)
      applyImported(song, importedFrom(song.source))
      setImportUrl('')
    } catch (err: any) {
      Alert.alert('Import failed', err?.message || 'Could not read that page')
    } finally {
      setImporting(false)
    }
  }

  const handleImportFromClipboard = async () => {
    try {
      const text = await Clipboard.getStringAsync()
      if (!text || !text.trim()) { Alert.alert('Clipboard empty', 'Copy a chord sheet first.'); return }
      applyImported(parseSongText(text), 'your clipboard')
    } catch {
      Alert.alert('Error', 'Could not read the clipboard')
    }
  }

  // Insert a chord at cursor position in the unified editor
  const handleInsertChord = (chord: string) => {
    const { start, end } = cursorPosRef.current
    const before = content.slice(0, start)
    const after = content.slice(end)
    const insertion = `[${chord}]`
    const newContent = before + insertion + after
    setContent(newContent)
    // Move cursor after the inserted chord
    const newPos = start + insertion.length
    cursorPosRef.current = { start: newPos, end: newPos }
    contentRef.current?.focus()
  }

  // Insert a section header at cursor position
  const handleInsertSection = (section: string) => {
  const { start } = cursorPosRef.current
  const before = content.slice(0, start)
  const after = content.slice(start)

  const header = section
  // Add blank line before header if there's content before it
  const prefix = before.length > 0 && !before.endsWith('\n\n')
    ? before.endsWith('\n') ? '\n' : '\n\n'
    : ''

  const newContent = before + prefix + header + '\n' + after
  setContent(newContent)

  const newPos = before.length + prefix.length + header.length + 1
  cursorPosRef.current = { start: newPos, end: newPos }
  contentRef.current?.focus()
}

  const handleAddSong = async () => {
  if (!title.trim() || !originalKey.trim()) {
    Alert.alert('Error', 'Please fill in Title and Key')
    return
  }
  if (!chordListId && !artist.trim()) {
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
    let finalChordListId = chordListId

    const user = await getCurrentUser()
    if (!user) { Alert.alert('Error', 'User not found'); setLoading(false); return }

    if (!chordListId) {
      const artistRows: any[] = await query('SELECT id FROM artists WHERE name = ?', [artist.trim()])
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

    const songPayload = {
      chordListId: finalChordListId,
      title,
      content: content.trim(),
      key: originalKey,
      youtubeUrl: cleanedYoutubeUrl,
      userId: user.id,
      createdAt: now,
      updatedAt: now,
      synced: false,
    }

    console.log('[AddSongScreen] creating song with payload:', { ...songPayload })
    await createSong(songPayload)
    console.log('[AddSongScreen] createSong returned, navigating back')
    navigation.goBack()
  } catch (err) {
    console.error('Error adding song:', err)
    Alert.alert('Error', 'Failed to add song')
  } finally {
    setLoading(false)
  }
}

  const chordSet = useNashville ? NASHVILLE_CHORDS : COMMON_CHORDS

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor={c.surface} />

      {/* ─── HEADER ─── */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => navigation.goBack()} activeOpacity={0.7}>
          <Ionicons name="arrow-back" size={16} color={c.text} />
        </TouchableOpacity>
        <View style={styles.headerMeta}>
          <Text style={styles.headerEyebrow}>NEW SONG</Text>
          <Text style={styles.headerTitle}>Add Song</Text>
        </View>
        <TouchableOpacity
          style={[styles.saveHeaderBtn, loading && styles.saveHeaderBtnDisabled]}
          onPress={handleAddSong}
          disabled={loading}
          activeOpacity={0.8}
        >
          <Text style={[styles.saveHeaderBtnText, loading && styles.saveHeaderBtnTextDisabled]}>
            {loading ? 'Saving…' : 'Save'}
          </Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* ─── IMPORT ─── */}
        <TouchableOpacity
          style={styles.importHeader}
          onPress={() => setShowImport(v => !v)}
          activeOpacity={0.75}
        >
          <Ionicons name="cloud-download-outline" size={16} color={c.text} />
          <Text style={styles.importHeaderText}>Get a song from the internet</Text>
          <Ionicons
            name={showImport ? 'chevron-up' : 'chevron-down'}
            size={16}
            color={c.textMuted}
          />
        </TouchableOpacity>

        {showImport && (
          <View style={styles.card}>
            <Text style={styles.importHint}>
              Search several chord sites and pick the version you want, paste a link to one
              you already have, or paste the chords you copied. Everything lands in the editor
              below, yours to change before saving.
            </Text>

            <TouchableOpacity
              style={styles.importSearchBtn}
              onPress={() => setShowSearch(true)}
              activeOpacity={0.85}
            >
              <Ionicons name="search" size={15} color={c.accentText} />
              <Text style={styles.importSearchText}>Search chord sites</Text>
            </TouchableOpacity>

            <Text style={styles.importOr}>or open a link you already have</Text>

            <View style={styles.importRow}>
              <TextInput
                style={styles.importInput}
                placeholder="https://…"
                placeholderTextColor={c.textMuted}
                value={importUrl}
                onChangeText={setImportUrl}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                editable={!importing}
                onSubmitEditing={handleImportFromWeb}
              />
              <TouchableOpacity
                style={[styles.importBtn, importing && styles.importBtnBusy]}
                onPress={handleImportFromWeb}
                disabled={importing}
                activeOpacity={0.85}
              >
                {importing
                  ? <ActivityIndicator size="small" color={c.accentText} />
                  : <Ionicons name="arrow-down" size={17} color={c.accentText} />}
              </TouchableOpacity>
            </View>

            <TouchableOpacity
              style={styles.importPasteBtn}
              onPress={handleImportFromClipboard}
              activeOpacity={0.8}
            >
              <Ionicons name="clipboard-outline" size={14} color={c.text} />
              <Text style={styles.importPasteText}>Paste chords from clipboard</Text>
            </TouchableOpacity>

            {importNote ? <Text style={styles.importNote}>{importNote}</Text> : null}

            <Text style={styles.importFootnote}>
              Chord sheets written with the chords above the words are converted to this
              app's format automatically. Pages that build their sheet in the browser
              can't be read - copy the chords and use Paste instead.
            </Text>
          </View>
        )}

        {/* Search several sites, choose a version, edit it before it lands here */}
        <SongImportModal
          visible={showSearch}
          onClose={() => setShowSearch(false)}
          initialQuery={title}
          onUse={song => applyImported(song, importedFrom(song.source))}
        />

        {/* ─── SONG INFO ─── */}
        <Text style={styles.sectionLabel}>SONG INFO</Text>
        <View style={styles.card}>
          <View style={styles.fieldRow}>
            <Text style={styles.fieldLabel}>Title <Text style={styles.required}>*</Text></Text>
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

          <View style={styles.fieldRow}>
            <Text style={styles.fieldLabel}>
              Artist {!chordListId && <Text style={styles.required}>*</Text>}
            </Text>
            <TextInput
              ref={artistRef}
              style={styles.fieldInput}
              placeholder={!chordListId ? 'Required' : 'Optional'}
              placeholderTextColor={c.textMuted}
              value={artist}
              onChangeText={setArtist}
              editable={!loading}
              returnKeyType="next"
            />
          </View>

          <View style={styles.fieldDivider} />

          <View style={styles.fieldRow}>
            <Text style={styles.fieldLabel}>YouTube</Text>
            <TextInput
              style={styles.fieldInput}
              placeholder="https://youtube.com/watch?..."
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

          <TouchableOpacity style={styles.fieldRow} onPress={() => setShowKeyPicker(!showKeyPicker)} activeOpacity={0.7}>
            <Text style={styles.fieldLabel}>Key <Text style={styles.required}>*</Text></Text>
            <View style={styles.keyPickerTrigger}>
              <Text style={styles.keyPickerValue}>{originalKey}</Text>
              <Ionicons name={showKeyPicker ? 'chevron-up' : 'chevron-down'} size={14} color={c.textMuted} />
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
                  <Text style={[styles.keyCellText, originalKey === key && styles.keyCellTextActive]}>{key}</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}
        </View>

        {/* ─── SONG CONTENT (UNIFIED EDITOR) ─── */}
        <Text style={[styles.sectionLabel, { marginTop: 24 }]}>CHORDS & LYRICS</Text>

        {/* Chord system toggle */}
        <View style={styles.segmentedControl}>
          <TouchableOpacity style={[styles.segment, !useNashville && styles.segmentActive]} onPress={() => setUseNashville(false)} activeOpacity={0.75}>
            <Text style={[styles.segmentText, !useNashville && styles.segmentTextActive]}>Standard</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.segment, useNashville && styles.segmentActive]} onPress={() => setUseNashville(true)} activeOpacity={0.75}>
            <Text style={[styles.segmentText, useNashville && styles.segmentTextActive]}>Nashville</Text>
          </TouchableOpacity>
        </View>

        {/* ─── UNIFIED EDITOR CARD ─── */}
        <View style={styles.editorCard}>

          {/* Chord shortcut chips */}
          <View style={styles.editorToolbar}>
            <Text style={styles.editorToolbarLabel}>CHORDS</Text>
            <ScrollView horizontal keyboardShouldPersistTaps="always" showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chordChips}>
              {chordSet.map((chord) => (
                <TouchableOpacity key={chord} style={styles.chordChip} onPress={() => handleInsertChord(chord)} activeOpacity={0.7}>
                  <Text style={styles.chordChipText}>{chord}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>

          <View style={styles.editorDivider} />

          {/* Section header chips */}
          <View style={styles.editorToolbar}>
            <Text style={styles.editorToolbarLabel}>SECTIONS</Text>
            <ScrollView horizontal keyboardShouldPersistTaps="always" showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chordChips}>
              {SONG_SECTIONS.map((section) => (
                <TouchableOpacity key={section} style={[styles.chordChip, styles.sectionChip]} onPress={() => handleInsertSection(section)} activeOpacity={0.7}>
                  <Text style={[styles.chordChipText, styles.sectionChipText]}>{section}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>

          <View style={styles.editorDivider} />

          {/* Format hint */}
          <View style={styles.formatHintRow}>
            <Ionicons name="information-circle-outline" size={12} color={c.iconInactive} />
            <Text style={styles.formatHintText}>Chords: [G]Amazing [D]grace · Sections: Verse 1</Text>
          </View>

          {/* The main text input */}
          <TextInput
            ref={contentRef}
            style={styles.editorInput}
            placeholder={'Verse 1\n[G]Amazing [D]grace, how [Em]sweet the [C]sound…\n\nChorus\n[G]That saved a [D]wretch like [C]me…'}
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

        {/* ─── SUBMIT ─── */}
        <TouchableOpacity
          style={[styles.submitBtn, loading && styles.submitBtnDisabled]}
          onPress={handleAddSong}
          disabled={loading}
          activeOpacity={0.82}
        >
          {loading
            ? <Text style={styles.submitBtnText}>Saving…</Text>
            : <>
                <Ionicons name="add" size={18} color={c.accentText} style={{ marginRight: 8 }} />
                <Text style={styles.submitBtnText}>Add Song</Text>
              </>
          }
        </TouchableOpacity>

        <View style={{ height: 50 }} />
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

const makeStyles = (c: AppColors) => StyleSheet.create({
  importHeader: {
    flexDirection: 'row', alignItems: 'center', gap: 9,
    paddingVertical: 12, paddingHorizontal: 14, marginBottom: 10,
    backgroundColor: c.surface, borderRadius: 10,
    borderWidth: 1.5, borderColor: c.border,
  },
  importHeaderText: { flex: 1, fontSize: 13.5, fontWeight: '800', color: c.text },
  importHint: { fontSize: 12, color: c.textMuted, fontWeight: '500', lineHeight: 17, marginBottom: 12 },
  importSearchBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 12, borderRadius: 10, backgroundColor: c.accent,
  },
  importSearchText: { fontSize: 13.5, fontWeight: '800', color: c.accentText },
  importOr: {
    fontSize: 11, fontWeight: '600', color: c.iconInactive,
    textAlign: 'center', marginTop: 12, marginBottom: 8,
  },
  importRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  importInput: {
    flex: 1, height: 42, borderRadius: 8, borderWidth: 1.5, borderColor: c.border,
    paddingHorizontal: 12, fontSize: 14, color: c.text, backgroundColor: c.surfaceAlt,
  },
  importBtn: {
    width: 44, height: 42, borderRadius: 8, backgroundColor: c.accent,
    alignItems: 'center', justifyContent: 'center',
  },
  importBtnBusy: { opacity: 0.7 },
  importPasteBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7,
    marginTop: 10, paddingVertical: 10, borderRadius: 8,
    borderWidth: 1.5, borderColor: c.border, backgroundColor: c.surfaceAlt,
  },
  importPasteText: { fontSize: 13, fontWeight: '700', color: c.text },
  importNote: {
    fontSize: 12, fontWeight: '600', color: c.success, backgroundColor: c.successBg,
    borderRadius: 8, padding: 10, marginTop: 10, lineHeight: 17,
  },
  importFootnote: { fontSize: 11, color: c.textMuted, fontWeight: '500', lineHeight: 16, marginTop: 10 },
  container: { flex: 1, backgroundColor: c.surfaceAlt },

  header: { flexDirection: 'row', alignItems: 'center', backgroundColor: c.surface, paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: c.hairline, gap: 12 },
  backBtn: { width: 34, height: 34, borderRadius: 10, backgroundColor: c.surfaceAlt, justifyContent: 'center', alignItems: 'center' },
  headerMeta: { flex: 1, gap: 2 },
  headerEyebrow: { fontSize: 9, fontWeight: '700', color: c.iconInactive, letterSpacing: 2 },
  headerTitle: { fontSize: 16, fontWeight: '800', color: c.text, letterSpacing: -0.4 },
  saveHeaderBtn: { backgroundColor: c.accent, borderRadius: 10, paddingHorizontal: 16, paddingVertical: 8, minWidth: 58, alignItems: 'center' },
  saveHeaderBtnDisabled: { backgroundColor: c.border },
  saveHeaderBtnText: { fontSize: 13, fontWeight: '700', color: c.accentText },
  saveHeaderBtnTextDisabled: { color: c.accentText },

  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 16, paddingTop: 20 },

  sectionLabel: { fontSize: 10, fontWeight: '700', color: c.iconInactive, letterSpacing: 1.8, marginBottom: 10 },
  required: { color: c.textMuted },

  card: { backgroundColor: c.surface, borderRadius: 16, borderWidth: 1, borderColor: c.hairline, overflow: 'hidden', paddingHorizontal: 14 },
  fieldRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, gap: 12 },
  fieldDivider: { height: 1, backgroundColor: c.surfaceAlt },
  fieldLabel: { fontSize: 13, fontWeight: '600', color: c.text, width: 56, flexShrink: 0 },
  fieldInput: { flex: 1, fontSize: 14, color: c.text, fontWeight: '500', padding: 0, textAlign: 'right' },

  keyPickerTrigger: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 6 },
  keyPickerValue: { fontSize: 14, fontWeight: '700', color: c.text },
  keyGrid: { flexDirection: 'row', flexWrap: 'wrap', paddingVertical: 14, gap: 8, borderTopWidth: 1, borderTopColor: c.hairline },
  keyCell: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: 10, backgroundColor: c.surfaceAlt, borderWidth: 1, borderColor: c.hairline, minWidth: 44, alignItems: 'center' },
  keyCellActive: { backgroundColor: c.accent, borderColor: c.accent },
  keyCellText: { fontSize: 13, fontWeight: '700', color: c.textSub },
  keyCellTextActive: { color: c.accentText },

  segmentedControl: { flexDirection: 'row', backgroundColor: c.surfaceAlt, borderRadius: 12, padding: 3, marginBottom: 14, gap: 2 },
  segment: { flex: 1, paddingVertical: 9, alignItems: 'center', borderRadius: 9 },
  segmentActive: { backgroundColor: c.surface, shadowColor: c.shadow, shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.07, shadowRadius: 3, elevation: 2 },
  segmentText: { fontSize: 13, fontWeight: '600', color: c.textMuted },
  segmentTextActive: { color: c.text },

  // Unified editor card
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

  chordChips: { flexDirection: 'row', gap: 7, paddingRight: 14 },
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

  submitBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginTop: 28, paddingVertical: 16, borderRadius: 16, backgroundColor: c.accent },
  submitBtnDisabled: { backgroundColor: c.border },
  submitBtnText: { fontSize: 15, fontWeight: '800', color: c.accentText, letterSpacing: -0.2 },
})