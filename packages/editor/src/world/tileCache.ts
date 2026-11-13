/**
 * What the tile workers have built, kept on the device (IndexedDB): the
 * streets and buildings of a place seen before come back in the time it
 * takes to read them, not to work them out again. Kept under a key that
 * names the map data's date and this code's version, so neither stale
 * data nor an old way of building is ever shown; the least recently used
 * go when it grows past its budget. Everything here fails quietly: with
 * no storage (a private window, a full disk) the world is simply built
 * as it was.
 */

/** Bump when what the workers build changes, so nothing built the old way is shown. */
export const BUILD_VERSION = 3

const NAME = 'plinth-world-tiles'
/** The most kept (bytes). */
const BUDGET = 400e6

interface Used {
  key: string
  at: number
  bytes: number
}

let opening: Promise<IDBDatabase | null> | null = null
/** How much is kept (bytes), once counted. */
let total: number | null = null

function open(): Promise<IDBDatabase | null> {
  opening ??= new Promise<IDBDatabase | null>((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null)
      const request = indexedDB.open(NAME, 1)
      request.onupgradeneeded = () => {
        const db = request.result
        db.createObjectStore('built')
        db.createObjectStore('used', { keyPath: 'key' }).createIndex('at', 'at')
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => resolve(null)
      request.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  return opening
}

const done = <T>(request: IDBRequest<T>): Promise<T | undefined> =>
  new Promise((resolve) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => resolve(undefined)
  })

/** What was kept under a key, or undefined. */
export async function kept<T>(key: string): Promise<T | undefined> {
  const db = await open()
  if (!db) return undefined
  try {
    const transaction = db.transaction(['built', 'used'], 'readwrite')
    const value = await done(transaction.objectStore('built').get(key) as IDBRequest<T | undefined>)
    if (value === undefined) return undefined
    // Used now: among the last to go.
    const used = transaction.objectStore('used')
    const entry = await done(used.get(key) as IDBRequest<Used | undefined>)
    if (entry) used.put({ ...entry, at: Date.now() } satisfies Used)
    return value
  } catch {
    return undefined
  }
}

/** The bytes a value's buffers hold. */
function sizeOf(value: unknown): number {
  if (!value || typeof value !== 'object') return 0
  if (ArrayBuffer.isView(value)) return value.byteLength
  let bytes = 0
  for (const part of Object.values(value)) bytes += sizeOf(part)
  return bytes
}

/**
 * Keeps a value under a key. The value is copied as this is called (so its buffers may be handed on at once);
 * the writing goes on behind.
 */
export function keep(key: string, value: unknown): void {
  const bytes = sizeOf(value)
  if (bytes === 0 || bytes > BUDGET / 8) return
  let copy: unknown
  try {
    copy = structuredClone(value)
  } catch {
    return
  }
  void open().then(async (db) => {
    if (!db) return
    try {
      const transaction = db.transaction(['built', 'used'], 'readwrite')
      transaction.objectStore('built').put(copy, key)
      transaction.objectStore('used').put({ key, at: Date.now(), bytes } satisfies Used)
      if (total === null) {
        const all = (await done(db.transaction('used').objectStore('used').getAll() as IDBRequest<Used[]>)) ?? []
        total = all.reduce((sum, entry) => sum + entry.bytes, 0)
      } else total += bytes
      if (total > BUDGET) await trim(db)
    } catch {
      // No room, or no storage: nothing is kept.
    }
  })
}

/** Lets go of the least recently used until what's kept is well within the budget. */
async function trim(db: IDBDatabase): Promise<void> {
  const transaction = db.transaction(['built', 'used'], 'readwrite')
  const used = transaction.objectStore('used')
  const oldest = (await done(used.index('at').getAll() as IDBRequest<Used[]>)) ?? []
  let left = oldest.reduce((sum, entry) => sum + entry.bytes, 0)
  for (const entry of oldest) {
    if (left <= BUDGET * 0.8) break
    transaction.objectStore('built').delete(entry.key)
    used.delete(entry.key)
    left -= entry.bytes
  }
  total = left
}
