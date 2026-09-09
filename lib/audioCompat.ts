import {
  createAudioPlayer,
  setAudioModeAsync as setExpoAudioModeAsync,
  type AudioPlayer as ExpoAudioPlayer,
  type AudioSource,
  type AudioStatus,
} from 'expo-audio'

export type AVPlaybackStatus =
  | { isLoaded: false; error?: string }
  | {
      isLoaded: true
      isPlaying: boolean
      isBuffering: boolean
      didJustFinish: boolean
      durationMillis: number
      positionMillis: number
      rate: number
      shouldCorrectPitch: boolean
      volume: number
    }

type PlaybackStatus = {
  shouldPlay?: boolean
  isLooping?: boolean
  volume?: number
  positionMillis?: number
  rate?: number
  shouldCorrectPitch?: boolean
}

type StatusSubscription = { remove(): void }
type StatusEventPlayer = ExpoAudioPlayer & {
  addListener(
    event: 'playbackStatusUpdate',
    listener: (status: AudioStatus) => void,
  ): StatusSubscription
}

function toSource(source: AudioSource | { uri: string }): AudioSource {
  return source
}

function addPlaybackStatusListener(
  player: ExpoAudioPlayer,
  listener: (status: AudioStatus) => void,
): StatusSubscription {
  return (player as StatusEventPlayer).addListener('playbackStatusUpdate', listener)
}

export namespace Audio {
  export class Sound {
    private player: ExpoAudioPlayer | null = null
    private statusSubscription: StatusSubscription | null = null
    private statusCallback: ((status: AVPlaybackStatus) => void) | null = null
    private volume = 1

    static async createAsync(
      source: AudioSource | { uri: string },
      initialStatus: PlaybackStatus = {},
    ): Promise<{ sound: Sound; status: AVPlaybackStatus }> {
      const sound = new Sound()
      const status = await sound.loadAsync(source, initialStatus)
      return { sound, status }
    }

    async loadAsync(
      source: AudioSource | { uri: string },
      initialStatus: PlaybackStatus = {},
    ): Promise<AVPlaybackStatus> {
      await this.unloadAsync()

      const player = createAudioPlayer(toSource(source), { updateInterval: 100 })
      this.player = player
      await this.waitUntilLoaded(player)

      player.loop = initialStatus.isLooping ?? false
      this.volume = initialStatus.volume ?? 1
      player.volume = this.volume
      player.shouldCorrectPitch = initialStatus.shouldCorrectPitch ?? true

      if (initialStatus.rate !== undefined) {
        player.playbackRate = initialStatus.rate
      }
      if (initialStatus.positionMillis !== undefined) {
        await player.seekTo(initialStatus.positionMillis / 1000)
      }

      this.attachStatusListener()
      if (initialStatus.shouldPlay) player.play()

      return this.getStatusAsync()
    }

    async playAsync(): Promise<AVPlaybackStatus> {
      this.requirePlayer().play()
      return this.getStatusAsync()
    }

    async pauseAsync(): Promise<AVPlaybackStatus> {
      this.requirePlayer().pause()
      return this.getStatusAsync()
    }

    async stopAsync(): Promise<AVPlaybackStatus> {
      const player = this.requirePlayer()
      player.pause()
      await player.seekTo(0)
      return this.getStatusAsync()
    }

    async replayAsync(): Promise<AVPlaybackStatus> {
      const player = this.requirePlayer()
      // Do not put an async round trip between the scheduler tick and play().
      // expo-audio queues these native commands in order, while awaiting the
      // seek here adds variable bridge latency that makes a metronome wobble.
      void player.seekTo(0)
      player.play()
      return this.getStatusAsync()
    }

    async unloadAsync(): Promise<AVPlaybackStatus> {
      this.statusSubscription?.remove()
      this.statusSubscription = null

      if (this.player) {
        this.player.pause()
        this.player.remove()
        this.player = null
      }

      return { isLoaded: false }
    }

    async setPositionAsync(positionMillis: number): Promise<AVPlaybackStatus> {
      await this.requirePlayer().seekTo(positionMillis / 1000)
      return this.getStatusAsync()
    }

    async setVolumeAsync(volume: number): Promise<AVPlaybackStatus> {
      this.volume = Math.max(0, Math.min(1, volume))
      this.requirePlayer().volume = this.volume
      return this.getStatusAsync()
    }

    async setRateAsync(rate: number, shouldCorrectPitch = true): Promise<AVPlaybackStatus> {
      const player = this.requirePlayer()
      player.shouldCorrectPitch = shouldCorrectPitch
      player.playbackRate = rate
      return this.getStatusAsync()
    }

    async getStatusAsync(): Promise<AVPlaybackStatus> {
      const player = this.player
      if (!player) return { isLoaded: false }
      return this.toPlaybackStatus(player.currentStatus)
    }

    setOnPlaybackStatusUpdate(callback: ((status: AVPlaybackStatus) => void) | null): void {
      this.statusCallback = callback
      this.attachStatusListener()
    }

    private requirePlayer(): ExpoAudioPlayer {
      if (!this.player) throw new Error('Audio is not loaded')
      return this.player
    }

    private attachStatusListener(): void {
      this.statusSubscription?.remove()
      this.statusSubscription = null
      if (!this.player || !this.statusCallback) return

      this.statusSubscription = addPlaybackStatusListener(this.player, status => {
        this.statusCallback?.(this.toPlaybackStatus(status))
      })
    }

    private toPlaybackStatus(status: AudioStatus): AVPlaybackStatus {
      if (!status.isLoaded) {
        return { isLoaded: false, error: status.error ?? undefined }
      }

      return {
        isLoaded: true,
        isPlaying: status.playing,
        isBuffering: status.isBuffering,
        didJustFinish: status.didJustFinish,
        durationMillis: Math.round(status.duration * 1000),
        positionMillis: Math.round(status.currentTime * 1000),
        rate: status.playbackRate,
        shouldCorrectPitch: status.shouldCorrectPitch,
        volume: this.volume,
      }
    }

    private async waitUntilLoaded(player: ExpoAudioPlayer): Promise<void> {
      if (player.isLoaded) return

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          subscription.remove()
          reject(new Error('Timed out while loading audio'))
        }, 15000)

        const subscription = addPlaybackStatusListener(player, status => {
          if (status.error) {
            clearTimeout(timeout)
            subscription.remove()
            reject(new Error(status.error))
          } else if (status.isLoaded) {
            clearTimeout(timeout)
            subscription.remove()
            resolve()
          }
        })
      })
    }
  }

  export async function setAudioModeAsync(mode: {
    playsInSilentModeIOS?: boolean
    staysActiveInBackground?: boolean
  }): Promise<void> {
    await setExpoAudioModeAsync({
      ...(mode.playsInSilentModeIOS !== undefined
        ? { playsInSilentMode: mode.playsInSilentModeIOS }
        : {}),
      ...(mode.staysActiveInBackground !== undefined
        ? { shouldPlayInBackground: mode.staysActiveInBackground }
        : {}),
    })
  }
}
