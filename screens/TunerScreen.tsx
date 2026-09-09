// screens/TunerScreen.tsx
//
// The tuner: what frequency is sounding right now, how far it is from the
// note you are aiming at, and which way to turn the peg to close the gap.
//
// The listening and the scrolling picture both happen inside the WebView (see
// lib/tunerEngineHtml.ts) - React Native cannot read the microphone sample by
// sample, and a canvas scrolling a pixel a frame is far cheaper in there than
// pushing pixels across the bridge would be. This screen owns the parts that
// have to be native: asking for the microphone, showing the reading, and
// making sure the microphone is released the moment the screen is left.

import React, { useCallback, useEffect, useRef, useState, useMemo } from 'react'
import {
  ActivityIndicator,
  AppState,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native'
import { useAppTheme, type AppColors } from '../lib/theme'
import { WebView } from '../components/EngineWebView'
import { useFocusEffect } from '@react-navigation/native'
import Ionicons from '@expo/vector-icons/Ionicons'
import { requestRecordingPermissionsAsync } from 'expo-audio'
import { TUNER_ENGINE_HTML } from '../lib/tunerEngineHtml'
import { useKeepScreenAwake } from '../lib/useKeepScreenAwake'

/** How long a reading stays up after the sound has died away. */
const HOLD_MS = 1200
const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B']

/** Inside this many cents the note counts as tuned. */
const IN_TUNE_CENTS = 5
/** Inside this many cents it is close enough to be worth saying so. */
const CLOSE_CENTS = 15
/** How far the needle can swing either way before it pins to the end. */
const METER_RANGE_CENTS = 50

/**
 * The octaves offered for the chromatic notes.
 *
 * One octave was not enough to tune by ear from: a guitar's low E and a
 * soprano's top A are three octaves apart, and a note played far outside your
 * own range is hard to match against. These cover the instruments the app is
 * used with, with 4 in the middle as the default.
 */
const REFERENCE_OCTAVES = [2, 3, 4, 5]

/**
 * The tunings offered.
 *
 * Picking your instrument is the difference between hunting for the right note
 * among twelve and tapping the string you are about to turn - and with a
 * tuning chosen, the tuner snaps to the nearest string on its own, so a badly
 * flat string still reads against the string you meant rather than against
 * whatever semitone it happens to be nearest.
 *
 * Strings are MIDI numbers. Chromatic has none: it aims at whatever twelve-tone
 * note is nearest, which is what you want when the instrument is not listed.
 */
type Tuning = { id: string; name: string; strings: number[] | null }
const TUNINGS: Tuning[] = [
  { id: 'chromatic', name: 'Chromatic', strings: null },
  { id: 'guitar', name: 'Guitar', strings: [40, 45, 50, 55, 59, 64] },
  { id: 'bass', name: 'Bass', strings: [28, 33, 38, 43] },
  { id: 'ukulele', name: 'Ukulele', strings: [67, 60, 64, 69] },
]

/** Concert pitch of a MIDI note. A4 (69) is 440 Hz. */
function midiFrequency(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12)
}

function midiLabel(midi: number): string {
  return `${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`
}

/** How far a frequency is from a note, in cents. Positive is sharp. */
function centsFrom(hz: number, midi: number): number {
  return 1200 * Math.log2(hz / midiFrequency(midi))
}

/** The MIDI note a frequency is nearest to, anywhere on the keyboard. */
function nearestMidi(hz: number): number {
  return Math.round(69 + 12 * Math.log2(hz / 440))
}

