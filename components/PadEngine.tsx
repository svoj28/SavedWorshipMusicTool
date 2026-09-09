// components/PadEngine.tsx
//
// The pad, as far as the rest of the app is concerned.
//
// Mounted once, at the root, and never unmounted - which is the whole reason
// it lives here rather than on a screen. A pad exists to hold underneath
// whatever else is happening: you start it, then go and open the chord chart
// you are actually playing from. If the sound died the moment you navigated
// away it would be useless, so the WebView that makes the sound sits above
// the navigator and stays put.
//
// Screens do not talk to it directly. They go through padController, one
// shared object, so any screen can start the pad or change its key without
// anything being threaded down through props.

import React, { useCallback, useEffect, useRef, useState , useMemo} from 'react'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { AppState, View, StyleSheet } from 'react-native'
import { useAppTheme, type AppColors } from '../lib/theme'
import { WebView } from './EngineWebView'
import { Audio } from '../lib/audioCompat'
import { PAD_ENGINE_HTML } from '../lib/padEngineHtml'
import { PadSample, listPads, padForRoot } from '../lib/padLibrary'
import { crossfadeToFile, playFile, setFileVolume, stopFile } from '../lib/padFilePlayer'
import { DEFAULT_PAD_PRESET, isPadPresetId, PadPresetId } from '../lib/padPresets'

/** Where the sound comes from: the built-in synth, or the user's own files. */
export type PadSource = 'synth' | 'imported'

export interface PadState {
  /** The engine has loaded and will accept instructions */
  ready: boolean
  playing: boolean
  /** 0 = C, 1 = C#, up to 11 = B */
  root: number
  minor: boolean
  /** 0 to 1 */
  volume: number
  source: PadSource
  /** The built-in sound, also used for keys without an imported pad. */
  preset: PadPresetId
  /** The user's imported pads, as last read from storage */
  library: PadSample[]
}

type Listener = (state: PadState) => void

let state: PadState = {
  ready: false,
  playing: false,
  root: 0,
  minor: false,
  volume: 0.6,
  source: 'synth',
  preset: DEFAULT_PAD_PRESET,
  library: [],
}
let post: ((message: object) => void) | null = null
// The source actually requested can differ from the preference when an
// imported key is missing. Library edits alone do not change a playing sound.
let playingSource: PadSource | null = null
const PRESET_STORAGE_KEY = 'pad.preset.v1'
let presetSelectedByUser = false
let presetHydrationStarted = false
const listeners = new Set<Listener>()

function update(patch: Partial<PadState>) {
  state = { ...state, ...patch }
  listeners.forEach(l => l(state))
}

/**
 * Claim the audio session for the pad.
 *
 * Only the imported-file path used to do this, and only halfway. The synth
 * runs inside a WebView, but it plays through the same system audio session
 * the rest of the app configures - so without this, a pad held under a song
 * was liable to be ducked or interrupted by anything else the phone wanted to
 * play, and to stop the moment the screen locked. Both are heard as the pad
 * briefly dropping out and coming back.
 *
 * Asked for once. The session outlives any one sound, and re-setting it while
 * something is playing is itself a small interruption.
 */
let audioSessionClaimed = false
async function claimAudioSession(): Promise<void> {
  if (audioSessionClaimed) return
  audioSessionClaimed = true
  try {
    await Audio.setAudioModeAsync({
      // Somebody will always have left the ringer switch on without thinking
      // about it, and a silent pad in the middle of a service is no use.
      playsInSilentModeIOS: true,
      // A pad is meant to keep holding while the phone is locked and the
      // player is looking at their own music.
      staysActiveInBackground: true,
    })
  } catch {
    // Not fatal - it only means the pad is subject to the default session.
    audioSessionClaimed = false
  }
}

/**
 * The pad's controls, shared across the whole app.
 *
 * Deliberately a plain object rather than a context: the pad outlives every
 * screen that touches it, and nothing renders differently because of it
 * except the screen that happens to be showing its controls.
 */
