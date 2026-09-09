import { Audio, AVPlaybackStatus } from './audioCompat'
import * as FileSystem from 'expo-file-system/legacy'
import * as DocumentPicker from 'expo-document-picker'


export type RemovalType = 'vocal' | 'instrument'
export type InstrumentType = 'drums' | 'electric_guitar' | 'acoustic_guitar' | 'bass' | 'keyboard'

export interface RemovalOptions {
  removalType: RemovalType
  instrument?: InstrumentType
}

export interface RemovalProgress {
  status: 'idle' | 'uploading' | 'processing' | 'downloading' | 'completed' | 'error'
  progress: number
  message: string
}

export class AudioRemovalService {
  private sound: Audio.Sound | null = null
  private statusUpdateCallback: ((progress: RemovalProgress) => void) | null = null
  private apiBaseUrl: string

  constructor(apiBaseUrl: string = '') {
    // Backend removed by user request; default to empty.
    this.apiBaseUrl = apiBaseUrl
  }
  

  /**
   * Set callback for progress updates
   */
  setProgressCallback(callback: (progress: RemovalProgress) => void) {
    this.statusUpdateCallback = callback
  }

  /**
   * Notify progress update
   */
  private notifyProgress(update: RemovalProgress) {
    if (this.statusUpdateCallback) {
      this.statusUpdateCallback(update)
    }
  }

