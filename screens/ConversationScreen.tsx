import React, { useEffect, useState , useMemo} from 'react'
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  Modal,
  Alert,
  Pressable,
  Image,
  FlatList,
  RefreshControl,
} from 'react-native'
import { useAppTheme, type AppColors } from '../lib/theme'
import { CameraView, Camera, BarcodeScanningResult } from '../components/ScannerCamera'
import Ionicons from '@expo/vector-icons/Ionicons'
import { getCurrentUser } from '../lib/auth'
import { createMessage, query as dbQuery, editMessage, deleteMessage, getUserProfileByUserId } from '../db/queries'
import { Message, UserProfile } from '../db/models'
import { useFocusEffect } from '@react-navigation/native'
import UserProfileModal from './UserProfileModal'
import { onTableChange } from '../lib/sync'
import { execute } from '../db/index'
import { supabase } from '../lib/supabase'
import { usePullToRefresh } from '../lib/usePullToRefresh'
import { dayLabel, isSameDay, timeLabel } from '../lib/dayLabels'

export default function ConversationScreen() {
  const { colors: c } = useAppTheme()
  const styles = useMemo(() => makeStyles(c), [c])

  const [userId, setUserId] = useState<string>('')
  const [messages, setMessages] = useState<Message[]>([])
  const [overallChatMessages, setOverallChatMessages] = useState<Message[]>([])
  const [messageText, setMessageText] = useState('')
  const [receiverId, setReceiverId] = useState('')
  const [chatMode, setChatMode] = useState<'direct' | 'overall'>('overall')
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null)
  const [showEditModal, setShowEditModal] = useState(false)
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null)
  const [editingText, setEditingText] = useState('')
  const [scrollViewRef, setScrollViewRef] = useState<any>(null)
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null)
  const [userProfiles, setUserProfiles] = useState<Map<string, UserProfile>>(new Map())
  const [contactedUsers, setContactedUsers] = useState<any[]>([])
  const [showNewConversationModal, setShowNewConversationModal] = useState(false)
  const [newRecipientId, setNewRecipientId] = useState('')
  const [activeUserIds, setActiveUserIds] = useState<Set<string>>(new Set())
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null)
  const [profileModalUserId, setProfileModalUserId] = useState<string | null>(null)
  const [scannerVisible, setScannerVisible] = useState(false)
  const [hasPermission, setHasPermission] = useState<boolean | null>(null)
  const [scanned, setScanned] = useState(false)

  const OVERALL_CHAT_ID = 'overall-chat'
  const userIdRef = React.useRef('')
  const userProfilesRef = React.useRef<Map<string, UserProfile>>(new Map())

  const getMessageTimestamp = (row: any) => {
    const timestamp = row?.updated_at ?? row?.edited_at ?? row?.created_at ?? 0
    return typeof timestamp === 'number' ? timestamp : Number(timestamp) || 0
  }

  const loadCurrentUserProfile = async (id: string) => {
    const profile = await getUserProfileByUserId(id)
    setUserProfile(profile)
    return profile
  }

  const mergeRowsById = (rows: any[]) => {
    const merged = new Map<string, any>()
    for (const row of rows) {
      if (!row?.id) continue
      const current = merged.get(row.id)
      if (!current || getMessageTimestamp(row) >= getMessageTimestamp(current)) {
        merged.set(row.id, row)
      }
    }
    return [...merged.values()]
  }

  useEffect(() => {
    const loadUser = async () => {
      const user = await getCurrentUser()
      if (user) {
        setUserId(user.id)
        userIdRef.current = user.id
        await loadCurrentUserProfile(user.id)
        await Promise.all([
          loadMessages(user.id),
          loadOverallChat(user.id),
          loadUsers(),
          loadContactedUsers(user.id),
        ])
      }
    }
    loadUser()
  }, [])

  const loadMessages = async (id: string) => {
    try {
      const [{ data: sentMessages }, { data: receivedMessages }, localSent, localReceived] = await Promise.all([
        supabase
          .from('messages')
          .select('*')
          .eq('sender_id', id)
          .neq('receiver_id', OVERALL_CHAT_ID)
          .eq('is_deleted', 0)
          .order('created_at', { ascending: true }),
        supabase
          .from('messages')
          .select('*')
          .eq('receiver_id', id)
          .neq('receiver_id', OVERALL_CHAT_ID)
          .eq('is_deleted', 0)
          .order('created_at', { ascending: true }),
        dbQuery(
          `SELECT * FROM messages WHERE sender_id = ? AND receiver_id != ? AND COALESCE(is_deleted, 0) = 0 ORDER BY created_at ASC`,
          [id, OVERALL_CHAT_ID]
        ),
        dbQuery(
          `SELECT * FROM messages WHERE receiver_id = ? AND receiver_id != ? AND COALESCE(is_deleted, 0) = 0 ORDER BY created_at ASC`,
          [id, OVERALL_CHAT_ID]
        ),
      ])

      const rows = mergeRowsById([
        ...(sentMessages || []),
        ...(receivedMessages || []),
        ...(localSent || []),
        ...(localReceived || []),
      ])

      const mapMessage = (row: any): Message => ({
        id: row.id,
        senderId: row.sender_id,
        receiverId: row.receiver_id,
        text: row.text,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        isDeleted: Boolean(row.is_deleted),
        editedAt: row.edited_at,
        synced: Boolean(row._synced),
      })

      const allMessages = rows.map(mapMessage).sort((a, b) => a.createdAt - b.createdAt)

      setMessages([...allMessages])
      const loadedProfiles = await loadUsers()
      setTimeout(() => scrollViewRef?.scrollToEnd({ animated: true }), 100)

      const senderIds = new Set(allMessages.map(m => m.senderId))
      const profilesMap = new Map<string, UserProfile>(loadedProfiles)
      for (const senderId of senderIds) {
        if (!profilesMap.has(senderId)) {
          const profile = await getProfileWithFallback(senderId)
          if (profile) profilesMap.set(senderId, profile)
        }
      }

      setUserProfiles(profilesMap)
      userProfilesRef.current = profilesMap
      setTimeout(() => scrollViewRef?.scrollToEnd({ animated: true }), 100)
    } catch (err) {
      console.error('Error loading messages:', err)
    }
  }

  const loadOverallChat = async (id: string) => {
    try {
      const [{ data }, localResults] = await Promise.all([
        supabase
          .from('messages')
          .select('*')
          .eq('receiver_id', OVERALL_CHAT_ID)
          .eq('is_deleted', 0)
          .order('created_at', { ascending: true }),
        dbQuery(
          `SELECT * FROM messages WHERE receiver_id = ? AND COALESCE(is_deleted, 0) = 0 ORDER BY created_at ASC`,
          [OVERALL_CHAT_ID]
        ),
      ])

      const results = mergeRowsById([...(data || []), ...(localResults || [])])

      const mapMessage = (row: any): Message => ({
        id: row.id,
        senderId: row.sender_id,
        receiverId: row.receiver_id,
        text: row.text,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        isDeleted: Boolean(row.is_deleted),
        editedAt: row.edited_at,
        synced: Boolean(row._synced),
      })

      const mapped = results.map(mapMessage)
      setOverallChatMessages([...mapped])
      const loadedProfiles = await loadUsers()

      const senderIds = new Set(mapped.map(m => m.senderId))
      const profilesMap = new Map<string, UserProfile>(loadedProfiles)
      for (const senderId of senderIds) {
        if (!profilesMap.has(senderId)) {
          const profile = await getProfileWithFallback(senderId)
          if (profile) profilesMap.set(senderId, profile)
        }
      }
      setUserProfiles(profilesMap)
      setTimeout(() => scrollViewRef?.scrollToEnd({ animated: true }), 100)
    } catch (err) {
      console.error('Error loading overall chat:', err)
    }
  }

  const handleSendMessage = async () => {
    if (!messageText.trim()) {
      Alert.alert('Notice', 'Please enter a message')
      return
    }
    if (chatMode === 'direct' && !receiverId.trim()) {
      Alert.alert('Notice', 'Please select a recipient')
      return
    }
    try {
      await createMessage({
        senderId: userId,
        receiverId: chatMode === 'overall' ? OVERALL_CHAT_ID : receiverId,
        text: messageText,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        isDeleted: false,
        synced: false,
      })
      setMessageText('')
      if (chatMode === 'overall') {
        await loadOverallChat(userId)
      } else {
        await loadMessages(userId)
        await loadContactedUsers(userId)
      }
    } catch (err) {
      console.error('Error sending message:', err)
      Alert.alert('Error', 'Failed to send message')
    }
  }

  const handleStartConversation = async (targetUserId: string) => {
    setChatMode('direct')
    setReceiverId(targetUserId)
    setShowNewConversationModal(false)
    setScannerVisible(false)
    setScanned(false)
    setNewRecipientId('')

    try {
      const profile = await getProfileWithFallback(targetUserId)
      if (profile) {
        setUserProfiles(prev => {
          const updated = new Map(prev)
          updated.set(targetUserId, profile)
          return updated
        })
      }
      if (userId) {
        await loadContactedUsers(userId)
      }
    } catch (err) {
      console.warn('Failed to resolve recipient profile:', err)
    }
  }

  const resolveRecipientIdFromQr = (data: string) => {
    try {
      const parsed = JSON.parse(data)
      if (parsed?.type === 'savedworship:recipient' && typeof parsed.userId === 'string') {
        return parsed.userId.trim()
      }
    } catch (err) {
      // Not JSON, fall through to raw value handling.
    }
    return data.trim()
  }

  const handleScanQRCode = async () => {
    const { status } = await Camera.requestCameraPermissionsAsync()
    if (status === 'granted') {
      setHasPermission(true)
      setScanned(false)
      setScannerVisible(true)
    } else {
      Alert.alert('Permission Required', 'Please enable camera access to scan QR codes.', [{ text: 'OK' }])
    }
  }

  const handleBarCodeScanned = ({ data }: BarcodeScanningResult) => {
    if (scanned) return
    setScanned(true)
    setScannerVisible(false)
    const recipientId = resolveRecipientIdFromQr(data)
    if (!recipientId) {
      Alert.alert('Invalid QR Code', 'This QR code does not contain a recipient ID.')
      setScanned(false)
      return
    }
    handleStartConversation(recipientId)
  }

  const closeScanner = () => {
    setScannerVisible(false)
    setScanned(false)
  }

  // ─── FIX: capture ID before clearing state, search across all messages ────
  const handleOpenEditModal = (msgId: string) => {
    // Search across ALL messages (both overall + direct) so we never get undefined
    const msg = [...messages, ...overallChatMessages].find(m => m.id === msgId)
    if (!msg) return
    setEditingMessageId(msgId)
    setEditingText(msg.text)
    setSelectedMessageId(null)   // close action menu first
    setTimeout(() => setShowEditModal(true), 50) // open edit modal after menu closes
  }

  const handleOpenDeleteConfirm = (msgId: string) => {
    setSelectedMessageId(null) // close action menu first
    setTimeout(() => handleDeleteMessage(msgId), 50) // delete after menu closes
  }
  // ─────────────────────────────────────────────────────────────────────────

  // ✅ EDIT — optimistically update text, then persist
