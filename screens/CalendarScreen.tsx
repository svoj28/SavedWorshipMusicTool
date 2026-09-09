import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Modal,
  TextInput,
  Alert,
  ActivityIndicator,
  Pressable,
  RefreshControl,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
} from 'react-native'
import { useAppTheme, type AppColors } from '../lib/theme'
import Ionicons from '@expo/vector-icons/Ionicons'
import { WebView } from '../components/EngineWebView'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { getCurrentUser } from '../lib/auth'
import {
  createCalendarEvent,
  deleteCalendarEvent,
  getAllCalendarEvents,
  updateCalendarEvent,
} from '../db/queries'
import { CalendarAssignment, CalendarEvent } from '../db/models'
import DevotionRotationModal from '../components/DevotionRotationModal'
import { useRole } from '../lib/useRole'
import { onTableChange } from '../lib/sync'
import { usePullToRefresh } from '../lib/usePullToRefresh'

const DEFAULT_ROLES = [
  'Lead Guitarist',
  'Keyboardist',
  'Drummer',
  'Bassist',
  'Vocalist',
  'Sound Engineer',
  'Lyrics Operator',
  'Other',
]

type CalendarFormState = {
  eventDate: string
  title: string
  notes: string
  assignments: CalendarAssignment[]
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function toDateKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function parseDateKey(dateKey: string): Date {
  const [year, month, day] = dateKey.split('-').map(part => Number(part))
  return new Date(year, (month || 1) - 1, day || 1)
}

function formatDisplayDate(dateKey: string): string {
  const date = parseDateKey(dateKey)
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(date)
}

function formatMonthLabel(date: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    year: 'numeric',
  }).format(date)
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function hasHtml(value: string): boolean {
  return /<[a-z][\s\S]*>/i.test(value)
}

function plainTextToHtml(value: string): string {
  const escaped = escapeHtml(value.trim())
  if (!escaped) return ''
  return `<p>${escaped.replace(/\n/g, '<br/>')}</p>`
}

function normalizeRichTextValue(value?: string): string {
  const text = value ?? ''
  if (!text.trim()) return ''
  return hasHtml(text) ? text : plainTextToHtml(text)
}

function stripHtml(value?: string): string {
  if (!value) return ''
  return value
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

function buildRichTextDocument(initialHtml: string, placeholder: string, editable: boolean): string {
  const safeInitialHtml = JSON.stringify(initialHtml || '')
  const safePlaceholder = escapeHtml(placeholder)
  return `<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0" />
  <style>
    :root { color-scheme: light; }
    html, body { margin: 0; padding: 0; background: transparent; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      color: #0A0A0A;
      font-size: 16px;
      line-height: 1.5;
      -webkit-text-size-adjust: 100%;
      padding: 0;
    }
    #editor {
      min-height: 100vh;
      outline: none;
      white-space: pre-wrap;
      word-break: break-word;
      padding: 14px 14px 20px;
      box-sizing: border-box;
    }
    #editor:empty:before {
      content: attr(data-placeholder);
      color: #C4C4C4;
    }
    b, strong { font-weight: 800; }
    i, em { font-style: italic; }
    u { text-decoration: underline; }
    p { margin: 0 0 10px; }
    p:last-child { margin-bottom: 0; }
  </style>
</head>
<body>
  <div id="editor" ${editable ? 'contenteditable="true"' : 'contenteditable="false"'} data-placeholder="${safePlaceholder}"></div>
  <script>
    (function() {
      var editor = document.getElementById('editor');
      var savedRange = null;

      function post(type, payload) {
        window.ReactNativeWebView.postMessage(JSON.stringify(Object.assign({ type: type }, payload || {})));
      }

      function postChange() {
        post('change', { html: editor.innerHTML });
      }

      function restoreSelection() {
        var selection = window.getSelection();
        if (!savedRange || !selection) return;
        selection.removeAllRanges();
        selection.addRange(savedRange);
      }

      function saveSelection() {
        var selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) return;
        var range = selection.getRangeAt(0);
        if (!editor.contains(range.commonAncestorContainer)) return;
        savedRange = range.cloneRange();
      }

      editor.addEventListener('input', postChange);
      editor.addEventListener('keyup', saveSelection);
      editor.addEventListener('mouseup', saveSelection);
      document.addEventListener('selectionchange', saveSelection);

      window.__setHtml = function(html) {
        editor.innerHTML = html || '';
        if (!editor.innerHTML.trim()) {
          editor.innerHTML = '<div><br /></div>';
        }
      };

      window.__applyCommand = function(command) {
        editor.focus();
        restoreSelection();
        document.execCommand(command, false, null);
        savedRange = null;
        postChange();
      };

      window.__focusEditor = function() {
        editor.focus();
      };

      window.__setHtml(${safeInitialHtml});
      post('ready');
    })();
  </script>
</body>
</html>`
}

function RichTextField({
  label,
  value,
  onChange,
  placeholder,
  height = 200,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder: string
  height?: number
}) {
  const { colors: c } = useAppTheme()
  const styles = useMemo(() => makeStyles(c), [c])

  const webViewRef = useRef<any>(null)
  const initialHtmlRef = useRef<string>(normalizeRichTextValue(value))

  const applyFormat = (command: 'bold' | 'italic' | 'underline') => {
    webViewRef.current?.injectJavaScript(`window.__applyCommand(${JSON.stringify(command)}); true;`)
  }

  return (
    <View style={styles.richField}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <View style={[styles.richEditorWrap, { height }]}> 
        <WebView
          ref={webViewRef}
          originWhitelist={['*']}
          source={{ html: buildRichTextDocument(initialHtmlRef.current, placeholder, true) }}
          style={styles.richEditorWebView}
          onMessage={(event) => {
            try {
              const message = JSON.parse(event.nativeEvent.data)
              if (message.type === 'change' && typeof message.html === 'string') {
                onChange(message.html)
              }
            } catch {
              // Ignore malformed bridge messages.
            }
          }}
          javaScriptEnabled
          domStorageEnabled
          scrollEnabled
          showsVerticalScrollIndicator={false}
        />
      </View>
      <View style={styles.richToolbar}>
        <TouchableOpacity
          style={styles.richToolBtn}
          onPressIn={() => webViewRef.current?.injectJavaScript('window.__focusEditor(); true;')}
          onPress={() => applyFormat('bold')}
          activeOpacity={0.75}
        >
          <Text style={styles.richToolBtnText}>B</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.richToolBtn}
          onPressIn={() => webViewRef.current?.injectJavaScript('window.__focusEditor(); true;')}
          onPress={() => applyFormat('italic')}
          activeOpacity={0.75}
        >
          <Text style={[styles.richToolBtnText, styles.richToolItalic]}>I</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.richToolBtn}
          onPressIn={() => webViewRef.current?.injectJavaScript('window.__focusEditor(); true;')}
          onPress={() => applyFormat('underline')}
          activeOpacity={0.75}
        >
          <Text style={[styles.richToolBtnText, styles.richToolUnderline]}>U</Text>
        </TouchableOpacity>
        <Text style={styles.richToolbarHint}>Highlight text, then tap a style</Text>
      </View>
    </View>
  )
}

