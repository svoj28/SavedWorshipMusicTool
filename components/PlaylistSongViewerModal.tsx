import React, { useEffect, useState, useRef, useCallback, useMemo } from 'react'
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Dimensions,
  StatusBar,
  Platform,
  Animated,
} from 'react-native'
import { useAppTheme, type AppColors } from '../lib/theme'
import { ScrollView as HorizontalScroll } from 'react-native'
import Ionicons from '@expo/vector-icons/Ionicons'
import { getAllKeys, getTransposeDistance, transposeText, hasNashville, transposeTextToNashville, isSameKey } from '../lib/transpose'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { useKeepScreenAwake } from '../lib/useKeepScreenAwake'

const SCREEN_WIDTH = Dimensions.get('window').width

const SECTION_HEADER_LINE_PATTERN = /^(intro|verse|chorus|bridge|pre[-\s]?chorus|hook|outro|coda)(?:\s*[0-9]+)?$/i

function isSectionHeaderLine(line: string): boolean {
  return SECTION_HEADER_LINE_PATTERN.test(line.trim())
}

type SongSection = {
  id: string
  label: string
  content: string
}

function normalizeSectionLabel(rawLabel: string, fallbackIndex: number) {
  const cleaned = rawLabel.trim()
  const match = cleaned.match(/^(intro|verse|chorus|bridge|pre[-\s]?chorus|hook|outro|coda)\s*([0-9]+)?$/i)
  if (!match) return cleaned || `Section ${fallbackIndex + 1}`
  const base = match[1].replace(/[-\s]/g, ' ')
  const number = match[2] ? ` ${match[2]}` : ''
  return `${base.charAt(0).toUpperCase()}${base.slice(1).toLowerCase()}${number}`
}

function getChordRoot(chord: string): string {
  const match = chord.match(/^([A-G]#?|[A-G]b?)/)
  return match ? match[1] : chord
}

function getEffectiveSongKey(song: any): string {
  const explicitKey = typeof song?.key === 'string' ? song.key.trim() : ''
  if (explicitKey) return explicitKey
  const content = typeof song?.content === 'string' ? song.content : ''
  const chordMatch = content.match(/\[([^\]]+)\]/)
  if (chordMatch) return getChordRoot(chordMatch[1])
  return 'C'
}

function parseSongSections(content: string): SongSection[] {
  const lines = content.split(/\r?\n/)
  const sections: SongSection[] = []
  let currentLabel = 'Full Song'
  let currentLines: string[] = []
  let foundAnyHeader = false

  const flush = (label: string) => {
    const body = currentLines.join('\n').trim()
    if (body) {
      sections.push({
        id: `${sections.length}-${label.toLowerCase().replace(/\s+/g, '-')}`,
        label,
        content: body,
      })
    }
    currentLines = []
  }

  for (const line of lines) {
    const trimmed = line.trim()
    if (isSectionHeaderLine(trimmed)) {
      const label = normalizeSectionLabel(trimmed, sections.length)
      if (currentLines.length > 0 || sections.length === 0) flush(currentLabel)
      currentLabel = label
      foundAnyHeader = true
      continue
    }
    currentLines.push(line)
  }

  flush(currentLabel)
  if (!foundAnyHeader) {
    return [{ id: 'full-song', label: 'Full Song', content: content.trim() }]
  }
  return sections.length > 0
    ? sections
    : [{ id: 'full-song', label: 'Full Song', content: content.trim() }]
}

/**
 * Pull every [chord] token out of a line, in order.
 *
 * The token is returned exactly as authored - root, quality ("m", "maj",
 * "min", "sus", "dim", "aug", "add"), extensions ("7", "9", "11", "13") and
 * slash bass ("/G") are all preserved. Only the brackets and the surrounding
 * lyric text are removed.
 *
 * "[Am7]Amazing [G/B]grace" -> ["Am7", "G/B"]
 * "[C]/[E]"                 -> ["C/E"]
 */
function extractChordTokens(line: string): string[] {
  return [...line
    // Collapse a bracketed slash chord, e.g. "[C]/[E]", into one token
    .replace(/\[([^\]]+)\]\s*\/\s*\[([^\]]+)\]/g, '[$1/$2]')
    .matchAll(/\[([^\]]+)\]/g)]
    .map(m => m[1].trim())
    .filter(Boolean)
}

