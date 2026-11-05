import type { Session } from '@supabase/supabase-js'
import { useEffect, useState } from 'react'
import { currentSession, onSessionChange, supabase } from './supabase.ts'

/** Whether the app is set up for the cloud at all. */
export const cloudAvailable = supabase !== null

/** The signed-in session, kept up to date. */
export function useSession(): Session | null {
  const [session, setSession] = useState<Session | null>(null)
  useEffect(() => {
    if (!cloudAvailable) return
    let live = true
    void currentSession().then((s) => live && setSession(s))
    const stop = onSessionChange((s) => setSession(s))
    return () => {
      live = false
      stop()
    }
  }, [])
  return session
}

