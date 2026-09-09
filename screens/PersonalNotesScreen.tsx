// screens/PersonalNotesScreen.tsx
import React, { useState, useEffect , useMemo} from 'react'
import {
  View,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  TextInput,
  FlatList,
  Modal,
  StatusBar,
  RefreshControl,
  Animated,
  PanResponder,
  Dimensions,
  KeyboardAvoidingView,
  Platform,
  Keyboard,
} from 'react-native'
import { useAppTheme, type AppColors } from '../lib/theme'
import { useFocusEffect } from '@react-navigation/native'
import { ChordList, Artist } from '../db/models'
import { getCurrentUser } from '../lib/auth'
import { query, execute } from '../db/index'
import uuid from 'react-native-uuid'
import { useRole } from '../lib/useRole'
import { syncRowToSupabase } from '../lib/syncToSupabase'
import { getChordListById } from '../db/queries'
import Ionicons from '@expo/vector-icons/Ionicons'
import { onTableChange } from '../lib/sync'
import { usePullToRefresh } from '../lib/usePullToRefresh'

interface Props {
  navigation: any
}

export default function PersonalNotesScreen({ navigation }: Props) {
  const { colors: c } = useAppTheme()
  const styles = useMemo(() => makeStyles(c), [c])

  const [chordLists, setChordLists] = useState<ChordList[]>([])
  const [filteredLists, setFilteredLists] = useState<ChordList[]>([])
  const [loading, setLoading] = useState(true)
  const [userId, setUserId] = useState<string | null>(null)
  const [searchText, setSearchText] = useState('')
const [searchFocused, setSearchFocused] = useState(false)
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [newListTitle, setNewListTitle] = useState('')
  const [selectedArtist, setSelectedArtist] = useState<string | null>(null)
  const [artists, setArtists] = useState<Artist[]>([])
  const [uploading, setUploading] = useState<string | null>(null) // track by id
  const hasLoadedOnceRef = React.useRef(false)
  const SCREEN_HEIGHT = Dimensions.get('window').height

  const pan = React.useRef(new Animated.Value(0)).current

  const panResponder = React.useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_evt, gestureState) => {
        return gestureState.dy > 5 && Math.abs(gestureState.dy) > Math.abs(gestureState.dx)
      },
      onMoveShouldSetPanResponderCapture: (_evt, gestureState) => {
        return gestureState.dy > 5 && Math.abs(gestureState.dy) > Math.abs(gestureState.dx)
      },
      onPanResponderGrant: () => {
        pan.setValue(0)
      },
      onPanResponderMove: (_evt, gestureState) => {
        if (gestureState.dy > 0) {
          pan.setValue(gestureState.dy)
        }
      },
      onPanResponderRelease: (_evt, gestureState) => {
        if (gestureState.dy > 80) {
          Animated.timing(pan, {
            toValue: SCREEN_HEIGHT,
            duration: 180,
            useNativeDriver: false,
          }).start(() => {
            pan.setValue(0)
            setShowCreateModal(false)
            setNewListTitle('')
          })
        } else {
          Animated.timing(pan, {
            toValue: 0,
            duration: 150,
            useNativeDriver: false,
          }).start()
        }
      },
      onPanResponderTerminationRequest: () => false,
    })
  ).current

    useFocusEffect(
    React.useCallback(() => {
      void loadPersonalNotes({ silent: hasLoadedOnceRef.current })
    }, [])
  )

  useEffect(() => {
    const unsubArtists = onTableChange('artists', () => void loadPersonalNotes({ silent: true }))
    const unsubChordLists = onTableChange('chord_lists', () => void loadPersonalNotes({ silent: true }))

    return () => {
      unsubArtists()
      unsubChordLists()
    }
  }, [])

