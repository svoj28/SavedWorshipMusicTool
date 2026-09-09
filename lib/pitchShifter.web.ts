// lib/pitchShifter.web.ts
// Web implementation using Tone.js for true pitch shifting

/**
 * PitchShifter for Web
 * Uses Tone.js for true pitch shifting (pitch without tempo change)
 */

let ToneModule: any = null

// Lazy load Tone.js only in browser environment
try {
  ToneModule = require('tone')
} catch (error) {
  console.warn('Tone.js not available, web pitch shifting will be limited')
}

class PitchShifter {
  private tonePlayers: Map<string, any> = new Map()
  private currentSemitones: Map<string, number> = new Map()

  /**
   * Initialize pitch shifter for a specific audio source
   */
  async initializePitchShifter(uri: string, soundId: string): Promise<void> {
    if (!ToneModule) {
      console.warn('Tone.js not available, skipping initialization')
      return
    }

    try {
      // Initialize Tone.js player with pitch shifting capability
      const player = new ToneModule.Player(uri).toDestination()
      this.tonePlayers.set(soundId, player)
      this.currentSemitones.set(soundId, 0)
      console.log('Tone.js player initialized for pitch shifting')
    } catch (error) {
      console.error('Error initializing Tone.js player:', error)
    }
  }

  /**
   * Apply pitch shift without changing tempo
   * Uses Tone.js PitchShift effect
   * Returns null since web applies effect in real-time without needing to reload
   */
  async applyPitchShift(sound: any, semitones: number, soundId: string, filePath?: string): Promise<string | null> {
    if (!ToneModule) {
      console.warn('Tone.js not available')
      return null
    }

    try {
      const player = this.tonePlayers.get(soundId)
      if (!player) return null

      this.currentSemitones.set(soundId, semitones)

      // Create or update pitch shift effect
      if (!player.pitchShift) {
        const pitchShift = new ToneModule.PitchShift(semitones).connect(player.destination)
        player.connect(pitchShift)
        player.pitchShift = pitchShift
      } else {
        // Update existing pitch shift
        player.pitchShift.pitch = semitones
      }

      console.log(`Web pitch shift applied: ${semitones} semitones`)
      return null // Web doesn't need to return a new file path
    } catch (error) {
      console.error('Error in web pitch shift:', error)
      return null
    }
  }

  /**
   * Get info about current pitch shifting capabilities
   */
  getPitchShiftInfo(): {
    canDoPurePitchShift: boolean
    platform: string
    note: string
  } {
    const canDoPurePitchShift = !!ToneModule

    return {
      canDoPurePitchShift,
      platform: 'Web',
      note: canDoPurePitchShift
        ? 'Pure pitch shifting available via Tone.js (pitch changes without affecting tempo)'
        : 'Tone.js not loaded, pitch shifting limited',
    }
  }

  /**
   * Cleanup resources
   */
  cleanup(soundId: string): void {
    const tonePlayer = this.tonePlayers.get(soundId)
    if (tonePlayer) {
      try {
        if (tonePlayer.pitchShift) {
          tonePlayer.pitchShift.dispose()
        }
        tonePlayer.dispose()
      } catch (error) {
        console.error('Error cleaning up Tone player:', error)
      }
    }

    this.tonePlayers.delete(soundId)
    this.currentSemitones.delete(soundId)
  }
}

export const pitchShifter = new PitchShifter()
