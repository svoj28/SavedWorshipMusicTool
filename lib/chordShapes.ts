// lib/chordShapes.ts
//
// Where to put your fingers for a chord written in a song.
//
// Two kinds of shape live here. The open chords a guitarist actually plays -
// C, G, Am, D7 and the rest - are written out by hand, because the shape a
// player expects for those is the open one, not a barre high up the neck.
// Everything else is worked out from a movable shape: the same handful of
// barre patterns slid up the neck until the root lands right, which is how a
// guitarist would work it out too.
//
// Chords are parsed with splitChord() from lib/transpose.ts rather than a
// second parser of our own, so a chord that can be transposed is a chord that
// can be drawn.
//
// Only genuinely standard shapes are listed. A wrong fingering is worse than
// none - it is confidently wrong, and a learner has no way to know - so
// anything unusual returns nothing and the app says so plainly.

import { notePitchClass, splitChord, transposeChord } from './transpose'

/**
 * The keys a guitarist can play with open shapes.
 *
 * This is the whole reason a capo exists: a song in Eb is a fistful of barre
 * chords, but put a capo on the first fret and play it as D and it becomes
 * the easiest thing in the world - and it sounds better, because open strings
 * ring.
 */
const EASY_KEYS = ['G', 'C', 'D', 'A', 'E', 'Em', 'Am', 'Dm']

export interface CapoOption {
  /** Fret the capo goes on; 0 means play it as written */
  capo: number
  /** The key you then read and play in */
  shapeKey: string
}

/**
 * Ways to play a song in `key` using open shapes.
 *
 * Only sensible capo positions are offered - past the seventh fret the frets
 * are too close together to play comfortably and the guitar starts to sound
 * like a mandolin. Ordered by how far up the neck the capo goes, since the
 * lowest one that works is nearly always the one to use.
 */
export function suggestCapo(key: string): CapoOption[] {
  if (!key || !splitChord(key)) return []

  const out: CapoOption[] = []

  for (let capo = 0; capo <= 7; capo += 1) {
    // Capo raises the pitch, so the shapes are read that many semitones lower
    const shapeKey = transposeChord(key, -capo)
    if (!shapeKey) continue
    if (!EASY_KEYS.some(k => k.toLowerCase() === shapeKey.toLowerCase())) continue
    out.push({ capo, shapeKey })
  }

  return out
}

export interface ChordShape {
  /**
   * One entry per string, from the low E to the high E.
   * -1 means the string is not played, 0 means played open.
   */
  frets: number[]
  /** Set when the shape is a barre, naming the fret held across. */
  barreFret?: number
  /** How the shape was arrived at, so the UI can be honest about it. */
  origin: 'open' | 'movable'
}

/** Pitch class of each open string, low E to high E. */
const STRING_PITCH = [4, 9, 2, 7, 11, 4] // E A D G B E

/**
 * The open chords, written out because these are the ones a player pictures.
 * Keyed by root and a normalised quality.
 */
const OPEN_SHAPES: Record<string, number[]> = {
  'C:': [-1, 3, 2, 0, 1, 0],
  'C:maj7': [-1, 3, 2, 0, 0, 0],
  'C:7': [-1, 3, 2, 3, 1, 0],
  'C:add9': [-1, 3, 2, 0, 3, 3],

  'A:': [-1, 0, 2, 2, 2, 0],
  'A:m': [-1, 0, 2, 2, 1, 0],
  'A:7': [-1, 0, 2, 0, 2, 0],
  'A:m7': [-1, 0, 2, 0, 1, 0],
  'A:maj7': [-1, 0, 2, 1, 2, 0],
  'A:sus4': [-1, 0, 2, 2, 3, 0],
  'A:sus2': [-1, 0, 2, 2, 0, 0],

  'G:': [3, 2, 0, 0, 0, 3],
  'G:7': [3, 2, 0, 0, 0, 1],
  'G:maj7': [3, 2, 0, 0, 0, 2],

  'E:': [0, 2, 2, 1, 0, 0],
  'E:m': [0, 2, 2, 0, 0, 0],
  'E:7': [0, 2, 0, 1, 0, 0],
  'E:m7': [0, 2, 0, 0, 0, 0],
  'E:sus4': [0, 2, 2, 2, 0, 0],

  'D:': [-1, -1, 0, 2, 3, 2],
  'D:m': [-1, -1, 0, 2, 3, 1],
  'D:7': [-1, -1, 0, 2, 1, 2],
  'D:m7': [-1, -1, 0, 2, 1, 1],
  'D:maj7': [-1, -1, 0, 2, 2, 2],
  'D:sus4': [-1, -1, 0, 2, 3, 3],
  'D:sus2': [-1, -1, 0, 2, 3, 0],

  'F:maj7': [-1, -1, 3, 2, 1, 0],
  'B:7': [-1, 2, 1, 2, 0, 2],
}

/**
 * The movable shapes, as fret offsets from the root.
 *
 * One set has its root on the sixth string and one on the fifth - the E and A
 * barre shapes every guitarist learns. Sliding either up the neck gives the
 * same chord on a different root, which is what makes them worth having.
 */