const handleUploadToCloud = async (noteId: string) => {
  Alert.alert(
    'Upload to Cloud',
    'This note will be backed up to the cloud.',
    [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Upload',
        onPress: async () => {
          try {
            setUploading(noteId)
            const note = await getChordListById(noteId)
            if (note) {
              await syncRowToSupabase('chord_lists', note)
              await loadPersonalNotes()
              Alert.alert('Success', 'Note backed up to cloud!')
            }
          } catch (err) {
            Alert.alert('Error', 'Failed to upload note')
          } finally {
            setUploading(null)
      }
},
        },
    ]
  )
}

  const loadPersonalNotes = async ({ silent = false }: { silent?: boolean } = {}) => {
    try {
      if (!silent) setLoading(true)
      const user = await getCurrentUser()
      if (!user) {
        Alert.alert('Error', 'Not authenticated')
        return
      }
      setUserId(user.id)

            const listRows: any[] = await query(
        'SELECT * FROM chord_lists WHERE user_id = ? AND is_private = 1 ORDER BY updated_at DESC',
        [user.id]
      )
      
      const mapped: ChordList[] = (listRows || []).map(row => ({
        id: row.id,
        title: row.title,
        artistId: row.artist_id,
        userId: row.user_id,
        isPrivate: Boolean(row.is_private),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        synced: Boolean(row._synced),
      }))

      setChordLists(mapped)
      setFilteredLists(mapped)

            const artistRows: any[] = await query(
        'SELECT * FROM artists WHERE user_id = ? ORDER BY name',
        [user.id]
      )
      setArtists((artistRows || []).map(row => ({
        id: row.id,
        name: row.name,
        userId: row.user_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        synced: Boolean(row._synced),
      })))
    } catch (err) {
      console.error('Error loading personal notes:', err)
      Alert.alert('Error', 'Failed to load personal notes')
    } finally {
      hasLoadedOnceRef.current = true
      if (!silent) setLoading(false)
    }
  }

  const { refreshing, onRefresh } = usePullToRefresh(() => loadPersonalNotes({ silent: true }))

  const handleSearch = (text: string) => {
    setSearchText(text)
    setFilteredLists(
chordLists.filter      (list =>
        list.title.toLowerCase().includes(text.toLowerCase())
)
    )
      }

  const handleCreateList = async () => {
    if (!newListTitle.trim()) {
      Alert.alert('Error', 'Please enter a title')
      return
    }
    if (!userId) return

    try {
      let artistId = selectedArtist
      const now = Date.now()

      if (!artistId || artistId === 'new') {
                artistId = uuid.v4() as string
        await execute(
          'INSERT INTO artists (id, name, user_id, created_at, updated_at, _synced) VALUES (?, ?, ?, ?, ?, ?)',
          [artistId, 'Personal', userId, now, now, 0]
        )
      }

            const listId = uuid.v4() as string
      await execute(
        'INSERT INTO chord_lists (id, title, artist_id, user_id, is_private, created_at, updated_at, _synced) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [listId, newListTitle, artistId, userId, 1, now, now, 0]
      )

      setNewListTitle('')
      setSelectedArtist(null)
      setShowCreateModal(false)
      void loadPersonalNotes({ silent: true })
    } catch (err) {
      console.error('Error creating chord list:', err)
      Alert.alert('Error', 'Failed to create chord list')
    }
  }

  const handleDeleteList = async (listId: string) => {
    Alert.alert('Delete Note', 'This will permanently delete the note and its songs.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
style: 'destructive',
        onPress: async () => {
          try {
                        await execute('DELETE FROM songs WHERE chord_list_id = ?', [listId])
                        await execute('DELETE FROM chord_lists WHERE id = ?', [listId])
            void loadPersonalNotes({ silent: true })
          } catch (err) {
            Alert.alert('Error', 'Failed to delete note')
          }
        },
      },
    ])
  }

  const handleSelectList = (list: ChordList) => {
        navigation.navigate('NoteDetail', { noteId: list.id })
  }

  const formatDate = (ts: number) => {
    const d = new Date(ts)
    const now = new Date()
    const diff = now.getTime() - d.getTime()
    const days = Math.floor(diff / (1000 * 60 * 60 * 24))
    if (days === 0) return 'Today'
    if (days === 1) return 'Yesterday'
    if (days < 7) return `${days}d ago`
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  }

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={c.text} />
<Text style={styles.loadingText}>Loading notes…</Text>
      </View>
    )
  }

  const syncedCount = chordLists.filter(l => l.synced).length
  const localCount = chordLists.length - syncedCount

  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor={c.surfaceAlt} />

      {/* ─── HEADER ─── */}
      <View style={styles.header}>
        <View style={styles.headerTop}>
          <View>
            <Text style={styles.headerEyebrow}>PERSONAL</Text>
            <Text style={styles.headerTitle}>Notes</Text>
          </View>
