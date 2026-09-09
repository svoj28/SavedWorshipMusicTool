import React, { useEffect, useState, useCallback, useRef , useMemo} from 'react'
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
} from 'react-native'
import { useAppTheme, type AppColors } from '../lib/theme'
import * as DocumentPicker from 'expo-document-picker'
import Ionicons from '@expo/vector-icons/Ionicons'
import { WebView } from '../components/EngineWebView'
import { getCurrentUser } from '../lib/auth'
import {
  getAllFileDroppers,
  getAllAnnouncements,
  getAllVersionDroppers,
  createFileDropper,
  createImportantAnnouncement,
  createVersionDropper,
  updateFileDropper,
  updateAnnouncement,
  updateVersionDropper,
  deleteFileDropper,
  deleteAnnouncement,
  deleteVersionDropper,
  getAllImportantMessages,
  createImportantMessage,
  updateImportantMessage,
  deleteImportantMessage,
} from '../db/queries'
import YoutubePlayer from 'react-native-youtube-iframe'
import { FileDropper, ImportantAnnouncement, VersionDropper, ImportantMessage } from '../db/models'
import { useRole } from '../lib/useRole'
import { notifyManagementChangeToAllUsers } from '../lib/notifications'
import { onTableChange } from '../lib/sync'
import { supabase } from '../lib/supabase'
import { useNotifications } from '../lib/NotificationContext'
import { usePullToRefresh } from '../lib/usePullToRefresh'


type Section = 'conversation' | 'files' | 'announcements' | 'versions' | null

interface FormData {
  title?: string
  description?: string
  content?: string
  youtubeUrl?: string
  fileUrl?: string
  fileName?: string
}

interface SectionConfig {
  key: Exclude<Section, null>
  label: string
  icon: any
  countKey?: string
  countLabel: string
}

const SECTIONS: SectionConfig[] = [
  { key: 'conversation',  label: 'Important Messages', icon: 'chatbubbles-outline', countKey: 'messages',      countLabel: 'messages' },
  { key: 'files',         label: 'Files',              icon: 'folder-outline',      countKey: 'files',         countLabel: 'files'   },
  { key: 'announcements', label: 'Announcements',      icon: 'megaphone-outline',   countKey: 'announcements', countLabel: 'items'   },
]

const SECTION_TITLES: Record<Exclude<Section, null>, string> = {
  conversation:  'Important Messages',
  files:         'File Dropper',
  announcements: 'Announcements',
  versions:      'Version Dropper',
}

function extractYouTubeId(url: string): string | null {
  if (!url) return null
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
  ]
  for (const p of patterns) {
    const m = url.match(p)
    if (m) return m[1]
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
  const [ready, setReady] = useState(false)
  const initialHtmlRef = useRef<string>(normalizeRichTextValue(value))
  const normalizedValue = normalizeRichTextValue(value)

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
              if (message.type === 'ready') {
                setReady(true)
                return
              }
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

function RichTextBlock({ label, value }: { label: string; value: string }) {
  const { colors: c } = useAppTheme()
  const styles = useMemo(() => makeStyles(c), [c])

  if (!value) return null

  const previewSource = { html: buildRichTextDocument(value, '', false) }

  return (
    <View style={[styles.detailBlock, { flex: 1 }]}>
      <Text style={styles.detailLabel}>{label}</Text>
      <View style={styles.detailRichPreviewWrap}>
        <WebView
          originWhitelist={['*']}
          source={previewSource}
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

export default function ManagementScreen({ route }: any) {
  const { colors: c } = useAppTheme()
  const styles = useMemo(() => makeStyles(c), [c])

  const [activeSection, setActiveSection] = useState<Section>(null)
  const [userId, setUserId] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const { isAdmin, canManageContent } = useRole()
  const { notifications } = useNotifications()
  const lastManagementNotificationIdRef = React.useRef<string | null>(null)
  const [messages, setMessages] = useState<ImportantMessage[]>([])

  const [files, setFiles] = useState<FileDropper[]>([])
  const [announcements, setAnnouncements] = useState<ImportantAnnouncement[]>([])
  const [versions, setVersions] = useState<VersionDropper[]>([])

    const [showForm, setShowForm] = useState(false)
  const [formData, setFormData] = useState<FormData>({})
  const [editingId, setEditingId] = useState<string | null>(null)
  const [pickingFile, setPickingFile] = useState(false)
  const [selectedItem, setSelectedItem] = useState<any | null>(null)

  const normalizeManagementRow = (tableName: string, row: any) => {
    if (tableName === 'important_messages') {
      return {
        id: row.id,
        title: row.title,
        content: row.content || '',
        userId: row.user_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        synced: Boolean(row._synced),
      }
    }
    
    if (tableName === 'file_droppers') {
      return {
        id: row.id,
        title: row.title,
        description: row.description || '',
        fileUrl: row.file_url || '',
        userId: row.user_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        synced: Boolean(row._synced),
      }
    }
    if (tableName === 'important_announcements') {
      return {
        id: row.id,
        title: row.title,
        content: row.content || '',
        userId: row.user_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        synced: Boolean(row._synced),
      }
    }
    return {
      id: row.id,
      title: row.title,
      description: row.description || '',
      youtubeUrl: row.youtube_url || '',
      userId: row.user_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      synced: Boolean(row._synced),
    }
  }

  const sortByNewest = (left: any, right: any) => (right.createdAt || 0) - (left.createdAt || 0)

  const applyRealtimeManagementChange = (tableName: string, payload: any) => {
    const eventType = payload?.eventType
    const row = payload?.new ?? payload?.old
    if (!row) return

    const normalized = normalizeManagementRow(tableName, row)

    const applyUpsert = (setter: React.Dispatch<React.SetStateAction<any[]>>) => {
      setter(prev => {
        const withoutCurrent = prev.filter(item => item.id !== normalized.id)
        if (eventType === 'DELETE') return withoutCurrent
        return [...withoutCurrent, normalized].sort(sortByNewest)
      })
    }

    if (tableName === 'file_droppers') applyUpsert(setFiles)
    if (tableName === 'important_announcements') applyUpsert(setAnnouncements)
    if (tableName === 'important_messages') applyUpsert(setMessages)
    if (tableName === 'version_droppers') applyUpsert(setVersions)

    setSelectedItem(prev => (prev?.id === normalized.id ? (eventType === 'DELETE' ? null : normalized) : prev))
  }

  const refreshData = useCallback(async (options: { silent?: boolean } = {}) => {
  if (!options.silent) setLoading(true)
  try {
    const [fileData, announcementData, versionData, messageData] = await Promise.all([
      getAllFileDroppers(),
      getAllAnnouncements(),
      getAllVersionDroppers(),
      getAllImportantMessages(),
    ])
    setFiles(fileData)
    setAnnouncements(announcementData)
    setVersions(versionData)
    setMessages(messageData)
  } catch (err) {
    console.error('Error loading data:', err)
  } finally {
    if (!options.silent) setLoading(false)
  }
}, [])

  const { refreshing, onRefresh } = usePullToRefresh(() => refreshData({ silent: true }))

  useEffect(() => {
    const loadUser = async () => {
      const user = await getCurrentUser()
      if (user) {
        setUserId(user.id)
      }
    }
    loadUser()
    void refreshData()
  }, [])

  useEffect(() => {
    const latestManagementNotification = [...notifications]
      .find(notification => {
        if (notification.type !== 'management_broadcast') return false
        if (!userId) return true
        return notification.data?.actorUserId !== userId
      })

    if (!latestManagementNotification) return
    if (lastManagementNotificationIdRef.current === latestManagementNotification.id) return

    lastManagementNotificationIdRef.current = latestManagementNotification.id
    void refreshData({ silent: true })
  }, [notifications, refreshData])

  useEffect(() => {
    const initialSection = route?.params?.initialSection as Section | undefined
    if (initialSection) {
      setActiveSection(initialSection)
    }
  }, [route?.params?.initialSection])

  useEffect(() => {
  const unsubFiles = onTableChange('file_droppers', () => void refreshData({ silent: true }))
  const unsubAnnouncements = onTableChange('important_announcements', () => void refreshData({ silent: true }))
  const unsubVersions = onTableChange('version_droppers', () => void refreshData({ silent: true }))
  const unsubMessages = onTableChange('important_messages', () => void refreshData({ silent: true }))

  const filesChannel = supabase
    .channel('management-files')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'file_droppers' }, payload => {
      applyRealtimeManagementChange('file_droppers', payload)
    })
    .subscribe()

  const announcementsChannel = supabase
    .channel('management-announcements')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'important_announcements' }, payload => {
      applyRealtimeManagementChange('important_announcements', payload)
    })
    .subscribe()

  const versionsChannel = supabase
    .channel('management-versions')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'version_droppers' }, payload => {
      applyRealtimeManagementChange('version_droppers', payload)
    })
    .subscribe()

  const messagesChannel = supabase
    .channel('management-messages')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'important_messages' }, payload => {
      applyRealtimeManagementChange('important_messages', payload)
    })
    .subscribe()

  return () => {
    unsubFiles()
    unsubAnnouncements()
    unsubVersions()
    unsubMessages()
    supabase.removeChannel(filesChannel)
    supabase.removeChannel(announcementsChannel)
    supabase.removeChannel(versionsChannel)
    supabase.removeChannel(messagesChannel)
  }
}, [refreshData])

