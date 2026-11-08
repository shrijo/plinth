import type { ChangeStore, LiveChannel, Peer } from './sync.ts'

/** A change store in memory, for tests and trying things out. */
export class MemoryStore implements ChangeStore {
  readonly projects = new Map<string, Uint8Array[]>()
  online = true

  async load(projectId: string): Promise<Uint8Array[]> {
    this.check()
    return [...(this.projects.get(projectId) ?? [])]
  }

  async append(projectId: string, update: Uint8Array): Promise<void> {
    this.check()
    const list = this.projects.get(projectId) ?? []
    list.push(update)
    this.projects.set(projectId, list)
  }

  async compact(projectId: string, state: Uint8Array, replacing: number): Promise<void> {
    this.check()
    const list = this.projects.get(projectId) ?? []
    // Changes appended after the ones being replaced are kept.
    this.projects.set(projectId, [state, ...list.slice(replacing)])
  }

  private check(): void {
    if (!this.online) throw new Error('offline')
  }
}

/** A live channel in memory: everyone joined to a project hears everyone else. */
export class MemoryChannel implements LiveChannel {
  private rooms = new Map<string, Map<string, { me: Peer; change: (u: Uint8Array) => void; peers: (p: Peer[]) => void }>>()
  private counter = 0

  async join(projectId: string, me: Peer, handlers: { change: (update: Uint8Array) => void; peers: (peers: Peer[]) => void }) {
    const room = this.rooms.get(projectId) ?? new Map()
    this.rooms.set(projectId, room)
    const key = `${me.id}:${this.counter++}`
    room.set(key, { me, ...handlers })
    this.announce(projectId)
    return () => {
      room.delete(key)
      this.announce(projectId)
    }
  }

  send(projectId: string, update: Uint8Array): void {
    for (const [, member] of this.rooms.get(projectId) ?? []) member.change(update)
  }

  private announce(projectId: string): void {
    const room = this.rooms.get(projectId)
    if (!room) return
    const peers = [...room.values()].map((m) => m.me)
    for (const member of room.values()) member.peers(peers.filter((p) => p.id !== member.me.id))
  }
}
