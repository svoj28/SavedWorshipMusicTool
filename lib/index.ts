// lib/index.ts
/**
 * Centralized exports for easier imports
 * Import from 'lib' instead of 'lib/supabase', 'lib/auth', etc.
 */

// Auth
export {
  signUpWithEmail,
  signInWithEmail,
  signInWithGoogle,
  signOut,
  getCurrentUser,
  isAuthenticated,
  onAuthStateChange,
  resetPassword,
  type AuthUser,
  type AuthError,
} from './auth'

// Transpose
export {
  transposeChord,
  transposeText,
  getTransposeDistance,
  getAllKeys,
  getRelativeMinor,
} from './transpose'

// Sync
export {
  syncPushToSupabase,
  syncPullFromSupabase,
  fullSync,
  subscribeToChanges,
} from './sync'

// Supabase client
export { supabase } from './supabase'

// Seed data
export { seedDatabase, clearDatabase } from './seedData'
