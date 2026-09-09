// lib/pitchShifter.ts
// Platform-aware pitch shifter - automatic resolution based on platform
// - On web: uses pitchShifter.web.ts (Tone.js)
// - On native: uses pitchShifter.native.ts (FFmpeg with rubberband filter)

import { Audio } from './audioCompat'

/**
 * Base PitchShifter - Fallback implementation
 * Metro bundler will automatically use:
 * - pitchShifter.web.ts on web platform
 * - pitchShifter.native.ts on iOS/Android
 */

class PitchShifter {
  async initializePitchShifter(uri: string, soundId: string): Promise<void> {
    console.log('Base pitch shifter - no platform-specific implementation loaded')
  }

  async applyPitchShift(sound: Audio.Sound | null, semitones: number, soundId: string, filePath?: string): Promise<string | null> {
    console.log('Base pitch shifter - pitch shifting not available')
    return null
  }

  getPitchShiftInfo(): {
    canDoPurePitchShift: boolean
    platform: string
    note: string
  } {
    return {
      canDoPurePitchShift: false,
      platform: 'unknown',
      note: 'Platform-specific pitch shifter not loaded',
    }
  }

  cleanup(soundId: string): void {
    // Base cleanup
  }
}

export const pitchShifter = new PitchShifter()
