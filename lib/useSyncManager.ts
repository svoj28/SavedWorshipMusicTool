import { useEffect, useState, useCallback, useRef } from 'react'
import {
  fullSync,
  syncTable,
  subscribeToChanges,
  startPeriodicSync,
  getSyncStatus,
  onSyncStatusChange,
  clearSyncError,
  countPendingChanges,
} from './sync'

export interface UseSyncManagerOptions {
  userId: string
  autoSync?: boolean
  syncInterval?: number // milliseconds
  enableRealtime?: boolean
}

export interface SyncState {
  isSyncing: boolean
  lastSyncTime: number
  syncError: string | null
  pendingChanges: number
  isOnline: boolean
}

/**
 * React hook for managing database sync
 * Handles auto-sync, real-time subscriptions, and status tracking
 */
export function useSyncManager(options: UseSyncManagerOptions) {
  const { userId, autoSync = true, syncInterval = 10000, enableRealtime = true } = options
  
  const [syncState, setSyncState] = useState<SyncState>(() => {
    const status = getSyncStatus()
    return {
      isSyncing: status.isSyncing,
      lastSyncTime: status.lastSyncTime,
      syncError: status.syncError,
      pendingChanges: 0,
      isOnline: true,
    }
  })

  const periodicSyncCleanup = useRef<(() => void) | null>(null)
  const realtimeUnsubscribe = useRef<(() => void) | null>(null)
  const statusUnsubscribe = useRef<(() => void) | null>(null)

  // Manual sync function
  const sync = useCallback(async () => {
    return await fullSync(userId)
  }, [userId])

  // Sync specific table
  const syncTableManual = useCallback(async (tableName: string) => {
    return await syncTable(tableName, userId)
  }, [userId])

  // Update sync state from status
  const updateSyncState = useCallback(async () => {
    const status = getSyncStatus()
    let pending = 0
    try {
      pending = await countPendingChanges(userId)
    } catch (err) {
      console.warn('Could not count pending changes, defaulting to 0:', err)
    }
    setSyncState({
      isSyncing: status.isSyncing,
      lastSyncTime: status.lastSyncTime,
      syncError: status.syncError,
      pendingChanges: pending,
      isOnline: true, // TODO: Check network connectivity
    })
  }, [userId])

  // Initialize sync status listener
  useEffect(() => {
    statusUnsubscribe.current = onSyncStatusChange(async () => {
      await updateSyncState()
    })

    return () => {
      statusUnsubscribe.current?.()
    }
  }, [updateSyncState])

  // Setup periodic sync
  useEffect(() => {
    if (!autoSync || !userId) return

    let unsubscribe: (() => void) | undefined

    const setupPeriodicSync = async () => {
      unsubscribe = await startPeriodicSync(userId, syncInterval)
      await updateSyncState()
    }

    setupPeriodicSync()

    return () => {
      unsubscribe?.()
    }
  }, [autoSync, userId, syncInterval, updateSyncState])

  // Setup real-time subscriptions
  useEffect(() => {
    if (!enableRealtime || !userId) return

    const unsubscribe = subscribeToChanges(userId, async () => {
      await updateSyncState()
    })

    realtimeUnsubscribe.current = unsubscribe

    return () => {
      unsubscribe?.()
    }
  }, [enableRealtime, userId, updateSyncState])

  // Initial sync and state update
  useEffect(() => {
    const initialize = async () => {
      if (userId) {
        await sync()
        await updateSyncState()
      }
    }

    initialize()
  }, [userId, sync, updateSyncState])

  return {
    ...syncState,
    sync,
    syncTable: syncTableManual,
    clearError: clearSyncError,
  }
}

/**
 * Hook for tracking sync status of a specific resource
 */
export function useSyncStatus(tableName: string) {
  const [status, setStatus] = useState(() => getSyncStatus())

  useEffect(() => {
    const unsubscribe = onSyncStatusChange((newStatus) => {
      setStatus(newStatus)
    })

    return () => unsubscribe()
  }, [])

  return {
    isSyncing: status.isSyncing,
    syncError: status.syncError,
    lastSyncTime: status.lastSyncTime,
  }
}