function RichTextPreview({ label, value }: { label: string; value: string }) {
  const { colors: c } = useAppTheme()
  const styles = useMemo(() => makeStyles(c), [c])

  if (!value) return null

  return (
    <View style={styles.detailBlock}>
      <Text style={styles.detailLabel}>{label}</Text>
      <View style={styles.detailRichPreviewWrap}>
        <WebView
          originWhitelist={['*']}
          source={{ html: buildRichTextDocument(value, '', false) }}
          style={styles.detailRichPreview}
          scrollEnabled
          showsVerticalScrollIndicator={false}
          javaScriptEnabled
          domStorageEnabled
        />
      </View>
    </View>
  )
}

function buildMonthCells(monthDate: Date) {
  const year = monthDate.getFullYear()
  const month = monthDate.getMonth()
  const firstDay = new Date(year, month, 1)
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const startOffset = firstDay.getDay()
  const cells: Array<{ dateKey: string | null; day: number | null; inMonth: boolean }> = []

  for (let index = 0; index < 42; index += 1) {
    const dayNumber = index - startOffset + 1
    if (dayNumber < 1 || dayNumber > daysInMonth) {
      cells.push({ dateKey: null, day: null, inMonth: false })
    } else {
      const date = new Date(year, month, dayNumber)
      cells.push({ dateKey: toDateKey(date), day: dayNumber, inMonth: true })
    }
  }

  return cells
}

function normalizeAssignments(assignments: CalendarAssignment[]): CalendarAssignment[] {
  return assignments
    .map(item => ({
      role: item.role.trim(),
      person: item.person.trim(),
      note: item.note?.trim() || '',
    }))
    .filter(item => item.role || item.person || item.note)
}

const blankAssignment = (): CalendarAssignment => ({ role: '', person: '', note: '' })

