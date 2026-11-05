import type { Session } from '@supabase/supabase-js'
import { useEffect, useRef, useState } from 'react'
import { cloudAvailable } from './session.ts'
import { inviteToCloudProject, listCloudProjects, sendSignInLink, signOut, type CloudProject } from './supabase.ts'

/** Who's signed in, or a way to sign in with a link sent by email. */
export function AccountButton({ session }: { session: Session | null }) {
  const [open, setOpen] = useState(false)
  const [email, setEmail] = useState('')
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | { error: string }>('idle')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [open])

  if (!cloudAvailable) return null
  const send = async () => {
    setState('sending')
    try {
      await sendSignInLink(email.trim())
      setState('sent')
    } catch (e) {
      setState({ error: e instanceof Error ? e.message : String(e) })
    }
  }
  return (
    <div className="app-menu" ref={ref}>
      <button type="button" className="app-button" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}>
        {session ? (session.user.email ?? 'Signed in') : 'Sign in'}
      </button>
      {open && (
        <div className="app-menu-list app-account" role="dialog" aria-label="Account">
          {session ? (
            <>
              <p className="app-account-note">Signed in as {session.user.email}. Cities you share are kept in the cloud and open on any device.</p>
              <button type="button" className="app-menu-item" onClick={() => void signOut().then(() => setOpen(false))}>
                Sign out
              </button>
            </>
          ) : state === 'sent' ? (
            <p className="app-account-note">Check your email: the link in it signs you in here.</p>
          ) : (
            <form
              className="app-account-form"
              onSubmit={(e) => {
                e.preventDefault()
                void send()
              }}
            >
              <p className="app-account-note">Sign in to share cities and work on them together. We'll email you a link.</p>
              <input
                className="app-input"
                type="email"
                required
                placeholder="you@example.com"
                value={email}
                autoFocus
                onChange={(e) => setEmail(e.target.value)}
              />
              <button type="submit" className="app-button app-button-primary" disabled={state === 'sending'}>
                {state === 'sending' ? 'Sending…' : 'Send link'}
              </button>
              {typeof state === 'object' && <p className="app-account-error">{state.error}</p>}
            </form>
          )}
        </div>
      )}
    </div>
  )
}

/** Cities other people shared that aren't on this device yet. */
export function SharedWithYou({ session, known, onOpen }: { session: Session | null; known: ReadonlySet<string>; onOpen: (project: CloudProject) => void }) {
  const [projects, setProjects] = useState<CloudProject[] | null>(null)
  useEffect(() => {
    if (!session) return
    let live = true
    listCloudProjects()
      .then((list) => live && setProjects(list))
      .catch(() => live && setProjects([]))
    return () => {
      live = false
    }
  }, [session])
  const fresh = (projects ?? []).filter((p) => !known.has(p.id))
  if (!session || fresh.length === 0) return null
  return (
    <section aria-labelledby="gallery-shared">
      <h2 id="gallery-shared" className="gallery-heading">
        Shared with you
      </h2>
      <ul className="gallery-shared">
        {fresh.map((project) => (
          <li key={project.id}>
            <span>{project.name}</span>
            <button type="button" className="app-button" onClick={() => onOpen(project)}>
              Open
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** Invites someone, by the email they sign in with, to a shared city. */
export function InviteDialog({ cloudId, name, onClose }: { cloudId: string; name: string; onClose: () => void }) {
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<'editor' | 'viewer'>('editor')
  const [state, setState] = useState<'idle' | 'sending' | 'done' | { error: string }>('idle')
  const invite = async () => {
    setState('sending')
    try {
      await inviteToCloudProject(cloudId, email.trim(), role)
      setState('done')
    } catch (e) {
      setState({ error: e instanceof Error ? e.message : String(e) })
    }
  }
  return (
    <div className="app-dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="app-dialog"
        role="dialog"
        aria-label={`Invite people to ${name}`}
        onSubmit={(e) => {
          e.preventDefault()
          void invite()
        }}
      >
        <h2>Invite people to {name}</h2>
        <p className="app-account-note">They need to have signed in to Plinth once with this address.</p>
        <input className="app-input" type="email" required placeholder="their@email.com" value={email} autoFocus onChange={(e) => setEmail(e.target.value)} />
        <label className="app-account-note">
          <input type="radio" checked={role === 'editor'} onChange={() => setRole('editor')} /> Can edit
        </label>
        <label className="app-account-note">
          <input type="radio" checked={role === 'viewer'} onChange={() => setRole('viewer')} /> Can only look
        </label>
        {state === 'done' && <p className="app-account-note">Invited. The city shows up in their gallery under Shared with you.</p>}
        {typeof state === 'object' && <p className="app-account-error">{state.error}</p>}
        <div className="app-dialog-actions">
          <button type="button" className="app-button" onClick={onClose}>
            Close
          </button>
          <button type="submit" className="app-button app-button-primary" disabled={state === 'sending'}>
            Invite
          </button>
        </div>
      </form>
    </div>
  )
}
