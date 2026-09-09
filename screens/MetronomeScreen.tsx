// screens/MetronomeScreen.tsx
import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import {
  View,
  StyleSheet,
  Text,
  TouchableOpacity,
  Dimensions,
  Modal,
  TextInput,
  Alert,
  ActivityIndicator,
  ScrollView,
  Switch,
} from 'react-native'
import { useAppTheme, type AppColors } from '../lib/theme'
import Slider from '@react-native-community/slider'
import { Audio } from '../lib/audioCompat'
import Ionicons from '@expo/vector-icons/Ionicons'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { supabase } from '../lib/supabase'
import { getCurrentUser } from '../lib/auth'
import { useRole } from '../lib/useRole'
import { getPlaylistsByUserId, getPlaylistItems } from '../db/queries'
import { useKeepScreenAwake } from '../lib/useKeepScreenAwake'
import * as FileSystem from 'expo-file-system/legacy'
import * as DocumentPicker from 'expo-document-picker'
import { AUDIO_PICKER_TYPES, resolveAudioExtension } from '../lib/audioFormat'
import { WebView } from '../components/EngineWebView'
import { METRONOME_ENGINE_HTML } from '../lib/metronomeEngineHtml'
import {
  CLICK_TONES,
  DECAY_TAIL,
  PITCH_RANGE_SEMITONES,
  clickDurationSec,
  pitchRatio,
  renderClickWavBase64,
  shiftTone,
  type ClickAccent,
} from '../lib/clickSynth'

// Monochrome palette - Formal & Professional

const SCREEN_WIDTH = Dimensions.get('window').width

type PresetScope = 'personal' | 'overall'
type MainTab = 'personal' | 'overall' | 'playlist'

// ═══════════════════════════════════════════════════════════════════════════════
// TIME SIGNATURE SYSTEM — music-theory accurate
// ═══════════════════════════════════════════════════════════════════════════════
//
// BPM = the beat you count out loud. That is the only reading a player can tap
// against, so every meter defines which note value that beat is:
//
//   4/4, 3/4, 5/4 …  BPM = quarter note
//   2/2 (cut time)   BPM = half note
//   3/8, 5/8, 7/8 …  BPM = eighth note   (the counting unit of the groups)
//   6/8, 9/8, 12/8   BPM = dotted quarter (the felt pulse, not the eighth)
//
// Every meter is described the same way, as a GRID of equal units plus a
// GROUPING of those units:
//
//   beatGroups  units per accent group; the groups sum to the whole measure
//                 4/4  → [2, 2]        (S w M w)
//                 3/4  → [3]           (S w w)
//                 5/4  → [3, 2]        (S w w M w)
//                 7/8  → [2, 2, 3]     (S w M w M w w)
//                 6/8  → [3, 3]        (S w w M w w)
//   pulseUnits  how many grid units make one counted beat
//                 1 for simple + asymmetric (the unit IS the beat)
//                 3 for compound (the dotted-note pulse is 3 eighths)
//
// So one grid unit lasts (60 / BPM) / pulseUnits seconds, and the accent of a
// unit falls straight out of the grouping:
//
//   first unit of the measure → 2 STRONG
//   first unit of a group     → 1 MEDIUM
//   anything else             → 0 WEAK
//
// Compound meters click all six/nine/twelve subdivisions by default, which is
// what makes 6/8 sound like 6/8 rather than a fast 2/4. Turning subdivisions
// off collapses them to the dotted pulse alone; simple and asymmetric meters
// are unaffected because their grid unit is already the beat.
// ═══════════════════════════════════════════════════════════════════════════════

type MeterType = 'simple' | 'compound' | 'asymmetric'

type TimeSignatureOption = {
  label: string
  numerator: number
  denominator: number
  meterType: MeterType
  beatGroups: number[]      // grid units per accent group; sums to unitsPerMeasure
  pulseUnits: number        // grid units per counted beat (3 = compound, else 1)
  unitsPerMeasure: number   // sum(beatGroups)
  beatsPerMeasure: number   // counted beats per measure = beatGroups.length
  pulseName: string         // what BPM counts, e.g. 'dotted quarter'
  description: string
}

// One click of the pattern: its accent, and how many grid units until the next
type ClickStep = { accent: number; units: number }

// Duration of one grid unit in seconds
function calcUnitSec(bpm: number, sig: TimeSignatureOption): number {
  return (60 / bpm) / sig.pulseUnits
}

// Duration of a whole measure — used by the UI to show the bar length
function calcMeasureSec(bpm: number, sig: TimeSignatureOption): number {
  return calcUnitSec(bpm, sig) * sig.unitsPerMeasure
}

// Build the click pattern for one measure.
// subdivide=false collapses a compound meter to its dotted pulse only.
function buildClickPattern(sig: TimeSignatureOption, subdivide: boolean = true): ClickStep[] {
  const collapse = !subdivide && sig.pulseUnits > 1
  const pattern: ClickStep[] = []

  sig.beatGroups.forEach((groupSize, groupIdx) => {
    if (collapse) {
      // One click per group (= per dotted pulse), lasting the whole group
      pattern.push({ accent: groupIdx === 0 ? 2 : 1, units: groupSize })
      return
    }
    for (let u = 0; u < groupSize; u++) {
      const accent = groupIdx === 0 && u === 0 ? 2   // measure downbeat
        : u === 0 ? 1                                 // group downbeat
        : 0                                           // inner subdivision
      pattern.push({ accent, units: 1 })
    }
  })

  return pattern
}

const TIME_SIGNATURE_OPTIONS: TimeSignatureOption[] = [
  // ── Simple ───────────────────────────────────────────────────────────────────
  {
    label: '2/4',
    numerator: 2, denominator: 4,
    meterType: 'simple',
    beatGroups: [2], pulseUnits: 1, unitsPerMeasure: 2, beatsPerMeasure: 2,
    pulseName: 'quarter',
    description: 'March · 2 quarter beats',
  },
  {
    label: '3/4',
    numerator: 3, denominator: 4,
    meterType: 'simple',
    beatGroups: [3], pulseUnits: 1, unitsPerMeasure: 3, beatsPerMeasure: 3,
    pulseName: 'quarter',
    description: 'Waltz · 3 quarter beats',
  },
  {
    label: '4/4',
    numerator: 4, denominator: 4,
    meterType: 'simple',
    beatGroups: [2, 2], pulseUnits: 1, unitsPerMeasure: 4, beatsPerMeasure: 4,
    pulseName: 'quarter',
    description: 'Common time · 4 quarter beats · accent on 1 and 3',
  },
  {
    label: '2/2',
    numerator: 2, denominator: 2,
    meterType: 'simple',
    beatGroups: [2], pulseUnits: 1, unitsPerMeasure: 2, beatsPerMeasure: 2,
    pulseName: 'half note',
    description: 'Cut time · 2 half-note beats · BPM counts half notes',
  },
  {
    label: '3/8',
    numerator: 3, denominator: 8,
    meterType: 'simple',
    beatGroups: [3], pulseUnits: 1, unitsPerMeasure: 3, beatsPerMeasure: 3,
    pulseName: 'eighth',
    description: 'Simple triple · 3 eighth beats',
  },
  {
    label: '6/4',
    numerator: 6, denominator: 4,
    meterType: 'simple',
    beatGroups: [3, 3], pulseUnits: 1, unitsPerMeasure: 6, beatsPerMeasure: 6,
    pulseName: 'quarter',
    description: '6 quarter beats felt 3+3 · common in worship',
  },
  // ── Asymmetric ───────────────────────────────────────────────────────────────
  {
    label: '5/4',
    numerator: 5, denominator: 4,
    meterType: 'asymmetric',
    beatGroups: [3, 2], pulseUnits: 1, unitsPerMeasure: 5, beatsPerMeasure: 2,
    pulseName: 'quarter',
    description: '5/4 (3+2) · "Take Five" · 5 quarter beats',
  },
  {
    label: '5/4 (2+3)',
    numerator: 5, denominator: 4,
    meterType: 'asymmetric',
    beatGroups: [2, 3], pulseUnits: 1, unitsPerMeasure: 5, beatsPerMeasure: 2,
    pulseName: 'quarter',
    description: '5/4 (2+3) · 5 quarter beats, accent on 1 and 3',
  },
  {
    label: '5/8',
    numerator: 5, denominator: 8,
    meterType: 'asymmetric',
    beatGroups: [3, 2], pulseUnits: 1, unitsPerMeasure: 5, beatsPerMeasure: 2,
    pulseName: 'eighth',
    description: '5/8 (3+2) · 5 eighth beats',
  },
  {
    label: '7/8',
    numerator: 7, denominator: 8,
    meterType: 'asymmetric',
    beatGroups: [2, 2, 3], pulseUnits: 1, unitsPerMeasure: 7, beatsPerMeasure: 3,
    pulseName: 'eighth',
    description: '7/8 (2+2+3) · Balkan / Prog · 7 eighth beats',
  },
  {
    label: '7/8 (3+2+2)',
    numerator: 7, denominator: 8,
    meterType: 'asymmetric',
    beatGroups: [3, 2, 2], pulseUnits: 1, unitsPerMeasure: 7, beatsPerMeasure: 3,
    pulseName: 'eighth',
    description: '7/8 (3+2+2) · 7 eighth beats, long group first',
  },
  {
    label: '7/4',
    numerator: 7, denominator: 4,
    meterType: 'asymmetric',
    beatGroups: [4, 3], pulseUnits: 1, unitsPerMeasure: 7, beatsPerMeasure: 2,
    pulseName: 'quarter',
    description: '7/4 (4+3) · 7 quarter beats',
  },
  // ── Compound ─────────────────────────────────────────────────────────────────
  // BPM counts the dotted-quarter pulse; each pulse is 3 eighth-note clicks.
  {
    label: '6/8',
    numerator: 6, denominator: 8,
    meterType: 'compound',
    beatGroups: [3, 3], pulseUnits: 3, unitsPerMeasure: 6, beatsPerMeasure: 2,
    pulseName: 'dotted quarter',
    description: 'Compound duple · 2 dotted-quarter beats · Jig / 6-8 ballad',
  },
  {
    label: '9/8',
    numerator: 9, denominator: 8,
    meterType: 'compound',
    beatGroups: [3, 3, 3], pulseUnits: 3, unitsPerMeasure: 9, beatsPerMeasure: 3,
    pulseName: 'dotted quarter',
    description: 'Compound triple · 3 dotted-quarter beats · Triple jig',
  },
  {
    label: '12/8',
    numerator: 12, denominator: 8,
    meterType: 'compound',
    beatGroups: [3, 3, 3, 3], pulseUnits: 3, unitsPerMeasure: 12, beatsPerMeasure: 4,
    pulseName: 'dotted quarter',
    description: 'Compound quadruple · 4 dotted-quarter beats · Shuffle / Blues',
  },
]

const DEFAULT_TIME_SIGNATURE =
  TIME_SIGNATURE_OPTIONS.find(o => o.label === '4/4') ?? TIME_SIGNATURE_OPTIONS[0]
const resolveTimeSignatureOption = (label?: string | null) =>
  TIME_SIGNATURE_OPTIONS.find(option => option.label === label) ?? DEFAULT_TIME_SIGNATURE

// ─── Web Audio scheduler constants ────────────────────────────────────────────
// Preloaded players per accent on the native path. The shortest gap the app can
// produce is a 12/8 subdivision at 300 BPM — (60/300)/3 = 67 ms — against a
// click that runs 161 ms including its tail, so three players would just cover
// it; four leaves headroom and costs almost nothing.
const CLICK_POOL_SIZE    = 8

// Click pitch is a feel preference rather than part of a preset, so it is kept
// on the device and applies to whatever the user plays next.
const CLICK_PITCH_KEY = 'metronome_click_pitch'
const CUSTOM_CLICK_KEY = 'metronome_custom_click'
// The old key held a single sound. This one holds one per accent, and the
// single one is read once and folded into the downbeat slot so nobody loses
// the sample they already imported.
const CUSTOM_CLICKS_KEY = 'metronome_custom_clicks_v2'
const CUSTOM_CLICK_DIR = `${FileSystem.documentDirectory ?? ''}metronome/`

type CustomClick = { uri: string; name: string }
/** One imported sound per accent level, keyed the same way the clicks are. */
type CustomClicks = Partial<Record<ClickAccent, CustomClick>>

/**
 * The three sounds that can be imported, in the order they are shown.
 *
 * A measure is not one click repeated - it is a downbeat, the beats under it,
 * and the subdivisions between those. Importing a single sound and having it
 * cover all three still works (the empty slots fall back to the downbeat's,
 * played quieter), but a kit of three samples can now be used as three.
 */
const CLICK_SLOTS: { accent: ClickAccent; title: string; hint: string }[] = [
  { accent: 2, title: 'Downbeat', hint: 'The first beat of the measure' },
  { accent: 1, title: 'Beat', hint: 'The other main beats' },
  { accent: 0, title: 'Sub-beat', hint: 'Subdivisions between the beats' },
]

/**
 * The largest sample worth importing.
 *
 * A click is a few tens of milliseconds. The whole file has to be read into
 * memory as base64 and handed to the audio engine, so this is generous for a
 * click and still small enough to cross that boundary without a stall.
 */
const MAX_CLICK_BYTES = 2 * 1024 * 1024

const monotonicNow = () => globalThis.performance?.now?.() ?? Date.now()

const clampPitch = (semitones: number) =>
  Math.max(-PITCH_RANGE_SEMITONES, Math.min(PITCH_RANGE_SEMITONES, Math.round(semitones) || 0))

const LOOKAHEAD_MS       = 25.0   // scheduler wake interval (ms)
const SCHEDULE_AHEAD_SEC = 0.1    // how far ahead to pre-schedule beats

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const isUuid = (value?: string | null) => !!value && UUID_REGEX.test(value)

// ─── Preset types (unchanged) ─────────────────────────────────────────────────
interface MetronomePreset {
  id: string
  name: string
  bpm: number
  inCloud: boolean
  scope: PresetScope
  isPublic: boolean
  playlistNames?: string[]
  isOwnedByOther?: boolean
  ownerUserId?: string
  useTimeSignatures?: boolean
  timeSignatureLabel?: string | null
}

const DEFAULT_PRESETS = [
  { id: 'default-60',  name: '60 BPM',  bpm: 60,  inCloud: false },
  { id: 'default-90',  name: '90 BPM',  bpm: 90,  inCloud: false },
  { id: 'default-120', name: '120 BPM', bpm: 120, inCloud: false },
  { id: 'default-140', name: '140 BPM', bpm: 140, inCloud: false },
  { id: 'default-160', name: '160 BPM', bpm: 160, inCloud: false },
]

