// components/PitchAudioEngine.tsx
//
// Hidden WebView that hosts the Web Audio pitch engine (lib/pitchEngineHtml).
//
// Pitch shifting needs raw PCM, which React Native has no decoder for. The
// WebView supplies the platform decoder and Web Audio, so the song can be
// re-pitched WITHOUT changing its speed - and the same decoded samples drive
// key detection. Audio keeps playing while the view is invisible.

import React, { forwardRef, useCallback, useImperativeHandle, useRef , useMemo} from 'react'
import { View, StyleSheet } from 'react-native'
import { useAppTheme, type AppColors } from '../lib/theme'
import { WebView } from './EngineWebView'
import * as FileSystem from 'expo-file-system/legacy'
import { PITCH_ENGINE_HTML } from '../lib/pitchEngineHtml'

// Base64 is handed over the bridge in pieces so a long song never arrives as
// one enormous string.
const CHUNK_SIZE = 131072

export interface DetectedKey {
  /** Full key name, e.g. "Bb" or "Em" */
  key: string
  /** Tonic on its own, e.g. "Bb" or "E" */
  root: string
  minor: boolean
  /** 0-100 */
  confidence: number
}

/** One separable part of the mix, as reported by the engine. */
export interface StemPart {
  id: 'vocals' | 'bass' | 'drums' | 'harmonic'
  /** 0-100, how much of it is in the mix */
  level: number
  present: boolean
  /** Set when the part cannot be removed, e.g. vocals in a mono file */
  note: string
}

export interface StemReport {
  stereo: boolean
  parts: StemPart[]
}

export interface RemovalFlags {
  vocals?: boolean
  bass?: boolean
  drums?: boolean
  harmonic?: boolean
}

export interface EngineStatus {
  isPlaying: boolean
  /** seconds */
  position: number
  /** seconds */
  duration: number
}

export interface PitchAudioEngineHandle {
  load: (uri: string) => Promise<void>
  play: () => void
  pause: () => void
  stop: () => void
  seek: (seconds: number) => void
  setSemitones: (semitones: number) => void
  setTempo: (factor: number) => void
  detectKey: () => void
  analyzeStems: () => void
  setRemoval: (flags: RemovalFlags) => void
}

interface Props {
  onReady?: () => void
  onLoaded?: (info: { duration: number; sampleRate: number; channels: number }) => void
  onStatus?: (status: EngineStatus) => void
  onKeyDetected?: (key: DetectedKey) => void
  onStems?: (report: StemReport) => void
  onEnded?: () => void
  onError?: (message: string) => void
  /** True while the engine renders a new pitch/tempo, false when it is ready */
  onProcessing?: (busy: boolean) => void
}

export const PitchAudioEngine = forwardRef<PitchAudioEngineHandle, Props>(function PitchAudioEngine(
  { onReady, onLoaded, onStatus, onKeyDetected, onStems, onEnded, onError, onProcessing },
  ref,
) {
  const { colors: c } = useAppTheme()
  const styles = useMemo(() => makeStyles(c), [c])
  const webRef = useRef<WebView>(null)

  const post = useCallback((message: object) => {
    const payload = JSON.stringify(JSON.stringify(message))
    // A MessageEvent is what the engine listens for on both platforms
    webRef.current?.injectJavaScript(
      `window.dispatchEvent(new MessageEvent('message', { data: ${payload} })); true;`,
    )
  }, [])

  useImperativeHandle(
    ref,
    () => ({
      async load(uri: string) {
        const base64 = await FileSystem.readAsStringAsync(uri, {
          encoding: FileSystem.EncodingType.Base64,
        })
        post({ type: 'load-start' })
        for (let offset = 0; offset < base64.length; offset += CHUNK_SIZE) {
          post({ type: 'load-chunk', data: base64.slice(offset, offset + CHUNK_SIZE) })
        }
        post({ type: 'load-end' })
      },
      play() { post({ type: 'play' }) },
      pause() { post({ type: 'pause' }) },
      stop() { post({ type: 'stop' }) },
      seek(seconds: number) { post({ type: 'seek', seconds }) },
      setSemitones(semitones: number) { post({ type: 'set-pitch', semitones }) },
      setTempo(factor: number) { post({ type: 'set-tempo', tempo: factor }) },
      detectKey() { post({ type: 'detect-key' }) },
      analyzeStems() { post({ type: 'analyze-stems' }) },
      setRemoval(flags: RemovalFlags) {
        post({
          type: 'set-removal',
          vocals: !!flags.vocals, bass: !!flags.bass,
          drums: !!flags.drums, harmonic: !!flags.harmonic,
        })
      },
    }),
    [post],
  )

  const handleMessage = useCallback(
    (event: any) => {
      let msg: any
      try {
        msg = JSON.parse(event.nativeEvent.data)
      } catch {
        return
      }

      switch (msg.type) {
        case 'ready':
          onReady?.()
          break
        case 'loaded':
          onLoaded?.({ duration: msg.duration, sampleRate: msg.sampleRate, channels: msg.channels })
          break
        case 'status':
          onStatus?.({ isPlaying: !!msg.isPlaying, position: msg.position || 0, duration: msg.duration || 0 })
          break
        case 'key':
          onKeyDetected?.({
            key: msg.key,
            root: msg.root,
            minor: !!msg.minor,
            confidence: msg.confidence || 0,
          })
          break
        case 'stems':
          onStems?.({ stereo: !!msg.stereo, parts: msg.parts || [] })
          break
        case 'rendering':
          onProcessing?.(true)
          break
        case 'rendered':
          onProcessing?.(false)
          break
        case 'ended':
          onEnded?.()
          break
        case 'error':
          onProcessing?.(false)
          onError?.(msg.message || 'Audio engine error')
          break
        default:
          break
      }
    },
    [onReady, onLoaded, onStatus, onKeyDetected, onStems, onEnded, onError, onProcessing],
  )

  return (
    <View style={styles.host} pointerEvents="none">
      <WebView
        ref={webRef}
        source={{ html: PITCH_ENGINE_HTML }}
        originWhitelist={['*']}
        onMessage={handleMessage}
        javaScriptEnabled
        domStorageEnabled
        // Web Audio must be allowed to start without a tap inside the page
        mediaPlaybackRequiresUserAction={false}
        allowsInlineMediaPlayback
        androidLayerType="software"
        onError={() => onError?.('Audio engine failed to load')}
        style={styles.web}
      />
    </View>
  )
})

const makeStyles = (c: AppColors) => StyleSheet.create({
  // Kept mounted and laid out (not display:none) so audio keeps running,
  // but effectively invisible.
  host: { position: 'absolute', width: 1, height: 1, opacity: 0, top: 0, left: 0 },
  web: { width: 1, height: 1, backgroundColor: 'transparent' },
})
