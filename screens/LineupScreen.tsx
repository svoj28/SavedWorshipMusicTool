import React, { useCallback, useEffect, useRef, useState , useMemo} from 'react'
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
  StatusBar,
  Linking,
  RefreshControl,
  KeyboardAvoidingView,
  Platform,
   Keyboard
} from 'react-native'
import { useAppTheme, type AppColors } from '../lib/theme'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import Ionicons from '@expo/vector-icons/Ionicons'
import { WebView } from '../components/EngineWebView'
import YoutubePlayer from 'react-native-youtube-iframe'
import { getCurrentUser } from '../lib/auth'
import {
  createLineup,
  createLineupItem,
  deleteLineup,
  deleteLineupItem,
  getAllLineups,
  getAllLineupItems,
  updateLineup,
  updateLineupItem,
} from '../db/queries'
import { Lineup, LineupItem } from '../db/models'
import { useRole } from '../lib/useRole'
import { notifyManagementChangeToAllUsers } from '../lib/notifications'
import { onTableChange } from '../lib/sync'
import { supabase } from '../lib/supabase'
import { usePullToRefresh } from '../lib/usePullToRefresh'

type Category = 'joyful' | 'solemn' | 'victory' | 'any'

type LineupDraftItem = {
  id: string
  artist: string
  songTitle: string
  key: string
  versionUrl: string
  category: Category
}

interface LineupFormData {
  title: string
  description: string
  items: LineupDraftItem[]
}

function extractYouTubeId(url: string): string | null {
  if (!url) return null
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
  ]
  for (const pattern of patterns) {
    const match = url.match(pattern)
    if (match) return match[1]
  }
  return null
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
      color: #101010;
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
      color: #999999;
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
  height = 220,
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
        <TouchableOpacity style={styles.richToolBtn} onPressIn={() => webViewRef.current?.injectJavaScript('window.__focusEditor(); true;')} onPress={() => applyFormat('bold')} activeOpacity={0.75}>
          <Text style={styles.richToolBtnText}>B</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.richToolBtn} onPressIn={() => webViewRef.current?.injectJavaScript('window.__focusEditor(); true;')} onPress={() => applyFormat('italic')} activeOpacity={0.75}>
          <Text style={[styles.richToolBtnText, styles.richToolItalic]}>I</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.richToolBtn} onPressIn={() => webViewRef.current?.injectJavaScript('window.__focusEditor(); true;')} onPress={() => applyFormat('underline')} activeOpacity={0.75}>
          <Text style={[styles.richToolBtnText, styles.richToolUnderline]}>U</Text>
        </TouchableOpacity>
        <Text style={styles.richToolbarHint}>Highlight text, then tap a style</Text>
      </View>
    </View>
  )
}

