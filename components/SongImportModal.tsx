// components/SongImportModal.tsx
//
// Finding a song on the internet, in three steps the user stays in charge of:
//
//   1. Search  - type a title, choose which sites to look in
//   2. Choose  - every site's answers side by side, each labelled with where
//                it came from
//   3. Edit    - the chosen sheet, in full, editable before it goes anywhere
//
// Step 3 is the point of the whole screen. Scraped chord sheets are never
// quite right: a site may not name the key, may run the sections together, or
// may put a chord a column off. Everything lands in ordinary text boxes so it
// can be fixed here, and nothing reaches the song until "Use this song".

import React, { useCallback, useEffect, useRef, useState , useMemo} from 'react'
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native'
import { useAppTheme, type AppColors } from '../lib/theme'
import Ionicons from '@expo/vector-icons/Ionicons'
import {
  CHORD_SOURCES,
  DEFAULT_SOURCE_IDS,
  SongSearchResult,
  SourceOutcome,
  fetchResultSong,
  importSongFromUrl,
  searchChordSites,
} from '../lib/chordSources'
import { ImportedSong } from '../lib/songImport'

interface Props {
  visible: boolean
  onClose: () => void
  /** Handed the song once the user is happy with it */
  onUse: (song: ImportedSong) => void
  /** Pre-fills the search box, e.g. with the title already typed */
  initialQuery?: string
}

type Stage = 'search' | 'results' | 'preview'

const EMPTY_DRAFT: ImportedSong = { title: '', artist: '', key: '', content: '', source: '' }

