const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'
const LENGTH = 12

/** Random bytes fetched in bulk: a large example makes hundreds of thousands of IDs. */
const pool = new Uint8Array(LENGTH * 1024)
let used = pool.length

/** A random 12-character ID (about 62 bits), short enough to keep documents small. */
export function createId(): string {
  if (used + LENGTH > pool.length) {
    crypto.getRandomValues(pool)
    used = 0
  }
  let id = ''
  for (let i = 0; i < LENGTH; i++) id += ALPHABET[pool[used + i]! % ALPHABET.length]
  used += LENGTH
  return id
}
