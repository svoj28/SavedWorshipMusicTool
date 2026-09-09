import { useEffect, useState } from 'react'
import { getCurrentUser } from './auth'
import { getUserProfileByUserId } from '../db/queries'
import { supabase } from './supabase'
import { isOnline } from './networkStatus'

export type UserRole = 'superadmin' | 'admin' | 'manager' | 'user' | 'guest'

export function useRole() {
  const [role, setRole] = useState<UserRole>('guest')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const load = async () => {
      try {
        const user = await getCurrentUser()
        if (!user) { setRole('guest'); setLoading(false); return }

        // Try local first
        const profile = await getUserProfileByUserId(user.id)
        const localRole = profile?.role as UserRole | undefined

        if (localRole && localRole !== 'user') {
          // Has a specific role set locally
          setRole(localRole)
          setLoading(false)
          return
        }

        const online = await isOnline()
        if (!online) {
          setRole(localRole ?? 'user')
          setLoading(false)
          return
        }

        // Always verify role from Supabase to catch superadmin/admin
        const { data } = await supabase
          .from('user_profiles')
          .select('role')
          .eq('user_id', user.id)
          .single()

        if (data?.role) {
          setRole(data.role as UserRole)

          // Update local SQLite so future loads are fast
          const { execute } = await import('../db/index')
          try {
            await execute(
              `UPDATE user_profiles SET role = ? WHERE user_id = ?`,
              [data.role, user.id]
            )
          } catch (e) {}
        } else {
          setRole(localRole ?? 'user')
        }
      } catch {
        setRole('user')
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  return {
    role,
    loading,
    isSuperAdmin: role === 'superadmin',
    isManager: role === 'manager',
    isAdmin: role === 'admin',
    isUser: role === 'user',
    // 'manager' can perform full CRUD like superadmin
    canManageChords: role === 'superadmin' || role === 'manager',
    canManageContent: role === 'superadmin' || role === 'admin' || role === 'manager',
    canManageCalendar: role === 'superadmin' || role === 'manager',
    canMessage: role !== 'guest',
    canEditProfile: role !== 'guest',
    canAddContacts: role !== 'guest',
  }
}