export default function SongImportModal({ visible, onClose, onUse, initialQuery = '' }: Props) {
  const { colors: c } = useAppTheme()
  const styles = useMemo(() => makeStyles(c), [c])

  const [stage, setStage] = useState<Stage>('search')
  const [query, setQuery] = useState(initialQuery)
  const [sourceIds, setSourceIds] = useState<string[]>(DEFAULT_SOURCE_IDS)

  const [searching, setSearching] = useState(false)
  const [results, setResults] = useState<SongSearchResult[]>([])
  const [failed, setFailed] = useState<{ sourceName: string; reason: string }[]>([])
  const [perSource, setPerSource] = useState<SourceOutcome[]>([])
  const [loosened, setLoosened] = useState(false)
  const [error, setError] = useState('')

  const [openingId, setOpeningId] = useState('')
  const [draft, setDraft] = useState<ImportedSong>(EMPTY_DRAFT)
  const [pickedFrom, setPickedFrom] = useState('')

  // Lets a search or a page load be dropped when the user moves on
  const abortRef = useRef<AbortController | null>(null)

  const cancelInFlight = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
  }, [])

  useEffect(() => {
    if (visible) setQuery(prev => (prev ? prev : initialQuery))
    else cancelInFlight()
  }, [visible, initialQuery, cancelInFlight])

  useEffect(() => cancelInFlight, [cancelInFlight])

  const toggleSource = (id: string) => {
    setSourceIds(prev => (prev.includes(id) ? prev.filter(s => s !== id) : [...prev, id]))
  }

  const runSearch = async () => {
    if (!query.trim()) { setError('Type the name of a song to search for'); return }
    if (sourceIds.length === 0) { setError('Pick at least one site to search'); return }

    cancelInFlight()
    const controller = new AbortController()
    abortRef.current = controller

    setSearching(true)
    setError('')
    setResults([])
    setFailed([])
    setPerSource([])
    setLoosened(false)
    setStage('results')

    try {
      const outcome = await searchChordSites(query, { sourceIds, signal: controller.signal })
      if (controller.signal.aborted) return
      setResults(outcome.results)
      setFailed(outcome.failed.map(f => ({ sourceName: f.sourceName, reason: f.reason })))
      setPerSource(outcome.perSource)
      setLoosened(outcome.loosened)
      if (outcome.results.length === 0) {
        setError(
          outcome.failed.length === sourceIds.length
            ? 'None of the sites could be reached. Check your connection and try again.'
            : 'Nothing found. Try a shorter title - just the first few words - or turn on more sites.',
        )
      }
    } catch (err: any) {
      if (!controller.signal.aborted) setError(err?.message || 'The search failed')
    } finally {
      if (!controller.signal.aborted) setSearching(false)
    }
  }

  /** Load one choice and move on to the editor. */
  const openResult = async (result: SongSearchResult) => {
    cancelInFlight()
    const controller = new AbortController()
    abortRef.current = controller

    setOpeningId(result.id)
    setError('')

    try {
      const song = await fetchResultSong(result, { signal: controller.signal })
      if (controller.signal.aborted) return
      setDraft(song)
      setPickedFrom(result.sourceName)
      setStage('preview')
    } catch (err: any) {
      if (!controller.signal.aborted) setError(err?.message || 'That page could not be read')
    } finally {
      if (!controller.signal.aborted) setOpeningId('')
    }
  }

  /** A pasted link skips the search and goes straight to the editor. */
  const openLink = async () => {
    const url = query.trim()
    cancelInFlight()
    const controller = new AbortController()
    abortRef.current = controller

    setSearching(true)
    setError('')

    try {
      const song = await importSongFromUrl(url, { signal: controller.signal })
      if (controller.signal.aborted) return
      setDraft(song)
      setPickedFrom('the link you pasted')
      setStage('preview')
    } catch (err: any) {
      if (!controller.signal.aborted) setError(err?.message || 'That page could not be read')
    } finally {
      if (!controller.signal.aborted) setSearching(false)
    }
  }

  const close = () => {
    cancelInFlight()
    setStage('search')
    setError('')
    setOpeningId('')
    setSearching(false)
    onClose()
  }

  const useThisSong = () => {
    onUse({ ...draft, content: draft.content.trim() })
    close()
  }

  const looksLikeLink = /^https?:\/\//i.test(query.trim())
  const chordCount = (draft.content.match(/\[[^\]]+\]/g) || []).length

  // ── Search stage ───────────────────────────────────────────────────────────
  const renderSearch = () => (
    <ScrollView
      style={styles.body}
      contentContainerStyle={styles.bodyContent}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={styles.hint}>
        Type a song title and the app looks through several chord sites at once. You pick
        which result to use, and you can change every word of it before it is added.
      </Text>

      <View style={styles.searchRow}>
        <TextInput
          style={styles.searchInput}
          placeholder="Song title, or paste a link"
          placeholderTextColor={c.textMuted}
          value={query}
          onChangeText={setQuery}
          autoCapitalize="words"
          autoCorrect={false}
          editable={!searching}
          returnKeyType="search"
          onSubmitEditing={looksLikeLink ? openLink : runSearch}
        />
        <TouchableOpacity
          style={[styles.searchBtn, searching && styles.btnBusy]}
          onPress={looksLikeLink ? openLink : runSearch}
          disabled={searching}
          activeOpacity={0.85}
        >
          {searching
            ? <ActivityIndicator size="small" color={c.accentText} />
            : <Ionicons name={looksLikeLink ? 'arrow-down' : 'search'} size={17} color={c.accentText} />}
        </TouchableOpacity>
      </View>

      {looksLikeLink && (
        <Text style={styles.linkNote}>That is a link — it will be opened directly.</Text>
      )}

      <Text style={styles.sectionLabel}>SITES TO SEARCH</Text>
      <View style={styles.sourceList}>
        {CHORD_SOURCES.map(source => {
          const on = sourceIds.includes(source.id)
          return (
            <TouchableOpacity
              key={source.id}
              style={[styles.sourceRow, on && styles.sourceRowOn]}
              onPress={() => toggleSource(source.id)}
              activeOpacity={0.75}
            >
              <Ionicons
                name={on ? 'checkbox' : 'square-outline'}
                size={18}
                color={on ? c.text : c.iconInactive}
              />
              <View style={styles.sourceText}>
                <Text style={styles.sourceName}>{source.name}</Text>
                <Text style={styles.sourceBlurb}>{source.blurb}</Text>
              </View>
              <Text style={styles.sourceDomain}>{source.domain}</Text>
            </TouchableOpacity>
          )
        })}
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <Text style={styles.footnote}>
        These are public web pages, read the same way a browser reads them. A site that builds
        its chord sheet in the browser cannot be read this way — open it yourself, copy the
        chords, and use Paste on the previous screen.
      </Text>
    </ScrollView>
  )

  // ── Results stage ──────────────────────────────────────────────────────────
  const renderResultRow = ({ item }: { item: SongSearchResult }) => {
    const busy = openingId === item.id
    return (
      <TouchableOpacity
        style={styles.resultRow}
        onPress={() => openResult(item)}
        disabled={!!openingId}
        activeOpacity={0.75}
      >
        <View style={styles.resultMain}>
          <Text style={styles.resultTitle} numberOfLines={1}>{item.title}</Text>
          <Text style={styles.resultArtist} numberOfLines={1}>
            {item.artist || 'Artist not given'}
          </Text>
          <View style={styles.resultMetaRow}>
            <Text style={styles.sourceBadge}>{item.sourceName}</Text>
            {item.key ? <Text style={styles.resultMeta}>Key {item.key}</Text> : null}
            {item.rating ? (
              <Text style={styles.resultMeta}>
                {item.rating.toFixed(1)}★{item.votes ? ` · ${item.votes}` : ''}
              </Text>
            ) : null}
          </View>
        </View>
        {busy
          ? <ActivityIndicator size="small" color={c.text} />
          : <Ionicons name="chevron-forward" size={16} color={c.iconInactive} />}
      </TouchableOpacity>
    )
  }

  const renderResults = () => (
    <FlatList
      style={styles.body}
      contentContainerStyle={styles.bodyContent}
      data={results}
      keyExtractor={item => item.id}
      renderItem={renderResultRow}
      keyboardShouldPersistTaps="handled"
      ListHeaderComponent={
        <View>
          {searching ? (
            <View style={styles.searchingRow}>
              <ActivityIndicator size="small" color={c.text} />
              <Text style={styles.searchingText}>
                Looking through {sourceIds.length} {sourceIds.length === 1 ? 'site' : 'sites'}…
              </Text>
            </View>
          ) : results.length > 0 ? (
            <Text style={styles.hint}>
              {loosened
                ? `No exact match, so here is the closest ${
                    results.length === 1 ? 'thing' : 'few things'
                  } the sites do have. Check the title before you use one.`
                : `${results.length} ${
                    results.length === 1 ? 'version' : 'versions'
                  } found. Pick one to look at it — you can come back and try another.`}
            </Text>
          ) : null}
          {error ? <Text style={styles.error}>{error}</Text> : null}
        </View>
      }
      ListFooterComponent={
        searching ? null : (
          <View>
            {/* Site by site, so an empty search says why rather than just
                sitting there blank */}
            {perSource.length > 0 && (
              <View style={styles.breakdown}>
                <Text style={styles.breakdownLabel}>WHAT EACH SITE SAID</Text>
                {perSource.map(s => (
                  <View key={s.sourceId} style={styles.breakdownRow}>
                    <Text style={styles.breakdownName}>{s.sourceName}</Text>
                    <Text style={styles.breakdownWord} numberOfLines={2}>
                      {s.reason
                        ? s.reason
                        : s.found === 0
                          ? 'nothing for that search'
                          : s.kept > 0
                            ? `${s.kept} match${s.kept === 1 ? '' : 'es'}`
                            : `${s.found} found, none matching`}
                    </Text>
                  </View>
                ))}
              </View>
            )}

            {results.length === 0 && (
              <TouchableOpacity
                style={styles.secondaryBtn}
                onPress={goBackToSearch}
                activeOpacity={0.8}
              >
                <Ionicons name="arrow-back" size={14} color={c.text} />
                <Text style={styles.secondaryBtnText}>Change the search or the sites</Text>
              </TouchableOpacity>
            )}

            {failed.length > 0 && (
              <Text style={styles.footnote}>
                A site that cannot be read is usually blocking apps rather than missing the song —
                open it in a browser, copy the chords, and use Paste instead.
              </Text>
            )}
          </View>
        )
      }
    />
  )

  // ── Preview / edit stage ───────────────────────────────────────────────────
  const renderPreview = () => (
    <ScrollView
      style={styles.body}
      contentContainerStyle={styles.bodyContent}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={styles.hint}>
        From {pickedFrom || 'the web'} — {chordCount > 0
          ? `${chordCount} chords found`
          : 'no chords recognised, so check the text'}. Change anything below; nothing is saved
        until you tap Use this song.
      </Text>

      <View style={styles.card}>
        <View style={styles.fieldRow}>
          <Text style={styles.fieldLabel}>Title</Text>
          <TextInput
            style={styles.fieldInput}
            value={draft.title}
            onChangeText={t => setDraft(d => ({ ...d, title: t }))}
            placeholder="Song title"
            placeholderTextColor={c.textMuted}
          />
        </View>
        <View style={styles.fieldDivider} />
        <View style={styles.fieldRow}>
          <Text style={styles.fieldLabel}>Artist</Text>
          <TextInput
            style={styles.fieldInput}
            value={draft.artist}
            onChangeText={t => setDraft(d => ({ ...d, artist: t }))}
            placeholder="Artist"
            placeholderTextColor={c.textMuted}
          />
        </View>
        <View style={styles.fieldDivider} />
        <View style={styles.fieldRow}>
          <Text style={styles.fieldLabel}>Key</Text>
          <TextInput
            style={styles.fieldInput}
            value={draft.key}
            onChangeText={t => setDraft(d => ({ ...d, key: t }))}
            placeholder="e.g. G"
            placeholderTextColor={c.textMuted}
            autoCapitalize="characters"
          />
        </View>
      </View>

      {draft.source ? (
        <Text style={styles.sourceLine} numberOfLines={2}>{draft.source}</Text>
      ) : null}

      <Text style={[styles.sectionLabel, { marginTop: 18 }]}>CHORDS & LYRICS</Text>
      <View style={styles.formatHintRow}>
        <Ionicons name="information-circle-outline" size={12} color={c.iconInactive} />
        <Text style={styles.formatHintText}>Chords: [G]Amazing [D]grace · Sections: Verse 1</Text>
      </View>
      <TextInput
        style={styles.contentInput}
        value={draft.content}
        onChangeText={t => setDraft(d => ({ ...d, content: t }))}
        multiline
        textAlignVertical="top"
        autoCorrect={false}
        autoCapitalize="none"
      />

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <TouchableOpacity style={styles.useBtn} onPress={useThisSong} activeOpacity={0.85}>
        <Ionicons name="checkmark" size={18} color={c.accentText} style={{ marginRight: 8 }} />
        <Text style={styles.useBtnText}>Use this song</Text>
      </TouchableOpacity>

      <View style={{ height: 40 }} />
    </ScrollView>
  )

  const headerTitle =
    stage === 'search' ? 'Find a song' : stage === 'results' ? 'Choose a version' : 'Check and edit'

  const goBack = () => {
    cancelInFlight()
    setError('')
    setOpeningId('')
    setSearching(false)
    setStage(stage === 'preview' && results.length > 0 ? 'results' : 'search')
  }

  function goBackToSearch() {
    cancelInFlight()
    setError('')
    setSearching(false)
    setStage('search')
  }

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={close}>
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.header}>
          <TouchableOpacity
            style={styles.headerBtn}
            onPress={stage === 'search' ? close : goBack}
            activeOpacity={0.7}
          >
            <Ionicons name={stage === 'search' ? 'close' : 'arrow-back'} size={16} color={c.text} />
          </TouchableOpacity>
          <View style={styles.headerMeta}>
            <Text style={styles.headerEyebrow}>IMPORT</Text>
            <Text style={styles.headerTitle}>{headerTitle}</Text>
          </View>
          {stage !== 'search' && (
            <TouchableOpacity style={styles.headerBtn} onPress={close} activeOpacity={0.7}>
              <Ionicons name="close" size={16} color={c.text} />
            </TouchableOpacity>
          )}
        </View>

        {stage === 'search' && renderSearch()}
        {stage === 'results' && renderResults()}
        {stage === 'preview' && renderPreview()}
      </KeyboardAvoidingView>
    </Modal>
  )
}

