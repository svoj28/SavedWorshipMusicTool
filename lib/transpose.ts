// lib/transpose.ts
//
// Single source of truth for chord parsing, transposition and Nashville
// conversion. Chord quality is never rewritten: "m", "maj", "major", "min",
// "sus", "dim", "aug", "add", extensions and slash bass notes are all carried
// through exactly as the user wrote them.

// Chromatic scale in both spellings. Index = pitch class (C = 0).
const SHARP_NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const FLAT_NOTES  = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B']

// Every spelling we accept as input, including the rarer enharmonics.
const NOTE_INDEX: Record<string, number> = {
  'C': 0,  'B#': 0,
  'C#': 1, 'Db': 1,
  'D': 2,
  'D#': 3, 'Eb': 3,
  'E': 4,  'Fb': 4,
  'F': 5,  'E#': 5,
  'F#': 6, 'Gb': 6,
  'G': 7,
  'G#': 8, 'Ab': 8,
  'A': 9,
  'A#': 10, 'Bb': 10,
  'B': 11, 'Cb': 11,
}

// Natural-letter minor keys whose key signature uses flats (Dm, Gm, Cm, Fm).
const FLAT_MINOR_LETTERS = new Set(['D', 'G', 'C', 'F'])

// The 12 keys in the spelling musicians actually read them in.
const KEY_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']

/** True when a chord/key name is minor (and not "maj"/"major"). */
function isMinorQuality(quality: string): boolean {
  return /^(?:min|m(?!aj))/i.test(quality)
}

/**
 * Split a chord into its root note and everything that follows.
 * "F#m7" -> { root: "F#", quality: "m7" }; "Bbmaj7" -> { root: "Bb", quality: "maj7" }
 * Returns null when the token does not start with a note letter.
 */
