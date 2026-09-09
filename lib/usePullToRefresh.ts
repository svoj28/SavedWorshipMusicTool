import { useCallback, useState } from 'react'

export function usePullToRefresh(refresh: () => Promise<void> | void) {
  const [refreshing, setRefreshing] = useState(false)

  const onRefresh = useCallback(async () => {
    setRefreshing(true)
    try {
      await refresh()
    } finally {
      setRefreshing(false)
    }
  }, [refresh])

  return { refreshing, onRefresh }
}