  /**
   * Pick an audio file from device
   */
  async pickAudioFile(): Promise<string | null> {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: [
          'audio/mpeg',
          'audio/wav',
          'audio/mp4',
          'audio/aac',
          'audio/*',
        ],
      })

      if (result.assets && result.assets.length > 0) {
        return result.assets[0].uri
      }
      return null
    } catch (error) {
      console.error('Error picking audio file:', error)
      throw error
    }
  }

  /**
   * Remove vocals or specific instruments from audio
   */
  async removeVocalOrInstrument(
    audioUri: string,
    options: RemovalOptions
  ): Promise<string> {
    try {
      // If no backend URL is configured, the vocal removal API is unavailable.
      if (!this.apiBaseUrl) {
        const msg = 'Vocal removal backend removed — feature unavailable.'
        this.notifyProgress({ status: 'error', progress: 0, message: msg })
        throw new Error(msg)
      }
      // Read the audio file
      this.notifyProgress({
        status: 'uploading',
        progress: 10,
        message: 'Reading audio file...',
      })

      const fileInfo = await FileSystem.getInfoAsync(audioUri)
      if (!fileInfo.exists) {
        throw new Error('Audio file not found')
      }

      this.notifyProgress({
        status: 'uploading',
        progress: 40,
        message: 'Uploading to server...',
      })

      // Create FormData and add file directly
      const formData = new FormData()

      // Append file directly without converting to blob first
      // FormData will handle base64 encoding properly
      formData.append('audio', {
        uri: audioUri,
        type: 'audio/mp4',
        name: 'audio.m4a',
      } as any)
      formData.append('removalType', options.removalType)
      console.log('📦 Sending removalType:', options.removalType)
      
      if (options.instrument) {
        formData.append('instrument', options.instrument)
        console.log('🎸 Sending instrument:', options.instrument)
      } else {
        console.log('🎸 No instrument specified')
      }

      this.notifyProgress({
        status: 'processing',
        progress: 50,
        message: `Processing audio (${options.removalType})...`,
      })


      try {
        const url = `${this.apiBaseUrl}/api/remove-vocal-instrument`
        console.log('📤 Sending request to:', url)
        console.log('📦 File size:', audioUri, 'Type:', options.removalType)

        const uploadResponse = await fetch(url, {
          method: 'POST',
          body: formData,
        })

        console.log('📥 Response status:', uploadResponse.status)

        if (!uploadResponse.ok) {
          const errorData = await uploadResponse.json().catch(() => ({ error: `HTTP ${uploadResponse.status}` }))
          throw new Error(
            errorData.error || `HTTP ${uploadResponse.status}: Audio processing failed`
          )
        }

        this.notifyProgress({
          status: 'downloading',
          progress: 85,
          message: 'Downloading processed audio...',
        })

        // Parse response as JSON (server returns base64-encoded audio)
        console.log('📥 Parsing JSON response...')
        let responseData
        try {
          responseData = await uploadResponse.json()
          console.log('✅ JSON parsed successfully')
        } catch (jsonErr) {
          console.error('❌ JSON Parse error:', jsonErr)
          const text = await uploadResponse.text()
          console.error('   Response text (first 500 chars):', text.substring(0, 500))
          throw new Error('Server response was not valid JSON: ' + jsonErr)
        }
        
        if (!responseData.audioBase64) {
          throw new Error('Server did not return processed audio data')
        }

        console.log('📊 Received audio size:', responseData.audioBase64.length, 'bytes (base64)')

        // Save to app cache directory
        const fileName = `removed-${options.removalType}-${Date.now()}.m4a`
        const cacheDir = FileSystem.cacheDirectory || FileSystem.documentDirectory
        let outputPath = `${cacheDir}${fileName}`

        console.log('💾 Saving to:', outputPath)

        // Write base64 data directly to file
        await FileSystem.writeAsStringAsync(
          outputPath,
          responseData.audioBase64,
          { encoding: FileSystem.EncodingType.Base64 }
        )

        // Verify file was written
        const fileInfo = await FileSystem.getInfoAsync(outputPath)
        if (!fileInfo.exists) {
          throw new Error('Failed to write audio file to cache')
        }
        console.log('✅ File written successfully, size:', fileInfo.size, 'bytes')
        
        // Ensure proper file:// URI format for Audio.Sound
        if (!outputPath.startsWith('file://')) {
          outputPath = `file://${outputPath}`
        }
        console.log('🔗 Audio URI for playback:', outputPath)

        this.notifyProgress({
          status: 'completed',
          progress: 100,
          message: 'Audio processing completed!',
        })

        return outputPath
      } finally {
      }
    } catch (error) {
      const errorMessage = 
        error instanceof Error && error.message === 'AbortError'
          ? 'Request timeout - server took too long to respond'
          : error instanceof Error 
            ? error.message 
            : 'Unknown error occurred'
      
      this.notifyProgress({
        status: 'error',
        progress: 0,
        message: errorMessage,
      })
      throw error
    }
  }

  /**
   * Load processed audio for playback
   */
  async loadAudio(uri: string): Promise<void> {
    try {
      console.log('🔊 Loading audio from:', uri)
      
      if (this.sound) {
        await this.sound.unloadAsync()
      }

      this.sound = new Audio.Sound()
      await this.sound.loadAsync({ uri })
      console.log('✅ Audio loaded successfully')
    } catch (error) {
      console.error('❌ Error loading audio:', error)
      throw error
    }
  }

  /**
   * Play audio
   */
  async play(): Promise<void> {
    try {
      console.log('▶️ Playing audio...')
      if (this.sound) {
        await this.sound.playAsync()
        console.log('✅ Audio playing')
      } else {
        console.error('❌ No audio loaded to play')
      }
    } catch (error) {
      console.error('❌ Error playing audio:', error)
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
   * Get playback status
   */
  async getStatus() {
    try {
      if (this.sound) {
        return await this.sound.getStatusAsync()
      }
    } catch (error) {
      console.error('Error getting audio status:', error)
    }
  }

  /**
   * Subscribe to playback status updates
   */
  subscribeToStatusUpdates(
  callback: (status: AVPlaybackStatus) => void
) {
  if (this.sound) {
    this.sound.setOnPlaybackStatusUpdate(callback)
  }
}

  /**
   * Cleanup
   */
  async cleanup(): Promise<void> {
    try {
      await this.stop()
    } catch (error) {
      console.error('Error during cleanup:', error)
    }
  }

  /**
   * Set API base URL (useful for different environments)
   */
  setApiBaseUrl(url: string) {
    this.apiBaseUrl = url
  }
}

export default new AudioRemovalService()
