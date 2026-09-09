// lib/audioPlayer.ts
import { Audio } from './audioCompat'

export interface AudioPlayerState {
  isPlaying: boolean
  duration: number
  position: number
  isLoading: boolean
}

export class AudioPlayer {
  private sound: Audio.Sound | null = null
  private statusUpdateCallback: ((state: AudioPlayerState) => void) | null = null

  /**
   * Load an audio file
   */
  async loadAudio(uri: string): Promise<void> {
    try {
      // Unload previous sound if exists
      if (this.sound) {
        await this.sound.unloadAsync()
      }

      this.sound = new Audio.Sound()
      await this.sound.loadAsync({ uri })

      // Set up status update subscription
      this.sound.setOnPlaybackStatusUpdate((status) => {
        if (status.isLoaded && this.statusUpdateCallback) {
          this.statusUpdateCallback({
            isPlaying: status.isPlaying,
            duration: status.durationMillis || 0,
            position: status.positionMillis || 0,
            isLoading: false,
          })
        }
      })
    } catch (error) {
      console.error('Error loading audio:', error)
      throw error
    }
  }

  /**
   * Play audio
   */
  async play(): Promise<void> {
    try {
      if (this.sound) {
        await this.sound.playAsync()
      }
    } catch (error) {
      console.error('Error playing audio:', error)
      throw error
    }
  }

  /**
   * Pause audio
   */
  async pause(): Promise<void> {
    try {
      if (this.sound) {
        await this.sound.pauseAsync()
      }
    } catch (error) {
      console.error('Error pausing audio:', error)
      throw error
    }
  }

  /**
   * Stop audio
   */
  async stop(): Promise<void> {
    try {
      if (this.sound) {
        await this.sound.stopAsync()
        await this.sound.unloadAsync()
        this.sound = null
      }
    } catch (error) {
      console.error('Error stopping audio:', error)
      throw error
    }
  }

  /**
   * Seek to position
   */
  async seek(position: number): Promise<void> {
    try {
      if (this.sound) {
        await this.sound.setPositionAsync(position)
      }
    } catch (error) {
      console.error('Error seeking audio:', error)
      throw error
    }
  }

  /**
   * Set playback rate (if supported)
   */
  async setRate(rate: number, shouldCorrectPitch: boolean = true): Promise<void> {
    try {
      if (this.sound) {
        await this.sound.setRateAsync(rate, shouldCorrectPitch)
      }
    } catch (error) {
      console.error('Error setting playback rate:', error)
      throw error
    }
  }

  /**
   * Get current status
   */
  async getStatus(): Promise<AudioPlayerState | null> {
    try {
      if (this.sound) {
        const status = await this.sound.getStatusAsync()
        if (status.isLoaded) {
          return {
            isPlaying: status.isPlaying,
            duration: status.durationMillis || 0,
            position: status.positionMillis || 0,
            isLoading: false,
          }
        }
      }
      return null
    } catch (error) {
      console.error('Error getting status:', error)
      return null
    }
  }

  /**
   * Set status update callback
   */
  setStatusCallback(callback: (state: AudioPlayerState) => void): void {
    this.statusUpdateCallback = callback
  }

  /**
   * Clean up
   */
  async dispose(): Promise<void> {
    try {
      if (this.sound) {
        await this.sound.unloadAsync()
        this.sound = null
      }
    } catch (error) {
      console.error('Error disposing audio player:', error)
    }
  }

  /**
   * Check if sound is loaded
   */
  isLoaded(): boolean {
    return this.sound !== null
  }
}

export const audioPlayer = new AudioPlayer()
