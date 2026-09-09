// ═══════════════════════════════════════════════════════════════════════════════
// METRONOME CLICK SYNTHESIS
// ═══════════════════════════════════════════════════════════════════════════════
//
// The click is generated here rather than shipped as a sample, for two reasons:
//
//   PITCH   A sample pitched up for accents gets thin and piercing. Generating
//           each accent separately means every level has its own pitch, and all
//           three sit low and warm - a wooden "tock", not a hi-hat tick.
//
//   TAILS   A click that is stopped while still sounding pops. Every rendered
//           file holds its whole decay plus silence, and ends at exactly zero,
//           so the sound is complete no matter when the next beat arrives.
//
// The same three tones drive the Web Audio path in MetronomeScreen, so the
// metronome sounds identical whichever engine is playing it.
// ═══════════════════════════════════════════════════════════════════════════════

export type ClickAccent = 0 | 1 | 2

export type ClickTone = {
  /** Pitch at the attack, in Hz - where the "tock" starts */
  startHz: number
  /** Pitch it settles to; the drop between the two is what makes it wooden */
  endHz: number
  /** Time constant of the amplitude decay, in seconds */
  decaySec: number
  /** Peak level, 0-1 */
  level: number
}

// Deliberately low fundamentals. The old sample was a bandpassed noise burst at
// 900-1600 Hz, which is the range that gets shrill over a phone speaker; these
// stay under 500 Hz and lean on the second harmonic for definition instead.
export const CLICK_TONES: Record<ClickAccent, ClickTone> = {
  2: { startHz: 480, endHz: 300, decaySec: 0.030, level: 1.0 },   // STRONG - downbeat
  1: { startHz: 380, endHz: 250, decaySec: 0.026, level: 0.74 },  // MEDIUM - group beat
  0: { startHz: 300, endHz: 210, decaySec: 0.022, level: 0.52 },  // WEAK   - inner beat
}

/**
 * Decay time constants kept before the fade-out. Five puts the tail under 1%
 * of peak - inaudible - while keeping the whole click short enough that fast
 * subdivisions do not stack up.
 */
export const DECAY_TAIL = 5

// ─── Pitch ────────────────────────────────────────────────────────────────────
//
// Pitch is a property of the tone, not of playback, so shifting it only moves
// the frequencies. Length, decay and level are untouched, which is what keeps
// the tempo exactly where it was - unlike changing a sample's playback rate,
// which would stretch the click and shift its pitch together.

/** How far the click can be shifted, in semitones, either way. */
export const PITCH_RANGE_SEMITONES = 12

/** Frequency multiplier for a shift in semitones. 12 semitones = one octave. */
export function pitchRatio(semitones: number): number {
  return Math.pow(2, semitones / 12)
}

/** A tone with its frequencies shifted; everything else stays as it was. */
export function shiftTone(tone: ClickTone, semitones: number): ClickTone {
  if (!semitones) return tone
  const ratio = pitchRatio(semitones)
  return { ...tone, startHz: tone.startHz * ratio, endHz: tone.endHz * ratio }
}

/** Second harmonic level, relative to the fundamental. Adds attack definition. */
const HARMONIC_LEVEL = 0.3
/** Raised-cosine attack. Long enough to avoid a DC pop, short enough to be a click. */
const ATTACK_SEC = 0.003
/** Linear fade over the last moments, so the file ends at exactly zero. */
const FADE_OUT_SEC = 0.008

/** How long a rendered click lasts, decay tail and trailing silence included. */
export function clickDurationSec(tone: ClickTone): number {
  return ATTACK_SEC + tone.decaySec * DECAY_TAIL + FADE_OUT_SEC
}

/**
 * Render one click to mono float samples in [-1, 1].
 * Starts at zero, ends at zero, with the whole decay in between.
 */
export function renderClick(
  accent: ClickAccent,
  sampleRate: number,
  semitones: number = 0,
): Float32Array {
  const tone = shiftTone(CLICK_TONES[accent], semitones)
  const total = clickDurationSec(tone)
  const frames = Math.ceil(total * sampleRate)
  const out = new Float32Array(frames)

  // The pitch glide settles faster than the amplitude decays, which is what
  // reads as a struck block rather than a bent note.
  const glideTau = tone.decaySec * 0.4
  const fadeStart = total - FADE_OUT_SEC

  let phase = 0

  for (let i = 0; i < frames; i++) {
    const t = i / sampleRate

    const hz = tone.endHz + (tone.startHz - tone.endHz) * Math.exp(-t / glideTau)
    phase += (2 * Math.PI * hz) / sampleRate

    const body = Math.sin(phase) + HARMONIC_LEVEL * Math.sin(2 * phase)

    // Attack ramp, then exponential decay
    const attack = t < ATTACK_SEC
      ? 0.5 - 0.5 * Math.cos((Math.PI * t) / ATTACK_SEC)
      : 1
    let env = attack * Math.exp(-t / tone.decaySec)

    // Guarantee silence at the very end - no discontinuity to pop on
    if (t > fadeStart) env *= Math.max(0, (total - t) / FADE_OUT_SEC)

    out[i] = (body / (1 + HARMONIC_LEVEL)) * env * tone.level
  }

  return out
}

// ─── WAV container ────────────────────────────────────────────────────────────

/** Wrap mono float samples in a 16-bit PCM WAV file. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const dataBytes = samples.length * 2
  const bytes = new Uint8Array(44 + dataBytes)
  const view = new DataView(bytes.buffer)

  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i)
  }

  ascii(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)   // file size minus the first 8 bytes
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)              // fmt chunk size
  view.setUint16(20, 1, true)               // PCM
  view.setUint16(22, 1, true)               // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)  // byte rate
  view.setUint16(32, 2, true)               // block align
  view.setUint16(34, 16, true)              // bits per sample
  ascii(36, 'data')
  view.setUint32(40, dataBytes, true)

  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(44 + i * 2, Math.round(clamped * 32767), true)
  }

  return bytes
}

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/**
 * Base64 without depending on btoa, which React Native does not define
 * everywhere. Small inputs only - a click is a few kilobytes.
 */
export function toBase64(bytes: Uint8Array): string {
  let out = ''

  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]
    const b1 = bytes[i + 1]
    const b2 = bytes[i + 2]
    const has1 = i + 1 < bytes.length
    const has2 = i + 2 < bytes.length

    out += B64_ALPHABET[b0 >> 2]
    out += B64_ALPHABET[((b0 & 0x03) << 4) | (has1 ? b1 >> 4 : 0)]
    out += has1 ? B64_ALPHABET[((b1 & 0x0f) << 2) | (has2 ? b2 >> 6 : 0)] : '='
    out += has2 ? B64_ALPHABET[b2 & 0x3f] : '='
  }

  return out
}

/** A ready-to-write WAV of one click, base64 encoded. */
export function renderClickWavBase64(
  accent: ClickAccent,
  sampleRate: number = 44100,
  semitones: number = 0,
): string {
  return toBase64(encodeWav(renderClick(accent, sampleRate, semitones), sampleRate))
}