export default function TunerScreen() {
  const { colors: c } = useAppTheme()
  const styles = useMemo(() => makeStyles(c), [c])

  const [hz, setHz] = useState(0)
  const [listening, setListening] = useState(false)
  const [error, setError] = useState('')
  const [asking, setAsking] = useState(true)
  const [engineLoaded, setEngineLoaded] = useState(false)
  const [playingMidi, setPlayingMidi] = useState<number | null>(null)
  const [referenceOctave, setReferenceOctave] = useState(4)
  const [tuningId, setTuningId] = useState('chromatic')
  // null means "aim at whichever note is nearest" - the mode you leave it in
  // for a quick pass over all six strings. Tapping a note pins it, for when a
  // string is so far out that the nearest note is not the one you meant.
  const [targetMidi, setTargetMidi] = useState<number | null>(null)

  // Tuning is done with both hands on the instrument, so the screen must not
  // time out between one string and the next.
  useKeepScreenAwake(listening, 'tuner')

  const webRef = useRef<WebView>(null)
  // The engine loading and the permission answer arrive in either order, so
  // both are tracked and the tuner starts on whichever lands second.
  const engineReady = useRef(false)
  const allowed = useRef(false)
  const wantsToListen = useRef(false)
  const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const referenceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const post = useCallback((msg: object) => {
    webRef.current?.postMessage(JSON.stringify(msg))
  }, [])

  // The picture is drawn inside the WebView, which knows nothing about the
  // app's theme unless it is told. Without this the note names down the side
  // were always white on black - a slab of night in the middle of a pale
  // screen, and the labels the tuner is actually read from were the part
  // that suffered for it.
  const engineTheme = useMemo(
    () => ({
      bg: c.surfaceAlt,
      text: c.text,
      line: c.border,
      dark: c.statusBar === 'light',
    }),
    [c],
  )

  // Sent on every theme change, and again whenever the engine reloads.
  useEffect(() => {
    if (engineLoaded) post({ type: 'theme', theme: engineTheme })
  }, [engineLoaded, engineTheme, post])

  const startIfReady = useCallback(() => {
    if (engineReady.current && allowed.current && wantsToListen.current) post({ type: 'start' })
  }, [post])

  const stopListening = useCallback(() => {
    wantsToListen.current = false
    post({ type: 'stop' })
  }, [post])

  const askForMicrophone = useCallback(async () => {
    setAsking(true)
    setError('')
    try {
      const { granted } = await requestRecordingPermissionsAsync()
      allowed.current = granted
      if (!granted) {
        setError('The tuner needs the microphone. Allow it in your phone settings, then try again.')
      } else {
        startIfReady()
      }
    } catch {
      setError('The microphone could not be reached on this device.')
    } finally {
      setAsking(false)
    }
  }, [startIfReady])

  // Listen only while the screen is actually in front of the user. Leaving it
  // - for another screen, or out of the app entirely - lets the microphone go.
  useFocusEffect(
    useCallback(() => {
      wantsToListen.current = true
      askForMicrophone()

      const subscription = AppState.addEventListener('change', state => {
        if (state === 'active') {
          wantsToListen.current = true
          startIfReady()
        } else {
          stopListening()
        }
      })

      return () => {
        subscription.remove()
        stopListening()
      }
    }, [askForMicrophone, startIfReady, stopListening]),
  )

  useEffect(
    () => () => {
      if (clearTimer.current) clearTimeout(clearTimer.current)
      if (referenceTimer.current) clearTimeout(referenceTimer.current)
    },
    [],
  )

  const handleMessage = useCallback((event: any) => {
    let msg: any
    try {
      msg = JSON.parse(event.nativeEvent.data)
    } catch {
      return
    }

    switch (msg.type) {
      case 'ready':
        engineReady.current = true
        setEngineLoaded(true)
        if (allowed.current && wantsToListen.current) {
          webRef.current?.postMessage(JSON.stringify({ type: 'start' }))
        }
        break

      case 'started':
        setListening(true)
        setError('')
        break

      case 'stopped':
        setListening(false)
        setHz(0)
        break

      case 'pitch':
        if (msg.hz > 0) {
          setHz(msg.hz)
          // Hold the last reading for a moment, so it does not blink out
          // between one pluck and the next while the string rings down.
          if (clearTimer.current) clearTimeout(clearTimer.current)
          clearTimer.current = setTimeout(() => setHz(0), HOLD_MS)
        }
        break

      case 'error':
        // The detail says which problem this really was - refused, or never
        // able to ask - which is the difference between a settings fix and a
        // code fix, and is invisible from the message alone.
        console.log(
          '[Tuner] engine error:', msg.message,
          '| detail:', msg.detail,
          '| secureContext:', msg.secure,
          '| origin:', msg.origin,
        )
        setError(msg.message || 'The tuner could not start')
        setListening(false)
        break

      default:
        break
    }
  }, [])

  const tuning = useMemo(
    () => TUNINGS.find(t => t.id === tuningId) ?? TUNINGS[0],
    [tuningId],
  )

  /**
   * The notes offered as targets: the strings of the chosen tuning, or the
   * twelve chromatic notes in the chosen octave when there is no tuning.
   */
  const targets = useMemo(
    () => tuning.strings ?? NOTE_NAMES.map((_, i) => (referenceOctave + 1) * 12 + i),
    [tuning, referenceOctave],
  )

  /**
   * What the reading is being measured against. A pinned note wins; otherwise
   * the nearest string of the tuning, or - chromatically - the nearest note
   * anywhere.
   */
  const aim = useMemo(() => {
    if (targetMidi !== null) return targetMidi
    if (!(hz > 0)) return null
    if (!tuning.strings) return nearestMidi(hz)
    return tuning.strings.reduce((best, midi) =>
      Math.abs(centsFrom(hz, midi)) < Math.abs(centsFrom(hz, best)) ? midi : best,
    )
  }, [targetMidi, hz, tuning])

  const cents = aim !== null && hz > 0 ? centsFrom(hz, aim) : null
  const inTune = cents !== null && Math.abs(cents) <= IN_TUNE_CENTS

  // An octave out reads as wildly flat or sharp, which is true but unhelpful -
  // no amount of turning the peg fixes a note being played in the wrong
  // octave. Say so instead.
  const wrongOctave = cents !== null && Math.abs(cents) > 600

  const status = useMemo(() => {
    if (cents === null) return { text: 'Play a note', tone: c.textSub as string, arrow: null }
    if (wrongOctave) {
      return {
        text: cents > 0 ? 'An octave too high' : 'An octave too low',
        tone: c.warning as string,
        arrow: null,
      }
    }
    if (Math.abs(cents) <= IN_TUNE_CENTS) {
      return { text: 'In tune', tone: c.success as string, arrow: null }
    }
    const rounded = Math.round(Math.abs(cents))
    const close = Math.abs(cents) <= CLOSE_CENTS
    return {
      text: cents < 0 ? `${rounded} cents flat` : `${rounded} cents sharp`,
      tone: (close ? c.warning : c.danger) as string,
      arrow: (cents < 0 ? 'arrow-up' : 'arrow-down') as 'arrow-up' | 'arrow-down',
    }
  }, [cents, wrongOctave, c])

  /** Where the needle sits, 0 (50 cents flat) to 1 (50 cents sharp). */
  const needle = cents === null
    ? 0.5
    : Math.min(1, Math.max(0, 0.5 + cents / (METER_RANGE_CENTS * 2)))

  const playReference = useCallback((midi: number) => {
    if (!engineReady.current) return
    post({ type: 'play-reference', frequency: midiFrequency(midi) })
    setPlayingMidi(midi)
    if (referenceTimer.current) clearTimeout(referenceTimer.current)
    referenceTimer.current = setTimeout(() => setPlayingMidi(null), 1200)
  }, [post])

  /**
   * Tapping a note pins it as the target; tapping the pinned one lets go
   * again. Hearing it is a separate gesture, so a tap never both changes what
   * you are tuning to and makes a noise over the string you are listening to.
   */
  const toggleTarget = useCallback((midi: number) => {
    setTargetMidi(current => (current === midi ? null : midi))
  }, [])

  const selectTuning = useCallback((id: string) => {
    setTuningId(id)
    setTargetMidi(null)
  }, [])

  return (
    <View style={styles.container}>
      <View style={styles.readout}>
        <View style={styles.noteRow}>
          <Text style={styles.note}>{aim !== null ? midiLabel(aim) : '—'}</Text>
          <TouchableOpacity
            style={[styles.hearButton, aim !== null && playingMidi === aim && styles.hearButtonActive]}
            onPress={() => aim !== null && playReference(aim)}
            disabled={!engineLoaded || aim === null}
            activeOpacity={0.75}
            accessibilityLabel="Hear this note"
          >
            <Ionicons
              name="volume-medium"
              size={18}
              color={aim !== null && playingMidi === aim ? c.accentText : c.text}
            />
          </TouchableOpacity>
        </View>

        {/* The meter, not the numbers, is what the tuning is read from: the
            needle leaves the middle the moment the note does, and which side
            it went is which way the peg turns. */}
        <View style={styles.meter}>
          <View style={styles.meterTrack}>
            {[0.1, 0.3, 0.7, 0.9].map(at => (
              <View key={at} style={[styles.tick, { left: `${at * 100}%` }]} />
            ))}
            <View style={styles.centreZone} />
            <View style={styles.centreLine} />
            {cents !== null && (
              <View
                style={[styles.needle, { left: `${needle * 100}%`, backgroundColor: status.tone }]}
              />
            )}
          </View>
          <View style={styles.meterLabels}>
            <Text style={styles.meterLabel}>♭ flat</Text>
            <Text style={styles.meterLabel}>sharp ♯</Text>
          </View>
        </View>

        <View style={styles.statusRow}>
          {status.arrow && <Ionicons name={status.arrow} size={15} color={status.tone} />}
          <Text style={[styles.status, { color: status.tone }]}>{status.text}</Text>
        </View>

        <Text style={styles.hz} numberOfLines={1}>
          {hz > 0 ? `${hz.toFixed(1)} Hz` : ' '}
        </Text>
      </View>

      <View style={styles.display}>
        <WebView
          ref={webRef}
          // The base URL matters more than it looks. A page loaded from a
          // plain HTML string has no real origin, and a browser only hands
          // out the microphone to a SECURE one - so without this,
          // navigator.mediaDevices is simply not there and the tuner cannot
          // ask for the microphone at all, however many times the user says
          // yes. Nothing is fetched from this address; it only gives the page
          // an https origin to live at.
          source={{ html: TUNER_ENGINE_HTML, baseUrl: 'https://localhost' }}
          originWhitelist={['*']}
          onMessage={handleMessage}
          javaScriptEnabled
          domStorageEnabled
          // Web Audio has to be allowed to start without a tap inside the page
          mediaPlaybackRequiresUserAction={false}
          allowsInlineMediaPlayback
          // iOS: let the page open the microphone without a second prompt
          mediaCapturePermissionGrantType="grant"
          scrollEnabled={false}
          onError={() => setError('The tuner display failed to load')}
          style={styles.web}
        />

        {(asking || (!listening && !error)) && (
          <View style={styles.overlay} pointerEvents="none">
            <ActivityIndicator size="small" color={c.text} />
            <Text style={styles.overlayText}>
              {asking ? 'Asking for the microphone…' : 'Starting the tuner…'}
            </Text>
          </View>
        )}

        {!!error && (
          <View style={styles.overlay}>
            <Ionicons name="mic-off-outline" size={22} color={c.danger} />
            <Text style={styles.overlayText}>{error}</Text>
            <TouchableOpacity style={styles.retry} onPress={askForMicrophone} activeOpacity={0.8}>
              <Text style={styles.retryText}>Try again</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>

      <View style={styles.picker}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.tuningRow}
        >
          {TUNINGS.map(t => (
            <TouchableOpacity
              key={t.id}
              style={[styles.tuningChip, tuningId === t.id && styles.tuningChipActive]}
              onPress={() => selectTuning(t.id)}
              activeOpacity={0.75}
            >
              <Text style={[styles.tuningChipText, tuningId === t.id && styles.tuningChipTextActive]}>
                {t.name}
              </Text>
            </TouchableOpacity>
          ))}
          {!tuning.strings && (
            <View style={styles.octaveBar}>
              {REFERENCE_OCTAVES.map(octave => (
                <TouchableOpacity
                  key={octave}
                  style={[styles.octaveButton, referenceOctave === octave && styles.octaveButtonActive]}
                  onPress={() => { setReferenceOctave(octave); setTargetMidi(null) }}
                  activeOpacity={0.75}
                >
                  <Text style={[styles.octaveButtonText, referenceOctave === octave && styles.octaveButtonTextActive]}>
                    {octave}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          )}
        </ScrollView>

        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.targetRow}>
          {targets.map(midi => {
            const pinned = targetMidi === midi
            const live = aim === midi && cents !== null
            return (
              <TouchableOpacity
                key={midi}
                style={[
                  styles.targetChip,
                  live && styles.targetChipLive,
                  live && inTune && { borderColor: c.success, backgroundColor: c.success },
                  pinned && styles.targetChipPinned,
                ]}
                onPress={() => toggleTarget(midi)}
                onLongPress={() => playReference(midi)}
                delayLongPress={220}
                activeOpacity={0.75}
              >
                <Text
                  style={[
                    styles.targetChipText,
                    (pinned || (live && inTune)) && styles.targetChipTextActive,
                  ]}
                >
                  {tuning.strings ? midiLabel(midi) : NOTE_NAMES[midi % 12]}
                </Text>
                {pinned && <Ionicons name="pin" size={11} color={c.accentText} />}
              </TouchableOpacity>
            )
          })}
        </ScrollView>
      </View>

      <Text style={styles.hint}>
        {targetMidi !== null
          ? `Locked to ${midiLabel(targetMidi)} — tap it again to follow whatever you play.`
          : 'Play one string at a time. Tap a note to lock onto it, hold it to hear it.'}
      </Text>
    </View>
  )
}

const makeStyles = (c: AppColors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.surfaceAlt },

  readout: {
    alignItems: 'center',
    paddingTop: 12,
    paddingBottom: 10,
    backgroundColor: c.surface,
  },
  noteRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  note: { fontSize: 52, fontWeight: '800', color: c.text, letterSpacing: -1.5 },
  hearButton: {
    width: 36, height: 36, borderRadius: 18,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: c.border, backgroundColor: c.surfaceAlt,
  },
  hearButtonActive: { backgroundColor: c.accent, borderColor: c.accent },

  meter: { alignSelf: 'stretch', paddingHorizontal: 20, marginTop: 8 },
  meterTrack: {
    height: 40,
    borderRadius: 8,
    backgroundColor: c.surfaceAlt,
    borderWidth: 1,
    borderColor: c.border,
    justifyContent: 'center',
    overflow: 'hidden',
  },
  tick: { position: 'absolute', width: 1, height: 9, backgroundColor: c.border },
  // The band the needle has to land in. Drawn rather than only described, so
  // "close enough" is something you can see rather than a number to compare.
  centreZone: {
    position: 'absolute',
    left: '45%', width: '10%', top: 0, bottom: 0,
    backgroundColor: c.success, opacity: 0.16,
  },
  centreLine: {
    position: 'absolute', left: '50%', width: 2, marginLeft: -1,
    top: 0, bottom: 0, backgroundColor: c.border,
  },
  needle: { position: 'absolute', width: 4, marginLeft: -2, top: 4, bottom: 4, borderRadius: 2 },
  meterLabels: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 },
  meterLabel: { fontSize: 10, fontWeight: '700', color: c.textSub },

  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 8 },
  status: { fontSize: 14, fontWeight: '800' },
  hz: {
    fontSize: 12,
    fontWeight: '600',
    color: c.textSub,
    marginTop: 2,
    fontVariant: ['tabular-nums'],
    ...Platform.select({ android: { fontFamily: 'sans-serif' }, default: {} }),
  },

  // The canvas paints itself in these same colours (see engineTheme above),
  // so what shows before it has loaded matches what replaces it.
  display: { flex: 1, minHeight: 90, backgroundColor: c.surfaceAlt },
  web: { flex: 1, backgroundColor: c.surfaceAlt },

  overlay: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    paddingHorizontal: 36,
    backgroundColor: c.surface,
  },
  overlayText: {
    fontSize: 13,
    fontWeight: '600',
    color: c.text,
    textAlign: 'center',
    lineHeight: 19,
  },
  retry: {
    marginTop: 4,
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: c.accent,
    backgroundColor: c.accent,
  },
  retryText: { fontSize: 13, fontWeight: '700', color: c.accentText },

  picker: { paddingTop: 10, backgroundColor: c.surface },
  tuningRow: { paddingHorizontal: 12, gap: 7, alignItems: 'center' },
  tuningChip: {
    paddingHorizontal: 13, paddingVertical: 7, borderRadius: 999,
    backgroundColor: c.surfaceAlt, borderWidth: 1, borderColor: c.border,
  },
  tuningChipActive: { backgroundColor: c.accent, borderColor: c.accent },
  tuningChipText: { fontSize: 12, fontWeight: '800', color: c.textSub },
  tuningChipTextActive: { color: c.accentText },

  octaveBar: {
    flexDirection: 'row', gap: 4, padding: 2, borderRadius: 8, marginLeft: 4,
    backgroundColor: c.surfaceAlt, borderWidth: 1, borderColor: c.border,
  },
  octaveButton: {
    minWidth: 26, paddingHorizontal: 6, paddingVertical: 4,
    borderRadius: 6, alignItems: 'center',
  },
  octaveButtonActive: { backgroundColor: c.accent },
  octaveButtonText: { fontSize: 12, fontWeight: '800', color: c.textSub },
  octaveButtonTextActive: { color: c.accentText },

  targetRow: { paddingHorizontal: 12, paddingTop: 8, paddingBottom: 11, gap: 7 },
  targetChip: {
    minWidth: 54, height: 40, paddingHorizontal: 9, borderRadius: 9,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 3,
    backgroundColor: c.surfaceAlt, borderWidth: 1.5, borderColor: c.border,
  },
  targetChipLive: { borderColor: c.accent },
  targetChipPinned: { backgroundColor: c.accent, borderColor: c.accent },
  targetChipText: { fontSize: 14, fontWeight: '800', color: c.text },
  targetChipTextActive: { color: c.accentText },

  hint: {
    fontSize: 11,
    fontWeight: '500',
    color: c.textSub,
    textAlign: 'center',
    lineHeight: 16,
    paddingHorizontal: 24,
    paddingVertical: 12,
  },
})
