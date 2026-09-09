// lib/keyDetection.ts
// Key detection utility using autocorrelation algorithm

const NOTE_FREQUENCIES = {
  C: 16.35,
  'C#': 17.32,
  D: 18.35,
  'D#': 19.45,
  E: 20.6,
  F: 21.83,
  'F#': 23.12,
  G: 24.5,
  'G#': 25.96,
  A: 27.5,
  'A#': 29.13,
  B: 30.87,
}

const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

/**
 * Autocorrelation function to detect pitch
 * Based on the algorithm described in:
 * "Pitch Detection using YIN Algorithm" and "AUTOCORRELATION PITCH DETECTION"
 */
export function autoCorrelate(buffer: Float32Array, sampleRate: number): number {
  // Implements the autocorrelation algorithm for pitch detection
  const SIZE = buffer.length
  const MAX_SAMPLES = Math.floor(SIZE / 2)
  let best_offset = -1
  let best_correlation = 0
  let rms = 0

  // Calculate RMS (root mean square) to check if there's enough signal
  for (let i = 0; i < SIZE; i++) {
    const val = buffer[i]
    rms += val * val
  }
  rms = Math.sqrt(rms / SIZE)

  // Not enough signal
  if (rms < 0.01) {
    return -1
  }

  // Find the best correlation offset
  let lastCorrelation = 1
  for (let offset = 1; offset < MAX_SAMPLES; offset++) {
    let correlation = 0

    for (let i = 0; i < MAX_SAMPLES; i++) {
      correlation += Math.abs(buffer[i] - buffer[i + offset])
    }

    correlation = 1 - correlation / MAX_SAMPLES
    if (correlation > 0.9 && correlation > lastCorrelation) {
      let foundGoodCorrelation = false
      if (correlation > best_correlation) {
        foundGoodCorrelation = true
      }

      if (foundGoodCorrelation) {
        if (correlation > best_correlation) {
          best_correlation = correlation
          best_offset = offset
        }
      }
    }
    lastCorrelation = correlation
  }

  if (best_correlation > 0.01) {
    return sampleRate / best_offset
  }
  return -1
}

/**
 * Convert frequency to MIDI note number
 */
export function frequencyToMidi(freq: number): number {
  return Math.round(6 * Math.log2(freq / 440) + 69)
}

/**
 * Convert MIDI note number to frequency
 */
export function midiToFrequency(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12)
}

/**
 * Get the closest note name from a frequency
 */
export function frequencyToNote(frequency: number): {
  note: string
  octave: number
  cents: number
} {
  if (frequency < 0) {
    return { note: 'Unknown', octave: 0, cents: 0 }
  }

  const midi = frequencyToMidi(frequency)
  const noteName = NOTES[midi % 12]
  const octave = Math.floor(midi / 12) - 1

  // Calculate cents (100 cents = 1 semitone)
  const expectedFrequency = midiToFrequency(midi)
  const cents = Math.round(1200 * Math.log2(frequency / expectedFrequency))

  return {
    note: noteName,
    octave,
    cents,
  }
}

/**
 * Detect the key of an audio buffer
 * This is a simplified version - real key detection would analyze more of the audio
 */
export function detectKeyFromFrequency(frequency: number): {
  note: string
  confidence: number
} {
  const noteInfo = frequencyToNote(frequency)

  // Confidence is based on how close the frequency is to the note
  // cents = 0 means perfect match
  const confidence = Math.max(0, 100 - Math.abs(noteInfo.cents))

  return {
    note: noteInfo.note,
    confidence: Math.min(100, confidence),
  }
}

/**
 * Calculate semitone difference between two notes
 */
export function getSemitonesBetweenNotes(fromNote: string, toNote: string): number {
  const fromIndex = NOTES.indexOf(fromNote)
  const toIndex = NOTES.indexOf(toNote)

  if (fromIndex === -1 || toIndex === -1) {
    return 0
  }

  let difference = toIndex - fromIndex

  // Normalize to -12 to 12 range
  while (difference > 6) {
    difference -= 12
  }
  while (difference < -6) {
    difference += 12
  }

  return difference
}

/**
 * Get the target note when transposing by semitones
 */
export function transposeNote(note: string, semitones: number): string {
  const currentIndex = NOTES.indexOf(note)
  if (currentIndex === -1) {
    return note
  }

  const newIndex = (currentIndex + semitones + 120) % 12
  return NOTES[newIndex]
}

/**
 * Get all notes
 */
export function getNotes(): string[] {
  return [...NOTES]
}
