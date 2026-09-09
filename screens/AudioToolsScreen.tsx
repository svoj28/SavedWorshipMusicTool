// screens/AudioToolsScreen.tsx
import React, { useState, useEffect, useRef, useCallback , useMemo} from 'react'
import {
  View,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
  SafeAreaView,
  KeyboardAvoidingView,
  Platform,
} from 'react-native'
import { useAppTheme, type AppColors } from '../lib/theme'
import Slider from '@react-native-community/slider'
import Ionicons from '@expo/vector-icons/Ionicons'
import * as DocumentPicker from 'expo-document-picker'
import { Audio } from '../lib/audioCompat'

import { getAllKeys, getTransposeDistance, isSameKey } from '../lib/transpose'
import { saveAudioFileLocally, updateAudioFileMetadata } from '../lib/audioFileManager'
import {
  PitchAudioEngine,
  PitchAudioEngineHandle,
  EngineStatus,
  DetectedKey,
  StemReport,
  StemPart,
} from '../components/PitchAudioEngine'
import ProgressBar from '../components/ProgressBar'
import {
  AudioRemovalService,
  RemovalType,
  InstrumentType,
  RemovalProgress,
} from '../lib/audioRemovalService'

// All 12 keys, spelled the way players read them (Eb not D#, F# not Gb)
const KEYS = getAllKeys()

type MainTab = 'pitch' | 'vocal'

const MANUAL_TEMPO_MIN_PERCENT = -40
const MANUAL_TEMPO_MAX_PERCENT = 40

interface PitchShiftStep {
  semitones: number
  displayName: string
  icon: string
}

interface PlaybackState {
  isPlaying: boolean
  duration: number
  position: number
}

// The parts of a mix that can actually be told apart without a trained model.
// Guitar vs keyboard is not one of them - both are sustained pitched sound -
// so the list is by what the DSP can genuinely separate.
const STEM_PARTS: { id: StemPart['id']; name: string; icon: string; blurb: string }[] = [
  { id: 'vocals',   name: 'Lead vocals',  icon: 'mic',
    blurb: 'Centre of the stereo image, in the vocal range' },
  { id: 'bass',     name: 'Bass',         icon: 'radio',
    blurb: 'Everything below 250 Hz' },
  { id: 'drums',    name: 'Drums',        icon: 'musical-notes',
    blurb: 'Short, broadband hits' },
  { id: 'harmonic', name: 'Instruments',  icon: 'musical-note',
    blurb: 'Sustained pitched parts - guitars, keys, strings' },
]

const pitchPresets: PitchShiftStep[] = [
  { semitones: -12, displayName: 'Down 1 Octave', icon: 'arrow-down' },
  { semitones: -7, displayName: 'Down Perfect 5th', icon: 'arrow-down' },
  { semitones: -5, displayName: 'Down Perfect 4th', icon: 'arrow-down' },
  { semitones: -2, displayName: 'Down Major 2nd', icon: 'arrow-down' },
  { semitones: 0, displayName: 'Original', icon: 'reload' },
  { semitones: 2, displayName: 'Up Major 2nd', icon: 'arrow-up' },
  { semitones: 5, displayName: 'Up Perfect 4th', icon: 'arrow-up' },
  { semitones: 7, displayName: 'Up Perfect 5th', icon: 'arrow-up' },
  { semitones: 12, displayName: 'Up 1 Octave', icon: 'arrow-up' },
]

// ─── Reusable Step Label ──────────────────────────────────────────────────────
function StepLabel({ step, label }: { step: string; label: string }) {
  const { colors: c } = useAppTheme()
  const stepStyles = useMemo(() => makeStepStyles(c), [c])

  return (
    <View style={stepStyles.row}>
      <View style={stepStyles.badge}>
        <Text style={stepStyles.badgeText}>{step}</Text>
      </View>
      <Text style={stepStyles.label}>{label}</Text>
    </View>
  )
}

const makeStepStyles = (c: AppColors) => StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 14 },
  badge: {
    width: 24, height: 24, borderRadius: 12,
    backgroundColor: c.accent,
    justifyContent: 'center', alignItems: 'center',
  },
  badgeText: { fontSize: 11, fontWeight: '700', color: c.accentText },
  label: { fontSize: 13, fontWeight: '700', color: c.text, letterSpacing: 1, textTransform: 'uppercase' },
})

// ─── Divider ─────────────────────────────────────────────────────────────────
function Divider() {
  const { colors: c } = useAppTheme()

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', marginVertical: 20, gap: 8 }}>
      <View style={{ flex: 1, height: 1, backgroundColor: c.surfaceMuted }} />
      <View style={{ width: 4, height: 4, backgroundColor: c.border, transform: [{ rotate: '45deg' }] }} />
      <View style={{ flex: 1, height: 1, backgroundColor: c.surfaceMuted }} />
    </View>
  )
}

