import type { Vec2 } from './math.ts'
import { levelsByBuilding, nodesOnLevel, wallsOnLevel, type Id, type Snapshot } from './model.ts'

/**
 * Points and walls that line up across floors: the same plan position, or
 * the same two end positions, on different levels of the same building. In the whole-building
 * view they are picked, moved and edited as one. Copies of a level aren't
 * included; they follow their master anyway.
 */
export interface Stacks {
  /** Every point, mapped to the points at the same position on all floors (itself included), lowest first. */
  nodes: Map<Id, Id[]>
  /** Every wall, mapped to the walls with the same ends on all floors (itself included), lowest first. */
  walls: Map<Id, Id[]>
}

/** Plan positions that match to the millimetre share a key. */
export const positionKey = (p: Vec2): string => `${Math.round(p.x * 1000)},${Math.round(p.y * 1000)}`

const cache = new WeakMap<object, Map<string, { snapshot: Snapshot; stacks: Stacks }>>()

/**
 * The stacks of one building (or of every building, when none is given:
 * costly on a large site, so the editor always names the open building).
 */
export function findStacks(snapshot: Snapshot, buildingId?: Id): Stacks {
  const scope = buildingId ?? '*'
  const perScope = cache.get(snapshot.walls) ?? new Map<string, { snapshot: Snapshot; stacks: Stacks }>()
  cache.set(snapshot.walls, perScope)
  const hit = perScope.get(scope)
  if (hit && hit.snapshot.nodes === snapshot.nodes && hit.snapshot.levels === snapshot.levels) return hit.stacks

  const elevation = (levelId: Id) => snapshot.levels[levelId]?.elevation ?? 0
  const real = (levelId: Id) => {
    const level = snapshot.levels[levelId]
    return !!level && !level.masterId
  }
  const group = <T extends { id: Id; levelId: Id }>(items: T[], keyOf: (item: T) => string | null) => {
    const groups = new Map<string, T[]>()
    for (const item of items) {
      const key = keyOf(item)
      if (key === null) continue
      groups.set(key, [...(groups.get(key) ?? []), item])
    }
    const result = new Map<Id, Id[]>()
    for (const members of groups.values()) {
      const ids = members.sort((p, q) => elevation(p.levelId) - elevation(q.levelId)).map((m) => m.id)
      for (const id of ids) result.set(id, ids)
    }
    return result
  }

  // Only within one building: neighbours that happen to line up aren't one wall.
  const building = (levelId: Id) => snapshot.levels[levelId]?.buildingId ?? ''
  const levels = buildingId === undefined ? null : (levelsByBuilding(snapshot).get(buildingId) ?? [])
  const nodes = group(
    (levels ? levels.flatMap((l) => nodesOnLevel(snapshot, l.id)) : Object.values(snapshot.nodes)).filter((n) => real(n.levelId)),
    (n) => `${building(n.levelId)}|${positionKey(n)}`,
  )
  const walls = group(
    (levels ? levels.flatMap((l) => wallsOnLevel(snapshot, l.id)) : Object.values(snapshot.walls)).filter((w) => real(w.levelId)),
    (w) => {
      const a = snapshot.nodes[w.a]
      const b = snapshot.nodes[w.b]
      return a && b ? `${building(w.levelId)}|${[positionKey(a), positionKey(b)].sort().join('|')}` : null
    },
  )
  const stacks = { nodes, walls }
  perScope.set(scope, { snapshot, stacks })
  return stacks
}
