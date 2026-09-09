// screens/ChordListsHomeScreen.tsx
import React, { useState, useEffect, useRef, useMemo } from 'react'
import {
  View,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  Modal,
  TextInput,
  FlatList,
  StatusBar,
  RefreshControl,
} from 'react-native'
import { useAppTheme, type AppColors } from '../lib/theme'
import { useFocusEffect } from '@react-navigation/native'
import Ionicons from '@expo/vector-icons/Ionicons'
import { getCurrentUser } from '../lib/auth'
import { supabase } from '../lib/supabase'
import { query, execute } from '../db/index'
import { isOnline } from '../lib/networkStatus'
import {
  getPlaylistsByUserId,
  createPlaylist,
  deletePlaylist,
  getPlaylistItems,
  addToPlaylist,
  removeFromPlaylist,
  updatePlaylistItemPosition,
} from '../db/queries'
import { PlaylistSongViewerModal } from '../components/PlaylistSongViewerModal'
import { useRole } from '../lib/useRole'
import { onTableChange } from '../lib/sync'
import { usePullToRefresh } from '../lib/usePullToRefresh'
import { isChordListPublic } from '../lib/chordListPrivacy'

interface Props {
  navigation: any
}

interface Playlist {
  id: string
  userId: string
  title: string
  description?: string
  createdAt: number
  updatedAt: number
  synced: boolean
}

interface PlaylistItem {
  id: string
  playlistId: string
  chordListId?: string
  songId?: string
  position: number
  createdAt: number
  synced: boolean
}

interface ArtistBrowseItem {
  id: string
  title: string
  kind: 'song' | 'chord_list'
  chordListId: string
  songId?: string
  createdAt?: number
  updatedAt?: number
}

interface FlatChordItem extends ArtistBrowseItem {
  artistName: string
}

type ChordFilter = 'all' | 'name' | 'artist' | 'recentlyAdded' | 'recentlyUpdated'

const CHORD_FILTERS: { value: ChordFilter; label: string; icon: any }[] = [
  { value: 'all', label: 'All fields', icon: 'search-outline' },
  { value: 'name', label: 'Name', icon: 'musical-note-outline' },
  { value: 'artist', label: 'Artist', icon: 'person-outline' },
  { value: 'recentlyAdded', label: 'Recently added', icon: 'time-outline' },
  { value: 'recentlyUpdated', label: 'Recently updated', icon: 'refresh-outline' },
]

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')

/**
 * How many chord list ids are asked about in one request.
 *
 * The ids go into the query string, so they cannot all travel at once without
 * risking a URL longer than the server will accept. Batches this size keep
 * well inside that and, since they are sent together, cost one round trip
 * rather than one each.
 */
const CHORD_LIST_ID_BATCH = 150

/** Columns in the grid view. Matches the 48%-wide cards in the stylesheet. */
const GRID_COLUMNS = 2

