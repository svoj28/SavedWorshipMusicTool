// lib/useKeepScreenAwake.ts
//
// Hold the screen open while the user is reading, playing, or tuning.
//
// A phone's lock timer assumes that if you have not touched the screen for a
// minute you have stopped looking at it. That is exactly wrong on a music
// stand: the chart is scrolling itself, both hands are busy, and the screen
// going black mid-verse is the worst thing the app can do. Anywhere the user
// is reading rather than tapping asks for this.
//
// The lock is taken by tag and given back the moment the caller stops needing
// it - leaving the screen pinned awake after the user has moved on would
// quietly drain the battery for the rest of the day.

import { useEffect } from 'react'
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake'

/**
 * Keep the screen on while `active` is true.
 *
 * The tag names the reason the screen is being held, so two parts of the app
 * asking at once cannot switch each other off - each releases only its own.
 */
export function useKeepScreenAwake(active: boolean, tag: string): void {
  useEffect(() => {
    if (!active) return

    let released = false
    // A failure here is never worth interrupting anyone over: not being able
    // to hold the screen awake is a small annoyance, an error message is not.
    activateKeepAwakeAsync(tag).catch(() => {})

    return () => {
      if (released) return
      released = true
      try {
        Promise.resolve(deactivateKeepAwake(tag)).catch(() => {})
      } catch {
        /* the lock was never taken, or has already gone */
      }
    }
  }, [active, tag])
}