const MOVABLE: Record<string, { sixth?: number[]; fifth?: number[] }> = {
  '': { sixth: [0, 2, 2, 1, 0, 0], fifth: [-1, 0, 2, 2, 2, 0] },
  m: { sixth: [0, 2, 2, 0, 0, 0], fifth: [-1, 0, 2, 2, 1, 0] },
  '7': { sixth: [0, 2, 0, 1, 0, 0], fifth: [-1, 0, 2, 0, 2, 0] },
  m7: { sixth: [0, 2, 0, 0, 0, 0], fifth: [-1, 0, 2, 0, 1, 0] },
  maj7: { sixth: [0, 2, 1, 1, 0, 0], fifth: [-1, 0, 2, 1, 2, 0] },
  sus4: { sixth: [0, 2, 2, 2, 0, 0], fifth: [-1, 0, 2, 2, 3, 0] },
  sus2: { fifth: [-1, 0, 2, 2, 0, 0] },
  add9: { fifth: [-1, 0, 2, 2, 0, 2] },
}

/**
 * Reduce a written quality to the shape it is actually played with.
 *
 * A player reaches for the same grip for "Cmaj7" and "CM7", and for "Cm7" and
 * "Cmin7". Extensions with no distinct shape fall back to the nearest one
 * that is still musically right - a 9 is played as a 7 far more often than it
 * is left out - and anything genuinely unusual returns null, so the app can
 * admit it rather than draw something wrong.
 */
function normaliseQuality(raw: string): string | null {
  const q = raw.trim().replace(/[()]/g, '')
  const lower = q.toLowerCase()

  if (q === '' || lower === 'maj' || lower === 'major' || q === 'M') return ''
  if (/^(m|min|minor)$/.test(lower)) return 'm'
  if (/^(maj7|major7|maj9)$/.test(lower) || q === 'M7') return 'maj7'
  if (/^(m7|min7|minor7|m9|min9)$/.test(lower)) return 'm7'
  if (/^(7|9|11|13|7sus4|dom7)$/.test(lower)) return '7'
  if (/^(sus4|sus)$/.test(lower)) return 'sus4'
  if (/^sus2$/.test(lower)) return 'sus2'
  if (/^(add9|2)$/.test(lower)) return 'add9'
  if (/^(m6|min6)$/.test(lower)) return 'm'
  if (/^6$/.test(lower)) return ''

  return null // diminished, augmented, altered - no honest shape to offer
}

/** Lowest fret actually held down, ignoring open and muted strings. */
function lowestFret(frets: number[]): number {
  const held = frets.filter(f => f > 0)
  return held.length === 0 ? 0 : Math.min.apply(null, held)
}

/** Build a movable shape with its root at the given fret. */
function placeMovable(offsets: number[], rootFret: number): number[] {
  return offsets.map(o => (o < 0 ? -1 : o + rootFret))
}

/**
 * The shape for a chord, or null when there is no standard one worth showing.
 *
 * A slash chord is drawn as its main shape - the bass note is somebody else's
 * job in a band, and the grip the guitarist needs is the one above the slash.
 */
export function findChordShape(chord: string): ChordShape | null {
  const parts = splitChord(chord)
  if (!parts) return null

  const quality = normaliseQuality(parts.quality)
  if (quality === null) return null

  // An open shape wins whenever there is one - it is what a player expects
  const open = OPEN_SHAPES[parts.root + ':' + quality]
  if (open) return { frets: open.slice(), origin: 'open' }

  const rootPc = notePitchClass(parts.root)
  if (rootPc < 0) return null

  const movable = MOVABLE[quality]
  if (!movable) return null

  const candidates: ChordShape[] = []

  if (movable.sixth) {
    const fret = (rootPc - STRING_PITCH[0] + 12) % 12
    candidates.push({
      frets: placeMovable(movable.sixth, fret),
      barreFret: fret > 0 ? fret : undefined,
      origin: 'movable',
    })
  }

  if (movable.fifth) {
    const fret = (rootPc - STRING_PITCH[1] + 12) % 12
    candidates.push({
      frets: placeMovable(movable.fifth, fret),
      barreFret: fret > 0 ? fret : undefined,
      origin: 'movable',
    })
  }

  if (candidates.length === 0) return null

  // The one nearest the nut: easier to play, and easier to read on a small
  // diagram, since the whole shape fits within the first few frets
  candidates.sort((a, b) => lowestFret(a.frets) - lowestFret(b.frets))
  const best = candidates[0]

  // Anything this far up the neck is not what the player wants to be shown
  if (lowestFret(best.frets) > 11) return null

  return best
}

/**
 * Every distinct chord in a song, in the order they are first played.
 *
 * Order matters: the chords a song opens with are the ones a player wants to
 * see first, and sorting them alphabetically would bury them.
 */
export function chordsInSong(content: string): string[] {
  const seen: Record<string, boolean> = {}
  const out: string[] = []

  const matches = content.matchAll(/\[([^\]\n]+)\]/g)
  for (const m of matches) {
    const token = m[1].trim()
    if (!token || seen[token]) continue
    if (!splitChord(token)) continue // a section heading, not a chord
    seen[token] = true
    out.push(token)
  }

  return out
}