<View style={styles.headerStats}>
        <View style={styles.statPill}>
              <Ionicons name="document-text-outline" size={12} color={c.textMuted} />
              <Text style={styles.statText}>{chordLists.length}</Text>
            </View>
            {localCount > 0 && (
              <View style={[styles.statPill, styles.statPillLocal]}>
                <Ionicons name="phone-portrait-outline" size={12} color={c.textMuted} />
                <Text style={styles.statText}>{localCount} local</Text>
      </View>
            )}
          </View>
        </View>

        {/* Search Bar */}
      <View style={[styles.searchBar, searchFocused && styles.searchBarFocused]}>
          <Ionicons name="search-outline" size={16} color={c.iconInactive} style={{ marginRight: 8 }} />
        <TextInput
          style={styles.searchInput}
          placeholder="Search notes…"
          placeholderTextColor={c.textMuted}
          value={searchText}
          onChangeText={handleSearch}
        onFocus={() => setSearchFocused(true)}
            onBlur={() => setSearchFocused(false)}
          />
          {searchText.length > 0 && (
            <TouchableOpacity onPress={() => handleSearch('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Ionicons name="close-circle" size={16} color={c.iconInactive} />
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* ─── LIST ─── */}
      {filteredLists.length === 0 ? (
        <View style={styles.emptyState}>
          <View style={styles.emptyIconWrap}>
            <Ionicons name="document-text-outline" size={28} color={c.iconInactive} />
          </View>
          <Text style={styles.emptyTitle}>
            {chordLists.length === 0 ? 'No notes yet' : 'No results found'}
</Text>
          <Text style={styles.emptySubtitle}>
            {chordLists.length === 0 ? 'Tap + to create your first note' : `No notes matching "${searchText}"`}
          </Text>
        </View>
      ) : (
        <FlatList
          data={filteredLists}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          refreshing={refreshing}
          onRefresh={onRefresh}
renderItem={({ item, index }) => (
  <TouchableOpacity
    style={styles.noteCard}
    onPress={() => handleSelectList(item)}
  activeOpacity={0.72}
            >
              {/* Left: index number */}
              <View style={styles.noteIndexWrap}>
                <Text style={styles.noteIndex}>{index + 1}</Text>
              </View>

              {/* Center: title + meta */}
              <View style={styles.noteContent}>
      <Text style={styles.noteTitle} numberOfLines={1}>{item.title}</Text>
      <View style={styles.noteMeta}>
        <Text style={styles.noteDate}>{formatDate(item.updatedAt || item.createdAt)}        </Text>
        <Text style={styles.noteDot}>·</Text>
                  <View style={styles.syncChip}>
          <Ionicons
            name={item.synced ? 'cloud-done-outline' : 'phone-portrait-outline'}
            size={10}
            color={item.synced ? c.textMuted : c.textMuted}
          />
          <Text style={[styles.syncChipText, item.synced && styles.syncChipTextSynced]}>
            {item.synced ? 'Backed up' : 'Local'}
          </Text>
        </View>
      </View>
    </View>

{/* Right: actions */}
    <View style={styles.noteActions}>
            {!item.synced && (
        <TouchableOpacity
          style={styles.uploadBtn}
          onPress={(e) => {
            e.stopPropagation()
            handleUploadToCloud(item.id)
          }}
          disabled={uploading === item.id}
                    hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
        >
          {uploading === item.id
            ? <ActivityIndicator size="small" color={c.text} />
            : <Ionicons name="cloud-upload-outline" size={17} color={c.text} />
          }
        </TouchableOpacity>
      )}

      <TouchableOpacity
        style={styles.deleteBtn}
        onPress={(e) => {
          e.stopPropagation()
          handleDeleteList(item.id)
        }}
hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
      >
        <Ionicons name="trash-outline" size={15} color={c.iconInactive} />
      </TouchableOpacity>

                <Ionicons name="chevron-forward" size={14} color={c.iconInactive} />
    </View>
  </TouchableOpacity>
)}
        />
      )}

      {/* ─── FAB ─── */}
      <TouchableOpacity
        style={styles.fab}
        onPress={() => setShowCreateModal(true)}
activeOpacity={0.82}
      >
        <Ionicons name="add" size={24} color={c.accentText} />
      </TouchableOpacity>

      {/* ─── CREATE MODAL ─── */}
      {/* ─── CREATE MODAL ─── */}
<Modal
  visible={showCreateModal}
  transparent
  animationType="slide"
  onRequestClose={() => {
    Keyboard.dismiss()
    setTimeout(() => {
      setShowCreateModal(false)
      setNewListTitle('')
    }, Platform.OS === 'android' ? 150 : 50)
  }}
>
  <KeyboardAvoidingView
    style={{ flex: 1 }}
    behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    keyboardVerticalOffset={0}
  >
    <View style={styles.modalOverlay}>
      <Animated.View style={[styles.modalSheet, { transform: [{ translateY: pan }] }]}>
        <View style={styles.modalDragArea} {...panResponder.panHandlers}>
          <View style={styles.modalHandle} />
          <View style={styles.modalHead}>
            <TouchableOpacity
              onPress={() => {
                Keyboard.dismiss()
                setTimeout(() => {
                  setShowCreateModal(false)
                  setNewListTitle('')
                }, Platform.OS === 'android' ? 150 : 50)
              }}
            >
              <Text style={styles.modalCancel}>Cancel</Text>
            </TouchableOpacity>
            <Text style={styles.modalTitle}>New Note</Text>
            <TouchableOpacity onPress={handleCreateList} style={styles.modalActionBtn}>
              <Text style={styles.modalAction}>Create</Text>
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.modalBody}>
          <Text style={styles.fieldLabel}>TITLE</Text>
          <TextInput
            style={styles.textInput}
            placeholder="Note title…"
            placeholderTextColor={c.textMuted}
            value={newListTitle}
            onChangeText={setNewListTitle}
            autoFocus
            returnKeyType="done"
            onSubmitEditing={handleCreateList}
          />
          <Text style={styles.fieldHint}>
            A "Personal" artist will be created automatically to organize your notes.
          </Text>
        </View>
      </Animated.View>
    </View>
  </KeyboardAvoidingView>
</Modal>
    </View>
  )
}

