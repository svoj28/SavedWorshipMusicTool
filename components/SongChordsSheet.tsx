// components/SongChordsSheet.tsx
//
// Every chord in the song you are looking at, drawn as a fingering.
//
// The chords are read from the words on screen, so they follow whatever key
// the song has been transposed into - shift a song up to Bb and the shapes
// shift with it, which is the whole point. They stay in the order the song
// plays them, because the chords it opens with are the ones you need first.
//
// Where a chord has no standard shape - a diminished, an altered voicing - it
// is listed and said so, rather than drawn wrongly. A confident wrong
// fingering is worse than an honest gap, particularly for anyone still
// learning the instrument.

import React, { useMemo, useState } from 'react'
import {
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from 'react-native'
import { useAppTheme, type AppColors } from '../lib/theme'
import Svg, { Circle, Line, Rect, Text as SvgText } from 'react-native-svg'
import Ionicons from '@expo/vector-icons/Ionicons'
import { ChordShape, chordsInSong, findChordShape, suggestCapo } from '../lib/chordShapes'
import { transposeChord } from '../lib/transpose'

interface Props {
  visible: boolean
  /** The song as displayed - already transposed, so the shapes match */
  content: string
  /** The key it is currently in, used to work out where a capo would help */
  songKey?: string
  onClose: () => void
}

/** How many fret rows a diagram shows. Five covers every shape we produce. */
const FRET_ROWS = 5
const STRING_COUNT = 6

/** One chord box: strings down, frets across, dots where the fingers go. */
function ChordDiagram({ chord, shape, size }: { chord: string; shape: ChordShape; size: number }) {
  const { colors: c } = useAppTheme()
  const styles = useMemo(() => makeStyles(c), [c])

  const boxW = size * 0.62
  const boxH = size * 0.66
  const padX = (size - boxW) / 2
  const padY = size * 0.26

  const stringGap = boxW / (STRING_COUNT - 1)
  const fretGap = boxH / FRET_ROWS

  const held = shape.frets.filter(f => f > 0)
  const lowest = held.length ? Math.min.apply(null, held) : 0
  const highest = held.length ? Math.max.apply(null, held) : 0

  // Start at the nut when the whole shape fits there; otherwise slide the
  // window up the neck and label which fret it starts on.
  const baseFret = highest <= FRET_ROWS ? 1 : lowest
  const showNut = baseFret === 1

  const x = (stringIndex: number) => padX + stringIndex * stringGap
  const rowCentreY = (row: number) => padY + (row - 0.5) * fretGap

  const fretLines = []
  for (let f = 0; f <= FRET_ROWS; f += 1) fretLines.push(f)

  const stringLines = []
  for (let s = 0; s < STRING_COUNT; s += 1) stringLines.push(s)

  return (
    <View style={{ width: size, alignItems: 'center' }}>
      <Svg width={size} height={size * 1.02}>
        {fretLines.map(f => (
          <Line
            key={'f' + f}
            x1={padX}
            y1={padY + f * fretGap}
            x2={padX + boxW}
            y2={padY + f * fretGap}
            stroke={f === 0 && showNut ? c.text : c.iconInactive}
            strokeWidth={f === 0 && showNut ? 3.5 : 1}
          />
        ))}

        {stringLines.map(s => (
          <Line
            key={'s' + s}
            x1={x(s)}
            y1={padY}
            x2={x(s)}
            y2={padY + boxH}
            stroke={c.iconInactive}
            strokeWidth={1}
          />
        ))}

        {/* The fret this window starts at, when it is not the nut */}
        {!showNut && (
          <SvgText
            x={padX - 6}
            y={rowCentreY(1) + 3}
            fontSize={9}
            fontWeight="700"
            fill={c.textMuted}
            textAnchor="end"
          >
            {baseFret + 'fr'}
          </SvgText>
        )}

        {/* A barre is drawn as one bar rather than as separate dots */}
        {shape.barreFret !== undefined && shape.barreFret >= baseFret && (
          <Rect
            x={x(0) - 4}
            y={rowCentreY(shape.barreFret - baseFret + 1) - 4}
            width={boxW + 8}
            height={8}
            rx={4}
            fill={c.accent}
          />
        )}

        {shape.frets.map((fret, sIdx) => {
          const cx = x(sIdx)

          // Above the nut: × for a string not played, ○ for one played open
          if (fret <= 0) {
            return (
              <SvgText
                key={'m' + sIdx}
                x={cx}
                y={padY - 5}
                fontSize={10}
                fontWeight="700"
                fill={fret < 0 ? c.textMuted : c.accent}
                textAnchor="middle"
              >
                {fret < 0 ? '×' : '○'}
              </SvgText>
            )
          }

          const row = fret - baseFret + 1
          if (row < 1 || row > FRET_ROWS) return null

          return <Circle key={'d' + sIdx} cx={cx} cy={rowCentreY(row)} r={5.5} fill={c.accent} />
        })}
      </Svg>

      <Text style={styles.chordName} numberOfLines={1}>{chord}</Text>
    </View>
  )
}

export default function SongChordsSheet({ visible, content, songKey, onClose }: Props) {
  const { colors: c } = useAppTheme()
  const styles = useMemo(() => makeStyles(c), [c])

  const { width } = useWindowDimensions()

  // 0 means play it as written. Anything else redraws the shapes as the ones
  // your fingers actually make with the capo on - which is the point of a
  // capo, and the thing a player otherwise has to work out in their head.
  const [capo, setCapo] = useState(0)

  // Three across on a phone, more on anything wider, so the diagrams stay big
  // enough to read rather than shrinking to fit a fixed count.
  const columns = Math.max(3, Math.min(5, Math.floor(width / 118)))
  const size = (width - 32 - (columns - 1) * 10) / columns

  const chords = useMemo(() => (visible ? chordsInSong(content) : []), [visible, content])

  const capoOptions = useMemo(
    () => (visible && songKey ? suggestCapo(songKey) : []),
    [visible, songKey],
  )

  // With a capo at fret N, the shape you hold is N semitones below the chord
  // that sounds. The name under each diagram is that shape, not the sounding
  // chord - it is what you read off the page while playing.
  // The key those shapes are read in, which also decides how they are spelled:
  // capo 1 on an Eb song is a D shape, not a D# one, and a player reading
  // "D#" would have to translate it back before they could use it.
  const shapeKey = useMemo(
    () => capoOptions.find(o => o.capo === capo)?.shapeKey || '',
    [capoOptions, capo],
  )

  const drawable = useMemo(
    () =>
      chords.map(sounding => {
        const shapeName =
          capo > 0 ? transposeChord(sounding, -capo, shapeKey || undefined) || sounding : sounding
        return { chord: shapeName, sounding, shape: findChordShape(shapeName) }
      }),
    [chords, capo, shapeKey],
  )

  const known = drawable.filter(d => d.shape)
  const unknown = drawable.filter(d => !d.shape)

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          <View style={styles.handle} />

          <View style={styles.head}>
            <View style={{ flex: 1 }}>
              <Text style={styles.title}>Chords in this song</Text>
              <Text style={styles.subtitle}>
                {known.length === 0
                  ? 'No chords found in this song yet'
                  : capo > 0
                    ? known.length + ' shapes · capo ' + capo + ', sounding in ' + (songKey || 'the written key')
                    : known.length + (known.length === 1 ? ' shape' : ' shapes') + ' · in the key on screen'}
              </Text>
            </View>
            <TouchableOpacity style={styles.closeBtn} onPress={onClose} activeOpacity={0.7}>
              <Ionicons name="close" size={16} color={c.text} />
            </TouchableOpacity>
          </View>

          {/* Only offered when a capo actually buys something: a position
              that turns this key into open shapes. A song already in an easy
              key gets no suggestions, because it needs none. */}
          {capoOptions.length > 1 && (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.capoRow}
            >
              {capoOptions.map(option => {
                const on = capo === option.capo
                return (
                  <TouchableOpacity
                    key={option.capo}
                    style={[styles.capoChip, on && styles.capoChipOn]}
                    onPress={() => setCapo(option.capo)}
                    activeOpacity={0.75}
                  >
                    <Text style={[styles.capoChipText, on && styles.capoChipTextOn]}>
                      {option.capo === 0
                        ? 'No capo · ' + option.shapeKey
                        : 'Capo ' + option.capo + ' · play ' + option.shapeKey}
                    </Text>
                  </TouchableOpacity>
                )
              })}
            </ScrollView>
          )}

          <ScrollView contentContainerStyle={styles.grid} showsVerticalScrollIndicator={false}>
            {known.map(({ chord, shape }) => (
              <ChordDiagram key={chord} chord={chord} shape={shape as ChordShape} size={size} />
            ))}

            {chords.length === 0 && (
              <View style={styles.empty}>
                <Ionicons name="musical-notes-outline" size={22} color={c.iconInactive} />
                <Text style={styles.emptyText}>
                  This song has no chords written in it yet. Add chords like [G] and they will
                  appear here.
                </Text>
              </View>
            )}
          </ScrollView>

          {unknown.length > 0 && (
            <Text style={styles.footnote}>
              No standard shape to show for {unknown.map(u => u.chord).join(', ')} — these are
              voiced differently by every player, so nothing is drawn rather than something wrong.
            </Text>
          )}
        </View>
      </View>
    </Modal>
  )
}

