import { cross, dot, isOnSegmentInterior, normalize, properCrossing, sub, type Vec2 } from '../math.ts'
import type { Id, Snapshot, Wall } from '../model.ts'
import type { Tx } from '../tx.ts'
import { moveOpeningsToWall } from './openings.ts'
import { splitWall } from './walls.ts'

/**
 * Where walls meet without being joined, or are joined and could be
 * separated again. Walls stay whole by default; the user connects them
 * here, which splits them at the meeting point so they share a node.
 */
export type IntersectionKind =
  /** Two walls cross, sharing no node. */
  | 'crossing'
  /** A wall ends partway along another wall. */
  | 'touch'
  /** Walls share a node and at least two of them run straight through it. */
  | 'junction'

export interface Intersection {
  /** Stable while the walls involved don't change. */
  id: string
  kind: IntersectionKind
  point: Vec2
  wallIds: Id[]
  /** The node of a touch (the touching wall's end) or of a junction. */
  nodeId?: Id
}

const STRAIGHT = 1e-6

/** Every crossing, touch and straight-through junction on a level. */
export function findIntersections(
  snapshot: Snapshot,
  levelId: Id,
  walls: readonly Wall[] = Object.values(snapshot.walls).filter((w) => w.levelId === levelId),
): Intersection[] {
  const ends = (w: Wall) => [snapshot.nodes[w.a], snapshot.nodes[w.b]] as const
  const result: Intersection[] = []
  const touches = new Map<string, Intersection>()

  for (let i = 0; i < walls.length; i++) {
    const w1 = walls[i]!
    const [a, b] = ends(w1)
    if (!a || !b) continue

    // Ends of other walls that land partway along this one. Several walls
    // can end at the same point (a corner sitting on a wall): one touch.
    for (const other of walls) {
      if (other.id === w1.id) continue
      for (const nodeId of [other.a, other.b]) {
        const node = snapshot.nodes[nodeId]
        if (!node || nodeId === w1.a || nodeId === w1.b) continue
        if (!isOnSegmentInterior(node, a, b)) continue
        const id = `touch:${nodeId}:${w1.id}`
        const existing = touches.get(id)
        if (existing) {
          if (!existing.wallIds.includes(other.id)) existing.wallIds.push(other.id)
        } else {
          const touch: Intersection = { id, kind: 'touch', point: { x: node.x, y: node.y }, wallIds: [w1.id, other.id], nodeId }
          touches.set(id, touch)
          result.push(touch)
        }
      }
    }

    for (let j = i + 1; j < walls.length; j++) {
      const w2 = walls[j]!
      const [c, d] = ends(w2)
      if (!c || !d) continue
      const shared = w1.a === w2.a || w1.a === w2.b || w1.b === w2.a || w1.b === w2.b
      if (shared) continue
      const hit = properCrossing(a, b, c, d)
      if (hit) result.push({ id: `cross:${[w1.id, w2.id].sort().join(':')}`, kind: 'crossing', point: hit, wallIds: [w1.id, w2.id] })
    }
  }

  // Joined nodes that could be separated: some pair of walls runs straight through.
  const wallsAtNode = new Map<Id, Wall[]>()
  for (const wall of walls) {
    for (const nodeId of [wall.a, wall.b]) wallsAtNode.set(nodeId, [...(wallsAtNode.get(nodeId) ?? []), wall])
  }
  for (const [nodeId, atNode] of wallsAtNode) {
    const node = snapshot.nodes[nodeId]
    if (!node || atNode.length < 3) continue
    const through = straightPairs(atNode, nodeId, (id) => snapshot.nodes[id])
    if (through.length > 0) {
      result.push({
        id: `junction:${nodeId}`,
        kind: 'junction',
        point: { x: node.x, y: node.y },
        wallIds: atNode.map((w) => w.id),
        nodeId,
      })
    }
  }
  return result
}

/** Joins the walls at an intersection: they're split there and share a node. */
export function connectIntersection(tx: Tx, intersection: Intersection): void {
  if (intersection.kind === 'touch' && intersection.nodeId) {
    const [throughId] = intersection.wallIds
    if (throughId && tx.wall(throughId)) splitWall(tx, throughId, intersection.point, intersection.nodeId)
  } else if (intersection.kind === 'crossing') {
    const [first, second] = intersection.wallIds
    if (!first || !second || !tx.wall(first) || !tx.wall(second)) return
    const { nodeId } = splitWall(tx, first, intersection.point)
    splitWall(tx, second, intersection.point, nodeId)
  }
}

/**
 * Separates the walls at a node again: each pair that runs straight
 * through it becomes one wall. Walls that end there keep their end there,
 * now touching rather than joined.
 */
export function disconnectNode(tx: Tx, nodeId: Id): void {
  const node = tx.node(nodeId)
  if (!node) return
  for (const [w1, w2] of straightPairs(tx.wallsAtNode(nodeId), nodeId, (id) => tx.node(id))) {
    const far2 = tx.requireNode(w2.a === nodeId ? w2.b : w2.a)
    const before1 = { a: tx.requireNode(w1.a), b: tx.requireNode(w1.b) }
    const before2 = { a: tx.requireNode(w2.a), b: tx.requireNode(w2.b) }
    const openings1 = tx.openingsOnWall(w1.id)
    const openings2 = tx.openingsOnWall(w2.id)
    // w1 now runs from its far end to w2's far end, keeping its settings.
    tx.putWall({ ...w1, a: w1.a === nodeId ? far2.id : w1.a, b: w1.b === nodeId ? far2.id : w1.b })
    moveOpeningsToWall(tx, openings1, before1, w1.id)
    moveOpeningsToWall(tx, openings2, before2, w1.id)
    tx.deleteWall(w2.id)
  }
  if (tx.wallsAtNode(nodeId).length === 0) tx.deleteNode(nodeId)
}

/** Pairs of walls at a node that continue each other in a straight line. */
function straightPairs(
  walls: readonly Wall[],
  nodeId: Id,
  nodeOf: (id: Id) => Vec2 | undefined,
): [Wall, Wall][] {
  const node = nodeOf(nodeId)
  if (!node) return []
  const dirs = walls.map((w) => {
    const far = nodeOf(w.a === nodeId ? w.b : w.a)
    return far ? normalize(sub(far, node)) : null
  })
  const used = new Set<number>()
  const pairs: [Wall, Wall][] = []
  for (let i = 0; i < walls.length; i++) {
    if (used.has(i)) continue
    for (let j = i + 1; j < walls.length; j++) {
      if (used.has(j)) continue
      const di = dirs[i]
      const dj = dirs[j]
      if (di && dj && Math.abs(cross(di, dj)) < STRAIGHT && dot(di, dj) < 0) {
        pairs.push([walls[i]!, walls[j]!])
        used.add(i)
        used.add(j)
        break
      }
    }
  }
  return pairs
}