export default function ChordListsHomeScreen({ navigation }: Props) {
  const { colors: c } = useAppTheme()
  const styles = useMemo(() => makeStyles(c), [c])

  const [activeTab, setActiveTab] = useState<'artists' | 'playlists'>('artists')
  const [artists, setArtists] = useState<any[]>([])
  const [expandedArtists, setExpandedArtists] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [playlists, setPlaylists] = useState<Playlist[]>([])
  const [selectedPlaylist, setSelectedPlaylist] = useState<Playlist | null>(null)
  const [playlistItems, setPlaylistItems] = useState<PlaylistItem[]>([])
  // Map of songId/chordListId -> resolved title for playlist display
  const [playlistItemTitles, setPlaylistItemTitles] = useState<Record<string, string>>({})
  const [showCreatePlaylistModal, setShowCreatePlaylistModal] = useState(false)
  const [newPlaylistTitle, setNewPlaylistTitle] = useState('')
  const [newPlaylistDesc, setNewPlaylistDesc] = useState('')
  const [showAddSongModal, setShowAddSongModal] = useState(false)
  const [userId, setUserId] = useState<string>('')
  const [addSongExpandedArtists, setAddSongExpandedArtists] = useState<Set<string>>(new Set())
  const [showSongViewer, setShowSongViewer] = useState(false)
  const [viewerStartIndex, setViewerStartIndex] = useState(0)
  const [viewerSongs, setViewerSongs] = useState<any[]>([])
  const [searchText, setSearchText] = useState('')
  const [chordFilter, setChordFilter] = useState<ChordFilter>('all')
  const [showChordFilterModal, setShowChordFilterModal] = useState(false)
  /** Ids of songs whose lyrics match the search, not just their title */
  const [lyricMatches, setLyricMatches] = useState<Set<string>>(new Set())
  const [gridView, setGridView] = useState(false)
  const artistsListRef = useRef<FlatList<FlatChordItem> | null>(null)
  // artistItems holds songs (or chord lists) per artist, used for both browsing and Add Song modal
  const [artistItems, setArtistItems] = useState<{ [key: string]: ArtistBrowseItem[] }>({})
  const { canManageChords } = useRole()
  const hasLoadedOnceRef = useRef(false)

  useFocusEffect(
    React.useCallback(() => {
      void loadData({ silent: hasLoadedOnceRef.current })
    }, [])
  )

  useEffect(() => {
    const refreshLibrary = () => {
      void loadData({ silent: true })
    }

    const u1 = onTableChange('artists', refreshLibrary)
    const u2 = onTableChange('chord_lists', refreshLibrary)
    const u3 = onTableChange('songs', refreshLibrary)
    const u4 = onTableChange('playlists', refreshLibrary)
    const u5 = onTableChange('playlist_items', refreshLibrary)
    return () => { u1(); u2(); u3(); u4(); u5() }
  }, [])

  const loadData = async ({ silent = false }: { silent?: boolean } = {}) => {
    try {
      if (!silent) setLoading(true)
      const user = await getCurrentUser()
      if (user) {
        setUserId(user.id)
        await Promise.all([loadArtists(), loadPlaylists(user.id)])
      }
    } catch (err) {
      console.error('Error loading data:', err)
      Alert.alert('Error', 'Failed to load data')
    } finally {
      hasLoadedOnceRef.current = true
      if (!silent) setLoading(false)
    }
  }

  const { refreshing, onRefresh } = usePullToRefresh(() => loadData({ silent: true }))

  /**
   * Fold flat rows into the per-artist lists the screen draws.
   *
   * Everything arrives as three flat sets - artists, their chord lists, and
   * the songs inside those lists - and is indexed once here. What used to
   * happen instead was a scan of every chord list and a fresh query for every
   * single artist, which is why opening this screen got slower with each
   * artist added rather than staying the same.
   */
  const buildArtistItems = (
    artistRows: any[],
    chordLists: any[],
    songs: any[],
  ): { [key: string]: ArtistBrowseItem[] } => {
    const listsByArtist: { [key: string]: any[] } = {}
    for (const list of chordLists) {
      const bucket = listsByArtist[list.artist_id]
      if (bucket) bucket.push(list)
      else listsByArtist[list.artist_id] = [list]
    }

    const songsByList: { [key: string]: any[] } = {}
    for (const song of songs) {
      const bucket = songsByList[song.chord_list_id]
      if (bucket) bucket.push(song)
      else songsByList[song.chord_list_id] = [song]
    }

    const itemMap: { [key: string]: ArtistBrowseItem[] } = {}

    for (const artist of artistRows) {
      const lists = listsByArtist[artist.id] || []

      const artistSongs: any[] = []
      for (const list of lists) {
        const inList = songsByList[list.id]
        if (inList) artistSongs.push(...inList)
      }
      // The rows came back sorted by title, but collecting them list by list
      // interleaves those runs. Sorted again so an artist's songs read
      // alphabetically however their chord lists are arranged.
      artistSongs.sort((left, right) => String(left.title).localeCompare(String(right.title)))

      // An artist's songs are what people look for; the chord lists
      // themselves are only shown when there are no songs inside them yet.
      itemMap[artist.id] = artistSongs.length > 0
        ? artistSongs.map(row => ({
            id: row.id,
            title: row.title,
            kind: 'song',
            chordListId: row.chord_list_id,
            songId: row.id,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
          }))
        : lists.map(row => ({
            id: row.id,
            title: row.title,
            kind: 'chord_list',
            chordListId: row.id,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
          }))
    }

    return itemMap
  }

  /**
   * Every song in the given chord lists, in as few requests as possible.
   *
   * The ids travel in the query string, so they are sent in batches rather
   * than as one enormous URL - but the batches go out together, so a big
   * library still costs one round trip's worth of waiting rather than one per
   * batch, let alone the one per artist this replaces.
   */
  const fetchSongsForLists = async (chordListIds: string[]): Promise<any[]> => {
    if (chordListIds.length === 0) return []

    const batches: string[][] = []
    for (let i = 0; i < chordListIds.length; i += CHORD_LIST_ID_BATCH) {
      batches.push(chordListIds.slice(i, i + CHORD_LIST_ID_BATCH))
    }

    const responses = await Promise.all(
      batches.map(batch =>
        supabase
          .from('songs')
          .select('id, title, chord_list_id, created_at, updated_at')
          .in('chord_list_id', batch)
          .order('title'),
      ),
    )

    const rows: any[] = []
    for (const response of responses) {
      if (response.error) throw response.error
      rows.push(...(response.data || []))
    }
    return rows
  }

  /**
   * The library as the phone already has it.
   *
   * Used both when offline and when the server cannot be reached, which is
   * why it is one function - the two used to be identical copies, and a fix
   * to either was a fix to only half the cases.
   */
  const loadArtistsFromCache = async () => {
    const [artistRows, songRows, listRows] = await Promise.all([
      query('SELECT DISTINCT id, name FROM artists ORDER BY name'),
      query(
        `SELECT s.id, s.title, s.chord_list_id, s.created_at, s.updated_at FROM songs s
         JOIN chord_lists cl ON s.chord_list_id = cl.id
         WHERE cl.is_private = 0
         ORDER BY s.title`,
      ),
      query(
        `SELECT id, title, artist_id, created_at, updated_at FROM chord_lists
         WHERE is_private = 0 ORDER BY title`,
      ),
    ]) as [any[], any[], any[]]

    setArtists(artistRows || [])
    setArtistItems(buildArtistItems(artistRows || [], listRows || [], songRows || []))
  }

  const loadArtists = async () => {
    try {
      if (!(await isOnline())) {
        await loadArtistsFromCache()
        return
      }

      // The artists and their chord lists have nothing to say to each other,
      // so they are asked for at the same time.
      const [{ data: artistRows, error: artistError }, { data: chordListRows, error: clError }] =
        await Promise.all([
          supabase.from('artists').select('id, name').order('name'),
          supabase
            .from('chord_lists')
            .select('id, title, artist_id, is_private, created_at, updated_at')
            .order('title'),
        ])

      if (artistError || clError) throw artistError || clError

      const publicChordLists = (chordListRows || []).filter(isChordListPublic)
      const songRows = await fetchSongsForLists(publicChordLists.map(row => row.id))

      setArtists(artistRows || [])
      setArtistItems(buildArtistItems(artistRows || [], publicChordLists, songRows))
    } catch (err) {
      console.error('Error loading artists:', err)
      await loadArtistsFromCache()
    }
  }

  const loadPlaylists = async (uid: string) => {
    try {
      const userPlaylists = await getPlaylistsByUserId(uid)
      setPlaylists(userPlaylists)
    } catch (err) {
      console.error('Error loading playlists:', err)
    }
  }

  /**
   * Resolve a song title: try local SQLite first, fall back to Supabase.
   */
  const resolveSongTitle = async (songId: string): Promise<string> => {
    try {
      const rows: any[] = await query('SELECT title FROM songs WHERE id = ?', [songId])
      if (rows[0]?.title) return rows[0].title
    } catch {}
    // Supabase fallback — catches songs not yet synced locally
    try {
      const { data } = await supabase.from('songs').select('title').eq('id', songId).single()
      if (data?.title) return data.title
    } catch {}
    return `Song ${songId.substring(0, 8)}`
  }

  /**
   * Resolve a chord list title: try local SQLite first, fall back to Supabase.
   */
  const resolveChordListTitle = async (chordListId: string): Promise<string> => {
    try {
      const rows: any[] = await query('SELECT title FROM chord_lists WHERE id = ?', [chordListId])
      if (rows[0]?.title) return rows[0].title
    } catch {}
    try {
      const { data } = await supabase.from('chord_lists').select('title').eq('id', chordListId).single()
      if (data?.title) return data.title
    } catch {}
    return `Chord List ${chordListId.substring(0, 8)}`
  }

  /**
   * Fetch full song row: try local SQLite first, fall back to Supabase.
   */
  const fetchSongRow = async (songId: string): Promise<any | null> => {
    try {
      const rows: any[] = await query('SELECT * FROM songs WHERE id = ?', [songId])
      if (rows[0]) return rows[0]
    } catch {}
    try {
      const { data } = await supabase.from('songs').select('*').eq('id', songId).single()
      if (data) {
        // Normalize snake_case columns to camelCase so the viewer works
        return {
          id: data.id,
          chordListId: data.chord_list_id,
          title: data.title,
          content: data.content,
          key: data.key,
          createdAt: data.created_at,
          updatedAt: data.updated_at,
          synced: Boolean(data._synced),
          userId: data.user_id ?? '',
          youtubeUrl: data.youtube_url,
        }
      }
    } catch {}
    return null
  }

  /**
   * Load playlist items and resolve each item's display title.
   * Uses SQLite first, Supabase as fallback — so newly added songs always resolve.
   */
  const loadPlaylistItems = async (playlistId: string) => {
    try {
      const items = await getPlaylistItems(playlistId)
      setPlaylistItems(items)

      const titleMap: Record<string, string> = {}
      await Promise.all(
        items.map(async item => {
          if (item.songId) {
            titleMap[item.id] = await resolveSongTitle(item.songId)
          } else if (item.chordListId) {
            titleMap[item.id] = await resolveChordListTitle(item.chordListId)
          }
        })
      )
      setPlaylistItemTitles(titleMap)
    } catch (err) {
      console.error('Error loading playlist items:', err)
    }
  }

  const handleOpenSongViewer = async (startIndex: number) => {
    try {
      const songs = await Promise.all(
        playlistItems.map(async item => {
          if (!item.songId) return null
          return fetchSongRow(item.songId)
        })
      )
      setViewerSongs(songs.filter(Boolean))
      setViewerStartIndex(startIndex)
      setShowSongViewer(true)
    } catch (err) {
      Alert.alert('Error', 'Failed to load songs')
    }
  }

  const toggleArtistExpand = (artistId: string) => {
    setExpandedArtists(prev => {
      const next = new Set(prev)
      next.has(artistId) ? next.delete(artistId) : next.add(artistId)
      return next
    })
  }

  const handleSelectSong = (song: ArtistBrowseItem) => {
    navigation.navigate('ChordList', { chordListId: song.chordListId })
  }

  const handleSelectChordList = (chordListId: string) => {
    navigation.navigate('ChordList', { chordListId })
  }

  const handleCreatePlaylist = async () => {
    if (!newPlaylistTitle.trim()) {
      Alert.alert('Error', 'Please enter a playlist name')
      return
    }
    try {
      await createPlaylist({
        userId,
        title: newPlaylistTitle.trim(),
        description: newPlaylistDesc.trim(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        synced: false,
      })
      setNewPlaylistTitle('')
      setNewPlaylistDesc('')
      setShowCreatePlaylistModal(false)
      await loadPlaylists(userId)
    } catch {
      Alert.alert('Error', 'Failed to create playlist')
    }
  }

  const handleDeletePlaylist = (playlistId: string) => {
    Alert.alert('Delete Playlist', 'Are you sure?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await deletePlaylist(playlistId)
            await loadPlaylists(userId)
            if (selectedPlaylist?.id === playlistId) setSelectedPlaylist(null)
          } catch {
            Alert.alert('Error', 'Failed to delete playlist')
          }
        },
      },
    ])
  }

  const handleSelectPlaylist = async (playlist: Playlist) => {
    setSelectedPlaylist(playlist)
    await loadPlaylistItems(playlist.id)
  }

  const handleMoveItemUp = async (index: number) => {
    if (index === 0 || !selectedPlaylist) return
    try {
      const cur = playlistItems[index]
      const prev = playlistItems[index - 1]
      await updatePlaylistItemPosition(cur.id, prev.position)
      await updatePlaylistItemPosition(prev.id, cur.position)
      await loadPlaylistItems(selectedPlaylist.id)
    } catch {
      Alert.alert('Error', 'Failed to reorder')
    }
  }

  const handleMoveItemDown = async (index: number) => {
  if (index >= playlistItems.length - 1 || !selectedPlaylist) return
  try {
    const cur = playlistItems[index]
    const next = playlistItems[index + 1]
    await updatePlaylistItemPosition(cur.id, next.position)
    await updatePlaylistItemPosition(next.id, cur.position)   // ← also move next up
    await loadPlaylistItems(selectedPlaylist.id)
  } catch {
    Alert.alert('Error', 'Failed to reorder')
  }
}

  const visibleArtists = artists.filter(a => (artistItems[a.id] || []).length > 0)
  const normalizedSearch = searchText.trim().toLowerCase()

  /**
   * Songs whose words match the search, as opposed to their title.
   *
   * People remember a line long before they remember what a song is called -
   * "the one about the valley" - and searching titles alone can never find
   * that. The words are read from the local database rather than the server,
   * so this works with no signal, and costs one scan of a table the phone is
   * already holding.
   */
  useEffect(() => {
    // Two letters match half the library; below three it is noise, not a search
    if (normalizedSearch.length < 3) {
      setLyricMatches(new Set())
      return
    }

    let cancelled = false
    const timer = setTimeout(async () => {
      try {
        const rows: any[] = await query(
          'SELECT id FROM songs WHERE content LIKE ? LIMIT 300',
          ['%' + normalizedSearch + '%'],
        )
        if (!cancelled) setLyricMatches(new Set((rows || []).map(r => String(r.id))))
      } catch {
        // A search that cannot reach the words still searches the titles
        if (!cancelled) setLyricMatches(new Set())
      }
    }, 220) // let the typing settle before touching the database

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [normalizedSearch])

  const filteredArtists = useMemo(() => {
    const matchesFilter = (artist: any, item: ArtistBrowseItem) => {
      const matchesArtist = artist.name.toLowerCase().includes(normalizedSearch)
      const matchesName = item.title.toLowerCase().includes(normalizedSearch)
      const matchesLyrics = lyricMatches.has(item.songId || item.id)

      if (!normalizedSearch) return true
      if (chordFilter === 'artist') return matchesArtist
      if (chordFilter === 'name') return matchesName
      return matchesArtist || matchesName || matchesLyrics
    }

    const results = visibleArtists
      .map(artist => {
        const items = artistItems[artist.id] || []
        const matchesArtist = artist.name.toLowerCase().includes(normalizedSearch)
        const matchingItems = items.filter(item => matchesFilter(artist, item))

        if (matchingItems.length === 0) {
          return null
        }

        const filteredItems = chordFilter === 'artist' && matchesArtist ? items : matchingItems
        const sortedItems = chordFilter === 'recentlyAdded' || chordFilter === 'recentlyUpdated'
          ? [...filteredItems].sort((left, right) => {
              const timestamp = chordFilter === 'recentlyAdded' ? 'createdAt' : 'updatedAt'
              return (right[timestamp] || 0) - (left[timestamp] || 0)
            })
          : filteredItems

        return {
          ...artist,
          filteredItems: sortedItems,
        }
      })
      .filter(Boolean) as any[]

    if (chordFilter === 'recentlyAdded' || chordFilter === 'recentlyUpdated') {
      const timestamp = chordFilter === 'recentlyAdded' ? 'createdAt' : 'updatedAt'
      return results.sort((left, right) => {
        const leftLatest = Math.max(...(left.filteredItems || []).map((item: ArtistBrowseItem) => item[timestamp] || 0))
        const rightLatest = Math.max(...(right.filteredItems || []).map((item: ArtistBrowseItem) => item[timestamp] || 0))
        return rightLatest - leftLatest
      })
    }

    return results
  }, [artistItems, chordFilter, normalizedSearch, visibleArtists, lyricMatches])

  const flatChordItems = useMemo(() => {
    const items: FlatChordItem[] = []
    for (const artist of filteredArtists) {
      for (const item of artist.filteredItems || []) {
        items.push({ ...item, artistName: artist.name })
      }
    }

    if (chordFilter === 'recentlyAdded' || chordFilter === 'recentlyUpdated') {
      const timestamp = chordFilter === 'recentlyAdded' ? 'createdAt' : 'updatedAt'
      items.sort((left, right) => (right[timestamp] || 0) - (left[timestamp] || 0))
    } else if (chordFilter === 'artist') {
      items.sort((left, right) => {
        const artistOrder = left.artistName.localeCompare(right.artistName)
        return artistOrder || left.title.localeCompare(right.title)
      })
    } else {
      items.sort((left, right) => left.title.localeCompare(right.title))
    }
    return items
  }, [chordFilter, filteredArtists])

  const availableLetters = useMemo(() => {
    const letters = new Set(
      flatChordItems.map(item => {
        const firstCharacter = item.title.trim().charAt(0).toUpperCase()
        return /^[A-Z]$/.test(firstCharacter) ? firstCharacter : '#'
      }),
    )
    return letters
  }, [flatChordItems])

  const jumpToLetter = (letter: string) => {
    const index = flatChordItems.findIndex(item => {
      const firstCharacter = item.title.trim().charAt(0).toUpperCase()
      return (letter === '#' ? !/^[A-Z]$/.test(firstCharacter) : firstCharacter === letter)
    })
    if (index < 0) return
    // Asked for by position rather than by a measured offset. The list only
    // keeps the rows near the viewport mounted now, so most rows have never
    // been laid out and have no offset to jump to - but their position is
    // known whether they have been drawn or not.
    artistsListRef.current?.scrollToIndex({
      index: gridView ? Math.floor(index / GRID_COLUMNS) : index,
      animated: true,
      viewPosition: 0,
    })
  }

  const filteredPlaylists = useMemo(() => {
    if (!normalizedSearch) return playlists

    return playlists.filter(playlist => {
      const titleMatch = playlist.title.toLowerCase().includes(normalizedSearch)
      const descMatch = (playlist.description || '').toLowerCase().includes(normalizedSearch)
      return titleMatch || descMatch
    })
  }, [normalizedSearch, playlists])

  const filteredPlaylistItems = useMemo(() => {
    if (!normalizedSearch) return playlistItems

    return playlistItems.filter(item => {
      const title = playlistItemTitles[item.id] || ''
      return title.toLowerCase().includes(normalizedSearch)
    })
  }, [normalizedSearch, playlistItemTitles, playlistItems])

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={c.text} />
        <Text style={styles.loadingText}>Loading library…</Text>
      </View>
    )
  }

  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor={c.surfaceAlt} />

      {/* HEADER */}
      <View style={styles.header}>
        <Text style={styles.headerLogo}>♩</Text>
        <Text style={styles.headerTitle}>Chord Library</Text>
      </View>

      {/* TAB BAR */}
      <View style={styles.tabBar}>
        {(['artists', 'playlists'] as const).map(tab => (
          <TouchableOpacity
            key={tab}
            style={[styles.tab, activeTab === tab && styles.tabActive]}
            onPress={() => setActiveTab(tab)}
            activeOpacity={0.7}
          >
            <Text style={[styles.tabLabel, activeTab === tab && styles.tabLabelActive]}>
              {tab === 'artists' ? 'Songs' : 'Playlists'}
            </Text>
            {activeTab === tab && <View style={styles.tabUnderline} />}
          </TouchableOpacity>
        ))}
      </View>

      <View style={styles.controlsRow}>
        <View style={styles.searchBar}>
          <Ionicons name="search-outline" size={16} color={c.iconInactive} style={{ marginRight: 8 }} />
          <TextInput
            style={styles.searchInput}
            placeholder={
              activeTab === 'artists'
                ? 'Search artists, songs, or a line of lyrics…'
                : selectedPlaylist
                  ? 'Search playlist items…'
                  : 'Search playlists…'
            }
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
              <Ionicons name="close-circle" size={16} color={c.iconInactive} />
            </TouchableOpacity>
          )}
        </View>

        <TouchableOpacity
          style={styles.viewModeBtn}
          onPress={() => setGridView(prev => !prev)}
          activeOpacity={0.75}
          accessibilityRole="button"
          accessibilityLabel={gridView ? 'Switch to list view' : 'Switch to grid view'}
        >
          <Ionicons name={gridView ? 'list-outline' : 'grid-outline'} size={18} color={c.text} />
        </TouchableOpacity>

        {activeTab === 'artists' && (
          <TouchableOpacity
            style={[styles.viewModeBtn, chordFilter !== 'all' && styles.filterBtnActive]}
            onPress={() => setShowChordFilterModal(true)}
            activeOpacity={0.75}
            accessibilityRole="button"
            accessibilityLabel="Filter chord lists"
          >
            <Ionicons name="options-outline" size={18} color={chordFilter !== 'all' ? c.accentText : c.text} />
          </TouchableOpacity>
        )}
      </View>

      {activeTab === 'artists' && chordFilter !== 'all' && (
        <View style={styles.activeFilterRow}>
          <Text style={styles.activeFilterText}>
            {CHORD_FILTERS.find(filter => filter.value === chordFilter)?.label}
          </Text>
          <TouchableOpacity onPress={() => setChordFilter('all')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Ionicons name="close-circle" size={16} color={c.iconInactive} />
          </TouchableOpacity>
        </View>
      )}

      {/* ─── ARTISTS TAB ─── */}
      {activeTab === 'artists' && (
        <>
          {flatChordItems.length === 0 ? (
            <EmptyState
              icon="people-outline"
              title={normalizedSearch ? 'No matches found' : 'No songs yet'}
              subtitle={normalizedSearch ? 'Try a different search term' : 'Create a public chord list to get started'}
            />
          ) : (
            <View style={styles.libraryBody}>
              <FlatList
                ref={artistsListRef}
                data={flatChordItems}
                keyExtractor={item => item.id}
                // Changing the column count changes the shape of every row,
                // which the list holds on to - remounting is how it is told.
                key={gridView ? 'grid' : 'rows'}
                numColumns={gridView ? GRID_COLUMNS : 1}
                columnWrapperStyle={gridView ? styles.flatItemGrid : undefined}
                style={styles.list}
                contentContainerStyle={styles.listContent}
                showsVerticalScrollIndicator={false}
                refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
                ListHeaderComponent={
                  <Text style={styles.sectionLabel}>{flatChordItems.length} SONGS</Text>
                }
                // Enough to fill the screen, and no more. A library of any
                // size used to build every single row before anything at all
                // could be shown, which is the wait this removes.
                initialNumToRender={12}
                maxToRenderPerBatch={12}
                windowSize={9}
                removeClippedSubviews
                // Rows are not measured up front, so a jump to a letter far
                // down the list can be asked for before those rows exist.
                // Scroll to roughly the right place and let the list fill in.
                onScrollToIndexFailed={info => {
                  artistsListRef.current?.scrollToOffset({
                    offset: info.averageItemLength * info.index,
                    animated: true,
                  })
                }}
                renderItem={({ item }) => (
                  <View style={gridView ? styles.flatItemGridEntry : undefined}>
                    <TouchableOpacity
                      style={[styles.flatItem, gridView && styles.flatItemGridCard]}
                      onPress={() =>
                        item.kind === 'song'
                          ? handleSelectSong(item)
                          : handleSelectChordList(item.chordListId)
                      }
                      activeOpacity={0.7}
                    >
                      <View style={styles.flatItemMonogram}>
                        <Text style={styles.flatItemMonogramText}>{item.title.trim().charAt(0).toUpperCase()}</Text>
                      </View>
                      <View style={styles.flatItemMeta}>
                        <Text style={styles.flatItemTitle} numberOfLines={1}>{item.title}</Text>
                        <Text style={styles.flatItemArtist} numberOfLines={1}>{item.artistName}</Text>
                      </View>
                      {selectedPlaylist && (
                        <TouchableOpacity
                          style={styles.addBtn}
                          onPress={async () => {
                            try {
                              const maxPos = playlistItems.length > 0
                                ? Math.max(...playlistItems.map(i => i.position)) + 1
                                : 0
                              await addToPlaylist({
                                playlistId: selectedPlaylist.id,
                                songId: item.kind === 'song' ? item.songId : undefined,
                                chordListId: item.chordListId,
                                position: maxPos,
                                createdAt: Date.now(),
                                synced: false,
                                userId,
                              })
                              await loadPlaylistItems(selectedPlaylist.id)
                              Alert.alert('Added', `"${item.title}" added to playlist`)
                            } catch {
                              Alert.alert('Error', 'Failed to add song')
                            }
                          }}
                          hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                        >
                          <Ionicons name="add" size={18} color={c.text} />
                        </TouchableOpacity>
                      )}
                      <Ionicons name="chevron-forward" size={14} color={c.iconInactive} />
                    </TouchableOpacity>
                  </View>
                )}
              />

              <View style={styles.alphabetRail}>
                {ALPHABET.map(letter => {
                  const available = availableLetters.has(letter)
                  return (
                    <TouchableOpacity
                      key={letter}
                      style={styles.alphabetLetter}
                      onPress={() => jumpToLetter(letter)}
                      disabled={!available}
                      hitSlop={{ top: 2, bottom: 2, left: 4, right: 4 }}
                    >
                      <Text style={[styles.alphabetLetterText, !available && styles.alphabetLetterDisabled]}>
                        {letter}
                      </Text>
                    </TouchableOpacity>
                  )
                })}
              </View>
            </View>
          )}
          {canManageChords && <FAB onPress={() => navigation.navigate('AddSong', {})} icon="add" />}
        </>
      )}

      {/* ─── PLAYLISTS TAB ─── */}
      {activeTab === 'playlists' && (
        <>
          {!selectedPlaylist ? (
            <>
              {filteredPlaylists.length === 0 ? (
                <EmptyState
                  icon="musical-note-outline"
                  title={normalizedSearch ? 'No matches found' : 'No playlists yet'}
                  subtitle={normalizedSearch ? 'Try a different search term' : 'Tap + to create your first playlist'}
                />
              ) : (
                <ScrollView
                  style={styles.list}
                  contentContainerStyle={styles.listContent}
                  showsVerticalScrollIndicator={false}
                  refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
                >
                  <Text style={styles.sectionLabel}>{filteredPlaylists.length} PLAYLISTS</Text>
                  <View style={gridView ? styles.playlistGrid : undefined}>
                    {filteredPlaylists.map((playlist, idx) => (
                      <TouchableOpacity
                        key={playlist.id}
                        style={[styles.playlistCard, gridView && styles.playlistCardGrid]}
                        onPress={() => handleSelectPlaylist(playlist)}
                        activeOpacity={0.72}
                      >
                        {gridView ? (
                          <View style={styles.playlistCardGridBody}>
                            <View style={styles.playlistGridMonogram}>
                              <Text style={styles.playlistGridMonogramText}>
                                {playlist.title.charAt(0).toUpperCase()}
                              </Text>
                            </View>

                            <View style={styles.playlistCardContentGridMatch}>
                              <Text style={styles.playlistTitle} numberOfLines={2}>
                                {playlist.title}
                              </Text>
                              <Text style={styles.playlistDescGrid} numberOfLines={2}>
                                {playlist.description || `Playlist ${idx + 1}`}
                              </Text>
                            </View>

                            <View style={styles.playlistCardActionsGrid}>
                              <TouchableOpacity
                                onPress={() => handleDeletePlaylist(playlist.id)}
                                style={styles.deleteBtn}
                                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                              >
                                <Ionicons name="trash-outline" size={16} color={c.iconInactive} />
                              </TouchableOpacity>
                              <View style={styles.chevronWrap}>
                                <Ionicons name="chevron-forward" size={13} color={c.iconInactive} />
                              </View>
                            </View>
                          </View>
                        ) : (
                          <>
                            <View style={styles.playlistNumberBox}>
                              <Text style={styles.playlistNumber}>{idx + 1}</Text>
                            </View>
                            <View style={styles.playlistCardContent}>
                              <Text style={styles.playlistTitle} numberOfLines={1}>
                                {playlist.title}
                              </Text>
                              {playlist.description ? (
                                <Text style={styles.playlistDesc} numberOfLines={1}>
                                  {playlist.description}
                                </Text>
                              ) : null}
                            </View>
                            <View style={styles.playlistCardActions}>
                              <TouchableOpacity
                                onPress={() => handleDeletePlaylist(playlist.id)}
                                style={styles.deleteBtn}
                                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                              >
                                <Ionicons name="trash-outline" size={16} color={c.iconInactive} />
                              </TouchableOpacity>
                              <Ionicons name="chevron-forward" size={15} color={c.iconInactive} />
                            </View>
                          </>
                        )}
                      </TouchableOpacity>
                    ))}
                  </View>
                </ScrollView>
              )}
              <FAB onPress={() => setShowCreatePlaylistModal(true)} icon="add" />
            </>
          ) : (
            /* ─── PLAYLIST DETAIL ─── */
            <View style={styles.flex1}>
              <TouchableOpacity
                style={styles.detailHeader}
                onPress={() => setSelectedPlaylist(null)}
                activeOpacity={0.7}
              >
                <View style={styles.detailBackBtn}>
                  <Ionicons name="arrow-back" size={16} color={c.text} />
                </View>
                <View style={styles.detailHeaderMeta}>
                  <Text style={styles.detailHeaderLabel}>PLAYLIST</Text>
                  <Text style={styles.detailHeaderTitle}>{selectedPlaylist.title}</Text>
                </View>
                <View style={styles.detailBadge}>
                  <Text style={styles.detailBadgeText}>{playlistItems.length}</Text>
                </View>
              </TouchableOpacity>

              {filteredPlaylistItems.length === 0 ? (
                <EmptyState
                  icon="musical-notes-outline"
                  title={normalizedSearch ? 'No matches found' : 'No songs yet'}
                  subtitle={normalizedSearch ? 'Try a different search term' : 'Tap + to add songs to this playlist'}
                />
              ) : (
                <FlatList
                  data={filteredPlaylistItems}
                  keyExtractor={item => item.id}
                  contentContainerStyle={styles.listContent}
                  showsVerticalScrollIndicator={false}
                  refreshing={refreshing}
                  onRefresh={onRefresh}
                  renderItem={({ item, index }) => {
                    const title = playlistItemTitles[item.id] ?? '…'
                    const actualIndex = playlistItems.findIndex(playlistItem => playlistItem.id === item.id)
                    const isFirst = actualIndex === 0
                    const isLast = actualIndex === playlistItems.length - 1
                    return (
                      <TouchableOpacity
                        style={styles.playlistItemRow}
                        onPress={() => handleOpenSongViewer(actualIndex)}
                        activeOpacity={0.65}
                      >
                        <Text style={styles.itemIndex}>{actualIndex + 1}</Text>
                        <Text style={styles.itemTitle}>{title}</Text>

                        {/* Reorder buttons */}
                        <View style={styles.reorderBtns}>
                          <TouchableOpacity
                            style={[styles.reorderBtn, isFirst && styles.reorderBtnDisabled]}
                            onPress={() => handleMoveItemUp(actualIndex)}
                            disabled={isFirst}
                            hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                          >
                            <Ionicons name="chevron-up" size={14} color={isFirst ? c.iconInactive : c.textSub} />
                          </TouchableOpacity>
                          <TouchableOpacity
                            style={[styles.reorderBtn, isLast && styles.reorderBtnDisabled]}
                            onPress={() => handleMoveItemDown(actualIndex)}
                            disabled={isLast}
                            hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                          >
                            <Ionicons name="chevron-down" size={14} color={isLast ? c.iconInactive : c.textSub} />
                          </TouchableOpacity>
                        </View>

                        <TouchableOpacity
                          onPress={async e => {
                            try {
                              await removeFromPlaylist(item.id)
                              await loadPlaylistItems(selectedPlaylist.id)
                            } catch {
                              Alert.alert('Error', 'Failed to remove item')
                            }
                          }}
                          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                          style={styles.removeBtn}
                        >
                          <Ionicons name="close" size={16} color={c.iconInactive} />
                        </TouchableOpacity>
                      </TouchableOpacity>
                    )
                  }}
                />
              )}

              <FAB onPress={() => setShowAddSongModal(true)} icon="add" />
            </View>
          )}
        </>
      )}

      {/* ─── CHORD LIST FILTER MODAL ─── */}
      <Modal
        visible={showChordFilterModal}
        transparent
        animationType="slide"
        onRequestClose={() => setShowChordFilterModal(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalSheet}>
            <View style={styles.modalHandle} />
            <View style={styles.modalHead}>
              <TouchableOpacity onPress={() => setShowChordFilterModal(false)}>
                <Text style={styles.modalCancel}>Cancel</Text>
              </TouchableOpacity>
              <Text style={styles.modalTitle}>Filter chord lists</Text>
              <View style={{ width: 54 }} />
            </View>
            <View style={styles.filterOptions}>
              {CHORD_FILTERS.map(filter => {
                const selected = chordFilter === filter.value
                return (
                  <TouchableOpacity
                    key={filter.value}
                    style={[styles.filterOption, selected && styles.filterOptionSelected]}
                    onPress={() => {
                      setChordFilter(filter.value)
                      setShowChordFilterModal(false)
                    }}
                    activeOpacity={0.7}
                  >
                    <Ionicons name={filter.icon} size={18} color={selected ? c.accentText : c.textSub} />
                    <Text style={[styles.filterOptionText, selected && styles.filterOptionTextSelected]}>
                      {filter.label}
                    </Text>
                    {selected && <Ionicons name="checkmark" size={18} color={c.accentText} />}
                  </TouchableOpacity>
                )
              })}
            </View>
          </View>
        </View>
      </Modal>

      {/* ─── CREATE PLAYLIST MODAL ─── */}
      <Modal visible={showCreatePlaylistModal} transparent animationType="slide" onRequestClose={() => setShowCreatePlaylistModal(false)}>
        <View style={[styles.modalOverlay, { justifyContent: 'flex-start' }]}>
          <View style={[styles.modalSheet, { flex: 1, borderTopLeftRadius: 0, borderTopRightRadius: 0, paddingBottom: 18 }]}> 
            <View style={styles.modalHead}>
              <TouchableOpacity onPress={() => setShowCreatePlaylistModal(false)}>
                <Text style={styles.modalCancel}>Cancel</Text>
              </TouchableOpacity>
              <Text style={styles.modalTitle}>New Playlist</Text>
              <TouchableOpacity onPress={handleCreatePlaylist} style={styles.modalActionBtn}>
                <Text style={styles.modalAction}>Create</Text>
              </TouchableOpacity>
            </View>
            <View style={[styles.modalBody, { flex: 1 }]}>
              <Text style={styles.fieldLabel}>NAME</Text>
              <TextInput
                style={styles.textInput}
                placeholder="Untitled playlist"
                placeholderTextColor={c.textMuted}
                value={newPlaylistTitle}
                onChangeText={setNewPlaylistTitle}
                autoFocus
              />
              <Text style={[styles.fieldLabel, { marginTop: 22 }]}>DESCRIPTION</Text>
              <TextInput
                style={[styles.textInput, styles.textArea]}
                placeholder="Optional note or description"
                placeholderTextColor={c.textMuted}
                value={newPlaylistDesc}
                onChangeText={setNewPlaylistDesc}
                multiline
                numberOfLines={3}
              />
            </View>
          </View>
        </View>
      </Modal>

      {/* ─── ADD SONG MODAL ─── */}
      {/* Uses artistItems (already loaded) — sorted by artist, then song title */}
      <Modal visible={showAddSongModal} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={[styles.modalSheet, { maxHeight: '82%' }]}>
            <View style={styles.modalHandle} />
            <View style={styles.modalHead}>
              <TouchableOpacity onPress={() => setShowAddSongModal(false)}>
                <Text style={styles.modalCancel}>Cancel</Text>
              </TouchableOpacity>
              <Text style={styles.modalTitle}>Add Song</Text>
              <View style={{ width: 54 }} />
            </View>

            <ScrollView style={styles.modalScrollBody} showsVerticalScrollIndicator={false}>
              {artists
                .filter(a => (artistItems[a.id] || []).length > 0)
                .map(artist => (
                  <View key={artist.id}>
                    <TouchableOpacity
                      style={styles.modalArtistRow}
                      onPress={() => {
                        setAddSongExpandedArtists(prev => {
                          const next = new Set(prev)
                          next.has(artist.id) ? next.delete(artist.id) : next.add(artist.id)
                          return next
                        })
                      }}
                      activeOpacity={0.7}
                    >
                      <View style={styles.modalArtistMonogram}>
                        <Text style={styles.modalArtistMonogramText}>
                          {artist.name.charAt(0).toUpperCase()}
                        </Text>
                      </View>
                      <Text style={styles.modalArtistName}>{artist.name}</Text>
                      <Ionicons
                        name={addSongExpandedArtists.has(artist.id) ? 'chevron-up' : 'chevron-down'}
                        size={15}
                        color={c.iconInactive}
                      />
                    </TouchableOpacity>

                    {addSongExpandedArtists.has(artist.id) && (
                      <View style={styles.modalSongGroup}>
                        {(artistItems[artist.id] || []).map((item, idx) => (
                          <TouchableOpacity
                            key={item.id}
                            style={[
                              styles.modalSongRow,
                              idx < (artistItems[artist.id] || []).length - 1 &&
                                styles.modalSongRowBorder,
                            ]}
                            onPress={async () => {
                              if (!selectedPlaylist) return
                              try {
                                const maxPos =
                                  playlistItems.length > 0
                                    ? Math.max(...playlistItems.map(i => i.position)) + 1
                                    : 0
                                await addToPlaylist({
                                  playlistId: selectedPlaylist.id,
                                  songId: item.kind === 'song' ? item.songId : undefined,
                                  chordListId: item.chordListId,
                                  position: maxPos,
                                  createdAt: Date.now(),
                                  synced: false,
                                  userId,
                                })
                                await loadPlaylistItems(selectedPlaylist.id)
                                setShowAddSongModal(false)
                                Alert.alert('Added', `"${item.title}" added`)
                              } catch {
                                Alert.alert('Error', 'Failed to add song')
                              }
                            }}
                            activeOpacity={0.6}
                          >
                            <Text style={styles.modalSongTitle}>{item.title}</Text>
                            <View style={styles.addCircle}>
                              <Ionicons name="add" size={14} color={c.accentText} />
                            </View>
                          </TouchableOpacity>
                        ))}
                      </View>
                    )}
                  </View>
                ))}
              <View style={{ height: 20 }} />
            </ScrollView>
          </View>
        </View>
      </Modal>

      <PlaylistSongViewerModal
        visible={showSongViewer}
        songs={viewerSongs}
        startIndex={viewerStartIndex}
        onClose={() => setShowSongViewer(false)}
      />
    </View>
  )
}