export default function AudioToolsScreen() {
  const { colors: c } = useAppTheme()
  const styles = useMemo(() => makeStyles(c), [c])

  const [activeTab, setActiveTab] = useState<MainTab>('pitch')

  // ─── Pitch Changer State ──────────────────────────────────────────────────
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [fileName, setFileName] = useState<string>('')
  const [localFilePath, setLocalFilePath] = useState<string | null>(null)
  const [pitchShift, setPitchShift] = useState(0)
  const [tempoAdjustPercent, setTempoAdjustPercent] = useState(0)
  const [currentKey, setCurrentKey] = useState('C')
  const [targetKey, setTargetKey] = useState('C')
  const [isDetectingKey, setIsDetectingKey] = useState(false)
  const [detectionConfidence, setDetectionConfidence] = useState(0)
  const [pitchPlaybackState, setPitchPlaybackState] = useState<PlaybackState>({ isPlaying: false, duration: 0, position: 0 })
  const [isProcessing, setIsProcessing] = useState(false)
  const [detectedKeyLabel, setDetectedKeyLabel] = useState<string | null>(null)
  const [engineError, setEngineError] = useState<string | null>(null)
  const [isShifting, setIsShifting] = useState(false)

  const engineRef = useRef<PitchAudioEngineHandle>(null)
  const pitchShiftRef = useRef(0)
  const seekingRef = useRef(false)

  // ─── Vocal Remover State ──────────────────────────────────────────────────
  const [stemReport, setStemReport] = useState<StemReport | null>(null)
  const [isDetectingStems, setIsDetectingStems] = useState(false)
  const [removeParts, setRemoveParts] = useState<Record<string, boolean>>({})
  const [vocalIsShifting, setVocalIsShifting] = useState(false)
  const [isVocalProcessing, setIsVocalProcessing] = useState(false)
  const [progress, setProgress] = useState<RemovalProgress>({ status: 'idle', progress: 0, message: '' })
  const [selectedVocalAudioUri, setSelectedVocalAudioUri] = useState<string | null>(null)
  const [selectedVocalAudioName, setSelectedVocalAudioName] = useState<string | null>(null)
  const [vocalIsPlaying, setVocalIsPlaying] = useState(false)
  const [vocalPlaybackPosition, setVocalPlaybackPosition] = useState(0)
  const [vocalPlaybackDuration, setVocalPlaybackDuration] = useState(0)

  const removalServiceRef = useRef(new AudioRemovalService())
  const removalService = removalServiceRef.current
  const stemEngineRef = useRef<PitchAudioEngineHandle>(null)

  // ─── Init ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    Audio.setAudioModeAsync({ playsInSilentModeIOS: true, staysActiveInBackground: true })
    removalService.setProgressCallback((update) => setProgress(update))
    return () => {
      engineRef.current?.stop()
      removalService.cleanup()
    }
  }, [])

  // ─── Pitch Changer Logic ──────────────────────────────────────────────────
  //
  // Playback runs through the WebView audio engine, which shifts pitch by
  // overlap-adding grains: the pitch moves but the timeline does not, so the
  // song never speeds up or slows down when the key changes. Tempo is a
  // separate control, so the two can be set independently.

  /** The key that is `shift` semitones from `root`, named as in the key grid. */
  const keyAt = (root: string, shift: number): string => {
    const index = KEYS.findIndex(k => isSameKey(k, root))
    if (index === -1) return root
    return KEYS[((index + shift) % 12 + 12) % 12]
  }

  const handleEngineStatus = useCallback((status: EngineStatus) => {
    setPitchPlaybackState(prev => ({
      isPlaying: status.isPlaying,
      // While the user drags the scrubber, their thumb wins
      position: seekingRef.current ? prev.position : status.position * 1000,
      duration: status.duration * 1000,
    }))
  }, [])

  const handleEngineLoaded = useCallback((info: { duration: number }) => {
    setPitchPlaybackState({ isPlaying: false, position: 0, duration: info.duration * 1000 })
    // Analyse the decoded samples for the song's key
    setIsDetectingKey(true)
    engineRef.current?.detectKey()
  }, [])

  const handleEngineKey = useCallback((detected: DetectedKey) => {
    setIsDetectingKey(false)
    setDetectedKeyLabel(detected.key)
    setDetectionConfidence(detected.confidence)
    setCurrentKey(detected.root)
    const shift = pitchShiftRef.current
    setTargetKey(shift === 0 ? detected.root : keyAt(detected.root, shift))
  }, [])

  const handleEngineProcessing = useCallback((busy: boolean) => {
    setIsShifting(busy)
  }, [])

  const handleEngineError = useCallback((message: string) => {
    setIsDetectingKey(false)
    setEngineError(message)
  }, [])

  const handleEngineEnded = useCallback(() => {
    setPitchPlaybackState(prev => ({ ...prev, isPlaying: false, position: 0 }))
  }, [])

  const handlePickFile = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({ type: ['audio/mpeg', 'audio/wav', 'audio/*'] })
      if (!result.canceled && result.assets.length > 0) {
        const file = result.assets[0]
        setSelectedFile(file.uri)
        setFileName(file.name || 'Selected Audio File')
        try {
          setIsProcessing(true)
          const savedFile = await saveAudioFileLocally(file.uri, file.name || 'audio-file')
          setLocalFilePath(savedFile.localUri)
          await loadAudio(savedFile.localUri)
        } catch (error) {
          Alert.alert('Error', 'Failed to save audio file locally')
        } finally {
          setIsProcessing(false)
        }
      }
    } catch (error) {
      Alert.alert('Error', 'Failed to pick audio file')
    }
  }

  const loadAudio = async (uri: string) => {
    try {
      setEngineError(null)
      setPitchShift(0)
      pitchShiftRef.current = 0
      setTempoAdjustPercent(0)
      setCurrentKey('C')
      setTargetKey('C')
      setDetectedKeyLabel(null)
      setDetectionConfidence(0)
      setPitchPlaybackState({ isPlaying: false, duration: 0, position: 0 })
      engineRef.current?.stop()
      engineRef.current?.setSemitones(0)
      engineRef.current?.setTempo(1)
      await engineRef.current?.load(uri)
    } catch (error) {
      Alert.alert('Error', 'Failed to load audio file')
    }
  }

  const handleDetectKey = () => {
    if (!localFilePath) return
    setIsDetectingKey(true)
    engineRef.current?.detectKey()
  }

  const handlePitchPlayPause = () => {
    if (!localFilePath) { Alert.alert('Error', 'No audio loaded'); return }
    if (pitchPlaybackState.isPlaying) {
      engineRef.current?.pause()
    } else {
      engineRef.current?.play()
    }
    setPitchPlaybackState(prev => ({ ...prev, isPlaying: !prev.isPlaying }))
  }

  const handlePitchStop = () => {
    engineRef.current?.stop()
    setPitchPlaybackState(prev => ({ ...prev, isPlaying: false, position: 0 }))
  }

  const handleSeekDrag = (positionMillis: number) => {
    seekingRef.current = true
    setPitchPlaybackState(prev => ({ ...prev, position: positionMillis }))
  }

  const handleSeek = (positionMillis: number) => {
    seekingRef.current = false
    engineRef.current?.seek(positionMillis / 1000)
    setPitchPlaybackState(prev => ({ ...prev, position: positionMillis }))
  }

  const handleClearFile = () => {
    engineRef.current?.stop()
    setSelectedFile(null)
    setFileName('')
    setLocalFilePath(null)
    setCurrentKey('C')
    setTargetKey('C')
    setDetectedKeyLabel(null)
    setDetectionConfidence(0)
    setPitchShift(0)
    pitchShiftRef.current = 0
    setTempoAdjustPercent(0)
    setEngineError(null)
    setPitchPlaybackState({ isPlaying: false, duration: 0, position: 0 })
  }

  /** Move the labels while dragging, without re-rendering audio each step. */
  const previewPitchShift = (semitones: number) => {
    const clamped = Math.max(-12, Math.min(12, Math.round(semitones)))
    if (clamped === pitchShift) return
    setPitchShift(clamped)
    setTargetKey(keyAt(currentKey, clamped))
  }

  const applyPitchShift = (semitones: number) => {
    const clamped = Math.max(-12, Math.min(12, Math.round(semitones)))
    setPitchShift(clamped)
    setTargetKey(keyAt(currentKey, clamped))
    if (clamped === pitchShiftRef.current) return
    pitchShiftRef.current = clamped
    engineRef.current?.setSemitones(clamped)
  }

  /** Pick the key to hear it in; the semitone shift follows from it. */
  const handleTargetKeyPress = (key: string) => {
    const shift = getTransposeDistance(currentKey, key)
    pitchShiftRef.current = shift
    setPitchShift(shift)
    setTargetKey(key)
    engineRef.current?.setSemitones(shift)
  }

  const handleOriginalKeyPress = (key: string) => {
    setCurrentKey(key)
    setDetectedKeyLabel(null)
    setTargetKey(keyAt(key, pitchShiftRef.current))
  }

  const previewTempoAdjust = (value: number) => {
    setTempoAdjustPercent(
      Math.min(MANUAL_TEMPO_MAX_PERCENT, Math.max(MANUAL_TEMPO_MIN_PERCENT, Math.round(value))),
    )
  }

  const updateTempoAdjust = (value: number) => {
    const clamped = Math.min(MANUAL_TEMPO_MAX_PERCENT, Math.max(MANUAL_TEMPO_MIN_PERCENT, Math.round(value)))
    setTempoAdjustPercent(clamped)
    engineRef.current?.setTempo(1 + clamped / 100)
    return clamped
  }

  const handlePresetPress = (semitones: number) => {
    applyPitchShift(semitones)
  }

  const formatTime = (ms: number) => {
    const s = Math.floor(ms / 1000)
    return `${Math.floor(s / 60)}:${(s % 60 < 10 ? '0' : '')}${s % 60}`
  }

  // ─── Vocal / instrument removal ───────────────────────────────────────────
  //
  // Runs on the same WebView engine as the pitch changer, so the audio is
  // separated on the device. There is no model here: parts are told apart by
  // where they sit in the stereo image, how low they are, and whether they are
  // brief and broadband or sustained and narrow.

  const handleStemStatus = useCallback((status: EngineStatus) => {
    setVocalIsPlaying(status.isPlaying)
    setVocalPlaybackPosition(status.position * 1000)
    setVocalPlaybackDuration(status.duration * 1000)
  }, [])

  const handleStemsDetected = useCallback((report: StemReport) => {
    setIsDetectingStems(false)
    setStemReport(report)
  }, [])

  const handleStemLoaded = useCallback(() => {
    setIsDetectingStems(true)
    stemEngineRef.current?.analyzeStems()
  }, [])

  const handlePickVocalAudio = async () => {
    try {
      const audioUri = await removalService.pickAudioFile()
      if (!audioUri) return
      setSelectedVocalAudioUri(audioUri)
      setSelectedVocalAudioName(audioUri.split('/').pop() || 'audio.m4a')
      setStemReport(null)
      setRemoveParts({})
      setVocalIsPlaying(false)
      setVocalPlaybackPosition(0)
      setIsVocalProcessing(true)
      try {
        await stemEngineRef.current?.load(audioUri)
      } finally {
        setIsVocalProcessing(false)
      }
    } catch (error) {
      Alert.alert('Error', 'Failed to pick audio file')
    }
  }

  const handleDetectStems = () => {
    if (!selectedVocalAudioUri) { Alert.alert('No audio', 'Choose a file first'); return }
    setIsDetectingStems(true)
    stemEngineRef.current?.analyzeStems()
  }

  /** Each part is toggled on its own; the mix is rebuilt with all of them. */
  const toggleRemovePart = (id: StemPart['id']) => {
    const next = { ...removeParts, [id]: !removeParts[id] }
    setRemoveParts(next)
    stemEngineRef.current?.setRemoval({
      vocals: !!next.vocals,
      bass: !!next.bass,
      drums: !!next.drums,
      harmonic: !!next.harmonic,
    })
  }

  const handleVocalPlayPause = () => {
    if (!selectedVocalAudioUri) { Alert.alert('No audio', 'Choose a file first'); return }
    if (vocalIsPlaying) stemEngineRef.current?.pause()
    else stemEngineRef.current?.play()
    setVocalIsPlaying(!vocalIsPlaying)
  }

  const handleVocalStop = () => {
    stemEngineRef.current?.stop()
    setVocalIsPlaying(false)
    setVocalPlaybackPosition(0)
  }

  const handleVocalSeek = (positionMillis: number) => {
    stemEngineRef.current?.seek(positionMillis / 1000)
    setVocalPlaybackPosition(positionMillis)
  }

  const removalCount = Object.keys(removeParts).filter(k => removeParts[k]).length

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <SafeAreaView style={styles.container}>

      {/* Hidden Web Audio engine - does the pitch shifting and key detection */}
      <PitchAudioEngine
        ref={engineRef}
        onLoaded={handleEngineLoaded}
        onStatus={handleEngineStatus}
        onKeyDetected={handleEngineKey}
        onEnded={handleEngineEnded}
        onError={handleEngineError}
        onProcessing={handleEngineProcessing}
      />

      {/* Second engine instance, for the removal tab's own file */}
      <PitchAudioEngine
        ref={stemEngineRef}
        onLoaded={handleStemLoaded}
        onStatus={handleStemStatus}
        onStems={handleStemsDetected}
        onEnded={() => { setVocalIsPlaying(false); setVocalPlaybackPosition(0) }}
        onProcessing={setVocalIsShifting}
        onError={(m) => { setIsDetectingStems(false); Alert.alert('Audio engine', m) }}
      />

      {/* ── Header ── */}
      <View style={styles.header}>
