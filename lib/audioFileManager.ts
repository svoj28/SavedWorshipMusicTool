// lib/audioFileManager.ts
import * as FileSystem from 'expo-file-system/legacy'

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

// Use cache directory as the base path
const AUDIO_FOLDER_NAME = 'SavedWorshipMusic/audio-files'
const getAudioFolder = () => {
  const baseDir = FileSystem.cacheDirectory || FileSystem.documentDirectory
  return `${baseDir}${AUDIO_FOLDER_NAME}/`
}

/**
 * Initialize audio folder if it doesn't exist
 */
export async function initializeAudioFolder(): Promise<void> {
  try {
    const folderPath = getAudioFolder()
    const folderInfo = await FileSystem.getInfoAsync(folderPath)
    if (!folderInfo.exists) {
      await FileSystem.makeDirectoryAsync(folderPath, { intermediates: true })
    }
  } catch (error) {
    console.error('Error initializing audio folder:', error)
    throw error
  }
}

/**
 * Save audio file locally
 */
export async function saveAudioFileLocally(
  sourceUri: string,
  fileName: string,
  metadata?: Partial<LocalAudioFile>
): Promise<LocalAudioFile> {
  try {
    await initializeAudioFolder()

    const folderPath = getAudioFolder()
    // Create a unique filename
    const timestamp = Date.now()
    const fileExtension = fileName.split('.').pop() || 'mp3'
    const newFileName = `audio-${timestamp}.${fileExtension}`
    const destinationUri = `${folderPath}${newFileName}`

    // Copy the file
    await FileSystem.copyAsync({
      from: sourceUri,
      to: destinationUri,
    })

    // Get file size
    const fileInfo = await FileSystem.getInfoAsync(destinationUri)
    const size =
      fileInfo.exists && 'size' in fileInfo && typeof fileInfo.size === 'number'
        ? fileInfo.size
        : 0

    const audioFile: LocalAudioFile = {
      id: `${timestamp}`,
      fileName: fileName,
      localUri: destinationUri,
      size,
      createdAt: new Date(),
      ...metadata,
    }

    return audioFile
  } catch (error) {
    console.error('Error saving audio file:', error)
    throw error
  }
}

/**
 * Get all saved audio files
 */
export async function getAllAudioFiles(): Promise<LocalAudioFile[]> {
  try {
    await initializeAudioFolder()

    const folderPath = getAudioFolder()
    const files = await FileSystem.readDirectoryAsync(folderPath)
    const audioFiles: LocalAudioFile[] = []

    for (const file of files) {
      try {
        const fileUri = `${folderPath}${file}`
        const fileInfo = await FileSystem.getInfoAsync(fileUri)

        if (fileInfo.exists) {
          const size =
            'size' in fileInfo && typeof fileInfo.size === 'number' ? fileInfo.size : 0
          const modificationTimeSeconds =
            'modificationTime' in fileInfo && typeof fileInfo.modificationTime === 'number'
              ? fileInfo.modificationTime
              : Date.now() / 1000

          audioFiles.push({
            id: file,
            fileName: file,
            localUri: fileUri,
            size,
            createdAt: new Date(modificationTimeSeconds * 1000),
          })
        }
      } catch (error) {
        console.error(`Error processing file ${file}:`, error)
      }
    }

    return audioFiles.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
  } catch (error) {
    console.error('Error getting audio files:', error)
    return []
  }
}

/**
 * Delete an audio file
 */
export async function deleteAudioFile(fileId: string): Promise<void> {
  try {
    const folderPath = getAudioFolder()
    const fileUri = `${folderPath}${fileId}`
    await FileSystem.deleteAsync(fileUri)
  } catch (error) {
    console.error('Error deleting audio file:', error)
    throw error
  }
}

/**
 * Update audio file metadata
 */
export async function updateAudioFileMetadata(
  fileId: string,
  metadata: Partial<LocalAudioFile>
): Promise<void> {
  try {
    // Since we can't directly update files, we need to save metadata in a separate JSON file
    const folderPath = getAudioFolder()
    const metadataPath = `${folderPath}.metadata.json`
    let allMetadata: Record<string, Partial<LocalAudioFile>> = {}

    try {
      const existingData = await FileSystem.readAsStringAsync(metadataPath)
      allMetadata = JSON.parse(existingData)
    } catch {
      // File doesn't exist yet
    }

    allMetadata[fileId] = { ...allMetadata[fileId], ...metadata }

    await FileSystem.writeAsStringAsync(metadataPath, JSON.stringify(allMetadata, null, 2))
  } catch (error) {
    console.error('Error updating metadata:', error)
    throw error
  }
}

/**
 * Get audio file metadata
 */
export async function getAudioFileMetadata(fileId: string): Promise<Partial<LocalAudioFile> | null> {
  try {
    const folderPath = getAudioFolder()
    const metadataPath = `${folderPath}.metadata.json`
    const data = await FileSystem.readAsStringAsync(metadataPath)
    const allMetadata = JSON.parse(data)
    return allMetadata[fileId] || null
  } catch (error) {
    // File doesn't exist or metadata not found
    return null
  }
}

/**
 * Clear all audio files (use with caution)
 */
export async function clearAllAudioFiles(): Promise<void> {
  try {
    await initializeAudioFolder()
    const folderPath = getAudioFolder()
    const files = await FileSystem.readDirectoryAsync(folderPath)

    for (const file of files) {
      const fileUri = `${folderPath}${file}`
      await FileSystem.deleteAsync(fileUri)
    }
  } catch (error) {
    console.error('Error clearing audio files:', error)
    throw error
  }
}

