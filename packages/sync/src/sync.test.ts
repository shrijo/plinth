import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { MemoryChannel, MemoryStore } from './memory.ts'
import { fromBase64, ProjectSync, toBase64, type Peer } from './sync.ts'

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

function client(store: MemoryStore, channel: MemoryChannel, name: string, extra: Partial<ConstructorParameters<typeof ProjectSync>[2]> = {}) {
  const doc = new Y.Doc()
  const peers: Peer[][] = []
  const sync = new ProjectSync(doc, 'p1', { store, channel, me: { id: name, name }, onPeers: (p) => peers.push(p), ...extra })
  return { doc, sync, peers, walls: () => doc.getMap<{ length: number }>('walls') }
}

describe('project sync', () => {
  it('passes changes between copies open at the same time, and keeps them for later', async () => {
    const store = new MemoryStore()
    const channel = new MemoryChannel()
    const anna = client(store, channel, 'anna')
    const ben = client(store, channel, 'ben')
    await anna.sync.start()
    await ben.sync.start()
    anna.walls().set('w1', { length: 4 })
    await settle()
    expect(ben.walls().get('w1')).toEqual({ length: 4 })
    ben.walls().set('w2', { length: 6 })
    await settle()
    expect(anna.walls().size).toBe(2)
    // Someone opening it later catches up from the store.
    const cleo = client(store, channel, 'cleo')
    await cleo.sync.start()
    expect([...cleo.walls().keys()].sort()).toEqual(['w1', 'w2'])
    expect(anna.peers.at(-1)!.map((p) => p.name).sort()).toEqual(['ben', 'cleo'])
  })

  it('merges edits made at the same time', async () => {
    const store = new MemoryStore()
    const channel = new MemoryChannel()
    const anna = client(store, channel, 'anna')
    const ben = client(store, channel, 'ben')
    await Promise.all([anna.sync.start(), ben.sync.start()])
    anna.walls().set('a', { length: 1 })
    ben.walls().set('b', { length: 2 })
    await settle()
    expect(anna.walls().toJSON()).toEqual(ben.walls().toJSON())
    expect(anna.walls().size).toBe(2)
  })

  it('uploads what a copy had before it was shared', async () => {
    const store = new MemoryStore()
    const channel = new MemoryChannel()
    const anna = client(store, channel, 'anna')
    anna.walls().set('local', { length: 3 })
    await anna.sync.start()
    const ben = client(store, channel, 'ben')
    await ben.sync.start()
    expect(ben.walls().get('local')).toEqual({ length: 3 })
  })

  it('keeps edits made offline and sends them when back online', async () => {
    const store = new MemoryStore()
    const channel = new MemoryChannel()
    const statuses: string[] = []
    const anna = client(store, channel, 'anna', { onStatus: (s) => statuses.push(s) })
    await anna.sync.start()
    store.online = false
    anna.walls().set('offline', { length: 5 })
    await settle()
    expect(statuses).toContain('offline')
    store.online = true
    await anna.sync.flush()
    expect(statuses.at(-1)).toBe('synced')
    const ben = client(store, channel, 'ben')
    await ben.sync.start()
    expect(ben.walls().get('offline')).toEqual({ length: 5 })
  })

  it('compacts the store after many changes, losing nothing', async () => {
    const store = new MemoryStore()
    const channel = new MemoryChannel()
    const anna = client(store, channel, 'anna', { compactAfter: 10 })
    await anna.sync.start()
    for (let i = 0; i < 25; i++) {
      anna.walls().set(`w${i}`, { length: i })
      await settle()
    }
    expect(store.projects.get('p1')!.length).toBeLessThan(10)
    const ben = client(store, channel, 'ben')
    await ben.sync.start()
    expect(ben.walls().size).toBe(25)
  })

  it('encodes changes as text and back', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255, 128])
    expect(fromBase64(toBase64(bytes))).toEqual(bytes)
  })
})
