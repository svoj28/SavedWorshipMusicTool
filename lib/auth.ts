// lib/auth.ts
import { supabase } from './supabase'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { isOnline } from './networkStatus'
import { SUPPORTS_OFFLINE } from './platform'
import { resetDatabase } from '../db/index'

export const OFFLINE_GUEST_USER_ID = 'offline-guest'
const CACHED_USER_KEY = 'savedworship_cached_auth_user'

async function cacheUser(user: AuthUser) {
  try {
    await AsyncStorage.setItem(CACHED_USER_KEY, JSON.stringify(user))
  } catch (err) {
    console.warn('Failed to cache auth user:', err)
  }
}

async function getCachedUser(): Promise<AuthUser | null> {
  try {
    const cached = await AsyncStorage.getItem(CACHED_USER_KEY)
    return cached ? JSON.parse(cached) as AuthUser : null
  } catch (err) {
    console.warn('Failed to read cached auth user:', err)
    return null
  }
}

async function clearCachedUser() {
  try {
    await AsyncStorage.removeItem(CACHED_USER_KEY)
  } catch (err) {
    console.warn('Failed to clear cached auth user:', err)
  }
}

function createOfflineGuestUser(): AuthUser {
  return {
    id: OFFLINE_GUEST_USER_ID,
    email: 'offline@local',
    user_metadata: { offline: true },
  }
}

/**
 * Distinguish "the server rejected our credentials" from "we couldn't reach
 * the server". Only the former means the user is genuinely signed out — a
 * network failure must not kick an offline user to the sign-in screen.
 */
function isDefinitiveAuthRejection(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { status?: number; message?: string; name?: string }
  if (e.status === 400 || e.status === 401 || e.status === 403) return true
  if (e.name === 'AuthApiError') return true
  return /invalid refresh token|refresh token not found|jwt expired|user not found/i.test(
    e.message || ''
  )
}

export interface AuthUser {
  id: string
  email: string
  user_metadata?: Record<string, any>
}

export interface AuthError {
  message: string
  code?: string
}

/**
 * Sign up with email and password
 */
export async function signUpWithEmail(
  email: string,
  password: string,
  displayName?: string
): Promise<{ user: AuthUser | null; error: AuthError | null }> {
  try {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          display_name: displayName,
        },
      },
    })

    if (error) {
      return { user: null, error: { message: error.message, code: error.code } }
    }

    if (data.user) {
      await cacheUser({
        id: data.user.id,
        email: data.user.email || '',
        user_metadata: data.user.user_metadata,
      })

      // Create local profile with displayName as nickname
      try {
        const { createUserProfile } = await import('../db/queries')
        await createUserProfile({
          userId: data.user.id,
          nickname: displayName || '',  // ← displayName becomes nickname
          bio: '',
          avatarUrl: '',
          instruments: '',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          synced: false,
          role: 'user',
        })
      } catch (profileErr) {
        console.warn('Profile creation skipped:', profileErr)
      }

      return {
        user: {
          id: data.user.id,
          email: data.user.email || '',
          user_metadata: data.user.user_metadata,
        },
        error: null,
      }
    }

    return { user: null, error: { message: 'Sign up failed' } }
  } catch (err) {
    return {
      user: null,
      error: { message: err instanceof Error ? err.message : 'Unknown error' },
    }
  }
}

/**
 * Sign in with email and password
 */
export async function signInWithEmail(
  email: string,
  password: string
): Promise<{ user: AuthUser | null; error: AuthError | null }> {
  try {
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    })

    if (error) {
      return { user: null, error: { message: error.message, code: error.code } }
    }

    if (data.user) {
      await cacheUser({
        id: data.user.id,
        email: data.user.email || '',
        user_metadata: data.user.user_metadata,
      })

      return {
        user: {
          id: data.user.id,
          email: data.user.email || '',
          user_metadata: data.user.user_metadata,
        },
        error: null,
      }
    }

    return { user: null, error: { message: 'Sign in failed' } }
  } catch (err) {
    return {
      user: null,
      error: { message: err instanceof Error ? err.message : 'Unknown error' },
    }
  }
}

/**
 * Sign in with Google (Expo)
 * Note: For Google OAuth to work in React Native, you need to:
 * 1. Set up OAuth credentials in Google Cloud Console
 * 2. Configure Redirect URI in Supabase dashboard
 * 3. Use deeplink handling to capture auth callback
 */
export async function signInWithGoogle(): Promise<{
  user: AuthUser | null
  error: AuthError | null
}> {
  try {
    // This is a simplified version. In production, you'll need:
    // - expo-auth-session for proper OAuth flow
    // - deeplink handling for redirect URI
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: 'savedworshipmusictool://auth/callback',
      },
    })

    if (error) {
      return { user: null, error: { message: error.message } }
    }

    return { user: null, error: null } // Will complete via deeplink
  } catch (err) {
    return {
      user: null,
      error: { message: err instanceof Error ? err.message : 'Unknown error' },
    }
  }
}

