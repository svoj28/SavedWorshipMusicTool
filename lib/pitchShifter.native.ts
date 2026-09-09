// lib/pitchShifter.native.ts
// Native implementation for iOS/Android - fully local pitch shifting with FFmpeg
import { Audio } from './audioCompat'
import * as FileSystem from 'expo-file-system/legacy'
// import { FFmpegKit, FFprobeKit, ReturnCode } from 'ffmpeg-kit-react-native'
// ffmpeg-kit-react-native removed - stubs keep TypeScript happy, never called at runtime
const FFmpegKit: any = null
const FFprobeKit: any = null
const ReturnCode: any = null
import { NativeModules } from 'react-native'

/**
 * PitchShifter for Native (iOS/Android)
 * Performs pitch shifting on-device with FFmpeg.
 * No backend server is required.
 */

function semitonesToPitchFactor(semitones: number): number {
  return Math.pow(2, semitones / 12)
}

const TEMPO_OPPOSITION_BOOST_AT_12 = 1.03

function getTempoOppositionBoost(semitones: number): number {
  const normalizedSemitoneDistance = Math.min(1, Math.abs(semitones) / 12)
  return 1 + (TEMPO_OPPOSITION_BOOST_AT_12 - 1) * normalizedSemitoneDistance
}

function boostOpposingTempoRate(rate: number, semitones: number): number {
  if (!Number.isFinite(rate) || rate <= 0 || semitones === 0) {
    return 1
  }

  const boost = getTempoOppositionBoost(semitones)
  return rate >= 1 ? rate * boost : rate / boost
}

function toFfmpegPath(uri: string): string {
  const decodedUri = decodeURIComponent(uri)
  return decodedUri.startsWith('file://') ? decodedUri.replace('file://', '') : decodedUri
}