const makeStyles = (c: AppColors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.surfaceAlt },

  header: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: c.surface,
    paddingHorizontal: 16, paddingVertical: 14,
    borderBottomWidth: 1, borderBottomColor: c.hairline, gap: 12,
    paddingTop: Platform.OS === 'ios' ? 52 : 14,
  },
  headerBtn: {
    width: 34, height: 34, borderRadius: 10, backgroundColor: c.surfaceAlt,
    justifyContent: 'center', alignItems: 'center',
  },
  headerMeta: { flex: 1, gap: 2 },
  headerEyebrow: { fontSize: 9, fontWeight: '700', color: c.iconInactive, letterSpacing: 2 },
  headerTitle: { fontSize: 16, fontWeight: '800', color: c.text, letterSpacing: -0.4 },

  body: { flex: 1 },
  bodyContent: { paddingHorizontal: 16, paddingTop: 18, paddingBottom: 28 },

  hint: { fontSize: 12, color: c.textMuted, fontWeight: '500', lineHeight: 18, marginBottom: 14 },
  sectionLabel: {
    fontSize: 10, fontWeight: '700', color: c.iconInactive,
    letterSpacing: 1.8, marginTop: 20, marginBottom: 10,
  },
  footnote: { fontSize: 11, color: c.textMuted, fontWeight: '500', lineHeight: 16, marginTop: 16 },
  error: {
    fontSize: 12, fontWeight: '600', color: c.danger, backgroundColor: c.dangerBg,
    borderRadius: 8, padding: 10, marginTop: 12, lineHeight: 17,
  },
  linkNote: { fontSize: 11, color: c.textMuted, fontWeight: '600', marginTop: 8 },

  searchRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  searchInput: {
    flex: 1, height: 44, borderRadius: 10, borderWidth: 1.5, borderColor: c.border,
    paddingHorizontal: 12, fontSize: 14, color: c.text, backgroundColor: c.surface,
  },
  searchBtn: {
    width: 46, height: 44, borderRadius: 10, backgroundColor: c.accent,
    alignItems: 'center', justifyContent: 'center',
  },
  btnBusy: { opacity: 0.7 },

  sourceList: {
    backgroundColor: c.surface, borderRadius: 14,
    borderWidth: 1, borderColor: c.hairline, overflow: 'hidden',
  },
  sourceRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 14, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: c.hairline,
  },
  sourceRowOn: { backgroundColor: c.surfaceAlt },
  sourceText: { flex: 1, gap: 2 },
  sourceName: { fontSize: 13.5, fontWeight: '700', color: c.text },
  sourceBlurb: { fontSize: 11, fontWeight: '500', color: c.textMuted },
  sourceDomain: { fontSize: 10, fontWeight: '600', color: c.iconInactive },

  breakdown: {
    marginTop: 18, backgroundColor: c.surface, borderRadius: 12,
    borderWidth: 1, borderColor: c.hairline, paddingHorizontal: 14, paddingVertical: 12, gap: 8,
  },
  breakdownLabel: { fontSize: 9, fontWeight: '700', color: c.iconInactive, letterSpacing: 1.6 },
  breakdownRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  breakdownName: { fontSize: 12.5, fontWeight: '700', color: c.text, width: 116, flexShrink: 0 },
  breakdownWord: { flex: 1, fontSize: 12, fontWeight: '500', color: c.textMuted, textAlign: 'right' },

  secondaryBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7,
    marginTop: 14, paddingVertical: 12, borderRadius: 10,
    borderWidth: 1.5, borderColor: c.border, backgroundColor: c.surface,
  },
  secondaryBtnText: { fontSize: 13, fontWeight: '700', color: c.text },

  searchingRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 16 },
  searchingText: { fontSize: 13, fontWeight: '600', color: c.textSub },

  resultRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: c.surface, borderRadius: 12, borderWidth: 1, borderColor: c.hairline,
    paddingHorizontal: 14, paddingVertical: 12, marginBottom: 8,
  },
  resultMain: { flex: 1, gap: 3 },
  resultTitle: { fontSize: 14, fontWeight: '700', color: c.text },
  resultArtist: { fontSize: 12, fontWeight: '500', color: c.textMuted },
  resultMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 3 },
  sourceBadge: {
    fontSize: 10, fontWeight: '700', color: c.warning,
    backgroundColor: c.warningBg, borderWidth: 1, borderColor: c.warning,
    borderRadius: 6, paddingHorizontal: 7, paddingVertical: 3, overflow: 'hidden',
  },
  resultMeta: { fontSize: 10.5, fontWeight: '600', color: c.textMuted },

  card: {
    backgroundColor: c.surface, borderRadius: 16, borderWidth: 1, borderColor: c.hairline,
    overflow: 'hidden', paddingHorizontal: 14,
  },
  fieldRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, gap: 12 },
  fieldDivider: { height: 1, backgroundColor: c.surfaceAlt },
  fieldLabel: { fontSize: 13, fontWeight: '600', color: c.text, width: 52, flexShrink: 0 },
  fieldInput: {
    flex: 1, fontSize: 14, color: c.text, fontWeight: '500', padding: 0, textAlign: 'right',
  },
  sourceLine: { fontSize: 10, color: c.iconInactive, fontWeight: '500', marginTop: 8 },

  formatHintRow: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 12, paddingVertical: 9,
    backgroundColor: c.surface, borderTopLeftRadius: 12, borderTopRightRadius: 12,
    borderWidth: 1, borderBottomWidth: 0, borderColor: c.hairline,
  },
  formatHintText: {
    fontSize: 11, color: c.iconInactive, fontWeight: '500', fontFamily: 'Courier New', flex: 1,
  },
  contentInput: {
    fontSize: 13.5, color: c.text, lineHeight: 23, minHeight: 260,
    paddingHorizontal: 12, paddingTop: 12, paddingBottom: 16,
    fontFamily: 'Courier New', textAlignVertical: 'top',
    backgroundColor: c.surface, borderWidth: 1, borderColor: c.hairline,
    borderBottomLeftRadius: 12, borderBottomRightRadius: 12,
  },

  useBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    marginTop: 22, paddingVertical: 16, borderRadius: 16, backgroundColor: c.accent,
  },
  useBtnText: { fontSize: 15, fontWeight: '800', color: c.accentText, letterSpacing: -0.2 },
})