const makeStyles = (c: AppColors) => StyleSheet.create({
  overlay: { flex: 1, backgroundColor: c.accent, justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: c.surface,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    paddingHorizontal: 16,
    paddingBottom: 26,
    maxHeight: '82%',
  },
  handle: {
    width: 38,
    height: 4,
    borderRadius: 2,
    backgroundColor: c.border,
    alignSelf: 'center',
    marginTop: 10,
    marginBottom: 14,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 14 },
  title: { fontSize: 16, fontWeight: '800', color: c.text, letterSpacing: -0.3 },
  subtitle: { fontSize: 11.5, fontWeight: '500', color: c.textMuted, marginTop: 2 },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: 10,
    backgroundColor: c.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },

  capoRow: { flexDirection: 'row', gap: 7, paddingBottom: 14, paddingRight: 8 },
  capoChip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 9,
    backgroundColor: c.surfaceAlt,
    borderWidth: 1,
    borderColor: c.hairline,
  },
  capoChipOn: { backgroundColor: c.accent, borderColor: c.accent },
  capoChipText: { fontSize: 12, fontWeight: '700', color: c.textSub },
  capoChipTextOn: { color: c.accentText },

  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, paddingBottom: 8 },
  chordName: {
    fontSize: 12.5,
    fontWeight: '700',
    color: c.text,
    marginTop: 2,
    textAlign: 'center',
  },

  empty: { alignItems: 'center', gap: 10, paddingVertical: 30, paddingHorizontal: 20 },
  emptyText: {
    fontSize: 12.5,
    fontWeight: '500',
    color: c.textMuted,
    textAlign: 'center',
    lineHeight: 18,
  },

  footnote: { fontSize: 11, fontWeight: '500', color: c.textMuted, lineHeight: 16, marginTop: 10 },
})