export default function MetronomeScreen() {
  const { colors: c } = useAppTheme()
  const styles = useMemo(() => makeStyles(c), [c])

  const { role } = useRole()
  const [bpm, setBpm] = useState(120)
  const [isPlaying, setIsPlaying] = useState(false)
  const [beatFlash, setBeatFlash] = useState(false)

  // While the click is running the player is playing, not tapping - and the
  // beat flash is no use on a screen that has gone dark.
  useKeepScreenAwake(isPlaying, 'metronome')
  const defaultTimeSignature = TIME_SIGNATURE_OPTIONS[2]
  const resolveSelectedTimeSignature = (label?: string | null) =>
    TIME_SIGNATURE_OPTIONS.find(option => option.label === label) ?? defaultTimeSignature

  // ── Audio context ─────────────────────────────────────────────────────────
  const audioCtxRef        = useRef<AudioContext | null>(null)
  const schedulerTimerRef  = useRef<ReturnType<typeof setTimeout> | null>(null)
  const nextBeatTimeRef    = useRef(0)
  const beatInMeasureRef   = useRef(0)
  const isPlayingRef       = useRef(false)
  const bpmRef             = useRef(120)

  // ── Time signature refs — read directly inside schedulerLoop (no stale closures) ──
  const sigRef        = useRef<TimeSignatureOption>(defaultTimeSignature)
  const useTimeSigRef = useRef(false)
  const subdivideRef  = useRef(true)   // click compound subdivisions (6/8 as 6, not 2)

  // ── Fallback click players (no Web Audio, i.e. native) ────────────────────
  //
  // One pool of preloaded players per accent level, played round-robin. A pool
  // rather than a single instance because replaying a player restarts it, which
  // would chop the tail off the click still sounding from the previous beat.
  const clickPoolRef = useRef<Audio.Sound[][]>([[], [], []])
  const poolIdxRef   = useRef<number[]>([0, 0, 0])
  // Bumped on every rebuild so a slow one that has been superseded can bail out
  const poolBuildRef = useRef(0)

  // ── Click pitch ───────────────────────────────────────────────────────────
  // Semitones, -12 to +12. Only the tone frequencies move: the click keeps its
  // length and decay, and the tempo is untouched.
  const [clickPitch, setClickPitch] = useState(0)
  const clickPitchRef = useRef(0)
  const [customClicks, setCustomClicks] = useState<CustomClicks>({})
  const customClicksRef = useRef<CustomClicks>({})

  // -- The timing engine ----------------------------------------------------
  //
  // React Native has no audio clock, so the beat is kept by Web Audio inside
  // a WebView (see lib/metronomeEngineHtml.ts). Everything below only tells it
  // when to start, when to stop, and what the tempo is now - none of which has
  // to arrive on time, which is exactly why the click finally does.
  const engineRef = useRef<WebView>(null)
  const engineReadyRef = useRef(false)
  // Set if the engine says it cannot run here. The old setTimeout-and-replay
  // path is still in the file underneath, and this is what falls back to it.
  const engineFailedRef = useRef(false)
  // Which slot is being imported into, or null. One at a time, so the row
  // that is working is the row that shows a spinner.
  const [importingClick, setImportingClick] = useState<ClickAccent | null>(null)

  // ── UI state ─────────────────────────────────────────────────────────────
  const [presets, setPresets] = useState<MetronomePreset[]>([])
  const [activePreset, setActivePreset] = useState<MetronomePreset | null>(null)
  const [showAddModal, setShowAddModal] = useState(false)
  const [showEditModal, setShowEditModal] = useState(false)
  const [editingPreset, setEditingPreset] = useState<MetronomePreset | null>(null)
  const [menuPreset, setMenuPreset] = useState<MetronomePreset | null>(null)
  const [showPresetMenu, setShowPresetMenu] = useState(false)
  const [newPresetName, setNewPresetName] = useState('')
  const lastPreviewAtRef = useRef<number>(0)
  const [showSaveBar, setShowSaveBar] = useState(false)
  const [showTimeSignatureModal, setShowTimeSignatureModal] = useState(false)
  const [useTimeSignatures, setUseTimeSignatures] = useState(false)
  const [subdivideCompound, setSubdivideCompound] = useState(true)
  const [selectedTimeSignature, setSelectedTimeSignature] = useState<TimeSignatureOption>(defaultTimeSignature)
  const [newPresetScope, setNewPresetScope] = useState<PresetScope>('personal')
  const [newPresetPlaylistName, setNewPresetPlaylistName] = useState('')
  const [newPresetIsPublic, setNewPresetIsPublic] = useState(true)
  const [showPlaylistPicker, setShowPlaylistPicker] = useState(false)
  const [playlistPickerPreset, setPlaylistPickerPreset] = useState<MetronomePreset | null>(null)
  const [playlistPickerName, setPlaylistPickerName] = useState('')
  const [playlistPickerNames, setPlaylistPickerNames] = useState<string[]>([])
  const [playlistPickerScope, setPlaylistPickerScope] = useState<PresetScope>('personal')
  const [playlistPickerMode, setPlaylistPickerMode] = useState<'assign' | 'field'>('assign')
  const [uploadingPresetId, setUploadingPresetId] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<MainTab>('personal')
  const [playlistScopeTab, setPlaylistScopeTab] = useState<PresetScope>('personal')
  const [publicPresets, setPublicPresets] = useState<MetronomePreset[]>([])
  const [openPlaylistNames, setOpenPlaylistNames] = useState<Record<string, boolean>>({})
  const [chordlistPlaylists, setChordlistPlaylists] = useState<string[]>([])
  const [currentUserId, setCurrentUserId] = useState<string | null>(null)
  const [searchText, setSearchText] = useState('')
  const [playlistOrder, setPlaylistOrder] = useState<Record<string, string[]>>({})

  const isManagerOrSuperadmin = role === 'manager' || role === 'superadmin'
  const canUseOverallPlaylists = isManagerOrSuperadmin
  const canCreateOverallPreset = isManagerOrSuperadmin

  const isPresetOwner = useCallback((preset: MetronomePreset) => {
    if (preset.ownerUserId && currentUserId) return preset.ownerUserId === currentUserId
    return !preset.isOwnedByOther
  }, [currentUserId])

  const canModifyPreset = useCallback((preset: MetronomePreset) => {
    if (preset.scope === 'personal') return isPresetOwner(preset)
    if (preset.scope === 'overall') return isManagerOrSuperadmin
    return false
  }, [isManagerOrSuperadmin, isPresetOwner])

  const ensureCanModifyPreset = useCallback((preset: MetronomePreset, actionLabel: string) => {
    if (canModifyPreset(preset)) return true
    if (preset.scope === 'overall') {
      Alert.alert('Permission Denied', `Only manager and superadmin can ${actionLabel.toLowerCase()} overall presets.`)
      return false
    }
    Alert.alert('Permission Denied', `Only the creator can ${actionLabel.toLowerCase()} personal presets.`)
    return false
  }, [canModifyPreset])

  // ── Keep refs in sync with state ──────────────────────────────────────────
  useEffect(() => { bpmRef.current = bpm }, [bpm])
  useEffect(() => { sigRef.current = selectedTimeSignature }, [selectedTimeSignature])
  useEffect(() => { useTimeSigRef.current = useTimeSignatures }, [useTimeSignatures])
  useEffect(() => { subdivideRef.current = subdivideCompound }, [subdivideCompound])

  const postEngine = useCallback((msg: object) => {
    engineRef.current?.postMessage(JSON.stringify(msg))
  }, [])

  /** Is the WebView engine the thing that should be keeping time? */
  const engineUsable = useCallback(
    () => engineReadyRef.current && !engineFailedRef.current,
    [],
  )

  /**
   * Give up on the engine if it never reports in.
   *
   * A WebView that fails to load usually says so, but not always - and the
   * one failure mode that must not happen here is a metronome that makes no
   * sound at all and never explains why. So there is a deadline: miss it, and
   * the old player path is loaded instead.
   */
  useEffect(() => {
    const deadline = setTimeout(() => {
      if (engineReadyRef.current) return
      console.log('[Metronome] engine did not load in time; using the fallback click')
      engineFailedRef.current = true
      void rebuildClickPool(clickPitchRef.current)
    }, 5000)

    return () => clearTimeout(deadline)
    // rebuildClickPool is stable, and this must run once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /**
   * The grid the engine should click on: how long one unit lasts, and the
   * accent pattern laid over the measure. Exactly what the old scheduler
   * worked out for itself every time it woke up.
   */
  const currentGrid = useCallback((overrideBpm?: number) => {
    const sig = sigRef.current
    const useTS = useTimeSigRef.current
    const currentBpm = overrideBpm ?? bpmRef.current

    return {
      unitSec: useTS ? calcUnitSec(currentBpm, sig) : 60 / currentBpm,
      pattern: useTS
        ? buildClickPattern(sig, subdivideRef.current)
        : [{ accent: 2, units: 1 }],
      pitchRatio: pitchRatio(clickPitchRef.current),
    }
  }, [])

  /**
   * Hand one imported sound to the engine.
   *
   * The file is read and decoded once, here, and never on a beat - decoding
   * when a click was already due would put work back on the critical path
   * this engine exists to keep clear.
   */
  const sendSampleToEngine = useCallback(async (accent: ClickAccent, uri: string) => {
    try {
      const data = await FileSystem.readAsStringAsync(uri, {
        encoding: FileSystem.EncodingType.Base64,
      })
      postEngine({ type: 'sample', accent, data })
    } catch (err) {
      console.error('Error sending click sample to the engine:', err)
    }
  }, [postEngine])

  /** Re-send every imported sound, e.g. after the engine has (re)loaded. */
  const syncSamplesToEngine = useCallback(async (clicks: CustomClicks) => {
    postEngine({ type: 'clear-samples' })
    for (const slot of CLICK_SLOTS) {
      const entry = clicks[slot.accent]
      if (entry?.uri) await sendSampleToEngine(slot.accent, entry.uri)
    }
  }, [postEngine, sendSampleToEngine])

  // ── Native click players ──────────────────────────────────────────────────
  //
  // Renders the three clicks at the given pitch and preloads a pool for each.
  // Called at startup and again whenever the pitch is changed, since a rendered
  // file has its pitch baked in. No-op under Web Audio, which synthesises every
  // click live and so picks the new pitch up on the next beat by itself.
  //
  const rebuildClickPool = useCallback(async (semitones: number) => {
    if (audioCtxRef.current) return

    const build = ++poolBuildRef.current
    const built: Audio.Sound[][] = [[], [], []]

    try {
      for (const accent of [0, 1, 2] as ClickAccent[]) {
        // A slot with nothing in it borrows the downbeat's sound, the same
        // way the engine does, so the two paths never disagree about what a
        // given beat is supposed to sound like.
        const imported = customClicksRef.current[accent] ?? customClicksRef.current[2]
        // The pitch is in the filename so players still holding the old file
        // are never reading one that has been overwritten underneath them.
        const uri = imported?.uri ?? `${FileSystem.cacheDirectory}metronome-click-${accent}-${semitones}.wav`
        if (!imported) {
          await FileSystem.writeAsStringAsync(uri, renderClickWavBase64(accent, 44100, semitones), {
            encoding: FileSystem.EncodingType.Base64,
          })
        }

        // Preserve downbeat accents even when every beat uses the same sample.
        const volume = imported ? ([0.55, 0.76, 1][accent] ?? 1) : 1

        for (let i = 0; i < CLICK_POOL_SIZE; i++) {
          const { sound } = await Audio.Sound.createAsync({ uri }, { shouldPlay: false, volume })
          built[accent].push(sound)
        }
      }
    } catch (err) {
      console.error('Error building click pool:', err)
      built.forEach(pool => pool.forEach(sound => sound.unloadAsync().catch(() => {})))
      return
    }

    // A newer rebuild started while this one was still loading - drop ours
    if (build !== poolBuildRef.current) {
      built.forEach(pool => pool.forEach(sound => sound.unloadAsync().catch(() => {})))
      return
    }

    const previous = clickPoolRef.current
    clickPoolRef.current = built
    poolIdxRef.current = [0, 0, 0]
    previous.forEach(pool => pool.forEach(sound => sound.unloadAsync().catch(() => {})))
  }, [])

  // ── Initialise audio ──────────────────────────────────────────────────────
  useEffect(() => {
    const setup = async () => {
      try {
        await Audio.setAudioModeAsync({
          playsInSilentModeIOS: true,
          staysActiveInBackground: true,
        })

        const [storedPitch, storedCustomClicks, storedCustomClick] = await Promise.all([
          AsyncStorage.getItem(CLICK_PITCH_KEY),
          AsyncStorage.getItem(CUSTOM_CLICKS_KEY),
          AsyncStorage.getItem(CUSTOM_CLICK_KEY),
        ])
        const pitch = storedPitch === null ? 0 : clampPitch(Number(storedPitch))
        clickPitchRef.current = pitch
        setClickPitch(pitch)

        // The three-slot map, or the one sound an older build saved, promoted
        // into the downbeat slot. Either way every file is checked to still
        // exist - a sample can be gone after a reinstall, and a slot pointing
        // at nothing would be silence with no explanation.
        let restored: CustomClicks = {}
        try {
          if (storedCustomClicks) {
            restored = (JSON.parse(storedCustomClicks) ?? {}) as CustomClicks
          } else if (storedCustomClick) {
            const legacy = JSON.parse(storedCustomClick) as CustomClick
            if (legacy?.uri) restored = { 2: legacy }
          }
        } catch {
          restored = {}
        }

        const verified: CustomClicks = {}
        for (const slot of CLICK_SLOTS) {
          const entry = restored[slot.accent]
          if (!entry?.uri) continue
          const info = await FileSystem.getInfoAsync(entry.uri).catch(() => null)
          if (info?.exists) verified[slot.accent] = entry
        }

        customClicksRef.current = verified
        setCustomClicks(verified)
        await AsyncStorage.setItem(CUSTOM_CLICKS_KEY, JSON.stringify(verified))
        // The engine may well have reported ready before this read finished,
        // in which case it synced an empty set. Sending them again here is
        // what makes the order of those two not matter.
        void syncSamplesToEngine(verified)
        // The old key has been folded in and is never read again.
        if (storedCustomClick) await AsyncStorage.removeItem(CUSTOM_CLICK_KEY).catch(() => {})

        const AudioContextClass =
          (window as any)?.AudioContext ||
          (window as any)?.webkitAudioContext ||
          null

        if (AudioContextClass) {
          audioCtxRef.current = new AudioContextClass()
        } else {
          // No Web Audio out here in React Native - which is the whole
          // reason the engine exists. The rendered-file pool is the last
          // resort behind it, and building it costs two dozen loaded
          // players, so it waits until the engine has actually failed
          // rather than being paid for on every visit to this screen.
          if (engineFailedRef.current) await rebuildClickPool(pitch)
        }
      } catch (err) {
        console.error('Error initialising audio:', err)
      }
    }
    setup()
    loadPresets()

    return () => {
      stopMetronome()
      audioCtxRef.current?.close()
      clickPoolRef.current.forEach(pool => pool.forEach(sound => sound.unloadAsync()))
    }
  }, [])

  /**
   * What the engine has to say: that it is ready, that a beat has landed, or
   * that it cannot run here.
   */
  const handleEngineMessage = useCallback((event: any) => {
    let msg: any
    try {
      msg = JSON.parse(event.nativeEvent.data)
    } catch {
      return
    }

    switch (msg.type) {
      case 'ready':
        engineReadyRef.current = true
        engineFailedRef.current = false
        void syncSamplesToEngine(customClicksRef.current)
        // The engine can finish loading after the user has already pressed
        // start, so a metronome that is meant to be running picks up here.
        if (isPlayingRef.current) {
          postEngine({ type: 'start', ...currentGrid() })
        }
        break

      case 'beat':
        setBeatFlash(f => !f)
        break

      case 'sample-error':
        console.log('[Metronome] sample rejected:', msg.message)
        Alert.alert('Could not use that sound', msg.message || 'Choose a different audio file.')
        break

      case 'error':
        // Falling back is better than falling silent: the old player path is
        // less steady, but it does make a noise.
        console.log('[Metronome] engine error:', msg.message)
        engineFailedRef.current = true
        void rebuildClickPool(clickPitchRef.current)
        break

      default:
        break
    }
  }, [currentGrid, postEngine, rebuildClickPool, syncSamplesToEngine])

  // ─── Click synthesis — 3 accent levels ────────────────────────────────────
  //
  //  accentLevel 2 = STRONG  → lowest-pitched, loudest (measure downbeat)
  //  accentLevel 1 = MEDIUM  → mid                     (sub-group downbeat)
  //  accentLevel 0 = WEAK    → softest                 (all other beats)
  //
  // A warm wooden "tock": a low sine that glides down in pitch, plus a quiet
  // second harmonic for definition. The old click was a bandpassed noise burst
  // at 900-1600 Hz, which is exactly the range that turns shrill on a phone
  // speaker. CLICK_TONES is shared with the rendered fallback files so both
  // engines sound the same.
  //
  // Every node is stopped only after its envelope has reached zero, so a click
  // is never truncated mid-decay.
  //
  const scheduleClickAtTime = useCallback((time: number, accentLevel: number = 0) => {
    const ctx = audioCtxRef.current
    if (!ctx) return

    const base  = CLICK_TONES[(accentLevel as ClickAccent)] ?? CLICK_TONES[0]
    // Read live, so dragging the pitch slider is audible on the very next beat
    const tone  = shiftTone(base, clickPitchRef.current)
    const total = clickDurationSec(tone)

    const gainNode = ctx.createGain()
    gainNode.connect(ctx.destination)

    // Short ramp up rather than an instant start — an instant one pops
    gainNode.gain.setValueAtTime(0.0001, time)
    gainNode.gain.exponentialRampToValueAtTime(tone.level, time + 0.003)
    gainNode.gain.exponentialRampToValueAtTime(0.0001, time + tone.decaySec * DECAY_TAIL)
    // Land on true zero so the stop below has nothing left to cut
    gainNode.gain.linearRampToValueAtTime(0, time + total)

    const harmonicGain = ctx.createGain()
    harmonicGain.gain.value = 0.3
    harmonicGain.connect(gainNode)

    const fundamental = ctx.createOscillator()
    const harmonic    = ctx.createOscillator()
    fundamental.type = 'sine'
    harmonic.type    = 'sine'

    // Pitch drops away from the attack — what makes it read as struck wood
    const glideEnd = time + tone.decaySec * 0.4
    fundamental.frequency.setValueAtTime(tone.startHz, time)
    fundamental.frequency.exponentialRampToValueAtTime(tone.endHz, glideEnd)
    harmonic.frequency.setValueAtTime(tone.startHz * 2, time)
    harmonic.frequency.exponentialRampToValueAtTime(tone.endHz * 2, glideEnd)

    fundamental.connect(gainNode)
    harmonic.connect(harmonicGain)

    fundamental.start(time)
    harmonic.start(time)
    fundamental.stop(time + total)
    harmonic.stop(time + total)
  }, [])

  // Round-robin the pool so a click still decaying is never restarted, which
  // is what used to chop the sound off at fast tempos.
  const playClickFallback = async (accent: ClickAccent = 0) => {
    try {
      const pool = clickPoolRef.current[accent]
      if (!pool?.length) return
      const idx = poolIdxRef.current[accent] % pool.length
      poolIdxRef.current[accent] = (idx + 1) % pool.length
      await pool[idx].replayAsync()
    } catch (err) {
      console.error('Fallback click error:', err)
    }
  }

  // ─── Lookahead scheduler ───────────────────────────────────────────────────
  //
  // Reads time signature data from refs (sigRef, useTimeSigRef, subdivideRef)
  // so it always sees the current value without needing to restart or
  // re-create the callback.
  //
  // Clicks are not all the same length: a compound meter with subdivisions off
  // holds one click for a whole 3-unit group. So each step carries how many
  // grid units it spans, and the clock advances by step.units * unitSec.
  //
  const schedulerLoop = useCallback(() => {
    const ctx = audioCtxRef.current
    if (!isPlayingRef.current) return

    const sig        = sigRef.current
    const useTS      = useTimeSigRef.current
    const currentBpm = bpmRef.current

    // Duration of one grid unit (music-theory correct — see calcUnitSec)
    const unitSec = useTS ? calcUnitSec(currentBpm, sig) : (60 / currentBpm)

    // Click pattern for the measure (or one plain click if time sigs are off)
    const pattern: ClickStep[] = useTS
      ? buildClickPattern(sig, subdivideRef.current)
      : [{ accent: 2, units: 1 }]

    if (ctx) {
      // ── Web Audio path ──────────────────────────────────────────────────
      //
      // If the clock has fallen behind — the tab was backgrounded, or the
      // device throttled our timer — resync instead of firing a burst of
      // catch-up clicks, and restart the measure so the downbeat stays right.
      if (nextBeatTimeRef.current < ctx.currentTime - unitSec) {
        nextBeatTimeRef.current = ctx.currentTime + SCHEDULE_AHEAD_SEC
        beatInMeasureRef.current = 0
      }

      while (nextBeatTimeRef.current < ctx.currentTime + SCHEDULE_AHEAD_SEC) {
        const step = pattern[beatInMeasureRef.current % pattern.length]

        scheduleClickAtTime(nextBeatTimeRef.current, step.accent)

        // Sync visual flash to audio timing
        const visualDelayMs = Math.max(0, (nextBeatTimeRef.current - ctx.currentTime) * 1000)
        setTimeout(() => {
          if (isPlayingRef.current) setBeatFlash(f => !f)
        }, visualDelayMs)

        nextBeatTimeRef.current += unitSec * step.units
        beatInMeasureRef.current = (beatInMeasureRef.current + 1) % pattern.length
      }
    } else {
      // ── Fallback path (drift-corrected setTimeout) ───────────────────────
      const step = pattern[beatInMeasureRef.current % pattern.length]
      playClickFallback(step.accent as ClickAccent)
      setBeatFlash(f => !f)

      nextBeatTimeRef.current += unitSec * step.units * 1000   // ms
      beatInMeasureRef.current = (beatInMeasureRef.current + 1) % pattern.length

      // Same resync guard as above: a due time already well in the past means
      // we lost time somewhere, so start a fresh measure from now.
      const now = monotonicNow()
      if (nextBeatTimeRef.current < now - unitSec * 1000) {
        nextBeatTimeRef.current = now + unitSec * 1000
        beatInMeasureRef.current = 0
      }

      const delay = Math.max(0, nextBeatTimeRef.current - monotonicNow())
      schedulerTimerRef.current = setTimeout(schedulerLoop, delay)
      return
    }

    schedulerTimerRef.current = setTimeout(schedulerLoop, LOOKAHEAD_MS)
  }, [scheduleClickAtTime])

  // ─── Start / stop ──────────────────────────────────────────────────────────

  const startScheduler = useCallback((overrideBpm?: number) => {
    if (overrideBpm !== undefined) bpmRef.current = overrideBpm
    beatInMeasureRef.current = 0   // always restart measure phase on start

    // The engine keeps its own clock, so there is nothing to schedule here.
    if (engineUsable()) {
      isPlayingRef.current = true
      postEngine({ type: 'start', ...currentGrid(overrideBpm) })
      return
    }

    const ctx = audioCtxRef.current
    if (ctx) {
      if (ctx.state === 'suspended') ctx.resume()
      // A hair ahead of 'now' so the very first click is scheduled, not clipped
      nextBeatTimeRef.current = ctx.currentTime + 0.05
    } else {
      nextBeatTimeRef.current = monotonicNow()
    }

    isPlayingRef.current = true
    schedulerLoop()
  }, [schedulerLoop, engineUsable, postEngine, currentGrid])

  const stopScheduler = useCallback(() => {
    isPlayingRef.current = false
    // Sent unconditionally: if the engine was not the one playing, a stop it
    // was not expecting costs nothing.
    postEngine({ type: 'stop' })
    if (schedulerTimerRef.current) {
      clearTimeout(schedulerTimerRef.current)
      schedulerTimerRef.current = null
    }
  }, [postEngine])

  /**
   * A tempo, meter or pitch change while the click is running.
   *
   * The two older paths read these out of refs every time they woke up, so
   * they picked a change up by themselves. The engine cannot - it is keeping
   * its own clock on the other side of the bridge - so it has to be told.
   *
   * It keeps its phase when told, so nothing jumps: the new spacing applies
   * from the first beat that has not already been handed to the audio thread.
   */
  useEffect(() => {
    if (!isPlaying || !engineUsable()) return
    postEngine({ type: 'update', ...currentGrid() })
  }, [
    bpm, selectedTimeSignature, useTimeSignatures, subdivideCompound, clickPitch,
    isPlaying, engineUsable, postEngine, currentGrid,
  ])

  const startMetronome = () => { setIsPlaying(true); startScheduler() }
  const stopMetronome  = () => { setIsPlaying(false); stopScheduler() }
  const toggleMetronome = () => {
    if (isPlayingRef.current) stopMetronome()
    else startMetronome()
  }

  // ── BPM changes while playing ─────────────────────────────────────────────
  useEffect(() => {
    if (!isPlayingRef.current) return
    bpmRef.current = bpm
    // Engine: told separately, and it keeps its phase - restarting it here
    // would drop a downbeat every time the tempo nudged by one.
    // AudioContext: scheduler reads bpmRef on each tick — no restart needed
    // Fallback: restart with new BPM
    if (!audioCtxRef.current && !engineUsable()) {
      stopScheduler()
      startScheduler(bpm)
    }
  }, [bpm])

  // ── Real-time time signature change ──────────────────────────────────────
  //
  // Update refs first (so the scheduler sees new values immediately),
  // then reset the beat-in-measure counter so the new pattern starts clean.
  // The AudioContext scheduler picks up sigRef on its very next tick (within
  // LOOKAHEAD_MS = 25 ms) with zero audible glitch.
  // The fallback path needs an explicit restart to reset its drift timer.
  //
  useEffect(() => {
    sigRef.current        = selectedTimeSignature
    useTimeSigRef.current = useTimeSignatures
    subdivideRef.current  = subdivideCompound

    // Reset measure position so the new pattern always starts on beat 1
    beatInMeasureRef.current = 0

    if (isPlayingRef.current && !audioCtxRef.current && !engineUsable()) {
      // Fallback: restart drift-corrected timer
      stopScheduler()
      startScheduler()
    }
    // AudioContext path: no restart needed — scheduler reads sigRef next tick ✓
    // Engine path: sent the new grid separately, and it starts the measure
    // again by itself whenever the pattern length changes.
  }, [useTimeSignatures, selectedTimeSignature, subdivideCompound])

  // ─── Preset persistence ────────────────────────────────────────────────────

  const getPresetsKey = (userId: string) => `metronome_presets_${userId}`

  const getPlaylistOrderKey = (userId: string) => `metronome_playlist_order_${userId}`

const loadPlaylistOrder = async (userId: string) => {
  try {
    const stored = await AsyncStorage.getItem(getPlaylistOrderKey(userId))
    if (stored) setPlaylistOrder(JSON.parse(stored))
  } catch {}
}

const savePlaylistOrder = async (order: Record<string, string[]>) => {
  try {
    const user = await getCurrentUser()
    if (!user) return
    await AsyncStorage.setItem(getPlaylistOrderKey(user.id), JSON.stringify(order))
  } catch {}
}

  const loadPresets = async () => {
    try {
      const user = await getCurrentUser()
      if (!user) return
      setCurrentUserId(user.id)
      await loadPlaylistOrder(user.id)

      const PRESETS_KEY = getPresetsKey(user.id)
      const stored = await AsyncStorage.getItem(PRESETS_KEY)
      const allLocalPresets: MetronomePreset[] = stored ? JSON.parse(stored) : []

      let ownCloudPresets: MetronomePreset[] = []
      let fetchedPublicPresets: MetronomePreset[] = []

      const { data: ownData } = await supabase
        .from('metronome_presets')
        .select('*')
        .eq('user_id', user.id)

      if (ownData) {
        ownCloudPresets = ownData.map((row: any) => ({
          id: row.id,
          name: row.name,
          bpm: row.bpm,
          inCloud: true,
          scope: getEffectivePresetScope({
            scope: row.scope ?? 'personal',
            playlistNames: (row.playlist_name || '').split(',').map((s: string) => s.trim()).filter(Boolean),
          }),
          isPublic: getEffectivePresetScope({
            scope: row.scope ?? 'personal',
            playlistNames: (row.playlist_name || '').split(',').map((s: string) => s.trim()).filter(Boolean),
          }) === 'overall',
          playlistNames: (row.playlist_name || '').split(',').map((s: string) => s.trim()).filter(Boolean),
          isOwnedByOther: false,
          ownerUserId: row.user_id,
          useTimeSignatures: !!row.use_time_signatures,
          timeSignatureLabel: row.time_signature_label ?? null,
        }))
      }

      const { data: publicData } = await supabase
        .from('metronome_presets')
        .select('*')
        .neq('user_id', user.id)
        .eq('scope', 'overall')
        .eq('is_public', true)

      if (publicData) {
        fetchedPublicPresets = publicData.map((row: any) => ({
          id: row.id,
          name: row.name,
          bpm: row.bpm,
          inCloud: true,
          scope: 'overall' as PresetScope,
          isPublic: true,
          playlistNames: (row.playlist_name || '').split(',').map((s: string) => s.trim()).filter(Boolean),
          isOwnedByOther: true,
          ownerUserId: row.user_id,
          useTimeSignatures: !!row.use_time_signatures,
          timeSignatureLabel: row.time_signature_label ?? null,
        }))
      }

      const remoteCloudIds = new Set([...ownCloudPresets, ...fetchedPublicPresets].map(p => p.id))
      const mergedLocal = allLocalPresets
        .filter(p => !remoteCloudIds.has(p.id))
        .map(normalizePresetVisibility)
      const ownPresets = [...mergedLocal, ...ownCloudPresets].map(normalizePresetVisibility)
      const uniqueOwnPresets = ownPresets.reduce<MetronomePreset[]>((items, preset) => {
        if (!items.some(existing => existing.id === preset.id)) items.push(preset)
        return items
      }, [])

      setPresets(uniqueOwnPresets)
      setPublicPresets(fetchedPublicPresets)
      try {
        const cls = await getPlaylistsByUserId(user.id)
        const playlistsWithItems = await Promise.all(
          (cls || []).map(async (playlist: any) => {
            try {
              const items = await getPlaylistItems(playlist.id)
              return (items?.length || 0) > 0 ? playlist : null
            } catch {
              return null
            }
          })
        )
        const titles = playlistsWithItems
          .filter(Boolean)
          .map((r: any) => r.title)
          .filter(Boolean)
        setChordlistPlaylists(titles)
      } catch (e) {
        console.warn('Failed to load chordlist playlists:', e)
        setChordlistPlaylists([])
      }
      await savePresetsLocally(uniqueOwnPresets)
    } catch (err) {
      console.error('Error loading presets:', err)
      setPresets([])
      setPublicPresets([])
    }
  }

  const savePresetsLocally = async (updatedPresets: MetronomePreset[]) => {
    try {
      const user = await getCurrentUser()
      if (!user) return
      const PRESETS_KEY = getPresetsKey(user.id)
      await AsyncStorage.setItem(PRESETS_KEY, JSON.stringify(updatedPresets))
    } catch (err) {
      console.error('Error saving presets locally:', err)
    }
  }

  const resetPresetForm = (preset?: MetronomePreset | null) => {
    setEditingPreset(preset ?? null)
    setNewPresetName(preset?.name ?? '')
    setNewPresetScope(preset?.scope ?? (activeTab === 'overall' ? 'overall' : 'personal'))
    setNewPresetPlaylistName(preset?.playlistNames?.[0] ?? '')
    setNewPresetIsPublic(preset?.scope === 'overall' ? true : false)
    setUseTimeSignatures(!!preset?.useTimeSignatures)
    setSelectedTimeSignature(resolveSelectedTimeSignature(preset?.timeSignatureLabel))
    setShowAddModal(!preset)
    setShowEditModal(!!preset)
  }

  const openPlaylistPicker = (preset: MetronomePreset | null, mode: 'assign' | 'field' = 'assign') => {
    const presetPlaylistNames = (preset?.playlistNames ?? []).filter(name => canUseOverallPlaylists || getPlaylistScope(name) === 'personal')
    setPlaylistPickerPreset(preset)
    setPlaylistPickerNames(presetPlaylistNames)
    setPlaylistPickerName(presetPlaylistNames[0] ?? '')
    setPlaylistPickerScope('personal')
    setPlaylistPickerMode(mode)
    setShowPlaylistPicker(true)
  }

  const closePlaylistPicker = () => {
    setShowPlaylistPicker(false)
    setPlaylistPickerPreset(null)
    setPlaylistPickerName('')
    setPlaylistPickerNames([])
    setPlaylistPickerScope('personal')
    setPlaylistPickerMode('assign')
  }

  const getScopedPlaylistName = (name: string, scope: PresetScope) => {
    const trimmed = name.trim()
    if (!trimmed) return ''
    return scope === 'overall' ? `Overall: ${trimmed}` : trimmed
  }

  const getPlaylistScope = (name: string): PresetScope =>
    name.trim().toLowerCase().startsWith('overall:') ? 'overall' : 'personal'

  const getPlaylistDisplayName = (name: string) =>
    name.replace(/^overall:\s*/i, '').trim()

  const getCanonicalPlaylistName = (name: string, scope: PresetScope) => {
    const display = getPlaylistDisplayName(name)
    return scope === 'overall' ? `Overall: ${display}` : display
  }

  const getScopedPlaylistNamesForCopy = (playlistNames: string[] | undefined, scope: PresetScope) => {
    const displayNames = (playlistNames ?? [])
      .map(name => getPlaylistDisplayName(name).trim())
      .filter(Boolean)
    return Array.from(new Set(displayNames.map(name => getCanonicalPlaylistName(name, scope))))
  }

  const getEffectivePresetScope = (preset: Pick<MetronomePreset, 'scope' | 'playlistNames'>): PresetScope => {
    const hasOverallPlaylist = (preset.playlistNames ?? []).some(name => getPlaylistScope(name) === 'overall')
    return hasOverallPlaylist ? 'overall' : preset.scope
  }

  const normalizePresetVisibility = (preset: MetronomePreset): MetronomePreset => ({
    ...preset,
    isPublic: preset.scope === 'overall',
  })

  const getPresetCopyFingerprint = (preset: MetronomePreset) =>
    [
      preset.scope,
      preset.name.trim().toLowerCase(),
      String(preset.bpm),
      getScopedPlaylistNamesForCopy(preset.playlistNames, preset.scope).sort().join('|'),
    ].join('::')

  const getPresetPairKey = (preset: Pick<MetronomePreset, 'name' | 'bpm' | 'playlistNames'>) =>
    [
      preset.name.trim().toLowerCase(),
      String(preset.bpm),
      getScopedPlaylistNamesForCopy(preset.playlistNames, 'personal').sort().join('|'),
    ].join('::')

  const makePresetCopy = (preset: MetronomePreset, scope: PresetScope): MetronomePreset => ({
    ...preset,
    id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    scope,
    isPublic: scope === 'overall',
    playlistNames: getScopedPlaylistNamesForCopy(preset.playlistNames, scope),
    inCloud: false,
    isOwnedByOther: false,
    ownerUserId: currentUserId ?? preset.ownerUserId,
  })

  const getCurrentTimeSignatureState = () => ({
    useTimeSignatures,
    timeSignatureLabel: useTimeSignatures ? selectedTimeSignature.label : null,
  })

  const savePresetPlaylist = async (preset: MetronomePreset, playlistNames: string[] | string) => {
    const incomingNames = Array.isArray(playlistNames) ? playlistNames : [playlistNames]
    const names = incomingNames.map(name => name.trim()).filter(Boolean)
    if (names.some(name => getPlaylistScope(name) === 'overall') && !canUseOverallPlaylists) {
      Alert.alert('Permission Denied', 'Only manager and superadmin can add presets to overall playlists.')
      return false
    }

    const existing = preset.playlistNames ?? []
    const nextPlaylistNames = Array.from(new Set([...existing, ...names]))
    const nextScope = getEffectivePresetScope({ scope: preset.scope, playlistNames: nextPlaylistNames })
    const forcePersonalCopy = preset.scope === 'overall'
    const hasDirectEditPermission = canModifyPreset(preset) && !forcePersonalCopy
    const existingPersonalCopy = presets.find(existingPreset =>
      existingPreset.scope === 'personal' && getPresetPairKey(existingPreset) === getPresetPairKey(preset)
    ) ?? null

    const nextPreset = forcePersonalCopy
      ? existingPersonalCopy
        ? {
            ...existingPersonalCopy,
            name: preset.name,
            bpm: preset.bpm,
            scope: 'personal' as PresetScope,
            isPublic: false,
            playlistNames: nextPlaylistNames,
          }
        : {
            ...makePresetCopy(preset, 'personal'),
            name: preset.name,
            bpm: preset.bpm,
            scope: 'personal' as PresetScope,
            isPublic: false,
            playlistNames: nextPlaylistNames,
          }
      : hasDirectEditPermission
        ? { ...preset, scope: nextScope, isPublic: nextScope === 'overall', playlistNames: nextPlaylistNames }
        : existingPersonalCopy
          ? {
              ...existingPersonalCopy,
              name: preset.name,
              bpm: preset.bpm,
              scope: 'personal' as PresetScope,
              isPublic: false,
              playlistNames: nextPlaylistNames,
            }
          : {
              ...makePresetCopy(preset, 'personal'),
              name: preset.name,
              bpm: preset.bpm,
              scope: 'personal' as PresetScope,
              isPublic: false,
              playlistNames: nextPlaylistNames,
            }

    const updated = forcePersonalCopy
      ? existingPersonalCopy
        ? presets.map(p => p.id === existingPersonalCopy.id ? nextPreset : p)
        : [...presets, nextPreset]
      : hasDirectEditPermission
        ? presets.map(p => p.id === preset.id ? nextPreset : p)
        : existingPersonalCopy
          ? presets.map(p => p.id === existingPersonalCopy.id ? nextPreset : p)
          : [...presets, nextPreset]
    setPresets(updated)
    await savePresetsLocally(updated)

    const persistTargetId = hasDirectEditPermission
      ? (preset.inCloud && isUuid(preset.id) ? preset.id : undefined)
      : (forcePersonalCopy && existingPersonalCopy?.inCloud && isUuid(existingPersonalCopy.id) ? existingPersonalCopy.id : undefined)
        || (!forcePersonalCopy && existingPersonalCopy?.inCloud && isUuid(existingPersonalCopy.id) ? existingPersonalCopy.id : undefined)

    const cloudRow = await persistPreset(nextPreset, persistTargetId)
    if (cloudRow) {
      const synced = hasDirectEditPermission
        ? updated.map(p => p.id === preset.id ? { ...nextPreset, id: cloudRow.id, inCloud: true } : p)
        : existingPersonalCopy
          ? updated.map(p => p.id === existingPersonalCopy.id ? { ...nextPreset, id: cloudRow.id, inCloud: true } : p)
          : updated.map(p => p.id === nextPreset.id ? { ...nextPreset, id: cloudRow.id, inCloud: true } : p)
      setPresets(synced)
      await savePresetsLocally(synced)
      await loadPresets()
      setActivePreset(synced.find(p => p.id === cloudRow.id) ?? nextPreset)
      return true
    }
    await showCloudFailAlert(nextPreset, 'Save Playlist')
    return false
  }

  const handleRemovePresetFromPlaylist = async (preset: MetronomePreset, playlistName?: string) => {
    if (!ensureCanModifyPreset(preset, 'Update Playlist')) return
    if (!playlistName) { await savePresetPlaylist(preset, ''); return }
    const existing = preset.playlistNames ?? []
    const next = existing.filter(n => n !== playlistName)
    if (preset.scope === 'personal' && next.length === 0) {
      try {
        if (preset.inCloud && isUuid(preset.id)) {
          await supabase.from('metronome_presets').delete().eq('id', preset.id)
        }
        const updated = presets.filter(p => p.id !== preset.id)
        setPresets(updated)
        await savePresetsLocally(updated)
        if (activePreset?.id === preset.id) setActivePreset(null)
      } catch (err) {
        Alert.alert('Error', 'Failed to delete preset')
      }
      return
    }
    const nextPreset = { ...preset, playlistNames: next }
    const updated = presets.map(p => p.id === preset.id ? nextPreset : p)
    setPresets(updated)
    await savePresetsLocally(updated)
    const cloudRow = await persistPreset(nextPreset, preset.inCloud && isUuid(preset.id) ? preset.id : undefined)
    if (cloudRow) {
      const synced = updated.map(p => p.id === preset.id ? { ...nextPreset, id: cloudRow.id, inCloud: true } : p)
      setPresets(synced)
      await savePresetsLocally(synced)
      await loadPresets()
    }
  }

  const handleSavePlaylistFromPicker = async () => {
    const newName = playlistPickerName.trim()
    const effectivePickerScope = canUseOverallPlaylists ? playlistPickerScope : 'personal'
    const scopedNewName = newName ? getScopedPlaylistName(newName, effectivePickerScope) : ''
    const selections = Array.from(new Set([...(playlistPickerNames || []), ...(scopedNewName ? [scopedNewName] : [])])).filter(Boolean)
    if (selections.length === 0) { Alert.alert('Error', 'Enter a playlist name or choose one from the list'); return }

    if (playlistPickerMode === 'field' || !playlistPickerPreset) {
      setNewPresetPlaylistName(selections[0])
      closePlaylistPicker()
      return
    }
    await savePresetPlaylist(playlistPickerPreset, selections)
    closePlaylistPicker()
  }

  const handleQuickAddPlaylist = async () => {
    const targetPreset = activePreset ?? null
    if (!targetPreset) { Alert.alert('Add Playlist', 'Select a preset first, then add it to a playlist.'); return }
    openPlaylistPicker(targetPreset)
  }

  const togglePlaylistAccordion = (name: string) =>
    setOpenPlaylistNames(prev => ({ ...prev, [name]: !prev[name] }))

  const handleReorderPlaylistPreset = async (playlistName: string, fromIndex: number, direction: 'up' | 'down') => {
  const group = getOrderedPlaylistGroup(playlistName)
  const toIndex = direction === 'up' ? fromIndex - 1 : fromIndex + 1
  if (toIndex < 0 || toIndex >= group.length) return
  const newGroup = [...group]
  const [moved] = newGroup.splice(fromIndex, 1)
  newGroup.splice(toIndex, 0, moved)
  const newOrder = { ...playlistOrder, [playlistName]: newGroup.map(p => p.id) }
  setPlaylistOrder(newOrder)
  await savePlaylistOrder(newOrder)
}

const getOrderedPlaylistGroup = (playlistName: string): MetronomePreset[] => {
  const group = playlistGroups[playlistName] || []
  const order = playlistOrder[playlistName]
  if (!order || order.length === 0) return group
  const indexed = Object.fromEntries(group.map(p => [p.id, p]))
  const ordered = order.map(id => indexed[id]).filter(Boolean)
  // append any newly added presets not yet in order
  const inOrder = new Set(order)
  const extras = group.filter(p => !inOrder.has(p.id))
  return [...ordered, ...extras]
}

  const handleChangePlaylistScope = async (playlistName: string, targetScope: PresetScope) => {
    const currentScope = getPlaylistScope(playlistName)
    if (currentScope === targetScope) return
    if (targetScope === 'overall' && !isManagerOrSuperadmin) {
      Alert.alert('Permission Denied', 'Only manager and superadmin can copy personal playlists to overall.')
      return
    }

    const groupItems = playlistGroups[playlistName] || []
    if (groupItems.length === 0) return

    let workingPresets = [...presets]
    let copiedCount = 0, skippedCount = 0, duplicateCount = 0

    for (const item of groupItems) {
      let sourcePreset = workingPresets.find(p => p.id === item.id)
      if (!sourcePreset) {
        // fall back to playlistSource (which includes public presets)
        sourcePreset = (playlistSource || []).find(p => p.id === item.id)
        if (sourcePreset) console.warn('handleChangePlaylistScope: using playlistSource as source for copy', item.id)
      }
      if (!sourcePreset) { console.warn('handleChangePlaylistScope: skipping - preset not found in local or playlist source', item.id); skippedCount++; continue }

      if (targetScope === 'overall' && !isManagerOrSuperadmin) { console.warn('handleChangePlaylistScope: skipping - no permission to copy to overall', item.id); skippedCount++; continue }

      const nextPreset = makePresetCopy(sourcePreset, targetScope)
      if (workingPresets.some(existing => getPresetCopyFingerprint(existing) === getPresetCopyFingerprint(nextPreset))) {
        duplicateCount++; continue
      }
      workingPresets = [...workingPresets, nextPreset]
      copiedCount++
      try {
        const cloudRow = await persistPreset(nextPreset)
        if (cloudRow) {
          workingPresets = workingPresets.map(p =>
            p.id === nextPreset.id ? { ...nextPreset, id: cloudRow.id, inCloud: true, ownerUserId: cloudRow.user_id ?? nextPreset.ownerUserId } : p
          )
        }
      } catch (err) {
        console.warn('Failed to sync playlist copy for preset:', sourcePreset.id, err)
      }
    }

    if (copiedCount === 0) {
      const message = duplicateCount > 0 ? 'A matching copy already exists for this playlist.'
        : skippedCount > 0 ? 'No presets could be copied from this playlist. Skipped items were not found locally or you lack permission to copy them.'
        : 'Nothing to copy for this playlist.'
      Alert.alert('No Changes', message)
      return
    }

    setPresets(workingPresets)
    await savePresetsLocally(workingPresets)
    await loadPresets()
    const parts = [
      `${copiedCount} copy${copiedCount === 1 ? '' : 'ies'} created`,
      duplicateCount > 0 ? `${duplicateCount} already existed` : '',
      skippedCount > 0 ? `${skippedCount} skipped` : '',
    ].filter(Boolean)
    Alert.alert('Playlist Updated', parts.join('. '))
  }

  const persistPreset = async (preset: MetronomePreset, existingId?: string, forcedScope?: PresetScope) => {
    const user = await getCurrentUser()
    if (!user) return null
    const effectiveScope = forcedScope ?? getEffectivePresetScope(preset)

    const payload: any = {
      user_id: user.id,
      name: preset.name,
      bpm: preset.bpm,
      scope: effectiveScope,
      is_public: effectiveScope === 'overall',
      playlist_name: (preset.playlistNames && preset.playlistNames.length) ? preset.playlistNames.join(',') : '',
      use_time_signatures: !!preset.useTimeSignatures,
      time_signature_label: preset.useTimeSignatures ? (preset.timeSignatureLabel ?? null) : null,
    }
    if (isUuid(preset.id)) payload.id = preset.id

    if (existingId && isUuid(existingId)) {
      const updatePayload: any = {
        name: preset.name, bpm: preset.bpm, scope: effectiveScope,
        is_public: effectiveScope === 'overall',
        playlist_name: (preset.playlistNames && preset.playlistNames.length) ? preset.playlistNames.join(',') : '',
        use_time_signatures: !!preset.useTimeSignatures,
        time_signature_label: preset.useTimeSignatures ? (preset.timeSignatureLabel ?? null) : null,
      }
      const { data, error } = await supabase.from('metronome_presets').update(updatePayload).eq('id', existingId).select()
      if (error) {
        console.warn('persistPreset UPDATE error', error)
        if (error.code === '42501') { Alert.alert('Cloud Permission Denied', 'Supabase denied update (RLS).'); return null }
        Alert.alert('Cloud Error', `${error.message || 'Unknown error'} (${error.code || 'no-code'})`)
        throw error
      }
      return Array.isArray(data) ? data[0] ?? null : data ?? null
    }

    const { data, error } = await supabase.from('metronome_presets').insert(payload).select()
    if (error) {
      console.warn('persistPreset INSERT error', error)
      if (error.code === '42501') { Alert.alert('Cloud Permission Denied', 'Supabase denied insert (RLS).'); return null }
      Alert.alert('Cloud Error', `${error.message || 'Unknown error'} (${error.code || 'no-code'})`)
      throw error
    }
    return Array.isArray(data) ? data[0] ?? null : data ?? null
  }

  const handleAddPreset = async () => {
    if (!newPresetName.trim()) { Alert.alert('Error', 'Please enter a preset name'); return }
    if (newPresetScope === 'overall' && !canCreateOverallPreset) {
      Alert.alert('Permission Denied', 'Only manager and superadmin can create overall presets.')
      return
    }

    const newPreset: MetronomePreset = {
      id: `local-${Date.now()}`,
      name: newPresetName.trim(),
      bpm,
      inCloud: false,
      scope: newPresetScope,
      isPublic: newPresetScope === 'overall' ? true : false,
      playlistNames: newPresetPlaylistName.trim() ? [newPresetPlaylistName.trim()] : [],
      ownerUserId: currentUserId ?? undefined,
      ...getCurrentTimeSignatureState(),
    }

    const updated = [...presets, newPreset]
    setPresets(updated)
    await savePresetsLocally(updated)
    setEditingPreset(null); setNewPresetName(''); setNewPresetScope('personal')
    setNewPresetPlaylistName(''); setNewPresetIsPublic(false)
    setShowAddModal(false); setShowEditModal(false)
    setActiveTab(newPresetScope)

    if (newPresetScope === 'overall') {
      try {
        const data = await persistPreset(newPreset)
        if (!data) { Alert.alert('Saved locally', `"${newPreset.name}" saved at ${bpm} BPM. Sign in to sync to cloud.`); return }
        const synced = updated.map(p => p.id === newPreset.id ? { ...p, id: data.id, inCloud: true, isPublic: true } : p)
        setPresets(synced); await savePresetsLocally(synced)
        Alert.alert('Synced', `"${newPreset.name}" saved and synced to cloud at ${bpm} BPM`)
      } catch (err) {
        console.error('Auto-sync failed:', err)
        Alert.alert('Saved locally', `"${newPreset.name}" saved at ${bpm} BPM but cloud sync failed.`)
      }
    } else {
      Alert.alert('Saved', `"${newPreset.name}" saved locally at ${bpm} BPM`)
    }
  }

  const handleSavePresetEdit = async () => {
    if (!editingPreset) return
    if (!ensureCanModifyPreset(editingPreset, 'Edit')) return
    if (!newPresetName.trim()) { Alert.alert('Error', 'Please enter a preset name'); return }

    const scopeChanged = editingPreset.scope !== newPresetScope
    const nextPlaylistNames = newPresetPlaylistName.trim()
      ? [newPresetPlaylistName.trim()]
      : (editingPreset.playlistNames ?? [])

    const nextPreset: MetronomePreset = scopeChanged
      ? {
          ...makePresetCopy(editingPreset, newPresetScope),
          name: newPresetName.trim(),
          bpm,
          playlistNames: nextPlaylistNames,
          ...getCurrentTimeSignatureState(),
        }
      : {
          ...editingPreset,
          name: newPresetName.trim(),
          bpm,
          scope: newPresetScope,
          isPublic: newPresetScope === 'overall',
          playlistNames: nextPlaylistNames,
          ...getCurrentTimeSignatureState(),
        }

    const updated = scopeChanged
      ? [...presets, nextPreset]
      : presets.map(p => p.id === editingPreset.id ? nextPreset : p)
    const pairKey = getPresetPairKey(editingPreset)
    const linkedPresets = presets.filter(p => p.id !== editingPreset.id && getPresetPairKey(p) === pairKey)

    setPresets(updated); await savePresetsLocally(updated)

    try {
      const cloudRow = await persistPreset(
        nextPreset,
        scopeChanged && editingPreset.inCloud && isUuid(editingPreset.id) ? undefined : (editingPreset.inCloud && isUuid(editingPreset.id) ? editingPreset.id : undefined)
      )
      const syncLinkedPreset = async (linkedPreset: MetronomePreset) => {
        const linkedNextPreset = {
          ...linkedPreset,
          name: newPresetName.trim(),
          bpm,
          playlistNames: nextPlaylistNames,
        }
        const linkedCloudRow = await persistPreset(
          linkedNextPreset,
          linkedPreset.inCloud && isUuid(linkedPreset.id) ? linkedPreset.id : undefined,
          linkedPreset.scope
        )
        return linkedCloudRow
          ? { ...linkedNextPreset, id: linkedCloudRow.id, inCloud: true, ownerUserId: linkedCloudRow.user_id ?? linkedNextPreset.ownerUserId }
          : linkedNextPreset
      }

      if (cloudRow) {
        const synced = scopeChanged
          ? updated.map(p => p.id === nextPreset.id ? { ...nextPreset, id: cloudRow.id, inCloud: true, ownerUserId: cloudRow.user_id ?? nextPreset.ownerUserId } : p)
          : updated.map(p => p.id === editingPreset.id ? { ...nextPreset, id: cloudRow.id, inCloud: true } : p)
        let finalPresets = synced
        for (const linkedPreset of linkedPresets) {
          const syncedLinkedPreset = await syncLinkedPreset(linkedPreset)
          finalPresets = finalPresets.map(p => p.id === linkedPreset.id ? syncedLinkedPreset : p)
        }
        setPresets(finalPresets); await savePresetsLocally(finalPresets); await loadPresets()
      } else {
        console.warn('Preset edit saved locally but did not sync to Supabase.')
        await showCloudFailAlert(nextPreset, 'Save')
      }
      Alert.alert('Saved', scopeChanged ? `"${nextPreset.name}" copied to ${newPresetScope}` : `"${nextPreset.name}" updated`)
    } catch (err) {
      console.error('Failed to save preset edit:', err)
      await showCloudFailAlert(nextPreset, 'Save')
    } finally {
      setEditingPreset(null); setShowEditModal(false); setNewPresetName('')
      setNewPresetScope('personal'); setNewPresetPlaylistName(''); setNewPresetIsPublic(false)
    }
  }

  const handleUploadPresetToCloud = async (preset: MetronomePreset) => {
    Alert.alert('Upload to Cloud', `Save "${preset.name}" to cloud so it syncs across devices?`, [
      { text: 'Cancel' },
      {
        text: 'Upload',
        onPress: async () => {
          try {
            setUploadingPresetId(preset.id)
            const user = await getCurrentUser()
            if (!user) { Alert.alert('Error', 'Not logged in'); return }
            const cloudRow = await persistPreset(preset, preset.inCloud && isUuid(preset.id) ? preset.id : undefined)
            if (!cloudRow) {
              Alert.alert('Saved locally', `"${preset.name}" saved locally but cloud sync failed.`)
            } else {
              const updated = presets.map(p => p.id === preset.id ? { ...p, id: cloudRow.id, inCloud: true } : p)
              setPresets(updated); await savePresetsLocally(updated)
              Alert.alert('Success', `"${preset.name}" saved to cloud!`)
            }
          } catch (err) {
            console.error('Upload preset error:', err)
            Alert.alert('Error', 'Failed to upload preset')
          } finally {
            setUploadingPresetId(null)
          }
        }
      }
    ])
  }

  const handleCopyPresetToOwn = async (preset: MetronomePreset) => {
    try {
      setUploadingPresetId(preset.id)
      const user = await getCurrentUser()
      if (!user) { Alert.alert('Error', 'Not logged in'); return }
      const effectiveScope = getEffectivePresetScope(preset)
      const payload: any = {
        user_id: user.id, name: preset.name, bpm: preset.bpm,
        scope: effectiveScope, is_public: effectiveScope === 'overall',
        playlist_name: (preset.playlistNames && preset.playlistNames.length) ? preset.playlistNames[0] : '',
        use_time_signatures: !!preset.useTimeSignatures,
        time_signature_label: preset.useTimeSignatures ? (preset.timeSignatureLabel ?? null) : null,
      }
      const { data, error } = await supabase.from('metronome_presets').insert(payload).select().single()
      if (error) throw error
      const updated = presets.map(p => p.id === preset.id ? { ...p, id: data.id, inCloud: true, isOwnedByOther: false } : p)
      const exists = presets.some(p => p.id === preset.id)
      const final = exists ? updated : [...presets, { ...preset, id: data.id, inCloud: true, isOwnedByOther: false }]
      setPresets(final); await savePresetsLocally(final)
      Alert.alert('Success', `"${preset.name}" copied to your presets and uploaded.`)
    } catch (err) {
      console.error('Copy preset error:', err)
      Alert.alert('Error', 'Failed to copy preset to your account')
    } finally {
      setUploadingPresetId(null)
    }
  }

  const showCloudFailAlert = async (preset: MetronomePreset, actionLabel = 'Save') => {
    try {
      const user = await getCurrentUser()
      Alert.alert(
        'Cloud Sync Failed',
        `${actionLabel} failed to sync to Supabase.\nPreset id: ${preset.id}\nUser id: ${user?.id ?? 'not signed in'}`,
        [
          { text: 'Cancel' },
          { text: 'Retry Upload', onPress: () => handleUploadPresetToCloud(preset) },
          { text: 'Show Debug', onPress: () => {
            Alert.alert('Debug', `Preset id: ${preset.id}\nuser: ${user?.id ?? 'not signed in'}`)
          } }
        ]
      )
    } catch (e) {
      Alert.alert('Cloud Sync Failed', 'Failed to show debug info')
    }
  }

  const handleTogglePublic = async (preset: MetronomePreset) => {
    if (preset.scope === 'overall') return
    const nextIsPublic = !preset.isPublic
    const updated = presets.map(p => p.id === preset.id ? { ...p, isPublic: nextIsPublic } : p)
    setPresets(updated); await savePresetsLocally(updated)
    if (preset.inCloud) {
      try { await supabase.from('metronome_presets').update({ is_public: nextIsPublic }).eq('id', preset.id) }
      catch (err) { console.error('Failed to update visibility in cloud:', err) }
    }
  }

  const handleChangePresetScope = async (preset: MetronomePreset, scope: PresetScope) => {
    if (preset.scope === scope) return
    if (scope === 'overall' && !isManagerOrSuperadmin) {
      Alert.alert('Permission Denied', 'Only manager and superadmin can copy personal presets to overall.')
      return
    }
    if (scope === 'personal') {
      if (preset.scope !== 'overall') return

      const existingCopy = presets.find(existing =>
        existing.scope === 'personal' && getPresetPairKey(existing) === getPresetPairKey(preset)
      )

      if (existingCopy) {
        setActivePreset(existingCopy)
        Alert.alert('Already Copied', `A personal copy of "${preset.name}" already exists.`)
        return
      }

      const nextPreset = makePresetCopy(preset, 'personal')
      const updated = [...presets, nextPreset]
      setPresets(updated)
      await savePresetsLocally(updated)

      try {
        const cloudRow = await persistPreset(nextPreset)
        if (cloudRow) {
          const synced = updated.map(p =>
            p.id === nextPreset.id ? { ...nextPreset, id: cloudRow.id, inCloud: true, ownerUserId: cloudRow.user_id ?? nextPreset.ownerUserId } : p
          )
          setPresets(synced)
          await savePresetsLocally(synced)
          await loadPresets()
          setActivePreset(synced.find(p => p.id === cloudRow.id) ?? nextPreset)
          return
        }
        await showCloudFailAlert(nextPreset, 'Copy')
      } catch (err) {
        console.error('Failed to copy preset scope to personal:', err)
        await showCloudFailAlert(nextPreset, 'Copy')
      }
      return
    }

    const nextPreset = makePresetCopy(preset, scope)
    if (presets.some(existing => getPresetCopyFingerprint(existing) === getPresetCopyFingerprint(nextPreset))) {
      Alert.alert('Already Copied', `A ${scope} copy of "${preset.name}" already exists.`)
      return
    }

    let updated = [...presets, nextPreset]
    setPresets(updated); await savePresetsLocally(updated)
    try {
      const cloudRow = await persistPreset(nextPreset)
      if (cloudRow) {
        updated = updated.map(p =>
          p.id === nextPreset.id ? { ...nextPreset, id: cloudRow.id, inCloud: true, ownerUserId: cloudRow.user_id ?? nextPreset.ownerUserId } : p
        )
        setPresets(updated); await savePresetsLocally(updated); await loadPresets()
        return
      }
      await showCloudFailAlert(nextPreset, 'Copy')
    } catch (err) {
      console.error('Failed to copy preset scope:', err)
      await showCloudFailAlert(nextPreset, 'Copy')
    }
  }

  const handleDeletePreset = (preset: MetronomePreset) => {
    if (!ensureCanModifyPreset(preset, 'Delete')) return
    Alert.alert('Delete Preset', `Delete "${preset.name}"?`, [
      { text: 'Cancel' },
      {
        text: 'Delete', style: 'destructive',
        onPress: async () => {
          try {
            if (preset.inCloud) await supabase.from('metronome_presets').delete().eq('id', preset.id)
            const updated = presets.filter(p => p.id !== preset.id)
            setPresets(updated); await savePresetsLocally(updated)
            if (activePreset?.id === preset.id) setActivePreset(null)
          } catch (err) { Alert.alert('Error', 'Failed to delete preset') }
        }
      }
    ])
  }

  const handleDeletePresetFromMenu = (preset: MetronomePreset) => {
    if (preset.scope === 'overall') { handleDeletePreset(preset); return }
    if (!preset.isOwnedByOther) { handleDeletePreset(preset); return }
    Alert.alert('Remove Preset', `Remove "${preset.name}" from your list?`, [
      { text: 'Cancel' },
      {
        text: 'Remove', style: 'destructive',
        onPress: async () => {
          const updated = presets.filter(p => p.id !== preset.id)
          setPresets(updated); await savePresetsLocally(updated)
          if (activePreset?.id === preset.id) setActivePreset(null)
        }
      }
    ])
  }

  const handleEditPresetPress = (preset: MetronomePreset) => {
    if (!ensureCanModifyPreset(preset, 'Edit')) return
    setEditingPreset(preset); setNewPresetName(preset.name)
    setNewPresetScope(preset.scope); setNewPresetPlaylistName(preset.playlistNames?.[0] ?? '')
    setNewPresetIsPublic(preset.scope === 'overall' ? true : preset.isPublic)
    setUseTimeSignatures(!!preset.useTimeSignatures)
    setSelectedTimeSignature(resolveSelectedTimeSignature(preset.timeSignatureLabel))
    setBpm(preset.bpm); setShowEditModal(true)
  }

  const openPresetMenu  = (preset: MetronomePreset) => { setMenuPreset(preset); setShowPresetMenu(true) }
  const closePresetMenu = () => { setShowPresetMenu(false); setMenuPreset(null) }

  const handleSelectPreset = (preset: MetronomePreset) => {
    setBpm(preset.bpm)
    setActivePreset(preset)
    setUseTimeSignatures(!!preset.useTimeSignatures)
    setSelectedTimeSignature(resolveSelectedTimeSignature(preset.timeSignatureLabel))
    if (isPlayingRef.current) {
      bpmRef.current = preset.bpm
      // The engine is told the new tempo by the effect below and keeps its
      // phase; only the older paths need restarting to pick it up.
      if (!audioCtxRef.current && !engineUsable()) { stopScheduler(); startScheduler(preset.bpm) }
    }
  }

  // ── Click pitch controls ──────────────────────────────────────────────────
  //
  // Dragging updates the ref immediately so the Web Audio path is audible right
  // away; the native pool is only re-rendered once the finger lifts, since each
  // rebuild writes three files and reloads twelve players.
  //
  const handlePitchDrag = (value: number) => {
    const semitones = clampPitch(value)
    clickPitchRef.current = semitones
    setClickPitch(semitones)
  }

  const commitPitch = async (value: number) => {
    const semitones = clampPitch(value)
    clickPitchRef.current = semitones
    setClickPitch(semitones)

    try {
      await AsyncStorage.setItem(CLICK_PITCH_KEY, String(semitones))
    } catch (err) {
      console.error('Error saving click pitch:', err)
    }

    await rebuildClickPool(semitones)
    playPreviewClick()
  }

  const PREVIEW_THROTTLE_MS = 220
  const playPreviewClick = () => {
    const now = Date.now()
    if (now - lastPreviewAtRef.current < PREVIEW_THROTTLE_MS) return
    lastPreviewAtRef.current = now

    if (engineUsable()) {
      postEngine({ type: 'preview', accent: 2, ...currentGrid() })
      return
    }

    const ctx = audioCtxRef.current
    if (ctx) { try { scheduleClickAtTime(ctx.currentTime + 0.02, 2) } catch { playClickFallback(2) } }
    else { playClickFallback(2) }
  }

  /** Preview one particular accent - used after importing a sound for it. */
  const previewAccent = (accent: ClickAccent) => {
    if (engineUsable()) {
      postEngine({ type: 'preview', accent, ...currentGrid() })
      return
    }
    playClickFallback(accent)
  }

  const persistCustomClicks = async (next: CustomClicks) => {
    customClicksRef.current = next
    setCustomClicks(next)
    await AsyncStorage.setItem(CUSTOM_CLICKS_KEY, JSON.stringify(next)).catch(() => {})
  }

  const importClickSound = async (accent: ClickAccent) => {
    setImportingClick(accent)
    try {
      // Not filtered to 'audio/*': a file the system cannot name the type of
      // - somebody's .ss2, say - is not offered under that filter at all, so
      // the import could never begin. Everything is offered instead, and the
      // file is identified from its own header below.
      const result = await DocumentPicker.getDocumentAsync({
        type: AUDIO_PICKER_TYPES,
        copyToCacheDirectory: true,
        multiple: false,
      })
      if (result.canceled) return

      const asset = result.assets[0]
      if (!asset?.uri) throw new Error('The selected audio file has no readable location.')
      if (asset.size && asset.size > MAX_CLICK_BYTES) {
        Alert.alert('Sound is too large', 'Choose a short click sample under 2 MB. A click only needs to last a fraction of a second.')
        return
      }
      if (!FileSystem.documentDirectory) throw new Error('App storage is unavailable on this device.')

      // The header decides the extension, not the file name. The engine
      // decodes from the bytes and would not care either way, but the
      // fallback pool hands the file to the platform player, which infers the
      // format from the name - so a click saved as .ss2 would be silent there.
      const extension = await resolveAudioExtension(asset.uri, asset.name)
      if (!extension) {
        Alert.alert(
          'Not a sound file',
          'That file could not be read as audio. Choose a short click sample - a WAV or MP3 works well.',
        )
        return
      }

      await FileSystem.makeDirectoryAsync(CUSTOM_CLICK_DIR, { intermediates: true })
      const destination = `${CUSTOM_CLICK_DIR}click-${accent}-${Date.now()}${extension}`
      await FileSystem.copyAsync({ from: asset.uri, to: destination })

      const previous = customClicksRef.current[accent]
      const entry: CustomClick = { uri: destination, name: asset.name || 'Custom click' }
      const next: CustomClicks = { ...customClicksRef.current, [accent]: entry }
      await persistCustomClicks(next)

      await sendSampleToEngine(accent, destination)
      if (!engineUsable()) await rebuildClickPool(clickPitchRef.current)

      // The replaced file is only deleted once nothing points at it - the
      // same sample can sit in more than one slot.
      const stillUsed = Object.values(next).some(v => v?.uri === previous?.uri)
      if (previous?.uri && !stillUsed && previous.uri.startsWith(CUSTOM_CLICK_DIR)) {
        await FileSystem.deleteAsync(previous.uri, { idempotent: true }).catch(() => {})
      }
      previewAccent(accent)
    } catch (err) {
      console.error('Error importing metronome sound:', err)
      Alert.alert('Could not import sound', err instanceof Error ? err.message : 'Choose a valid audio file and try again.')
    } finally {
      setImportingClick(null)
    }
  }

  const resetClickSound = async (accent: ClickAccent) => {
    const previous = customClicksRef.current[accent]
    const next: CustomClicks = { ...customClicksRef.current }
    delete next[accent]
    await persistCustomClicks(next)

    postEngine({ type: 'clear-samples', accent })
    if (!engineUsable()) await rebuildClickPool(clickPitchRef.current)

    const stillUsed = Object.values(next).some(v => v?.uri === previous?.uri)
    if (previous?.uri && !stillUsed && previous.uri.startsWith(CUSTOM_CLICK_DIR)) {
      await FileSystem.deleteAsync(previous.uri, { idempotent: true }).catch(() => {})
    }
    previewAccent(accent)
  }

  const handleModalSliderChange = (value: number) => {
    setBpm(Math.round(value))
    playPreviewClick()
  }

  const adjustBpm = (delta: number) => {
    setBpm(prev => Math.max(40, Math.min(300, prev + delta)))
    setActivePreset(null)
  }

  useEffect(() => {
    if (!activePreset) { setShowSaveBar(false); return }
    setShowSaveBar(bpm !== activePreset.bpm)
  }, [bpm, activePreset])

  const handleSaveBpmChangeForActivePreset = async () => {
    if (!activePreset) return
    if (!ensureCanModifyPreset(activePreset, 'Update BPM')) return
    const updatedPreset: MetronomePreset = {
      ...activePreset,
      bpm,
      ...getCurrentTimeSignatureState(),
    }
    const updated = presets.map(p => p.id === activePreset.id ? updatedPreset : p)
    setPresets(updated); await savePresetsLocally(updated)
    try {
      const shouldSync = activePreset.inCloud || updatedPreset.scope === 'overall'
      if (shouldSync) {
        const cloudRow = await persistPreset(updatedPreset, activePreset.inCloud && isUuid(activePreset.id) ? activePreset.id : undefined)
        if (cloudRow) {
          const synced = updated.map(p => p.id === activePreset.id ? { ...updatedPreset, id: cloudRow.id, inCloud: true } : p)
          setPresets(synced); await savePresetsLocally(synced)
          setActivePreset(synced.find(p => p.id === cloudRow.id) ?? updatedPreset)
        } else { setActivePreset(updatedPreset); await showCloudFailAlert(updatedPreset, 'Save BPM') }
      } else { setActivePreset(updatedPreset) }
      Alert.alert('Saved', `"${updatedPreset.name}" updated to ${updatedPreset.bpm} BPM`)
    } catch (err) {
      console.error('Failed to persist BPM change:', err)
      await showCloudFailAlert(updatedPreset, 'Save BPM'); setActivePreset(updatedPreset)
    } finally { setShowSaveBar(false) }
  }

  const handleRevertBpmChange = () => {
    if (!activePreset) return
    setBpm(activePreset.bpm); setShowSaveBar(false)
  }

  // ─── Derived lists ─────────────────────────────────────────────────────────
  const personalPresets   = presets.filter(p => !p.scope || p.scope === 'personal')
  const ownOverallPresets = presets.filter(p => p.scope === 'overall')
  const overallPresets    = [...ownOverallPresets, ...publicPresets]
  const playlistSource    = [...presets, ...publicPresets]
    .filter(preset => preset.scope === 'overall' || isPresetOwner(preset))
    .reduce<MetronomePreset[]>((items, preset) => {
    if (!items.some(existing => existing.id === preset.id)) items.push(preset)
    return items
  }, [])
  const playlistGroups = playlistSource.reduce<Record<string, MetronomePreset[]>>((groups, preset) => {
    const names = (preset.playlistNames && preset.playlistNames.length) ? preset.playlistNames : ['Unassigned']
    names.forEach(name => {
      const key = (name || 'Unassigned').trim() || 'Unassigned'
      if (!groups[key]) groups[key] = []
      groups[key].push(preset)
    })
    return groups
  }, {})
  const playlistNames         = Object.keys(playlistGroups).sort((a, b) => a.localeCompare(b))
  const visiblePlaylistNames  = playlistNames.filter(name => name !== 'Unassigned')
  const combinedPlaylistNames = Array.from(new Set([...visiblePlaylistNames, ...chordlistPlaylists])).sort((a, b) => a.localeCompare(b))
  const personalPlaylistNames = combinedPlaylistNames.filter(name => getPlaylistScope(name) === 'personal')
  const overallPlaylistNames  = combinedPlaylistNames.filter(name => getPlaylistScope(name) === 'overall')
  const playlistPickerExistingNames = canUseOverallPlaylists ? combinedPlaylistNames : personalPlaylistNames
  const scopedPlaylistNames   = playlistScopeTab === 'personal' ? personalPlaylistNames : overallPlaylistNames
  const tabPresets            = activeTab === 'personal' ? personalPresets
    : activeTab === 'overall' ? overallPresets : []
  const normalizedSearch = searchText.trim().toLowerCase()

  const presetMatchesSearch = useCallback((preset: MetronomePreset) => {
    if (!normalizedSearch) return true
    const playlistNameText = (preset.playlistNames || []).join(' ').toLowerCase()
    return [preset.name, `${preset.bpm}`, playlistNameText]
      .some(value => value.toLowerCase().includes(normalizedSearch))
  }, [normalizedSearch])

  const filteredTabPresets = useMemo(() => tabPresets.filter(presetMatchesSearch), [presetMatchesSearch, tabPresets])
  const filteredScopedPlaylistNames = useMemo(() => {
    if (!normalizedSearch) return scopedPlaylistNames

    return scopedPlaylistNames.filter(name => {
      if (name.toLowerCase().includes(normalizedSearch)) return true
      return (playlistGroups[name] || []).some(presetMatchesSearch)
    })
  }, [normalizedSearch, playlistGroups, presetMatchesSearch, scopedPlaylistNames])

  // ─── Render ────────────────────────────────────────────────────────────────

  const anyCustomClick = CLICK_SLOTS.some(slot => !!customClicks[slot.accent])

  return (
    <View style={{ flex: 1 }}>
      {/*
        The clock. Laid out but invisible rather than removed - a WebView that
        is not laid out is free to have its audio stopped by the system, and
        this one is the only thing keeping time.
      */}
      <View style={styles.engineHost} pointerEvents="none">
        <WebView
          ref={engineRef}
          source={{ html: METRONOME_ENGINE_HTML }}
          originWhitelist={['*']}
          onMessage={handleEngineMessage}
          javaScriptEnabled
          domStorageEnabled
          // Web Audio has to be allowed to sound without a tap inside the page
          mediaPlaybackRequiresUserAction={false}
          allowsInlineMediaPlayback
          androidLayerType="software"
          onError={() => {
            engineFailedRef.current = true
            void rebuildClickPool(clickPitchRef.current)
          }}
          style={styles.engineWeb}
        />
      </View>
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        {/* BPM Display */}
        <View style={styles.bpmDisplayContainer}>
          {activePreset && <Text style={styles.activePresetName}>{activePreset.name}</Text>}
          <Text style={styles.bpmLabel}>BPM</Text>
          <Text style={styles.bpmValue}>{bpm}</Text>
        </View>

        {/* BPM Slider */}
        <View style={styles.sliderContainer}>
          <TouchableOpacity style={styles.bpmStepButton} onPress={() => adjustBpm(-1)}>
            <Ionicons name="remove" size={18} color={c.text} />
          </TouchableOpacity>
          <Text style={styles.sliderLabel}>40</Text>
          <Slider
            style={styles.slider}
            minimumValue={40} maximumValue={300} value={bpm}
            onValueChange={(value) => { setBpm(Math.round(value)); setActivePreset(null) }}
            step={1}
            minimumTrackTintColor={c.accent}
            maximumTrackTintColor={c.border}
          />
          <Text style={styles.sliderLabel}>300</Text>
          <TouchableOpacity style={styles.bpmStepButton} onPress={() => adjustBpm(1)}>
            <Ionicons name="add" size={18} color={c.text} />
          </TouchableOpacity>
        </View>

        {/* Time Signature Card */}
        <View style={styles.timeSignatureCard}>
          <View style={styles.timeSignatureCardLeft}>
            <Text style={styles.timeSignatureCardTitle}>Time Signatures</Text>
            <Text style={styles.timeSignatureCardSubtitle}>
              {useTimeSignatures
                ? `On · ${selectedTimeSignature.label} · ${selectedTimeSignature.description} · BPM = ${selectedTimeSignature.pulseName}`
                : 'Off · steady quarter-note clicks'}
            </Text>
          </View>
          <TouchableOpacity style={styles.timeSignatureCardButton} onPress={() => setShowTimeSignatureModal(true)}>
            <Ionicons name="musical-notes-outline" size={16} color={c.text} />
            <Text style={styles.timeSignatureCardButtonText}>Choose</Text>
          </TouchableOpacity>
        </View>

        {/* Click Pitch Card */}
        <View style={styles.pitchCard}>
          <View style={styles.pitchCardHeader}>
            <View style={styles.timeSignatureCardLeft}>
              <Text style={styles.timeSignatureCardTitle}>Click Pitch</Text>
              <Text style={styles.timeSignatureCardSubtitle}>
                {anyCustomClick
                  ? 'Speeds an imported sound up or down'
                  : clickPitch === 0
                  ? 'Default tone'
                  : `${clickPitch > 0 ? '+' : ''}${clickPitch} semitone${Math.abs(clickPitch) === 1 ? '' : 's'} · pitch only, tempo never changes`}
              </Text>
            </View>
            {clickPitch !== 0 && (
              <TouchableOpacity style={styles.timeSignatureCardButton} onPress={() => commitPitch(0)}>
                <Ionicons name="refresh-outline" size={16} color={c.text} />
                <Text style={styles.timeSignatureCardButtonText}>Reset</Text>
              </TouchableOpacity>
            )}
          </View>

          <View style={styles.pitchSliderRow}>
            <Ionicons name="arrow-down" size={14} color={c.textSub} />
            <Slider
              style={styles.slider}
              minimumValue={-PITCH_RANGE_SEMITONES}
              maximumValue={PITCH_RANGE_SEMITONES}
              value={clickPitch}
              step={1}
              onValueChange={handlePitchDrag}
              onSlidingComplete={commitPitch}
              minimumTrackTintColor={c.accent}
              maximumTrackTintColor={c.border}
            />
            <Ionicons name="arrow-up" size={14} color={c.textSub} />
          </View>
        </View>

        {/* Custom Click Sounds - one per accent */}
        <View style={styles.clickSoundCard}>
          <Text style={styles.timeSignatureCardTitle}>Click Sounds</Text>

          {CLICK_SLOTS.map(slot => {
            const entry = customClicks[slot.accent]
            const busy = importingClick === slot.accent

            return (
              <View key={slot.accent} style={styles.clickSoundRow}>
                <View style={styles.timeSignatureCardLeft}>
                  <Text style={styles.clickSoundRowTitle}>{slot.title}</Text>
                  <Text style={styles.timeSignatureCardSubtitle} numberOfLines={1}>
                    {entry ? entry.name : slot.hint}
                  </Text>
                </View>

                <View style={styles.clickSoundActions}>
                  {/* Hearing it is the only way to tell whether a sample is
                      trimmed tightly enough to land on the beat. */}
                  <TouchableOpacity
                    style={styles.iconButton}
                    onPress={() => previewAccent(slot.accent)}
                    accessibilityLabel={`Hear the ${slot.title.toLowerCase()} click`}
                  >
                    <Ionicons name="volume-medium-outline" size={17} color={c.text} />
                  </TouchableOpacity>

                  {entry && (
                    <TouchableOpacity
                      style={styles.iconButton}
                      onPress={() => resetClickSound(slot.accent)}
                      accessibilityLabel={`Use the built-in ${slot.title.toLowerCase()} click`}
                    >
                      <Ionicons name="refresh-outline" size={17} color={c.text} />
                    </TouchableOpacity>
                  )}

                  <TouchableOpacity
                    style={styles.timeSignatureCardButton}
                    onPress={() => importClickSound(slot.accent)}
                    disabled={importingClick !== null}
                  >
                    {busy
                      ? <ActivityIndicator size="small" color={c.text} />
                      : <Ionicons name="folder-open-outline" size={16} color={c.text} />}
                    <Text style={styles.timeSignatureCardButtonText}>
                      {entry ? 'Change' : 'Import'}
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>
            )
          })}
        </View>

        {/* Play/Stop Button */}
        <TouchableOpacity
          style={[styles.playButton, isPlaying && styles.playButtonActive]}
          onPress={toggleMetronome}
        >
          <Text style={styles.playButtonText}>{isPlaying ? 'Stop' : 'Start'}</Text>
        </TouchableOpacity>

        {/* Beat Indicator */}
        {isPlaying && (
          <View style={styles.beatIndicator}>
            <View style={[styles.beatDot, beatFlash && styles.beatDotFlash]} />
            <Text style={styles.beatText}>
              {useTimeSignatures ? `${selectedTimeSignature.label} · ${selectedTimeSignature.beatsPerMeasure} beats/measure` : 'Playing'}
            </Text>
          </View>
        )}

        {/* Quick BPM Presets */}
        <View style={styles.presetsContainer}>
          <Text style={styles.presetsLabel}>Quick BPM</Text>
          <View style={styles.presets}>
            {DEFAULT_PRESETS.map((preset) => (
              <TouchableOpacity
                key={preset.id}
                style={[styles.presetButton, bpm === preset.bpm && !activePreset && styles.presetButtonActive]}
                onPress={() => handleSelectPreset({ ...preset, scope: 'personal', isPublic: false })}
              >
                <Text style={[styles.presetButtonText, bpm === preset.bpm && !activePreset && styles.presetButtonTextActive]}>
                  {preset.bpm}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* ── My Presets ───────────────────────────────────────────────── */}
        <View style={styles.customPresetsContainer}>
          <View style={styles.customPresetsHeader}>
            <Text style={styles.presetsLabel}>My Presets</Text>
            <View style={styles.headerActions}>
              {(activeTab !== 'overall' || canCreateOverallPreset) && (
                <TouchableOpacity
                  style={styles.addPresetButton}
                  onPress={() => {
                    setEditingPreset(null); setNewPresetName('')
                    setNewPresetScope(activeTab === 'overall' ? 'overall' : 'personal')
                    setNewPresetPlaylistName(''); setNewPresetIsPublic(false)
                    setShowAddModal(true)
                  }}
                >
                  <Ionicons name="add-circle" size={28} color={c.text} />
                </TouchableOpacity>
              )}
            </View>
          </View>

          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10, backgroundColor: c.surface, borderWidth: 1.5, borderColor: c.hairline }}>
            <Ionicons name="search-outline" size={16} color={c.textSub} />
            <TextInput
              style={{ flex: 1, fontSize: 14, color: c.text, fontWeight: '600', padding: 0 }}
              placeholder={activeTab === 'playlist' ? 'Search playlist names or presets…' : 'Search presets…'}
              placeholderTextColor={c.textMuted}
              value={searchText}
              onChangeText={setSearchText}
              returnKeyType="search"
            />
            {searchText.length > 0 && (
              <TouchableOpacity
                onPress={() => setSearchText('')}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Ionicons name="close-circle" size={18} color={c.textSub} />
              </TouchableOpacity>
            )}
          </View>

          {/* Tab bar */}
          <View style={styles.tabBar}>
            <TouchableOpacity style={[styles.tab, activeTab === 'personal' && styles.tabActive]} onPress={() => setActiveTab('personal')}>
              <Ionicons name="person-outline" size={14} color={activeTab === 'personal' ? c.accentText : c.textSub} />
              <Text style={[styles.tabText, activeTab === 'personal' && styles.tabTextActive]}>Personal</Text>
              {personalPresets.length > 0 && (
                <View style={[styles.tabBadge, activeTab === 'personal' && styles.tabBadgeActive]}>
                  <Text style={[styles.tabBadgeText, activeTab === 'personal' && styles.tabBadgeTextActive]}>{personalPresets.length}</Text>
                </View>
              )}
            </TouchableOpacity>
            <TouchableOpacity style={[styles.tab, activeTab === 'overall' && styles.tabActive]} onPress={() => setActiveTab('overall')}>
              <Ionicons name="globe-outline" size={14} color={activeTab === 'overall' ? c.accentText : c.textSub} />
              <Text style={[styles.tabText, activeTab === 'overall' && styles.tabTextActive]}>Overall</Text>
              {overallPresets.length > 0 && (
                <View style={[styles.tabBadge, activeTab === 'overall' && styles.tabBadgeActive]}>
                  <Text style={[styles.tabBadgeText, activeTab === 'overall' && styles.tabBadgeTextActive]}>{overallPresets.length}</Text>
                </View>
              )}
            </TouchableOpacity>
            <TouchableOpacity style={[styles.tab, activeTab === 'playlist' && styles.tabActive]} onPress={() => setActiveTab('playlist')}>
              <Ionicons name="albums-outline" size={14} color={activeTab === 'playlist' ? c.accentText : c.textSub} />
              <Text style={[styles.tabText, activeTab === 'playlist' && styles.tabTextActive]}>Playlist</Text>
              {combinedPlaylistNames.length > 0 && (
                <View style={[styles.tabBadge, activeTab === 'playlist' && styles.tabBadgeActive]}>
                  <Text style={[styles.tabBadgeText, activeTab === 'playlist' && styles.tabBadgeTextActive]}>{combinedPlaylistNames.length}</Text>
                </View>
              )}
            </TouchableOpacity>
          </View>

          <Text style={styles.tabDescription}>
            {activeTab === 'personal' ? 'Private presets only visible to you.'
              : activeTab === 'overall' ? 'Your presets + public presets from other users. Overall presets are always public.'
              : 'Named playlist groups for your metronome presets.'}
          </Text>

          {/* Playlist tab content */}
          {activeTab === 'playlist' ? (
            <>
              <View style={styles.playlistScopeTabBar}>
                <TouchableOpacity
                  style={[styles.playlistScopeTabButton, playlistScopeTab === 'personal' && styles.playlistScopeTabButtonActive]}
                  onPress={() => setPlaylistScopeTab('personal')}
                >
                  <Ionicons name="person-outline" size={14} color={playlistScopeTab === 'personal' ? c.accentText : c.textSub} />
                  <Text style={[styles.playlistScopeTabButtonText, playlistScopeTab === 'personal' && styles.playlistScopeTabButtonTextActive]}>
                    Personal ({personalPlaylistNames.length})
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.playlistScopeTabButton, playlistScopeTab === 'overall' && styles.playlistScopeTabButtonActive]}
                  onPress={() => setPlaylistScopeTab('overall')}
                >
                  <Ionicons name="globe-outline" size={14} color={playlistScopeTab === 'overall' ? c.accentText : c.textSub} />
                  <Text style={[styles.playlistScopeTabButtonText, playlistScopeTab === 'overall' && styles.playlistScopeTabButtonTextActive]}>
                    Overall ({overallPlaylistNames.length})
                  </Text>
                </TouchableOpacity>
              </View>

{scopedPlaylistNames.length === 0 ? (
  <View style={styles.emptyPlaylistState}>
    <Ionicons name="albums-outline" size={28} color={c.textSub} />
    <Text style={styles.emptyPlaylistTitle}>
      {normalizedSearch ? 'No matches found' : `No ${playlistScopeTab} playlists yet`}
    </Text>
    <Text style={styles.emptyPlaylistText}>
      {normalizedSearch
        ? 'Try a different search term.'
        : 'Add a playlist from the button above, or assign a preset to a playlist from its menu.'}
    </Text>
  </View>
) : (
  filteredScopedPlaylistNames.map(name => (
    <View key={name} style={styles.playlistSection}>
      {(() => {
        const nameScope = getPlaylistScope(name)
        return (
          <TouchableOpacity style={styles.playlistAccordionHeader} onPress={() => togglePlaylistAccordion(name)}>
            <View style={styles.playlistAccordionHeaderLeft}>
              <Ionicons name={openPlaylistNames[name] ? 'chevron-down' : 'chevron-forward'} size={16} color={c.textSub} />
              <Text style={styles.playlistSectionTitle}>{getPlaylistDisplayName(name)}</Text>
              <View style={[styles.playlistScopeBadge, getPlaylistScope(name) === 'overall' ? styles.playlistScopeBadgeOverall : styles.playlistScopeBadgePersonal]}>
                <Text style={styles.playlistScopeBadgeText}>{getPlaylistScope(name) === 'overall' ? 'Overall' : 'Personal'}</Text>
              </View>
            </View>
            <View style={styles.playlistAccordionHeaderRight}>
              {nameScope === 'overall' && isManagerOrSuperadmin && (
                <View style={styles.playlistHeaderScopeActions}>
                  <TouchableOpacity style={styles.playlistHeaderScopeButton} onPress={(e) => { e.stopPropagation(); handleChangePlaylistScope(name, 'personal') }}>
                    <Ionicons name="person-outline" size={12} color={c.text} />
                  </TouchableOpacity>
                </View>
              )}
              {nameScope === 'personal' && isManagerOrSuperadmin && (
                <View style={styles.playlistHeaderScopeActions}>
                  <TouchableOpacity style={styles.playlistHeaderScopeButton} onPress={(e) => { e.stopPropagation(); handleChangePlaylistScope(name, 'overall') }}>
                    <Ionicons name="globe-outline" size={12} color={c.text} />
                  </TouchableOpacity>
                </View>
              )}
              <View style={styles.playlistAccordionCount}>
                <Text style={styles.playlistAccordionCountText}>{(playlistGroups[name] || []).length}</Text>
              </View>
            </View>
          </TouchableOpacity>
        )
      })()}

      {openPlaylistNames[name] && (
        <View style={styles.playlistAccordionBody}>
          {getOrderedPlaylistGroup(name).map((preset, presetIdx) => {
            const orderedGroup = getOrderedPlaylistGroup(name)
            const isFirst = presetIdx === 0
            const isLast = presetIdx === orderedGroup.length - 1
            return (
              <TouchableOpacity
                key={preset.id}
                style={[styles.playlistPresetCard, activePreset?.id === preset.id && styles.customPresetCardActive]}
                onPress={() => handleSelectPreset(preset)}
              >
                <View style={styles.playlistPresetBody}>
                  <View style={styles.playlistPresetTopRow}>
                    <Text style={[styles.playlistPresetName, activePreset?.id === preset.id && styles.playlistPresetNameActive]} numberOfLines={2}>
                      {preset.name}
                    </Text>
                    <View style={[styles.playlistPresetScopePill, preset.scope === 'overall' ? styles.playlistPresetScopeOverall : styles.playlistPresetScopePersonal]}>
                      <Ionicons name={preset.scope === 'overall' ? 'globe-outline' : 'person-outline'} size={11} color={preset.scope === 'overall' ? c.text : c.textSub} />
                      <Text style={styles.playlistPresetScopeText}>{preset.scope === 'overall' ? 'Overall' : 'Personal'}</Text>
                    </View>
                  </View>
                  <View style={styles.playlistPresetMetaRow}>
                    <Text style={[styles.playlistPresetBpm, activePreset?.id === preset.id && styles.playlistPresetBpmActive]}>{preset.bpm} BPM</Text>
                    <View style={[styles.syncBadge, preset.inCloud ? styles.syncBadgeCloud : styles.syncBadgeLocal]}>
                      <Ionicons name={preset.inCloud ? 'cloud-done-outline' : 'phone-portrait-outline'} size={10} color={c.textSub} />
                      <Text style={styles.syncBadgeText}>{preset.inCloud ? 'Cloud' : 'Local'}</Text>
                    </View>
                  </View>
                  <View style={styles.playlistPresetFooterRow}>
                    <View style={styles.playlistPresetActionsLeft}>
                      {preset.scope === 'overall' && isManagerOrSuperadmin && (
                        <TouchableOpacity style={styles.scopeInlineButton} onPress={() => handleChangePresetScope(preset, 'personal')}>
                          <Ionicons name="person-outline" size={14} color={c.text} />
                          <Text style={styles.scopeInlineButtonText}>Personal</Text>
                        </TouchableOpacity>
                      )}
                      {preset.scope === 'personal' && isManagerOrSuperadmin && (
                        <TouchableOpacity style={styles.scopeInlineButton} onPress={() => handleChangePresetScope(preset, 'overall')}>
                          <Ionicons name="globe-outline" size={14} color={c.text} />
                          <Text style={styles.scopeInlineButtonText}>Overall</Text>
                        </TouchableOpacity>
                      )}
                    </View>
                    <View style={styles.customPresetActions}>
                      <View style={styles.reorderBtns}>
                        <TouchableOpacity
                          style={[styles.reorderBtn, isFirst && styles.reorderBtnDisabled]}
                          onPress={() => handleReorderPlaylistPreset(name, presetIdx, 'up')}
                          disabled={isFirst}
                          hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                        >
                          <Ionicons name="chevron-up" size={13} color={isFirst ? c.iconInactive : c.text} />
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={[styles.reorderBtn, isLast && styles.reorderBtnDisabled]}
                          onPress={() => handleReorderPlaylistPreset(name, presetIdx, 'down')}
                          disabled={isLast}
                          hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                        >
                          <Ionicons name="chevron-down" size={13} color={isLast ? c.iconInactive : c.text} />
                        </TouchableOpacity>
                      </View>
                      {/* <TouchableOpacity style={styles.inlineActionButton} onPress={() => openPlaylistPicker(preset, 'assign')}>
                        <Ionicons name="add" size={16} color={c.text} />
                      </TouchableOpacity> */}
                      {/* {canModifyPreset(preset) && (
                        <TouchableOpacity style={styles.inlineActionButton} onPress={() => handleRemovePresetFromPlaylist(preset, name)}>
                          <Ionicons name="remove" size={16} color={c.text} />
                        </TouchableOpacity>
                      )} */}
                      <TouchableOpacity style={styles.menuButton} onPress={() => openPresetMenu(preset)}>
                        <Ionicons name="ellipsis-vertical" size={18} color={c.text} />
                      </TouchableOpacity>
                    </View>
                  </View>
                </View>
              </TouchableOpacity>
            )
          })}
        </View>
      )}
    </View>
  ))
)}
            </>
          ) : filteredTabPresets.length === 0 ? (
            <Text style={styles.emptyPresetsText}>
              {normalizedSearch
                ? 'No matches found. Try a different search term.'
                : activeTab === 'personal'
                  ? 'No personal presets yet. Tap + to add one.'
                  : 'No overall presets yet. Tap + to add one.'}
            </Text>
          ) : (
            filteredTabPresets.map((preset) => (
              <TouchableOpacity
                key={preset.id}
                style={[styles.customPresetCard, activePreset?.id === preset.id && styles.customPresetCardActive]}
                onPress={() => handleSelectPreset(preset)}
              >
                <View style={styles.customPresetLeft}>
                  <Text style={[styles.customPresetName, activePreset?.id === preset.id && styles.customPresetNameActive]}>
                    {preset.name}
                  </Text>
                  <View style={styles.customPresetMeta}>
                    <Text style={[styles.customPresetBpm, activePreset?.id === preset.id && styles.customPresetBpmActive]}>
                      {preset.bpm} BPM
                    </Text>
                    <View style={[styles.syncBadge, preset.inCloud ? styles.syncBadgeCloud : styles.syncBadgeLocal]}>
                      <Ionicons name={preset.inCloud ? 'cloud-done-outline' : 'phone-portrait-outline'} size={10} color={c.textSub} />
                      <Text style={styles.syncBadgeText}>{preset.inCloud ? 'Cloud' : 'Local'}</Text>
                    </View>
                    {preset.scope === 'overall' && (
                      <View style={[styles.syncBadge, styles.publicBadge]}>
                        <Ionicons name="eye-outline" size={10} color={c.textSub} />
                        <Text style={[styles.syncBadgeText, styles.syncBadgeTextPublic]}>Public</Text>
                      </View>
                    )}
                  </View>
                </View>
                <View style={styles.customPresetActions}>
                  {activeTab === 'personal' && preset.scope === 'personal' && isManagerOrSuperadmin && (
                    <TouchableOpacity style={styles.scopeInlineButton} onPress={() => handleChangePresetScope(preset, 'overall')}>
                      <Ionicons name="globe-outline" size={14} color={c.text} />
                      <Text style={styles.scopeInlineButtonText}>Overall</Text>
                    </TouchableOpacity>
                  )}
                  {activeTab === 'overall' && preset.scope === 'overall' && (
                    <TouchableOpacity style={styles.scopeInlineButton} onPress={() => handleChangePresetScope(preset, 'personal')}>
                      <Ionicons name="person-outline" size={14} color={c.text} />
                      <Text style={styles.scopeInlineButtonText}>Personal</Text>
                    </TouchableOpacity>
                  )}
                  <TouchableOpacity style={styles.menuButton} onPress={() => openPresetMenu(preset)}>
                    <Ionicons name="ellipsis-vertical" size={18} color={c.text} />
                  </TouchableOpacity>
                </View>
              </TouchableOpacity>
            ))
          )}
        </View>

        {/* ── Modals ─────────────────────────────────────────────────────────── */}

        {/* Preset Menu */}
        <Modal visible={showPresetMenu} transparent animationType="fade" onRequestClose={closePresetMenu}>
          <TouchableOpacity style={styles.menuOverlay} activeOpacity={1} onPress={closePresetMenu}>
            <View style={styles.menuSheet}>
              <Text style={styles.menuTitle}>{menuPreset?.name}</Text>
              {menuPreset && canModifyPreset(menuPreset) && (
                <TouchableOpacity style={styles.menuItem} onPress={() => { if (menuPreset) handleEditPresetPress(menuPreset); closePresetMenu() }}>
                  <Ionicons name="pencil-outline" size={18} color={c.text} />
                  <Text style={styles.menuItemText}>Edit</Text>
                </TouchableOpacity>
              )}
              {menuPreset && (
                <TouchableOpacity style={styles.menuItem} onPress={() => { const p = menuPreset; closePresetMenu(); openPlaylistPicker(p, 'assign') }}>
                  <Ionicons name="albums-outline" size={18} color={c.text} />
                  <Text style={styles.menuItemText}>Add to Playlist</Text>
                </TouchableOpacity>
              )}
              {menuPreset && !menuPreset.inCloud && !menuPreset.isOwnedByOther && canModifyPreset(menuPreset) && (
                <TouchableOpacity style={styles.menuItem} onPress={async () => { const p = menuPreset; closePresetMenu(); await handleUploadPresetToCloud(p) }}>
                  <Ionicons name="cloud-upload-outline" size={18} color={c.text} />
                  <Text style={styles.menuItemText}>Upload to Cloud</Text>
                </TouchableOpacity>
              )}
              {menuPreset && canModifyPreset(menuPreset) && (
                <TouchableOpacity style={styles.menuItemDestructive} onPress={() => { const p = menuPreset; closePresetMenu(); handleDeletePresetFromMenu(p) }}>
                  <Ionicons name="trash-outline" size={18} color={c.textSub} />
                  <Text style={styles.menuItemTextDestructive}>Delete</Text>
                </TouchableOpacity>
              )}
            </View>
          </TouchableOpacity>
        </Modal>

        {/* Playlist Picker */}
        <Modal visible={showPlaylistPicker} transparent animationType="slide" onRequestClose={closePlaylistPicker}>
          <View style={styles.modalOverlay}>
            <View style={styles.modal}>
              <Text style={styles.modalTitle}>Add to Playlist</Text>
              <Text style={styles.modalSubtitle}>
                {playlistPickerMode === 'field' ? 'Pick a playlist name for this preset.' : 'Choose a playlist to assign this preset to.'}
              </Text>
              {combinedPlaylistNames.length > 0 && (
                <View style={styles.playlistChoiceList}>
                  <Text style={styles.modalFieldLabel}>{canUseOverallPlaylists ? 'Existing playlists' : 'Existing personal playlists'}</Text>
                  <ScrollView style={styles.playlistChoiceScroll}>
                    {playlistPickerExistingNames.map(name => {
                      const selected = playlistPickerNames.includes(name)
                      return (
                        <TouchableOpacity
                          key={name}
                          style={[styles.playlistChoiceItem, selected && { backgroundColor: c.surfaceAlt }]}
                          onPress={() => setPlaylistPickerNames(prev => {
                            const next = new Set(prev); next.has(name) ? next.delete(name) : next.add(name)
                            return Array.from(next)
                          })}
                        >
                          <Ionicons name={selected ? 'checkmark-circle' : 'bookmark-outline'} size={16} color={c.text} />
                          <View style={{ flex: 1 }}>
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                              <Text style={styles.playlistChoiceText}>{getPlaylistDisplayName(name)}</Text>
                              <View style={[styles.playlistScopeBadge, getPlaylistScope(name) === 'overall' ? styles.playlistScopeBadgeOverall : styles.playlistScopeBadgePersonal]}>
                                <Text style={styles.playlistScopeBadgeText}>{getPlaylistScope(name) === 'overall' ? 'Overall' : 'Personal'}</Text>
                              </View>
                            </View>
                          </View>
                        </TouchableOpacity>
                      )
                    })}
                  </ScrollView>
                </View>
              )}
              <Text style={styles.modalFieldLabel}>Or create a new playlist</Text>
              <Text style={styles.modalFieldLabel}>Playlist type</Text>
              <View style={styles.scopePicker}>
                <TouchableOpacity style={[styles.scopeOption, playlistPickerScope === 'personal' && styles.scopeOptionActive]} onPress={() => setPlaylistPickerScope('personal')}>
                  <Ionicons name="person-outline" size={16} color={playlistPickerScope === 'personal' ? c.accentText : c.textSub} />
                  <Text style={[styles.scopeOptionText, playlistPickerScope === 'personal' && styles.scopeOptionTextActive]}>Personal</Text>
                </TouchableOpacity>
                {canUseOverallPlaylists && (
                  <TouchableOpacity style={[styles.scopeOption, playlistPickerScope === 'overall' && styles.scopeOptionActive]} onPress={() => setPlaylistPickerScope('overall')}>
                    <Ionicons name="globe-outline" size={16} color={playlistPickerScope === 'overall' ? c.accentText : c.textSub} />
                    <Text style={[styles.scopeOptionText, playlistPickerScope === 'overall' && styles.scopeOptionTextActive]}>Overall</Text>
                  </TouchableOpacity>
                )}
              </View>
              <TextInput
                style={styles.modalInput}
                placeholder={playlistPickerScope === 'overall' ? 'New overall playlist name' : 'New personal playlist name'}
                placeholderTextColor={c.textMuted}
                value={playlistPickerName} onChangeText={setPlaylistPickerName}
              />
              <View style={styles.modalButtons}>
                <TouchableOpacity style={[styles.modalButton, styles.cancelButton]} onPress={closePlaylistPicker}>
                  <Text style={styles.cancelButtonText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.modalButton, styles.saveButton]} onPress={handleSavePlaylistFromPicker}>
                  <Text style={styles.saveButtonText}>{playlistPickerMode === 'field' ? 'Use Playlist' : 'Save Playlist'}</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>

        {/* Time Signature Modal */}
        <Modal visible={showTimeSignatureModal} transparent animationType="slide" onRequestClose={() => setShowTimeSignatureModal(false)}>
          <View style={styles.modalOverlay}>
            <View style={styles.modal}>
              <Text style={styles.modalTitle}>Time Signatures</Text>
              <Text style={styles.modalSubtitle}>
                Accent the downbeat and sub-group beats. Changes take effect immediately.
              </Text>

              <View style={styles.timeSignatureSwitchRow}>
                <View style={styles.timeSignatureSwitchLeft}>
                  <Text style={styles.modalFieldLabel}>Use time signatures</Text>
                </View>
                <Switch
                  value={useTimeSignatures}
                  onValueChange={setUseTimeSignatures}
                  trackColor={{ false: c.border, true: c.accent }}
                  thumbColor={c.surface}
                />
              </View>

              <View style={styles.timeSignatureSwitchRow}>
                <View style={styles.timeSignatureSwitchLeft}>
                  <Text style={styles.modalFieldLabel}>Compound subdivisions</Text>
                </View>
                <Switch
                  value={subdivideCompound}
                  onValueChange={setSubdivideCompound}
                  trackColor={{ false: c.border, true: c.accent }}
                  thumbColor={c.surface}
                />
              </View>

              {/* Legend */}
              <View style={styles.timeSignatureLegend}>
                <View style={styles.legendItem}>
                  <View style={[styles.legendDot, { backgroundColor: c.accent }]} />
                  <Text style={styles.legendText}>Strong (beat 1)</Text>
                </View>
                <View style={styles.legendItem}>
                  <View style={[styles.legendDot, { backgroundColor: c.textSub }]} />
                  <Text style={styles.legendText}>Medium (sub-group)</Text>
                </View>
                <View style={styles.legendItem}>
                  <View style={[styles.legendDot, { backgroundColor: c.border }]} />
                  <Text style={styles.legendText}>Weak</Text>
                </View>
              </View>

              <Text style={styles.modalFieldLabel}>Choose a signature</Text>
              <ScrollView style={styles.timeSignatureScroll} contentContainerStyle={styles.timeSignatureGrid}>
                {TIME_SIGNATURE_OPTIONS.map(option => {
                  const selected = selectedTimeSignature.label === option.label
                  // Build a mini accent-dot display
                  const accentPat = buildClickPattern(option, subdivideCompound).map(step => step.accent)
                  return (
                    <TouchableOpacity
                      key={option.label}
                      style={[styles.timeSignatureChoice, selected && styles.timeSignatureChoiceActive]}
                      onPress={() => { setSelectedTimeSignature(option); setUseTimeSignatures(true) }}
                    >
                      <View style={styles.timeSignatureChoiceHeader}>
                        <Text style={[styles.timeSignatureChoiceText, selected && styles.timeSignatureChoiceTextActive]}>
                          {option.label}
                        </Text>
                        <View style={[styles.meterTypeBadge,
                          option.meterType === 'compound' ? styles.meterTypeBadgeCompound
                          : option.meterType === 'asymmetric' ? styles.meterTypeBadgeAsymmetric
                          : styles.meterTypeBadgeSimple
                        ]}>
                          <Text style={styles.meterTypeBadgeText}>
                            {option.meterType === 'compound' ? 'Compound'
                              : option.meterType === 'asymmetric' ? 'Asymmetric'
                              : 'Simple'}
                          </Text>
                        </View>
                      </View>
                      {/* Accent pattern dots */}
                      <View style={styles.accentDots}>
                        {accentPat.map((level, i) => (
                          <View key={i} style={[
                            styles.accentDot,
                            level === 2 ? styles.accentDotStrong
                            : level === 1 ? styles.accentDotMedium
                            : styles.accentDotWeak,
                            selected && level === 2 && styles.accentDotStrongActive,
                            selected && level === 1 && styles.accentDotMediumActive,
                            selected && level === 0 && styles.accentDotWeakActive,
                          ]} />
                        ))}
                      </View>
                      <Text style={[styles.timeSignatureChoiceBeats, selected && styles.timeSignatureChoiceBeatsActive]}>
                        {option.description}
                      </Text>
                    </TouchableOpacity>
                  )
                })}
              </ScrollView>

              <View style={styles.modalButtons}>
                <TouchableOpacity style={[styles.modalButton, styles.cancelButton]} onPress={() => setShowTimeSignatureModal(false)}>
                  <Text style={styles.cancelButtonText}>Close</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>

        {/* Add/Edit Preset Modal */}
        <Modal visible={showAddModal || showEditModal} transparent animationType="slide">
          <View style={styles.modalOverlay}>
            <View style={styles.modal}>
              <Text style={styles.modalTitle}>{editingPreset ? 'Edit Preset' : 'Save Preset'}</Text>
              <Text style={styles.modalSubtitle}>Current BPM: {bpm}</Text>
              <View style={styles.modalBpmRow}>
                <Text style={styles.modalBpmLabel}>Edit BPM: <Text style={styles.modalBpmValue}>{bpm}</Text></Text>
                <Slider
                  style={styles.modalSlider}
                  minimumValue={40} maximumValue={300} step={1} value={bpm}
                  onValueChange={(value) => setBpm(Math.round(value))}
                  minimumTrackTintColor={c.accent} maximumTrackTintColor={c.border}
                />
              </View>
              <TextInput
                style={styles.modalInput}
                placeholder="Preset name (e.g. How Great Is Our God)"
                placeholderTextColor={c.textMuted}
                value={newPresetName} onChangeText={setNewPresetName} autoFocus
              />
              <View style={styles.timeSignatureCard}>
                <View style={styles.timeSignatureCardLeft}>
                  <Text style={styles.timeSignatureCardTitle}>Time Signatures</Text>
                  <Text style={styles.timeSignatureCardSubtitle}>
                    {useTimeSignatures
                      ? `On · ${selectedTimeSignature.label} · ${selectedTimeSignature.description}`
                      : 'Off · steady quarter-note clicks'}
                  </Text>
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Switch
                    value={useTimeSignatures}
                    onValueChange={setUseTimeSignatures}
                    trackColor={{ false: c.border, true: c.accent }}
                    thumbColor={c.surface}
                  />
                  <TouchableOpacity style={styles.timeSignatureCardButton} onPress={() => setShowTimeSignatureModal(true)}>
                    <Ionicons name="musical-notes-outline" size={16} color={c.text} />
                    <Text style={styles.timeSignatureCardButtonText}>Choose</Text>
                  </TouchableOpacity>
                </View>
              </View>
              <Text style={styles.modalFieldLabel}>Playlist</Text>
              <TouchableOpacity style={styles.playlistPickerButton} onPress={() => openPlaylistPicker(editingPreset ?? null, 'field')}>
                <Ionicons name="albums-outline" size={18} color={c.text} />
                <Text style={styles.playlistPickerButtonText}>
                  {newPresetPlaylistName.trim() ? newPresetPlaylistName.trim() : 'Add to Playlist'}
                </Text>
              </TouchableOpacity>
              {!!newPresetPlaylistName.trim() && (
                <TouchableOpacity onPress={() => setNewPresetPlaylistName('')} style={styles.clearPlaylistButton}>
                  <Text style={styles.clearPlaylistButtonText}>Clear playlist</Text>
                </TouchableOpacity>
              )}
              <Text style={styles.modalHint}>Presets are saved locally first. You can upload to cloud after saving.</Text>
              <View style={styles.modalButtons}>
                {editingPreset && (
                  <TouchableOpacity
                    style={[styles.modalButton, styles.deleteButton]}
                    onPress={() => { const p = editingPreset; setShowEditModal(false); setEditingPreset(null); handleDeletePreset(p) }}
                  >
                    <Text style={styles.deleteButtonText}>Delete</Text>
                  </TouchableOpacity>
                )}
                <TouchableOpacity
                  style={[styles.modalButton, styles.cancelButton]}
                  onPress={() => { setShowAddModal(false); setShowEditModal(false); setEditingPreset(null) }}
                >
                  <Text style={styles.cancelButtonText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.modalButton, styles.saveButton]}
                  onPress={editingPreset ? handleSavePresetEdit : handleAddPreset}
                >
                  <Text style={styles.saveButtonText}>{editingPreset ? 'Save Changes' : 'Save Locally'}</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>
      </ScrollView>
    </View>
  )
}