const getCount = (key?: string): number => {
  if (!key) return 0
  const map: Record<string, number> = {
    files: files.length,
    announcements: announcements.length,
    versions: versions.length,
    messages: messages.length,
  }
  return map[key] ?? 0
}

  const getItems = (): any[] => {
    if (activeSection === 'files') return files
    if (activeSection === 'conversation') return messages
    if (activeSection === 'announcements') return announcements
    if (activeSection === 'versions') return versions
    return []
  }

  const handleAddNew = () => {     setEditingId(null);     setFormData({});     setShowForm(true)   }

  const handleEdit = (item: any) => {
    setEditingId(item.id)
    setFormData({
      title: item.title,
      description: item.description || '',
      content: item.content || '',
      youtubeUrl: item.youtubeUrl || '',
      fileUrl: item.fileUrl || '',
      fileName: item.fileName || '',
    })
    setShowForm(true)
  }

  const handleOpenItem = (item: any) => {
    setSelectedItem(item)
  }

  const handlePickFile = async () => {
    try {
      setPickingFile(true)
      const result = await DocumentPicker.getDocumentAsync({         type: '*/*'       })
      if (!result.canceled && result.assets.length > 0) {
        const asset = result.assets[0]
        setFormData(prev => ({           ...prev,           fileUrl: asset.uri,           fileName: asset.name         }))
      }
    } catch (err) {
            Alert.alert('Error', 'Failed to pick file')
    } finally {
      setPickingFile(false)
    }
  }

  const handleSaveConfirm = () => {
    if (!canManageContent) {
      Alert.alert('Access denied', 'Only admins can add or edit management items.')
      return
    }
    if (saving || deletingId) return

    const actionLabel = editingId ? 'Save changes' : 'Add item'
    Alert.alert(
      actionLabel,
      editingId
        ? `Save your changes to "${formData.title?.trim() || 'this item'}"?`
        : `Add "${formData.title?.trim() || 'this item'}" to ${sectionTitle.toLowerCase()}?`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: actionLabel, onPress: handleSubmit },
      ]
    )
  }

  const upsertLocalItem = (item: any) => {
  if (activeSection === 'files') {
    setFiles(prev => editingId ? prev.map(existing => existing.id === editingId ? { ...existing, ...item } : existing) : [item, ...prev])
    return
  }
  if (activeSection === 'conversation') {
    setMessages(prev => editingId ? prev.map(existing => existing.id === editingId ? { ...existing, ...item } : existing) : [item, ...prev])
    return
  }
  if (activeSection === 'announcements') {
    setAnnouncements(prev => editingId ? prev.map(existing => existing.id === editingId ? { ...existing, ...item } : existing) : [item, ...prev])
    return
  }
  if (activeSection === 'versions') {
    setVersions(prev => editingId ? prev.map(existing => existing.id === editingId ? { ...existing, ...item } : existing) : [item, ...prev])
  }
}