const handleEditMessage = async () => {
  if (!editingText.trim() || !editingMessageId) return

  const msgId = editingMessageId
  const newText = editingText.trim()

  // Immediately update in both arrays
  const applyEdit = (msgs: Message[]) =>
    msgs.map(m => m.id === msgId
      ? { ...m, text: newText, editedAt: Date.now() }
      : m
    )
  setOverallChatMessages(prev => applyEdit(prev))
  setMessages(prev => applyEdit(prev))

  setEditingMessageId(null)
  setEditingText('')
  setShowEditModal(false)

  try {
    await editMessage(msgId, newText)
    // Reload to sync with DB
    if (chatMode === 'overall') {
      await loadOverallChat(userId)
    } else {
      await loadMessages(userId)
    }
  } catch (err) {
    Alert.alert('Error', 'Failed to edit message')
    // Reload to revert
    if (chatMode === 'overall') {
      await loadOverallChat(userId)
    } else {
      await loadMessages(userId)
    }
  }
}

  // ✅ DELETE — optimistically mark deleted, then persist
const handleDeleteMessage = async (messageId: string) => {
  Alert.alert('Delete Message', 'Are you sure you want to remove this message?', [
    { text: 'Cancel' },
    {
      text: 'Delete',
      style: 'destructive',
      onPress: async () => {
        // Immediately mark as deleted in UI
        const applyDelete = (msgs: Message[]) =>
          msgs.map(m => m.id === messageId ? { ...m, isDeleted: true } : m)
        setOverallChatMessages(prev => applyDelete(prev))
        setMessages(prev => applyDelete(prev))

        try {
          await deleteMessage(messageId)
          if (chatMode === 'overall') {
            await loadOverallChat(userId)
          } else {
            await loadMessages(userId)
          }
        } catch (err) {
          Alert.alert('Error', 'Failed to delete message')
          // Reload to revert
          if (chatMode === 'overall') {
            await loadOverallChat(userId)
          } else {
            await loadMessages(userId)
          }
        }
      },
    },
  ])
}

  const handleDeleteConversation = (otherUserId: string, nickname: string) => {
    Alert.alert(
      'Remove Conversation',
      `Remove your conversation with ${nickname}?`,
      [
        { text: 'Cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            try {
              await Promise.all([
                execute(
                  `DELETE FROM messages WHERE 
                  (sender_id = ? AND receiver_id = ?) OR 
                  (sender_id = ? AND receiver_id = ?)`,
                  [userId, otherUserId, otherUserId, userId]
                ),
                supabase
                  .from('messages')
                  .delete()
                  .eq('sender_id', userId)
                  .eq('receiver_id', otherUserId),
                supabase
                  .from('messages')
                  .delete()
                  .eq('sender_id', otherUserId)
                  .eq('receiver_id', userId),
              ])

              if (receiverId === otherUserId) setReceiverId('')
              setSelectedConversationId(null)
              await loadMessages(userId)
              await loadContactedUsers(userId)
            } catch (err) {
              console.error('Error deleting conversation:', err)
              Alert.alert('Error', 'Failed to remove conversation')
            }
          },
        },
      ]
    )
  }

  const getProfileWithFallback = async (targetUserId: string): Promise<UserProfile | null> => {
    const local = await getUserProfileByUserId(targetUserId)
    if (local && (local.nickname || local.avatarUrl || local.bio || local.instruments)) return local
    try {
      const { supabase } = await import('../lib/supabase')
      const { data } = await supabase
        .from('user_profiles')
        .select('*')
        .eq('user_id', targetUserId)
        .single()
      if (data) {
        const { execute } = await import('../db/index')
        try {
          await execute(
            `INSERT OR REPLACE INTO user_profiles 
             (id, user_id, nickname, bio, avatar_url, instruments, role, created_at, updated_at, _synced)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
            [
              data.id ?? targetUserId,
              data.user_id,
              data.nickname ?? '',
              data.bio ?? '',
              data.avatar_url ?? '',
              data.instruments ?? '',
              data.role ?? 'user',
              data.created_at ?? Date.now(),
              data.updated_at ?? Date.now(),
            ]
          )
        } catch (e) {}
        return {
          id: data.id,
          userId: data.user_id,
          nickname: data.nickname ?? '',
          bio: data.bio ?? '',
          avatarUrl: data.avatar_url ?? '',
          instruments: data.instruments ?? '',
          createdAt: data.created_at ?? Date.now(),
          updatedAt: data.updated_at ?? Date.now(),
          synced: true,
          role: data.role ?? 'user',
        }
      }
    } catch (e) {
      console.warn('Failed to fetch profile from Supabase:', e)
    }
    return null
  }

  const loadUsers = async (): Promise<Map<string, UserProfile>> => {
    try {
      const { data } = await supabase.from('user_profiles').select('*')
      const allProfiles: any[] = data && data.length > 0 ? data : await dbQuery(`SELECT * FROM user_profiles`)
      const profilesMap = new Map<string, UserProfile>()
      for (const row of allProfiles) {
        profilesMap.set(row.user_id, {
          id: row.id,
          userId: row.user_id,
          nickname: row.nickname || '',
          bio: row.bio || '',
          avatarUrl: row.avatar_url || '',
          instruments: row.instruments || '',
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          synced: Boolean(row._synced),
          role: row.role ?? 'user',
        })
      }
      setUserProfiles(profilesMap)
      userProfilesRef.current = profilesMap
      return profilesMap
    } catch (err) {
      console.error('Error loading users:', err)
      return new Map<string, UserProfile>()
    }
  }

  const loadContactedUsers = async (id: string) => {
    try {
      const [sent, received, localSent, localReceived] = await Promise.all([
        supabase
          .from('messages')
          .select('id, sender_id, receiver_id, text, created_at, updated_at')
          .eq('sender_id', id)
          .neq('receiver_id', OVERALL_CHAT_ID)
          .eq('is_deleted', 0)
          .order('created_at', { ascending: false }),
        supabase
          .from('messages')
          .select('id, sender_id, receiver_id, text, created_at, updated_at')
          .eq('receiver_id', id)
          .neq('receiver_id', OVERALL_CHAT_ID)
          .eq('is_deleted', 0)
          .order('created_at', { ascending: false }),
        dbQuery(
          `SELECT id, sender_id, receiver_id, text, created_at, updated_at FROM messages 
            WHERE sender_id = ?
            AND receiver_id != ?
            AND COALESCE(is_deleted, 0) = 0
            ORDER BY created_at DESC`,
          [id, OVERALL_CHAT_ID]
        ),
        dbQuery(
          `SELECT id, sender_id, receiver_id, text, created_at, updated_at FROM messages 
            WHERE receiver_id = ?
            AND receiver_id != ?
            AND COALESCE(is_deleted, 0) = 0
            ORDER BY created_at DESC`,
          [id, OVERALL_CHAT_ID]
        ),
      ])
      const results: any[] = mergeRowsById([
        ...(sent.data || []),
        ...(received.data || []),
        ...(localSent || []),
        ...(localReceived || []),
      ])
      const userMap = new Map<string, { lastContacted: number; lastMessage: string }>()
      results.forEach((msg: any) => {
        const otherUserId = msg.sender_id === id ? msg.receiver_id : msg.sender_id
        if (!userMap.has(otherUserId)) {
          userMap.set(otherUserId, {
            lastContacted: msg.created_at,
            lastMessage: msg.text,
          })
        }
      })
      const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000
      const contactList = []
      for (const [uid, data] of userMap.entries()) {
        if (data.lastContacted > thirtyDaysAgo) {
          const profile = await getUserProfileByUserId(uid)
          contactList.push({
            id: uid,
            nickname: profile?.nickname || 'Member',
            avatar: profile?.avatarUrl,
            lastContacted: data.lastContacted,
            lastMessage: data.lastMessage,
          })
        }
      }
      contactList.sort((a, b) => b.lastContacted - a.lastContacted)
      setContactedUsers(contactList)
    } catch (err) {
      console.error('Error loading contacted users:', err)
    }
  }

  const refreshConversationData = async () => {
    const id = userIdRef.current || userId
    if (!id) return
    await Promise.all([
      loadCurrentUserProfile(id),
      loadMessages(id),
      loadOverallChat(id),
      loadUsers(),
      loadContactedUsers(id),
    ])
  }

  const { refreshing, onRefresh } = usePullToRefresh(refreshConversationData)

  const directConversationMessages = messages.filter(
    m =>
      (m.senderId === userId && m.receiverId === receiverId) ||
      (m.senderId === receiverId && m.receiverId === userId)
  )

  useEffect(() => {
    if (!userId) return

    const unsubMessages = onTableChange('messages', () => {
      const id = userIdRef.current
      if (!id) return
      loadOverallChat(id)
      loadMessages(id)
      loadContactedUsers(id)
    })

    const unsubProfiles = onTableChange('user_profiles', () => {
      const id = userIdRef.current
      if (id) {
        void loadCurrentUserProfile(id)
        loadContactedUsers(id)
      }
      loadUsers()
    })

    const unsubContacts = onTableChange('contacts', () => {
      const id = userIdRef.current
      if (!id) return
      loadContactedUsers(id)
    })

    const messageChannel = supabase
      .channel(`conversation-messages-${userIdRef.current}`)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'messages',
        filter: `sender_id=eq.${userIdRef.current}`,
      }, () => {
        const id = userIdRef.current
        if (!id) return
        loadOverallChat(id)
        loadMessages(id)
        loadContactedUsers(id)
      })
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'messages',
        filter: `receiver_id=eq.${userIdRef.current}`,
      }, () => {
        const id = userIdRef.current
        if (!id) return
        loadOverallChat(id)
        loadMessages(id)
        loadContactedUsers(id)
      })
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'messages',
        filter: `receiver_id=eq.overall-chat`,
      }, () => {
        const id = userIdRef.current
        if (!id) return
        loadOverallChat(id)
        loadMessages(id)
        loadContactedUsers(id)
      })
      .subscribe()

    const profileChannel = supabase
      .channel(`conversation-profiles-${userIdRef.current}`)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'user_profiles',
      }, () => {
        const id = userIdRef.current
        if (!id) return
        loadUsers()
        loadContactedUsers(id)
      })
      .subscribe()

    const contactsChannel = supabase
      .channel(`conversation-contacts-${userIdRef.current}`)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'contacts',
        filter: `user_id=eq.${userIdRef.current}`,
      }, () => {
        const id = userIdRef.current
        if (!id) return
        loadContactedUsers(id)
      })
      .subscribe()

    return () => {
      unsubMessages()
      unsubProfiles()
      unsubContacts()
      supabase.removeChannel(messageChannel)
      supabase.removeChannel(profileChannel)
      supabase.removeChannel(contactsChannel)
    }
  }, [userId])

  useFocusEffect(
    React.useCallback(() => {
      const id = userIdRef.current || userId
      if (!id) return
      void refreshConversationData()
    }, [userId])
  )

  const currentMessages = chatMode === 'overall' ? overallChatMessages : directConversationMessages
  const isEmpty = currentMessages.length === 0

  /**
   * A message, with the date above it when the day has changed.
   *
   * The date is written once per day rather than on every message: the first
   * message of a day carries it, and everything after it that day needs only
   * a time. Send something now underneath yesterday's conversation and a
   * "Today" line appears between the two - which is the moment the date
   * actually tells you something.
   */
  const renderMessageBubble = (msg: Message, index?: number, all?: Message[]) => {
    const previous = typeof index === 'number' && all ? all[index - 1] : undefined
    const startsNewDay = !previous || !isSameDay(previous.createdAt, msg.createdAt)

    const dayDivider = startsNewDay ? (
      <View style={styles.dayDivider}>
        <View style={styles.dayDividerLine} />
        <Text style={styles.dayDividerText}>{dayLabel(msg.createdAt)}</Text>
        <View style={styles.dayDividerLine} />
      </View>
    ) : null

    const isOwn = msg.senderId === userId
    const senderProfile = userProfiles.get(msg.senderId)
    const displayProfile = isOwn ? userProfile : senderProfile
    const displayNickname = isOwn
      ? userProfile?.nickname || 'You'
      : senderProfile?.nickname || 'Member'

    if (msg.isDeleted) {
      return (
        <React.Fragment key={msg.id}>
          {dayDivider}
          <View style={styles.deletedWrapper}>
            <Text style={styles.deletedMessageText}>
              — This message has been removed —
            </Text>
          </View>
        </React.Fragment>
      )
    }

    const avatarContent =
      displayProfile?.avatarUrl && displayProfile.avatarUrl.trim() !== '' ? (
        <Image source={{ uri: displayProfile.avatarUrl }} style={styles.messageSenderAvatar} />
      ) : (
        <View style={[styles.messageSenderAvatarPlaceholder, isOwn && styles.ownAvatarPlaceholder]}>
          <Ionicons name="person" size={15} color={isOwn ? c.accentText : c.textMuted} />
        </View>
      )

    const avatar = (
      <TouchableOpacity
        onPress={() => setProfileModalUserId(msg.senderId)}
        activeOpacity={0.75}
      >
        {avatarContent}
      </TouchableOpacity>
    )

    return (
      <React.Fragment key={msg.id}>
        {dayDivider}
        <Pressable
          // ─── FIX: allow long-press on own messages only ───────────────────
          onLongPress={() => isOwn ? setSelectedMessageId(msg.id) : null}
          style={styles.messageWrapper}
        >
        <Text style={[styles.messageSenderNickname, isOwn && styles.messageSenderNicknameOwn]}>
          {displayNickname}
        </Text>
        <View style={[styles.messageRow, isOwn && styles.messageRowOwn]}>
          {!isOwn && avatar}
          <View style={[styles.messageBubble, isOwn && styles.ownMessage]}>
            <Text style={[styles.messageText, isOwn && styles.ownMessageText]}>{msg.text}</Text>
            <View style={styles.messageFooter}>
              <Text style={[styles.timestamp, isOwn && styles.ownTimestamp]}>
                {timeLabel(msg.createdAt)}
              </Text>
              {msg.editedAt && (
                <Text style={[styles.editedBadge, isOwn && styles.ownEditedBadge]}>· edited</Text>
              )}
            </View>
          </View>
          {isOwn && avatar}
          </View>
        </Pressable>
      </React.Fragment>
    )
  }

  const renderDirectMessagesPanel = () => (
    <ScrollView
      style={styles.dmPanel}
      showsVerticalScrollIndicator={false}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      <View style={[styles.sectionBlock, { marginTop: 24 }]}>
        <View style={styles.sectionHeaderRow}>
          <View style={styles.sectionAccentLine} />
          <Text style={styles.sectionHeader}>CONVERSATIONS</Text>
        </View>
        {contactedUsers.length === 0 ? (
          <View style={styles.emptySection}>
            <Ionicons name="chatbubble-ellipses-outline" size={36} color={c.iconInactive} />
            <Text style={styles.emptySectionText}>No conversations yet</Text>
            <Text style={styles.emptySectionSub}>Start a conversation using recipient ID or QR code</Text>
          </View>
        ) : (
          <View style={{ paddingHorizontal: 16 }}>
            {contactedUsers.map((contact, index) => {
              const isSelected = selectedConversationId === contact.id
              return (
                <View key={contact.id}>
                  {index > 0 && <View style={styles.divider} />}
                  <Pressable
                    style={[styles.conversationItem, isSelected && styles.conversationItemSelected]}
                    onPress={() => {
                      if (isSelected) {
                        setSelectedConversationId(null)
                      } else {
                        handleStartConversation(contact.id)
                      }
                    }}
                    onLongPress={() => setSelectedConversationId(contact.id)}
                  >
                    <TouchableOpacity
                      onPress={() => setProfileModalUserId(contact.id)}
                      style={styles.convAvatarWrapper}
                    >
                      {contact.avatar ? (
                        <Image source={{ uri: contact.avatar }} style={styles.convAvatar} />
                      ) : (
                        <View style={styles.convAvatarPlaceholder}>
                          <Ionicons name="person" size={18} color={c.textMuted} />
                        </View>
                      )}
                      {activeUserIds.has(contact.id) && <View style={styles.activeDotSmall} />}
                    </TouchableOpacity>
                    <View style={styles.convInfo}>
                      <Text style={styles.convNickname}>{contact.nickname}</Text>
                      <Text style={styles.convLastMessage} numberOfLines={1}>
                        {contact.lastMessage || '—'}
                      </Text>
                    </View>
                    <View style={styles.convRightCol}>
                      <Text style={styles.convTime}>
                        {new Date(contact.lastContacted).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </Text>
                      {isSelected && (
                        <TouchableOpacity
                          style={styles.convDeleteBtn}
                          onPress={() => {
                            setSelectedConversationId(null)
                            handleDeleteConversation(contact.id, contact.nickname)
                          }}
                        >
                          <Ionicons name="trash-outline" size={16} color={c.text} />
                        </TouchableOpacity>
                      )}
                    </View>
                  </Pressable>
                </View>
              )
            })}
          </View>
        )}
      </View>
      <View style={{ height: 100 }} />
    </ScrollView>
  )

  const activeConvProfile = receiverId ? userProfiles.get(receiverId) : null
  const activeConvNickname = activeConvProfile?.nickname || 'Member'

  const renderActiveConversation = () => (
    <>
      <View style={styles.convHeader}>
        <TouchableOpacity style={styles.backBtn} onPress={() => setReceiverId('')} activeOpacity={0.7}>
          <Ionicons name="chevron-back" size={22} color={c.text} />
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.convHeaderTapArea}
          onPress={() => setProfileModalUserId(receiverId)}
          activeOpacity={0.7}
        >
          <View style={styles.convAvatarWrapper}>
            {activeConvProfile?.avatarUrl ? (
              <Image source={{ uri: activeConvProfile.avatarUrl }} style={styles.convHeaderAvatar} />
            ) : (
              <View style={styles.convHeaderAvatarPlaceholder}>
                <Ionicons name="person" size={16} color={c.textMuted} />
              </View>
            )}
            {activeUserIds.has(receiverId) && <View style={styles.activeDotSmall} />}
          </View>
          <View>
            <Text style={styles.convHeaderName}>{activeConvNickname}</Text>
            <Text style={styles.convHeaderStatus}>
              {activeUserIds.has(receiverId) ? '● Online' : '○ Offline'}
            </Text>
          </View>
        </TouchableOpacity>
      </View>

      {isEmpty ? (
        <View style={styles.centerContent}>
          <Ionicons name="chatbubble-ellipses-outline" size={44} color={c.iconInactive} />
          <Text style={styles.emptyText}>No messages yet</Text>
          <Text style={styles.emptySubtext}>Send a message to {activeConvNickname}</Text>
        </View>
      ) : (
        <ScrollView
          style={styles.messagesContainer}
          showsVerticalScrollIndicator={false}
          ref={setScrollViewRef}
          onContentSizeChange={() => scrollViewRef?.scrollToEnd({ animated: true })}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        >
          {currentMessages.map(renderMessageBubble)}
          <View style={{ height: 12 }} />
        </ScrollView>
      )}

      <View style={styles.inputArea}>
        <View style={styles.messageInputContainer}>
          <TextInput
            style={styles.textInput}
            placeholder="Write a message…"
            value={messageText}
            onChangeText={setMessageText}
            multiline
            maxLength={500}
            placeholderTextColor={c.textMuted}
          />
          <TouchableOpacity
            style={[styles.sendButtonSmall, !messageText.trim() && styles.sendButtonDisabled]}
            onPress={handleSendMessage}
            activeOpacity={0.8}
          >
            <Ionicons name="arrow-up" size={18} color={c.accentText} />
          </TouchableOpacity>
        </View>
      </View>
    </>
  )

  return (
    <View style={styles.container}>
      {/* Chat Mode Tabs */}
      <View style={styles.tabContainer}>
        <TouchableOpacity
          style={[styles.tab, chatMode === 'overall' && styles.tabActive]}
          onPress={() => setChatMode('overall')}
          activeOpacity={0.7}
        >
          <Ionicons
            name={chatMode === 'overall' ? 'people' : 'people-outline'}
            size={18}
            color={chatMode === 'overall' ? c.text : c.textMuted}
          />
          <Text style={[styles.tabText, chatMode === 'overall' && styles.tabTextActive]}>
            Team Chat
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.tab, chatMode === 'direct' && styles.tabActive]}
          onPress={() => setChatMode('direct')}
          activeOpacity={0.7}
        >
          <Ionicons
            name={chatMode === 'direct' ? 'chatbubble' : 'chatbubble-outline'}
            size={18}
            color={chatMode === 'direct' ? c.text : c.textMuted}
          />
          <Text style={[styles.tabText, chatMode === 'direct' && styles.tabTextActive]}>
            Direct
          </Text>
        </TouchableOpacity>
      </View>

      {/* Header — overall or DM list */}
      {/* {(chatMode === 'overall' || (chatMode === 'direct' && !receiverId)) && (
        <View style={styles.header}>
          <View style={styles.headerContent}>
            <View style={styles.headerAvatarCol}>
              {userProfile?.avatarUrl ? (
                <Image source={{ uri: userProfile.avatarUrl }} style={styles.headerAvatar} />
              ) : (
                <View style={styles.headerAvatarPlaceholder}>
                  <Ionicons name="person" size={18} color={c.textMuted} />
                </View>
              )}
            </View>
            <View style={styles.headerInfo}>
              <Text style={styles.headerNickname}>{userProfile?.nickname || 'You'}</Text>
              <Text style={styles.headerTitle}>
                {chatMode === 'overall' ? 'Worship Team · Team Chat' : 'Direct Messages'}
              </Text>
            </View>
          </View>
        </View>
      )} */}

      {/* ── OVERALL CHAT ── */}
      {chatMode === 'overall' && (
        <>
          {overallChatMessages.length === 0 ? (
            <View style={styles.centerContent}>
              <Ionicons name="people-outline" size={50} color={c.iconInactive} />
              <Text style={styles.emptyText}>No messages yet</Text>
              <Text style={styles.emptySubtext}>Begin the team conversation below</Text>
            </View>
          ) : (
            <ScrollView
              style={styles.messagesContainer}
              showsVerticalScrollIndicator={false}
              ref={setScrollViewRef}
              onContentSizeChange={() => scrollViewRef?.scrollToEnd({ animated: true })}
              refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
            >
              {overallChatMessages.map(renderMessageBubble)}
              <View style={{ height: 12 }} />
            </ScrollView>
          )}
          <View style={styles.inputArea}>
            <View style={styles.messageInputContainer}>
              <TextInput
                style={styles.textInput}
                placeholder="Share with the team…"
                value={messageText}
                onChangeText={setMessageText}
                multiline
                maxLength={500}
                placeholderTextColor={c.textMuted}
              />
              <TouchableOpacity
                style={[styles.sendButtonSmall, !messageText.trim() && styles.sendButtonDisabled]}
                onPress={handleSendMessage}
                activeOpacity={0.8}
              >
                <Ionicons name="arrow-up" size={18} color={c.accentText} />
              </TouchableOpacity>
            </View>
          </View>
        </>
      )}

      {/* ── DIRECT MESSAGES ── */}
      {chatMode === 'direct' && (
        <>
          {receiverId ? renderActiveConversation() : renderDirectMessagesPanel()}
          {!receiverId && (
            <TouchableOpacity
              style={styles.fab}
              onPress={() => setShowNewConversationModal(true)}
              activeOpacity={0.85}
            >
              <Ionicons name="create-outline" size={22} color={c.accentText} />
            </TouchableOpacity>
          )}
        </>
      )}

      {/* Edit Message Modal */}
      <Modal visible={showEditModal} transparent animationType="slide">
        <View style={styles.modalContainer}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <TouchableOpacity onPress={() => {
                setShowEditModal(false)
                setEditingMessageId(null)
                setEditingText('')
              }}>
                <Text style={styles.cancelButton}>Cancel</Text>
              </TouchableOpacity>
              <Text style={styles.modalTitle}>Edit Message</Text>
              <TouchableOpacity onPress={handleEditMessage}>
                <Text style={styles.confirmButton}>Save</Text>
              </TouchableOpacity>
            </View>
            <View style={styles.modalBody}>
              <Text style={styles.label}>Message</Text>
              <TextInput
                style={styles.messageInput}
                value={editingText}
                onChangeText={setEditingText}
                multiline
                numberOfLines={6}
                placeholderTextColor={c.textMuted}
                autoFocus
              />
            </View>
          </View>
        </View>
      </Modal>

      {/* ─── FIX: Message Action Menu ──────────────────────────────────────── */}
      <Modal
        visible={selectedMessageId !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setSelectedMessageId(null)}
      >
        <Pressable style={styles.menuOverlay} onPress={() => setSelectedMessageId(null)}>
          <View style={styles.actionMenuContainer}>
            {/* Edit */}
            <TouchableOpacity
              style={styles.menuOption}
              onPress={() => {
                if (selectedMessageId) handleOpenEditModal(selectedMessageId)
              }}
            >
              <Ionicons name="pencil-outline" size={18} color={c.text} />
              <Text style={styles.menuOptionText}>Edit Message</Text>
            </TouchableOpacity>
            <View style={styles.menuDivider} />
            {/* Delete */}
            <TouchableOpacity
              style={styles.menuOption}
              onPress={() => {
                if (selectedMessageId) handleOpenDeleteConfirm(selectedMessageId)
              }}
            >
              <Ionicons name="trash-outline" size={18} color={c.text} />
              <Text style={[styles.menuOptionText, styles.deleteOptionText]}>Delete Message</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Modal>
      {/* ─────────────────────────────────────────────────────────────────── */}

      {/* New Conversation Modal */}
      <Modal
        visible={showNewConversationModal}
        transparent
        animationType="slide"
        onRequestClose={() => setShowNewConversationModal(false)}
      >
        <View style={styles.modalContainer}>
          <View style={styles.newConversationContent}>
            <View style={styles.modalHeader}>
              <TouchableOpacity onPress={() => setShowNewConversationModal(false)}>
                <Text style={styles.cancelButton}>Cancel</Text>
              </TouchableOpacity>
              <Text style={styles.modalTitle}>New Message</Text>
              <View style={{ width: 60 }} />
            </View>

            <ScrollView
              style={styles.newConversationBody}
              showsVerticalScrollIndicator={false}
              refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
            >
              <View style={[styles.sectionHeaderRow, { marginTop: 16 }]}>
                <View style={styles.sectionAccentLine} />
                <Text style={styles.sectionHeader}>BY ID</Text>
              </View>
              <View style={styles.recipientInputSection}>
                <TextInput
                  style={styles.recipientIdInput}
                  placeholder="Enter recipient ID"
                  value={newRecipientId}
                  onChangeText={setNewRecipientId}
                  placeholderTextColor={c.textMuted}
                />
                <TouchableOpacity
                  style={[styles.startButton, !newRecipientId.trim() && styles.startButtonDisabled]}
                  onPress={() => {
                    if (newRecipientId.trim()) handleStartConversation(newRecipientId)
                  }}
                  disabled={!newRecipientId.trim()}
                  activeOpacity={0.8}
                >
                  <Text style={styles.startButtonText}>Start Conversation</Text>
                </TouchableOpacity>
              </View>

              <View style={[styles.sectionHeaderRow, { marginTop: 24 }]}>
                <View style={styles.sectionAccentLine} />
                <Text style={styles.sectionHeader}>SCAN</Text>
              </View>
              <TouchableOpacity style={styles.qrButton} onPress={handleScanQRCode} activeOpacity={0.75}>
                <Ionicons name="qr-code-outline" size={36} color={c.text} />
                <Text style={styles.qrButtonText}>Scan QR Code</Text>
              </TouchableOpacity>
              <View style={{ height: 40 }} />
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* QR Code Scanner Modal */}
      <Modal visible={scannerVisible} animationType="fade" onRequestClose={closeScanner}>
        <View style={styles.scannerContainer}>
          <View style={styles.scannerHeader}>
            <TouchableOpacity onPress={closeScanner} style={styles.closeButton}>
              <Ionicons name="close" size={20} color={c.accentText} />
            </TouchableOpacity>
            <Text style={styles.scannerTitle}>Scan Recipient Code</Text>
            <View style={{ width: 44 }} />
          </View>

          {hasPermission && (
            <CameraView
              style={styles.camera}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={scanned ? undefined : handleBarCodeScanned}
            />
          )}

          <View style={styles.scannerOverlay}>
            <View style={styles.scannerFrame}>
              <View style={[styles.corner, styles.cornerTL]} />
              <View style={[styles.corner, styles.cornerTR]} />
              <View style={[styles.corner, styles.cornerBL]} />
              <View style={[styles.corner, styles.cornerBR]} />
            </View>
          </View>

          <View style={styles.scannerFooter}>
            <Text style={styles.scannerHint}>Align the code within the frame</Text>
            {scanned && (
              <TouchableOpacity style={styles.rescanButton} onPress={() => setScanned(false)}>
                <Text style={styles.rescanText}>Scan Again</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      </Modal>

      {/* User Profile Modal */}
      <UserProfileModal
        visible={profileModalUserId !== null}
        targetUserId={profileModalUserId}
        isActiveUser={profileModalUserId ? activeUserIds.has(profileModalUserId) : false}
        onClose={() => setProfileModalUserId(null)}
        onMessage={(uid) => {
          setChatMode('direct')
          handleStartConversation(uid)
        }}
      />
    </View>
  )
}

// ─── PALETTE ────────────────────────────────────────────────────────────────
const makeStyles = (c: AppColors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.surfaceAlt },

  // ── Tabs ──────────────────────────────────────────────────────────────────
  tabContainer: {
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
    gap: 7,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  tabActive: { borderBottomColor: c.accent },
  tabText: {
    fontSize: 12,
    fontWeight: '600',
    color: c.textMuted,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  tabTextActive: { color: c.text },

  // ── Header ─────────────────────────────────────────────────────────────────
  header: {
    paddingHorizontal: 16,
    paddingVertical: 14,
    backgroundColor: c.surface,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  headerContent: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  headerAvatarCol: {},
  headerAvatar: { width: 42, height: 42, borderRadius: 21, borderWidth: 1, borderColor: c.border },
  headerAvatarPlaceholder: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: c.surfaceAlt,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: c.border,
  },
  headerInfo: { flex: 1 },
  headerNickname: {
    fontSize: 15,
    fontWeight: '700',
    color: c.text,
    letterSpacing: 0.2,
    marginBottom: 2,
  },
  headerTitle: {
    fontSize: 12,
    fontWeight: '400',
    color: c.textMuted,
    letterSpacing: 0.3,
  },

  // ── DM Panel ───────────────────────────────────────────────────────────────
  dmPanel: { flex: 1, backgroundColor: c.surfaceAlt },
  sectionBlock: { marginTop: 24 },
  sectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    marginBottom: 14,
  },
  sectionAccentLine: {
    width: 3,
    height: 16,
    backgroundColor: c.accent,
    borderRadius: 1.5,
  },
  sectionHeader: {
    fontSize: 12,
    fontWeight: '800',
    color: c.text,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
  },

  // ── Friends / bubbles ──────────────────────────────────────────────────────
  friendsRow: { paddingBottom: 8 },
  friendBubble: { alignItems: 'center', marginRight: 22, width: 64 },
  friendAvatarWrapper: { position: 'relative', marginBottom: 8 },
  friendBubbleAvatar: {
    width: 56,
    height: 56,
    borderRadius: 28,
    borderWidth: 2,
    borderColor: c.border,
  },
  friendBubbleAvatarPlaceholder: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: c.surfaceMuted,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 2,
    borderColor: c.border,
  },
  activeDot: {
    position: 'absolute',
    bottom: 1,
    right: 1,
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: c.accent,
    borderWidth: 2,
    borderColor: c.hairline,
  },
  activeDotSmall: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: 9,
    height: 9,
    borderRadius: 5,
    backgroundColor: c.accent,
    borderWidth: 2,
    borderColor: c.hairline,
  },
  friendBubbleName: {
    fontSize: 12,
    fontWeight: '600',
    color: c.text,
    textAlign: 'center',
    lineHeight: 15,
    letterSpacing: 0.2,
  },

  // ── Conversations list ─────────────────────────────────────────────────────
  divider: {
    height: 1,
    backgroundColor: c.surfaceAlt,
    marginVertical: 0,
  },
  conversationItem: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: c.surface,
    paddingVertical: 14,
    paddingHorizontal: 16,
    gap: 12,
    borderRadius: 8,
    marginVertical: 4,
  },
  conversationItemSelected: {
    backgroundColor: c.surfaceAlt,
    borderWidth: 1.5,
    borderColor: c.accent,
  },
  convAvatarWrapper: { position: 'relative' },
  convAvatar: {
    width: 46,
    height: 46,
    borderRadius: 23,
    borderWidth: 1.5,
    borderColor: c.border,
  },
  convAvatarPlaceholder: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: c.surfaceAlt,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: c.border,
  },
  convInfo: { flex: 1 },
  convNickname: { fontSize: 14, fontWeight: '700', color: c.text, marginBottom: 3, letterSpacing: 0.2 },
  convLastMessage: { fontSize: 12, color: c.textMuted, lineHeight: 16, letterSpacing: 0.1 },
  convRightCol: { alignItems: 'flex-end', gap: 8 },
  convTime: { fontSize: 11, color: c.textMuted, letterSpacing: 0.3, fontWeight: '500' },
  convDeleteBtn: { padding: 6, paddingRight: 0 },

  // ── Conversation view ──────────────────────────────────────────────────────
  convHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: c.surface,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
    paddingHorizontal: 12,
    paddingVertical: 12,
    gap: 10,
  },
  convHeaderTapArea: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  backBtn: { padding: 4 },
  convHeaderAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: c.border,
  },
  convHeaderAvatarPlaceholder: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: c.surfaceAlt,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: c.border,
  },
  convHeaderName: { fontSize: 15, fontWeight: '700', color: c.text, letterSpacing: 0.1 },
  convHeaderStatus: { fontSize: 11, color: c.textMuted, marginTop: 1, letterSpacing: 0.5 },

  // ── Messages ───────────────────────────────────────────────────────────────
  messagesContainer: { flex: 1, paddingHorizontal: 14, paddingTop: 14 },
  messageWrapper: { marginBottom: 14 },
  deletedWrapper: { alignItems: 'center', marginBottom: 14 },
  messageSenderNickname: {
    fontSize: 11,
    fontWeight: '600',
    color: c.textMuted,
    marginBottom: 4,
    marginLeft: 42,
    letterSpacing: 0.3,
    textTransform: 'uppercase',
  },
  messageSenderNicknameOwn: {
    marginLeft: 0,
    marginRight: 42,
    textAlign: 'right',
    color: c.textSub,
  },
  messageRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  messageRowOwn: { justifyContent: 'flex-end' },
  messageSenderAvatar: {
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: 1,
    borderColor: c.border,
  },
  messageSenderAvatarPlaceholder: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: c.surfaceMuted,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: c.border,
  },
  ownAvatarPlaceholder: {
    backgroundColor: c.textSub,
    borderColor: c.accent,
  },
  messageBubble: {
    backgroundColor: c.surface,
    borderRadius: 14,
    borderTopLeftRadius: 4,
    paddingHorizontal: 13,
    paddingVertical: 9,
    maxWidth: '72%',
    borderWidth: 1,
    borderColor: c.border,
  },
  ownMessage: {
    backgroundColor: c.accent,
    borderTopRightRadius: 4,
    borderTopLeftRadius: 14,
    borderColor: c.accent,
  },
  messageText: { fontSize: 14, color: c.text, lineHeight: 20 },
  ownMessageText: { color: c.accentText },
  messageFooter: { flexDirection: 'row', alignItems: 'center', marginTop: 4, gap: 4 },
  dayDivider: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 16,
    marginBottom: 10,
    paddingHorizontal: 4,
  },
  dayDividerLine: { flex: 1, height: 1, backgroundColor: c.surfaceMuted },
  dayDividerText: {
    fontSize: 10.5,
    fontWeight: '700',
    color: c.textMuted,
    letterSpacing: 0.4,
  },

  timestamp: { fontSize: 10, color: c.iconInactive, letterSpacing: 0.2 },
  ownTimestamp: { color: c.accentText },
  editedBadge: { fontSize: 10, color: c.iconInactive, fontStyle: 'italic' },
  ownEditedBadge: { color: c.accentText },
  deletedMessageText: {
    fontSize: 12,
    color: c.iconInactive,
    fontStyle: 'italic',
    letterSpacing: 0.3,
  },

  // ── Input ──────────────────────────────────────────────────────────────────
  inputArea: {
    backgroundColor: c.surface,
    borderTopWidth: 1,
    borderTopColor: c.border,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  messageInputContainer: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  textInput: {
    flex: 1,
    backgroundColor: c.surfaceAlt,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: c.border,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 14,
    color: c.text,
    maxHeight: 100,
    lineHeight: 20,
  },
  sendButtonSmall: {
    backgroundColor: c.accent,
    borderRadius: 20,
    width: 40,
    height: 40,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 2,
  },
  sendButtonDisabled: {
    backgroundColor: c.textMuted,
  },

  // ── Empty States ───────────────────────────────────────────────────────────
  centerContent: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 32 },
  emptyText: { fontSize: 15, color: c.textMuted, marginTop: 14, fontWeight: '500' },
  emptySubtext: { fontSize: 13, color: c.iconInactive, marginTop: 6, textAlign: 'center' },
  emptySection: { alignItems: 'center', paddingVertical: 24, paddingHorizontal: 16 },
  emptySectionText: { fontSize: 13, color: c.iconInactive, marginTop: 8, fontWeight: '500' },
  emptySectionSub: { fontSize: 12, color: c.iconInactive, marginTop: 4 },

  // ── FAB ────────────────────────────────────────────────────────────────────
  fab: {
    position: 'absolute',
    bottom: 24,
    right: 20,
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: c.accent,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: c.shadow,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 6,
  },

  // ── Modals ─────────────────────────────────────────────────────────────────
  modalContainer: {
    flex: 1,
    backgroundColor: c.accent,
    justifyContent: 'flex-end',
  },
  modalContent: {
    backgroundColor: c.surface,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: '90%',
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  modalTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: c.text,
    letterSpacing: 0.2,
  },
  cancelButton: { color: c.textMuted, fontSize: 14, fontWeight: '500' },
  confirmButton: { color: c.text, fontSize: 14, fontWeight: '700' },
  modalBody: { paddingHorizontal: 16, paddingVertical: 16 },
  label: {
    fontSize: 11,
    fontWeight: '700',
    color: c.textMuted,
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginBottom: 10,
  },
  messageInput: {
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 14,
    color: c.text,
    textAlignVertical: 'top',
    lineHeight: 20,
    backgroundColor: c.surfaceAlt,
  },
  menuOverlay: {
    flex: 1,
    backgroundColor: c.accent,
    justifyContent: 'center',
    alignItems: 'center',
  },
  actionMenuContainer: {
    backgroundColor: c.surface,
    borderRadius: 14,
    overflow: 'hidden',
    minWidth: 200,
    shadowColor: c.shadow,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 10,
  },
  menuOption: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 18,
    paddingVertical: 15,
    gap: 12,
  },
  menuDivider: {
    height: 1,
    backgroundColor: c.surfaceAlt,
    marginHorizontal: 16,
  },
  menuOptionText: {
    fontSize: 14,
    fontWeight: '500',
    color: c.text,
    letterSpacing: 0.1,
  },
  deleteOptionText: { color: c.textSub },
  newConversationContent: {
    backgroundColor: c.surface,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: '90%',
    flex: 1,
  },
  newConversationBody: {
    flex: 1,
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  friendsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginBottom: 8,
    marginTop: 4,
  },
  friendCard: {
    width: '33.33%',
    alignItems: 'center',
    marginBottom: 18,
    paddingHorizontal: 4,
  },
  friendAvatar: {
    width: 58,
    height: 58,
    borderRadius: 29,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: c.border,
  },
  friendAvatarPlaceholder: {
    width: 58,
    height: 58,
    borderRadius: 29,
    backgroundColor: c.surfaceMuted,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 8,
    borderWidth: 1,
    borderColor: c.border,
  },
  friendName: {
    fontSize: 12,
    fontWeight: '500',
    color: c.textSub,
    textAlign: 'center',
    lineHeight: 15,
  },
  recipientInputSection: { marginBottom: 4 },
  recipientIdInput: {
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 13,
    fontSize: 14,
    color: c.text,
    marginBottom: 10,
    backgroundColor: c.surfaceAlt,
  },
  startButton: {
    backgroundColor: c.accent,
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
  },
  startButtonDisabled: { backgroundColor: c.border },
  startButtonText: {
    color: c.accentText,
    fontSize: 14,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
  qrButton: {
    backgroundColor: c.surfaceAlt,
    borderRadius: 12,
    paddingVertical: 22,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: c.border,
    marginTop: 8,
  },
  qrButtonText: {
    fontSize: 13,
    fontWeight: '600',
    color: c.textSub,
    marginTop: 8,
    letterSpacing: 0.3,
  },

  // ── QR Scanner ────────────────────────────────────────────────────────────
  scannerContainer: {
    flex: 1,
    backgroundColor: c.accent,
  },
  scannerHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 12,
    backgroundColor: c.accent,
  },
  scannerTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: c.accentText,
  },
  closeButton: {
    padding: 8,
  },
  camera: {
    flex: 1,
  },
  scannerOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
  },
  scannerFrame: {
    width: 260,
    height: 260,
    borderWidth: 2,
    borderColor: c.hairline,
    borderRadius: 12,
    backgroundColor: 'transparent',
  },
  corner: {
    position: 'absolute',
    width: 20,
    height: 20,
    borderColor: c.hairline,
    borderWidth: 3,
  },
  cornerTL: {
    top: -2,
    left: -2,
    borderRightWidth: 0,
    borderBottomWidth: 0,
  },
  cornerTR: {
    top: -2,
    right: -2,
    borderLeftWidth: 0,
    borderBottomWidth: 0,
  },
  cornerBL: {
    bottom: -2,
    left: -2,
    borderRightWidth: 0,
    borderTopWidth: 0,
  },
  cornerBR: {
    bottom: -2,
    right: -2,
    borderLeftWidth: 0,
    borderTopWidth: 0,
  },
  scannerFooter: {
    backgroundColor: c.accent,
    paddingHorizontal: 20,
    paddingVertical: 20,
    alignItems: 'center',
  },
  scannerHint: {
    fontSize: 13,
    color: c.iconInactive,
    textAlign: 'center',
    letterSpacing: 0.2,
  },
  rescanButton: {
    marginTop: 12,
    paddingHorizontal: 20,
    paddingVertical: 8,
    backgroundColor: c.surface,
    borderRadius: 6,
  },
  rescanText: {
    fontSize: 12,
    fontWeight: '600',
    color: c.text,
  },
})