function RichTextBlock({ label, value }: { label: string; value: string }) {
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

function categoryLabel(category?: Category): string {
  switch (category) {
    case 'joyful':
      return 'Joyful'
    case 'solemn':
      return 'Solemn'
    case 'victory':
      return 'Victory Song'
    default:
      return 'Any'
  }
}

function createDraftItem(seed?: Partial<LineupDraftItem>): LineupDraftItem {
  return {
    id: seed?.id || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    artist: seed?.artist || '',
    songTitle: seed?.songTitle || '',
    key: seed?.key || '',
    versionUrl: seed?.versionUrl || '',
    category: seed?.category || 'any',
  }
}

export default function LineupScreen() {
  const { colors: c } = useAppTheme()
  const styles = useMemo(() => makeStyles(c), [c])

  const { canManageContent } = useRole()
   const insets = useSafeAreaInsets()
  const [userId, setUserId] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [lineups, setLineups] = useState<Lineup[]>([])
  const [lineupItemsById, setLineupItemsById] = useState<Record<string, LineupItem[]>>({})
  const [selectedLineup, setSelectedLineup] = useState<Lineup | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [formData, setFormData] = useState<LineupFormData>({ title: '', description: '', items: [createDraftItem()] })
  const [lineupChangedAt, setLineupChangedAt] = useState(0)
  

  const groupItems = useCallback((items: LineupItem[]) => {
    const grouped: Record<string, LineupItem[]> = {}
    for (const item of items) {
      if (!grouped[item.lineupId]) grouped[item.lineupId] = []
      grouped[item.lineupId].push(item)
    }
    return grouped
  }, [])

  const refreshData = useCallback(async (options: { silent?: boolean } = {}) => {
    if (!options.silent) setLoading(true)
    try {
      const [lineupData, lineupItemData] = await Promise.all([getAllLineups(), getAllLineupItems()])
      const groupedItems = groupItems(lineupItemData)
      setLineups(lineupData.map(lineup => ({ ...lineup, items: groupedItems[lineup.id] || [] })))
      setLineupItemsById(groupedItems)
      setLineupChangedAt(Date.now())
    } catch (error) {
      console.error('Error loading lineups:', error)
    } finally {
      if (!options.silent) setLoading(false)
    }
  }, [groupItems])

  const { refreshing, onRefresh } = usePullToRefresh(() => refreshData({ silent: true }))

  useEffect(() => {
    const loadUser = async () => {
      const user = await getCurrentUser()
      if (user) setUserId(user.id)
    }
    void loadUser()
    void refreshData()
  }, [refreshData])

  useEffect(() => {
    const unsubLineups = onTableChange('lineups', () => void refreshData({ silent: true }))
    const unsubLineupItems = onTableChange('lineup_items', () => void refreshData({ silent: true }))

    const lineupsChannel = supabase
      .channel('lineups-public')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'lineups' }, () => {
        void refreshData({ silent: true })
      })
      .subscribe()

    const lineupItemsChannel = supabase
      .channel('lineup-items-public')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'lineup_items' }, () => {
        void refreshData({ silent: true })
      })
      .subscribe()

    return () => {
      unsubLineups()
      unsubLineupItems()
      supabase.removeChannel(lineupsChannel)
      supabase.removeChannel(lineupItemsChannel)
    }
  }, [refreshData])

  useEffect(() => {
    if (selectedLineup) {
      const updated = lineups.find(lineup => lineup.id === selectedLineup.id) || null
      setSelectedLineup(updated)
    }
  }, [lineups, selectedLineup?.id, lineupChangedAt])

  const openCreateForm = () => {
    if (!canManageContent) {
      Alert.alert('Access denied', 'Only admins or managers can manage lineups.')
      return
    }
    setEditingId(null)
    setFormData({ title: '', description: '', items: [createDraftItem()] })
    setShowForm(true)
  }

  const openEditForm = (lineup: Lineup) => {
    if (!canManageContent) {
      Alert.alert('Access denied', 'Only admins or managers can manage lineups.')
      return
    }
    setEditingId(lineup.id)
    setFormData({
      title: lineup.title,
      description: lineup.description || '',
      items: (lineup.items || []).length > 0
        ? lineup.items!.map(item => createDraftItem({
            id: item.id,
            artist: item.artist,
            songTitle: item.songTitle,
            key: item.key || '',
            versionUrl: item.versionUrl || '',
            category: item.category || 'any',
          }))
        : [createDraftItem()],
    })
    setShowForm(true)
  }

  const addDraftItem = () => {
    setFormData(prev => ({ ...prev, items: [...prev.items, createDraftItem()] }))
  }

  const updateDraftItem = (id: string, patch: Partial<LineupDraftItem>) => {
    setFormData(prev => ({
      ...prev,
      items: prev.items.map(item => item.id === id ? { ...item, ...patch } : item),
    }))
  }

  const removeDraftItem = (id: string) => {
    setFormData(prev => {
      const remaining = prev.items.filter(item => item.id !== id)
      return { ...prev, items: remaining.length > 0 ? remaining : [createDraftItem()] }
    })
  }

 const submitLineup = async () => {
    if (!canManageContent) {
      Alert.alert('Access denied', 'Only admins or managers can manage lineups.')
      return
    }
    if (saving || deletingId) return

    let activeUserId = userId
    if (!activeUserId) {
      const currentUser = await getCurrentUser()
      if (!currentUser) {
        Alert.alert('Error', 'Could not verify your account. Please try again.')
        return
      }
      activeUserId = currentUser.id
      setUserId(activeUserId)
    }

    const title = formData.title.trim()
    if (!title) {
      Alert.alert('Error', 'Please enter a lineup title')
      return
    }

    const validItems = formData.items
      .map((item, index) => ({ ...item, position: index + 1 }))
      .filter(item => item.artist.trim() || item.songTitle.trim() || item.versionUrl.trim() || item.key.trim())

    if (validItems.length === 0) {
      Alert.alert('Error', 'Please add at least one song')
      return
    }

    if (validItems.some(item => !item.artist.trim() || !item.songTitle.trim())) {
      Alert.alert('Error', 'Each song needs at least an artist and a song title')
      return
    }

    setSaving(true)
    try {
      const now = Date.now()
      const cleanDescription = formData.description || ''

      if (editingId) {
        await updateLineup(editingId, { title, description: cleanDescription, updatedAt: now })
        const oldItems = lineupItemsById[editingId] || []
        await Promise.all(oldItems.map(item => deleteLineupItem(item.id)))
        await Promise.all(validItems.map(item => createLineupItem({
          lineupId: editingId,
          userId: activeUserId,
          position: item.position,
          artist: item.artist.trim(),
          songTitle: item.songTitle.trim(),
          key: item.key.trim(),
          versionUrl: item.versionUrl.trim(),
          category: item.category,
          createdAt: now,
          updatedAt: now,
          synced: false,
        })))
        void notifyManagementChangeToAllUsers(activeUserId, 'updated', 'Lineup', title)
      } else {
        const created = await createLineup({
          title,
          description: cleanDescription,
          userId: activeUserId,
          createdAt: now,
          updatedAt: now,
          synced: false,
        })
        await Promise.all(validItems.map(item => createLineupItem({
          lineupId: created.id,
          userId: activeUserId,
          position: item.position,
          artist: item.artist.trim(),
          songTitle: item.songTitle.trim(),
          key: item.key.trim(),
          versionUrl: item.versionUrl.trim(),
          category: item.category,
          createdAt: now,
          updatedAt: now,
          synced: false,
        })))
        void notifyManagementChangeToAllUsers(activeUserId, 'created', 'Lineup', title)
      }

      Keyboard.dismiss()
      await new Promise(res => setTimeout(res, 50))
      setShowForm(false)
      setEditingId(null)
      setFormData({ title: '', description: '', items: [createDraftItem()] })
      await refreshData({ silent: true })
    } catch (error) {
      Alert.alert('Error', 'Failed to save lineup')
    } finally {
      setSaving(false)
    }
  }

  const confirmDelete = (lineup: Lineup) => {
    if (!canManageContent) {
      Alert.alert('Access denied', 'Only admins or managers can manage lineups.')
      return
    }
    if (saving || deletingId) return

    const activeUserId = userId
    if (!activeUserId) {
      Alert.alert('Error', 'Could not verify your account. Please try again.')
      return
    }

    Alert.alert('Delete Lineup', 'This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          setDeletingId(lineup.id)
          try {
            await deleteLineup(lineup.id)
            void notifyManagementChangeToAllUsers(userId, 'deleted', 'Lineup', lineup.title)
            await refreshData({ silent: true })
          } catch (error) {
            Alert.alert('Error', 'Failed to delete lineup')
          } finally {
            setDeletingId(null)
          }
        },
      },
    ])
  }

  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor={c.surface} />

      <View style={styles.header}>
        <View>
          <Text style={styles.eyebrow}>WORSHIP FLOW</Text>
          <Text style={styles.title}>Lineups</Text>
        </View>
        {canManageContent ? (
          <TouchableOpacity style={styles.primaryAction} onPress={openCreateForm} activeOpacity={0.8}>
            <Ionicons name="add" size={18} color={c.accentText} />
            <Text style={styles.primaryActionText}>New Lineup</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      {loading ? (
        <View style={styles.centerContent}>
          <ActivityIndicator size="large" color={c.text} />
        </View>
      ) : lineups.length === 0 ? (
        <View style={styles.emptyState}>
          <View style={styles.emptyIconWrap}>
            <Ionicons name="list-outline" size={30} color={c.text} />
          </View>
          <Text style={styles.emptyTitle}>No lineups yet</Text>
          <Text style={styles.emptySubtitle}>
            {canManageContent ? 'Create a lineup with multiple songs, preview links, and categories.' : 'Lineups will appear here when they are posted.'}
          </Text>
          {canManageContent ? (
            <TouchableOpacity style={styles.emptyCta} onPress={openCreateForm} activeOpacity={0.85}>
              <Text style={styles.emptyCtaText}>Create First Lineup</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={[styles.listContent, { paddingBottom: insets.bottom + 40 }]}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          showsVerticalScrollIndicator={false}
        >
          {lineups.map((lineup, index) => {
            const items = lineup.items || []
            return (
              <TouchableOpacity
                key={lineup.id}
                style={styles.lineupCard}
                onPress={() => setSelectedLineup(lineup)}
                activeOpacity={0.76}
              >
                <View style={styles.cardTopRow}>
                  <View>
                    <Text style={styles.cardIndex}>SET {String(index + 1).padStart(2, '0')}</Text>
                    <Text style={styles.cardTitle}>{lineup.title}</Text>
                  </View>
                  <View style={styles.cardCountPill}>
                    <Text style={styles.cardCountPillText}>{items.length} songs</Text>
                  </View>
                </View>

                {lineup.description ? (
                  <Text style={styles.cardDescription} numberOfLines={3}>
                    {stripHtml(lineup.description)}
                  </Text>
                ) : null}

                <View style={styles.songStack}>
                  {items.slice(0, 3).map((item) => (
                    <View key={item.id} style={styles.songRow}>
                      <View style={styles.songDot} />
                      <View style={styles.songMeta}>
                        <Text style={styles.songName}>{item.songTitle}</Text>
                        <Text style={styles.songSubMeta} numberOfLines={1}>
                          {item.artist}{item.key ? ` • Key ${item.key}` : ''}{item.category ? ` • ${categoryLabel(item.category)}` : ''}
                        </Text>
                      </View>
                    </View>
                  ))}
                  {items.length > 3 ? <Text style={styles.moreText}>+{items.length - 3} more songs</Text> : null}
                </View>

                {canManageContent ? (
                  <View style={styles.cardActions}>
                    <TouchableOpacity style={styles.cardActionBtn} onPress={() => openEditForm(lineup)} activeOpacity={0.75}>
                      <Ionicons name="pencil-outline" size={15} color={c.text} />
                      <Text style={styles.cardActionText}>Edit</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={[styles.cardActionBtn, styles.cardActionBtnDanger]} onPress={() => confirmDelete(lineup)} activeOpacity={0.75}>
                      <Ionicons name="trash-outline" size={15} color={c.text} />
                      <Text style={[styles.cardActionText, styles.cardActionTextDanger]}>Delete</Text>
                    </TouchableOpacity>
                  </View>
                ) : null}
              </TouchableOpacity>
            )
          })}
        </ScrollView>
      )}

      <Modal visible={showForm} transparent animationType="slide" onRequestClose={() => setShowForm(false)}>
        <KeyboardAvoidingView
          style={styles.formOverlay}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          keyboardVerticalOffset={0}
        >
          <View style={[styles.formSheet, { paddingBottom: Math.max(insets.bottom, 16) }]}>
            <View style={styles.formHead}>
              <TouchableOpacity onPress={() => {
                  Keyboard.dismiss()
                  setTimeout(() => setShowForm(false), 50)
                }}>
                <Text style={styles.formCancel}>Cancel</Text>
              </TouchableOpacity>
              <Text style={styles.formTitle}>{editingId ? 'Edit Lineup' : 'Add Lineup'}</Text>
              <TouchableOpacity onPress={submitLineup} style={[styles.formSaveBtn, (saving || !!deletingId) && styles.formSaveBtnDisabled]} disabled={saving || !!deletingId}>
                {saving ? <ActivityIndicator size="small" color={c.accentText} /> : <Text style={styles.formSave}>Save</Text>}
              </TouchableOpacity>
            </View>

            <ScrollView style={styles.formBody} contentContainerStyle={styles.formBodyContent} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="always" keyboardDismissMode="on-drag">
              <Text style={styles.fieldLabel}>LINEUP TITLE</Text>
              <TextInput
                style={styles.textInput}
                placeholder="Enter lineup title…"
                placeholderTextColor={c.textMuted}
                value={formData.title}
                onChangeText={(text) => setFormData(prev => ({ ...prev, title: text }))}
              />

              <RichTextField
                label="DESCRIPTION"
                placeholder="Optional lineup description…"
                value={formData.description}
                onChange={(text) => setFormData(prev => ({ ...prev, description: text }))}
                height={180}
              />

              <View style={styles.sectionDivider} />
              <View style={styles.songHeaderRow}>
                <View>
                  <Text style={styles.fieldLabel}>SONGS</Text>
                  <Text style={styles.songHeaderHint}>Add multiple songs with version links and live previews.</Text>
                </View>
                <TouchableOpacity style={styles.inlineAddBtn} onPress={addDraftItem} activeOpacity={0.8}>
                  <Ionicons name="add" size={16} color={c.text} />
                  <Text style={styles.inlineAddBtnText}>Add Song</Text>
                </TouchableOpacity>
              </View>

              {formData.items.map((item, index) => {
                const youtubeId = extractYouTubeId(item.versionUrl)
                return (
                  <View key={item.id} style={styles.songEditorCard}>
                    <View style={styles.songEditorHead}>
                      <Text style={styles.songEditorIndex}>Song {index + 1}</Text>
                      <TouchableOpacity onPress={() => removeDraftItem(item.id)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                        <Ionicons name="close-circle" size={20} color={c.textSub} />
                      </TouchableOpacity>
                    </View>

                    <Text style={styles.fieldLabel}>ARTIST</Text>
                    <TextInput
                      style={styles.textInput}
                      placeholder="Artist name"
                      placeholderTextColor={c.textMuted}
                      value={item.artist}
                      onChangeText={(text) => updateDraftItem(item.id, { artist: text })}
                    />

                    <Text style={styles.fieldLabel}>SONG TITLE</Text>
                    <TextInput
                      style={styles.textInput}
                      placeholder="Song title"
                      placeholderTextColor={c.textMuted}
                      value={item.songTitle}
                      onChangeText={(text) => updateDraftItem(item.id, { songTitle: text })}
                    />

                    <View style={styles.songInlineRow}>
                      <View style={styles.songInlineCol}>
                        <Text style={styles.fieldLabel}>KEY</Text>
                        <TextInput
                          style={styles.textInput}
                          placeholder="C, D, Eb…"
                          placeholderTextColor={c.textMuted}
                          value={item.key}
                          onChangeText={(text) => updateDraftItem(item.id, { key: text })}
                        />
                      </View>
                      <View style={styles.songInlineCol}>
                        <Text style={styles.fieldLabel}>CATEGORY</Text>
                        <View style={styles.categoryWrap}>
                          {(['joyful', 'solemn', 'victory', 'any'] as Category[]).map((category) => {
                            const isActive = item.category === category
                            return (
                              <TouchableOpacity
                                key={category}
                                style={[styles.categoryChip, isActive && styles.categoryChipActive]}
                                onPress={() => updateDraftItem(item.id, { category })}
                                activeOpacity={0.8}
                              >
                                <Text style={[styles.categoryChipText, isActive && styles.categoryChipTextActive]}>{categoryLabel(category)}</Text>
                              </TouchableOpacity>
                            )
                          })}
                        </View>
                      </View>
                    </View>

                    <Text style={styles.fieldLabel}>VERSION LINK</Text>
                    <TextInput
                      style={styles.textInput}
                      placeholder="https://youtube.com/watch?v=…"
                      placeholderTextColor={c.textMuted}
                      value={item.versionUrl}
                      onChangeText={(text) => updateDraftItem(item.id, { versionUrl: text })}
                      autoCapitalize="none"
                      keyboardType="url"
                    />

                    {youtubeId ? (
                      <View style={styles.previewCard}>
                        <Text style={styles.previewLabel}>VIDEO PREVIEW</Text>
                        <YoutubePlayer height={160} videoId={youtubeId} play={false} />
                        <TouchableOpacity
                          style={styles.previewOpenBtn}
                          onPress={() => {
                            const url = /^https?:\/\//i.test(item.versionUrl) ? item.versionUrl : `https://${item.versionUrl}`
                            Linking.openURL(url).catch(() => Alert.alert('Error', 'Could not open YouTube'))
                          }}
                          activeOpacity={0.75}
                        >
                          <Ionicons name="logo-youtube" size={14} color={c.danger} />
                          <Text style={styles.previewOpenBtnText}>Open version link</Text>
                        </TouchableOpacity>
                      </View>
                    ) : null}
                  </View>
                )
              })}

              <View style={{ height: 24 }} />
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <Modal visible={selectedLineup !== null} transparent animationType="fade" onRequestClose={() => setSelectedLineup(null)}>
        <View style={styles.detailOverlay}>
          <TouchableOpacity style={styles.detailBackdrop} activeOpacity={1} onPress={() => setSelectedLineup(null)} />
          <View style={[styles.detailSheet, { paddingBottom: Math.max(insets.bottom, 12) }]}>
            <View style={styles.detailHandle} />
            <View style={styles.detailHead}>
              <View style={styles.detailHeadTextWrap}>
                <Text style={styles.detailEyebrow}>LINEUP</Text>
                <Text style={styles.detailTitle}>{selectedLineup?.title || 'Lineup'}</Text>
              </View>
              <TouchableOpacity onPress={() => setSelectedLineup(null)} style={styles.detailCloseBtn}>
                <Ionicons name="close" size={20} color={c.text} />
              </TouchableOpacity>
            </View>

            <ScrollView style={styles.detailBody} contentContainerStyle={styles.detailBodyContent} showsVerticalScrollIndicator={false}>
              {selectedLineup?.description ? <RichTextBlock label="DESCRIPTION" value={selectedLineup.description} /> : null}

              {(selectedLineup?.items || []).map((item, index) => {
                const videoId = extractYouTubeId(item.versionUrl || '')
                return (
                  <View key={item.id} style={styles.detailSongCard}>
                    <Text style={styles.detailSongIndex}>Song {index + 1}</Text>
                    <Text style={styles.detailSongTitle}>{item.songTitle}</Text>
                    <Text style={styles.detailSongMeta}>{item.artist}{item.key ? ` • Key ${item.key}` : ''}</Text>
                    <View style={styles.detailChipRow}>
                      <View style={styles.detailChip}><Text style={styles.detailChipText}>{categoryLabel(item.category)}</Text></View>
                    </View>

                    {item.versionUrl ? (
                      <View style={styles.detailBlock}>
                        <Text style={styles.detailLabel}>VERSION</Text>
                        {videoId ? (
                          <View style={styles.detailYoutubeWrap}>
                            <YoutubePlayer height={180} videoId={videoId} play={false} />
                            <TouchableOpacity
                              style={styles.detailOpenYoutubeBtn}
                              onPress={() => {
                                const url = /^https?:\/\//i.test(item.versionUrl) ? item.versionUrl : `https://${item.versionUrl}`
                                Linking.openURL(url).catch(() => Alert.alert('Error', 'Could not open YouTube'))
                              }}
                              activeOpacity={0.7}
                            >
                              <Ionicons name="logo-youtube" size={14} color={c.danger} />
                              <Text style={styles.detailOpenYoutubeBtnText}>Open in YouTube</Text>
                              <Ionicons name="open-outline" size={13} color={c.textMuted} />
                            </TouchableOpacity>
                          </View>
                        ) : (
                          <Text style={styles.detailMonoText}>{item.versionUrl}</Text>
                        )}
                      </View>
                    ) : null}
                  </View>
                )
              })}
            </ScrollView>

            {canManageContent && selectedLineup ? (
              <View style={styles.detailActions}>
                <TouchableOpacity style={[styles.detailActionBtn, styles.detailActionBtnSecondary]} onPress={() => { const lineup = selectedLineup; setSelectedLineup(null); openEditForm(lineup) }}>
                  <Ionicons name="pencil-outline" size={16} color={c.text} />
                  <Text style={styles.detailActionBtnText}>Edit</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.detailActionBtn, styles.detailActionBtnDestructive]} onPress={() => { const lineup = selectedLineup; setSelectedLineup(null); confirmDelete(lineup) }}>
                  <Ionicons name="trash-outline" size={16} color={c.accentText} />
                  <Text style={styles.detailActionBtnTextDestructive}>Delete</Text>
                </TouchableOpacity>
              </View>
            ) : null}
          </View>
        </View>
      </Modal>

      {(loading || saving || deletingId) ? (
        <View style={styles.busyOverlay} pointerEvents="auto">
          <View style={styles.busyCard}>
            <ActivityIndicator size="large" color={c.text} />
          </View>
        </View>
      ) : null}
    </View>
  )
}

const makeStyles = (c: AppColors) => StyleSheet.create({
  // ─── Layout ────────────────────────────────────────────────────────────────
  container: { flex: 1, backgroundColor: c.surface },
  header: {
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  centerContent: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  // ─── Header ────────────────────────────────────────────────────────────────
  eyebrow: { fontSize: 11, letterSpacing: 2, color: c.textSub, fontWeight: '800' },
  title: { fontSize: 32, lineHeight: 36, fontWeight: '900', color: c.text, marginTop: 4 },
  primaryAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: c.accent,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 18,
    flexShrink: 1,
    maxWidth: '52%',
  },
  primaryActionText: { color: c.accentText, fontSize: 13, fontWeight: '800', flexShrink: 1 },

  // ─── Empty state ───────────────────────────────────────────────────────────
  emptyState: {
    marginHorizontal: 20,
    marginTop: 24,
    padding: 24,
    borderRadius: 28,
    backgroundColor: c.surface,
    alignItems: 'center',
    shadowColor: c.shadow,
    shadowOpacity: 0.06,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 10 },
    elevation: 2,
    borderWidth: 1,
    borderColor: c.border,
  },
  emptyIconWrap: {
    width: 64,
    height: 64,
    borderRadius: 20,
    backgroundColor: c.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14,
  },
  emptyTitle: { fontSize: 19, fontWeight: '800', color: c.text },
  emptySubtitle: { marginTop: 8, fontSize: 14, lineHeight: 20, color: c.textSub, textAlign: 'center' },
  emptyCta: {
    marginTop: 18,
    backgroundColor: c.accent,
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  emptyCtaText: { color: c.accentText, fontWeight: '800', fontSize: 13 },

  // ─── List ──────────────────────────────────────────────────────────────────
  listContent: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 40, gap: 14 },

  // ─── Lineup card ───────────────────────────────────────────────────────────
  lineupCard: {
    backgroundColor: c.surface,
    borderRadius: 28,
    padding: 18,
    shadowColor: c.shadow,
    shadowOpacity: 0.05,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 10 },
    elevation: 2,
    borderWidth: 1,
    borderColor: c.border,
  },
  cardTopRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 },
  cardIndex: { fontSize: 11, letterSpacing: 1.4, color: c.textMuted, fontWeight: '800' },
  cardTitle: { fontSize: 22, lineHeight: 26, color: c.text, fontWeight: '900', marginTop: 4 },
  cardCountPill: { backgroundColor: c.surfaceAlt, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 8 },
  cardCountPillText: { color: c.textSub, fontSize: 12, fontWeight: '800' },
  cardDescription: { marginTop: 12, color: c.textMuted, fontSize: 14, lineHeight: 21 },

  // ─── Song stack ────────────────────────────────────────────────────────────
  songStack: { marginTop: 16, gap: 10 },
  songRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  songDot: { width: 10, height: 10, borderRadius: 999, marginTop: 5, backgroundColor: c.textSub },
  songMeta: { flex: 1 },
  songName: { color: c.text, fontSize: 15, fontWeight: '800' },
  songSubMeta: { color: c.textMuted, fontSize: 12, marginTop: 2 },
  moreText: { color: c.textSub, fontSize: 12, fontWeight: '700', marginTop: 2 },

  // ─── Card actions ──────────────────────────────────────────────────────────
  cardActions: { marginTop: 16, flexDirection: 'row', gap: 10 },
  cardActionBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 16,
    paddingVertical: 12,
    backgroundColor: c.surfaceAlt,
  },
  cardActionBtnDanger: { backgroundColor: c.surfaceMuted, borderWidth: 1, borderColor: c.border },
  cardActionText: { fontSize: 13, fontWeight: '800', color: c.text },
  cardActionTextDanger: { color: c.text },

  // ─── Form modal ────────────────────────────────────────────────────────────
  formOverlay: { flex: 1, backgroundColor: c.accent, justifyContent: 'flex-end' },
  formSheet: { backgroundColor: c.surface, borderTopLeftRadius: 28, borderTopRightRadius: 28, maxHeight: '94%' },
  formHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 18, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: c.hairline },
  formCancel: { color: c.text, fontSize: 14, fontWeight: '700' },
  formTitle: { color: c.text, fontSize: 16, fontWeight: '900' },
  formSaveBtn: { backgroundColor: c.accent, borderRadius: 14, paddingHorizontal: 16, paddingVertical: 10, minWidth: 74, alignItems: 'center' },
  formSaveBtnDisabled: { opacity: 0.45 },
  formSave: { color: c.accentText, fontWeight: '800', fontSize: 13 },
  formBody: { maxHeight: '100%' },
  formBodyContent: { paddingHorizontal: 18, paddingBottom: 24 },

  // ─── Form fields ───────────────────────────────────────────────────────────
  fieldLabel: { color: c.textSub, fontSize: 11, letterSpacing: 1.6, fontWeight: '800', marginTop: 16, marginBottom: 8 },
  textInput: {
    backgroundColor: c.surface,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: c.border,
    paddingHorizontal: 14,
    paddingVertical: 13,
    fontSize: 15,
    color: c.text,
  },

  // ─── Rich text editor ──────────────────────────────────────────────────────
  richField: { marginTop: 6 },
  richEditorWrap: { borderRadius: 20, overflow: 'hidden', backgroundColor: c.surface, borderWidth: 1, borderColor: c.border },
  richEditorWebView: { backgroundColor: 'transparent' },
  richToolbar: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10 },
  richToolBtn: { width: 34, height: 34, borderRadius: 12, backgroundColor: c.surfaceAlt, alignItems: 'center', justifyContent: 'center' },
  richToolBtnText: { color: c.text, fontSize: 15, fontWeight: '900' },
  richToolItalic: { fontStyle: 'italic' },
  richToolUnderline: { textDecorationLine: 'underline' },
  richToolbarHint: { color: c.textMuted, fontSize: 12, marginLeft: 8, flex: 1 },

  // ─── Songs section ─────────────────────────────────────────────────────────
  sectionDivider: { height: 1, backgroundColor: c.surfaceMuted, marginTop: 22, marginBottom: 8 },
  songHeaderRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' },
  songHeaderHint: { color: c.textMuted, fontSize: 12, marginTop: 2, flexShrink: 1 },
  inlineAddBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: c.surfaceAlt,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 14,
    alignSelf: 'flex-start',
    flexShrink: 0,
  },
  inlineAddBtnText: { color: c.text, fontWeight: '800', fontSize: 13 },

  // ─── Song editor card ──────────────────────────────────────────────────────
  songEditorCard: { marginTop: 14, backgroundColor: c.surfaceAlt, borderRadius: 24, borderWidth: 1, borderColor: c.border, padding: 14 },
  songEditorHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  songEditorIndex: { color: c.textSub, fontWeight: '900', fontSize: 12, letterSpacing: 1.2, textTransform: 'uppercase' },
  songInlineRow: { flexDirection: 'row', gap: 10 },
  songInlineCol: { flex: 1 },

  // ─── Category chips ────────────────────────────────────────────────────────
  categoryWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  categoryChip: { backgroundColor: c.surfaceAlt, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 8 },
  categoryChipActive: { backgroundColor: c.accent },
  categoryChipText: { color: c.textSub, fontSize: 11, fontWeight: '800' },
  categoryChipTextActive: { color: c.accentText },

  // ─── Preview card ──────────────────────────────────────────────────────────
  previewCard: { marginTop: 14, backgroundColor: c.surfaceAlt, borderRadius: 20, padding: 12, borderWidth: 1, borderColor: c.border },
  previewLabel: { color: c.textSub, fontSize: 11, fontWeight: '800', letterSpacing: 1.3, marginBottom: 10 },
  previewOpenBtn: { marginTop: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: c.surface, borderRadius: 14, paddingVertical: 10 },
  previewOpenBtnText: { color: c.text, fontSize: 13, fontWeight: '800' },

  // ─── Detail modal ──────────────────────────────────────────────────────────
  detailOverlay: { flex: 1, backgroundColor: c.accent, justifyContent: 'flex-end' },
  detailBackdrop: { ...StyleSheet.absoluteFill },
  detailSheet: { backgroundColor: c.surface, borderTopLeftRadius: 28, borderTopRightRadius: 28, maxHeight: '92%' },
  detailHandle: { alignSelf: 'center', width: 48, height: 5, borderRadius: 999, backgroundColor: c.border, marginTop: 12 },
  detailHead: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', paddingHorizontal: 18, paddingTop: 14, paddingBottom: 10 },
  detailHeadTextWrap: { flex: 1, paddingRight: 10 },
  detailEyebrow: { color: c.textMuted, fontSize: 11, letterSpacing: 1.5, fontWeight: '900' },
  detailTitle: { color: c.text, fontSize: 24, lineHeight: 28, fontWeight: '900', marginTop: 4 },
  detailCloseBtn: { width: 34, height: 34, borderRadius: 999, backgroundColor: c.surfaceAlt, alignItems: 'center', justifyContent: 'center' },
  detailBody: { maxHeight: '100%' },
  detailBodyContent: { paddingHorizontal: 18, paddingBottom: 22 },
  detailBlock: { marginTop: 16 },
  detailLabel: { color: c.textMuted, fontSize: 11, letterSpacing: 1.4, fontWeight: '900', marginBottom: 10 },
  detailRichPreviewWrap: { backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, borderRadius: 20, overflow: 'hidden', minHeight: 120 },
  detailRichPreview: { backgroundColor: 'transparent', minHeight: 120 },

  // ─── Detail song card ──────────────────────────────────────────────────────
  detailSongCard: { marginTop: 16, backgroundColor: c.surface, borderRadius: 24, borderWidth: 1, borderColor: c.border, padding: 14 },
  detailSongIndex: { color: c.textMuted, fontSize: 11, letterSpacing: 1.2, fontWeight: '900', textTransform: 'uppercase' },
  detailSongTitle: { color: c.text, fontSize: 18, fontWeight: '900', marginTop: 6 },
  detailSongMeta: { color: c.textSub, fontSize: 13, marginTop: 4 },
  detailChipRow: { flexDirection: 'row', gap: 8, marginTop: 10 },
  detailChip: { backgroundColor: c.surfaceAlt, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 7 },
  detailChipText: { color: c.textSub, fontSize: 11, fontWeight: '800' },
  detailYoutubeWrap: { borderRadius: 16, overflow: 'hidden' },
  detailOpenYoutubeBtn: { marginTop: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: c.surfaceAlt, borderRadius: 14, paddingVertical: 10 },
  detailOpenYoutubeBtnText: { color: c.text, fontSize: 13, fontWeight: '800' },
  detailMonoText: { color: c.textSub, fontSize: 13, lineHeight: 20 },

  // ─── Detail actions ────────────────────────────────────────────────────────
  detailActions: { flexDirection: 'row', gap: 10, paddingHorizontal: 18, paddingTop: 8, paddingBottom: 18 },
  detailActionBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: 16, paddingVertical: 13 },
  detailActionBtnSecondary: { backgroundColor: c.surfaceAlt },
  detailActionBtnDestructive: { backgroundColor: c.accent },
  detailActionBtnText: { color: c.text, fontSize: 13, fontWeight: '800' },
  detailActionBtnTextDestructive: { color: c.accentText, fontSize: 13, fontWeight: '800' },

  // ─── Busy overlay ──────────────────────────────────────────────────────────
  busyOverlay: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center', backgroundColor: c.surface },
  busyCard: { backgroundColor: c.surface, borderRadius: 20, padding: 20, shadowColor: c.shadow, shadowOpacity: 0.06, shadowRadius: 16, shadowOffset: { width: 0, height: 8 }, borderWidth: 1, borderColor: c.border },
})