// Not a component, so it cannot hold the theme hook - SongPage, which does,
// hands its themed stylesheet down instead.
function renderSongLines(
  content: string,
  mode: 'lyrics' | 'chords' | 'both',
  fontSize: number,
  s: ReturnType<typeof makeStyles>,
) {
  const lines = content.split(/\r?\n/)
  const rendered: React.ReactNode[] = []

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index]
    const trimmed = rawLine.trim()

    if (!trimmed) {
      rendered.push(<View key={`blank-${index}`} style={{ height: 12 }} />)
      continue
    }

    if (isSectionHeaderLine(trimmed)) {
      rendered.push(
        <Text
          key={`section-${index}`}
          numberOfLines={1}
          style={[s.sectionLine, { fontSize: fontSize + 1, lineHeight: (fontSize + 1) * 1.7 }]}
        >
          {trimmed}
        </Text>
      )
      continue
    }

    let lineToRender = rawLine
    if (mode === 'lyrics') {
      lineToRender = rawLine.replace(/\[([^\]]+)\]/g, '').trim()
    } else if (mode === 'chords') {
      if (!/\[[^\]]+\]/.test(rawLine)) continue
      // Keep each chord token exactly as written - quality, extensions and
      // slash bass all intact - and drop the surrounding lyric text without
      // filtering out suffix characters like "m", "maj", "sus" or "add".
      lineToRender = extractChordTokens(rawLine).join('  ')
      if (!lineToRender) continue
    } else if (mode === 'both') {
      lineToRender = rawLine.replace(/\[([^\]]+)\]/g, '$1').trim()
    }

    if (lineToRender.trim()) {
      rendered.push(
        <Text
          key={`line-${index}`}
          numberOfLines={1}
          style={[s.contentLine, { fontSize, lineHeight: fontSize * 1.7 }]}
        >
          {lineToRender}
        </Text>
      )
    }
  }

  return rendered
}

// Speed presets in px/s
const SCROLL_SPEEDS = [
  { label: '0.5×', value: 10 },
  { label: '1×',   value: 20 },
  { label: '1.5×', value: 32 },
  { label: '2×',   value: 45 },
  { label: '3×',   value: 70 },
  { label: '4×',   value: 100 },
]

// ─── Per-song content viewer ──────────────────────────────────────────────────

interface SongPageProps {
  song: any
  index: number
  transposeKey: string
  notationMode: 'chords' | 'nashville'
  viewMode: 'lyrics' | 'chords' | 'both'
  fontSize: number
  isActive: boolean
  scrollSpeedIndex: number
  isAutoScrolling: boolean
  onAutoScrollEnd: () => void
  /** Called once when the user (or auto-scroll) reaches the bottom of this page */
}