function parseChord(chord: string): { root: string; quality: string } | null {
  const match = chord.trim().match(/^([A-G][#b]?)(.*)$/)
  if (!match) return null
  return { root: match[1], quality: match[2] }
}

/** Pitch class (0-11) of a note spelling, or -1 if unknown. */
function noteIndex(note: string): number {
  const index = NOTE_INDEX[note]
  return index === undefined ? -1 : index
}

/**
 * Does this key conventionally spell its accidentals as flats?
 * Bb/Eb/Ab/Db/Gb and F are flat keys; C#/F# and the rest are sharp keys.
 * Minor keys follow their own signature (Dm, Gm, Cm, Fm are flat).
 */
function keyPrefersFlats(key: string): boolean {
  const parsed = parseChord(key)
  if (!parsed) return false

  const accidental = parsed.root.slice(1)
  if (accidental === 'b') return true
  if (accidental === '#') return false

  return isMinorQuality(parsed.quality)
    ? FLAT_MINOR_LETTERS.has(parsed.root)
    : parsed.root === 'F'
}

/**
 * Spell a pitch class for a given key, so transposing into Bb gives "Eb"
 * rather than "D#", and transposing into A gives "C#" rather than "Db".
 * With no key, fall back to the accidental the source chord already used.
 */
function spellNote(index: number, targetKey?: string, sourceRoot?: string): string {
  const useFlats = targetKey
    ? keyPrefersFlats(targetKey)
    : sourceRoot ? sourceRoot.slice(1) === 'b' : false
  return (useFlats ? FLAT_NOTES : SHARP_NOTES)[index]
}

/**
 * Extract the base note from a chord (e.g., "Gm7" -> "G", "Bbm" -> "Bb")
 */
function getBaseNote(chord: string): string {
  const parsed = parseChord(chord)
  return parsed ? parsed.root : chord
}

/**
 * Transpose a single chord by a given number of semitones.
 *
 * @param chord - The chord to transpose (e.g., "G", "Dm", "F#m7", "G/B")
 * @param semitones - Number of semitones to transpose (positive = up, negative = down)
 * @param targetKey - Optional key, used to pick sharp vs flat spelling
 * @returns The transposed chord, quality and slash bass preserved
 *
 * Example: transposeChord("G", 2) -> "A"
 * Example: transposeChord("Dm", -3) -> "Bm"
 * Example: transposeChord("G/B", 2, "A") -> "A/C#"
 * Example: transposeChord("A#m7", 0, "Bb") -> "Bbm7"
 */
export function transposeChord(chord: string, semitones: number, targetKey?: string): string {
  if (!chord || chord.trim() === '') return chord

  // Slash chord: transpose both sides so the bass note moves with the root
  const slashIndex = chord.indexOf('/')
  if (slashIndex > 0) {
    const upper = chord.slice(0, slashIndex)
    const bass  = chord.slice(slashIndex + 1)
    return transposeChord(upper, semitones, targetKey) + '/' + transposeChord(bass, semitones, targetKey)
  }

  const parsed = parseChord(chord)
  if (!parsed) return chord

  const currentIndex = noteIndex(parsed.root)
  if (currentIndex === -1) return chord

  const newIndex = ((currentIndex + semitones) % 12 + 12) % 12
  return spellNote(newIndex, targetKey, parsed.root) + parsed.quality
}

// --- Nashville support ----------------------------------------------------
const ROMAN_TO_SEMITONE: Record<string, number> = {
  'I':   0,
  'bII': 1,
  '#I':  1,
  'II':  2,
  'bIII':3,
  '#II': 3,
  'III': 4,
  'IV':  5,
  'bV':  6,
  '#IV': 6,
  'V':   7,
  'bVI': 8,
  '#V':  8,
  'VI':  9,
  'bVII':10,
  '#VI': 10,
  'VII': 11,
}

const ALL_ROMANS = Object.keys(ROMAN_TO_SEMITONE).sort((a, b) => b.length - a.length)
const ROMAN_PATTERN = ALL_ROMANS.map(r => r.replace('#', '\\#')).join('|')
const ROMAN_RE = new RegExp(`^(${ROMAN_PATTERN})(.*)$`, 'i')
const SEMITONE_TO_ROMAN: Record<number, string> = {
  0: 'I',
  1: 'bII',
  2: 'II',
  3: 'bIII',
  4: 'III',
  5: 'IV',
  6: 'bV',
  7: 'V',
  8: 'bVI',
  9: 'VI',
  10: 'bVII',
  11: 'VII',
}

function parseNashville(token: string): { numeral: string; modifiers: string; lowerCase: boolean } | null {
  const m = token.trim().match(ROMAN_RE)
  if (!m) return null
  const rawNumeral = m[1]
  let modifiers = m[2] ?? ''
  const lowerCase = /[a-z]/.test(rawNumeral)

  // Canonicalise numeral to uppercase with optional leading b/# preserved
  const upper = rawNumeral.toUpperCase()
  const finalNumeral = rawNumeral.startsWith('b') || rawNumeral.startsWith('B')
    ? 'b' + upper.slice(1)
    : rawNumeral.startsWith('#')
    ? '#' + upper.slice(1)
    : upper

  if (!(finalNumeral in ROMAN_TO_SEMITONE)) return null

  // A Roman numeral followed by ordinary letters is usually a section label
  // (for example "Verse" or "Interlude"), not a Nashville chord.
  if (!/^(?:maj|major|min|minor|dom|sus|add|aug|dim|alt|hdim|no|M|m|Â°|Ã¸|Î”|\+|-|\d+|[#b]\d+|\(|\))*$/.test(modifiers)) {
    return null
  }

  // If user used lowercase numerals (e.g. "ii"), imply minor if no explicit modifier
  if (lowerCase && !/\bm(?![a-zA-Z])/.test(modifiers) && !/maj|dim|aug/.test(modifiers)) {
    modifiers = 'm' + modifiers
  }

  return { numeral: finalNumeral, modifiers, lowerCase }
}

function nashvilleToChord(token: string, targetKey: string): string | null {
  const trimmed = token.trim()

  // Slash numeral, e.g. "V/VII" -> "G/B" in C
  const slashIndex = trimmed.indexOf('/')
  if (slashIndex > 0) {
    const upper = nashvilleToChord(trimmed.slice(0, slashIndex), targetKey)
    const bass  = nashvilleToChord(trimmed.slice(slashIndex + 1), targetKey)
    if (!upper) return null
    return upper + '/' + (bass ?? trimmed.slice(slashIndex + 1))
  }

  const parsed = parseNashville(trimmed)
  if (!parsed) return null
  const semitone = ROMAN_TO_SEMITONE[parsed.numeral]
  if (semitone === undefined) return null

  const rootIdx = noteIndex(getBaseNote(targetKey))
  if (rootIdx === -1) return null

  return spellNote((rootIdx + semitone) % 12, targetKey) + parsed.modifiers
}

/**
 * Transpose a block of text containing chords in [chord] format.
 * Supports both standard chords and Nashville numerals. When `targetKey`
 * is provided, Nashville numerals (e.g. [I], [ii]) are converted to actual
 * chord names in that key, and chord spellings follow that key's signature.
 */
export function transposeText(
  text: string,
  semitones: number,
  targetKey?: string,
  convertNashville: boolean = true,
): string {
  return text.replace(/\[([^\]]+)\]/g, (match, chord) => {
    // Try Nashville first (requires a targetKey to map to real chords)
    if (targetKey && convertNashville) {
      const maybe = nashvilleToChord(chord, targetKey)
      if (maybe) return `[${maybe}]`
    }

    // Preserve headings and annotations such as [Verse 1], [Interlude], and
    // [Repeat]. Only bracket contents that are actually chords are transposed.
    if (!isChordToken(chord)) return match
    return `[${transposeChord(chord, semitones, targetKey)}]`
  })
}

/**
 * Is this token a chord on its own, e.g. "Am7", "G/B", "Csus4"?
 *
 * Deliberately strict: the part after the root must be built only from real
 * chord-quality pieces, so ordinary words that start with a note letter
 * ("Amazing", "Bad", "Cage", "Fine") are never mistaken for chords.
 */
/**
 * Split a chord into its root, its quality and its slash bass note.
 *
 * Exported so chord diagrams are looked up with the very same parsing that
 * transposition uses. Two separate definitions of what counts as a chord
 * would drift apart, and a chord that transposes but has no diagram - or the
 * reverse - is the kind of bug nobody thinks to go looking for.
 *
 * "F#m7/A" -> { root: "F#", quality: "m7", bass: "A" }
 */
export function splitChord(chord: string): { root: string; quality: string; bass: string } | null {
  const trimmed = chord.trim()
  if (!trimmed) return null

  const slash = trimmed.indexOf('/')
  const head = slash > 0 ? trimmed.slice(0, slash) : trimmed
  const bassPart = slash > 0 ? trimmed.slice(slash + 1).trim() : ''

  const parsed = parseChord(head)
  if (!parsed || noteIndex(parsed.root) === -1) return null

  const bass = bassPart && noteIndex(bassPart) !== -1 ? bassPart : ''
  return { root: parsed.root, quality: parsed.quality, bass }
}

/** Pitch class 0-11 of a note name ("Bb" -> 10), or -1 when it is not one. */
export function notePitchClass(note: string): number {
  return noteIndex(note.trim())
}

export function isChordToken(token: string): boolean {
  const trimmed = token.trim()
  if (!trimmed) return false

  const slashIndex = trimmed.indexOf('/')
  if (slashIndex > 0) {
    return isChordToken(trimmed.slice(0, slashIndex)) && isChordToken(trimmed.slice(slashIndex + 1))
  }

  const parsed = parseChord(trimmed)
  if (!parsed || noteIndex(parsed.root) === -1) return false

  return /^(?:maj|major|min|minor|dom|sus|add|aug|dim|alt|hdim|no|M|m|°|ø|Δ|\+|-|\d+|[#b]\d+|\(|\))*$/.test(parsed.quality)
}

/** Is this token a Nashville numeral on its own, e.g. "I", "vi", "bVII"? */
export function isNashvilleToken(token: string): boolean {
  const trimmed = token.trim()
  if (!trimmed) return false

  const slashIndex = trimmed.indexOf('/')
  if (slashIndex > 0) {
    return isNashvilleToken(trimmed.slice(0, slashIndex)) && isNashvilleToken(trimmed.slice(slashIndex + 1))
  }

  return parseNashville(trimmed) !== null
}

/**
 * The words a chart uses to name a part of the song.
 *
 * These are here for one reason: several of them are also perfectly good
 * chord or numeral tokens once they are abbreviated. "V1" reads as the fifth
 * with a modifier, "C1" as a C chord, "B1" as a B - so a chart that labels
 * its parts the way most players write them came out with its headings
 * transposed along with the music.
 */
const SECTION_WORDS = [
  'verse', 'chorus', 'pre-?chorus', 'prechorus', 'post-?chorus',
  'bridge', 'intro', 'introduction', 'interlude', 'instrumental',
  'outro', 'ending', 'end', 'tag', 'refrain', 'vamp', 'coda',
  'turnaround', 'solo', 'break', 'breakdown', 'hook', 'reprise',
  'chant', 'spontaneous', 'channel', 'link', 'response',
].join('|')

/** A whole line that is nothing but a section heading, however it is dressed. */
const SECTION_LINE_RE = new RegExp(
  '^\\s*[\\[({<]?\\s*(?:' + SECTION_WORDS + ')\\b[^\\]})>]*[\\]})>]?\\s*:?\\s*$',
  'i',
)

/**
 * The shorthand forms: "V1", "C2", "PC", "B", "[V1]", "Ch 2:".
 *
 * A bare single letter is only a heading when it carries a number - "C" on
 * its own really is a C chord, and guessing otherwise would break ordinary
 * charts to fix a rarer case.
 */
const SECTION_ABBR_RE =
  /^\s*[\[({<]?\s*(?:v|c|ch|b|br|pc|pb|i|in|intro|o|t|tg|r|s)\s*\d{1,2}\s*[\])}>]?\s*:?\s*$/i

/** A repeat marker on its own, e.g. "x2", "2x", "(x3)". */
const REPEAT_ONLY_RE = /^\s*[\[({<]?\s*(?:x\s*\d{1,2}|\d{1,2}\s*x)\s*[\])}>]?\s*:?\s*$/i

/**
 * Is this whole line a heading rather than music?
 *
 * Exported so anything that displays or edits a chart can leave the same
 * lines alone that transposition does.
 */
export function isSectionLabelLine(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed) return false
  return SECTION_LINE_RE.test(trimmed) || SECTION_ABBR_RE.test(trimmed) || REPEAT_ONLY_RE.test(trimmed)
}

/**
 * Transpose text whether or not the chords are wrapped in brackets.
 *
 * - Bracketed chords are always transposed.
 * - A line with no brackets is transposed only when *every* token on it is a
 *   chord or a Nashville numeral, so lyric lines are never touched. That is
 *   what makes it safe to paste a plain chord chart straight in.
 * - A line that is only a section heading is left exactly as written, even
 *   when the heading happens to spell a chord.
 */
export function transposeAnyText(
  text: string,
  semitones: number,
  targetKey?: string,
  convertNashville: boolean = true,
): string {
  // The key is always wanted for spelling (F# vs Gb); turning numerals into
  // chords is a separate decision, and in plain chord mode "I" is a heading
  // or a lyric, never the tonic.
  const nashKey = convertNashville ? targetKey : undefined
  return text
    .split('\n')
    .map(line => {
      // Headings first: "[Verse 1]" and "V1" are both the name of a part of
      // the song, not something to move into another key.
      if (isSectionLabelLine(line)) return line

      if (/\[[^\]]+\]/.test(line)) return transposeText(line, semitones, targetKey, convertNashville)

      const tokens = line.split(/(\s+)/)
      const chordTokens = tokens.filter(t => t.trim() !== '')
      if (chordTokens.length === 0) return line

      // Only a pure chord line qualifies - one stray lyric word and we bail out
      const allChords = chordTokens.every(t => isChordToken(t) || (!!nashKey && isNashvilleToken(t)))
      if (!allChords) return line

      return tokens
        .map(t => {
          if (t.trim() === '') return t
          if (nashKey && !isChordToken(t)) {
            const nashville = nashvilleToChord(t, nashKey)
            if (nashville) return nashville
          }
          return transposeChord(t, semitones, targetKey)
        })
        .join('')
    })
    .join('\n')
}

/**
 * Detect whether a text block contains any Nashville numerals inside brackets
 */
export function hasNashville(text: string): boolean {
  if (!text) return false
  const matches = [...text.matchAll(/\[([^\]]+)\]/g)].map(m => m[1])
  for (const token of matches) {
    if (parseNashville(token)) return true
  }
  return false
}

export function chordToNashville(token: string, sourceKey: string): string | null {
  const trimmed = token.trim()
  if (parseNashville(trimmed)) return trimmed

  // Slash chord: the bass note becomes a numeral too, so the chart stays
  // key-independent and converts back correctly.
  const slashIndex = trimmed.indexOf('/')
  if (slashIndex > 0) {
    const upper = chordToNashville(trimmed.slice(0, slashIndex), sourceKey)
    const bass  = chordToNashville(trimmed.slice(slashIndex + 1), sourceKey)
    if (!upper) return null
    return upper + '/' + (bass ?? trimmed.slice(slashIndex + 1))
  }

  const sourceIndex = noteIndex(getBaseNote(sourceKey))
  const parsed = parseChord(trimmed)
  if (!parsed) return null
  const chordIndex = noteIndex(parsed.root)

  if (sourceIndex === -1 || chordIndex === -1) return null

  const semitone = (chordIndex - sourceIndex + 12) % 12
  const numeral = SEMITONE_TO_ROMAN[semitone]
  if (!numeral) return null

  const remainder = parsed.quality
  const isMinor = isMinorQuality(remainder)
  const strippedRemainder = isMinor
    ? remainder.replace(/^min/i, '').replace(/^m(?!aj)/i, '')
    : remainder

  return (isMinor ? numeral.toLowerCase() : numeral) + strippedRemainder
}

export function transposeTextToNashville(text: string, sourceKey: string): string {
  return text.replace(/\[([^\]]+)\]/g, (match, chord) => {
    const converted = chordToNashville(chord, sourceKey)
    return converted ? `[${converted}]` : match
  })
}

/**
 * Get semitone distance from one key to another, as the shortest path
 * (-6..+6), so C -> Bb reads as -2 rather than +10.
 *
 * Example: getTransposeDistance("G", "A") -> 2
 */
export function getTransposeDistance(fromKey: string, toKey: string): number {
  const fromIndex = noteIndex(getBaseNote(fromKey))
  const toIndex = noteIndex(getBaseNote(toKey))

  if (fromIndex === -1 || toIndex === -1) {
    console.warn(`Invalid keys: ${fromKey}, ${toKey}`)
    return 0
  }

  let distance = toIndex - fromIndex
  // Normalize to -6 to +6 range for shortest path
  if (distance > 6) distance -= 12
  if (distance < -6) distance += 12

  return distance
}

/**
 * Get all 12 keys for the transpose UI, in the spelling players expect
 * (Eb rather than D#, F# rather than Gb).
 */
export function getAllKeys(): string[] {
  return [...KEY_NAMES]
}

/**
 * Do two key names sound the same? "A#" and "Bb" are the same key, so a song
 * saved in one spelling still matches the picker showing the other.
 */
export function isSameKey(a: string, b: string): boolean {
  const left = noteIndex(getBaseNote(a))
  const right = noteIndex(getBaseNote(b))
  return left !== -1 && left === right
}

/**
 * Describe an interval in words, for transpose UI labels.
 * Example: intervalLabel(2) -> "up a whole step"
 */
export function intervalLabel(semitones: number): string {
  if (semitones === 0) return 'Same key'
  const names: Record<number, string> = {
    1: 'a half step',
    2: 'a whole step',
    3: 'a minor 3rd',
    4: 'a major 3rd',
    5: 'a 4th',
    6: 'a tritone',
  }
  const size = Math.abs(semitones)
  const name = names[size] ?? `${size} semitones`
  return `${semitones > 0 ? 'up' : 'down'} ${name}`
}

/**
 * Best-guess key of a chord chart.
 *
 * Scores all 12 major and 12 minor keys on how well the chords fit their
 * diatonic triads, with a bonus when the first or last chord is the tonic -
 * the usual heuristic, and far steadier than "most frequent root".
 *
 * @returns The tonic spelled for that key ("Bb", "Em"), or null if no chords.
 */
export function detectKeyFromText(text: string): string | null {
  if (!text) return null

  const tokens: string[] = []
  const bracketed = [...text.matchAll(/\[([^\]]+)\]/g)].map(m => m[1])
  if (bracketed.length > 0) {
    tokens.push(...bracketed)
  } else {
    for (const raw of text.split(/\s+/)) {
      if (isChordToken(raw)) tokens.push(raw)
    }
  }

  const chords = tokens
    .map(t => {
      const head = t.split('/')[0]
      const parsed = parseChord(head)
      if (!parsed) return null
      const index = noteIndex(parsed.root)
      if (index === -1) return null
      return { index, minor: isMinorQuality(parsed.quality) }
    })
    .filter((c): c is { index: number; minor: boolean } => c !== null)

  if (chords.length === 0) return null

  // Diatonic triads: semitones above the tonic -> is that triad minor?
  const MAJOR_SCALE: Record<number, boolean> = { 0: false, 2: true, 4: true, 5: false, 7: false, 9: true, 11: true }
  const MINOR_SCALE: Record<number, boolean> = { 0: true, 2: true, 3: false, 5: true, 7: true, 8: false, 10: false }

  let best: { key: string; score: number } | null = null

  for (let tonic = 0; tonic < 12; tonic += 1) {
    for (const minorKey of [false, true]) {
      const scale = minorKey ? MINOR_SCALE : MAJOR_SCALE
      let score = 0

      chords.forEach((chord, i) => {
        const degree = (chord.index - tonic + 12) % 12
        const expectedMinor = scale[degree]

        if (expectedMinor === undefined) {
          score -= 2                                  // out of key
        } else if (expectedMinor === chord.minor) {
          score += 2                                  // right degree, right quality
        } else {
          score += 1                                  // borrowed / secondary chord
        }

        // Charts overwhelmingly start and end on the tonic
        const isTonic = degree === 0 && chord.minor === minorKey
        if (isTonic && (i === 0 || i === chords.length - 1)) score += 3
      })

      // A minor reading only wins on a clear margin - major is the safer default
      const threshold = best ? best.score + (minorKey ? 1 : 0) : -Infinity
      if (score > threshold) {
        const spelled = KEY_NAMES.includes(SHARP_NOTES[tonic]) ? SHARP_NOTES[tonic] : FLAT_NOTES[tonic]
        best = { key: minorKey ? spelled + 'm' : spelled, score }
      }
    }
  }

  return best ? best.key : null
}

/**
 * Get relative minor key for a major key
 * E.g., C -> Am, G -> Em, Bb -> Gm
 */
export function getRelativeMinor(majorKey: string): string {
  const index = noteIndex(getBaseNote(majorKey))
  if (index === -1) return majorKey

  // Relative minor is 3 semitones down (9 semitones up)
  return spellNote((index + 9) % 12, majorKey) + 'm'
}
