// screens/PadScreen.tsx
//
// The controls for the pad: which key it holds, how loud, and whether it is
// sounding at all.
//
// The sound itself is made by components/PadEngine, which is mounted at the
// root of the app and keeps going when this screen is closed. So this screen
// owns nothing - it reads the pad's state and asks it to change. Leave with
// the pad running and it carries on underneath whatever you open next, which
// is the entire point of having one.

import React, { useEffect, useState , useMemo} from 'react'
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native'
import { useAppTheme, type AppColors } from '../lib/theme'
import Ionicons from '@expo/vector-icons/Ionicons'
import Slider from '@react-native-community/slider'
import { padController, usePadState } from '../components/PadEngine'
import { assignPad, importPads, removePad } from '../lib/padLibrary'
import { PAD_PRESETS, getPadPreset } from '../lib/padPresets'

/** The twelve roots, written the way most worship charts write them. */
const ROOTS = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']

export default function PadScreen() {
  const { colors: c } = useAppTheme()
  const styles = useMemo(() => makeStyles(c), [c])

  const pad = usePadState()
  const [importing, setImporting] = useState(false)
  const [assigning, setAssigning] = useState<string | null>(null)

  useEffect(() => {
    void padController.refreshLibrary()
  }, [])

  const keyName = ROOTS[pad.root] + (pad.minor ? 'm' : '')
  const usingOwnFile = !!padController.fileFor(pad.root)
  const preset = getPadPreset(pad.preset)

  const handleImport = async () => {
    setImporting(true)
    try {
      const { added, skipped } = await importPads()
      padController.refreshLibrary()

      // Anything the picker offered but we cannot play has to be named. The
      // picker now shows every file, so that unusually named audio is
      // reachable at all - which means a wrong pick is a thing that can
      // happen, and saying nothing would leave it looking as though the
      // import had simply hung.
      const missing = skipped.length
        ? (skipped.length === 1 ? skipped[0] : skipped.length + ' files') + ' could not be read as audio.'
        : ''

      if (added > 0) {
        Alert.alert(
          added === 1 ? 'Pad added' : added + ' pads added',
          'Check the key against each one below - the key was guessed from the file name.'
            + (missing ? '\n\n' + missing : ''),
        )
      } else if (missing) {
        Alert.alert('Nothing imported', missing)
      }
    } catch (err) {
      console.log('[PadScreen] import failed', err)
      Alert.alert('Could not import', 'Those files could not be read. Try a different format.')
    } finally {
      setImporting(false)
    }
  }

  const cycleAssignment = async (id: string, currentRoot: number | null) => {
    // Step through the keys and then back to unassigned, so a whole set can
    // be corrected by tapping rather than opening a picker twelve times.
    const next = currentRoot === null ? 0 : currentRoot >= 11 ? null : currentRoot + 1
    setAssigning(id)
    try {
      await assignPad(id, next)
      await padController.refreshLibrary()
    } finally {
      setAssigning(null)
    }
  }

  const confirmRemove = (id: string, name: string) => {
    Alert.alert('Remove this pad?', name + ' will be deleted from the app.', [
      { text: 'Keep', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          await removePad(id)
          await padController.refreshLibrary()
        },
      },
    ])
  }

  const chooseRoot = (root: number) => {
    // Choosing a key while it is playing crossfades to it; while it is
    // stopped, choosing one starts it there.
    if (pad.playing) padController.setKey(root, pad.minor)
    else padController.play(root, pad.minor)
  }

  const chooseMode = (minor: boolean) => {
    if (minor === pad.minor) return
    padController.setKey(pad.root, minor)
  }

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>

        {/* What it is doing right now */}
        <View style={styles.statusCard}>
          <View style={{ flex: 1 }}>
            <Text style={styles.statusLabel}>{pad.playing ? 'SOUNDING IN' : 'READY IN'}</Text>
            <Text style={styles.statusKey}>{keyName}</Text>
            <Text style={styles.statusSource}>
              {usingOwnFile
                ? 'your own pad'
                : preset.name + (pad.source === 'imported' ? ' · built-in' : '')}
            </Text>
          </View>
          <TouchableOpacity
            style={[styles.playBtn, pad.playing && styles.playBtnOn]}
            onPress={() => padController.toggle(pad.root, pad.minor)}
            activeOpacity={0.85}
            accessibilityRole="button"
            accessibilityLabel={pad.playing ? 'Stop the pad' : 'Start the pad'}
          >
            <Ionicons name={pad.playing ? 'stop' : 'play'} size={22} color={c.accentText} />
          </TouchableOpacity>
        </View>

        <Text style={styles.sectionLabel}>KEY</Text>
        <View style={styles.keyGrid}>
          {ROOTS.map((name, index) => {
            const on = pad.root === index
            return (
              <TouchableOpacity
                key={name}
                style={[styles.keyCell, on && styles.keyCellOn]}
                onPress={() => chooseRoot(index)}
                activeOpacity={0.75}
              >
                <Text style={[styles.keyCellText, on && styles.keyCellTextOn]}>{name}</Text>
              </TouchableOpacity>
            )
          })}
        </View>

        <Text style={styles.sectionLabel}>MAJOR OR MINOR</Text>
        <View style={styles.modeRow}>
          {[false, true].map(minor => {
            const on = pad.minor === minor
            return (
              <TouchableOpacity
                key={String(minor)}
                style={[styles.modeBtn, on && styles.modeBtnOn]}
                onPress={() => chooseMode(minor)}
                activeOpacity={0.75}
              >
                <Text style={[styles.modeText, on && styles.modeTextOn]}>
                  {minor ? 'Minor' : 'Major'}
                </Text>
              </TouchableOpacity>
            )
          })}
        </View>

        <Text style={styles.sectionLabel}>VOLUME</Text>
        <View style={styles.volumeRow}>
          <Ionicons name="volume-low-outline" size={16} color={c.textMuted} />
          <Slider
            style={styles.slider}
            minimumValue={0}
            maximumValue={1}
            value={pad.volume}
            onValueChange={v => padController.setVolume(v)}
            minimumTrackTintColor={c.accent}
            maximumTrackTintColor={c.border}
            thumbTintColor={c.accent}
          />
          <Ionicons name="volume-high-outline" size={16} color={c.textMuted} />
        </View>

        {/* ── The user's own pads ── */}
        <Text style={styles.sectionLabel}>SOUND</Text>
        <View style={styles.modeRow}>
          {(['synth', 'imported'] as const).map(source => {
            const on = pad.source === source
            return (
              <TouchableOpacity
                key={source}
                style={[styles.modeBtn, on && styles.modeBtnOn]}
                onPress={() => padController.setSource(source)}
                activeOpacity={0.75}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
              >
                <Text style={[styles.modeText, on && styles.modeTextOn]}>
                  {source === 'synth' ? 'Built-in' : 'My pads'}
                </Text>
              </TouchableOpacity>
            )
          })}
        </View>

        {pad.source === 'synth' && (
          <View style={styles.presetSection}>
            <View style={styles.presetGrid} accessibilityRole="radiogroup" accessibilityLabel="Built-in sounds">
              {PAD_PRESETS.map(sound => {
                const on = sound.id === pad.preset
                return (
                  <TouchableOpacity
                    key={sound.id}
                    style={[styles.presetCard, on && styles.presetCardOn]}
                    onPress={() => padController.setPreset(sound.id)}
                    activeOpacity={0.8}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: on }}
                    accessibilityLabel={sound.name + '. ' + sound.description}
                    accessibilityHint={pad.playing ? 'Crossfades to this sound' : 'Selects the sound to play'}
                  >
                    <View style={styles.presetHeading}>
                      <Text style={[styles.presetName, on && styles.presetNameOn]}>{sound.name}</Text>
                      <Ionicons
                        name={on ? 'checkmark-circle' : 'ellipse-outline'}
                        size={17}
                        color={on ? c.accentText : c.iconInactive}
                        accessible={false}
                      />
                    </View>
                    <Text style={[styles.presetDescription, on && styles.presetDescriptionOn]}>
                      {sound.description}
                    </Text>
                  </TouchableOpacity>
                )
              })}
            </View>
          </View>
        )}

        {pad.source === 'imported' && (
          <View style={styles.library}>
            {pad.library.map(sample => (
              <View key={sample.id} style={styles.sampleRow}>
                <TouchableOpacity
                  style={[styles.sampleKey, sample.root === null && styles.sampleKeyEmpty]}
                  onPress={() => cycleAssignment(sample.id, sample.root)}
                  disabled={assigning === sample.id}
                  activeOpacity={0.75}
                >
                  {assigning === sample.id ? (
                    <ActivityIndicator size="small" color={c.text} />
                  ) : (
                    <Text
                      style={[
                        styles.sampleKeyText,
                        sample.root === null && styles.sampleKeyTextEmpty,
                      ]}
                    >
                      {sample.root === null ? '—' : ROOTS[sample.root]}
                    </Text>
                  )}
                </TouchableOpacity>

                <Text style={styles.sampleName} numberOfLines={1}>
                  {sample.name}
                </Text>

                <TouchableOpacity
                  onPress={() => confirmRemove(sample.id, sample.name)}
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                >
                  <Ionicons name="trash-outline" size={16} color={c.iconInactive} />
                </TouchableOpacity>
              </View>
            ))}

            <TouchableOpacity
              style={styles.importBtn}
              onPress={handleImport}
              disabled={importing}
              activeOpacity={0.85}
            >
              {importing ? (
                <ActivityIndicator size="small" color={c.accentText} />
              ) : (
                <>
                  <Ionicons name="download-outline" size={15} color={c.accentText} />
                  <Text style={styles.importBtnText}>Import pad files</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>
    </View>
  )
}

const makeStyles = (c: AppColors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.surfaceAlt },
  content: { paddingHorizontal: 16, paddingTop: 20, paddingBottom: 40 },

  hint: { fontSize: 12, color: c.textMuted, fontWeight: '500', lineHeight: 18, marginBottom: 16 },

  statusCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    backgroundColor: c.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: c.hairline,
    paddingHorizontal: 18,
    paddingVertical: 18,
  },
  statusLabel: { fontSize: 9, fontWeight: '700', color: c.iconInactive, letterSpacing: 1.8 },
  statusKey: { fontSize: 34, fontWeight: '300', color: c.text, letterSpacing: -1, marginTop: 4 },
  playBtn: {
    width: 58,
    height: 58,
    borderRadius: 29,
    backgroundColor: c.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playBtnOn: { backgroundColor: c.danger },

  sectionLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: c.iconInactive,
    letterSpacing: 1.8,
    marginTop: 24,
    marginBottom: 10,
  },

  keyGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  keyCell: {
    width: '22.4%',
    paddingVertical: 14,
    borderRadius: 12,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.hairline,
    alignItems: 'center',
  },
  keyCellOn: { backgroundColor: c.accent, borderColor: c.accent },
  keyCellText: { fontSize: 15, fontWeight: '700', color: c.text },
  keyCellTextOn: { color: c.accentText },

  modeRow: { flexDirection: 'row', gap: 8 },
  modeBtn: {
    flex: 1,
    paddingVertical: 13,
    borderRadius: 12,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.hairline,
    alignItems: 'center',
  },
  modeBtnOn: { backgroundColor: c.accent, borderColor: c.accent },
  modeText: { fontSize: 14, fontWeight: '700', color: c.text },
  modeTextOn: { color: c.accentText },

  statusSource: { fontSize: 11, fontWeight: '600', color: c.textMuted, marginTop: 2 },

  presetSection: { marginTop: 14 },
  presetHint: { fontSize: 12, color: c.textMuted, fontWeight: '500', lineHeight: 18, marginBottom: 12 },
  presetGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  presetCard: {
    flexBasis: '47%',
    flexGrow: 1,
    padding: 13,
    borderRadius: 12,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.hairline,
  },
  presetCardOn: { backgroundColor: c.accent, borderColor: c.accent },
  presetHeading: { flexDirection: 'row', alignItems: 'flex-start', gap: 6 },
  presetName: { flex: 1, fontSize: 13, lineHeight: 18, fontWeight: '700', color: c.text },
  presetNameOn: { color: c.accentText },
  presetDescription: { fontSize: 11, lineHeight: 16, fontWeight: '500', color: c.textMuted, marginTop: 6 },
  presetDescriptionOn: { color: c.iconInactive },

  library: { marginTop: 12 },
  sampleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: c.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: c.hairline,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 8,
  },
  sampleKey: {
    width: 44,
    height: 36,
    borderRadius: 9,
    backgroundColor: c.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sampleKeyEmpty: { backgroundColor: c.surfaceAlt, borderWidth: 1, borderColor: c.border },
  sampleKeyText: { fontSize: 13.5, fontWeight: '800', color: c.accentText },
  sampleKeyTextEmpty: { color: c.textMuted },
  sampleName: { flex: 1, fontSize: 13, fontWeight: '600', color: c.text },
  libraryEmpty: {
    fontSize: 12.5,
    fontWeight: '500',
    color: c.textMuted,
    lineHeight: 18,
    paddingVertical: 10,
  },
  importBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: 4,
    paddingVertical: 13,
    borderRadius: 11,
    backgroundColor: c.accent,
  },
  importBtnText: { fontSize: 13.5, fontWeight: '700', color: c.accentText },

  volumeRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  slider: { flex: 1, height: 40 },

  footnote: { fontSize: 11, color: c.textMuted, fontWeight: '500', lineHeight: 16, marginTop: 26 },
})
