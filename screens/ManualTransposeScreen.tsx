// screens/ManualTransposeScreen.tsx
import React, { useState, useEffect, useMemo } from 'react'
import {
  View,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  Text,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from 'react-native'
import { useAppTheme, type AppColors } from '../lib/theme'
import Ionicons from '@expo/vector-icons/Ionicons'
import * as Clipboard from 'expo-clipboard'
import {
  getAllKeys,
  getTransposeDistance,
  transposeAnyText,
  detectKeyFromText,
  intervalLabel,
} from '../lib/transpose'

// Monochrome palette - Formal & Professional

interface Props {
  navigation: any
}

type Mode = 'chords' | 'nashville'

const KEYS = getAllKeys()

const CHORD_SHORTCUTS     = ['C', 'D', 'E', 'F', 'G', 'A', 'B', 'Am', 'Dm', 'Em', 'Bm', 'F#m']
const NASHVILLE_SHORTCUTS = ['I', 'ii', 'iii', 'IV', 'V', 'vi', 'vii']
const QUALITY_SHORTCUTS   = ['m', '7', 'maj7', 'm7', 'sus2', 'sus4', 'add9', 'dim']

export default function ManualTransposeScreen({ navigation }: Props) {
  const { colors: c } = useAppTheme()
  const styles = useMemo(() => makeStyles(c), [c])

  const [fromKey, setFromKey] = useState('C')
  const [toKey, setToKey]     = useState('D')
  const [input, setInput]     = useState('')
  const [mode, setMode]       = useState<Mode>('chords')

  const semitones = useMemo(() => getTransposeDistance(fromKey, toKey), [fromKey, toKey])

  // Live result - no button press needed, the chart updates as you type
  // The key is passed either way so the spelling follows it, but numerals are
  // only read as chords in Nashville mode - in chord mode an "I" or a "V1" on
  // its own is a heading, not the tonic.
  const result = useMemo(
    () => (input.trim() ? transposeAnyText(input, semitones, toKey, mode === 'nashville') : ''),
    [input, semitones, toKey, mode],
  )

  const shiftToKey = (step: number) => {
    const index = KEYS.indexOf(toKey)
    if (index === -1) return
    setToKey(KEYS[(index + step + KEYS.length) % KEYS.length])
  }

  const swapKeys = () => {
    setFromKey(toKey)
    setToKey(fromKey)
  }

  const handleDetectKey = () => {
    const detected = detectKeyFromText(input)
    if (!detected) {
      Alert.alert('No chords found', 'Type or paste some chords first, then tap Detect.')
      return
    }
    // The key row holds roots, so a detected minor key sets its root (Em -> E)
    setFromKey(detected.replace(/m$/, ''))
  }

  // Quick insert - a chord goes on the end, a quality attaches to the last chord
  const insertChord = (chord: string) => {
    setInput(prev => (prev.replace(/\s+$/, '') + ' ' + chord).trim() + ' ')
  }

  const insertQuality = (quality: string) => {
    setInput(prev => {
      const trimmed = prev.replace(/\s+$/, '')
      if (!trimmed) return prev
      // Keep it inside the brackets when the chart is written in [C] style
      if (trimmed.endsWith(']')) return trimmed.slice(0, -1) + quality + '] '
      return trimmed + quality + ' '
    })
  }

  const handlePaste = async () => {
    try {
      const text = await Clipboard.getStringAsync()
      if (!text) {
        Alert.alert('Clipboard empty', 'There is nothing to paste.')
        return
      }
      setInput(text)
    } catch {
      Alert.alert('Error', 'Failed to read the clipboard')
    }
  }

  const handleCopy = async () => {
    try {
      await Clipboard.setStringAsync(result)
      Alert.alert('Copied', 'Result copied to clipboard')
    } catch {
      Alert.alert('Error', 'Failed to copy to clipboard')
    }
  }

  const handleClear = () => {
    setInput('')
    setFromKey('C')
    setToKey('D')
  }

  const renderKeyRow = (selected: string, onSelect: (key: string) => void) => (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.keyScroller}
    >
      {KEYS.map(key => (
        <TouchableOpacity
          key={key}
          style={[styles.keyPill, selected === key && styles.keyPillActive]}
          onPress={() => onSelect(key)}
          activeOpacity={0.75}
        >
          <Text style={[styles.keyPillText, selected === key && styles.keyPillTextActive]}>
            {key}
          </Text>
        </TouchableOpacity>
      ))}
    </ScrollView>
  )

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={styles.container}
    >
      <ScrollView
        style={styles.content}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.title}>Transpose</Text>
        <Text style={styles.subtitle}>
          Pick the keys, then type or paste. The result updates as you go.
        </Text>

        {/* Mode Toggle */}
        <View style={styles.modeToggle}>
          {(['chords', 'nashville'] as const).map(m => (
            <TouchableOpacity
              key={m}
              style={[styles.modeButton, mode === m && styles.modeButtonActive]}
              onPress={() => setMode(m)}
              activeOpacity={0.8}
            >
              <Text style={[styles.modeButtonText, mode === m && styles.modeButtonTextActive]}>
                {m === 'chords' ? 'Chords' : 'Nashville'}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
        <Text style={styles.modeHint}>
          {mode === 'chords'
            ? 'Chord names in, chord names out.'
            : 'Numerals in (I, vi, IV), real chords in the To key out.'}
        </Text>

        {/* Keys */}
        <View style={styles.card}>
          <View style={styles.keyHeaderRow}>
            <Text style={styles.keyLabel}>From</Text>
            <TouchableOpacity style={styles.detectButton} onPress={handleDetectKey} activeOpacity={0.8}>
              <Ionicons name="sparkles-outline" size={13} color={c.text} />
              <Text style={styles.detectButtonText}>Detect</Text>
            </TouchableOpacity>
          </View>
          {renderKeyRow(fromKey, setFromKey)}

          <View style={styles.swapRow}>
            <View style={styles.divider} />
            <TouchableOpacity style={styles.swapButton} onPress={swapKeys} activeOpacity={0.8}>
              <Ionicons name="swap-vertical" size={17} color={c.accentText} />
            </TouchableOpacity>
            <View style={styles.divider} />
          </View>

          <View style={styles.keyHeaderRow}>
            <Text style={styles.keyLabel}>To</Text>
            <View style={styles.stepperRow}>
              <TouchableOpacity style={styles.stepperButton} onPress={() => shiftToKey(-1)} activeOpacity={0.8}>
                <Ionicons name="remove" size={17} color={c.text} />
              </TouchableOpacity>
              <TouchableOpacity style={styles.stepperButton} onPress={() => shiftToKey(1)} activeOpacity={0.8}>
                <Ionicons name="add" size={17} color={c.text} />
              </TouchableOpacity>
            </View>
          </View>
          {renderKeyRow(toKey, setToKey)}

          <View style={styles.deltaChip}>
            <Text style={styles.deltaText}>
              {fromKey} → {toKey}
              {semitones !== 0
                ? `  ·  ${semitones > 0 ? '+' : ''}${semitones}  ·  ${intervalLabel(semitones)}`
                : '  ·  Same key'}
            </Text>
          </View>
        </View>

        {/* Input */}
        <View style={styles.card}>
          <View style={styles.cardHeaderRow}>
            <Text style={styles.cardTitle}>Your chords</Text>
            <View style={styles.cardHeaderActions}>
              <TouchableOpacity style={styles.miniButton} onPress={handlePaste} activeOpacity={0.8}>
                <Ionicons name="clipboard-outline" size={14} color={c.text} />
                <Text style={styles.miniButtonText}>Paste</Text>
              </TouchableOpacity>
              {input.length > 0 && (
                <TouchableOpacity style={styles.miniButton} onPress={() => setInput('')} activeOpacity={0.8}>
                  <Ionicons name="close" size={14} color={c.text} />
                  <Text style={styles.miniButtonText}>Clear</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>

          <TextInput
            style={styles.input}
            placeholder={
              mode === 'chords'
                ? 'C  G  Am  F\nor  [C]Amazing [G]grace'
                : 'I  V  vi  IV\nor  [I]Amazing [V]grace'
            }
            placeholderTextColor={c.textMuted}
            value={input}
            onChangeText={setInput}
            multiline
            textAlignVertical="top"
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Text style={styles.inputHint}>
            Brackets are optional. Lyric lines are left exactly as they are.
          </Text>

          {/* Quick insert */}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
            {(mode === 'chords' ? CHORD_SHORTCUTS : NASHVILLE_SHORTCUTS).map(item => (
              <TouchableOpacity key={item} style={styles.chip} onPress={() => insertChord(item)} activeOpacity={0.8}>
                <Text style={styles.chipText}>{item}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
            {QUALITY_SHORTCUTS.map(item => (
              <TouchableOpacity
                key={item}
                style={[styles.chip, styles.chipQuality]}
                onPress={() => insertQuality(item)}
                activeOpacity={0.8}
              >
                <Text style={styles.chipText}>{item}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>

        {/* Result */}
        <View style={styles.card}>
          <View style={styles.cardHeaderRow}>
            <Text style={styles.cardTitle}>In {toKey}</Text>
            {result ? (
              <TouchableOpacity style={styles.miniButton} onPress={handleCopy} activeOpacity={0.8}>
                <Ionicons name="copy-outline" size={14} color={c.text} />
                <Text style={styles.miniButtonText}>Copy</Text>
              </TouchableOpacity>
            ) : null}
          </View>

          <View style={styles.resultBox}>
            {result ? (
              <Text style={styles.resultText} selectable>{result}</Text>
            ) : (
              <Text style={styles.resultPlaceholder}>
                Your transposed chords will appear here.
              </Text>
            )}
          </View>
        </View>

        {/* Reset */}
        <TouchableOpacity style={styles.clearButton} onPress={handleClear} activeOpacity={0.8}>
          <Text style={styles.clearButtonText}>Reset</Text>
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

const makeStyles = (c: AppColors) => StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: c.surfaceAlt,
  },
  content: {
    padding: 18,
  },
  title: {
    fontSize: 30,
    fontWeight: '800',
    color: c.text,
    letterSpacing: 0.3,
  },
  subtitle: {
    fontSize: 13,
    color: c.textSub,
    marginTop: 6,
    marginBottom: 20,
    fontWeight: '500',
  },

  // Cards
  card: {
    backgroundColor: c.surface,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: c.border,
    padding: 14,
    marginBottom: 16,
    elevation: 1,
    shadowColor: c.shadow,
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 2,
  },
  cardHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  cardTitle: {
    fontSize: 15,
    fontWeight: '800',
    color: c.text,
    letterSpacing: 0.2,
  },
  cardHeaderActions: {
    flexDirection: 'row',
    gap: 8,
  },
  miniButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 7,
    borderWidth: 1.5,
    borderColor: c.border,
    backgroundColor: c.surfaceAlt,
  },
  miniButtonText: {
    fontSize: 12,
    fontWeight: '700',
    color: c.text,
  },

  // Mode toggle
  modeToggle: {
    flexDirection: 'row',
    backgroundColor: c.surfaceAlt,
    borderRadius: 10,
    padding: 3,
    gap: 3,
  },
  modeButton: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
  },
  modeButtonActive: {
    backgroundColor: c.accent,
  },
  modeButtonText: {
    fontSize: 14,
    fontWeight: '700',
    color: c.textSub,
  },
  modeButtonTextActive: {
    color: c.accentText,
    fontWeight: '800',
  },
  modeHint: {
    fontSize: 12,
    color: c.textSub,
    marginTop: 8,
    marginBottom: 16,
    fontWeight: '500',
  },

  // Keys
  keyHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 9,
  },
  keyLabel: {
    fontSize: 12,
    fontWeight: '800',
    color: c.textSub,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  keyScroller: {
    gap: 7,
    paddingRight: 4,
  },
  keyPill: {
    minWidth: 44,
    paddingVertical: 9,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1.5,
    borderColor: c.border,
    backgroundColor: c.surface,
    alignItems: 'center',
  },
  keyPillActive: {
    backgroundColor: c.accent,
    borderColor: c.accent,
  },
  keyPillText: {
    fontSize: 15,
    fontWeight: '700',
    color: c.textSub,
  },
  keyPillTextActive: {
    color: c.accentText,
    fontWeight: '800',
  },
  detectButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingVertical: 5,
    paddingHorizontal: 10,
    borderRadius: 7,
    borderWidth: 1.5,
    borderColor: c.border,
    backgroundColor: c.surfaceAlt,
  },
  detectButtonText: {
    fontSize: 12,
    fontWeight: '700',
    color: c.text,
  },
  swapRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginVertical: 14,
  },
  divider: {
    flex: 1,
    height: 1.5,
    backgroundColor: c.surfaceAlt,
  },
  swapButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: c.accent,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 2,
    shadowColor: c.shadow,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 3,
  },
  stepperRow: {
    flexDirection: 'row',
    gap: 7,
  },
  stepperButton: {
    width: 34,
    height: 28,
    borderRadius: 7,
    borderWidth: 1.5,
    borderColor: c.border,
    backgroundColor: c.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  deltaChip: {
    marginTop: 14,
    paddingVertical: 9,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: c.surfaceAlt,
    alignItems: 'center',
  },
  deltaText: {
    fontSize: 13,
    fontWeight: '700',
    color: c.textSub,
  },

  // Input
  input: {
    backgroundColor: c.surfaceAlt,
    borderRadius: 8,
    borderWidth: 1.5,
    borderColor: c.border,
    padding: 12,
    fontSize: 15,
    minHeight: 110,
    color: c.text,
    fontWeight: '500',
  },
  inputHint: {
    fontSize: 11.5,
    color: c.textSub,
    marginTop: 8,
    fontWeight: '500',
  },
  chipRow: {
    gap: 7,
    paddingTop: 12,
    paddingRight: 4,
  },
  chip: {
    paddingVertical: 8,
    paddingHorizontal: 13,
    borderRadius: 7,
    backgroundColor: c.accent,
  },
  chipQuality: {
    backgroundColor: c.textSub,
  },
  chipText: {
    color: c.accentText,
    fontSize: 13,
    fontWeight: '700',
  },

  // Result
  resultBox: {
    backgroundColor: c.surfaceAlt,
    borderRadius: 8,
    borderWidth: 1.5,
    borderColor: c.border,
    padding: 12,
    minHeight: 110,
    justifyContent: 'center',
  },
  resultText: {
    fontSize: 16,
    color: c.text,
    lineHeight: 26,
    fontWeight: '600',
  },
  resultPlaceholder: {
    fontSize: 13,
    color: c.textSub,
    textAlign: 'center',
    fontWeight: '500',
  },

  // Reset
  clearButton: {
    backgroundColor: c.surfaceAlt,
    borderRadius: 8,
    paddingVertical: 13,
    alignItems: 'center',
    marginBottom: 30,
    borderWidth: 1.5,
    borderColor: c.border,
  },
  clearButtonText: {
    color: c.textSub,
    fontSize: 15,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
})
