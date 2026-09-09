// lib/seedData.ts
/**
 * Seed data for testing the app
 * Run this once during development to populate database with sample data
 */

import { Artist, ChordList, Song } from '../db/models'
import { query, execute } from '../db/index'
import uuid from 'react-native-uuid'

export async function seedDatabase(userId: string) {
  try {
    console.log('Seeding database with test data...')

    const now = Date.now()

    // Create artists
    const hillsongId = uuid.v4()
    const bethelId = uuid.v4()

    await execute(
      'INSERT INTO artists (id, name, user_id, created_at, updated_at, _synced) VALUES (?, ?, ?, ?, ?, ?)',
      [hillsongId, 'Hillsong United', userId, now, now, 0]
    )

    await execute(
      'INSERT INTO artists (id, name, user_id, created_at, updated_at, _synced) VALUES (?, ?, ?, ?, ?, ?)',
      [bethelId, 'Bethel Church', userId, now, now, 0]
    )

    // Create chord list
    const worshipListId = uuid.v4()
    await execute(
      'INSERT INTO chord_lists (id, title, artist_id, user_id, is_private, created_at, updated_at, _synced) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [worshipListId, 'Sunday Worship Service', hillsongId, userId, 0, now, now, 0]
    )

    // Create songs
    const songs = [
      {
        title: 'What A Beautiful Name',
        key: 'A',
        content: `[A]You were the Word at the beginning
[A]One with God, you have always been
[A]Called us out of the dark into your [E]marvelous light
[A]You have always been the Lord of all creation

[A]Welcome all, ye unfaithful lifting your eyes
[A]To the mercy of the Father, thrones laid bare
[A]Not asking why you have always been right there

[F#m]Oh what a beautiful name it is
[D]What a beautiful name it is
[A]The Name of Jesus Christ my King`,
      },
      {
        title: 'Goodness of God',
        key: 'D',
        content: `[D]All my life you have been faithful
[D]All my life you have been so, so good
[D]With every breath that I am taking
[D]I will sing of the goodness of God

[D]I love you, Lord
[A]For your mercy never fails me
[D]All my days, I have been held in your hands
[D]From the moment that I wake up
[D]Until I lay my head
[D]I will sing of the goodness of God`,
      },
      {
        title: 'Living Hope',
        key: 'E',
        content: `[E]Even when I don't see it coming
[E]Even when I don't see it all working
[E]Even when I can't seem to find my way out
[E]I will trust, I will trust, I will trust in you

[E]There is a hope that's ever true
[E]More powerful than what I see
[E]Fear, you lose the power over me
[E]I will trust in you always`,
      },
    ]

    for (const songData of songs) {
      const songId = uuid.v4()
      await execute(
        'INSERT INTO songs (id, chord_list_id, title, content, key, created_at, updated_at, _synced) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [songId, worshipListId, songData.title, songData.content, songData.key, now, now, 0]
      )
    }

    console.log('Database seeded successfully!')
  } catch (err) {
    console.error('Error seeding database:', err)
  }
}

/**
 * Clear all data (for testing/reset)
 */
export async function clearDatabase() {
  try {
    const tables = ['songs', 'chord_lists', 'artists', 'messages', 'lineup_items', 'lineups']

    for (const tableName of tables) {
      await execute(`DELETE FROM ${tableName}`, [])
    }

    console.log('Database cleared successfully!')
  } catch (err) {
    console.error('Error clearing database:', err)
  }
}