const removeLocalItem = (itemId: string) => {
  if (activeSection === 'files') {
    setFiles(prev => prev.filter(item => item.id !== itemId))
    return
  }
  if (activeSection === 'conversation') {
    setMessages(prev => prev.filter(item => item.id !== itemId))
    return
  }
  if (activeSection === 'announcements') {
    setAnnouncements(prev => prev.filter(item => item.id !== itemId))
    return
  }
  if (activeSection === 'versions') {
    setVersions(prev => prev.filter(item => item.id !== itemId))
  }
}

  const handleSubmit = async () => {
    if (!canManageContent) {
      Alert.alert('Access denied', 'Only admins or managers can add or edit management items.')
      return
    }
    if (saving || deletingId) return
    if (!formData.title?.trim()) {       Alert.alert('Error', 'Please enter a title');       return }
    setSaving(true)
    try {
      const now = Date.now()
      if (activeSection === 'files') {
        if (!formData.fileUrl?.trim()) {           Alert.alert('Error', 'Please enter a file URL');           return         }
        if (editingId) {
          await updateFileDropper(editingId, {
            title: formData.title,
            description: formData.description,
            fileUrl: formData.fileUrl,
            updatedAt: now,
          })
          upsertLocalItem({
            id: editingId,
            title: formData.title,
            description: formData.description,
            fileUrl: formData.fileUrl,
            userId,
            updatedAt: now,
          })
          void notifyManagementChangeToAllUsers(userId, 'updated', 'File', formData.title)
        } else {
          const created = await createFileDropper({
            title: formData.title,
            description: formData.description,
            fileUrl: formData.fileUrl,
            userId,
            createdAt: now,
            updatedAt: now,
            synced: false,
          })
          upsertLocalItem(created)
          void notifyManagementChangeToAllUsers(userId, 'created', 'File', formData.title)
        }
       } else if (activeSection === 'conversation') {
  if (!stripHtml(formData.content || '').trim()) { Alert.alert('Error', 'Please enter message content'); return }
  if (editingId) {
    await updateImportantMessage(editingId, {
      title: formData.title,
      content: formData.content,
      updatedAt: now,
    })
    upsertLocalItem({
      id: editingId,
      title: formData.title,
      content: formData.content,
      userId,
      updatedAt: now,
    })
    void notifyManagementChangeToAllUsers(userId, 'updated', 'Important Message', formData.title)
  } else {
    const created = await createImportantMessage({
      title: formData.title,
      content: formData.content,
      userId,
      createdAt: now,
      updatedAt: now,
      synced: false,
    })
    upsertLocalItem(created)
    void notifyManagementChangeToAllUsers(userId, 'created', 'Important Message', formData.title)
  }
} else if (activeSection === 'announcements') {
  if (!stripHtml(formData.content || '').trim()) { Alert.alert('Error', 'Please enter announcement content'); return }
  if (editingId) {
    await updateAnnouncement(editingId, {
      title: formData.title,
      content: formData.content,
      updatedAt: now,
    })
    upsertLocalItem({
      id: editingId,
      title: formData.title,
      content: formData.content,
      userId,
      updatedAt: now,
    })
    void notifyManagementChangeToAllUsers(userId, 'updated', 'Announcement', formData.title)
  } else {
    const created = await createImportantAnnouncement({
      title: formData.title,
      content: formData.content,
      userId,
      createdAt: now,
      updatedAt: now,
      synced: false,
    })
    upsertLocalItem(created)
    void notifyManagementChangeToAllUsers(userId, 'created', 'Announcement', formData.title)
  }
} else if (activeSection === 'versions') {
        if (!formData.youtubeUrl?.trim()) {           Alert.alert('Error', 'Please enter a YouTube URL');           return         }
        if (editingId) {
          await updateVersionDropper(editingId, {
            title: formData.title,
            description: formData.description,
            youtubeUrl: formData.youtubeUrl,
            updatedAt: now,
          })
          upsertLocalItem({
            id: editingId,
            title: formData.title,
            description: formData.description,
            youtubeUrl: formData.youtubeUrl,
            userId,
            updatedAt: now,
          })
          void notifyManagementChangeToAllUsers(userId, 'updated', 'Version', formData.title)
        } else {
          const created = await createVersionDropper({
            title: formData.title,
            description: formData.description,
            youtubeUrl: formData.youtubeUrl,
            userId,
            createdAt: now,
            updatedAt: now,
            synced: false,
          })
          upsertLocalItem(created)
          void notifyManagementChangeToAllUsers(userId, 'created', 'Version', formData.title)
        }
      }
      setShowForm(false)
      setFormData({})
    } catch (err) {       Alert.alert('Error', 'Failed to save item')     }
    finally {
      setSaving(false)
    }
  }

  const handleDelete = async (item: any) => {
    if (!canManageContent) {
      Alert.alert('Access denied', 'Only admins or managers can delete management items.')
      return
    }
    if (saving || deletingId) return
    Alert.alert('Delete Item', 'This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive',
        onPress: async () => {
          setDeletingId(item.id)
          try {
            if (activeSection === 'files') await deleteFileDropper(item.id)
            if (activeSection === 'files') await deleteFileDropper(item.id)
            else if (activeSection === 'conversation') await deleteImportantMessage(item.id)
            else if (activeSection === 'announcements') await deleteAnnouncement(item.id)
            else if (activeSection === 'versions') await deleteVersionDropper(item.id)
            else if (activeSection === 'versions') await deleteVersionDropper(item.id)
            removeLocalItem(item.id)
            void notifyManagementChangeToAllUsers(userId, 'deleted', sectionTitle, item.title)
          } catch (err) {             Alert.alert('Error', 'Failed to delete item')           }
          finally {
            setDeletingId(null)
          }
        },
      },
    ])
  }

  // ─── DASHBOARD ───
  if (!activeSection) {
      return (
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.dashboardContent}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
          <StatusBar barStyle="dark-content" backgroundColor={c.surfaceAlt} />

        <View style={styles.dashHeader}>
          <Text style={styles.dashEyebrow}>ADMIN</Text>
          <Text style={styles.dashTitle}>Management</Text>
        </View>
      
        {loading ? (
          <View style={styles.loadingWrap}>
            <ActivityIndicator size="large" color={c.text} />
          </View>
        ) : (
          <View style={styles.sectionGrid}>
            {SECTIONS.map((section) => {
              const count = getCount(section.countKey)
              return (
                <TouchableOpacity
                  key={section.key}
                  style={styles.sectionCard}
                  onPress={() => setActiveSection(section.key)}
                  activeOpacity={0.72}
                >
                  <View style={styles.sectionCardIcon}>
                    <Ionicons name={section.icon} size={20} color={c.text} />
                  </View>
                  <View style={styles.sectionCardMeta}>
                    <Text style={styles.sectionCardLabel}>{section.label}</Text>
                    <Text style={styles.sectionCardCount}>
                      {section.countKey ? `${count} ${section.countLabel}` : section.countLabel}
                    </Text>
                  </View>
                  <Ionicons name="chevron-forward" size={14} color={c.iconInactive} />
                </TouchableOpacity>
              )
            })}
          </View>
        )}
      </ScrollView>
    )
  }

  // ─── SECTION DETAIL ───
  // ─── SECTION DETAIL ───
  const items = getItems()
  const sectionTitle = SECTION_TITLES[activeSection]
  const sectionIcon = SECTIONS.find(s => s.key === activeSection)?.icon ?? 'cube-outline'

  // ─── ITEM DETAIL VIEW (inline, full screen) ───
  if (selectedItem) {
    return (
      <View style={styles.container}>
        <StatusBar barStyle="dark-content" backgroundColor={c.surface} />

        <View style={styles.sectionHeader}>
          <TouchableOpacity style={styles.backBtn} onPress={() => setSelectedItem(null)} activeOpacity={0.7}>
            <Ionicons name="arrow-back" size={16} color={c.text} />
          </TouchableOpacity>
          <View style={styles.sectionHeaderMeta}>
            <Text style={styles.sectionHeaderEyebrow}>{sectionTitle.toUpperCase()}</Text>
            <Text style={styles.sectionHeaderTitle} numberOfLines={1}>{selectedItem.title}</Text>
          </View>
          {canManageContent ? (
            <TouchableOpacity
              style={styles.addBtn}
              onPress={() => { const item = selectedItem; setSelectedItem(null); handleEdit(item) }}
              activeOpacity={0.8}
            >
              <Ionicons name="pencil-outline" size={16} color={c.accentText} />
            </TouchableOpacity>
          ) : <View style={{ width: 34 }} />}
        </View>

        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ flexGrow: 1, paddingHorizontal: 20, paddingTop: 22, paddingBottom: 60, gap: 18 }}
          showsVerticalScrollIndicator={false}
        >
          {selectedItem.description
            ? <RichTextBlock label="DESCRIPTION" value={selectedItem.description} />
            : null}

          {selectedItem.content
            ? <RichTextBlock label="CONTENT" value={selectedItem.content} />
            : null}

          {selectedItem.youtubeUrl ? (
            <View style={styles.detailBlock}>
              <Text style={styles.detailLabel}>VIDEO</Text>
              {(() => {
                const videoId = extractYouTubeId(selectedItem.youtubeUrl)
                return videoId ? (
                  <View style={styles.detailYoutubeWrap}>
                    <YoutubePlayer height={200} videoId={videoId} play={false} />
                    <TouchableOpacity
                      style={styles.detailOpenYoutubeBtn}
                      onPress={() => {
                        const url = /^https?:\/\//i.test(selectedItem.youtubeUrl)
                          ? selectedItem.youtubeUrl
                          : `https://${selectedItem.youtubeUrl}`
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
                  <Text style={styles.detailMonoText}>{selectedItem.youtubeUrl}</Text>
                )
              })()}
            </View>
          ) : null}

          {selectedItem.fileUrl ? (
            <View style={styles.detailBlock}>
              <Text style={styles.detailLabel}>FILE URL</Text>
              <TouchableOpacity
                onPress={() => {
                  const url = /^https?:\/\//i.test(selectedItem.fileUrl)
                    ? selectedItem.fileUrl
                    : `https://${selectedItem.fileUrl}`
                  Linking.openURL(url).catch(() => Alert.alert('Error', 'Could not open file'))
                }}
                activeOpacity={0.7}
              >
                <Text style={[styles.detailMonoText, { color: c.text, textDecorationLine: 'underline' }]}>
                  {selectedItem.fileUrl}
                </Text>
              </TouchableOpacity>
            </View>
          ) : null}

          {selectedItem.fileName ? (
            <View style={styles.detailBlock}>
              <Text style={styles.detailLabel}>FILE NAME</Text>
              <Text style={styles.detailText}>{selectedItem.fileName}</Text>
            </View>
          ) : null}

          {canManageContent && (
            <View style={[styles.detailActions, { marginTop: 8 }]}>
              <TouchableOpacity
                style={[styles.detailActionBtn, styles.detailActionBtnSecondary]}
                onPress={() => { const item = selectedItem; setSelectedItem(null); handleEdit(item) }}
              >
                <Ionicons name="pencil-outline" size={16} color={c.text} />
                <Text style={styles.detailActionBtnText}>Edit</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.detailActionBtn, styles.detailActionBtnDestructive]}
                onPress={() => { const item = selectedItem; setSelectedItem(null); handleDelete(item) }}
              >
                <Ionicons name="trash-outline" size={16} color={c.accentText} />
                <Text style={styles.detailActionBtnTextDestructive}>Delete</Text>
              </TouchableOpacity>
            </View>
          )}
        </ScrollView>

        <Modal visible={showForm} transparent animationType="slide" onRequestClose={() => setShowForm(false)}>
          <View style={styles.formOverlay}>
            <View style={styles.formSheet}>
              <View style={styles.formHandle} />
              <View style={styles.formHead}>
                <TouchableOpacity onPress={() => setShowForm(false)}>
                  <Text style={styles.formCancel}>Cancel</Text>
                </TouchableOpacity>
                <Text style={styles.formTitle}>{editingId ? 'Edit Item' : `Add ${sectionTitle}`}</Text>
                <TouchableOpacity onPress={handleSaveConfirm} style={[styles.formSaveBtn, (saving || !!deletingId) && styles.formSaveBtnDisabled]} disabled={saving || !!deletingId}>
                  {saving ? <ActivityIndicator size="small" color={c.accentText} /> : <Text style={styles.formSave}>Save</Text>}
                </TouchableOpacity>
              </View>
              <ScrollView style={styles.formBody} contentContainerStyle={styles.formBodyContent} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="always" keyboardDismissMode="none">
                <Text style={styles.fieldLabel}>TITLE</Text>
                <TextInput style={styles.textInput} placeholder="Enter title…" placeholderTextColor={c.textMuted} value={formData.title || ''} onChangeText={(text) => setFormData({ ...formData, title: text })} />
                {(activeSection === 'conversation' || activeSection === 'announcements') && (
                  <RichTextField label="CONTENT" placeholder="Write your announcement…" value={formData.content || ''} onChange={(text) => setFormData({ ...formData, content: text })} height={260} />
                )}
                {activeSection === 'files' && (
                  <>
                    <Text style={[styles.fieldLabel, { marginTop: 20 }]}>FILE</Text>
                    <TouchableOpacity style={styles.filePickerBtn} onPress={handlePickFile} disabled={pickingFile} activeOpacity={0.8}>
                      {pickingFile ? <ActivityIndicator size="small" color={c.accentText} /> : <Ionicons name="folder-open-outline" size={16} color={c.accentText} />}
                      <Text style={styles.filePickerBtnText}>{pickingFile ? 'Picking file…' : 'Pick from Device'}</Text>
                    </TouchableOpacity>
                    {formData.fileName ? (
                      <View style={styles.selectedFile}>
                        <Ionicons name="document-outline" size={16} color={c.textSub} />
                        <View style={{ flex: 1 }}>
                          <Text style={styles.selectedFileName}>{formData.fileName}</Text>
                          {formData.fileUrl && <Text style={styles.selectedFileUrl} numberOfLines={1}>{formData.fileUrl}</Text>}
                        </View>
                        <TouchableOpacity onPress={() => setFormData({ ...formData, fileUrl: '', fileName: '' })} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                          <Ionicons name="close-circle" size={18} color={c.iconInactive} />
                        </TouchableOpacity>
                      </View>
                    ) : null}
                    <Text style={styles.orDivider}>— or enter URL manually —</Text>
                    <TextInput style={styles.textInput} placeholder="https://…" placeholderTextColor={c.textMuted} value={formData.fileUrl || ''} onChangeText={(text) => setFormData({ ...formData, fileUrl: text })} autoCapitalize="none" keyboardType="url" />
                  </>
                )}
                {activeSection === 'versions' && (
                  <>
                    <Text style={[styles.fieldLabel, { marginTop: 20 }]}>YOUTUBE URL</Text>
                    <TextInput style={styles.textInput} placeholder="https://youtube.com/…" placeholderTextColor={c.textMuted} value={formData.youtubeUrl || ''} onChangeText={(text) => setFormData({ ...formData, youtubeUrl: text })} autoCapitalize="none" keyboardType="url" />
                  </>
                )}
                {(activeSection === 'files' || activeSection === 'versions') && (
                  <RichTextField label="DESCRIPTION" placeholder="Optional description…" value={formData.description || ''} onChange={(text) => setFormData({ ...formData, description: text })} height={180} />
                )}
                <View style={{ height: 20 }} />
              </ScrollView>
            </View>
          </View>
        </Modal>

        {(saving || !!deletingId) && (
          <View style={styles.busyOverlay} pointerEvents="auto">
            <View style={styles.busyCard}>
              <ActivityIndicator size="large" color={c.text} />
            </View>
          </View>
        )}
      </View>
    )
  }

  // ─── SECTION LIST VIEW ───
  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor={c.surface} />

      <View style={styles.sectionHeader}>
        <TouchableOpacity style={styles.backBtn} onPress={() => setActiveSection(null)} activeOpacity={0.7}>
          <Ionicons name="arrow-back" size={16} color={c.text} />
        </TouchableOpacity>
        <View style={styles.sectionHeaderMeta}>
          <Text style={styles.sectionHeaderEyebrow}>MANAGEMENT</Text>
          <Text style={styles.sectionHeaderTitle}>{sectionTitle}</Text>
        </View>
        {canManageContent ? (
          <TouchableOpacity style={styles.addBtn} onPress={handleAddNew} activeOpacity={0.8}>
            <Ionicons name="add" size={18} color={c.accentText} />
          </TouchableOpacity>
        ) : <View style={{ width: 34 }} />}
      </View>

      {loading ? (
        <View style={styles.centerContent}>
          <ActivityIndicator size="large" color={c.text} />
        </View>
      ) : items.length === 0 ? (
        <View style={styles.centerContent}>
          <View style={styles.emptyIconWrap}>
            <Ionicons name={sectionIcon} size={28} color={c.iconInactive} />
          </View>
          <Text style={styles.emptyTitle}>Nothing here yet</Text>
          <Text style={styles.emptySubtitle}>
            {canManageContent ? 'Tap + to add your first item' : 'No items have been added'}
          </Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.itemsContent}
          showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        >
          <Text style={styles.itemsSectionLabel}>
            {items.length} {items.length === 1 ? 'ITEM' : 'ITEMS'}
          </Text>
          {items.map((item, idx) => (
            <TouchableOpacity key={item.id} style={styles.itemCard} onPress={() => handleOpenItem(item)} activeOpacity={0.75}>
              <View style={styles.itemIndexWrap}>
                <Text style={styles.itemIndex}>{idx + 1}</Text>
              </View>
              <View style={styles.itemBody}>
                <Text style={styles.itemTitle}>{item.title}</Text>
                {item.description ? <Text style={styles.itemMeta} numberOfLines={2}>{stripHtml(item.description)}</Text> : null}
                {item.content ? <Text style={styles.itemMeta} numberOfLines={2}>{stripHtml(item.content)}</Text> : null}
                {item.youtubeUrl ? (
                  <View style={styles.itemUrlRow}>
                    <Ionicons name="logo-youtube" size={11} color={c.textMuted} />
                    <Text style={styles.itemUrl} numberOfLines={1}>{item.youtubeUrl}</Text>
                  </View>
                ) : null}
                {item.fileUrl ? (
                  <View style={styles.itemUrlRow}>
                    <Ionicons name="attach-outline" size={11} color={c.textMuted} />
                    <Text style={styles.itemUrl} numberOfLines={1}>{item.fileUrl}</Text>
                  </View>
                ) : null}
                <Text style={styles.itemViewMore}>Tap to view full content</Text>
              </View>
              {canManageContent && (
                <View style={styles.itemActions}>
                  <TouchableOpacity style={styles.itemActionBtn} onPress={() => handleEdit(item)} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
                    <Ionicons name="pencil-outline" size={15} color={c.text} />
                  </TouchableOpacity>
                  <TouchableOpacity style={[styles.itemActionBtn, styles.itemActionBtnDestructive]} onPress={() => handleDelete(item)} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
                    <Ionicons name="trash-outline" size={15} color={c.iconInactive} />
                  </TouchableOpacity>
                </View>
              )}
            </TouchableOpacity>
          ))}
          {canManageContent && (
            <TouchableOpacity style={styles.addMoreBtn} onPress={handleAddNew} activeOpacity={0.7}>
              <Ionicons name="add" size={17} color={c.text} />
              <Text style={styles.addMoreText}>Add Another</Text>
            </TouchableOpacity>
          )}
          <View style={{ height: 40 }} />
        </ScrollView>
      )}

      <Modal visible={showForm} transparent animationType="slide" onRequestClose={() => setShowForm(false)}>
        <View style={styles.formOverlay}>
          <View style={styles.formSheet}>
            <View style={styles.formHandle} />
            <View style={styles.formHead}>
              <TouchableOpacity onPress={() => setShowForm(false)}>
                <Text style={styles.formCancel}>Cancel</Text>
              </TouchableOpacity>
              <Text style={styles.formTitle}>{editingId ? 'Edit Item' : `Add ${sectionTitle}`}</Text>
              <TouchableOpacity onPress={handleSaveConfirm} style={[styles.formSaveBtn, (saving || !!deletingId) && styles.formSaveBtnDisabled]} disabled={saving || !!deletingId}>
                {saving ? <ActivityIndicator size="small" color={c.accentText} /> : <Text style={styles.formSave}>Save</Text>}
              </TouchableOpacity>
            </View>
            <ScrollView style={styles.formBody} contentContainerStyle={styles.formBodyContent} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="always" keyboardDismissMode="none">
              <Text style={styles.fieldLabel}>TITLE</Text>
              <TextInput style={styles.textInput} placeholder="Enter title…" placeholderTextColor={c.textMuted} value={formData.title || ''} onChangeText={(text) => setFormData({ ...formData, title: text })} />
              {(activeSection === 'conversation' || activeSection === 'announcements') && (
                <RichTextField label="CONTENT" placeholder="Write your announcement…" value={formData.content || ''} onChange={(text) => setFormData({ ...formData, content: text })} height={260} />
              )}
              {activeSection === 'files' && (
                <>
                  <Text style={[styles.fieldLabel, { marginTop: 20 }]}>FILE</Text>
                  <TouchableOpacity style={styles.filePickerBtn} onPress={handlePickFile} disabled={pickingFile} activeOpacity={0.8}>
                    {pickingFile ? <ActivityIndicator size="small" color={c.accentText} /> : <Ionicons name="folder-open-outline" size={16} color={c.accentText} />}
                    <Text style={styles.filePickerBtnText}>{pickingFile ? 'Picking file…' : 'Pick from Device'}</Text>
                  </TouchableOpacity>
                  {formData.fileName ? (
                    <View style={styles.selectedFile}>
                      <Ionicons name="document-outline" size={16} color={c.textSub} />
                      <View style={{ flex: 1 }}>
                        <Text style={styles.selectedFileName}>{formData.fileName}</Text>
                        {formData.fileUrl && <Text style={styles.selectedFileUrl} numberOfLines={1}>{formData.fileUrl}</Text>}
                      </View>
                      <TouchableOpacity onPress={() => setFormData({ ...formData, fileUrl: '', fileName: '' })} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                        <Ionicons name="close-circle" size={18} color={c.iconInactive} />
                      </TouchableOpacity>
                    </View>
                  ) : null}
                  <Text style={styles.orDivider}>— or enter URL manually —</Text>
                  <TextInput style={styles.textInput} placeholder="https://…" placeholderTextColor={c.textMuted} value={formData.fileUrl || ''} onChangeText={(text) => setFormData({ ...formData, fileUrl: text })} autoCapitalize="none" keyboardType="url" />
                </>
              )}
              {activeSection === 'versions' && (
                <>
                  <Text style={[styles.fieldLabel, { marginTop: 20 }]}>YOUTUBE URL</Text>
                  <TextInput style={styles.textInput} placeholder="https://youtube.com/…" placeholderTextColor={c.textMuted} value={formData.youtubeUrl || ''} onChangeText={(text) => setFormData({ ...formData, youtubeUrl: text })} autoCapitalize="none" keyboardType="url" />
                </>
              )}
              {(activeSection === 'files' || activeSection === 'versions') && (
                <RichTextField label="DESCRIPTION" placeholder="Optional description…" value={formData.description || ''} onChange={(text) => setFormData({ ...formData, description: text })} height={180} />
              )}
              <View style={{ height: 20 }} />
            </ScrollView>
          </View>
        </View>
      </Modal>

      {(loading || saving || !!deletingId) && (
        <View style={styles.busyOverlay} pointerEvents="auto">
          <View style={styles.busyCard}>
            <ActivityIndicator size="large" color={c.text} />
          </View>
        </View>
      )}
    </View>
  )
}

