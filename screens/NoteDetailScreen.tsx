// screens/NoteDetailScreen.tsx
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import {
  View,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  Text,
  Alert,
  Platform,
  StatusBar,
  ScrollView,
} from 'react-native'
import { useAppTheme, type AppColors } from '../lib/theme'
import { execute, queryOne } from '../db/index'
import Ionicons from '@expo/vector-icons/Ionicons'
import { onTableChange } from '../lib/sync'

interface Props {
  route: any
  navigation: any
}

// ─── Music Theory (ported 1-to-1 from ManualTransposeScreen) ─────────────────

const SHARP_NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

const FLAT_TO_SHARP: Record<string, string> = {
  Cb: 'B', Db: 'C#', Eb: 'D#', Fb: 'E', Gb: 'F#', Ab: 'G#', Bb: 'A#',
}

const FLAT_KEY_ROOTS = new Set(['F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb'])

const SHARP_TO_FLAT: Record<string, string> = {
  'C#': 'Db', 'D#': 'Eb', 'F#': 'Gb', 'G#': 'Ab', 'A#': 'Bb',
}

const ROMAN_TO_SEMITONE: Record<string, number> = {
  'I': 0, 'bII': 1, 'II': 2, 'bIII': 3, 'III': 4,
  'IV': 5, 'bV': 6, '#IV': 6, 'V': 7, 'bVI': 8, 'VI': 9, 'bVII': 10, 'VII': 11,
}

const SEMITONE_TO_ROMAN: Record<number, string> = {
  0: 'I', 1: 'bII', 2: 'II', 3: 'bIII', 4: 'III',
  5: 'IV', 6: 'bV', 7: 'V', 8: 'bVI', 9: 'VI', 10: 'bVII', 11: 'VII',
}

const ALL_ROMANS = Object.keys(ROMAN_TO_SEMITONE).sort((a, b) => b.length - a.length)
const ROMAN_PATTERN = ALL_ROMANS.map(r => r.replace('#', '\\#')).join('|')