const makeStyles = (c: AppColors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.surfaceAlt },
  content: { padding: 20, paddingBottom: 40 },

  bpmDisplayContainer: { alignItems: 'center', marginBottom: 24, paddingVertical: 16 },
  activePresetName: { fontSize: 14, color: c.textSub, fontWeight: '700', marginBottom: 6, letterSpacing: 0.3 },
  bpmLabel: { fontSize: 16, color: c.textSub, marginBottom: 8, fontWeight: '600', letterSpacing: 0.4 },
  bpmValue: { fontSize: 76, fontWeight: '800', color: c.text },

  sliderContainer: { flexDirection: 'row', alignItems: 'center', marginBottom: 32 },
  slider: { flex: 1, marginHorizontal: 15, height: 40 },
  sliderLabel: { fontSize: 12, color: c.textSub, width: 30, textAlign: 'center', fontWeight: '600' },
  bpmStepButton: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: c.surface, borderWidth: 1.5, borderColor: c.border },

  timeSignatureCard: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: 14, borderRadius: 10, backgroundColor: c.surface, borderWidth: 1.5, borderColor: c.hairline, marginBottom: 22 },
  timeSignatureCardLeft: { flex: 1 },
  timeSignatureCardTitle: { fontSize: 15, fontWeight: '800', color: c.text, marginBottom: 4 },
  timeSignatureCardSubtitle: { fontSize: 12, color: c.textSub, fontWeight: '500' },
  timeSignatureCardButton: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 9, paddingHorizontal: 12, borderRadius: 8, backgroundColor: c.surfaceAlt, borderWidth: 1, borderColor: c.border },
  timeSignatureCardButtonText: { fontSize: 13, fontWeight: '800', color: c.text },
  clickSoundActions: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  clickSoundCard: {
    backgroundColor: c.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: c.border,
    padding: 14,
    gap: 6,
    marginBottom: 12,
  },
  clickSoundRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: c.hairline,
  },
  clickSoundRowTitle: { fontSize: 13, fontWeight: '700', color: c.text },
  // Laid out but invisible - see the note where it is rendered.
  engineHost: { position: 'absolute', width: 1, height: 1, opacity: 0, top: 0, left: 0 },
  engineWeb: { width: 1, height: 1, backgroundColor: 'transparent' },
  iconButton: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center', borderRadius: 8, backgroundColor: c.surfaceAlt, borderWidth: 1, borderColor: c.border },

  pitchCard: { padding: 14, borderRadius: 10, backgroundColor: c.surface, borderWidth: 1.5, borderColor: c.hairline, marginBottom: 22 },
  pitchCardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  pitchSliderRow: { flexDirection: 'row', alignItems: 'center', marginTop: 4 },

  playButton: { backgroundColor: c.accent, paddingVertical: 22, borderRadius: 8, alignItems: 'center', marginBottom: 24, elevation: 3, shadowColor: c.shadow, shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.2, shadowRadius: 4 },
  playButtonActive: { backgroundColor: c.textSub },
  playButtonText: { fontSize: 26, fontWeight: '800', color: c.accentText, letterSpacing: 0.5 },

  beatIndicator: { alignItems: 'center', marginBottom: 24 },
  beatDot: { width: 32, height: 32, borderRadius: 16, backgroundColor: c.accent, marginBottom: 12, elevation: 2, shadowColor: c.shadow, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.15, shadowRadius: 2 },
  beatDotFlash: { backgroundColor: c.textSub },
  beatText: { fontSize: 15, color: c.textSub, fontWeight: '700', letterSpacing: 0.3 },

  presetsContainer: { alignItems: 'center', marginBottom: 32 },
  presetsLabel: { fontSize: 16, fontWeight: '800', color: c.text, marginBottom: 14, letterSpacing: 0.3 },
  presets: { flexDirection: 'row', justifyContent: 'space-around', width: '100%', gap: 8 },
  presetButton: { paddingVertical: 11, paddingHorizontal: 16, borderRadius: 6, borderWidth: 1.5, borderColor: c.accent, backgroundColor: c.surface, elevation: 1, shadowColor: c.shadow, shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.08, shadowRadius: 2 },
  presetButtonActive: { backgroundColor: c.accent, borderColor: c.accent },
  presetButtonText: { fontSize: 14, fontWeight: '700', color: c.text },
  presetButtonTextActive: { color: c.accentText },

  customPresetsContainer: { marginBottom: 20 },
  customPresetsHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  addPresetButton: { padding: 6 },
  addPlaylistButton: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 8, paddingHorizontal: 10, borderRadius: 8, backgroundColor: c.surfaceAlt, borderWidth: 1, borderColor: c.border },
  addPlaylistButtonText: { fontSize: 12, fontWeight: '800', color: c.text },
  searchBar: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10, backgroundColor: c.surface, borderWidth: 1.5, borderColor: c.hairline },
  searchInput: { flex: 1, fontSize: 14, color: c.text, fontWeight: '600', padding: 0 },

  tabBar: { flexDirection: 'row', backgroundColor: c.surfaceAlt, borderRadius: 8, padding: 3, marginBottom: 8, gap: 3, flexWrap: 'wrap' },
  tab: { flexGrow: 1, flexBasis: '30%', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 9, borderRadius: 6, gap: 5 },
  tabActive: { backgroundColor: c.accent, elevation: 2, shadowColor: c.shadow, shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.15, shadowRadius: 2 },
  tabText: { fontSize: 13, fontWeight: '700', color: c.textSub, letterSpacing: 0.2 },
  tabTextActive: { color: c.accentText },
  tabBadge: { minWidth: 18, height: 18, borderRadius: 9, backgroundColor: c.border, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 },
  tabBadgeActive: { backgroundColor: c.textSub },
  tabBadgeText: { fontSize: 10, fontWeight: '800', color: c.textSub },
  tabBadgeTextActive: { color: c.accentText },
  tabDescription: { fontSize: 12, color: c.textSub, fontWeight: '500', marginBottom: 14, fontStyle: 'italic' },

  playlistScopeTabBar: { flexDirection: 'row', backgroundColor: c.surfaceAlt, borderRadius: 8, padding: 3, marginBottom: 12, gap: 3 },
  playlistScopeTabButton: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, paddingVertical: 8, borderRadius: 6 },
  playlistScopeTabButtonActive: { backgroundColor: c.accent },
  playlistScopeTabButtonText: { fontSize: 12, fontWeight: '700', color: c.textSub },
  playlistScopeTabButtonTextActive: { color: c.accentText },

  emptyPresetsText: { color: c.textSub, fontSize: 14, textAlign: 'center', paddingVertical: 22, fontWeight: '500' },
  emptyPlaylistState: { alignItems: 'center', justifyContent: 'center', paddingVertical: 28, paddingHorizontal: 18, borderRadius: 12, borderWidth: 1, borderColor: c.hairline, backgroundColor: c.surface, gap: 10 },
  emptyPlaylistTitle: { fontSize: 16, fontWeight: '800', color: c.text },
  emptyPlaylistText: { fontSize: 13, lineHeight: 19, color: c.textSub, textAlign: 'center', fontWeight: '500' },
  emptyPlaylistButton: { marginTop: 6, backgroundColor: c.accent, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 8 },
  emptyPlaylistButtonText: { color: c.accentText, fontSize: 13, fontWeight: '800' },

  playlistSection: { marginBottom: 14 },
  playlistAccordionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 10, paddingHorizontal: 4 },
  playlistAccordionHeaderLeft: { flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1 },
  playlistAccordionHeaderRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  playlistHeaderScopeActions: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  playlistHeaderScopeButton: { width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: c.border, backgroundColor: c.surfaceAlt },
  playlistAccordionCount: { minWidth: 24, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 12, backgroundColor: c.surfaceAlt, alignItems: 'center', justifyContent: 'center' },
  playlistAccordionCountText: { fontSize: 11, fontWeight: '800', color: c.textSub },
  playlistAccordionBody: { paddingLeft: 10 },
  playlistSectionTitle: { fontSize: 12, fontWeight: '800', letterSpacing: 0.8, color: c.textSub, textTransform: 'uppercase', marginBottom: 8 },
  playlistScopeBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, borderWidth: 1 },
  playlistScopeBadgePersonal: { backgroundColor: c.surfaceAlt, borderColor: c.border },
  playlistScopeBadgeOverall: { backgroundColor: c.infoBg, borderColor: c.info },
  playlistScopeBadgeText: { fontSize: 10, fontWeight: '800', color: c.textSub, letterSpacing: 0.2 },

  customPresetCard: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: c.surface, borderRadius: 8, padding: 16, marginBottom: 11, borderWidth: 1.5, borderColor: c.hairline, elevation: 1, shadowColor: c.shadow, shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.08, shadowRadius: 2 },
  customPresetCardActive: { backgroundColor: c.surfaceAlt, borderColor: c.accent, borderWidth: 2 },
  customPresetLeft: { flex: 1 },
  customPresetName: { fontSize: 15, fontWeight: '700', color: c.text, marginBottom: 5 },
  customPresetNameActive: { color: c.text, fontWeight: '800' },
  customPresetMeta: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 },
  customPresetBpm: { fontSize: 13, color: c.textSub, fontWeight: '600' },
  customPresetBpmActive: { color: c.textSub },

  reorderBtns: { flexDirection: 'column', gap: 2 },
