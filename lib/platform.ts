// lib/platform.ts
/**
 * The one way the web build differs from the app.
 *
 * Everything the app does, the web does: the same screens, the same chord
 * lists, the same pad and metronome and tuner, importing audio, scanning a
 * code. The single difference is that the browser keeps nothing once the tab
 * is closed, so the web build has to be online.
 *
 * That is deliberately the only flag here. A feature is not switched off for
 * being on the web - if it needs a file, the file lives for the session
 * instead of forever.
 */

import { Platform } from 'react-native'

export const IS_WEB = Platform.OS === 'web'

/**
 * Whether anything written survives the app being closed.
 *
 * True on native, where SQLite is a file on disk and imported audio is copied
 * into the app's own directory - which is what lets the app work with no
 * signal and pick up where it left off.
 *
 * False on web, where the database is held in memory and imported files exist
 * only as object URLs belonging to the page. Both die with the tab, so there
 * is nothing to work from offline and nothing left waiting to be synced. Use
 * this to decide how long something is kept, not whether it is offered.
 */
export const SUPPORTS_OFFLINE = !IS_WEB