<View style={styles.headerInner}>
          <View style={styles.headerTitleRow}>
            <View style={styles.headerAccent} />
            <View>
                      <Text style={styles.headerTitle}>Audio Tools</Text>
              <Text style={styles.headerSubtitle}>Key · Vocal</Text>
</View>
          </View>
        </View>
                  </View>

      {/* ── Tab Bar ── */}
      <View style={styles.tabBar}>
        {([
          { key: 'pitch', label: 'Key / Pitch', icon: 'musical-notes' },
          { key: 'vocal', label: 'Vocal', icon: 'mic' },
        ] as const).map(tab => (
          <TouchableOpacity
            key={tab.key}
            style={[styles.tab, activeTab === tab.key && styles.tabActive]}
            onPress={() => setActiveTab(tab.key)}
activeOpacity={0.7}
                      >
            <Ionicons
name={tab.icon}
size={16}
color={activeTab === tab.key ? c.text : c.textMuted}
/>
            <Text style={[styles.tabText, activeTab === tab.key && styles.tabTextActive]}>
              {tab.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* ─────────────────────── KEY / PITCH TAB ─────────────────────── */}
      {activeTab === 'pitch' && (
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
          <ScrollView style={styles.content} showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollPad}>

            {/* 1. Import */}
            <View style={styles.card}>
              <StepLabel step="1" label="Import Audio File" />
              <TouchableOpacity
style={styles.importBtn}
onPress={handlePickFile}
disabled={isProcessing}
                activeOpacity={0.8}
>
                <Ionicons name="cloud-download-outline" size={18} color={c.accentText} />
                <Text style={styles.importBtnText}>
{isProcessing ? 'Importing…' : 'Choose File'}
</Text>
              </TouchableOpacity>

              {isProcessing && (
                <View style={styles.processingRow}>
                  <ActivityIndicator size="small" color={c.text} />
                  <Text style={styles.processingText}>Processing audio…</Text>
                </View>
              )}

              {selectedFile && (
                <View style={styles.fileChip}>
                  <View style={styles.fileChipIconBox}>
                    <Ionicons name="musical-notes" size={16} color={c.text} />
</View>
                                    <View style={{ flex: 1 }}>
                    <Text style={styles.fileChipName} numberOfLines={1}>{fileName}</Text>
                    <Text style={styles.fileChipSub}>Saved locally</Text>
                  </View>
                  <TouchableOpacity onPress={handleClearFile} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                    <Ionicons name="close-circle" size={20} color={c.textMuted} />
                  </TouchableOpacity>
                </View>
              )}
            </View>

            {engineError && (
              <View style={styles.errorBanner}>
                <Ionicons name="warning-outline" size={15} color={c.warning} />
                <Text style={styles.errorBannerText}>{engineError}</Text>
              </View>
            )}

            {/* Playback */}
            {selectedFile && (
              <View style={styles.card}>
                <View style={styles.cardLabelRow}>
<View style={styles.cardLabelBar} />
                  <Text style={styles.cardLabel}>Playback</Text>
</View>

                                <View style={styles.playbackRow}>
                  <TouchableOpacity
style={[styles.playCircle, pitchPlaybackState.isPlaying && styles.playCircleActive]}
onPress={handlePitchPlayPause}
                    activeOpacity={0.85}
>
                    <Ionicons
name={pitchPlaybackState.isPlaying ? 'pause' : 'play'}
size={22}
color={pitchPlaybackState.isPlaying ? c.accentText : c.text}
/>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.stopCircle} onPress={handlePitchStop} activeOpacity={0.85}>
                    <Ionicons name="stop" size={18} color={c.text} />
                  </TouchableOpacity>
{pitchPlaybackState.duration > 0 && (
                    <View style={styles.playbackTimeRow}>
                      <Text style={styles.timeText}>{formatTime(pitchPlaybackState.position)}</Text>
                      <Text style={styles.timeSep}>/</Text>
                      <Text style={styles.timeDuration}>{formatTime(pitchPlaybackState.duration)}</Text>
                                      </View>
)}
                </View>

                                  {pitchPlaybackState.duration > 0 && (
                  <Slider
                    style={{ height: 36, marginTop: 4 }}
                    minimumValue={0}
                    maximumValue={pitchPlaybackState.duration}
                    value={pitchPlaybackState.position}
                    onValueChange={(v) => handleSeekDrag(v)}
                    onSlidingComplete={(v) => handleSeek(v)}
                    minimumTrackTintColor={c.accent}
                    maximumTrackTintColor={c.border}
                    thumbTintColor={c.accent}
                  />
                )}
              </View>
            )}

            {/* 2. Original Key */}
            {selectedFile && (
              <View style={styles.card}>
                <View style={styles.stepLabelDetectRow}>
                  <StepLabel step="2" label="Original Key" />
                  {isDetectingKey ? (
                    <ActivityIndicator size="small" color={c.text} />
                  ) : (
                    <TouchableOpacity style={styles.detectBtn} onPress={handleDetectKey} activeOpacity={0.8}>
                      <Ionicons name="sparkles-outline" size={13} color={c.text} />
                      <Text style={styles.detectBtnText}>Detect</Text>
                    </TouchableOpacity>
                  )}
                </View>

                {detectedKeyLabel && (
                  <Text style={styles.detectedText}>
                    Detected {detectedKeyLabel}{detectedKeyLabel.endsWith('m') ? ' (minor)' : ''}
                  </Text>
                )}

                {detectionConfidence > 0 && (
                  <View style={styles.confidenceRow}>
                    <View style={styles.confidenceBarBg}>
                      <View style={[styles.confidenceBarFill, { width: `${detectionConfidence}%` }]} />
</View>
                                        <Text style={styles.confidenceText}>{Math.round(detectionConfidence)}% confidence</Text>
                  </View>
                )}

                <View style={styles.keyGrid}>
                  {KEYS.map(note => (
                    <TouchableOpacity
                      key={note}
                      style={[styles.keyBtn, isSameKey(currentKey, note) && styles.keyBtnActive]}
                      onPress={() => handleOriginalKeyPress(note)}
                      activeOpacity={0.7}
                    >
                      <Text style={[styles.keyBtnText, isSameKey(currentKey, note) && styles.keyBtnTextActive]}>
                        {note}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            )}

            {/* 3. Pitch Shift */}
            {selectedFile && (
              <View style={styles.card}>
                <StepLabel step="3" label="Adjust Pitch" />

                {/* Key transition display */}
                <View style={styles.pitchDisplay}>
                  <View style={styles.keyPill}>
                    <Text style={styles.keyPillLabel}>FROM</Text>
                    <Text style={styles.keyPillKey}>{currentKey}</Text>
                  </View>
<View style={styles.pitchArrowCol}>
                    <Text style={styles.pitchSemitones}>
                      {pitchShift > 0 ? '+' : ''}{pitchShift}
                    </Text>
                    <Text style={styles.pitchSemiLabel}>semitones</Text>
                    <Ionicons name="arrow-forward" size={18} color={c.textMuted} style={{ marginTop: 2 }} />
                                    </View>
<View style={[styles.keyPill, styles.keyPillTarget]}>
                    <Text style={styles.keyPillLabel}>TO</Text>
                    <Text style={[styles.keyPillKey, styles.keyPillKeyTarget]}>{targetKey}</Text>
                  </View>
                </View>

                {/* Play it in any key - sharps and flats both offered */}
                <Text style={styles.minorLabel}>Play In Key</Text>
                <View style={styles.keyGrid}>
                  {KEYS.map(note => (
                    <TouchableOpacity
                      key={note}
                      style={[styles.keyBtn, isSameKey(targetKey, note) && styles.keyBtnActive]}
                      onPress={() => handleTargetKeyPress(note)}
                      activeOpacity={0.7}
                    >
                      <Text style={[styles.keyBtnText, isSameKey(targetKey, note) && styles.keyBtnTextActive]}>
                        {note}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>

                <View style={styles.sliderRow}>
                  <Ionicons name="remove-circle-outline" size={20} color={c.textMuted} />
                  <Slider
                    style={styles.slider}
                    minimumValue={-6}
                    maximumValue={6}
                    step={1}
                    value={pitchShift}
                    onValueChange={(v) => previewPitchShift(v)}
                    onSlidingComplete={(v) => applyPitchShift(v)}
                    minimumTrackTintColor={c.accent}
                    maximumTrackTintColor={c.border}
                    thumbTintColor={c.accent}
                  />
                  <Ionicons name="add-circle-outline" size={20} color={c.textMuted} />
                </View>

                {isShifting ? (
                  <View style={styles.shiftingRow}>
                    <ActivityIndicator size="small" color={c.text} />
                    <Text style={styles.shiftingText}>Applying new key…</Text>
                  </View>
                ) : (
                  <Text style={styles.pitchNote}>
                    Speed stays the same when the key changes.
                  </Text>
                )}

<Divider />

                {/* Presets */}
                                <Text style={styles.minorLabel}>Quick Adjustments</Text>
                <View style={styles.presetsGrid}>
                  {pitchPresets.slice(2, 8).map(preset => (
                    <TouchableOpacity
                      key={preset.semitones}
                      style={[styles.presetBtn, pitchShift === preset.semitones && styles.presetBtnActive]}
                      onPress={() => handlePresetPress(preset.semitones)}
activeOpacity={0.75}
                                          >
                      <Ionicons
name={preset.icon as any}
size={11}
color={pitchShift === preset.semitones ? c.accentText : c.textSub}
/>
                      <Text style={[styles.presetBtnText, pitchShift === preset.semitones && styles.presetBtnTextActive]}>
                        {preset.displayName}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>

                <Divider />

                {/* Tempo */}
                <View style={styles.tempoBox}>
<View style={styles.tempoHeaderRow}>
                    <Ionicons name="timer-outline" size={15} color={c.textSub} />
                                      <Text style={styles.tempoTitle}>Tempo Adjustment</Text>
                    <Text style={styles.tempoValue}>
{tempoAdjustPercent > 0 ? '+' : ''}{tempoAdjustPercent}% · ×{(1 + tempoAdjustPercent / 100).toFixed(2)}
</Text>
</View>
                                    <View style={styles.sliderRow}>
                    <Ionicons name="play-back-outline" size={16} color={c.textMuted} />
                    <Slider
                      style={styles.slider}
                      minimumValue={MANUAL_TEMPO_MIN_PERCENT}
                      maximumValue={MANUAL_TEMPO_MAX_PERCENT}
                      step={1}
                      value={tempoAdjustPercent}
                      onValueChange={(v) => previewTempoAdjust(v)}
                      onSlidingComplete={(v) => updateTempoAdjust(v)}
                      minimumTrackTintColor={c.accent}
                      maximumTrackTintColor={c.border}
                      thumbTintColor={c.accent}
                    />
                    <Ionicons name="play-forward-outline" size={16} color={c.textMuted} />
                  </View>
                  <View style={styles.tempoQuickRow}>
                    {[-10, -5, 0, 5, 10].map(v => (
                      <TouchableOpacity
                        key={v}
                        style={[styles.tempoQuickBtn, tempoAdjustPercent === v && styles.tempoQuickBtnActive]}
                        onPress={() => updateTempoAdjust(v)}
activeOpacity={0.7}
                                              >
                        <Text style={[styles.tempoQuickText, tempoAdjustPercent === v && styles.tempoQuickTextActive]}>
                          {v > 0 ? '+' : ''}{v}%
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </View>
              </View>
            )}

            {selectedFile && (
              <TouchableOpacity
style={styles.saveBtn}
onPress={async () => {
                  setIsProcessing(true)
                  try {
                    await updateAudioFileMetadata(localFilePath?.split('/').pop() || '', {
originalKey: currentKey, targetKey, pitchShift, tempoAdjustPercent,
tempoAdjustFactor: 1 + tempoAdjustPercent / 100,
})
                    Alert.alert('Saved', `Pitch settings saved.\nKey: ${currentKey} → ${targetKey}\nShift: ${pitchShift > 0 ? '+' : ''}${pitchShift} semitones`)
                  } finally { setIsProcessing(false) }
                }}
disabled={isProcessing}
                activeOpacity={0.85}
>
                <Ionicons name="checkmark" size={18} color={c.accentText} />
                <Text style={styles.saveBtnText}>
{isProcessing ? 'Saving…' : 'Save Pitch Settings'}
</Text>
              </TouchableOpacity>
            )}

            <View style={{ height: 40 }} />
          </ScrollView>
        </KeyboardAvoidingView>
      )}

      {/* ─────────────────────── REMOVAL TAB ─────────────────────── */}
      {activeTab === 'vocal' && (
        <ScrollView style={styles.content} showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollPad}>

          {/* 1. Select file */}
          <View style={styles.card}>
            <StepLabel step="1" label="Select Audio File" />
            <TouchableOpacity style={styles.uploadZone} onPress={handlePickVocalAudio} activeOpacity={0.75}>
              <View style={styles.uploadIconBox}>
                <Ionicons name="cloud-upload-outline" size={28} color={c.textSub} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.uploadTitle} numberOfLines={1}>
                  {selectedVocalAudioName || 'Choose an audio file'}
                </Text>
                <Text style={styles.uploadSub}>
                  {isVocalProcessing ? 'Loading…' : 'MP3, WAV, M4A'}
                </Text>
              </View>
              {isVocalProcessing && <ActivityIndicator size="small" color={c.text} />}
            </TouchableOpacity>
          </View>

          {/* 2. What is in the mix */}
          {selectedVocalAudioUri && (
            <View style={styles.card}>
              <View style={styles.stepLabelDetectRow}>
                <StepLabel step="2" label="What's In This Track" />
                {isDetectingStems ? (
                  <ActivityIndicator size="small" color={c.text} />
                ) : (
                  <TouchableOpacity style={styles.detectBtn} onPress={handleDetectStems} activeOpacity={0.8}>
                    <Ionicons name="sparkles-outline" size={13} color={c.text} />
                    <Text style={styles.detectBtnText}>Detect</Text>
                  </TouchableOpacity>
                )}
              </View>

              {!stemReport && !isDetectingStems && (
                <Text style={styles.stemHint}>Tap Detect to see what can be taken out.</Text>
              )}

              {stemReport && (
                <>
                  {!stemReport.stereo && (
                    <Text style={styles.stemWarning}>
                      This file is mono. Vocals can't be separated from a mono mix — they
                      need the stereo image to stand apart.
                    </Text>
                  )}

                  {STEM_PARTS.map(part => {
                    const found = stemReport.parts.find(p => p.id === part.id)
                    const present = !!found?.present
                    const level = found?.level ?? 0
                    const removable = present || level > 0
                    const on = !!removeParts[part.id]
                    return (
                      <TouchableOpacity
                        key={part.id}
                        style={[styles.stemRow, on && styles.stemRowActive]}
                        onPress={() => removable && toggleRemovePart(part.id)}
                        activeOpacity={removable ? 0.75 : 1}
                        disabled={!removable}
                      >
                        <View style={[styles.stemIconBox, on && styles.stemIconBoxActive]}>
                          <Ionicons name={part.icon as any} size={18} color={on ? c.accentText : c.textSub} />
                        </View>
                        <View style={{ flex: 1 }}>
                          <Text style={[styles.stemName, !removable && styles.stemNameOff]}>
                            {part.name}
                          </Text>
                          <Text style={styles.stemBlurb} numberOfLines={1}>
                            {found?.note ? found.note : present ? part.blurb : 'Not really present'}
                          </Text>
                          <View style={styles.stemBarBg}>
                            <View style={[styles.stemBarFill, { width: (level + '%') as any }]} />
                          </View>
                        </View>
                        <View style={[styles.stemToggle, on && styles.stemToggleActive]}>
                          <Ionicons
                            name={on ? 'checkmark' : 'close'}
                            size={14}
                            color={on ? c.accentText : c.iconInactive}
                          />
                        </View>
                      </TouchableOpacity>
                    )
                  })}

                  <Text style={styles.stemFootnote}>
                    Each part is removed on its own — tap any combination. Separation is done
                    by ear-level DSP, not a trained model, so expect a reduction rather than a
                    perfectly clean stem.
                  </Text>
                </>
              )}
            </View>
          )}

          {/* 3. Listen */}
          {stemReport && (
            <View style={styles.card}>
              <StepLabel step="3" label="Listen" />

              {vocalIsShifting && (
                <View style={styles.shiftingRow}>
                  <ActivityIndicator size="small" color={c.text} />
                  <Text style={styles.shiftingText}>Rebuilding the mix…</Text>
                </View>
              )}

              <View style={styles.playbackRow}>
                <TouchableOpacity
                  style={[styles.playCircle, vocalIsPlaying && styles.playCircleActive]}
                  onPress={handleVocalPlayPause}
                  activeOpacity={0.85}
                >
                  <Ionicons
                    name={vocalIsPlaying ? 'pause' : 'play'}
                    size={22}
                    color={vocalIsPlaying ? c.accentText : c.text}
                  />
                </TouchableOpacity>
                <TouchableOpacity style={styles.stopCircle} onPress={handleVocalStop} activeOpacity={0.85}>
                  <Ionicons name="stop" size={18} color={c.text} />
                </TouchableOpacity>
                <View style={styles.playbackTimeRow}>
                  <Text style={styles.timeText}>{formatTime(vocalPlaybackPosition)}</Text>
                  <Text style={styles.timeSep}>/</Text>
                  <Text style={styles.timeDuration}>{formatTime(vocalPlaybackDuration)}</Text>
                </View>
              </View>

              {vocalPlaybackDuration > 0 && (
                <Slider
                  style={{ height: 36, marginTop: 4 }}
                  minimumValue={0}
                  maximumValue={vocalPlaybackDuration}
                  value={vocalPlaybackPosition}
                  onSlidingComplete={(v) => handleVocalSeek(v)}
                  minimumTrackTintColor={c.accent}
                  maximumTrackTintColor={c.border}
                  thumbTintColor={c.accent}
                />
              )}

              <Text style={styles.stemFootnote}>
                {removalCount === 0
                  ? 'Nothing removed yet — this is the original mix.'
                  : removalCount + ' part' + (removalCount > 1 ? 's' : '') + ' removed.'}
              </Text>
            </View>
          )}

          <View style={{ height: 40 }} />
        </ScrollView>
      )}
    </SafeAreaView>
  )
}

const makeStyles = (c: AppColors) => StyleSheet.create({
  detectBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingVertical: 5, paddingHorizontal: 10,
    borderRadius: 7, borderWidth: 1.5, borderColor: c.border, backgroundColor: c.surfaceAlt,
  },
  detectBtnText: { fontSize: 12, fontWeight: '700', color: c.text },
  stemHint: { fontSize: 12.5, color: c.textMuted, fontWeight: '500' },
  stemWarning: {
    fontSize: 12, color: c.warning, fontWeight: '600', backgroundColor: c.warningBg,
    borderRadius: 8, padding: 10, marginBottom: 12, lineHeight: 17,
  },
  stemRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    borderWidth: 1.5, borderColor: c.border, borderRadius: 10,
    padding: 12, marginBottom: 10, backgroundColor: c.surface,
  },
  stemRowActive: { borderColor: c.accent, backgroundColor: c.surfaceAlt },
  stemIconBox: {
    width: 38, height: 38, borderRadius: 10, backgroundColor: c.surfaceAlt,
    alignItems: 'center', justifyContent: 'center',
  },
  stemIconBoxActive: { backgroundColor: c.accent },
  stemName: { fontSize: 14, fontWeight: '800', color: c.text },
  stemNameOff: { color: c.textMuted },
  stemBlurb: { fontSize: 11, color: c.textMuted, fontWeight: '500', marginTop: 1 },
  stemBarBg: { height: 4, borderRadius: 2, backgroundColor: c.surfaceMuted, marginTop: 6, overflow: 'hidden' },
  stemBarFill: { height: 4, borderRadius: 2, backgroundColor: c.accent },
  stemToggle: {
    width: 26, height: 26, borderRadius: 13, borderWidth: 1.5, borderColor: c.border,
    alignItems: 'center', justifyContent: 'center',
  },
  stemToggleActive: { backgroundColor: c.accent, borderColor: c.accent },
  stemFootnote: { fontSize: 11, color: c.textMuted, fontWeight: '500', lineHeight: 16, marginTop: 4 },
  detectedText: { fontSize: 12.5, fontWeight: '700', color: c.textSub, marginBottom: 10 },
  pitchNote: { fontSize: 11.5, color: c.textMuted, fontWeight: '500', marginTop: 10, textAlign: 'center' },
  shiftingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 10 },
  shiftingText: { fontSize: 12, color: c.textSub, fontWeight: '700' },
  errorBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: c.warningBg, borderRadius: 10, borderWidth: 1.5, borderColor: c.warning,
    padding: 12, marginBottom: 16,
  },
  errorBannerText: { flex: 1, fontSize: 12, color: c.warning, fontWeight: '600' },
  container: { flex: 1, backgroundColor: c.surfaceAlt },

  // ── Header ──
  header: {
    backgroundColor: c.accent,
    paddingHorizontal: 20,
    paddingTop: 14,
    paddingBottom: 18,
  },
  headerInner: {},
  headerTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  headerAccent: {
    width: 4, height: 40, borderRadius: 2,
    backgroundColor: c.surface,
    opacity: 0.35,
  },
  headerTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: c.accentText,
    letterSpacing: -0.3,
},
  headerSubtitle: {
fontSize: 11,
color: c.accentText,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    marginTop: 2,
  },

  // ── Tab Bar ──
  tabBar: {
flexDirection: 'row',
backgroundColor: c.surface,
borderBottomWidth: 1,
borderBottomColor: c.border,
},
  tab: {
flex: 1,
flexDirection: 'row',
alignItems: 'center',
justifyContent: 'center',
paddingVertical: 13,
gap: 5,
},
  tabActive: {
borderBottomWidth: 2,
borderBottomColor: c.accent,
},
  tabText: {
fontSize: 11,
fontWeight: '600',
color: c.textMuted,
    letterSpacing: 0.3,
},
  tabTextActive: {
    color: c.text,
  },

  // ── Content ──
  content: { flex: 1 },
  scrollPad: { padding: 16 },

  // ── Card ──
  card: {
    backgroundColor: c.surface,
    borderRadius: 14,
    padding: 18,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: c.hairline,
    shadowColor: c.shadow,
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 1,
  },
  cardLabelRow: {
flexDirection: 'row',
alignItems: 'center',
    gap: 8,
    marginBottom: 14,
  },
  cardLabelBar: {
    width: 3,
    height: 13,
    borderRadius: 2,
    backgroundColor: c.accent,
  },
  cardLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: c.textSub,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
  },

  // ── Import ──
  importBtn: {
    backgroundColor: c.accent,
    borderRadius: 10,
    paddingVertical: 13,
    paddingHorizontal: 18,
flexDirection: 'row',
alignItems: 'center',
justifyContent: 'center',
gap: 8,
},
  importBtnText: {
color: c.accentText,
fontSize: 14,
fontWeight: '700',
    letterSpacing: 0.5,
},
  processingRow: {
    flexDirection: 'row',
alignItems: 'center',
    gap: 10,
    marginTop: 12,
backgroundColor: c.surfaceAlt,
borderRadius: 8,
    padding: 12,
},
  processingText: {
fontSize: 13,
color: c.textSub,
fontWeight: '500',
},
  fileChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginTop: 12,
backgroundColor: c.surfaceAlt,
borderRadius: 10,
padding: 12,
    borderWidth: 1,
    borderColor: c.border,
  },
  fileChipIconBox: {
    width: 36,
    height: 36,
    borderRadius: 8,
    backgroundColor: c.surfaceMuted,
    justifyContent: 'center',
alignItems: 'center',
},
  fileChipName: { fontSize: 13, fontWeight: '600', color: c.text, marginBottom: 2 },
  fileChipSub: { fontSize: 11, color: c.textMuted },

  // ── Playback ──
  playbackRow: {
flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 4,
  },
  playCircle: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: c.surfaceAlt,
    borderWidth: 1.5,
    borderColor: c.border,
justifyContent: 'center',
alignItems: 'center',
},
  playCircleActive: {
backgroundColor: c.accent,
    borderColor: c.accent,
  },
  stopCircle: {
width: 40,
height: 40,
    borderRadius: 20,
    backgroundColor: c.surfaceAlt,
    borderWidth: 1,
    borderColor: c.border,
justifyContent: 'center',
    alignItems: 'center',
  },
  playbackTimeRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 3,
  },
  timeText: { fontSize: 11, color: c.textMuted },
  timeSep: { fontSize: 11, color: c.iconInactive },
  timeDuration: { fontSize: 11, color: c.iconInactive },
  timeRow: {
flexDirection: 'row',
justifyContent: 'space-between',
    paddingHorizontal: 2,
    marginTop: 2,
  },

  // ── Key Detection ──
  stepLabelDetectRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
},
  confidenceRow: {
marginBottom: 14,
  },
  confidenceBarBg: {
    height: 4,
backgroundColor: c.surfaceMuted,
borderRadius: 2,
    overflow: 'hidden',
    marginBottom: 6,
  },
  confidenceBarFill: {
    height: '100%',
    backgroundColor: c.accent,
    borderRadius: 2,
},
  confidenceText: {
fontSize: 11,
color: c.textMuted,
fontWeight: '500',
},
  keyGrid: {
flexDirection: 'row',
flexWrap: 'wrap',
gap: 8,
},
  keyBtn: {
width: '18%',
aspectRatio: 1,
backgroundColor: c.surfaceAlt,
borderRadius: 8,
justifyContent: 'center',
alignItems: 'center',
borderWidth: 1.5,
borderColor: c.border,
},
  keyBtnActive: {
backgroundColor: c.accent,
borderColor: c.accent,
},
  keyBtnText: { fontSize: 13, fontWeight: '700', color: c.textSub },
  keyBtnTextActive: { color: c.accentText },

  // ── Pitch Display ──
  pitchDisplay: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
backgroundColor: c.surfaceAlt,
borderRadius: 12,
padding: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: c.hairline,
  },
  keyPill: {
alignItems: 'center',
    minWidth: 64,
  },
  keyPillLabel: {
    fontSize: 9,
    fontWeight: '700',
    color: c.textMuted,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    marginBottom: 4,
  },
  keyPillKey: {
    fontSize: 32,
    fontWeight: '700',
    color: c.text,
    letterSpacing: -1,
  },
  keyPillTarget: { alignItems: 'center' },
  keyPillKeyTarget: { color: c.textSub },
  pitchArrowCol: { alignItems: 'center' },
  pitchSemitones: {
    fontSize: 22,
    fontWeight: '800',
    color: c.text,
    letterSpacing: -0.5,
  },
  pitchSemiLabel: {
    fontSize: 9,
    fontWeight: '600',
    color: c.textMuted,
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginTop: 1,
  },

  // ── Slider ──
  sliderRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  slider: { flex: 1, height: 36 },

  // ── Presets ──
  minorLabel: {
fontSize: 10,
fontWeight: '700',
color: c.textMuted,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
marginBottom: 10,
},
  presetsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  presetBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
