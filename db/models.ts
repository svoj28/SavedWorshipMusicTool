// db/models.ts
/**
 * TypeScript types for database models
 * Simple interface-based models for expo-sqlite compatibility
 */

export interface Artist {
  id: string
  name: string
  userId: string
  createdAt: number
  updatedAt: number
  synced: boolean
}

export interface ImportantMessage {
  id: string
  title: string
  content: string
  userId: string
  createdAt: number
  updatedAt: number
  synced: boolean
}

export interface ChordList {
  id: string
  title: string
  artistId: string
  userId: string
  isPrivate: boolean
  createdAt: number
  updatedAt: number
  synced: boolean
}

export interface Song {
  id: string
  chordListId: string
  userId: string
  title: string
  content: string
  key: string
  youtubeUrl?: string
  createdAt: number
  updatedAt: number
  synced: boolean
}

export interface Lineup {
  id: string
  title: string
  userId: string
  description?: string
  createdAt: number
  updatedAt: number
  synced: boolean
  items?: LineupItem[]
}

export interface LineupItem {
  id: string
  lineupId: string
  songId?: string
  userId: string
  position: number
  artist: string
  songTitle: string
  key?: string
  versionUrl?: string
  category?: 'joyful' | 'solemn' | 'victory' | 'any'
  createdAt: number
  updatedAt: number
  synced: boolean
}

export interface Message {
  id: string
  senderId: string
  receiverId: string
  text: string
  createdAt: number
  updatedAt: number
  isDeleted: boolean
  editedAt?: number
  synced: boolean
}

export interface FileDropper {
  id: string
  title: string
  userId: string
  fileUrl: string
  description?: string
  createdAt: number
  updatedAt: number
  synced: boolean
}

export interface ImportantAnnouncement {
  id: string
  title: string
  userId: string
  content: string
  createdAt: number
  updatedAt: number
  synced: boolean
}

export interface VersionDropper {
  id: string
  title: string
  userId: string
  youtubeUrl: string
  description?: string
  createdAt: number
  updatedAt: number
  synced: boolean
}

export interface CalendarAssignment {
  role: string
  person: string
  note?: string
}

export interface CalendarEvent {
  id: string
  eventDate: string
  title: string
  assignments: CalendarAssignment[]
  notes?: string
  userId: string
  createdAt: number
  updatedAt: number
  synced: boolean
}

export interface Contact {
  id: string
  userId: string
  contactUserId: string
  contactEmail?: string
  contactName?: string
  status: 'pending' | 'accepted' | 'blocked'
  createdAt: number
  updatedAt: number
  synced: boolean
}

export interface UserProfile {
  id: string
  userId: string
  nickname?: string
  bio?: string
  avatarUrl?: string
  instruments?: string
  createdAt: number
  updatedAt: number
  synced: boolean
  role?: string
}

export interface Playlist {
  id: string
  userId: string
  title: string
  description?: string
  createdAt: number
  updatedAt: number
  synced: boolean
}

export interface PlaylistItem {
  id: string
  playlistId: string
  userId: string
  chordListId?: string
  songId?: string
  position: number
  createdAt: number
  synced: boolean
}