function parseRoot(str: string): { root: string; remainder: string } | null {
  const match = str.match(/^([A-G][#b]?)(.*)$/)
  if (!match) return null
  return { root: match[1], remainder: match[2] }
}

function normaliseRoot(root: string): string {
  return FLAT_TO_SHARP[root] ?? root
}

function spellNote(canonicalNote: string, targetKeyRoot: string): string {
  if (FLAT_KEY_ROOTS.has(targetKeyRoot)) {
    return SHARP_TO_FLAT[canonicalNote] ?? canonicalNote
  }
  return canonicalNote
}

function transposeChord(chord: string, semitones: number, targetKeyRoot: string): string {
  if (!chord.trim()) return chord

  const slashIdx = chord.indexOf('/')
  if (slashIdx !== -1) {
    const left  = chord.slice(0, slashIdx)
    const right = chord.slice(slashIdx + 1)
    return transposeChord(left, semitones, targetKeyRoot) + '/' + transposeChord(right, semitones, targetKeyRoot)
  }

  const parsed = parseRoot(chord)
  if (!parsed) return chord

  const { root, remainder } = parsed
  const canonical = normaliseRoot(root)
  const idx = SHARP_NOTES.indexOf(canonical)
  if (idx === -1) return chord

  const newIdx = ((idx + semitones) % 12 + 12) % 12
  const newCanonical = SHARP_NOTES[newIdx]
  const newRoot = spellNote(newCanonical, targetKeyRoot)

  return newRoot + remainder
}

function parseNashville(str: string): { numeral: string; modifiers: string; lowerCase: boolean } | null {
  const re = new RegExp(`^(${ROMAN_PATTERN})(.*)$`, 'i')
  const match = str.match(re)
  if (!match) return null
  const rawNumeral = match[1]
  let modifiers = match[2] ?? ''
  const lowerCase = /[a-z]/.test(rawNumeral)

  const upperNum = rawNumeral.toUpperCase()
  const finalNumeral = rawNumeral.startsWith('b') || rawNumeral.startsWith('B')
    ? 'b' + upperNum.slice(1)
    : rawNumeral.startsWith('#')
    ? '#' + upperNum.slice(1)
    : upperNum

  if (!(finalNumeral in ROMAN_TO_SEMITONE)) return null

  if (lowerCase && !/\bm(?![a-zA-Z])/.test(modifiers) && !/maj|dim|aug/.test(modifiers)) {
    modifiers = 'm' + modifiers
  }

  return { numeral: finalNumeral, modifiers, lowerCase }
}

function nashvilleToChord(token: string, targetKeyRoot: string): string {
  const parsed = parseNashville(token)
  if (!parsed) return token
  const semitone = ROMAN_TO_SEMITONE[parsed.numeral]
  if (semitone === undefined) return token

  const targetCanonical = normaliseRoot(targetKeyRoot)
  const idx = SHARP_NOTES.indexOf(targetCanonical)
  if (idx === -1) return token
  const newIdx = (idx + semitone) % 12
  const newCanonical = SHARP_NOTES[newIdx]
  const newRoot = spellNote(newCanonical, targetKeyRoot)

  return newRoot + parsed.modifiers
}

function transposeBracketContent(content: string, semitones: number, targetKeyRoot: string): string {
  const trimmed = content.trim()
  if (parseNashville(trimmed)) {
    return nashvilleToChord(trimmed, targetKeyRoot)
  }
  return transposeChord(trimmed, semitones, targetKeyRoot)
}

const BARE_CHORD_RE = /(?<![A-Za-z])([A-G][#b]?)((?:maj|min|m(?!aj)|sus|aug|dim|add|dom|M)?(?:\d+)?(?:\/[A-G][#b]?)?)/g

function transposeBareChords(text: string, semitones: number, targetKeyRoot: string): string {
  return text.replace(BARE_CHORD_RE, (match, root, suffix) => {
    const canonical = normaliseRoot(root)
    if (!SHARP_NOTES.includes(canonical)) return match

    const slashMatch = suffix.match(/^(.*?)\/([A-G][#b]?)(.*)$/)
    if (slashMatch) {
      const idx = SHARP_NOTES.indexOf(canonical)
      const newRoot = spellNote(SHARP_NOTES[((idx + semitones) % 12 + 12) % 12], targetKeyRoot)
      const bassCanon = normaliseRoot(slashMatch[2])
      const bassIdx   = SHARP_NOTES.indexOf(bassCanon)
      const newBass   = bassIdx !== -1
        ? spellNote(SHARP_NOTES[((bassIdx + semitones) % 12 + 12) % 12], targetKeyRoot)
        : slashMatch[2]
      return newRoot + slashMatch[1] + '/' + newBass + slashMatch[3]
    }

    return transposeChord(canonical + suffix, semitones, targetKeyRoot)
  })
}

function transposeText(text: string, semitones: number, targetKeyRoot: string): string {
  if (semitones === 0) return text

  const SLOT = '\x02'
  const store: string[] = []
  const slotted = text.replace(/\[([^\]]+)\]/g, (_, inner) => {
    store.push('[' + transposeBracketContent(inner, semitones, targetKeyRoot) + ']')
    return SLOT + (store.length - 1) + SLOT
  })

  const transposedBare = transposeBareChords(slotted, semitones, targetKeyRoot)

  return transposedBare.replace(new RegExp(SLOT + '(\\d+)' + SLOT, 'g'), (_, i) => store[+i])
}

// ─── Key detection ────────────────────────────────────────────────────────────

function detectKey(text: string): string | null {
  const counts: Record<string, number> = {}

  const bracketRe = /\[([A-G][#b]?)/g
  let m: RegExpExecArray | null
  while ((m = bracketRe.exec(text)) !== null) {
    const norm = normaliseRoot(m[1])
    if (SHARP_NOTES.includes(norm)) counts[norm] = (counts[norm] ?? 0) + 1
  }

  const bareRe = new RegExp(BARE_CHORD_RE.source, 'g')
  while ((m = bareRe.exec(text)) !== null) {
    const norm = normaliseRoot(m[1])
    if (SHARP_NOTES.includes(norm)) counts[norm] = (counts[norm] ?? 0) + 1
  }

  const entries = Object.entries(counts)
  if (!entries.length) return null
  return entries.sort((a, b) => b[1] - a[1])[0][0]
}

function semitonesBetween(fromKey: string, toKey: string): number {
  const a = SHARP_NOTES.indexOf(normaliseRoot(fromKey))
  const b = SHARP_NOTES.indexOf(normaliseRoot(toKey))
  if (a === -1 || b === -1) return 0
  return ((b - a) + 12) % 12
}

const DISPLAY_KEYS = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']

// ─── Component ────────────────────────────────────────────────────────────────

export default function NoteDetailScreen({ route, navigation }: Props) {
  const { colors: c } = useAppTheme()
  const styles = useMemo(() => makeStyles(c), [c])

  const { noteId } = route.params

  const [title, setTitle]           = useState('')
  const [content, setContent]       = useState('')
  const [loading, setLoading]       = useState(true)
  const [hasChanges, setHasChanges] = useState(false)
  const [savedAt, setSavedAt]       = useState<Date | null>(null)

  const contentRef       = useRef<TextInput>(null)
  const hasLoadedOnceRef = useRef(false)

  const selectionRef = useRef<{ start: number; end: number }>({ start: 0, end: 0 })
  const [selectionText, setSelectionText] = useState<string | null>(null)

  const [showTranspose, setShowTranspose] = useState(false)
  const [targetKey, setTargetKey]         = useState<string | null>(null)

  // Auto-detected key from content/selection
  const detectedKey = useMemo(
    () => detectKey(selectionText ?? content),
    [selectionText, content],
  )

  // Manual override: user can tap a key cell in the "From" row to set it explicitly
  const [manualFromKey, setManualFromKey] = useState<string | null>(null)

  // Effective "from" key — manual wins over detected
  const effectiveFromKey = manualFromKey ?? detectedKey

  // Reset manual key when transpose panel closes or selection changes
  useEffect(() => {
    if (!showTranspose) setManualFromKey(null)
  }, [showTranspose])

  useEffect(() => {
    setManualFromKey(null)
  }, [selectionText])

  // ── Load / save ──────────────────────────────────────────────────────────────

  useEffect(() => {
    void loadNote({ silent: hasLoadedOnceRef.current })
  }, [navigation])

  useEffect(() => {
    const unsub = onTableChange('chord_lists', () => void loadNote({ silent: true }))
    return () => unsub()
  }, [noteId])

  const loadNote = async ({ silent = false }: { silent?: boolean } = {}) => {
    try {
      if (!silent) setLoading(true)
      const row = await queryOne('SELECT * FROM chord_lists WHERE id = ?', [noteId]) as any
      if (row) {
        setTitle(row.title ?? '')
        setContent(row.content ?? '')
        if (row.updated_at) setSavedAt(new Date(row.updated_at))
      }
    } catch (err) {
      console.error('Error loading note:', err)
      Alert.alert('Error', 'Failed to load note')
    } finally {
      hasLoadedOnceRef.current = true
      setLoading(false)
    }
  }

  const handleSave = async () => {
    if (!title.trim()) { Alert.alert('Error', 'Please enter a title'); return }
    try {
      const now = Date.now()
      await execute(
        'UPDATE chord_lists SET title = ?, content = ?, updated_at = ?, _synced = 0 WHERE id = ?',
        [title.trim(), content, now, noteId],
      )
      setHasChanges(false)
      setSavedAt(new Date(now))
      navigation.goBack()
    } catch (err) {
      console.error('Error saving note:', err)
      Alert.alert('Error', 'Failed to save note')
    }
  }

  const handleCancel = () => {
    if (hasChanges) {
      Alert.alert('Discard Changes?', 'You have unsaved changes.', [
        { text: 'Keep Editing', style: 'cancel' },
        { text: 'Discard', style: 'destructive', onPress: () => navigation.goBack() },
      ])
    } else {
      navigation.goBack()
    }
  }

  // ── Selection tracking ───────────────────────────────────────────────────────

  const handleSelectionChange = useCallback((e: any) => {
    const { start, end } = e.nativeEvent.selection
    selectionRef.current = { start, end }
    setSelectionText(end > start ? content.slice(start, end) : null)
  }, [content])

  // ── Apply transpose ──────────────────────────────────────────────────────────

  const canApply = !!effectiveFromKey && !!targetKey && effectiveFromKey !== normaliseRoot(targetKey)

  const handleApply = useCallback(() => {
    if (!effectiveFromKey || !targetKey || effectiveFromKey === normaliseRoot(targetKey)) return

    const semitones   = semitonesBetween(effectiveFromKey, targetKey)
    const targetRoot  = normaliseRoot(targetKey)

    const { start, end } = selectionRef.current
    const hasSelection   = end > start

    if (hasSelection) {
      const before  = content.slice(0, start)
      const middle  = content.slice(start, end)
      const after   = content.slice(end)
      setContent(before + transposeText(middle, semitones, targetRoot) + after)
    } else {
      setContent(transposeText(content, semitones, targetRoot))
    }

    setHasChanges(true)
    setManualFromKey(null)
    setTargetKey(null)
  }, [content, effectiveFromKey, targetKey])

  // ── Render ───────────────────────────────────────────────────────────────────

  const hasSelection = selectionText !== null

  return (
    <View style={styles.root}>
      <StatusBar barStyle="dark-content" backgroundColor={c.surface} />

      {/* ─── HEADER ─── */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.iconBtn} onPress={handleCancel} activeOpacity={0.7}>
          <Ionicons name="arrow-back" size={16} color={c.text} />
        </TouchableOpacity>

        <View style={styles.headerCenter}>
          <Text style={styles.headerEyebrow}>NOTE</Text>
          {hasChanges && <View style={styles.unsavedDot} />}
        </View>

        <TouchableOpacity
          style={[styles.iconBtn, showTranspose && styles.iconBtnActive]}
          onPress={() => setShowTranspose(p => !p)}
          activeOpacity={0.75}
        >
          <Ionicons
            name="musical-notes-outline"
            size={15}
            color={showTranspose ? c.accentText : c.text}
          />
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.saveBtn, hasChanges && styles.saveBtnActive]}
          onPress={handleSave}
          activeOpacity={0.8}
          disabled={!hasChanges}
        >
          <Text style={[styles.saveBtnText, hasChanges && styles.saveBtnTextActive]}>Save</Text>
        </TouchableOpacity>
      </View>

      {/* ─── TRANSPOSE PANEL ─── */}
      {showTranspose && (
        <View style={styles.transposePanel}>

          {/* Scope tag */}
          <View style={styles.transposeLabelRow}>
            <View style={styles.transposeScopeTag}>
              <Ionicons
                name={hasSelection ? 'text-outline' : 'document-text-outline'}
                size={11}
                color={c.textMuted}
              />
              <Text style={styles.transposeScopeText}>
                {hasSelection ? 'Selection' : 'Whole note'}
              </Text>
            </View>

            {effectiveFromKey && targetKey && canApply ? (
              <Text style={styles.transposeFromLabel}>
                <Text style={styles.transposeKeyFrom}>{effectiveFromKey}</Text>
                {'  →  '}
                <Text style={styles.transposeKeyTo}>{targetKey}</Text>
              </Text>
            ) : effectiveFromKey ? (
              <Text style={styles.transposeFromLabel}>
                {'From '}
                <Text style={styles.transposeKeyFrom}>{effectiveFromKey}</Text>
              </Text>
            ) : (
              <Text style={styles.transposeNoChords}>No chords detected</Text>
            )}
          </View>

          {/* ── FROM key row ── */}
          <View style={styles.sectionLabel}>
            <Text style={styles.sectionLabelText}>FROM</Text>
            {detectedKey && manualFromKey && (
              <TouchableOpacity onPress={() => setManualFromKey(null)} activeOpacity={0.7}>
                <Text style={styles.resetDetected}>Use detected ({detectedKey})</Text>
              </TouchableOpacity>
            )}
            {detectedKey && !manualFromKey && (
              <Text style={styles.autoDetectedBadge}>auto-detected</Text>
            )}
          </View>
          <View style={styles.keyGrid}>
            {DISPLAY_KEYS.map(key => {
              const normKey    = normaliseRoot(key)
              const isActive   = normKey === effectiveFromKey
              const isDetected = normKey === detectedKey && !manualFromKey
              const isManual   = normKey === manualFromKey
              return (
                <TouchableOpacity
                  key={key}
                  style={[
                    styles.keyCell,
                    isActive && !isManual && styles.keyCellDetected,
                    isManual && styles.keyCellManual,
                  ]}
                  onPress={() => setManualFromKey(normKey === manualFromKey ? null : normKey)}
                  activeOpacity={0.7}
                >
                  <Text style={[
                    styles.keyCellText,
                    isActive && !isManual && styles.keyCellTextDetected,
                    isManual && styles.keyCellTextManual,
                  ]}>
                    {key}
                  </Text>
                </TouchableOpacity>
              )
            })}
          </View>

          {/* ── TO key row ── */}
          <View style={styles.sectionLabel}>
            <Text style={styles.sectionLabelText}>TO</Text>
          </View>
          <View style={styles.keyGrid}>
            {DISPLAY_KEYS.map(key => {
              const normKey  = normaliseRoot(key)
              const isTarget = normKey === normaliseRoot(targetKey ?? '')
              return (
                <TouchableOpacity
                  key={key}
                  style={[
                    styles.keyCell,
                    isTarget && styles.keyCellTarget,
                  ]}
                  onPress={() => setTargetKey(normKey)}
                  activeOpacity={0.7}
                >
                  <Text style={[
                    styles.keyCellText,
                    isTarget && styles.keyCellTextTarget,
                  ]}>
                    {key}
                  </Text>
                </TouchableOpacity>
              )
            })}
          </View>

          {/* Apply */}
          <View style={styles.transposeApplyRow}>
            <TouchableOpacity
              style={[styles.applyBtn, !canApply && styles.applyBtnDisabled]}
              onPress={handleApply}
              activeOpacity={0.8}
              disabled={!canApply}
            >
              <Ionicons name="checkmark" size={14} color={canApply ? c.accentText : c.iconInactive} />
              <Text style={[styles.applyBtnText, !canApply && styles.applyBtnTextDisabled]}>
                {hasSelection ? 'Transpose selection' : 'Transpose all'}
              </Text>
            </TouchableOpacity>
          </View>

          <Text style={styles.transposeHint}>
            {hasSelection
              ? 'Transposing highlighted text only. Tap Apply to write changes.'
              : 'Tap a FROM key to override auto-detection, then pick a TO key and apply.'}
          </Text>
        </View>
      )}

      {/* ─── EDITOR ─── */}
      <ScrollView
        style={styles.editorScroll}
        contentContainerStyle={styles.editorContent}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="none"
      >
        <TextInput
          style={styles.titleInput}
          placeholder="Untitled"
          placeholderTextColor={c.textMuted}
          value={title}
          onChangeText={text => { setTitle(text); setHasChanges(true) }}
          returnKeyType="next"
          onSubmitEditing={() => contentRef.current?.focus()}
          blurOnSubmit={false}
        />

        <View style={styles.dividerRow}>
          <View style={styles.divider} />
          <Text style={styles.metaText}>
            {content.trim().length > 0
              ? `${content.trim().split(/\s+/).length} words  ·  ${content.length} chars`
              : savedAt
                ? `Saved ${savedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
                : 'New note'}
          </Text>
          <View style={styles.divider} />
        </View>

        <TextInput
          ref={contentRef}
          style={styles.contentInput}
          placeholder={'Start writing…\n\nHighlight chords and use ♪ to transpose that portion only.'}
          placeholderTextColor={c.textMuted}
          value={content}
          onChangeText={text => { setContent(text); setHasChanges(true) }}
          onSelectionChange={handleSelectionChange}
          multiline
          textAlignVertical="top"
          autoCorrect
          autoCapitalize="sentences"
          scrollEnabled={false}
        />

        <View style={{ height: 320 }} />
      </ScrollView>
    </View>
  )
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const makeStyles = (c: AppColors) => StyleSheet.create({
  root: { flex: 1, backgroundColor: c.surface },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: Platform.OS === 'ios' ? 54 : (StatusBar.currentHeight ?? 24) + 8,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: c.hairline,
    backgroundColor: c.surface,
    gap: 10,
  },
  iconBtn: {
    width: 34, height: 34, borderRadius: 10,
    backgroundColor: c.surfaceAlt,
    justifyContent: 'center', alignItems: 'center',
  },
  iconBtnActive: { backgroundColor: c.accent },
  headerCenter: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
  },
  headerEyebrow: { fontSize: 10, fontWeight: '700', color: c.iconInactive, letterSpacing: 2.5 },
  unsavedDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: c.accent },

  saveBtn: {
    borderRadius: 10, paddingHorizontal: 16, paddingVertical: 8,
    backgroundColor: c.surfaceAlt, minWidth: 58, alignItems: 'center',
  },
  saveBtnActive: { backgroundColor: c.accent },
  saveBtnText: { fontSize: 13, fontWeight: '700', color: c.iconInactive },
  saveBtnTextActive: { color: c.accentText },

  transposePanel: {
    borderBottomWidth: 1,
    borderBottomColor: c.hairline,
    backgroundColor: c.surfaceAlt,
    paddingBottom: 12,
    gap: 6,
  },
  transposeLabelRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingTop: 12, gap: 10,
  },
  transposeScopeTag: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: c.surfaceMuted, borderRadius: 8,
    paddingHorizontal: 9, paddingVertical: 5,
  },
  transposeScopeText: { fontSize: 11, fontWeight: '600', color: c.textSub },
  transposeFromLabel: { fontSize: 13, color: c.textMuted, fontWeight: '600' },
  transposeKeyFrom: { color: c.text, fontWeight: '800' },
  transposeKeyTo: { color: c.info, fontWeight: '800' },
  transposeNoChords: { fontSize: 12, color: c.iconInactive, fontStyle: 'italic' },

  sectionLabel: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingTop: 4, gap: 8,
  },
  sectionLabelText: {
    fontSize: 9, fontWeight: '700', color: c.iconInactive, letterSpacing: 1.8,
  },
  autoDetectedBadge: {
    fontSize: 9, fontWeight: '600', color: c.iconInactive, fontStyle: 'italic',
  },
  resetDetected: {
    fontSize: 10, fontWeight: '600', color: c.info,
  },

  keyGrid: {
    flexDirection: 'row', flexWrap: 'wrap',
    paddingHorizontal: 16, gap: 7,
  },
  keyCell: {
    flex: 1, minWidth: 44,
    paddingVertical: 10,
    borderRadius: 10,
    alignItems: 'center',
    backgroundColor: c.surfaceMuted,
    borderWidth: 1.5,
    borderColor: 'transparent',
  },
  keyCellDetected: {
    backgroundColor: c.surfaceAlt,
    borderColor: c.accent,
  },
  keyCellManual: {
    backgroundColor: c.accent,
    borderColor: c.accent,
  },
  keyCellTarget: {
    backgroundColor: c.info,
    borderColor: c.info,
  },
  keyCellText: { fontSize: 14, fontWeight: '700', color: c.textSub },
  keyCellTextDetected: { color: c.text },
  keyCellTextManual: { color: c.accentText },
  keyCellTextTarget: { color: c.accentText },

  transposeApplyRow: { paddingHorizontal: 16, paddingTop: 4 },
  applyBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 6, paddingVertical: 11, borderRadius: 12,
    backgroundColor: c.accent,
  },
  applyBtnDisabled: { backgroundColor: c.surfaceMuted },
  applyBtnText: { fontSize: 13, fontWeight: '700', color: c.accentText },
  applyBtnTextDisabled: { color: c.iconInactive },

  transposeHint: {
    fontSize: 10, color: c.iconInactive, lineHeight: 15,
    paddingHorizontal: 16, fontStyle: 'italic',
  },

  editorScroll: { flex: 1 },
  editorContent: { paddingHorizontal: 22, paddingTop: 24 },
  titleInput: {
    fontSize: 28, fontWeight: '800', color: c.text,
    letterSpacing: -0.8, lineHeight: 34, marginBottom: 16, padding: 0,
  },
  dividerRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 20 },
  divider: { flex: 1, height: 1, backgroundColor: c.surfaceAlt },
  metaText: { fontSize: 10, fontWeight: '600', color: c.iconInactive, letterSpacing: 0.3 },
  contentInput: {
    fontSize: 15, color: c.textSub, lineHeight: 26,
    padding: 0, fontWeight: '400', minHeight: 300,
  },
})