backgroundColor: c.surfaceAlt,
borderRadius: 7,
paddingVertical: 8,
paddingHorizontal: 10,
borderWidth: 1,
borderColor: c.border,
minWidth: '31%',
flex: 1,
},
  presetBtnActive: { backgroundColor: c.accent, borderColor: c.accent },
  presetBtnText: { fontSize: 11, color: c.textSub, fontWeight: '500' },
  presetBtnTextActive: { color: c.accentText },

  // ── Tempo ──
  tempoBox: {
backgroundColor: c.surfaceAlt,
borderRadius: 10,
padding: 14,
borderWidth: 1,
borderColor: c.hairline,
  },
  tempoHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
marginBottom: 10,
},
  tempoTitle: {
fontSize: 13,
fontWeight: '600',
color: c.textSub,
    flex: 1,
},
  tempoValue: {
fontSize: 12,
fontWeight: '600',
    color: c.textMuted,
},
  tempoQuickRow: { flexDirection: 'row', gap: 6, marginTop: 8 },
  tempoQuickBtn: {
flex: 1,
backgroundColor: c.surface,
borderRadius: 7,
paddingVertical: 8,
borderWidth: 1,
borderColor: c.border,
alignItems: 'center',
},
  tempoQuickBtnActive: { backgroundColor: c.accent, borderColor: c.accent },
  tempoQuickText: { fontSize: 11, color: c.textSub, fontWeight: '600' },
  tempoQuickTextActive: { color: c.accentText },

  // ── Save Button ──
  saveBtn: {
backgroundColor: c.accent,
borderRadius: 10,
paddingVertical: 15,
flexDirection: 'row',
alignItems: 'center',
justifyContent: 'center',
    gap: 8,
    marginTop: 2,
  },
  saveBtnText: {
    color: c.accentText,
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: 0.6,
  },

  // ── Upload Zone ──
  uploadZone: {
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: c.border,
borderStyle: 'dashed',
    backgroundColor: c.surfaceAlt,
    padding: 16,
    flexDirection: 'row',
alignItems: 'center',
    gap: 14,
  },
  uploadIconBox: {
    width: 50,
    height: 50,
    borderRadius: 10,
    backgroundColor: c.surfaceAlt,
    borderWidth: 1,
    borderColor: c.border,
    justifyContent: 'center',
    alignItems: 'center',
  },
  uploadTitle: { fontSize: 14, fontWeight: '600', color: c.text, marginBottom: 2 },
  uploadSub: { fontSize: 12, color: c.textMuted },

  // ── Removal Type ──
  removalRow: { flexDirection: 'row', gap: 12 },
  removalBtn: {
flex: 1,
backgroundColor: c.surfaceAlt,
borderRadius: 12,
padding: 16,
alignItems: 'center',
borderWidth: 1.5,
borderColor: c.hairline,
    gap: 6,
},
  removalBtnActive: {
borderColor: c.accent,
backgroundColor: c.surface,
},
  removalBtnTitle: {
fontSize: 12,
fontWeight: '700',
color: c.textMuted,
textAlign: 'center',
    letterSpacing: 0.2,
},
  removalBtnTitleActive: { color: c.text },
  removalBtnSub: { fontSize: 11, color: c.iconInactive, textAlign: 'center' },

  // ── Instruments ──
  instrumentGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  instrumentCard: {
width: '48%',
backgroundColor: c.surfaceAlt,
borderRadius: 12,
padding: 14,
alignItems: 'center',
borderWidth: 1.5,
    borderColor: c.hairline,
    gap: 8,
},
  instrumentCardActive: { borderColor: c.accent, backgroundColor: c.surface },
  instrumentIconBox: {
width: 52,
height: 52,
borderRadius: 26,
    backgroundColor: c.surfaceMuted,
justifyContent: 'center',
    alignItems: 'center',
  },
  instrumentIconBoxActive: { backgroundColor: c.accent },
  instrumentName: { fontSize: 12, fontWeight: '600', color: c.textMuted, textAlign: 'center' },
instrumentNameActive: { color: c.text },

  // ── Process Button ──
    processBtn: {
backgroundColor: c.accent,
borderRadius: 10,
paddingVertical: 15,
alignItems: 'center',
justifyContent: 'center',
flexDirection: 'row',
gap: 10,
},
  processBtnDisabled: { opacity: 0.55 },
  processBtnText: { color: c.accentText, fontSize: 14, fontWeight: '700', letterSpacing: 0.5 },
  progressBox: { marginTop: 14 },
  progressBarBg: {
height: 5,
backgroundColor: c.surfaceMuted,
borderRadius: 3,
overflow: 'hidden',
marginBottom: 6,
},
  progressBarFill: { height: '100%', backgroundColor: c.accent },
  progressText: { fontSize: 11, color: c.textMuted, textAlign: 'right', fontWeight: '600' },

  // ── Vocal Player ──
  vocalPlayerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  })
