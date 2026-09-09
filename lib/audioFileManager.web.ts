// lib/audioFileManager.web.ts
/**
 * The same audio library as ./audioFileManager.ts, kept for the session.
 *
 * Audio Tools works the same way in a browser as it does in the app: pick a
 * track, play it, detect its key, shift its pitch. The only thing that cannot
 * be the same is where the file is put between those steps.
 *
 * Native copies it into the app's cache directory, so it is still there
 * tomorrow. There is no such directory here, and the file the picker returns
 * is already addressable - a blob: URL the page owns - so nothing is copied.
 * It is held in a map for as long as the tab is open and released when it is
 * finished with, which is exactly the bargain the rest of the web build makes:
 * everything works, nothing is stored.
 *
 * Blob URLs are revoked on delete rather than left to the page's lifetime,
 * because the bytes behind them are whole songs and a long session that
 * imported a dozen would otherwise hold every one of them in memory.
 */

export interface LocalAudioFile {
  id: string
  fileName: string
  localUri: string
  size: number
  createdAt: Date
  originalKey?: string
  targetKey?: string
  pitchShift?: number
  tempoAdjustPercent?: number
  tempoAdjustFactor?: number
}

/** Everything imported this session, newest last. */
const files = new Map<string, LocalAudioFile>()

/** Only the URLs this module created, so a picked URL is never revoked twice. */
const ownedUrls = new Set<string>()

/** Nothing to create - there is no folder. Kept so callers need not branch. */
export async function initializeAudioFolder(): Promise<void> {}

/**
 * Take a copy of the picked file, in the only sense the browser has one.
 *
 * The picker's own URL is re-fetched into a Blob we control rather than
 * simply kept. A URL handed to us belongs to whoever made it and can be
 * revoked from under us - re-fetching gives the library a handle with the same
 * lifetime as the entry that refers to it, and yields the real byte length,
 * which the caller shows.
 */
export async function saveAudioFileLocally(
  sourceUri: string,
  fileName: string,
  metadata?: Partial<LocalAudioFile>,
): Promise<LocalAudioFile> {
  try {
    const response = await fetch(sourceUri)
    const blob = await response.blob()
    const localUri = URL.createObjectURL(blob)
    ownedUrls.add(localUri)

    const timestamp = Date.now()
    const audioFile: LocalAudioFile = {
      id: `${timestamp}`,
      fileName,
      localUri,
      size: blob.size,
      createdAt: new Date(),
      ...metadata,
    }

    files.set(audioFile.id, audioFile)
    return audioFile
  } catch (error) {
    console.error('Error saving audio file:', error)
    throw error
  }
}

export async function getAllAudioFiles(): Promise<LocalAudioFile[]> {
  return Array.from(files.values()).sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
  )
}

export async function deleteAudioFile(fileId: string): Promise<void> {
  const going = files.get(fileId)
  if (!going) return

  if (ownedUrls.has(going.localUri)) {
    try {
      URL.revokeObjectURL(going.localUri)
    } catch {
      // Already gone; the entry is what mattered.
    }
    ownedUrls.delete(going.localUri)
  }

  files.delete(fileId)
}

export async function updateAudioFileMetadata(
  fileId: string,
  metadata: Partial<LocalAudioFile>,
): Promise<void> {
  const existing = files.get(fileId)
  if (!existing) return
  files.set(fileId, { ...existing, ...metadata })
}

export async function getAudioFileMetadata(
  fileId: string,
): Promise<Partial<LocalAudioFile> | null> {
  return files.get(fileId) ?? null
}

export async function clearAllAudioFiles(): Promise<void> {
  for (const id of Array.from(files.keys())) {
    await deleteAudioFile(id)
  }
}