/* ─── SHARED COMPONENTS ─── */

function EmptyState({ icon, title, subtitle }: { icon: any; title: string; subtitle: string }) {
  const { colors: c } = useAppTheme()
  const styles = useMemo(() => makeStyles(c), [c])

  return (
    <View style={styles.emptyState}>
      <View style={styles.emptyIconWrap}>
        <Ionicons name={icon} size={28} color={c.iconInactive} />
      </View>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptySubtitle}>{subtitle}</Text>
    </View>
  )
}

function FAB({ onPress, icon }: { onPress: () => void; icon: any }) {
  const { colors: c } = useAppTheme()
  const styles = useMemo(() => makeStyles(c), [c])

  return (
    <TouchableOpacity style={styles.fab} onPress={onPress} activeOpacity={0.82}>
      <Ionicons name={icon} size={24} color={c.accentText} />
    </TouchableOpacity>
  )
}

/* ─── STYLES ─── */
const makeStyles = (c: AppColors) => StyleSheet.create({
  flex1: { flex: 1 },
  container: { flex: 1, backgroundColor: c.surfaceAlt },

  loadingContainer: { flex: 1, backgroundColor: c.surfaceAlt, justifyContent: 'center', alignItems: 'center', gap: 14 },
  loadingText: { fontSize: 12, letterSpacing: 1.4, color: c.textMuted, textTransform: 'uppercase', fontWeight: '600' },

  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingTop: 16, paddingBottom: 12, backgroundColor: c.surfaceAlt, gap: 10 },
  headerLogo: { fontSize: 22, color: c.text, lineHeight: 28 },
  headerTitle: { fontSize: 20, fontWeight: '800', color: c.text, letterSpacing: -0.5 },

  tabBar: { flexDirection: 'row', backgroundColor: c.surfaceAlt, borderBottomWidth: 1, borderBottomColor: c.hairline, paddingHorizontal: 20 },
  tab: { paddingVertical: 13, marginRight: 28, position: 'relative' },
  tabActive: {},
  tabLabel: { fontSize: 13, fontWeight: '600', color: c.iconInactive, letterSpacing: 0.3 },
  tabLabelActive: { color: c.text },
  tabUnderline: { position: 'absolute', bottom: -1, left: 0, right: 0, height: 2, backgroundColor: c.accent, borderRadius: 1 },

  controlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 20,
    paddingTop: 14,
    paddingBottom: 4,
  },
  searchBar: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: c.surfaceAlt,
    borderRadius: 12,
    paddingHorizontal: 13,
    paddingVertical: 11,
    borderWidth: 1.5,
    borderColor: 'transparent',
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    color: c.text,
    fontWeight: '500',
    padding: 0,
  },
  viewModeBtn: {
    width: 42,
    height: 42,
    borderRadius: 12,
    backgroundColor: c.surfaceAlt,
    borderWidth: 1.5,
    borderColor: c.hairline,
    alignItems: 'center',
    justifyContent: 'center',
  },
  filterBtnActive: { backgroundColor: c.accent, borderColor: c.accent },
  activeFilterRow: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: 7, marginLeft: 20, marginTop: 8, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 9, backgroundColor: c.accent },
  activeFilterText: { fontSize: 11, fontWeight: '700', color: c.accentText },

  sectionLabel: { fontSize: 10, fontWeight: '700', color: c.iconInactive, letterSpacing: 1.8, marginBottom: 12, marginTop: 4 },

  list: { flex: 1 },
  listContent: { paddingHorizontal: 16, paddingTop: 18, paddingBottom: 100 },
  libraryBody: { flex: 1, flexDirection: 'row' },
  flatItemGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' },
  flatItemGridEntry: { width: '48%' },
  flatItem: { flexDirection: 'row', alignItems: 'center', marginTop: 8, paddingHorizontal: 12, paddingVertical: 11, gap: 10, backgroundColor: c.surface, borderRadius: 14, borderWidth: 1, borderColor: c.hairline },
  flatItemGridCard: { minHeight: 104, alignItems: 'flex-start', paddingHorizontal: 12, paddingVertical: 12 },
  flatItemMonogram: { width: 36, height: 36, borderRadius: 10, backgroundColor: c.surfaceAlt, justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: c.border },
  flatItemMonogramText: { fontSize: 14, fontWeight: '800', color: c.textSub },
  flatItemMeta: { flex: 1, gap: 3 },
  flatItemTitle: { fontSize: 14, fontWeight: '700', color: c.text },
  flatItemArtist: { fontSize: 11, fontWeight: '500', color: c.iconInactive },
  alphabetRail: { width: 28, alignItems: 'center', justifyContent: 'center', paddingVertical: 14, paddingRight: 4 },
  alphabetLetter: { width: 24, height: 20, alignItems: 'center', justifyContent: 'center' },
  alphabetLetterText: { fontSize: 10, lineHeight: 14, fontWeight: '800', color: c.accent },
  alphabetLetterDisabled: { color: c.border },

  emptyState: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 8, paddingBottom: 80 },
  emptyIconWrap: { width: 60, height: 60, borderRadius: 18, backgroundColor: c.surfaceAlt, justifyContent: 'center', alignItems: 'center', marginBottom: 8 },
  emptyTitle: { fontSize: 16, fontWeight: '700', color: c.text, letterSpacing: -0.2 },
  emptySubtitle: { fontSize: 13, color: c.iconInactive, letterSpacing: 0.1 },

  artistBlock: { marginTop: 10, borderRadius: 16, overflow: 'hidden', backgroundColor: c.surface, borderWidth: 1, borderColor: c.hairline },
  artistBlockGrid: { width: '48%', minHeight: 122 },
  artistGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' },
  artistRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 13, gap: 12 },
  artistRowGrid: { flexDirection: 'column', alignItems: 'flex-start', paddingHorizontal: 14, paddingVertical: 15, gap: 10, minHeight: 122 },
  artistMonogram: { width: 38, height: 38, borderRadius: 11, backgroundColor: c.surfaceAlt, justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: c.border },
  artistMonogramActive: { backgroundColor: c.accent, borderColor: c.accent },
  artistMonogramText: { fontSize: 15, fontWeight: '800', color: c.textSub, letterSpacing: -0.3 },
  artistMonogramTextActive: { color: c.accentText },
  artistMeta: { flex: 1, gap: 2 },
  artistMetaGrid: { flex: 0, width: '100%', gap: 4 },
  artistName: { fontSize: 15, fontWeight: '700', color: c.text, letterSpacing: -0.2 },
  artistSongCount: { fontSize: 11, color: c.iconInactive, fontWeight: '500', letterSpacing: 0.2 },
  artistSongCountGrid: { color: c.textMuted, fontSize: 12 },
  chevronWrap: { width: 28, height: 28, borderRadius: 8, backgroundColor: c.surfaceAlt, justifyContent: 'center', alignItems: 'center' },
  chevronWrapGrid: { marginTop: 'auto', alignSelf: 'flex-end' },

  songList: { borderTopWidth: 1, borderTopColor: c.hairline, backgroundColor: c.surface },
  songRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14 },
  songRowBorder: { borderBottomWidth: 1, borderBottomColor: c.hairline },
  songRowInner: { flex: 1, flexDirection: 'row', alignItems: 'center', paddingVertical: 13, gap: 10 },
  songIndex: { fontSize: 11, fontWeight: '700', color: c.iconInactive, minWidth: 18 },
  songTitle: { fontSize: 13.5, color: c.textSub, flex: 1, fontWeight: '500', letterSpacing: 0.1 },
  addBtn: { width: 32, height: 32, borderRadius: 9, backgroundColor: c.surfaceAlt, justifyContent: 'center', alignItems: 'center', marginLeft: 8 },

  playlistCard: { flexDirection: 'row', alignItems: 'center', marginTop: 10, backgroundColor: c.surface, borderRadius: 16, borderWidth: 1, borderColor: c.hairline, paddingHorizontal: 14, paddingVertical: 14, gap: 12 },
  playlistCardGrid: { width: '48%', minHeight: 122, paddingHorizontal: 14, paddingVertical: 15 },
  playlistGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' },
  playlistCardGridBody: { width: '100%', minHeight: 122, gap: 10 },
  playlistGridMonogram: { width: 38, height: 38, borderRadius: 11, backgroundColor: c.surfaceAlt, justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: c.border },
  playlistGridMonogramText: { fontSize: 15, fontWeight: '800', color: c.textSub, letterSpacing: -0.3 },
  playlistNumberBox: { width: 38, height: 38, borderRadius: 11, backgroundColor: c.surfaceAlt, justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: c.border },
  playlistNumber: { fontSize: 14, fontWeight: '800', color: c.textMuted },
  playlistCardContent: { flex: 1, gap: 3 },
  playlistCardContentGridMatch: { width: '100%', gap: 4 },
  playlistTitle: { fontSize: 15, fontWeight: '700', color: c.text, letterSpacing: -0.2 },
  playlistDesc: { fontSize: 12, color: c.iconInactive, fontWeight: '400' },
  playlistDescGrid: { fontSize: 12, color: c.textMuted, fontWeight: '500' },
  playlistCardActions: { flexDirection: 'row', alignItems: 'center', gap: 2, marginLeft: 'auto', marginTop: 'auto' },
  playlistCardActionsGrid: { marginTop: 'auto', marginLeft: 'auto', flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-end' },
  deleteBtn: { width: 30, height: 30, justifyContent: 'center', alignItems: 'center' },

  detailHeader: { flexDirection: 'row', alignItems: 'center', backgroundColor: c.surface, paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: c.hairline, gap: 12 },
  detailBackBtn: { width: 34, height: 34, borderRadius: 10, backgroundColor: c.surfaceAlt, justifyContent: 'center', alignItems: 'center' },
  detailHeaderMeta: { flex: 1, gap: 2 },
  detailHeaderLabel: { fontSize: 9, fontWeight: '700', color: c.iconInactive, letterSpacing: 2 },
  detailHeaderTitle: { fontSize: 15, fontWeight: '800', color: c.text, letterSpacing: -0.3 },
  detailBadge: { backgroundColor: c.accent, borderRadius: 9, paddingHorizontal: 10, paddingVertical: 4, minWidth: 28, alignItems: 'center' },
  detailBadgeText: { fontSize: 12, fontWeight: '800', color: c.accentText },

  // Playlist item row with inline reorder
  playlistItemRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: c.surface, marginTop: 8, borderRadius: 13, borderWidth: 1, borderColor: c.hairline, paddingHorizontal: 14, paddingVertical: 12, gap: 10 },
  itemIndex: { fontSize: 11, fontWeight: '800', color: c.iconInactive, minWidth: 20 },
  itemTitle: { flex: 1, fontSize: 14, color: c.text, fontWeight: '600', letterSpacing: -0.1 },
  reorderBtns: { flexDirection: 'column', gap: 2 },
  reorderBtn: { width: 24, height: 24, borderRadius: 6, backgroundColor: c.surfaceAlt, justifyContent: 'center', alignItems: 'center' },
  reorderBtnDisabled: { opacity: 0.35 },
  removeBtn: { width: 28, height: 28, borderRadius: 8, backgroundColor: c.surfaceAlt, justifyContent: 'center', alignItems: 'center' },

  fab: { position: 'absolute', bottom: 28, right: 20, width: 54, height: 54, borderRadius: 17, backgroundColor: c.accent, justifyContent: 'center', alignItems: 'center', elevation: 8, shadowColor: c.shadow, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.2, shadowRadius: 12 },

  modalOverlay: { flex: 1, backgroundColor: c.accent, justifyContent: 'flex-end' },
  modalSheet: { backgroundColor: c.surface, borderTopLeftRadius: 26, borderTopRightRadius: 26, paddingBottom: 36 },
  modalHandle: { width: 36, height: 4, borderRadius: 2, backgroundColor: c.border, alignSelf: 'center', marginTop: 12, marginBottom: 4 },
  modalHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 15, borderBottomWidth: 1, borderBottomColor: c.hairline },
  modalTitle: { fontSize: 15, fontWeight: '800', color: c.text, letterSpacing: -0.3 },
  modalCancel: { fontSize: 14, color: c.textMuted, fontWeight: '500', minWidth: 54 },
  modalActionBtn: { backgroundColor: c.accent, borderRadius: 10, paddingHorizontal: 16, paddingVertical: 8, minWidth: 54, alignItems: 'center' },
  modalAction: { fontSize: 13, fontWeight: '700', color: c.accentText },
  modalBody: { paddingHorizontal: 20, paddingTop: 22 },
  modalScrollBody: { paddingHorizontal: 20, paddingTop: 10 },
  filterOptions: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 20, gap: 8 },
  filterOption: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48, paddingHorizontal: 14, borderRadius: 12, backgroundColor: c.surfaceAlt },
  filterOptionSelected: { backgroundColor: c.accent },
  filterOptionText: { flex: 1, fontSize: 14, fontWeight: '600', color: c.textSub },
  filterOptionTextSelected: { color: c.accentText },
  fieldLabel: { fontSize: 10, fontWeight: '700', color: c.iconInactive, letterSpacing: 2, marginBottom: 9, textTransform: 'uppercase' },
  textInput: { backgroundColor: c.surfaceAlt, borderRadius: 13, borderWidth: 1.5, borderColor: c.hairline, paddingHorizontal: 15, paddingVertical: 14, fontSize: 15, color: c.text, fontWeight: '500' },
  textArea: { minHeight: 82, textAlignVertical: 'top' },

  modalArtistRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: c.hairline, gap: 10 },
  modalArtistMonogram: { width: 32, height: 32, borderRadius: 9, backgroundColor: c.surfaceAlt, justifyContent: 'center', alignItems: 'center' },
  modalArtistMonogramText: { fontSize: 13, fontWeight: '800', color: c.textSub },
  modalArtistName: { flex: 1, fontSize: 14, fontWeight: '700', color: c.text, letterSpacing: -0.1 },
  modalSongGroup: { backgroundColor: c.surface, marginLeft: 12, borderLeftWidth: 2, borderLeftColor: c.hairline, paddingLeft: 12, marginBottom: 4 },
  modalSongRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, gap: 10 },
  modalSongRowBorder: { borderBottomWidth: 1, borderBottomColor: c.hairline },
  modalSongTitle: { flex: 1, fontSize: 13.5, color: c.textSub, fontWeight: '500' },
  addCircle: { width: 26, height: 26, borderRadius: 8, backgroundColor: c.accent, justifyContent: 'center', alignItems: 'center' },
})