const makeStyles = (c: AppColors) => StyleSheet.create({
  container: {     flex: 1,     backgroundColor: c.surfaceAlt },

  detailYoutubeWrap: {
  borderRadius: 12,
  overflow: 'hidden',
  backgroundColor: c.accent,
},
detailOpenYoutubeBtn: {
  flexDirection: 'row',
  alignItems: 'center',
  gap: 8,
  paddingHorizontal: 14,
  paddingVertical: 10,
  backgroundColor: c.accent,
},
detailOpenYoutubeBtnText: {
  flex: 1,
  fontSize: 13,
  fontWeight: '600',
  color: c.iconInactive,
},

  // Dashboard
  dashboardContent: { paddingBottom: 60   },
  dashHeader: {
        backgroundColor: c.surface,
paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 18,
    borderBottomWidth: 1,
    borderBottomColor: c.hairline,
  },
  dashEyebrow: { fontSize: 10, fontWeight: '700', color: c.iconInactive, letterSpacing: 2, marginBottom: 2 },
  dashTitle: { fontSize: 28, fontWeight: '800', color: c.text, letterSpacing: -0.8 },
  loadingWrap: { paddingTop: 80, alignItems: 'center' },

  // Section Grid — now a vertical list for consistency
  sectionGrid: { paddingHorizontal: 16, paddingTop: 16, gap: 10 },
  sectionCard: {
    flexDirection: 'row',
    alignItems: 'center',
  gap: 14,
    backgroundColor: c.surface,
borderRadius: 16,
    borderWidth: 1,
    borderColor: c.hairline,
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  sectionCardIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: c.surfaceAlt,
    justifyContent: 'center',
    alignItems: 'center',
    },
  sectionCardMeta: { flex: 1, gap: 3 },
  sectionCardLabel: { fontSize: 15, fontWeight: '700', color: c.text, letterSpacing: -0.2 },
  sectionCardCount: {     fontSize: 11,     color: c.textMuted, fontWeight: '500'   },

  // Section Header
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
        backgroundColor: c.surface,
paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: c.hairline,
    gap: 12,
  },
  backBtn: { width: 34, height: 34, borderRadius: 10, backgroundColor: c.surfaceAlt, justifyContent: 'center', alignItems: 'center' },
  sectionHeaderMeta: { flex: 1, gap: 2 },
  sectionHeaderEyebrow: { fontSize: 9, fontWeight: '700', color: c.iconInactive, letterSpacing: 2 },
  sectionHeaderTitle: { fontSize: 15, fontWeight: '800', color: c.text, letterSpacing: -0.3 },
  addBtn: { width: 34, height: 34, borderRadius: 10, backgroundColor: c.accent, justifyContent: 'center', alignItems: 'center' },

  // Center / Empty
  centerContent: { flex: 1,     justifyContent: 'center',     alignItems: 'center', gap: 8, paddingBottom: 80 },
  emptyIconWrap: { width: 60, height: 60, borderRadius: 18, backgroundColor: c.surfaceAlt, justifyContent: 'center', alignItems: 'center', marginBottom: 8 },
  emptyTitle: { fontSize: 16, fontWeight: '700', color: c.text, letterSpacing: -0.2 },
  emptySubtitle: { fontSize: 13, color: c.iconInactive },

  // Items
  itemsContent: { paddingHorizontal: 16, paddingTop: 18, paddingBottom: 40 },
  itemsSectionLabel: { fontSize: 10, fontWeight: '700', color: c.iconInactive, letterSpacing: 1.8, marginBottom: 12 },
  itemCard: {
        flexDirection: 'row',
    alignItems: 'flex-start',
      backgroundColor: c.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: c.hairline,
        paddingHorizontal: 14,
    paddingVertical: 14,
    marginBottom: 10,
    gap: 12,
  },
  itemIndexWrap: { width: 30, height: 30, borderRadius: 9, backgroundColor: c.surfaceAlt, justifyContent: 'center', alignItems: 'center', marginTop: 1, flexShrink: 0 },
  itemIndex: { fontSize: 11, fontWeight: '800', color: c.textMuted },
  itemBody: { flex: 1, gap: 4 },
  itemTitle: { fontSize: 14, fontWeight: '700', color: c.text, letterSpacing: -0.1 },
  itemMeta: { fontSize: 12, color: c.textMuted, lineHeight: 17 },
  itemViewMore: { marginTop: 4, fontSize: 11, color: c.textMuted, fontWeight: '600' },
  itemUrlRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  itemUrl: { fontSize: 11, color: c.textMuted, flex: 1 },
  itemActions: { flexDirection: 'row', gap: 6, marginTop: 2, flexShrink: 0 },
  itemActionBtn: { width: 32, height: 32, borderRadius: 9, backgroundColor: c.surfaceAlt, justifyContent: 'center', alignItems: 'center' },
  itemActionBtnDestructive: { backgroundColor: c.surfaceAlt },
  addMoreBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  borderRadius: 14,
    borderWidth: 1.5,
    borderColor: c.border,
    borderStyle: 'dashed',
    paddingVertical: 14,
    marginTop: 4,
  },
  addMoreText: { fontSize: 13, fontWeight: '700', color: c.text },

  // Modal
  formOverlay: { flex: 1, backgroundColor: c.accent },
  formSheet: { flex: 1, backgroundColor: c.surface, paddingTop: 12, paddingBottom: 18 },
  formHandle: { width: 36, height: 4, borderRadius: 2, backgroundColor: c.border, alignSelf: 'center', marginTop: 4, marginBottom: 8 },
  formHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 15,
    borderBottomWidth: 1,
    borderBottomColor: c.hairline,
  },
  formTitle: { fontSize: 15, fontWeight: '800', color: c.text, letterSpacing: -0.3 },
  formCancel: { fontSize: 14, color: c.textMuted, fontWeight: '500', minWidth: 54 },
  formSaveBtn: { backgroundColor: c.accent, borderRadius: 10, paddingHorizontal: 16, paddingVertical: 8, minWidth: 54, alignItems: 'center' },
  formSaveBtnDisabled: { opacity: 0.6 },
  formSave: { fontSize: 13, fontWeight: '700', color: c.accentText },
  formBody: { flex: 1 },
  formBodyContent: { paddingHorizontal: 20, paddingTop: 20, paddingBottom: 28, gap: 16 },
  fieldLabel: { fontSize: 10, fontWeight: '700', color: c.iconInactive, letterSpacing: 2, marginBottom: 9, textTransform: 'uppercase' },
  textInput: { backgroundColor: c.surfaceAlt, borderRadius: 13, borderWidth: 1.5, borderColor: c.hairline, paddingHorizontal: 15, paddingVertical: 14, fontSize: 15, color: c.text, fontWeight: '500' },
  textArea: { minHeight: 100, textAlignVertical: 'top' },
  richField: { gap: 9 },
  richToolbar: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  richToolBtn: { width: 36, height: 36, borderRadius: 10, backgroundColor: c.surfaceAlt, justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: c.border },
  richToolBtnText: { fontSize: 15, fontWeight: '800', color: c.text },
  richToolItalic: { fontStyle: 'italic' },
  richToolUnderline: { textDecorationLine: 'underline' },
  richToolbarHint: { marginLeft: 6, fontSize: 12, color: c.textMuted, flex: 1 },
  richEditorWrap: { borderRadius: 14, borderWidth: 1.5, borderColor: c.hairline, overflow: 'hidden', backgroundColor: c.surface },
  richEditorWebView: { flex: 1, backgroundColor: 'transparent' },
  filePickerBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: c.accent, borderRadius: 13, paddingVertical: 14, marginBottom: 12 },
  filePickerBtnText: { fontSize: 14, fontWeight: '700', color: c.accentText },
  selectedFile: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: c.surfaceAlt, borderRadius: 12, borderWidth: 1, borderColor: c.hairline, padding: 12, marginBottom: 12 },
  selectedFileName: { fontSize: 13, fontWeight: '600', color: c.text },
  selectedFileUrl: { fontSize: 11, color: c.textMuted, marginTop: 2 },
  orDivider: { fontSize: 11, color: c.iconInactive, textAlign: 'center', fontWeight: '500', letterSpacing: 0.5, marginVertical: 12 },
  busyOverlay: {
    ...StyleSheet.absoluteFill,
    backgroundColor: c.surface,
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 50,
  },
  busyCard: {
    width: '78%',
    maxWidth: 320,
    backgroundColor: c.surface,
    borderRadius: 20,
    paddingVertical: 24,
    paddingHorizontal: 20,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: c.border,
    shadowColor: c.shadow,
    shadowOpacity: 0.12,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 10 },
    elevation: 6,
  },
  busyTitle: {
    marginTop: 12,
    fontSize: 16,
    fontWeight: '800',
    color: c.text,
    textAlign: 'center',
  },
  busySubtitle: {
    marginTop: 6,
    fontSize: 13,
    color: c.textMuted,
    textAlign: 'center',
    lineHeight: 18,
  },
  detailOverlay: { flex: 1, backgroundColor: c.accent },
  detailBackdrop: { ...StyleSheet.absoluteFill },
  detailSheet: { flex: 1, backgroundColor: c.surface, paddingBottom: 18, paddingTop: 12 },
  detailHandle: { width: 36, height: 4, borderRadius: 2, backgroundColor: c.border, alignSelf: 'center', marginTop: 4, marginBottom: 8 },
  detailHead: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', paddingHorizontal: 20, paddingBottom: 14, borderBottomWidth: 1, borderBottomColor: c.hairline },
  detailHeadTextWrap: { flex: 1, paddingRight: 16 },
  detailEyebrow: { fontSize: 9, fontWeight: '700', color: c.iconInactive, letterSpacing: 2, marginBottom: 4, textTransform: 'uppercase' },
  detailTitle: { fontSize: 18, fontWeight: '800', color: c.text, letterSpacing: -0.3 },
  detailCloseBtn: { width: 34, height: 34, borderRadius: 10, backgroundColor: c.surfaceAlt, justifyContent: 'center', alignItems: 'center' },
  detailBody: { flex: 1 },
  detailBodyContent: { paddingHorizontal: 20, paddingTop: 18, paddingBottom: 10, gap: 14 },
  detailBlock: { gap: 6 },
  detailLabel: { fontSize: 10, fontWeight: '700', color: c.iconInactive, letterSpacing: 2, textTransform: 'uppercase' },
  detailText: { fontSize: 14, color: c.text, lineHeight: 21 },
  detailRichPreviewWrap: { flex: 1, minHeight: 300, borderRadius: 14, overflow: 'hidden', borderWidth: 1, borderColor: c.hairline, backgroundColor: c.surface },
detailRichPreview: { flex: 1, backgroundColor: 'transparent' },
  detailMonoText: { fontSize: 13, color: c.text, lineHeight: 20, fontFamily: 'monospace' },
  detailActions: { flexDirection: 'row', gap: 10, paddingHorizontal: 20, paddingTop: 10 },
  detailActionBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: 12, paddingVertical: 13 },
  detailActionBtnSecondary: { backgroundColor: c.surfaceAlt },
  detailActionBtnDestructive: { backgroundColor: c.accent },
  detailActionBtnText: { fontSize: 13, fontWeight: '700', color: c.text },
  detailActionBtnTextDestructive: { fontSize: 13, fontWeight: '700', color: c.accentText },
})