export const padController = {
  getState(): PadState {
    return state
  },

  subscribe(listener: Listener): () => void {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },

  /** Re-read the imported pads from storage. */
  async refreshLibrary(): Promise<PadSample[]> {
    const library = await listPads()
    update({ library })
    return library
  },

  /**
   * Which source to sound.
   *
   * An imported pad is only used when the user has actually given one for
   * this key. Otherwise the synth covers it - falling silent because a file
   * is missing would be the worst of both.
   */
  fileFor(root: number): PadSample | null {
    if (state.source !== 'imported') return null
    return padForRoot(state.library, root)
  },

  /** Start the pad, or move it to this key if it is already sounding. */
  play(root: number, minor: boolean) {
    update({ root, minor, playing: true })
    void claimAudioSession()

    const file = padController.fileFor(root)
    if (file) {
      playingSource = 'imported'
      post?.({ type: 'stop' })
      void playFile(file.uri, state.volume)
    } else {
      playingSource = 'synth'
      void stopFile()
      post?.({ type: 'start', root, minor, volume: state.volume, preset: state.preset })
    }
  },

  /** Change key. Whichever source is sounding crossfades; it does not stop. */
  setKey(root: number, minor: boolean) {
    update({ root, minor })
    if (!state.playing) return

    const file = padController.fileFor(root)

    if (file) {
      playingSource = 'imported'
      // Coming from the synth, the synth fades out while the file fades in -
      // the two overlap, so there is still no gap when the source changes.
      post?.({ type: 'stop' })
      void crossfadeToFile(file.uri, state.volume)
    } else {
      playingSource = 'synth'
      void stopFile()
      post?.({ type: 'setKey', root, minor, preset: state.preset })
    }
  },

  /** Switch between the synth and the user's own pads. */
  setSource(source: PadSource) {
    if (source === state.source) return
    update({ source })
    if (state.playing) padController.setKey(state.root, state.minor)
  },

  /** Choose a built-in sound without starting playback or touching a file. */
  setPreset(preset: PadPresetId) {
    if (!isPadPresetId(preset)) return
    // Even choosing the default before storage resolves is a deliberate pick.
    presetSelectedByUser = true
    void AsyncStorage.setItem(PRESET_STORAGE_KEY, preset).catch(() => {})
    if (preset === state.preset) return
    update({ preset })
    if (playingSource === 'synth') post?.({ type: 'setPreset', preset })
  },

  setVolume(volume: number) {
    const clamped = Math.max(0, Math.min(1, volume))
    update({ volume: clamped })
    post?.({ type: 'setVolume', volume: clamped })
    void setFileVolume(clamped)
  },

  stop() {
    playingSource = null
    update({ playing: false })
    post?.({ type: 'stop' })
    void stopFile()
  },

  toggle(root: number, minor: boolean) {
    if (state.playing) padController.stop()
    else padController.play(root, minor)
  },
}

/** Follow the pad's state from a screen. */
export function usePadState(): PadState {
  const [local, setLocal] = useState<PadState>(padController.getState())
  useEffect(() => padController.subscribe(setLocal), [])
  return local
}

export default function PadEngine() {
  const { colors: c } = useAppTheme()
  const styles = useMemo(() => makeStyles(c), [c])

  const webRef = useRef<WebView>(null)

  useEffect(() => {
    post = (message: object) => webRef.current?.postMessage(JSON.stringify(message))
    // Read the user's own pads once at startup, so a key change can reach for
    // one without waiting on storage
    void padController.refreshLibrary()
    if (!presetHydrationStarted) {
      presetHydrationStarted = true
      void AsyncStorage.getItem(PRESET_STORAGE_KEY).then(preset => {
        // A slow storage read must never undo a sound the user just selected.
        if (presetSelectedByUser || !isPadPresetId(preset)) return
        update({ preset })
        if (playingSource === 'synth') post?.({ type: 'setPreset', preset })
      }).catch(() => {})
    }
    // Coming back to the foreground is the one moment we know the WebView may
    // have been frozen while it was away - frozen deeply enough that none of
    // its own listeners ran. Poke it, and let it check its own context.
    const appState = AppState.addEventListener('change', next => {
      if (next === 'active' && state.playing) post?.({ type: 'resume' })
    })

    return () => {
      appState.remove()
      post = null
    }
  }, [])

  const handleMessage = useCallback((event: any) => {
    let msg: any
    try {
      msg = JSON.parse(event.nativeEvent.data)
    } catch {
      return
    }

    switch (msg.type) {
      case 'ready':
        update({ ready: true })
        // Selections made before the WebView was ready still take effect.
        post?.({ type: 'setPreset', preset: state.preset })
        post?.({ type: 'setVolume', volume: state.volume })
        if (playingSource === 'synth') {
          post?.({ type: 'start', root: state.root, minor: state.minor, volume: state.volume, preset: state.preset })
        }
        break
      case 'started':
        if (playingSource === 'synth') update({ playing: true })
        break
      case 'stopped':
        // The outgoing synth also acknowledges stopping when a file takes
        // over. Late acknowledgments must not undo a newer play request.
        if (playingSource === null) update({ playing: false })
        break
      case 'context':
        // Only worth a line in the log: the engine has already put itself
        // back by the time this arrives. It is here because a pad that keeps
        // dropping out is otherwise silent about why.
        if (msg.state !== 'running') console.log('[PadEngine] audio context', msg.state)
        break
      case 'error':
        console.log('[PadEngine]', msg.message)
        if (playingSource === 'synth') {
          playingSource = null
          update({ playing: false })
        }
        break
      default:
        break
    }
  }, [])

  return (
    <View style={styles.host} pointerEvents="none">
      <WebView
        ref={webRef}
        source={{ html: PAD_ENGINE_HTML }}
        originWhitelist={['*']}
        onMessage={handleMessage}
        javaScriptEnabled
        domStorageEnabled
        // Web Audio has to be allowed to sound without a tap inside the page
        mediaPlaybackRequiresUserAction={false}
        allowsInlineMediaPlayback
        androidLayerType="software"
        onError={() => console.log('[PadEngine] failed to load')}
        style={styles.web}
      />
    </View>
  )
}

const makeStyles = (c: AppColors) => StyleSheet.create({
  // Laid out but invisible, rather than display:none - a WebView that is not
  // laid out is free to stop its audio, which is the one thing this must not
  // do. The same trick the pitch engine uses.
  host: { position: 'absolute', width: 1, height: 1, opacity: 0, top: 0, left: 0 },
  web: { width: 1, height: 1, backgroundColor: 'transparent' },
})
