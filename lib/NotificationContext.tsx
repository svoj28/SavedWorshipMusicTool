import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react'
import {
  getNotifications,
  getUnreadCount,
  markAllRead,
  markOneRead,
  clearAllNotifications,
  getMuteState,
  setMuteState,
  loadNotificationsFromSupabase,
  notificationFromRow,
  AppNotification,
  MuteState,
  MuteOption,
} from './notifications'
import { supabase } from './supabase'

interface NotificationContextValue {
  notifications: AppNotification[]
  unreadCount: number
  muteState: MuteState
  loading: boolean
  refresh: () => Promise<void>
  markRead: (id: string) => Promise<void>
  markAllAsRead: () => Promise<void>
  clearAll: () => Promise<void>
  updateMute: (option: MuteOption) => Promise<void>
}

const NotificationContext = createContext<NotificationContextValue | null>(null)

export function NotificationProvider({
  children,
  userId,
}: {
  children: React.ReactNode
  userId: string | null
}) {
  const [notifications, setNotifications] = useState<AppNotification[]>([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [muteState, setMuteStateLocal] = useState<MuteState>({ option: 'unmuted', until: null })
  const [loading, setLoading] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const refresh = useCallback(async () => {
    if (!userId) {
      setNotifications([])
      setUnreadCount(0)
      return
    }
    setLoading(true)
    try {
      await loadNotificationsFromSupabase(userId)
      const [notifs, count, mute] = await Promise.all([
        getNotifications(userId),
        getUnreadCount(userId),
        getMuteState(userId),
      ])
      setNotifications(notifs)
      setUnreadCount(count)
      setMuteStateLocal(mute)
    } catch (err) {
      console.error('Failed to refresh notifications:', err)
    } finally {
      setLoading(false)
    }
  }, [userId])

  const mergeNotificationRow = useCallback(async (row: any) => {
    if (!userId || !row?.id) return
    const next = notificationFromRow(row)
    const existing = await getNotifications(userId)
    const merged = [next, ...existing.filter(notification => notification.id !== next.id)].slice(0, 50)
    setNotifications(merged)
    setUnreadCount(merged.filter(notification => !notification.read).length)
  }, [userId])

  const markRead = useCallback(async (id: string) => {
    if (!userId) return
    await markOneRead(userId, id)
    await refresh()
  }, [userId, refresh])

  const markAllAsRead = useCallback(async () => {
    if (!userId) return
    await markAllRead(userId)
    await refresh()
  }, [userId, refresh])

  const clearAll = useCallback(async () => {
    if (!userId) return
    await clearAllNotifications(userId)
    setNotifications([])
    setUnreadCount(0)
  }, [userId])

  const updateMute = useCallback(async (option: MuteOption) => {
    if (!userId) return
    const newState = await setMuteState(userId, option)
    setMuteStateLocal(newState)
  }, [userId])

  // Keep the in-app activity feed current through realtime updates and polling.
  useEffect(() => {
    if (!userId) return
    refresh()

    const channel = supabase
      .channel(`notifications-${userId}`)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'notifications',
        filter: `user_id=eq.${userId}`,
      }, async (payload) => {
        if (payload.eventType === 'INSERT' && payload.new) {
          await mergeNotificationRow(payload.new)
          return
        }

        refresh()
      })
      .subscribe()

    pollRef.current = setInterval(refresh, 30000)
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
      supabase.removeChannel(channel)
    }
  }, [userId, refresh])

  return (
    <NotificationContext.Provider
      value={{ notifications, unreadCount, muteState, loading, refresh, markRead, markAllAsRead, clearAll, updateMute }}
    >
      {children}
    </NotificationContext.Provider>
  )
}

export function useNotifications() {
  const ctx = useContext(NotificationContext)
  if (!ctx) throw new Error('useNotifications must be used within NotificationProvider')
  return ctx
}
