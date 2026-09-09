// lib/padLibrary.ts
//
// Pads the user brings themselves.
//
// Plenty of worship teams already own a set of pads - usually twelve files,
// one per key - and would rather hear those than anything synthesised. This
// keeps a small index of the files they have imported and which key each one
// belongs to.
//
// The files are copied into the app's own storage rather than played from
// wherever the picker found them. A URI handed back by a document picker is
// often a temporary grant that stops working after a reboot, and a pad that
// silently fails on a Sunday morning is worse than one never added at all.
//
// This is deliberately local-only: no table, no sync. The audio lives on one
// phone and cannot follow the account to another, so recording it in the
// synced database would promise something that could not be kept.

import AsyncStorage from '@react-native-async-storage/async-storage'
import * as DocumentPicker from 'expo-document-picker'
import * as FileSystem from 'expo-file-system/legacy'
import { SUPPORTS_OFFLINE } from './platform'
import { AUDIO_PICKER_TYPES, resolveAudioExtension } from './audioFormat'

const INDEX_KEY = 'pad.library.v1'
const PAD_DIRECTORY = FileSystem.documentDirectory + 'pads/'

export interface PadSample {
  id: string
  /** What to show in the list - the file's own name, tidied up */
  name: string
  /** Where the copy lives, inside the app's storage */
  uri: string
  /**
   * Which key it plays in: 0 = C up to 11 = B, or null when the user has not
   * said yet. Major and minor share a file - a pad on the root sits under
   * both, and asking for twenty-four files nobody owns would be silly.
   */
  root: number | null
}

async function ensureDirectory(): Promise<void> {
  const info = await FileSystem.getInfoAsync(PAD_DIRECTORY)
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(PAD_DIRECTORY, { intermediates: true })
  }
}

async function saveIndex(pads: PadSample[]): Promise<void> {
  await AsyncStorage.setItem(INDEX_KEY, JSON.stringify(pads))
}

/** Every pad the user has imported. */
export async function listPads(): Promise<PadSample[]> {
  try {
    const raw = await AsyncStorage.getItem(INDEX_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/** Strip the extension and the tidier noise off a file name. */
function tidyName(fileName: string): string {
  return fileName
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/**
 * Guess the key from the file's name.
 *
 * Pad packs are almost always named for their key - "Pad in Bb", "07 - F#",
 * "Ab Pad". Reading it off the name means importing twelve files does not
 * mean twelve trips through a key picker. It is only ever a guess, and the
 * user can change it in a tap.
 */
export function guessRootFromName(name: string): number | null {
  const ROOTS: Record<string, number> = {
    c: 0, 'c#': 1, db: 1, d: 2, 'd#': 3, eb: 3, e: 4, f: 5,
    'f#': 6, gb: 6, g: 7, 'g#': 8, ab: 8, a: 9, 'a#': 10, bb: 10, b: 11,
  }

  // A note name standing on its own, so "Bb" is read but the B in "Bright"
  // is not.
  const match = name.match(/(^|[^a-z])([a-g](?:#|b)?)(?![a-z])/i)
  if (!match) return null

  const found = ROOTS[match[2].toLowerCase()]
  return found === undefined ? null : found
}

/** What an import did, so the screen can say so rather than guess from counts. */
export interface PadImportResult {
  /** The whole library afterwards - what the screen needs in order to redraw. */
  library: PadSample[]
  added: number
  /** Picked, but not audio this phone can play. */
  skipped: string[]
}

/**
 * Ask for audio files and take a copy of each.
 *
 * The picker deliberately does not filter to 'audio/*'. A file the system
 * cannot name the type of - somebody's .ss2, say - is not offered under that
 * filter at all, so the import could never begin. Instead everything is
 * offered and each file is identified from its own header, which is both more
 * permissive and more accurate than trusting the name.
 */
export async function importPads(): Promise<PadImportResult> {
  const result = await DocumentPicker.getDocumentAsync({
    type: AUDIO_PICKER_TYPES,
    multiple: true,
    copyToCacheDirectory: true,
  })

  if (result.canceled) return { library: await listPads(), added: 0, skipped: [] }

  // Nothing to make on web: there is no directory to copy into, and the
  // picked file is already addressable for as long as the page lives.
  if (SUPPORTS_OFFLINE) await ensureDirectory()
  const existing = await listPads()
  const added: PadSample[] = []
  const skipped: string[] = []

  for (const asset of result.assets || []) {
    try {
      // The header decides the extension, not the file name. Copying an .ss2
      // under its own name leaves the player unable to tell what it is, even
      // when the bytes inside are an ordinary WAV.
      const extension = await resolveAudioExtension(asset.uri, asset.name)
      if (!extension) {
        skipped.push(asset.name)
        continue
      }

      const stamp = Date.now() + '_' + Math.floor(Math.random() * 10000)

      // Native copies the file into the app's own directory so the pad is
      // still there next week. The browser has nowhere to copy to, and does
      // not need one: the picker's URL already refers to the chosen file and
      // stays valid for as long as the page is open. So the pad works exactly
      // as it does in the app - it just does not outlive the tab, which is the
      // same bargain the rest of the web build makes.
      let uri = asset.uri
      if (SUPPORTS_OFFLINE) {
        uri = PAD_DIRECTORY + 'pad_' + stamp + extension
        await FileSystem.copyAsync({ from: asset.uri, to: uri })
      }

      added.push({
        id: 'p_' + stamp,
        name: tidyName(asset.name),
        uri,
        root: guessRootFromName(asset.name),
      })
    } catch (err) {
      console.log('[padLibrary] could not import', asset.name, err)
      skipped.push(asset.name)
    }
  }

  const combined = existing.concat(added)
  await saveIndex(combined)
  return { library: combined, added: added.length, skipped }
}

/** Say which key a pad belongs to, or clear it with null. */
export async function assignPad(id: string, root: number | null): Promise<PadSample[]> {
  const pads = await listPads()
  const next = pads.map(p => (p.id === id ? { ...p, root } : p))
  await saveIndex(next)
  return next
}

/** Forget a pad, and delete the copy that was made of it. */
export async function removePad(id: string): Promise<PadSample[]> {
  const pads = await listPads()
  const going = pads.find(p => p.id === id)

  if (going) {
    try {
      await FileSystem.deleteAsync(going.uri, { idempotent: true })
    } catch {
      // The index is what matters; a file left behind is not worth an error
    }
  }

  const next = pads.filter(p => p.id !== id)
  await saveIndex(next)
  return next
}

/** The pad to play for a key, if the user has given one. */
export function padForRoot(pads: PadSample[], root: number): PadSample | null {
  return pads.find(p => p.root === root) || null
}