function SongPage({
  song,
  index,
  transposeKey,
  notationMode,
  viewMode,
  fontSize,
  isActive,
  scrollSpeedIndex,
  isAutoScrolling,
  onAutoScrollEnd,
}: SongPageProps) {
  const { colors: c } = useAppTheme()
  const s = useMemo(() => makeStyles(c), [c])
  const contentScrollRef    = useRef<ScrollView | null>(null)
  const scrollYRef          = useRef(0)
  const contentHeightRef    = useRef(0)
  const scrollViewHeightRef = useRef(0)
  const autoScrollRef       = useRef<ReturnType<typeof setInterval> | null>(null)
  const isTouchingRef       = useRef(false)

  const displayContent = useMemo(() => {
    if (!song?.content) return ''
    const originalKey = getEffectiveSongKey(song)
    let content = song.content || ''
    if (notationMode === 'nashville') {
      content = transposeTextToNashville(content, originalKey)
    } else {
      const semitones = getTransposeDistance(originalKey, transposeKey)
      if (semitones !== 0 || hasNashville(content)) {
        content = transposeText(song.content, semitones, transposeKey)
      }
    }
    return content
  }, [song, transposeKey, notationMode])

  const parsedSections = useMemo(() => parseSongSections(displayContent), [displayContent])
  const [activeSectionId, setActiveSectionId] = useState<string | null>(null)
  const [focusedSectionId, setFocusedSectionId] = useState<string | null>(null)

  const visibleSections = useMemo(() => {
    if (!focusedSectionId) return parsedSections
    return parsedSections.filter(section => section.id === focusedSectionId)
  }, [focusedSectionId, parsedSections])

  useEffect(() => {
    setActiveSectionId(parsedSections[0]?.id ?? null)
    setFocusedSectionId(null)
  }, [parsedSections])

  const scrollToSection = (sectionId: string) => {
    setActiveSectionId(sectionId)
    setFocusedSectionId(sectionId)
    scrollYRef.current = 0
    contentScrollRef.current?.scrollTo({ y: 0, animated: true })
  }

  const showAllSections = () => {
    setFocusedSectionId(null)
    setActiveSectionId(parsedSections[0]?.id ?? null)
    scrollYRef.current = 0
    contentScrollRef.current?.scrollTo({ y: 0, animated: true })
  }

  // Reset scroll position whenever content changes
  useEffect(() => {
    contentScrollRef.current?.scrollTo({ y: 0, animated: false })
    scrollYRef.current = 0
  }, [displayContent])

  // Track the sizes the auto-scroll engine needs to know when it hits the end
  const handleContentSizeChange = useCallback((_: number, h: number) => {
    contentHeightRef.current = h
  }, [])

  const handleLayout = useCallback((e: any) => {
    scrollViewHeightRef.current = e.nativeEvent.layout.height
  }, [])

  // Auto-scroll engine
  useEffect(() => {
    if (!isActive || !isAutoScrolling) {
      if (autoScrollRef.current) { clearInterval(autoScrollRef.current); autoScrollRef.current = null }
      return
    }
    if (autoScrollRef.current) clearInterval(autoScrollRef.current)

    const speed = SCROLL_SPEEDS[scrollSpeedIndex].value
    const TICK = 16
    const pixelsPerTick = (speed * TICK) / 1000

    autoScrollRef.current = setInterval(() => {
      if (isTouchingRef.current) return

      const maxScroll = contentHeightRef.current - scrollViewHeightRef.current
      if (scrollYRef.current >= maxScroll - 1) {
        clearInterval(autoScrollRef.current!)
        autoScrollRef.current = null
        onAutoScrollEnd()
        return
      }
      scrollYRef.current = Math.min(scrollYRef.current + pixelsPerTick, maxScroll)
      contentScrollRef.current?.scrollTo({ y: scrollYRef.current, animated: false })
    }, TICK)

    return () => {
      if (autoScrollRef.current) { clearInterval(autoScrollRef.current); autoScrollRef.current = null }
    }
  }, [isActive, isAutoScrolling, scrollSpeedIndex])

  const handleContentScroll = useCallback((e: any) => {
    scrollYRef.current = e.nativeEvent.contentOffset.y
  }, [])

  const handleScrollEndDrag = useCallback((e: any) => {
    isTouchingRef.current = false
    scrollYRef.current = e.nativeEvent.contentOffset.y
  }, [])

  const handleScrollBeginDrag = useCallback(() => {
    isTouchingRef.current = true
  }, [])

  return (
    <View style={{ width: SCREEN_WIDTH, flex: 1 }}>
      <ScrollView
        ref={contentScrollRef}
        style={s.contentScroll}
        contentContainerStyle={s.contentPad}
        showsVerticalScrollIndicator={false}
        scrollEventThrottle={16}
        onScroll={handleContentScroll}
        onScrollBeginDrag={handleScrollBeginDrag}
        onScrollEndDrag={handleScrollEndDrag}
        onMomentumScrollEnd={handleScrollEndDrag}
        onContentSizeChange={handleContentSizeChange}
        onLayout={handleLayout}
      >
        {parsedSections.length > 1 && (
          <View style={s.sectionNavBar}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.sectionNavContent}>
              <TouchableOpacity
                style={[s.sectionPill, !focusedSectionId && s.sectionPillActive]}
                onPress={showAllSections}
                activeOpacity={0.7}
              >
                <View style={[s.sectionPillIdx, !focusedSectionId && s.sectionPillIdxActive]}>
                  <Text style={[s.sectionPillIdxText, !focusedSectionId && s.sectionPillIdxTextActive]}>A</Text>
                </View>
                <Text style={[s.sectionPillText, !focusedSectionId && s.sectionPillTextActive]} numberOfLines={1}>
                  All
                </Text>
              </TouchableOpacity>
              {parsedSections.map((section, idx) => {
                const isActivePill = section.id === activeSectionId
                return (
                  <TouchableOpacity
                    key={section.id}
                    style={[s.sectionPill, isActivePill && s.sectionPillActive]}
                    onPress={() => scrollToSection(section.id)}
                    activeOpacity={0.7}
                  >
                    <View style={[s.sectionPillIdx, isActivePill && s.sectionPillIdxActive]}>
                      <Text style={[s.sectionPillIdxText, isActivePill && s.sectionPillIdxTextActive]}>{idx + 1}</Text>
                    </View>
                    <Text style={[s.sectionPillText, isActivePill && s.sectionPillTextActive]} numberOfLines={1}>
                      {section.label}
                    </Text>
                  </TouchableOpacity>
                )
              })}
            </ScrollView>
          </View>
        )}

        <View style={s.songBody}>
          {visibleSections.map(section => (
            <View key={section.id} style={s.sectionBlock}>
              <View style={s.sectionBadge}>
                <Text style={s.sectionBadgeText}>{section.label}</Text>
              </View>
              <View style={s.sectionContentBlock}>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={s.hScrollContent}
                >
                  <View style={s.linesColumn}>
                    {renderSongLines(section.content, viewMode, fontSize, s)}
                  </View>
                </ScrollView>
              </View>
            </View>
          ))}
        </View>

        <View style={{ height: 60 }} />
      </ScrollView>
    </View>
  )
}