/**
 * Sign out current user
 */
export async function signOut(): Promise<{ error: AuthError | null }> {
  try {
    const { error } = await supabase.auth.signOut()

    if (error) {
      return { error: { message: error.message } }
    }

    await clearCachedUser()
    // No-op on native, where the local database is the offline copy and is
    // meant to survive. On web it is a session cache in memory, and the next
    // person to use this browser must not find the last one's data in it.
    await resetDatabase()

    return { error: null }
  } catch (err) {
    return {
      error: { message: err instanceof Error ? err.message : 'Unknown error' },
    }
  }
}

/**
 * Get current authenticated user (from session)
 */
export async function getCurrentUser(): Promise<AuthUser | null> {
  try {
    const { data, error } = await supabase.auth.getSession()

    if (error || !data.session?.user) {
      // The stored refresh token was rejected outright (revoked, expired, or
      // wiped server-side). The user really is signed out — keeping the cached
      // user here would leave the app "logged in" while every query 401s.
      if (error && isDefinitiveAuthRejection(error)) {
        await supabase.auth.signOut({ scope: 'local' }).catch(() => {})
        await clearCachedUser()
        return null
      }

      // On web there is no such thing as being signed in without a session.
      // The fallbacks below exist so that a phone with no signal keeps working
      // from what it already has - a cached identity, or a guest to attribute
      // local work to. Neither means anything in a browser, which stores
      // nothing and must reach Supabase to show a single song. Allowing them
      // here is what let the web build open straight into an empty app instead
      // of asking the user to sign in.
      if (!SUPPORTS_OFFLINE) {
        await clearCachedUser()
        return null
      }

      // Session check failed/empty — this can happen offline when a token
      // refresh fails even though the user is still legitimately signed in.
      // Prefer the cached user over kicking them to the sign-in screen.
      const cached = await getCachedUser()
      if (cached) return cached

      if (!(await isOnline())) {
        return createOfflineGuestUser()
      }

      await clearCachedUser()
      return null
    }

    const currentUser: AuthUser = {
      id: data.session.user.id,
      email: data.session.user.email || '',
      user_metadata: data.session.user.user_metadata,
    }

    await cacheUser(currentUser)
    return currentUser
  } catch (err) {
    console.error('Error getting current user:', err)
    if (isDefinitiveAuthRejection(err)) {
      await supabase.auth.signOut({ scope: 'local' }).catch(() => {})
      await clearCachedUser()
      return null
    }
    // Same rule as above: on web, no session means signed out.
    if (!SUPPORTS_OFFLINE) return null
    const cached = await getCachedUser()
    if (cached) return cached
    if (!(await isOnline())) return createOfflineGuestUser()
    return null
  }
}

/**
 * Check if user is authenticated (check stored session)
 */
export async function isAuthenticated(): Promise<boolean> {
  try {
    const { data } = await supabase.auth.getSession()
    return !!data.session
  } catch {
    return false
  }
}

/**
 * Listen for auth state changes
 */
export function onAuthStateChange(
  callback: (user: AuthUser | null) => void
): () => void {
  const { data } = supabase.auth.onAuthStateChange(async (event, session) => {
    if (session?.user) {
      const authUser = {
        id: session.user.id,
        email: session.user.email || '',
        user_metadata: session.user.user_metadata,
      }
      await cacheUser(authUser)
      callback(authUser)
      return
    }

    // No session — only clear the cache on an EXPLICIT sign-out.
    // A null session from a failed offline token refresh (event is usually
    // 'INITIAL_SESSION' or 'TOKEN_REFRESHED' in that case) should not log
    // the user out; fall back to whatever we have cached.
    if (event === 'SIGNED_OUT') {
      await clearCachedUser()
      callback(null)
      return
    }

    // A null session on web is simply signed out. This callback firing with
    // a guest on INITIAL_SESSION is what put an unauthenticated visitor
    // straight into the app.
    if (!SUPPORTS_OFFLINE) {
      callback(null)
      return
    }

    callback((await getCachedUser()) ?? createOfflineGuestUser())
  })

  return () => {
    if (data?.subscription) {
      data.subscription.unsubscribe()
    }
  }
}

/**
 * Password reset - send reset link to email
 */
export async function resetPassword(email: string): Promise<{ error: AuthError | null }> {
  try {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
  redirectTo: 'savedworship://reset-password',
})

    if (error) {
      return { error: { message: error.message } }
    }

    return { error: null }
  } catch (err) {
    return {
      error: { message: err instanceof Error ? err.message : 'Unknown error' },
    }
  }
}
