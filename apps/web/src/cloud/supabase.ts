import { fromBase64, toBase64, type ChangeStore, type LiveChannel, type Peer } from '@plinth/sync'
import { createClient, type RealtimeChannel, type Session, type SupabaseClient } from '@supabase/supabase-js'
import * as Y from 'yjs'

/**
 * Plinth's cloud on Supabase: accounts (sign-in by an emailed link),
 * projects shared with other people, every change kept in the database and
 * passed on live to whoever has the project open. Set up with the SQL in
 * supabase/migrations and two settings in the app's environment:
 * VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY. Without them the app works
 * as before, on this device only.
 */

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

/** The cloud, when the app is set up for one. */
export const supabase: SupabaseClient | null = url && key ? createClient(url, key) : null

/** A change too big for one live message goes as a hint to load it from the database instead. */
const MAX_LIVE_BYTES = 200_000

export interface CloudProject {
  id: string
  name: string
  owner: string
  updatedAt: number
}

// Accounts

export function currentSession(): Promise<Session | null> {
  return supabase ? supabase.auth.getSession().then(({ data }) => data.session) : Promise.resolve(null)
}

export function onSessionChange(listener: (session: Session | null) => void): () => void {
  if (!supabase) return () => {}
  const { data } = supabase.auth.onAuthStateChange((_event, session) => listener(session))
  return () => data.subscription.unsubscribe()
}

/** Emails a sign-in link to an address. */
export async function sendSignInLink(email: string): Promise<void> {
  if (!supabase) throw new Error('The cloud is not set up.')
  const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.origin } })
  if (error) throw error
}

export async function signOut(): Promise<void> {
  await supabase?.auth.signOut()
}

// Projects

export async function listCloudProjects(): Promise<CloudProject[]> {
  if (!supabase) return []
  const { data, error } = await supabase.from('projects').select('id, name, owner, updated_at').order('updated_at', { ascending: false })
  if (error) throw error
  return (data ?? []).map((row) => ({ id: row.id, name: row.name, owner: row.owner, updatedAt: Date.parse(row.updated_at) }))
}

export async function createCloudProject(name: string): Promise<string> {
  if (!supabase) throw new Error('The cloud is not set up.')
  const { data, error } = await supabase.from('projects').insert({ name }).select('id').single()
  if (error) throw error
  return data.id as string
}

export async function renameCloudProject(id: string, name: string): Promise<void> {
  const { error } = (await supabase?.from('projects').update({ name }).eq('id', id)) ?? {}
  if (error) throw error
}

export async function inviteToCloudProject(id: string, email: string, role: 'editor' | 'viewer' = 'editor'): Promise<void> {
  if (!supabase) throw new Error('The cloud is not set up.')
  const { error } = await supabase.rpc('invite_to_project', { project: id, email, member_role: role })
  if (error) throw error
}

// Sync services

/** Every change to a project, kept as rows of project_changes. */
export class SupabaseStore implements ChangeStore {
  private readonly client: SupabaseClient
  /** The newest row each project was loaded up to: compaction only folds rows this copy has. */
  private loadedTo = new Map<string, number>()

  constructor(client: SupabaseClient) {
    this.client = client
  }

  async load(projectId: string): Promise<Uint8Array[]> {
    const rows: { id: number; change: string }[] = []
    // In pages: a project can have many rows between compactions.
    for (let from = 0; ; from += 1000) {
      const { data, error } = await this.client
        .from('project_changes')
        .select('id, change')
        .eq('project_id', projectId)
        .order('id')
        .range(from, from + 999)
      if (error) throw error
      rows.push(...(data ?? []))
      if (!data || data.length < 1000) break
    }
    this.loadedTo.set(projectId, rows.at(-1)?.id ?? 0)
    return rows.map((row) => fromBase64(row.change))
  }

  async append(projectId: string, update: Uint8Array): Promise<void> {
    const { error } = await this.client.from('project_changes').insert({ project_id: projectId, change: toBase64(update) })
    if (error) throw error
  }

  async compact(projectId: string, state: Uint8Array): Promise<void> {
    const upTo = this.loadedTo.get(projectId)
    if (!upTo) return
    const { data, error } = await this.client
      .from('project_changes')
      .insert({ project_id: projectId, change: toBase64(state) })
      .select('id')
      .single()
    if (error) throw error
    // The merged state holds everything up to what was loaded; rows since stay.
    await this.client.from('project_changes').delete().eq('project_id', projectId).lte('id', upTo).lt('id', data.id)
    this.loadedTo.set(projectId, data.id as number)
  }
}

/** Live changes and who's here, over a private Realtime channel per project. */
export class SupabaseChannel implements LiveChannel {
  private readonly client: SupabaseClient
  private readonly store: ChangeStore
  private channels = new Map<string, RealtimeChannel>()

  constructor(client: SupabaseClient, store: ChangeStore) {
    this.client = client
    this.store = store
  }

  async join(projectId: string, me: Peer, handlers: { change: (update: Uint8Array) => void; peers: (peers: Peer[]) => void }) {
    const channel = this.client.channel(`project:${projectId}`, {
      config: { private: true, broadcast: { self: false }, presence: { key: me.id } },
    })
    channel.on('broadcast', { event: 'change' }, ({ payload }) => {
      if (typeof payload?.u === 'string') handlers.change(fromBase64(payload.u))
    })
    // A change too big to pass on live: load what's kept, which includes it.
    channel.on('broadcast', { event: 'reload' }, () => {
      void this.store.load(projectId).then((kept) => {
        if (kept.length > 0) handlers.change(Y.mergeUpdates(kept))
      })
    })
    channel.on('presence', { event: 'sync' }, () => {
      const state = channel.presenceState<{ id: string; name: string }>()
      const peers = Object.values(state)
        .flat()
        .map((p) => ({ id: p.id, name: p.name }))
        .filter((p, i, all) => p.id !== me.id && all.findIndex((q) => q.id === p.id) === i)
      handlers.peers(peers)
    })
    await new Promise<void>((resolve, reject) => {
      channel.subscribe((status, error) => {
        if (status === 'SUBSCRIBED') {
          void channel.track({ id: me.id, name: me.name })
          resolve()
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') reject(error ?? new Error(`Live channel ${status}`))
      })
    })
    this.channels.set(projectId, channel)
    return () => {
      this.channels.delete(projectId)
      void this.client.removeChannel(channel)
    }
  }

  send(projectId: string, update: Uint8Array): void {
    const channel = this.channels.get(projectId)
    if (!channel) return
    if (update.length > MAX_LIVE_BYTES) void channel.send({ type: 'broadcast', event: 'reload', payload: {} })
    else void channel.send({ type: 'broadcast', event: 'change', payload: { u: toBase64(update) } })
  }
}

/** The sync services, when the cloud is set up. */
export const cloudServices = supabase
  ? (() => {
      const store = new SupabaseStore(supabase)
      return { store, channel: new SupabaseChannel(supabase, store) }
    })()
  : null
