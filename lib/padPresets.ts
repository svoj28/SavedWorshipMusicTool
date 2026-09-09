export type PadPresetId = 'warm' | 'prayer' | 'shimmer' | 'strings' | 'organ' | 'praise'

type PadWave = 'sine' | 'triangle' | 'custom'

export interface PadPreset {
  id: PadPresetId
  name: string
  description: string
  synth: {
    lowWave: PadWave
    highWave: PadWave
    /** Sine coefficients for harmonics 1 onward; DC is always zero. */
    harmonics?: readonly number[]
    /** Root, fifth, octave, high third, high fifth, second octave. */
    gains: readonly [number, number, number, number, number, number]
    register: number
    cutoff: number
    movement: number
    movementRate: number
    detune: number
    width: number
    level: number
    attack: number
    transition: number
  }
}

export const DEFAULT_PAD_PRESET: PadPresetId = 'warm'

// Shared by the controls and the WebView. Every sound uses the same small
// voice count and shared reverb; brighter tones use a few smooth harmonics.
export const PAD_PRESETS: readonly PadPreset[] = [
  {
    id: 'warm',
    name: 'Warm Worship',
    description: 'A warm foundation for worship and acoustic songs.',
    synth: {
      lowWave: 'triangle', highWave: 'sine',
      gains: [0.46, 0.30, 0.34, 0.20, 0.17, 0.10],
      register: 36, cutoff: 820, movement: 140, movementRate: 0.032,
      detune: 5, width: 1, level: 1, attack: 4, transition: 3.6,
    },
  },
  {
    id: 'prayer',
    name: 'Soft Prayer',
    description: 'A soft, rounded bed for prayer and quiet moments.',
    synth: {
      lowWave: 'sine', highWave: 'sine',
      gains: [0.50, 0.34, 0.32, 0.17, 0.16, 0.08],
      register: 36, cutoff: 520, movement: 40, movementRate: 0.018,
      detune: 2, width: 0.45, level: 0.94, attack: 5, transition: 4,
    },
  },
  {
    id: 'shimmer',
    name: 'Airy Shimmer',
    description: 'Light, sparkling octaves for spacious worship.',
    synth: {
      lowWave: 'sine', highWave: 'custom',
      harmonics: [1, 0, 0.18, 0, 0.09, 0.03],
      gains: [0.29, 0.27, 0.34, 0.22, 0.28, 0.17],
      register: 48, cutoff: 2500, movement: 160, movementRate: 0.05,
      detune: 7, width: 1.4, level: 0.90, attack: 4.5, transition: 4,
    },
  },
  {
    id: 'strings',
    name: 'Worship Strings',
    description: 'A wide ensemble swell for anthems and choruses.',
    synth: {
      lowWave: 'custom', highWave: 'custom',
      harmonics: [1, 0.48, 0.25, 0.13, 0.07, 0.04],
      gains: [0.38, 0.28, 0.35, 0.22, 0.22, 0.12],
      register: 36, cutoff: 1800, movement: 180, movementRate: 0.045,
      detune: 8, width: 1.3, level: 1.10, attack: 4, transition: 3.6,
    },
  },
  {
    id: 'organ',
    name: 'Sanctuary Organ',
    description: 'A steady organ tone for hymns and gospel praise.',
    synth: {
      lowWave: 'custom', highWave: 'custom',
      harmonics: [1, 0.50, 0, 0.30, 0, 0.12, 0, 0.06],
      gains: [0.40, 0.28, 0.34, 0.24, 0.19, 0.12],
      register: 36, cutoff: 2400, movement: 20, movementRate: 0.025,
      detune: 0.6, width: 0.55, level: 0.95, attack: 2.4, transition: 2.4,
    },
  },
  {
    id: 'praise',
    name: 'Bright Praise',
    description: 'A clear, full sound for upbeat praise songs.',
    synth: {
      lowWave: 'custom', highWave: 'triangle',
      harmonics: [1, 0.25, 0.13, 0.07],
      gains: [0.27, 0.32, 0.37, 0.23, 0.24, 0.14],
      register: 36, cutoff: 1900, movement: 90, movementRate: 0.08,
      detune: 3, width: 0.9, level: 1, attack: 1.8, transition: 2,
    },
  },
]

export function isPadPresetId(value: unknown): value is PadPresetId {
  return typeof value === 'string' && PAD_PRESETS.some(preset => preset.id === value)
}

export function getPadPreset(id: PadPresetId): PadPreset {
  return PAD_PRESETS.find(preset => preset.id === id) ?? PAD_PRESETS[0]
}
