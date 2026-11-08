/**
 * Hands back the previous value for an ID while its key (a string that
 * captures everything that matters about it) is unchanged, so memoised
 * children keep their geometry. Values for IDs not seen in a pass are dropped.
 */
export class StableValues<T> {
  private previous = new Map<string, { key: string; value: T }>()
  private next = new Map<string, { key: string; value: T }>()

  get(id: string, key: string, make: () => T): T {
    const prev = this.previous.get(id)
    const entry = prev && prev.key === key ? prev : { key, value: make() }
    this.next.set(id, entry)
    return entry.value
  }

  /** Call once after a full pass of `get`. */
  commit(): void {
    this.previous = this.next
    this.next = new Map()
  }
}

export const pointsKey = (points: readonly { x: number; y: number }[]): string =>
  points.map((p) => `${p.x.toFixed(5)},${p.y.toFixed(5)}`).join(';')