export default function CalendarScreen() {
  const { colors: c } = useAppTheme()
  const styles = useMemo(() => makeStyles(c), [c])

  const insets = useSafeAreaInsets()
  const [userId, setUserId] = useState('')
  const [loading, setLoading] = useState(true)
  const [events, setEvents] = useState<CalendarEvent[]>([])
  const [selectedDate, setSelectedDate] = useState(toDateKey(new Date()))
  const [monthDate, setMonthDate] = useState(new Date(new Date().getFullYear(), new Date().getMonth(), 1))
  const [showForm, setShowForm] = useState(false)
  const [showDevotionRotation, setShowDevotionRotation] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [selectedEvent, setSelectedEvent] = useState<CalendarEvent | null>(null)
  const [saving, setSaving] = useState(false)
  const { role, loading: roleLoading, canManageCalendar } = useRole()

  const [formData, setFormData] = useState<CalendarFormState>({
    eventDate: selectedDate,
    title: '',
    notes: '',
    assignments: [blankAssignment()],
  })

  const loadEvents = useCallback(async () => {
    const data = await getAllCalendarEvents()
    setEvents(data)
  }, [])

  useEffect(() => {
    const load = async () => {
      try {
        const user = await getCurrentUser()
        if (user) setUserId(user.id)
        await loadEvents()
      } catch (err) {
        console.error('Failed to load calendar:', err)
      } finally {
        setLoading(false)
      }
    }

    void load()
  }, [loadEvents])

  useEffect(() => {
    const unsub = onTableChange('team_calendar_events', () => {
      void loadEvents()
    })
    return () => unsub()
  }, [loadEvents])

  const { refreshing, onRefresh } = usePullToRefresh(async () => {
    await loadEvents()
  })

  const eventsByDate = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>()
    for (const event of events) {
      const list = map.get(event.eventDate) || []
      list.push(event)
      map.set(event.eventDate, list)
    }
    return map
  }, [events])

  const selectedDateEvents = eventsByDate.get(selectedDate) || []
  const monthCells = useMemo(() => buildMonthCells(monthDate), [monthDate])

  const moveMonth = (delta: number) => {
    setMonthDate(prev => new Date(prev.getFullYear(), prev.getMonth() + delta, 1))
  }

  const jumpToToday = () => {
    const today = new Date()
    const key = toDateKey(today)
    setSelectedDate(key)
    setMonthDate(new Date(today.getFullYear(), today.getMonth(), 1))
  }

  const openCreateForm = () => {
    setEditingId(null)
    setFormData({
      eventDate: selectedDate,
      title: '',
      notes: '',
      assignments: [blankAssignment()],
    })
    setShowForm(true)
  }

  const openEditForm = (event: CalendarEvent) => {
    setEditingId(event.id)
    setFormData({
      eventDate: event.eventDate,
      title: event.title,
      notes: event.notes || '',
      assignments: event.assignments.length > 0 ? event.assignments : [blankAssignment()],
    })
    setSelectedEvent(null)
    setShowForm(true)
  }

  const handleSubmit = async () => {
  if (!canManageCalendar) {
    Alert.alert('Access denied', 'Only managers can change the team calendar.')
    return
  }

  if (!formData.eventDate.trim()) {
    Alert.alert('Notice', 'Please enter a date.')
    return
  }

  if (!formData.title.trim()) {
    Alert.alert('Notice', 'Please enter a schedule title.')
    return
  }

  const assignments = normalizeAssignments(formData.assignments)
  const now = Date.now()
  const payload = {
    eventDate: formData.eventDate.trim(),
    title: formData.title.trim(),
    assignments,
    notes: formData.notes,
    userId,
    createdAt: now,
    updatedAt: now,
    synced: false,
  }

  Keyboard.dismiss()
  setSaving(true)
  try {
    if (editingId) {
      await updateCalendarEvent(editingId, {
        eventDate: payload.eventDate,
        title: payload.title,
        assignments: payload.assignments,
        notes: payload.notes,
        updatedAt: now,
      })
    } else {
      await createCalendarEvent(payload)
    }
    await loadEvents()
    setSelectedDate(payload.eventDate)
    setMonthDate(parseDateKey(payload.eventDate))
    setShowForm(false)
    setEditingId(null)
    setFormData({ eventDate: selectedDate, title: '', notes: '', assignments: [blankAssignment()] })
  } catch (err) {
    console.error('Failed to save calendar event:', err)
    Alert.alert('Error', 'Failed to save the schedule item.')
  } finally {
    setSaving(false)
  }
}

  const confirmDelete = (event: CalendarEvent) => {
    if (!canManageCalendar) {
      Alert.alert('Access denied', 'Only managers can delete calendar items.')
      return
    }

    Alert.alert('Delete Schedule Item', `Delete "${event.title}"?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await deleteCalendarEvent(event.id)
            setSelectedEvent(null)
            await loadEvents()
          } catch (err) {
            console.error('Failed to delete calendar event:', err)
            Alert.alert('Error', 'Failed to delete the schedule item.')
          }
        },
      },
    ])
  }

  const selectedDayLabel = formatDisplayDate(selectedDate)

  if (loading || roleLoading) {
    return (
      <View style={styles.loadingWrap}>
        <ActivityIndicator size="large" color={c.text} />
      </View>
    )
  }

  return (
    <View style={styles.container}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.hero}>
          <View>
            <Text style={styles.eyebrow}>TEAM CALENDAR</Text>
            <Text style={styles.title}>Worship Schedule</Text>
            <Text style={styles.subtitle}>
              Stay on track with your schedule.
            </Text>
          </View>
          {/* <View style={styles.heroBadge}>
            <Ionicons name="calendar-outline" size={18} color={c.text} />
            <Text style={styles.heroBadgeText}>{role.toUpperCase()}</Text>
          </View> */}
        </View>

        <View style={styles.monthCard}>
          <View style={styles.monthHeader}>
            <TouchableOpacity style={styles.monthNavBtn} onPress={() => moveMonth(-1)} activeOpacity={0.75}>
              <Ionicons name="chevron-back" size={18} color={c.text} />
            </TouchableOpacity>
            <View style={styles.monthHeaderTextWrap}>
              <Text style={styles.monthLabel}>{formatMonthLabel(monthDate)}</Text>
              <Text style={styles.monthHint}>Tap a date to view the team schedule</Text>
            </View>
            <TouchableOpacity style={styles.monthNavBtn} onPress={() => moveMonth(1)} activeOpacity={0.75}>
              <Ionicons name="chevron-forward" size={18} color={c.text} />
            </TouchableOpacity>
          </View>

          <View style={styles.weekRow}>
            {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(day => (
              <Text key={day} style={styles.weekLabel}>{day}</Text>
            ))}
          </View>

          <View style={styles.grid}>
            {monthCells.map((cell, index) => {
              const isSelected = cell.dateKey === selectedDate
              const hasEvents = cell.dateKey ? (eventsByDate.get(cell.dateKey)?.length || 0) > 0 : false
              return (
                <TouchableOpacity
                  key={`${cell.dateKey || 'empty'}-${index}`}
                  style={[
                    styles.dayCell,
                    !cell.inMonth && styles.dayCellMuted,
                    isSelected && styles.dayCellSelected,
                  ]}
                  activeOpacity={0.8}
                  disabled={!cell.dateKey}
                  onPress={() => {
                    if (!cell.dateKey) return
                    setSelectedDate(cell.dateKey)
                    setMonthDate(parseDateKey(cell.dateKey))
                  }}
                >
                  <Text style={[styles.dayNumber, !cell.inMonth && styles.dayNumberMuted, isSelected && styles.dayNumberSelected]}>
                    {cell.day || ''}
                  </Text>
                  {hasEvents && <View style={[styles.eventDot, isSelected && styles.eventDotSelected]} />}
                </TouchableOpacity>
              )
            })}
          </View>

          <TouchableOpacity style={styles.todayBtn} onPress={jumpToToday} activeOpacity={0.8}>
            <Ionicons name="today-outline" size={16} color={c.text} />
            <Text style={styles.todayBtnText}>Jump to Today</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.sectionCard}>
          <View style={styles.sectionHeaderRow}>
            <View style={styles.sectionAccentLine} />
            <Text style={styles.sectionHeader}>SELECTED DAY</Text>
          </View>
          <Text style={styles.selectedDayTitle}>{selectedDayLabel}</Text>
          <Text style={styles.selectedDayMeta}>
            {selectedDateEvents.length} {selectedDateEvents.length === 1 ? 'schedule item' : 'schedule items'}
          </Text>
        </View>

        <View style={styles.eventsSection}>
          <View style={styles.sectionHeaderRow}>
            <View style={styles.sectionAccentLine} />
            <Text style={styles.sectionHeader}>SCHEDULE ITEMS</Text>
          </View>

          {selectedDateEvents.length === 0 ? (
            <View style={styles.emptyState}>
              <Ionicons name="calendar-number-outline" size={40} color={c.iconInactive} />
              <Text style={styles.emptyTitle}>No schedule yet</Text>
              <Text style={styles.emptySubtitle}>This day has no team assignments posted.</Text>
              {canManageCalendar && (
                <TouchableOpacity style={styles.emptyAddBtn} onPress={openCreateForm} activeOpacity={0.8}>
                  <Ionicons name="add" size={16} color={c.accentText} />
                  <Text style={styles.emptyAddText}>Add Schedule Item</Text>
                </TouchableOpacity>
              )}
            </View>
          ) : (
            selectedDateEvents.map(event => (
              <Pressable key={event.id} style={styles.eventCard} onPress={() => setSelectedEvent(event)}>
                <View style={styles.eventTopRow}>
                  <View style={styles.eventTitleWrap}>
                    <Text style={styles.eventTitle}>{event.title}</Text>
                    <Text style={styles.eventDate}>{formatDisplayDate(event.eventDate)}</Text>
                  </View>
                  {canManageCalendar && (
                    <TouchableOpacity
                      style={styles.eventEditBtn}
                      onPress={() => openEditForm(event)}
                      activeOpacity={0.75}
                    >
                      <Ionicons name="create-outline" size={16} color={c.text} />
                    </TouchableOpacity>
                  )}
                </View>

                <View style={styles.assignmentList}>
                  {event.assignments.length > 0 ? event.assignments.map((assignment, index) => (
                    <View key={`${event.id}-${index}`} style={styles.assignmentRow}>
                      <Text style={styles.assignmentRole}>{assignment.role || 'Role'}</Text>
                      <Text style={styles.assignmentPerson}>{assignment.person || 'Unassigned'}</Text>
                      {assignment.note ? <Text style={styles.assignmentNote}>{assignment.note}</Text> : null}
                    </View>
                  )) : (
                    <Text style={styles.assignmentEmpty}>No roles added yet.</Text>
                  )}
                </View>

                {event.notes ? (
                  <View style={styles.eventNotesPreviewWrap}>
                    <WebView
                      originWhitelist={['*']}
                      source={{ html: buildRichTextDocument(event.notes, '', false) }}
                      style={styles.eventNotesWebView}
                      scrollEnabled={false}
                      javaScriptEnabled
                      domStorageEnabled
                    />
                  </View>
                ) : null}
              </Pressable>
            ))
          )}

          {canManageCalendar && selectedDateEvents.length > 0 && (
            <TouchableOpacity style={styles.addMoreBtn} onPress={openCreateForm} activeOpacity={0.8}>
              <Ionicons name="add" size={17} color={c.text} />
              <Text style={styles.addMoreText}>Add Another Item</Text>
            </TouchableOpacity>
          )}
        </View>
      </ScrollView>

      {canManageCalendar && (
        <>
          {/* The devotion rota sits above the add button: it is a schedule of
              its own rather than a one-off event, and it is the thing an
              admin comes back to week after week. */}
          <TouchableOpacity
            style={styles.devotionFab}
            onPress={() => setShowDevotionRotation(true)}
            activeOpacity={0.85}
            accessibilityRole="button"
            accessibilityLabel="Saturday devotion rotation"
          >
            <Ionicons name="repeat" size={19} color={c.text} />
          </TouchableOpacity>

          <TouchableOpacity style={styles.fab} onPress={openCreateForm} activeOpacity={0.85}>
            <Ionicons name="add" size={24} color={c.accentText} />
          </TouchableOpacity>
        </>
      )}

      <DevotionRotationModal
        visible={showDevotionRotation}
        events={events}
        userId={userId}
        onClose={() => setShowDevotionRotation(false)}
        onChanged={loadEvents}
      />

      <Modal
  visible={showForm}
  transparent
  animationType="slide"
  onRequestClose={() => {
    Keyboard.dismiss()
    setTimeout(() => setShowForm(false), Platform.OS === 'android' ? 150 : 50)
  }}
>
  <KeyboardAvoidingView
    style={{ flex: 1, backgroundColor: c.accent }}
    behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    keyboardVerticalOffset={0}
  >
    <View style={styles.modalOverlay}>
      <View style={[styles.formSheet, { paddingBottom: Math.max(insets.bottom, 16) }]}>
        <View style={[styles.formHeader, { paddingTop: Math.max(14, insets.top + 8) }]}>
          <TouchableOpacity onPress={() => {
            Keyboard.dismiss()
            setTimeout(() => setShowForm(false), Platform.OS === 'android' ? 150 : 50)
          }}>
            <Text style={styles.cancelText}>Cancel</Text>
          </TouchableOpacity>
          <Text style={styles.formTitle}>{editingId ? 'Edit Schedule' : 'New Schedule'}</Text>
          <TouchableOpacity onPress={handleSubmit} disabled={saving}>
            {saving ? <ActivityIndicator size="small" color={c.text} /> : <Text style={styles.saveText}>Save</Text>}
          </TouchableOpacity>
        </View>

        <ScrollView
          style={styles.formBody}
          contentContainerStyle={styles.formContent}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="always"
        >
          <Text style={styles.fieldLabel}>DATE</Text>
          <TextInput
            style={styles.textInput}
            placeholder="YYYY-MM-DD"
            value={formData.eventDate}
            onChangeText={(text) => setFormData(prev => ({ ...prev, eventDate: text }))}
            placeholderTextColor={c.textMuted}
          />

          <Text style={[styles.fieldLabel, { marginTop: 18 }]}>TITLE</Text>
          <TextInput
            style={styles.textInput}
            placeholder="Sunday Worship Service"
            value={formData.title}
            onChangeText={(text) => setFormData(prev => ({ ...prev, title: text }))}
            placeholderTextColor={c.textMuted}
          />

          <View style={styles.assignmentSection}>
            <View style={styles.assignmentSectionHeader}>
              <Text style={styles.fieldLabel}>ROLES</Text>
              <TouchableOpacity
                style={styles.smallGhostBtn}
                onPress={() => setFormData(prev => ({ ...prev, assignments: [...prev.assignments, blankAssignment()] }))}
                activeOpacity={0.8}
              >
                <Ionicons name="add" size={14} color={c.text} />
                <Text style={styles.smallGhostText}>Add Role</Text>
              </TouchableOpacity>
            </View>

            {formData.assignments.map((assignment, index) => (
              <View key={index} style={styles.assignmentEditorCard}>
                <View style={styles.assignmentEditorTopRow}>
                  <Text style={styles.assignmentEditorIndex}>#{index + 1}</Text>
                  {formData.assignments.length > 1 && (
                    <TouchableOpacity
                      onPress={() => setFormData(prev => ({ ...prev, assignments: prev.assignments.filter((_, idx) => idx !== index) }))}
                      activeOpacity={0.75}
                    >
                      <Text style={styles.removeRoleText}>Remove</Text>
                    </TouchableOpacity>
                  )}
                </View>

                <View style={styles.presetRow}>
                  {DEFAULT_ROLES.map(roleLabel => (
                    <TouchableOpacity
                      key={roleLabel}
                      style={styles.presetChip}
                      onPress={() => setFormData(prev => {
                        const next = [...prev.assignments]
                        next[index] = { ...next[index], role: roleLabel }
                        return { ...prev, assignments: next }
                      })}
                      activeOpacity={0.75}
                    >
                      <Text style={styles.presetChipText}>{roleLabel}</Text>
                    </TouchableOpacity>
                  ))}
                </View>

                <TextInput
                  style={[styles.textInput, styles.assignmentInput]}
                  placeholder="Role"
                  value={assignment.role}
                  onChangeText={(text) => setFormData(prev => {
                    const next = [...prev.assignments]
                    next[index] = { ...next[index], role: text }
                    return { ...prev, assignments: next }
                  })}
                  placeholderTextColor={c.textMuted}
                />

                <TextInput
                  style={[styles.textInput, styles.assignmentInput]}
                  placeholder="Person"
                  value={assignment.person}
                  onChangeText={(text) => setFormData(prev => {
                    const next = [...prev.assignments]
                    next[index] = { ...next[index], person: text }
                    return { ...prev, assignments: next }
                  })}
                  placeholderTextColor={c.textMuted}
                />

                <TextInput
                  style={[styles.textInput, styles.assignmentInput]}
                  placeholder="Note (optional)"
                  value={assignment.note || ''}
                  onChangeText={(text) => setFormData(prev => {
                    const next = [...prev.assignments]
                    next[index] = { ...next[index], note: text }
                    return { ...prev, assignments: next }
                  })}
                  placeholderTextColor={c.textMuted}
                />
              </View>
            ))}
          </View>

          <RichTextField
            label="NOTES"
            placeholder="Add rehearsal notes or service details..."
            value={formData.notes}
            onChange={(text) => setFormData(prev => ({ ...prev, notes: text }))}
            height={240}
          />

          <Text style={styles.helperText}>
            Tip: select text in the notes field, then tap B, I, or U for bold, italic, or underline.
          </Text>
        </ScrollView>
      </View>
    </View>
  </KeyboardAvoidingView>
</Modal>

      <Modal visible={selectedEvent !== null} transparent animationType="fade" onRequestClose={() => setSelectedEvent(null)}>
        <View style={styles.detailOverlay}>
          <TouchableOpacity style={styles.detailBackdrop} activeOpacity={1} onPress={() => setSelectedEvent(null)} />
          <View style={styles.detailSheet}>
            <View style={styles.detailHandle} />
            <View style={styles.detailHeader}>
              <View style={styles.detailHeaderText}>
                <Text style={styles.detailEyebrow}>SCHEDULE</Text>
                <Text style={styles.detailTitle}>{selectedEvent?.title || 'Item'}</Text>
                <Text style={styles.detailDate}>{selectedEvent ? formatDisplayDate(selectedEvent.eventDate) : ''}</Text>
              </View>
              <TouchableOpacity onPress={() => setSelectedEvent(null)} style={styles.detailCloseBtn}>
                <Ionicons name="close" size={20} color={c.text} />
              </TouchableOpacity>
            </View>

            <ScrollView style={styles.detailBody} contentContainerStyle={styles.detailBodyContent} showsVerticalScrollIndicator={false}>
              {selectedEvent?.assignments.length ? (
                <View style={styles.detailBlock}>
                  <Text style={styles.detailLabel}>ROLES</Text>
                  {selectedEvent.assignments.map((assignment, index) => (
                    <View key={`${selectedEvent.id}-${index}`} style={styles.detailAssignmentRow}>
                      <Text style={styles.detailAssignmentRole}>{assignment.role}</Text>
                      <Text style={styles.detailAssignmentPerson}>{assignment.person || 'Unassigned'}</Text>
                      {assignment.note ? <Text style={styles.detailAssignmentNote}>{assignment.note}</Text> : null}
                    </View>
                  ))}
                </View>
              ) : null}

              {selectedEvent?.notes ? <RichTextPreview label="NOTES" value={selectedEvent.notes} /> : null}
            </ScrollView>

            {canManageCalendar && selectedEvent && (
              <View style={styles.detailActions}>
                <TouchableOpacity style={[styles.detailActionBtn, styles.detailActionSecondary]} onPress={() => openEditForm(selectedEvent)}>
                  <Ionicons name="pencil-outline" size={16} color={c.text} />
                  <Text style={styles.detailActionText}>Edit</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.detailActionBtn, styles.detailActionDestructive]} onPress={() => confirmDelete(selectedEvent)}>
                  <Ionicons name="trash-outline" size={16} color={c.accentText} />
                  <Text style={styles.detailActionTextDestructive}>Delete</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        </View>
      </Modal>
    </View>
  )
}

const makeStyles = (c: AppColors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.surfaceAlt },
  scroll: { flex: 1 },
  scrollContent: { padding: 16, paddingBottom: 120 },

  loadingWrap: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: c.surfaceAlt },

  hero: {
    backgroundColor: c.accent,
    borderRadius: 20,
    padding: 18,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 16,
  },
  eyebrow: { fontSize: 10, fontWeight: '800', letterSpacing: 2.5, color: c.accentText, marginBottom: 6 },
  title: { fontSize: 24, fontWeight: '800', color: c.accentText, letterSpacing: 0.2 },
  subtitle: { marginTop: 8, fontSize: 13, lineHeight: 19, color: c.accentText, maxWidth: '88%' },
  heroBadge: {
    minWidth: 70,
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 14,
    backgroundColor: c.surface,
  },
  heroBadgeText: { fontSize: 10, fontWeight: '800', letterSpacing: 1.2, color: c.text },

  monthCard: {
    backgroundColor: c.surface,
    borderRadius: 20,
    padding: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: c.border,
  },
  monthHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  monthNavBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: c.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  monthHeaderTextWrap: { alignItems: 'center', flex: 1, paddingHorizontal: 10 },
  monthLabel: { fontSize: 18, fontWeight: '800', color: c.text, letterSpacing: 0.2 },
  monthHint: { fontSize: 12, color: c.textMuted, marginTop: 3 },
  weekRow: { flexDirection: 'row', marginBottom: 8 },
  weekLabel: { flex: 1, textAlign: 'center', fontSize: 11, fontWeight: '700', color: c.textMuted, letterSpacing: 0.8 },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  dayCell: {
    width: '14.2857%',
    aspectRatio: 0.9,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    marginBottom: 6,
  },
  dayCellMuted: { opacity: 0.35 },
  dayCellSelected: { backgroundColor: c.accent },
  dayNumber: { fontSize: 14, fontWeight: '700', color: c.text },
  dayNumberMuted: { color: c.textMuted },
  dayNumberSelected: { color: c.accentText },
  eventDot: { marginTop: 6, width: 6, height: 6, borderRadius: 3, backgroundColor: c.accent },
  eventDotSelected: { backgroundColor: c.surface },
  todayBtn: {
    marginTop: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: c.surfaceAlt,
  },
  todayBtnText: { fontSize: 13, fontWeight: '700', color: c.text },

  sectionCard: {
    backgroundColor: c.surface,
    borderRadius: 18,
    padding: 16,
    borderWidth: 1,
    borderColor: c.border,
    marginBottom: 16,
  },
  sectionHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 10 },
  sectionAccentLine: { width: 3, height: 16, borderRadius: 1.5, backgroundColor: c.accent },
  sectionHeader: { fontSize: 12, fontWeight: '800', color: c.text, letterSpacing: 1.3 },
  selectedDayTitle: { fontSize: 18, fontWeight: '800', color: c.text },
  selectedDayMeta: { marginTop: 4, fontSize: 12, color: c.textMuted },

  eventsSection: { marginBottom: 8 },
  emptyState: {
    alignItems: 'center',
    padding: 24,
    backgroundColor: c.surface,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: c.border,
  },
  emptyTitle: { fontSize: 16, fontWeight: '700', color: c.textSub, marginTop: 10 },
  emptySubtitle: { fontSize: 13, color: c.textMuted, marginTop: 6, textAlign: 'center' },
  emptyAddBtn: {
    marginTop: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: c.accent,
  },
  emptyAddText: { color: c.accentText, fontSize: 13, fontWeight: '700' },
  eventCard: {
    backgroundColor: c.surface,
    borderRadius: 18,
    padding: 16,
    borderWidth: 1,
    borderColor: c.border,
    marginBottom: 12,
  },
  eventTopRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 },
  eventTitleWrap: { flex: 1 },
  eventTitle: { fontSize: 16, fontWeight: '800', color: c.text },
  eventDate: { marginTop: 4, fontSize: 12, color: c.textMuted },
  eventEditBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: c.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  assignmentList: { marginTop: 14, gap: 10 },
  assignmentRow: {
    borderRadius: 14,
    backgroundColor: c.surfaceAlt,
    borderWidth: 1,
    borderColor: c.hairline,
    padding: 12,
  },
  assignmentRole: { fontSize: 11, fontWeight: '800', color: c.text, letterSpacing: 0.8, textTransform: 'uppercase' },
  assignmentPerson: { marginTop: 5, fontSize: 14, fontWeight: '700', color: c.text },
  assignmentNote: { marginTop: 4, fontSize: 12, color: c.textMuted, lineHeight: 17 },
  assignmentEmpty: { fontSize: 13, color: c.textMuted, fontStyle: 'italic' },
  eventNotesPreview: { marginTop: 14, fontSize: 13, color: c.textSub, lineHeight: 19 },
  eventNotesPreviewWrap: {
    marginTop: 14,
    borderWidth: 1,
    borderColor: c.hairline,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: c.surfaceAlt,
    minHeight: 64,
  },
  eventNotesWebView: { backgroundColor: 'transparent', minHeight: 64, maxHeight: 160 },
  addMoreBtn: {
    marginTop: 4,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
  },
  addMoreText: { fontSize: 13, fontWeight: '700', color: c.text },

  devotionFab: {
    position: 'absolute',
    right: 21,
    bottom: 90,
    width: 50,
    height: 50,
    borderRadius: 25,
    backgroundColor: c.surface,
    borderWidth: 1.5,
    borderColor: c.border,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: c.shadow,
    shadowOpacity: 0.12,
    shadowRadius: 8,
    elevation: 4,
  },
  fab: {
    position: 'absolute',
    right: 18,
    bottom: 24,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: c.accent,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: c.shadow,
    shadowOpacity: 0.2,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 7,
  },

  modalOverlay: { flex: 1, backgroundColor: c.accent, justifyContent: 'flex-end' },
  formSheet: { flex: 1, width: '100%', backgroundColor: c.surface, borderTopLeftRadius: 22, borderTopRightRadius: 22 },
  formHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: c.hairline,
  },
  formTitle: { fontSize: 15, fontWeight: '800', color: c.text },
  cancelText: { fontSize: 14, color: c.textMuted, fontWeight: '600' },
  saveText: { fontSize: 14, color: c.text, fontWeight: '800' },
  formBody: { flex: 1 },
  formContent: { padding: 16, paddingBottom: 40 },
  fieldLabel: { fontSize: 11, fontWeight: '800', color: c.textMuted, letterSpacing: 1.2, marginBottom: 8 },
  textInput: {
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 14,
    color: c.text,
    backgroundColor: c.surfaceAlt,
  },
  assignmentSection: { marginTop: 18 },
  assignmentSectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  smallGhostBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: c.surfaceAlt,
  },
  smallGhostText: { fontSize: 12, fontWeight: '700', color: c.text },
  assignmentEditorCard: {
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.hairline,
    borderRadius: 16,
    padding: 12,
    marginBottom: 12,
  },
  assignmentEditorTopRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  assignmentEditorIndex: { fontSize: 11, fontWeight: '800', color: c.textMuted },
  removeRoleText: { fontSize: 12, fontWeight: '700', color: c.danger },
  presetRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 10 },
  presetChip: {
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: c.surfaceAlt,
    borderWidth: 1,
    borderColor: c.hairline,
  },
  presetChipText: { fontSize: 11, fontWeight: '700', color: c.text },
  assignmentInput: { marginTop: 8 },
  helperText: { marginTop: 14, fontSize: 12, color: c.textMuted, lineHeight: 18 },

  richField: { marginTop: 18 },
  richEditorWrap: { borderWidth: 1, borderColor: c.border, borderRadius: 12, overflow: 'hidden', backgroundColor: c.surfaceAlt },
  richEditorWebView: { backgroundColor: 'transparent' },
  richToolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 10,
    flexWrap: 'wrap',
  },
  richToolBtn: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: c.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  richToolBtnText: { fontSize: 15, fontWeight: '800', color: c.text },
  richToolItalic: { fontStyle: 'italic' },
  richToolUnderline: { textDecorationLine: 'underline' },
  richToolbarHint: { fontSize: 12, color: c.textMuted, flexShrink: 1 },

  detailOverlay: { flex: 1, backgroundColor: c.accent, justifyContent: 'flex-end' },
  detailBackdrop: { ...StyleSheet.absoluteFill },
  detailSheet: { flex: 1, width: '100%', backgroundColor: c.surface, borderTopLeftRadius: 22, borderTopRightRadius: 22 },
  detailHandle: { width: 44, height: 4, borderRadius: 2, backgroundColor: c.surfaceMuted, alignSelf: 'center', marginTop: 10 },
  detailHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: c.hairline,
    gap: 12,
  },
  detailHeaderText: { flex: 1 },
  detailEyebrow: { fontSize: 10, fontWeight: '800', letterSpacing: 2.4, color: c.textMuted, marginBottom: 5 },
  detailTitle: { fontSize: 18, fontWeight: '800', color: c.text },
  detailDate: { marginTop: 4, fontSize: 12, color: c.textMuted },
  detailCloseBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: c.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  detailBody: { flex: 1 },
  detailBodyContent: { padding: 16, paddingBottom: 30 },
  detailBlock: { marginBottom: 16 },
  detailLabel: { fontSize: 11, fontWeight: '800', color: c.textMuted, letterSpacing: 1.2, marginBottom: 10 },
  detailRichPreviewWrap: { borderWidth: 1, borderColor: c.border, borderRadius: 12, overflow: 'hidden', minHeight: 160, backgroundColor: c.surfaceAlt },
  detailRichPreview: { backgroundColor: 'transparent', minHeight: 160 },
  detailAssignmentRow: {
    borderWidth: 1,
    borderColor: c.hairline,
    borderRadius: 14,
    padding: 12,
    backgroundColor: c.surfaceAlt,
    marginBottom: 10,
  },
  detailAssignmentRole: { fontSize: 11, fontWeight: '800', color: c.text, letterSpacing: 0.8, textTransform: 'uppercase' },
  detailAssignmentPerson: { marginTop: 5, fontSize: 14, fontWeight: '700', color: c.text },
  detailAssignmentNote: { marginTop: 4, fontSize: 12, color: c.textMuted, lineHeight: 17 },
  detailActions: {
    flexDirection: 'row',
    gap: 10,
    padding: 16,
    borderTopWidth: 1,
    borderTopColor: c.hairline,
  },
  detailActionBtn: {
    flex: 1,
    height: 46,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  detailActionSecondary: { backgroundColor: c.surfaceAlt },
  detailActionDestructive: { backgroundColor: c.accent },
  detailActionText: { fontSize: 13, fontWeight: '700', color: c.text },
  detailActionTextDestructive: { fontSize: 13, fontWeight: '700', color: c.accentText },
})
