import * as Y from 'yjs'

/**
 * Keeping a project's Yjs document in step with everyone else's copy of it,
 * through two services: a store that keeps every change (so a copy opened
 * later catches up) and a live channel that passes changes on as they
 * happen (so copies open at the same time see each other's edits at
 * once). Yjs merges changes in any order, so a change that arrives twice,
 * or late, is harmless.
 *
 * The services are interfaces: Supabase in the app, plain memory in tests.
 */

/** Where every change to a project is kept. */
export interface ChangeStore {
  /** Everything kept for a project so far: the compacted state and the changes since. */
  load(projectId: string): Promise<Uint8Array[]>
  /** Keeps one more change. */
  append(projectId: string, update: Uint8Array): Promise<void>
  /** Replaces what's kept with one merged state, once there are many changes (optional). */
  compact?(projectId: string, state: Uint8Array, replacing: number): Promise<void>
}

/** Someone with the project open. */
export interface Peer {
  id: string
  name: string
}

/** Passes changes between copies that are open at the same time, and says who's there. */
export interface LiveChannel {
  /** Starts listening; returns a function that stops. */
  join(projectId: string, me: Peer, handlers: { change: (update: Uint8Array) => void; peers: (peers: Peer[]) => void }): Promise<() => void>
  send(projectId: string, update: Uint8Array): void
}

export type SyncStatus = 'connecting' | 'synced' | 'offline' | 'error'

export interface SyncOptions {
  store: ChangeStore
  channel: LiveChannel
  me: Peer
  /** Compact the store after this many changes (default 200). */
  compactAfter?: number
  onStatus?: (status: SyncStatus, error?: unknown) => void
  onPeers?: (peers: Peer[]) => void
}

/** Changes that came from elsewhere carry this origin, so they aren't sent back out. */
export const REMOTE = Symbol('plinth:remote')

/**
 * Connects a document to a project's store and live channel. Local changes
 * are kept and sent on; changes from others are applied. Changes made while
 * offline are kept in a queue and sent when the connection is back.
 */
export class ProjectSync {
  readonly projectId: string
  private readonly doc: Y.Doc
  private readonly options: SyncOptions
  private leave: (() => void) | null = null
  private pending: Uint8Array[] = []
  private appended = 0
  private flushing: Promise<void> | null = null
  private status: SyncStatus = 'connecting'

  constructor(doc: Y.Doc, projectId: string, options: SyncOptions) {
    this.doc = doc
    this.projectId = projectId
    this.options = options
  }

  /** Loads what's kept, starts listening, and sends what this copy has that the store hasn't. */
  async start(): Promise<void> {
    this.setStatus('connecting')
    try {
      const kept = await this.options.store.load(this.projectId)
      this.appended = kept.length
      // What this copy had before syncing (a local cache, an upload): sent once loaded.
      const before = Y.encodeStateAsUpdate(this.doc)
      const remote = kept.length > 0 ? Y.mergeUpdates(kept) : null
      if (remote) Y.applyUpdate(this.doc, remote, REMOTE)
      const missing = remote ? Y.diffUpdate(before, Y.encodeStateVectorFromUpdate(remote)) : before
      if (hasContent(missing)) this.pending.push(missing)
      this.doc.on('update', this.handleUpdate)
      this.leave = await this.options.channel.join(this.projectId, this.options.me, {
        change: (update) => Y.applyUpdate(this.doc, update, REMOTE),
        peers: (peers) => this.options.onPeers?.(peers),
      })
      await this.flush()
      this.setStatus('synced')
    } catch (error) {
      this.setStatus('error', error)
      throw error
    }
  }

  stop(): void {
    this.doc.off('update', this.handleUpdate)
    this.leave?.()
    this.leave = null
  }

  /** Sends what's waiting (after being offline, say). */
  async flush(): Promise<void> {
    while (this.flushing) await this.flushing
    if (this.pending.length === 0) return
    const batch = this.pending
    this.pending = []
    const update = Y.mergeUpdates(batch)
    this.flushing = (async () => {
      try {
        await this.options.store.append(this.projectId, update)
        this.options.channel.send(this.projectId, update)
        this.appended++
        if (this.status !== 'synced') this.setStatus('synced')
        await this.maybeCompact()
      } catch (error) {
        // Kept for the next try; Yjs merges duplicates harmlessly.
        this.pending.unshift(update)
        this.setStatus('offline', error)
      } finally {
        this.flushing = null
      }
    })()
    await this.flushing
  }

  private handleUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin === REMOTE) return
    this.pending.push(update)
    void this.flush()
  }

  private async maybeCompact(): Promise<void> {
    const limit = this.options.compactAfter ?? 200
    const compact = this.options.store.compact
    if (!compact || this.appended < limit) return
    const state = Y.encodeStateAsUpdate(this.doc)
    await compact.call(this.options.store, this.projectId, state, this.appended)
    this.appended = 1
  }

  private setStatus(status: SyncStatus, error?: unknown): void {
    this.status = status
    this.options.onStatus?.(status, error)
  }
}

/** Whether an update changes anything (an empty Yjs update is two zero bytes). */
function hasContent(update: Uint8Array): boolean {
  return update.length > 2
}

// Encoding for text-only transports and columns.

export function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

export function fromBase64(text: string): Uint8Array {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}
