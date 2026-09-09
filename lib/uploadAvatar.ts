import { supabase } from './supabase'
import * as FileSystem from 'expo-file-system/legacy'

export async function uploadAvatar(userId: string, localUri: string): Promise<string | null> {
  try {
    // Read the file as base64
    const base64 = await FileSystem.readAsStringAsync(localUri, {
      encoding: 'base64',
    })

    const fileName = `${userId}/avatar.jpg`
    const contentType = 'image/jpeg'

    // Convert base64 to ArrayBuffer
    const byteCharacters = atob(base64)
    const byteNumbers = new Array(byteCharacters.length)
    for (let i = 0; i < byteCharacters.length; i++) {
      byteNumbers[i] = byteCharacters.charCodeAt(i)
    }
    const byteArray = new Uint8Array(byteNumbers)

    const { data, error } = await supabase.storage
      .from('avatars')
      .upload(fileName, byteArray, {
        contentType,
        upsert: true,
      })

    if (error) {
      console.error('Upload error:', error)
      return null
    }

    // Get public URL
    const { data: urlData } = supabase.storage
      .from('avatars')
      .getPublicUrl(fileName)

    return `${urlData.publicUrl}?t=${Date.now()}`
  } catch (err) {
    console.error('uploadAvatar error:', err)
    return null
  }
}