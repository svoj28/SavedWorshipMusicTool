import NetInfo from '@react-native-community/netinfo'
import { syncAllUnsyncedRows } from './syncToSupabase'

let unsubscribe: (() => void) | null = null

export function startNetworkSync() {
  if (unsubscribe) return // already listening

  unsubscribe = NetInfo.addEventListener(async (state) => {
    const isConnected = state.isConnected && state.isInternetReachable
    if (isConnected) {
      console.log('Network restored — syncing unsynced rows...')
      try {
        await syncAllUnsyncedRows()
      } catch (err) {
        console.error('Network sync failed:', err)
      }
    }
  })
}

export function stopNetworkSync() {
  if (unsubscribe) {
    unsubscribe()
    unsubscribe = null
  }
}