function quoteArgument(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`
}

function buildAtempoFilterChain(rate: number): string {
  // atempo only supports 0.5 - 2.0 per stage, so chain as needed.
  let remainingRate = rate
  const filters: string[] = []

  while (remainingRate < 0.5) {
    filters.push('atempo=0.5')
    remainingRate /= 0.5
  }

  while (remainingRate > 2.0) {
    filters.push('atempo=2.0')
    remainingRate /= 2.0
  }

  filters.push(`atempo=${remainingRate.toFixed(6)}`)
  return filters.join(',')
}

class PitchShifter {
  private currentSemitones: Map<string, number> = new Map()
  private processedFiles: Map<string, Map<number, string>> = new Map()
  private originalFilePath: Map<string, string> = new Map()
  private inFlightRequests: Map<string, Map<number, Promise<string | null>>> = new Map()
  private readonly hasNativeFfmpegModule = !!(NativeModules as any)?.FFmpegKitReactNativeModule

  private ensureNativeFfmpegModule(): boolean {
    return this.hasNativeFfmpegModule
  }

  private async executeFfmpegCommand(command: string): Promise<boolean> {
    if (!this.ensureNativeFfmpegModule()) {
      return false
    }

    try {
      const session = await FFmpegKit.execute(command)
      const returnCode = await session.getReturnCode()
      return ReturnCode.isSuccess(returnCode)
    } catch (error) {
      console.error('Failed to execute FFmpeg command:', error)
      return false
    }
  }

  private async getInputSampleRate(inputPath: string): Promise<number | null> {
    if (!this.ensureNativeFfmpegModule()) {
      return null
    }

    try {
      const mediaInformationSession = await FFprobeKit.getMediaInformation(inputPath)
      const mediaInformation = mediaInformationSession.getMediaInformation()
      const audioStream = mediaInformation
        ?.getStreams()
        ?.find((stream) => stream.getType() === 'audio')
      const sampleRate = Number(audioStream?.getSampleRate() || 0)

      if (Number.isFinite(sampleRate) && sampleRate > 0) {
        return sampleRate
      }
    } catch (error) {
      console.warn('Unable to probe input sample rate, using fallback defaults:', error)
    }

    return null
  }

  /**
   * Initialize pitch shifter - store original file path
   */
  async initializePitchShifter(uri: string, soundId: string): Promise<void> {
    this.currentSemitones.set(soundId, 0)
    this.originalFilePath.set(soundId, uri)
    this.processedFiles.set(soundId, new Map())
    this.inFlightRequests.set(soundId, new Map())
    if (this.ensureNativeFfmpegModule()) {
      console.log('✅ Pitch shifter initialized (on-device FFmpeg)')
    }
  }

  /**
  * Apply pitch shift using on-device FFmpeg for true pitch shifting
   * Returns the path to the pitch-shifted audio file
   */
  async applyPitchShift(
    sound: Audio.Sound | null,
    semitones: number,
    soundId: string,
    filePath?: string
  ): Promise<string | null> {
    const originalPath = filePath || this.originalFilePath.get(soundId)
    if (!sound && !originalPath) return null

    try {
      this.currentSemitones.set(soundId, semitones)

      // If no shift needed, return original file
      if (semitones === 0) {
        return filePath || this.originalFilePath.get(soundId) || null
      }

      if (!this.ensureNativeFfmpegModule()) {
        return null
      }

      // Check if we already processed this semitone value
      const processedFilesMap = this.processedFiles.get(soundId)
      if (processedFilesMap?.has(semitones)) {
        console.log(`Using cached pitch-shifted file for ${semitones} semitones`)
        return processedFilesMap.get(semitones) || null
      }

      if (!originalPath) {
        console.error('Original file path not found for sound:', soundId)
        return null
      }

      const requestsForSound = this.inFlightRequests.get(soundId) || new Map<number, Promise<string | null>>()
      this.inFlightRequests.set(soundId, requestsForSound)
      const existingRequest = requestsForSound.get(semitones)
      if (existingRequest) {
        return existingRequest
      }

      const processingPromise = (async (): Promise<string | null> => {
        const outputBaseDirectory = FileSystem.cacheDirectory || FileSystem.documentDirectory
        if (!outputBaseDirectory) {
          console.error('No writable directory available for processed audio')
          return null
        }

        const processedUri = `${outputBaseDirectory}pitch-shifted-${soundId}-${semitones}.m4a`
        const inputPath = toFfmpegPath(originalPath)
        const outputPath = toFfmpegPath(processedUri)
        const pitchFactor = semitonesToPitchFactor(semitones)
        const inputSampleRate = await this.getInputSampleRate(inputPath)
        const sourceSampleRate = Math.max(8000, Math.round(inputSampleRate || 44100))
        const shiftedSampleRate = Math.max(8000, Math.round(sourceSampleRate * pitchFactor))
        const appliedPitchFactor = shiftedSampleRate / sourceSampleRate
        const tempoCompensation = 1 / appliedPitchFactor
        const boostedTempoCompensation = boostOpposingTempoRate(tempoCompensation, semitones)

        console.log(`🎵 Processing on-device: ${semitones} semitones`)

        const rubberbandFilter = `rubberband=pitch=${pitchFactor.toFixed(6)}:formant=preserved`
        const rubberbandCommand =
          `-y -i ${quoteArgument(inputPath)} -vn ` +
          `-af ${quoteArgument(rubberbandFilter)} ` +
          `-c:a aac -b:a 192k ${quoteArgument(outputPath)}`

        const rubberbandSucceeded = await this.executeFfmpegCommand(rubberbandCommand)

        if (!rubberbandSucceeded) {
          console.log(
            `Using fallback FFmpeg pitch filter at ${sourceSampleRate}Hz (shifted to ${shiftedSampleRate}Hz)`
          )

          const fallbackFilter =
            `asetrate=${shiftedSampleRate},` +
            `aresample=${sourceSampleRate},` +
            `${buildAtempoFilterChain(boostedTempoCompensation)}`

          const fallbackCommand =
            `-y -i ${quoteArgument(inputPath)} -vn ` +
            `-af ${quoteArgument(fallbackFilter)} ` +
            `-c:a aac -b:a 192k ${quoteArgument(outputPath)}`

          const fallbackSucceeded = await this.executeFfmpegCommand(fallbackCommand)
          if (!fallbackSucceeded) {
            console.error('FFmpeg processing failed for both primary and fallback filters')
            return null
          }
        }

        const processedFileInfo = await FileSystem.getInfoAsync(processedUri)
        if (!processedFileInfo.exists) {
          console.error('Processed file was not created by FFmpeg')
          return null
        }

        console.log(`✅ Pitch shift successful! Saved to: ${processedUri}`)

        // Cache the processed file path
        processedFilesMap?.set(semitones, processedUri)

        return processedUri
      })()

      requestsForSound.set(semitones, processingPromise)
      const result = await processingPromise
      requestsForSound.delete(semitones)
      return result
    } catch (error) {
      if (error instanceof Error) {
        console.error('Error applying pitch shift (on-device FFmpeg):', error.message)
      } else {
        console.error('Error applying pitch shift (on-device FFmpeg):', error)
      }
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
    if (!this.hasNativeFfmpegModule) {
      return {
        canDoPurePitchShift: false,
        platform: 'iOS/Android (Playback-rate fallback)',
        note: 'FFmpeg native module not loaded. Using playback-rate fallback (pitch and tempo change together).',
      }
    }

    return {
      canDoPurePitchShift: true,
      platform: 'iOS/Android (Local FFmpeg)',
      note: '✅ True pitch shifting on-device (no backend required)',
    }
  }

  /**
   * Cleanup resources
   */
  cleanup(soundId: string): void {
    this.currentSemitones.delete(soundId)

    // Clean up all processed audio files for this sound
    const processedFilesMap = this.processedFiles.get(soundId)
    if (processedFilesMap) {
      processedFilesMap.forEach((filePath) => {
        FileSystem.deleteAsync(filePath, { idempotent: true }).catch((e) =>
          console.warn('Error deleting processed audio file:', e)
        )
      })
      this.processedFiles.delete(soundId)
    }

    this.inFlightRequests.delete(soundId)

    this.originalFilePath.delete(soundId)
  }
}

export const pitchShifter = new PitchShifter()