// ─── Main modal ───────────────────────────────────────────────────────────────

interface SongViewerProps {
  visible: boolean
  songs: any[]
  startIndex: number
  onClose: () => void
}

export function PlaylistSongViewerModal({ visible, songs, startIndex, onClose }: SongViewerProps) {
  const { colors: c } = useAppTheme()
  const s = useMemo(() => makeStyles(c), [c])
  // Nobody taps the screen while they are playing - and with auto-scroll on,
  // nobody touches it at all. Hold it open for as long as the chart is up.
  useKeepScreenAwake(visible, 'song-viewer')

  const scrollRef = useRef<any>(null)
  const [currentIndex, setCurrentIndex]   = useState(0)
  const [transposeKeys, setTransposeKeys] = useState<string[]>([])
  const [notationMode, setNotationMode]   = useState<'chords' | 'nashville'>('chords')
  const [viewMode, setViewMode]           = useState<'lyrics' | 'chords' | 'both'>('both')
  const [fontSize, setFontSize]           = useState(15)
  const [showTransposePicker, setShowTransposePicker] = useState(false)
  const [isAutoScrolling, setIsAutoScrolling]         = useState(false)
  const [scrollSpeedIndex, setScrollSpeedIndex]       = useState(1)
  const scrollFadeAnim = useRef(new Animated.Value(0)).current

  const currentIndexRef = useRef(0)
  currentIndexRef.current = currentIndex

  useEffect(() => {
    if (!visible || songs.length === 0) return
    const init = async () => {
      try {
        const stored = await AsyncStorage.getItem(`transpose_keys`)
        if (stored) {
          const parsed: Record<string, string> = JSON.parse(stored)
          setTransposeKeys(songs.map(s => parsed[s.id] ?? getEffectiveSongKey(s)))
        } else {
          setTransposeKeys(songs.map(getEffectiveSongKey))
        }
      } catch {
        setTransposeKeys(songs.map(getEffectiveSongKey))
      }
      setCurrentIndex(startIndex)
      setNotationMode('chords')
      setViewMode('both')
      setIsAutoScrolling(false)
      setTimeout(() => {
        scrollRef.current?.scrollTo({ x: startIndex * SCREEN_WIDTH, animated: false })
      }, 50)
    }
    void init()
  }, [visible, songs, startIndex])

  useEffect(() => {
    setIsAutoScrolling(false)
  }, [viewMode, notationMode])

  useEffect(() => { setIsAutoScrolling(false) }, [currentIndex])

  const handleScroll = (e: any) => {
    const index = Math.round(e.nativeEvent.contentOffset.x / SCREEN_WIDTH)
    if (index !== currentIndexRef.current) {
      setCurrentIndex(index)
      setIsAutoScrolling(false)
    }
  }

  const updateTransposeKey = async (index: number, key: string) => {
    const song = songs[index]
    if (!song) return
    setTransposeKeys(prev => {
      const next = [...prev]
      next[index] = key
      return next
    })
    try {
      const stored = await AsyncStorage.getItem(`transpose_keys`)
      const parsed: Record<string, string> = stored ? JSON.parse(stored) : {}
      parsed[song.id] = key
      await AsyncStorage.setItem(`transpose_keys`, JSON.stringify(parsed))
    } catch (err) {
      console.error('Failed to persist transpose key', err)
    }
  }

  const toggleAutoScroll = () => {
    const next = !isAutoScrolling
    setIsAutoScrolling(next)
    Animated.timing(scrollFadeAnim, { toValue: next ? 1 : 0, duration: 200, useNativeDriver: true }).start()
  }

  const handleAutoScrollEnd = useCallback(() => {
    const cur = currentIndexRef.current
    if (cur < songs.length - 1) {
      const next = cur + 1
      scrollRef.current?.scrollTo({ x: next * SCREEN_WIDTH, animated: true })
      setCurrentIndex(next)
      setTimeout(() => {
        setIsAutoScrolling(true)
        Animated.timing(scrollFadeAnim, { toValue: 1, duration: 200, useNativeDriver: true }).start()
      }, 1200)
    } else {
      setIsAutoScrolling(false)
      Animated.timing(scrollFadeAnim, { toValue: 0, duration: 200, useNativeDriver: true }).start()
    }
  }, [songs.length])

  const currentSong  = songs[currentIndex]
  const originalKey  = getEffectiveSongKey(currentSong)
  const targetKey    = transposeKeys[currentIndex] || originalKey
  const isTransposed = originalKey !== targetKey

  // Whether there's a next song and it's still locked

  if (!visible) return null

  return (
    <Modal visible={visible} animationType="slide" statusBarTranslucent>
      <StatusBar barStyle={c.statusBar === 'light' ? 'light-content' : 'dark-content'} backgroundColor={c.header} />
      <View style={s.root}>

        {/* ── TOP HEADER ── */}
        <View style={s.header}>
          <TouchableOpacity
            onPress={onClose} style={s.iconBtn}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Ionicons name="chevron-down" size={24} color={c.text} />
          </TouchableOpacity>

          <View style={s.headerCenter}>
            <Text style={s.songCounter}>{currentIndex + 1} / {songs.length}</Text>
            <Text style={s.songTitle} numberOfLines={1}>{currentSong?.title ?? ''}</Text>
            {currentSong?.artist ? (
              <Text style={s.songArtist} numberOfLines={1}>{currentSong.artist}</Text>
            ) : null}
          </View>

          <View style={s.headerRight}>
            <TouchableOpacity style={s.fontBtn} onPress={() => setFontSize(f => Math.max(11, f - 1))}>
              <Text style={s.fontBtnText}>A−</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.fontBtn} onPress={() => setFontSize(f => Math.min(24, f + 1))}>
              <Text style={s.fontBtnTextLg}>A+</Text>
            </TouchableOpacity>
          </View>
        </View>

        <View style={s.hairline} />

        {/* ── CONTROLS ROW ── */}
        <View style={s.controlsRow}>
          <View style={s.modeBar}>
            {(['lyrics', 'chords', 'both'] as const).map(mode => (
              <TouchableOpacity
                key={mode}
                style={[s.modeTab, viewMode === mode && s.modeTabActive]}
                onPress={() => setViewMode(mode)}
                activeOpacity={0.7}
              >
                <Text style={[s.modeTabText, viewMode === mode && s.modeTabTextActive]}>
                  {mode === 'both' ? 'Both' : mode === 'chords' ? 'Chords' : 'Lyrics'}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
          {notationMode === 'chords' ? (
            <TouchableOpacity
              style={s.transposeChip}
              onPress={() => setShowTransposePicker(true)}
              activeOpacity={0.75}
            >
              <Ionicons name="musical-notes" size={11} color={c.text} style={{ marginRight: 5 }} />
              <Text style={s.transposeChipText}>
                {originalKey}{isTransposed ? ` → ${targetKey}` : ''}
              </Text>
              <Ionicons name="chevron-down" size={10} color={c.text} style={{ marginLeft: 3 }} />
            </TouchableOpacity>
          ) : (
            <View style={{ width: 120 }} />
          )}
        </View>

        <View style={s.notationRow}>
          <Text style={s.notationLabel}>Notation</Text>
          <View style={s.notationBar}>
            {(['chords', 'nashville'] as const).map(mode => (
              <TouchableOpacity
                key={mode}
                style={[s.modeTab, notationMode === mode && s.modeTabActive]}
                onPress={() => setNotationMode(mode)}
                activeOpacity={0.7}
              >
                <Text style={[s.modeTabText, notationMode === mode && s.modeTabTextActive]}>
                  {mode === 'chords' ? 'Chords' : 'Nashville'}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* ── AUTO-SCROLL BAR ── */}
        <View style={s.autoScrollBar}>
          <TouchableOpacity
            style={[s.autoScrollToggle, isAutoScrolling && s.autoScrollToggleActive]}
            onPress={toggleAutoScroll}
            activeOpacity={0.75}
          >
            <Ionicons
              name={isAutoScrolling ? 'pause' : 'play'}
              size={13}
              color={isAutoScrolling ? c.accentText : c.text}
            />
            <Text style={[s.autoScrollToggleText, isAutoScrolling && s.autoScrollToggleTextActive]}>
              {isAutoScrolling ? 'Pause' : 'Scroll'}
            </Text>
          </TouchableOpacity>

          <View style={s.autoScrollDivider} />

          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={s.speedList}
          >
            {SCROLL_SPEEDS.map((sp, i) => (
              <TouchableOpacity
                key={sp.label}
                style={[s.speedChip, scrollSpeedIndex === i && s.speedChipActive]}
                onPress={() => setScrollSpeedIndex(i)}
                activeOpacity={0.7}
              >
                <Text style={[s.speedChipText, scrollSpeedIndex === i && s.speedChipTextActive]}>
                  {sp.label}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>

        {isAutoScrolling && (
          <View style={s.scrollHintBar}>
            <Ionicons name="hand-left-outline" size={10} color={c.textSub} />
            <Text style={s.scrollHintText}>Scroll freely — auto-scroll resumes when you release</Text>
          </View>
        )}

        {/* ── SONG PAGES ── */}
        {/* Still paged horizontally, but only the PREV/NEXT buttons move
            between songs - swiping is off so it can't fire while reading. */}
        <HorizontalScroll
          ref={scrollRef}
          horizontal
          pagingEnabled
          scrollEnabled={false}
          showsHorizontalScrollIndicator={false}
          onMomentumScrollEnd={handleScroll}
          style={{ flex: 1 }}
          scrollEventThrottle={16}
        >
          {songs.map((song, index) => (
            <SongPage
              key={song.id ?? index}
              song={song}
              index={index}
              transposeKey={transposeKeys[index] || song.key || 'C'}
              notationMode={notationMode}
              viewMode={viewMode}
              fontSize={fontSize}
              isActive={index === currentIndex}
              scrollSpeedIndex={scrollSpeedIndex}
              isAutoScrolling={isAutoScrolling && index === currentIndex}
              onAutoScrollEnd={handleAutoScrollEnd}
            />
          ))}
        </HorizontalScroll>

        {/* ── BOTTOM BAR ── */}
        <View style={s.bottomBar}>
          {songs.length > 1 && (
            <View style={s.dots}>
              {songs.map((_, i) => (
                <View key={i} style={[s.dot, i === currentIndex && s.dotActive]} />
              ))}
            </View>
          )}
          {songs.length > 1 && (
            <View style={s.navRow}>
              <TouchableOpacity
                style={[s.navBtn, currentIndex === 0 && s.navBtnDisabled]}
                onPress={() => {
                  if (currentIndex > 0) {
                    const next = currentIndex - 1
                    scrollRef.current?.scrollTo({ x: next * SCREEN_WIDTH, animated: true })
                    setCurrentIndex(next)
                  }
                }}
                disabled={currentIndex === 0}
              >
                <Ionicons name="chevron-back" size={18} color={c.text} />
                <Text style={[s.navBtnText, currentIndex === 0 && s.navBtnTextDisabled]}>PREV</Text>
              </TouchableOpacity>

              <Text style={s.navCounter}>{currentIndex + 1} / {songs.length}</Text>

              <TouchableOpacity
                style={[s.navBtn, currentIndex === songs.length - 1 && s.navBtnDisabled]}
                onPress={() => {
                  if (currentIndex < songs.length - 1) {
                    const next = currentIndex + 1
                    scrollRef.current?.scrollTo({ x: next * SCREEN_WIDTH, animated: true })
                    setCurrentIndex(next)
                  }
                }}
                disabled={currentIndex === songs.length - 1}
              >
                <Text style={[
                  s.navBtnText,
                  currentIndex === songs.length - 1 && s.navBtnTextDisabled,
                ]}>NEXT</Text>
                <Ionicons
                  name="chevron-forward"
                  size={18}
                  color={c.text}
                />
              </TouchableOpacity>
            </View>
          )}
        </View>

      </View>

      {/* ── TRANSPOSE MODAL ── */}
      <Modal visible={showTransposePicker} transparent animationType="slide">
        <View style={s.modalOverlay}>
          <View style={s.modalSheet}>
            <View style={s.modalHandle} />
            <View style={s.modalHead}>
              <TouchableOpacity onPress={() => setShowTransposePicker(false)}>
                <Text style={s.modalCancel}>Cancel</Text>
              </TouchableOpacity>
              <Text style={s.modalTitle}>Transpose Key</Text>
              <TouchableOpacity onPress={() => setShowTransposePicker(false)}>
                <Text style={s.modalDone}>Done</Text>
              </TouchableOpacity>
            </View>
            <View style={s.transposeInfo}>
              <Text style={s.transposeInfoText}>
                {`Original: ${originalKey}   →   Target: ${targetKey}`}
              </Text>
            </View>
            <View style={s.keyGrid}>
              {getAllKeys().map(key => (
                <TouchableOpacity
                  key={key}
                  style={[s.keyCell, isSameKey(targetKey, key) && s.keyCellActive]}
                  onPress={() => updateTransposeKey(currentIndex, key)}
                  activeOpacity={0.7}
                >
                  <Text style={[s.keyCellText, isSameKey(targetKey, key) && s.keyCellTextActive]}>{key}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        </View>
      </Modal>
    </Modal>
  )
}

const makeStyles = (c: AppColors) => StyleSheet.create({
  // The chart is read at arm's length on a stage, so the whole sheet follows
  // the theme's page colours rather than sitting on the accent. Text on a
  // saturated accent is what made the smaller controls unreadable.
  root: { flex: 1, backgroundColor: c.bg },

  // Header
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingTop: Platform.OS === 'ios' ? 58 : 40,
    paddingBottom: 14, paddingHorizontal: 20, backgroundColor: c.header,
  },
  iconBtn: { width: 40, height: 40, justifyContent: 'center', alignItems: 'flex-start' },
  headerCenter: { flex: 1, alignItems: 'center', paddingHorizontal: 8 },
  songCounter: {
    fontSize: 10, letterSpacing: 2.5, color: c.textSub,
    fontWeight: '600', marginBottom: 5, textTransform: 'uppercase',
  },
  songTitle: { fontSize: 18, fontWeight: '700', color: c.text, letterSpacing: 0.3, textAlign: 'center' },
  songArtist: { fontSize: 12, color: c.textSub, marginTop: 3, letterSpacing: 1, textTransform: 'uppercase' },
  headerRight: { width: 72, flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 6 },
  fontBtn: { padding: 4 },
  fontBtnText: { color: c.text, fontSize: 12, fontWeight: '700', letterSpacing: 0.5 },
  fontBtnTextLg: { color: c.text, fontSize: 14, fontWeight: '700', letterSpacing: 0.5 },

  hairline: { height: StyleSheet.hairlineWidth, backgroundColor: c.hairline, marginHorizontal: 20 },

  // Controls row
  controlsRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 14, paddingVertical: 10, gap: 8,
    backgroundColor: c.header,
  },
  notationRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 14, gap: 8,
    paddingBottom: 8,
    backgroundColor: c.header,
  },
  notationLabel: { fontSize: 10, color: c.textSub, fontWeight: '700', letterSpacing: 1, textTransform: 'uppercase' },
  notationBar: {
    flex: 1, flexDirection: 'row',
    borderWidth: 1, borderColor: c.border,
    borderRadius: 6, overflow: 'hidden',
    backgroundColor: c.surfaceAlt,
  },
  modeBar: {
    flex: 1, flexDirection: 'row',
    borderWidth: 1, borderColor: c.border,
    borderRadius: 6, overflow: 'hidden',
    backgroundColor: c.surfaceAlt,
  },
  // Selected reads as an accent block, unselected as plain text on the bar.
  // Before, both states were the same colour and nothing showed which was on.
  modeTab: { flex: 1, paddingVertical: 8, alignItems: 'center', backgroundColor: 'transparent' },
  modeTabActive: { backgroundColor: c.accent },
  modeTabText: {
    fontSize: 10, fontWeight: '700', letterSpacing: 1,
    color: c.textSub, textTransform: 'uppercase',
  },
  modeTabTextActive: { color: c.accentText },
  transposeChip: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: c.surface,
    borderRadius: 8, paddingHorizontal: 10, paddingVertical: 7,
    borderWidth: 1, borderColor: c.border,
  },
  transposeChipText: { fontSize: 12, fontWeight: '700', color: c.text, letterSpacing: 0.3 },

  // Auto-scroll bar
  autoScrollBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: c.header,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: c.hairline,
    gap: 0,
  },
  autoScrollToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 8,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
  },
  autoScrollToggleActive: { backgroundColor: c.accent, borderColor: c.accent },
  autoScrollToggleText: { fontSize: 11, fontWeight: '700', letterSpacing: 0.5, color: c.text },
  autoScrollToggleTextActive: { color: c.accentText },
  autoScrollDivider: { width: 1, height: 20, backgroundColor: c.border, marginHorizontal: 10 },
  speedList: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingRight: 8 },
  speedChip: {
    paddingHorizontal: 11, paddingVertical: 6, borderRadius: 20,
    backgroundColor: c.surface,
    borderWidth: 1, borderColor: c.border,
  },
  speedChipActive: { backgroundColor: c.accent, borderColor: c.accent },
  speedChipText: { fontSize: 11, fontWeight: '700', color: c.text },
  speedChipTextActive: { color: c.accentText },

  scrollHintBar: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 14, paddingBottom: 6, backgroundColor: c.header,
  },
  scrollHintText: { fontSize: 10, color: c.textSub, fontStyle: 'italic' },

  // Song header inside content
  songHeaderBlock: { marginBottom: 18, gap: 8 },
  songHeaderTitle: { fontWeight: '800', color: c.text, letterSpacing: -0.5, lineHeight: 28 },
  keyBadgeInline: {
    alignSelf: 'flex-start', backgroundColor: c.accent,
    borderRadius: 6, paddingHorizontal: 10, paddingVertical: 4,
  },
  keyBadgeInlineText: { fontSize: 11, fontWeight: '700', color: c.accentText, letterSpacing: 0.5 },

  sectionNavBar: {
    backgroundColor: c.header,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: c.hairline,
    paddingVertical: 8,
  },
  sectionNavContent: { paddingHorizontal: 14, gap: 6, flexDirection: 'row', alignItems: 'center' },
  sectionPill: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 10, paddingVertical: 6, borderRadius: 20,
    backgroundColor: c.surface,
    borderWidth: 1, borderColor: c.border, gap: 5,
  },
  sectionPillActive: { backgroundColor: c.accent, borderColor: c.accent },
  sectionPillIdx: {
    width: 15, height: 15, borderRadius: 8,
    backgroundColor: c.surfaceMuted,
    alignItems: 'center', justifyContent: 'center',
  },
  // On the selected pill the little number sits on the accent, so it takes
  // the accent's own text colour back to stay legible against it.
  sectionPillIdxActive: { backgroundColor: c.accentText },
  sectionPillIdxText: { fontSize: 8, fontWeight: '800', color: c.text },
  sectionPillIdxTextActive: { color: c.accent },
  sectionPillText: { fontSize: 11, fontWeight: '700', color: c.text, maxWidth: 80 },
  sectionPillTextActive: { color: c.accentText },

  contentScroll: { flex: 1, backgroundColor: c.bg },
  contentPad: { paddingHorizontal: 20, paddingTop: 0, paddingBottom: 48 },
  songBody: { paddingTop: 4 },
  content: {
    color: c.text,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
    fontWeight: '400', letterSpacing: 0.2,
  },
  contentLine: { fontSize: 15, lineHeight: 26, color: c.text, fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace', letterSpacing: 0.2 },
  sectionLine: { fontSize: 15, lineHeight: 26, color: c.accent, fontWeight: '800', fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace', letterSpacing: 0.2 },
  sectionBlock: {
    gap: 8,
    paddingBottom: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: c.hairline,
    marginBottom: 14,
  },
  sectionBadge: {
    alignSelf: 'flex-start',
    backgroundColor: c.surfaceMuted,
    borderRadius: 6, paddingHorizontal: 9, paddingVertical: 4,
    borderWidth: 1, borderColor: c.border,
  },
  sectionBadgeText: { fontSize: 10, fontWeight: '800', color: c.text, letterSpacing: 0.5 },
  sectionContentBlock: { gap: 0 },
  hScrollContent: { flexGrow: 1 },
  linesColumn: { alignItems: 'flex-start' },

  // Bottom bar
  bottomBar: {
    backgroundColor: c.header,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: c.hairline,
    paddingBottom: Platform.OS === 'ios' ? 34 : 16, paddingTop: 12,
  },
  dots: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 5, marginBottom: 12 },
  dot: { width: 5, height: 5, borderRadius: 2.5, backgroundColor: c.border },
  dotActive: { backgroundColor: c.accent, width: 20, borderRadius: 2.5 },
  navRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 24 },
  navBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 6, paddingHorizontal: 4 },
  navBtnDisabled: { opacity: 0.3 },
  navBtnText: { fontSize: 11, fontWeight: '800', letterSpacing: 1.5, color: c.text },
  navBtnTextDisabled: { color: c.textMuted },
  navCounter: { fontSize: 10, letterSpacing: 1.5, color: c.textSub, fontWeight: '700' },

  // Transpose modal
  modalOverlay: { flex: 1, backgroundColor: c.overlay, justifyContent: 'flex-end' },
  modalSheet: { backgroundColor: c.surface, borderTopLeftRadius: 26, borderTopRightRadius: 26, paddingBottom: 36 },
  modalHandle: { width: 36, height: 4, borderRadius: 2, backgroundColor: c.border, alignSelf: 'center', marginTop: 12, marginBottom: 4 },
  modalHead: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 20, paddingVertical: 15,
    borderBottomWidth: 1, borderBottomColor: c.hairline,
  },
  modalTitle: { fontSize: 15, fontWeight: '800', color: c.text, letterSpacing: -0.3 },
  modalCancel: { fontSize: 14, color: c.textSub, fontWeight: '500', minWidth: 54 },
  modalDone: { fontSize: 14, fontWeight: '700', color: c.accent, minWidth: 54, textAlign: 'right' },
  transposeInfo: {
    paddingHorizontal: 20, paddingVertical: 14,
    borderBottomWidth: 1, borderBottomColor: c.hairline, alignItems: 'center',
  },
  transposeInfoText: { fontSize: 13, color: c.textSub, fontWeight: '500' },
  keyGrid: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 16, paddingVertical: 16, gap: 8 },
  keyCell: {
    width: '22%', paddingVertical: 13, borderRadius: 12, alignItems: 'center',
    backgroundColor: c.surfaceAlt, borderWidth: 1, borderColor: c.border,
  },
  keyCellActive: { backgroundColor: c.accent, borderColor: c.accent },
  keyCellText: { fontSize: 14, fontWeight: '700', color: c.text },
  keyCellTextActive: { color: c.accentText },
})
