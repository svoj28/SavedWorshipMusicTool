// components/DevotionRotationModal.tsx
//
// The Saturday devotion rota: who leads, and swapping when somebody cannot.
//
// Two jobs, in the order they are actually done. Swapping sits at the top,
// because it happens most weeks - somebody is away and two people trade
// dates. Setting the rotation up happens once a term, so it sits below.
//
// A swap is two taps: choose a Saturday, then choose the one to trade with.
// No drag handles, no long press - this gets used one-handed, standing up,
// five minutes before a rehearsal.
//
// Filling in Saturdays never touches a date that already has a devotion on
// it. That is what makes the button safe to press twice, and it means
// extending the rota next term cannot quietly undo the swaps agreed last
// week.

import React, { useMemo, useState } from 'react'
import {
  ActivityIndicator,
  Alert,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native'
import { useAppTheme, type AppColors } from '../lib/theme'
import Ionicons from '@expo/vector-icons/Ionicons'
import { CalendarEvent } from '../db/models'
import { createCalendarEvent, updateCalendarEvent } from '../db/queries'
import {
  DEVOTION_ROLE,
  DEVOTION_TITLE,
  describeDate,
  devotionLeaderOf,
  isDevotionEvent,
  nextSaturdayOnOrAfter,
  parseDateKey,
  planNewDevotions,
  saturdaysFrom,
  swapDevotionLeaders,
  toDateKey,
} from '../lib/devotionRotation'

interface Props {
  visible: boolean
  /** Every calendar event, so the devotions can be picked out of them */
  events: CalendarEvent[]
  userId: string
  onClose: () => void
  /** Ask the calendar to reload once something has changed */
  onChanged: () => Promise<void> | void
}

const WEEK_CHOICES = [8, 13, 26, 52]

export default function DevotionRotationModal({
  visible,
  events,
  userId,
  onClose,
  onChanged,
}: Props) {
  const { colors: c } = useAppTheme()
  const styles = useMemo(() => makeStyles(c), [c])

  const [leaders, setLeaders] = useState<string[]>([''])
  const [weeks, setWeeks] = useState(13)
  const [startKey, setStartKey] = useState(() => toDateKey(nextSaturdayOnOrAfter(new Date())))
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [showSetup, setShowSetup] = useState(false)

  const today = toDateKey(new Date())

  /** The devotions still to come, earliest first. */
  const upcoming = useMemo(
    () =>
      events
        .filter(e => isDevotionEvent(e) && e.eventDate >= today)
        .sort((a, b) => a.eventDate.localeCompare(b.eventDate)),
    [events, today],
  )

  /**
   * Names already in the rota, offered as the starting point when setting one
   * up - retyping the same six names every term is a waste of an evening.
   */
  const knownLeaders = useMemo(() => {
    const seen: string[] = []
    for (const event of events) {
      if (!isDevotionEvent(event)) continue
      const name = devotionLeaderOf(event)
      if (name && seen.indexOf(name) === -1) seen.push(name)
    }
    return seen
  }, [events])

  const openSetup = () => {
    setLeaders(knownLeaders.length > 0 ? knownLeaders.slice() : [''])
    setShowSetup(true)
  }

  const setLeaderAt = (index: number, value: string) => {
    setLeaders(prev => prev.map((l, i) => (i === index ? value : l)))
  }

  const removeLeaderAt = (index: number) => {
    setLeaders(prev => (prev.length <= 1 ? [''] : prev.filter((_, i) => i !== index)))
  }

  const shiftStart = (weeksBy: number) => {
    const earliest = nextSaturdayOnOrAfter(new Date())
    const moved = parseDateKey(startKey)
    moved.setDate(moved.getDate() + weeksBy * 7)
    // Never start the rota in the past
    setStartKey(moved < earliest ? toDateKey(earliest) : toDateKey(moved))
  }

  /** Write a devotion onto every listed Saturday that does not have one. */
  const fillInSaturdays = async () => {
    const named = leaders.map(l => l.trim()).filter(Boolean)
    if (named.length === 0) {
      Alert.alert('Add a leader first', 'Type at least one name to build the rotation from.')
      return
    }

    const dates = saturdaysFrom(startKey, weeks)
    const taken = events.filter(isDevotionEvent).map(e => e.eventDate)

    const planned = dates.length
    const toCreate = planNewDevotions(named, dates, taken)

    if (toCreate.length === 0) {
      Alert.alert(
        'Already scheduled',
        'Every Saturday in that stretch already has a devotion leader. Nothing was changed.',
      )
      return
    }

    setBusy(true)
    try {
      for (const entry of toCreate) {
        const now = Date.now()
        await createCalendarEvent({
          eventDate: entry.date,
          title: DEVOTION_TITLE,
          assignments: [{ role: DEVOTION_ROLE, person: entry.person, note: '' }],
          notes: '',
          userId,
          createdAt: now,
          updatedAt: now,
          synced: false,
        })
      }

      await onChanged()
      setShowSetup(false)

      const skipped = planned - toCreate.length
      Alert.alert(
        'Rotation filled in',
        toCreate.length +
          (toCreate.length === 1 ? ' Saturday added' : ' Saturdays added') +
          (skipped > 0
            ? ', and ' + skipped + ' left as they were - those dates already had a leader.'
            : '.'),
      )
    } catch (err) {
      console.error('Failed to build devotion rotation:', err)
      Alert.alert('Could not save', 'The rotation could not be written. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  /** Trade the leaders on two Saturdays. */
  const swapWith = async (target: CalendarEvent) => {
    const first = upcoming.find(e => e.id === selectedId)
    if (!first || first.id === target.id) {
      setSelectedId(null)
      return
    }

    const swapped = swapDevotionLeaders(first.assignments || [], target.assignments || [])

    setBusy(true)
    try {
      const now = Date.now()
      await updateCalendarEvent(first.id, { assignments: swapped.first, updatedAt: now })
      await updateCalendarEvent(target.id, { assignments: swapped.second, updatedAt: now })
      await onChanged()
      setSelectedId(null)
    } catch (err) {
      console.error('Failed to swap devotion leaders:', err)
      Alert.alert('Could not swap', 'The two dates could not be swapped. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  const onRowPress = (event: CalendarEvent) => {
    if (busy) return
    if (!selectedId) {
      setSelectedId(event.id)
      return
    }
    if (selectedId === event.id) {
      setSelectedId(null)
      return
    }
    swapWith(event)
  }

  const selected = upcoming.find(e => e.id === selectedId)

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          <View style={styles.handle} />

          <View style={styles.head}>
            <View style={{ flex: 1 }}>
              <Text style={styles.title}>Saturday devotion</Text>
              <Text style={styles.subtitle}>
                {selected
                  ? 'Now choose the Saturday to swap ' +
                    (devotionLeaderOf(selected) || 'them') +
                    ' with'
                  : upcoming.length > 0
                    ? 'Tap two Saturdays to swap their leaders'
                    : 'No devotions scheduled yet'}
              </Text>
            </View>
            <TouchableOpacity style={styles.iconBtn} onPress={onClose} activeOpacity={0.7}>
              <Ionicons name="close" size={16} color={c.text} />
            </TouchableOpacity>
          </View>

          {selected && (
            <TouchableOpacity
              style={styles.cancelSwap}
              onPress={() => setSelectedId(null)}
              activeOpacity={0.8}
            >
              <Ionicons name="close-circle-outline" size={13} color={c.danger} />
              <Text style={styles.cancelSwapText}>Cancel swap</Text>
            </TouchableOpacity>
          )}

          <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
            {upcoming.map(event => {
              const isSelected = event.id === selectedId
              return (
                <TouchableOpacity
                  key={event.id}
                  style={[styles.row, isSelected && styles.rowSelected]}
                  onPress={() => onRowPress(event)}
                  activeOpacity={0.75}
                  disabled={busy}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.rowDate, isSelected && styles.rowTextSelected]}>
                      {describeDate(event.eventDate)}
                    </Text>
                    <Text style={[styles.rowPerson, isSelected && styles.rowTextSelected]}>
                      {devotionLeaderOf(event) || 'Nobody assigned'}
                    </Text>
                  </View>
                  <Ionicons
                    name={isSelected ? 'swap-horizontal' : 'chevron-forward'}
                    size={16}
                    color={isSelected ? c.accentText : c.iconInactive}
                  />
                </TouchableOpacity>
              )
            })}

            {upcoming.length === 0 && !showSetup && (
              <View style={styles.empty}>
                <Ionicons name="calendar-outline" size={22} color={c.iconInactive} />
                <Text style={styles.emptyText}>
                  Nobody is scheduled yet. Set the rotation up below and every Saturday will be
                  filled in for you.
                </Text>
              </View>
            )}

            {/* ── Setting the rotation up ── */}
            {!showSetup ? (
              <TouchableOpacity style={styles.setupBtn} onPress={openSetup} activeOpacity={0.8}>
                <Ionicons name="repeat" size={15} color={c.text} />
                <Text style={styles.setupBtnText}>
                  {upcoming.length > 0 ? 'Add more Saturdays' : 'Set up the rotation'}
                </Text>
              </TouchableOpacity>
            ) : (
              <View style={styles.setup}>
                <Text style={styles.sectionLabel}>LEADERS, IN ORDER</Text>
                {leaders.map((leader, index) => (
                  <View key={index} style={styles.leaderRow}>
                    <Text style={styles.leaderNumber}>{index + 1}</Text>
                    <TextInput
                      style={styles.leaderInput}
                      value={leader}
                      onChangeText={t => setLeaderAt(index, t)}
                      placeholder="Name"
                      placeholderTextColor={c.textMuted}
                      autoCapitalize="words"
                    />
                    <TouchableOpacity
                      onPress={() => removeLeaderAt(index)}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    >
                      <Ionicons name="remove-circle-outline" size={18} color={c.iconInactive} />
                    </TouchableOpacity>
                  </View>
                ))}

                <TouchableOpacity
                  style={styles.addLeader}
                  onPress={() => setLeaders(prev => [...prev, ''])}
                  activeOpacity={0.8}
                >
                  <Ionicons name="add" size={14} color={c.text} />
                  <Text style={styles.addLeaderText}>Add a leader</Text>
                </TouchableOpacity>

                <Text style={styles.sectionLabel}>STARTING</Text>
                <View style={styles.startRow}>
                  <TouchableOpacity
                    style={styles.stepBtn}
                    onPress={() => shiftStart(-1)}
                    activeOpacity={0.8}
                  >
                    <Ionicons name="chevron-back" size={15} color={c.text} />
                  </TouchableOpacity>
                  <Text style={styles.startText}>{describeDate(startKey)}</Text>
                  <TouchableOpacity
                    style={styles.stepBtn}
                    onPress={() => shiftStart(1)}
                    activeOpacity={0.8}
                  >
                    <Ionicons name="chevron-forward" size={15} color={c.text} />
                  </TouchableOpacity>
                </View>

                <Text style={styles.sectionLabel}>HOW MANY WEEKS</Text>
                <View style={styles.weekRow}>
                  {WEEK_CHOICES.map(choice => (
                    <TouchableOpacity
                      key={choice}
                      style={[styles.weekChip, weeks === choice && styles.weekChipOn]}
                      onPress={() => setWeeks(choice)}
                      activeOpacity={0.75}
                    >
                      <Text
                        style={[styles.weekChipText, weeks === choice && styles.weekChipTextOn]}
                      >
                        {choice}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>

                <TouchableOpacity
                  style={[styles.primaryBtn, busy && styles.primaryBtnBusy]}
                  onPress={fillInSaturdays}
                  disabled={busy}
                  activeOpacity={0.85}
                >
                  {busy ? (
                    <ActivityIndicator size="small" color={c.accentText} />
                  ) : (
                    <Text style={styles.primaryBtnText}>Fill in the Saturdays</Text>
                  )}
                </TouchableOpacity>

                <Text style={styles.footnote}>
                  Saturdays that already have a devotion leader are left exactly as they are, so
                  this is safe to run again and will not undo any swaps.
                </Text>
              </View>
            )}

            <View style={{ height: 20 }} />
          </ScrollView>
        </View>
      </View>
    </Modal>
  )
}

const makeStyles = (c: AppColors) => StyleSheet.create({
  overlay: { flex: 1, backgroundColor: c.accent, justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: c.surface,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    paddingHorizontal: 16,
    paddingBottom: 22,
    maxHeight: '88%',
  },
  handle: {
    width: 38,
    height: 4,
    borderRadius: 2,
    backgroundColor: c.border,
    alignSelf: 'center',
    marginTop: 10,
    marginBottom: 14,
  },

  head: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 12 },
  title: { fontSize: 16, fontWeight: '800', color: c.text, letterSpacing: -0.3 },
  subtitle: { fontSize: 11.5, fontWeight: '500', color: c.textMuted, marginTop: 2 },
  iconBtn: {
    width: 32,
    height: 32,
    borderRadius: 10,
    backgroundColor: c.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },

  cancelSwap: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 5,
    backgroundColor: c.dangerBg,
    borderRadius: 8,
    paddingHorizontal: 9,
    paddingVertical: 6,
    marginBottom: 10,
  },
  cancelSwapText: { fontSize: 11.5, fontWeight: '700', color: c.danger },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: c.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: c.hairline,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 8,
  },
  rowSelected: { backgroundColor: c.accent, borderColor: c.accent },
  rowDate: { fontSize: 13, fontWeight: '700', color: c.text },
  rowPerson: { fontSize: 12, fontWeight: '500', color: c.textMuted, marginTop: 2 },
  rowTextSelected: { color: c.accentText },

  empty: { alignItems: 'center', gap: 10, paddingVertical: 26, paddingHorizontal: 18 },
  emptyText: {
    fontSize: 12.5,
    fontWeight: '500',
    color: c.textMuted,
    textAlign: 'center',
    lineHeight: 18,
  },

  setupBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: 6,
    paddingVertical: 13,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: c.border,
    backgroundColor: c.surfaceAlt,
  },
  setupBtnText: { fontSize: 13, fontWeight: '700', color: c.text },

  setup: { marginTop: 10 },
  sectionLabel: {
    fontSize: 9,
    fontWeight: '700',
    color: c.iconInactive,
    letterSpacing: 1.6,
    marginTop: 16,
    marginBottom: 8,
  },

  leaderRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8 },
  leaderNumber: {
    fontSize: 11,
    fontWeight: '700',
    color: c.textMuted,
    width: 14,
    textAlign: 'center',
  },
  leaderInput: {
    flex: 1,
    height: 40,
    borderRadius: 8,
    borderWidth: 1.5,
    borderColor: c.border,
    paddingHorizontal: 11,
    fontSize: 13.5,
    color: c.text,
    backgroundColor: c.surfaceAlt,
  },
  addLeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: c.border,
  },
  addLeaderText: { fontSize: 12.5, fontWeight: '700', color: c.text },

  startRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  stepBtn: {
    width: 34,
    height: 34,
    borderRadius: 9,
    backgroundColor: c.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  startText: { flex: 1, textAlign: 'center', fontSize: 13.5, fontWeight: '700', color: c.text },

  weekRow: { flexDirection: 'row', gap: 8 },
  weekChip: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 9,
    backgroundColor: c.surfaceAlt,
    borderWidth: 1,
    borderColor: c.hairline,
    alignItems: 'center',
  },
  weekChipOn: { backgroundColor: c.accent, borderColor: c.accent },
  weekChipText: { fontSize: 13, fontWeight: '700', color: c.textSub },
  weekChipTextOn: { color: c.accentText },

  primaryBtn: {
    marginTop: 18,
    paddingVertical: 15,
    borderRadius: 12,
    backgroundColor: c.accent,
    alignItems: 'center',
  },
  primaryBtnBusy: { backgroundColor: c.textSub },
  primaryBtnText: { fontSize: 14, fontWeight: '800', color: c.accentText },

  footnote: { fontSize: 11, fontWeight: '500', color: c.textMuted, lineHeight: 16, marginTop: 10 },
})