const makeStyles = (c: AppColors) => StyleSheet.create({
    container: {
    flex: 1,
    backgroundColor: c.surfaceAlt,
  },
  loadingContainer: {
    flex: 1,
backgroundColor: c.surfaceAlt,
    justifyContent: 'center',
    alignItems: 'center',
  gap: 14,
  },
  loadingText: {
    fontSize: 12,
    letterSpacing: 1.4,
    color: c.textMuted,
    textTransform: 'uppercase',
    fontWeight: '600',
  },

  // Header
  header: {
    backgroundColor: c.surface,
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: c.hairline,
    gap: 14,
  },
  headerTop: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
  },
  headerEyebrow: {
    fontSize: 10,
    fontWeight: '700',
    color: c.iconInactive,
    letterSpacing: 2,
    marginBottom: 2,
  },
  headerTitle: {
    fontSize: 28,
    fontWeight: '800',
    color: c.text,
    letterSpacing: -0.8,
    lineHeight: 32,
  },
  headerStats: {
    flexDirection: 'row',
    gap: 6,
    paddingBottom: 4,
  },
  statPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: c.surfaceAlt,
    borderRadius: 8,
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  statPillLocal: {
    backgroundColor: c.surfaceAlt,
  },
  statText: {
    fontSize: 11,
    fontWeight: '700',
    color: c.textMuted,
  },

  // Search
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: c.surfaceAlt,
    borderRadius: 12,
    paddingHorizontal: 13,
    paddingVertical: 11,
    borderWidth: 1.5,
    borderColor: 'transparent',
  },
  searchBarFocused: {
    backgroundColor: c.surface,
    borderColor: c.border,
  },
  searchInput: {
    flex: 1,
        fontSize: 14,
    color: c.text,
    fontWeight: '500',
padding: 0,
  },

  // Empty state
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
gap: 8,
    paddingBottom: 80,
  },
  emptyIconWrap: {
    width: 60,
    height: 60,
borderRadius: 18,
    backgroundColor: c.surfaceAlt,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 8,
  },
  emptyTitle: {
    fontSize: 16,
fontWeight: '700',
    color: c.text,
    letterSpacing: -0.2,
  },
  emptySubtitle: {
    fontSize: 13,
    color: c.iconInactive,
letterSpacing: 0.1,
  },

  // List
  listContent: {
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 100,
  },

  // Note Card
  noteCard: {
        flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: c.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: c.hairline,
    paddingHorizontal: 14,
    paddingVertical: 14,
    marginBottom: 8,
    gap: 12,
  },
  noteIndexWrap: {
    width: 32,
    height: 32,
    borderRadius: 9,
    backgroundColor: c.surfaceAlt,
    justifyContent: 'center',
    alignItems: 'center',
    flexShrink: 0,
  },
  noteIndex: {
    fontSize: 12,
    fontWeight: '800',
    color: c.textMuted,
  },
  noteContent: {
    flex: 1,
    gap: 5,
  },
  noteTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: c.text,
    letterSpacing: -0.2,
  },
  noteMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  noteDate: {
    fontSize: 11,
    color: c.iconInactive,
    fontWeight: '500',
  },
  noteDot: {
    fontSize: 11,
    color: c.iconInactive,
  },
  syncChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  syncChipText: {
    fontSize: 10,
    fontWeight: '600',
    color: c.iconInactive,
  },
  syncChipTextSynced: {
    color: c.textMuted,
  },
  noteActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexShrink: 0,
  },
  uploadBtn: {
    width: 32,
    height: 32,
borderRadius: 9,
    backgroundColor: c.surfaceAlt,
    justifyContent: 'center',
    alignItems: 'center',
    },
  deleteBtn: {
    width: 30,
    height: 30,
    justifyContent: 'center',
    alignItems: 'center',
  },

  // FAB
  fab: {
    position: 'absolute',
    bottom: 28,
    right: 20,
    width: 54,
    height: 54,
    borderRadius: 17,
    backgroundColor: c.accent,
    justifyContent: 'center',
    alignItems: 'center',
elevation: 8,
    shadowColor: c.shadow,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 12,
  },
  
  // Modal
  modalOverlay: {
  flex: 1,
  backgroundColor: c.accent,
  justifyContent: 'flex-end',
},
  modalSheet: {
    backgroundColor: c.surface,
    borderTopLeftRadius: 26,
    borderTopRightRadius: 26,
    paddingBottom: 36,
  },
  modalDragArea: {
    paddingTop: 8,
  },
  modalHandle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: c.border,
    alignSelf: 'center',
    marginTop: 12,
    marginBottom: 4,
  },
  modalHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
      alignItems: 'center',
  paddingHorizontal: 20,
    paddingVertical: 15,
    borderBottomWidth: 1,
    borderBottomColor: c.hairline,
  },
  modalTitle: {
    fontSize: 15,
    fontWeight: '800',
    color: c.text,
letterSpacing: -0.3,
  },
  modalCancel: {
    fontSize: 14,
  color: c.textMuted,
    fontWeight: '500',
    minWidth: 54,
  },
  modalActionBtn: {
    backgroundColor: c.accent,
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 8,
    minWidth: 54,
    alignItems: 'center',
  },
  modalAction: {
    fontSize: 13,
    fontWeight: '700',
    color: c.accentText,
  },
  modalBody: {
    paddingHorizontal: 20,
    paddingTop: 22,
    gap: 8,
  },
  fieldLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: c.iconInactive,
    letterSpacing: 2,
    marginBottom: 1,
  },
  textInput: {
    backgroundColor: c.surfaceAlt,
    borderRadius: 13,
    borderWidth: 1.5,
    borderColor: c.hairline,
    paddingHorizontal: 15,
    paddingVertical: 14,
    fontSize: 15,
    color: c.text,
    fontWeight: '500',
    },
  fieldHint: {
    fontSize: 12,
    color: c.iconInactive,
    lineHeight: 17,
    marginTop: 4,
  },
})