reorderBtn: {
  width: 24, height: 24, borderRadius: 6,
  backgroundColor: c.surfaceAlt,
  borderWidth: 1, borderColor: c.border,
  justifyContent: 'center', alignItems: 'center',
},
reorderBtnDisabled: { opacity: 0.35 },

  playlistPresetCard: { backgroundColor: c.surface, borderRadius: 10, padding: 14, marginBottom: 10, borderWidth: 1.5, borderColor: c.hairline, elevation: 1, shadowColor: c.shadow, shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 2 },
  playlistPresetBody: { gap: 10 },
  playlistPresetTopRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 },
  playlistPresetName: { flex: 1, fontSize: 16, lineHeight: 21, fontWeight: '800', color: c.text },
  playlistPresetNameActive: { color: c.text },
  playlistPresetScopePill: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 999, borderWidth: 1 },
  playlistPresetScopePersonal: { backgroundColor: c.surfaceAlt, borderColor: c.border },
  playlistPresetScopeOverall: { backgroundColor: c.infoBg, borderColor: c.info },
  playlistPresetScopeText: { fontSize: 10, fontWeight: '800', color: c.textSub },
  playlistPresetMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  playlistPresetBpm: { fontSize: 13, fontWeight: '700', color: c.textSub },
  playlistPresetBpmActive: { color: c.text },
  playlistPresetFooterRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' },
  playlistPresetActionsLeft: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap', flexShrink: 1 },

  syncBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 7, paddingVertical: 3, borderRadius: 6, borderWidth: 1 },
  syncBadgeCloud: { backgroundColor: c.surfaceAlt, borderColor: c.border },
  syncBadgeLocal: { backgroundColor: c.surfaceAlt, borderColor: c.border },
  publicBadge: { backgroundColor: c.successBg, borderColor: c.success },
  syncBadgeText: { fontSize: 10, fontWeight: '700', color: c.textSub },
  syncBadgeTextPublic: { color: c.success },

  customPresetActions: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  scopeInlineButton: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 8, paddingHorizontal: 10, borderRadius: 6, backgroundColor: c.surfaceAlt, borderWidth: 1, borderColor: c.border },
  scopeInlineButtonText: { fontSize: 11, fontWeight: '800', color: c.text },
  inlineActionButton: { padding: 9, borderRadius: 6, backgroundColor: c.surfaceAlt, borderWidth: 1, borderColor: c.border },
  menuButton: { padding: 9, borderRadius: 6, backgroundColor: c.surfaceAlt, borderWidth: 1, borderColor: c.hairline },

  menuOverlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: c.accent },
  menuSheet: { backgroundColor: c.surface, padding: 20, borderTopLeftRadius: 16, borderTopRightRadius: 16 },
  menuTitle: { fontSize: 16, fontWeight: '800', color: c.text, marginBottom: 14 },
  menuItem: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14 },
  menuItemDestructive: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14, marginTop: 4 },
  menuItemText: { fontSize: 15, fontWeight: '700', color: c.text },
  menuItemTextDestructive: { fontSize: 15, fontWeight: '700', color: c.textSub },

  playlistPickerButton: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1.5, borderColor: c.border, borderRadius: 8, paddingVertical: 12, paddingHorizontal: 13, backgroundColor: c.surfaceAlt, marginBottom: 8 },
  playlistPickerButtonText: { fontSize: 14, fontWeight: '700', color: c.text },
  clearPlaylistButton: { alignSelf: 'flex-start', marginBottom: 14 },
  clearPlaylistButtonText: { fontSize: 12, color: c.textSub, fontWeight: '700' },
  playlistChoiceList: { marginBottom: 12 },
  playlistChoiceScroll: { maxHeight: 160, borderWidth: 1, borderColor: c.hairline, borderRadius: 8, backgroundColor: c.surfaceAlt },
  playlistChoiceItem: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 11, paddingHorizontal: 12, borderBottomWidth: 1, borderBottomColor: c.hairline },
  playlistChoiceText: { fontSize: 14, fontWeight: '700', color: c.text },

  modalOverlay: { flex: 1, backgroundColor: c.accent, justifyContent: 'flex-end' },
  modal: { backgroundColor: c.surface, borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 26 },
  modalTitle: { fontSize: 21, fontWeight: '800', color: c.text, marginBottom: 6, letterSpacing: 0.3 },
  modalSubtitle: { fontSize: 14, color: c.textSub, fontWeight: '700', marginBottom: 22 },
  modalInput: { borderWidth: 1.5, borderColor: c.border, borderRadius: 8, padding: 13, fontSize: 15, color: c.text, marginBottom: 18, backgroundColor: c.surfaceAlt, fontWeight: '500' },
  modalFieldLabel: { fontSize: 13, fontWeight: '700', color: c.textSub, marginBottom: 8, letterSpacing: 0.2 },
  modalHint: { fontSize: 12, color: c.textSub, marginBottom: 22, fontStyle: 'italic', fontWeight: '500' },
  modalButtons: { flexDirection: 'row', gap: 12 },
  modalButton: { flex: 1, paddingVertical: 15, borderRadius: 8, alignItems: 'center', elevation: 2, shadowColor: c.shadow, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.1, shadowRadius: 3 },
  cancelButton: { backgroundColor: c.surfaceAlt },
  cancelButtonText: { color: c.text, fontWeight: '700', fontSize: 15, letterSpacing: 0.3 },
  saveButton: { backgroundColor: c.accent },
  saveButtonText: { color: c.accentText, fontWeight: '700', fontSize: 15, letterSpacing: 0.3 },
  deleteButton: { backgroundColor: c.surfaceAlt, borderColor: c.border },
  deleteButtonText: { color: c.textSub, fontWeight: '800' },

  modalBpmRow: { marginBottom: 14 },
  modalBpmLabel: { fontSize: 13, color: c.textSub, fontWeight: '700', marginBottom: 8 },
  modalBpmValue: { fontSize: 13, color: c.text, fontWeight: '900' },
  modalSlider: { width: '100%', height: 40 },

  timeSignatureSwitchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 16, paddingVertical: 10 },
  timeSignatureSwitchLeft: { flex: 1 },
  timeSignatureHint: { fontSize: 12, color: c.textSub, fontWeight: '500' },

  // Legend
  timeSignatureLegend: { flexDirection: 'row', gap: 16, marginBottom: 14, flexWrap: 'wrap' },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  legendDot: { width: 10, height: 10, borderRadius: 5 },
  legendText: { fontSize: 11, color: c.textSub, fontWeight: '600' },

  timeSignatureScroll: { maxHeight: 320 },
  timeSignatureGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, paddingBottom: 10 },

  timeSignatureChoice: { width: '48%', paddingVertical: 12, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1.5, borderColor: c.border, backgroundColor: c.surfaceAlt },
  timeSignatureChoiceActive: { backgroundColor: c.accent, borderColor: c.accent },
  timeSignatureChoiceHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  timeSignatureChoiceText: { fontSize: 18, fontWeight: '800', color: c.text },
  timeSignatureChoiceTextActive: { color: c.accentText },
  timeSignatureChoiceBeats: { fontSize: 10, fontWeight: '600', color: c.textSub, marginTop: 6 },
  timeSignatureChoiceBeatsActive: { color: c.iconInactive },

  // Meter type badge inside time sig card
  meterTypeBadge: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
  meterTypeBadgeSimple: { backgroundColor: c.successBg },
  meterTypeBadgeCompound: { backgroundColor: c.infoBg },
  meterTypeBadgeAsymmetric: { backgroundColor: c.warningBg },
  meterTypeBadgeText: { fontSize: 9, fontWeight: '800', color: c.textSub },

  // Accent dot row in time sig choice
  accentDots: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 2 },
  accentDot: { width: 8, height: 8, borderRadius: 4 },
  accentDotStrong: { backgroundColor: c.accent },
  accentDotMedium: { backgroundColor: c.textSub },
  accentDotWeak: { backgroundColor: c.border },
  accentDotStrongActive: { backgroundColor: c.surface },
  accentDotMediumActive: { backgroundColor: c.border },
  accentDotWeakActive: { backgroundColor: c.textSub },

  scopePicker: { flexDirection: 'row', gap: 10, marginBottom: 18 },
  scopeOption: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 12, borderRadius: 8, borderWidth: 1.5, borderColor: c.border, backgroundColor: c.surfaceAlt },
  scopeOptionActive: { backgroundColor: c.accent, borderColor: c.accent },
  scopeOptionText: { fontSize: 14, fontWeight: '700', color: c.textSub },
  scopeOptionTextActive: { color: c.accentText },
})
