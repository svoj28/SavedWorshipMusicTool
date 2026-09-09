// components/WebOfflineNotice.web.tsx
/**
 * Says the one thing the web build cannot do.
 *
 * On a phone, losing signal is barely an event: the database is on the device,
 * so the app carries on and catches up later. In a browser there is no such
 * copy - the database lives in memory and is filled from Supabase - so the
 * same moment means the app has nothing to show and no way to save.
 *
 * That difference is worth a sentence on screen. Without it the app would
 * simply look empty, or appear to accept an edit that has nowhere to go, and
 * the user would reasonably conclude their work had been lost rather than
 * never sent.
 *
 * The native build gets ./WebOfflineNotice.tsx, which renders nothing.
 */

import React, { useEffect, useState } from 'react'
import { View, Text, StyleSheet } from 'react-native'

export default function WebOfflineNotice() {
  const [offline, setOffline] = useState(
    typeof navigator !== 'undefined' && navigator.onLine === false,
  )

  useEffect(() => {
    const goOffline = () => setOffline(true)
    const goOnline = () => setOffline(false)

    window.addEventListener('offline', goOffline)
    window.addEventListener('online', goOnline)
    return () => {
      window.removeEventListener('offline', goOffline)
      window.removeEventListener('online', goOnline)
    }
  }, [])

  if (!offline) return null

  return (
    <View style={styles.bar} pointerEvents="none">
      <Text style={styles.text}>
        No connection. The web app needs to be online — reconnect to keep working.
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  // Above the navigator and out of the way of taps: this is a statement about
  // the app, not a control, and it must not sit on top of anything tappable.
  bar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 1000,
    paddingVertical: 8,
    paddingHorizontal: 16,
    backgroundColor: '#b3261e',
  },
  text: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
  },
})
