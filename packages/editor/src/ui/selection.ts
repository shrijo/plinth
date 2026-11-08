import type { Id, Snapshot, Wall } from '@plinth/core'
import { dist } from '@plinth/core'

/** The number of floors if the ids are exactly one stack (the same wall or point on several floors), else 0. */
export function stackFloors(ids: readonly Id[], stacks: Map<Id, Id[]>): number {
  const stack = stacks.get(ids[0] ?? '')
  return stack && stack.length > 1 && stack.length === ids.length && ids.every((id) => stack.includes(id))
    ? stack.length
    : 0
}

export function wallLength(snapshot: Snapshot, wall: Wall): number {
  const a = snapshot.nodes[wall.a]
  const b = snapshot.nodes[wall.b]
  return a && b ? dist(a, b) : 0
}
