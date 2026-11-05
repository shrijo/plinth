import { createId } from '../ids.ts'
import {
  cross,
  dist,
  DIST_EPS,
  dot,
  normalize,
  projectOnSegment,
  sub,
  type Vec2,
} from '../math.ts'
import { DEFAULT_LEVEL_HEIGHT, MIN_WALL_LENGTH, type Id, type Wall, type WallNode } from '../model.ts'
import type { Tx } from '../tx.ts'
import { moveOpeningsToWall, splitRow } from './openings.ts'

/**
 * Wall graph operations. Walls join at shared nodes. Walls that cross, or
 * end partway along another wall, stay separate until the user connects
 * them (see ./intersections.ts).
 */

export interface WallProps {
  thickness?: number | null
  height?: number | null
  heightEnd?: number | null
}

/** The node at `p` on a level, if one is there (within DIST_EPS). */
export function findNodeAt(tx: Tx, levelId: Id, p: Vec2): WallNode | undefined {
  let best: WallNode | undefined
  let bestDistance = DIST_EPS
  for (const node of tx.nodes(levelId)) {
    const d = dist(node, p)
    if (d < bestDistance) {
      best = node
      bestDistance = d
    }
  }
  return best
}

/** The node at `p`, created if there is none. */
export function nodeAt(tx: Tx, levelId: Id, p: Vec2): WallNode {
  return findNodeAt(tx, levelId, p) ?? tx.putNode({ id: createId(), levelId, x: p.x, y: p.y })
}

/**
 * Adds a wall from p to q. Its ends join existing nodes they land on.
 * Returns the new wall's ID (none if it was too short, or the existing
 * wall's if one already ran between the same points).
 */
export function insertWall(tx: Tx, levelId: Id, p: Vec2, q: Vec2, props: WallProps = {}): Id[] {
  if (dist(p, q) < MIN_WALL_LENGTH) return []
  const a = nodeAt(tx, levelId, p)
  const b = nodeAt(tx, levelId, q)
  if (a.id === b.id) return []
  const wall = tx.putWall({
    id: createId(),
    levelId,
    a: a.id,
    b: b.id,
    thickness: props.thickness ?? null,
    height: props.height ?? null,
    heightEnd: props.heightEnd ?? null,
  })
  return tidyWalls(tx, levelId, [wall.id])
}

/** Adds walls along a chain of points, closing it back to the start if asked. */
export function insertPolyline(
  tx: Tx,
  levelId: Id,
  points: readonly Vec2[],
  closed: boolean,
  props: WallProps = {},
): Id[] {
  const ids: Id[] = []
  const count = closed ? points.length : points.length - 1
  for (let i = 0; i < count; i++) {
    const p = points[i]!
    const q = points[(i + 1) % points.length]!
    ids.push(...insertWall(tx, levelId, p, q, props))
  }
  return ids.filter((id) => tx.wall(id))
}

/** Adds four walls along the axis-aligned rectangle with corners p and q. */
export function insertRectangle(tx: Tx, levelId: Id, p: Vec2, q: Vec2, props: WallProps = {}): Id[] {
  if (Math.abs(p.x - q.x) < MIN_WALL_LENGTH || Math.abs(p.y - q.y) < MIN_WALL_LENGTH) return []
  const minX = Math.min(p.x, q.x)
  const maxX = Math.max(p.x, q.x)
  const minY = Math.min(p.y, q.y)
  const maxY = Math.max(p.y, q.y)
  const corners = [
    { x: minX, y: minY },
    { x: maxX, y: minY },
    { x: maxX, y: maxY },
    { x: minX, y: maxY },
  ]
  return insertPolyline(tx, levelId, corners, true, props)
}

/**
 * Splits a wall at `point` (projected onto the wall), using an existing node
 * there if given. The original ID keeps the part from `a`; heights of a
 * sloped wall are interpolated at the split.
 */
export function splitWall(
  tx: Tx,
  wallId: Id,
  point: Vec2,
  existingNodeId?: Id,
): { nodeId: Id; first: Id; second: Id } {
  const wall = tx.requireWall(wallId)
  const a = tx.requireNode(wall.a)
  const b = tx.requireNode(wall.b)
  const node = existingNodeId
    ? tx.requireNode(existingNodeId)
    : tx.putNode({ id: createId(), levelId: wall.levelId, x: point.x, y: point.y })

  const { t } = projectOnSegment(node, a, b)
  let firstEnd = wall.heightEnd
  let secondStart = wall.height
  if (wall.heightEnd !== null) {
    const level = tx.level(wall.levelId)
    const start = wall.height ?? level?.height ?? DEFAULT_LEVEL_HEIGHT
    const middle = start + (wall.heightEnd - start) * t
    firstEnd = middle
    secondStart = middle
  }

  tx.putWall({ ...wall, b: node.id, heightEnd: firstEnd })
  const second = tx.putWall({
    ...wall,
    id: createId(),
    a: node.id,
    height: secondStart,
    heightEnd: wall.heightEnd,
  })
  // Openings past the split move to the second part, measured from its start.
  const splitAt = t * dist(a, b)
  for (const opening of tx.openingsOnWall(wall.id)) {
    // A row across the split splits with it.
    const { before, after } = splitRow(opening, splitAt)
    if (before) tx.putOpening(before)
    if (after) tx.putOpening({ ...after, wallId: second.id, offset: after.offset - splitAt })
  }
  return { nodeId: node.id, first: wall.id, second: second.id }
}

/**
 * Moves every wall from `removeId` onto `keepId` and deletes `removeId`.
 * Walls that collapse to a point are deleted. Duplicates are left for
 * `tidyWalls` to remove.
 */
export function mergeNodes(tx: Tx, keepId: Id, removeId: Id): void {
  if (keepId === removeId) return
  for (const wall of tx.wallsAtNode(removeId)) {
    const next: Wall = {
      ...wall,
      a: wall.a === removeId ? keepId : wall.a,
      b: wall.b === removeId ? keepId : wall.b,
    }
    if (next.a === next.b) deleteWallAndOpenings(tx, wall.id)
    else tx.putWall(next)
  }
  tx.deleteNode(removeId)
}

/**
 * Tidies the graph around the given walls: ends that land on an existing
 * node join it, walls between the same two nodes are merged, and walls too
 * short to keep collapse. Walls that cross or touch along their length stay
 * separate; `connectIntersection` joins them on request. Returns the walls
 * that the seeds became.
 */
export function tidyWalls(tx: Tx, levelId: Id, seedWallIds: Iterable<Id>): Id[] {
  const own = new Set(seedWallIds)
  const queue = [...own]
  let guard = 0

  while (queue.length > 0) {
    if (++guard > 100_000) throw new Error('tidyWalls did not converge')
    const id = queue.pop()!
    const wall = tx.wall(id)
    if (!wall) continue
    const a = tx.requireNode(wall.a)
    const b = tx.requireNode(wall.b)

    // A wall too short to keep collapses into a single node.
    if (dist(a, b) < MIN_WALL_LENGTH) {
      mergeNodes(tx, wall.a, wall.b)
      own.delete(id)
      queue.push(...tx.wallsAtNode(wall.a).map((w) => w.id))
      continue
    }

    // Another wall between the same two nodes: keep that one.
    const duplicate = tx
      .wallsAtNode(wall.a)
      .find((w) => w.id !== id && (w.a === wall.b || w.b === wall.b))
    if (duplicate) {
      moveOpeningsToWall(tx, tx.openingsOnWall(id), { a, b }, duplicate.id)
      tx.deleteWall(id)
      if (own.delete(id)) own.add(duplicate.id)
      continue
    }

    // An end lands on another node: merge them.
    const nodes = tx.nodes(levelId)
    for (const end of [a, b]) {
      const other = nodes.find((n) => n.id !== end.id && dist(n, end) < DIST_EPS)
      if (other) {
        mergeNodes(tx, other.id, end.id)
        queue.push(...tx.wallsAtNode(other.id).map((w) => w.id))
        break
      }
    }
  }

  return [...own].filter((id) => tx.wall(id))
}

/** Deletes walls, then removes nodes left without walls and heals straight joints. */
export function deleteWalls(tx: Tx, wallIds: Iterable<Id>): void {
  const touched = new Set<Id>()
  for (const id of wallIds) {
    const wall = tx.wall(id)
    if (!wall) continue
    deleteWallAndOpenings(tx, id)
    touched.add(wall.a)
    touched.add(wall.b)
  }
  for (const nodeId of touched) cleanupNode(tx, nodeId)
}

/** Deletes nodes together with every wall attached to them. */
export function deleteNodes(tx: Tx, nodeIds: Iterable<Id>): void {
  const ids = [...nodeIds]
  deleteWalls(
    tx,
    ids.flatMap((id) => tx.wallsAtNode(id).map((w) => w.id)),
  )
  for (const id of ids) if (tx.node(id)) tx.deleteNode(id)
}

/**
 * Removes a point. Where two walls meet at it, they become one wall from
 * the point before to the point after, keeping the first wall's settings
 * and both walls' openings. A point at the end of a wall, or where three or
 * more walls meet, goes together with its walls.
 */
export function removeNode(tx: Tx, nodeId: Id): void {
  const node = tx.node(nodeId)
  if (!node) return
  const walls = tx.wallsAtNode(nodeId)
  if (walls.length === 2) {
    const [w1, w2] = walls as [Wall, Wall]
    const before = w1.a === nodeId ? w1.b : w1.a
    const after = w2.a === nodeId ? w2.b : w2.a
    if (before !== after) {
      const before1 = { a: tx.requireNode(w1.a), b: tx.requireNode(w1.b) }
      const before2 = { a: tx.requireNode(w2.a), b: tx.requireNode(w2.b) }
      const openings1 = tx.openingsOnWall(w1.id)
      const openings2 = tx.openingsOnWall(w2.id)
      tx.putWall({ ...w1, a: w1.a === nodeId ? after : w1.a, b: w1.b === nodeId ? after : w1.b })
      moveOpeningsToWall(tx, openings1, before1, w1.id)
      moveOpeningsToWall(tx, openings2, before2, w1.id)
      tx.deleteWall(w2.id)
      tx.deleteNode(nodeId)
      tidyWalls(tx, node.levelId, [w1.id])
      return
    }
  }
  deleteNodes(tx, [nodeId])
}

/** Removes a node with no walls, or merges a straight joint of two matching walls. */
export function cleanupNode(tx: Tx, nodeId: Id): void {
  if (!tx.node(nodeId)) return
  const walls = tx.wallsAtNode(nodeId)
  if (walls.length === 0) tx.deleteNode(nodeId)
  else if (walls.length === 2) healNode(tx, nodeId)
}

/**
 * Joins the two walls at a node back into one if they continue each other in
 * a straight line and share the same settings. Returns whether it did.
 */
export function healNode(tx: Tx, nodeId: Id): boolean {
  const walls = tx.wallsAtNode(nodeId)
  if (walls.length !== 2) return false
  const [w1, w2] = walls as [Wall, Wall]
  const sameSettings =
    w1.thickness === w2.thickness &&
    w1.height === w2.height &&
    w1.heightEnd === null &&
    w2.heightEnd === null
  if (!sameSettings) return false

  const node = tx.requireNode(nodeId)
  const o1 = tx.requireNode(w1.a === nodeId ? w1.b : w1.a)
  const o2 = tx.requireNode(w2.a === nodeId ? w2.b : w2.a)
  if (o1.id === o2.id) return false
  const d1 = normalize(sub(o1, node))
  const d2 = normalize(sub(o2, node))
  const straight = Math.abs(cross(d1, d2)) < 1e-6 && dot(d1, d2) < 0
  if (!straight) return false

  const before1 = { a: tx.requireNode(w1.a), b: tx.requireNode(w1.b) }
  const before2 = { a: tx.requireNode(w2.a), b: tx.requireNode(w2.b) }
  const openings1 = tx.openingsOnWall(w1.id)
  const openings2 = tx.openingsOnWall(w2.id)
  tx.putWall({
    ...w1,
    a: w1.a === nodeId ? o2.id : w1.a,
    b: w1.b === nodeId ? o2.id : w1.b,
  })
  moveOpeningsToWall(tx, openings1, before1, w1.id)
  moveOpeningsToWall(tx, openings2, before2, w1.id)
  tx.deleteWall(w2.id)
  tx.deleteNode(nodeId)
  return true
}

function deleteWallAndOpenings(tx: Tx, wallId: Id): void {
  for (const opening of tx.openingsOnWall(wallId)) tx.deleteOpening(opening.id)
  tx.deleteWall(wallId)
}

/** Moves nodes without re-checking the graph. Call `finishNodeMove` once the move ends. */
export function moveNodes(tx: Tx, positions: ReadonlyMap<Id, Vec2>): void {
  for (const [id, p] of positions) {
    const node = tx.node(id)
    if (node) tx.putNode({ ...node, x: p.x, y: p.y })
  }
}

/** Joins moved nodes to nodes they were dropped onto. */
export function finishNodeMove(tx: Tx, nodeIds: Iterable<Id>): void {
  const byLevel = new Map<Id, Set<Id>>()
  for (const nodeId of nodeIds) {
    const node = tx.node(nodeId)
    if (!node) continue
    const set = byLevel.get(node.levelId) ?? new Set<Id>()
    for (const wall of tx.wallsAtNode(nodeId)) set.add(wall.id)
    byLevel.set(node.levelId, set)
  }
  for (const [levelId, wallIds] of byLevel) tidyWalls(tx, levelId, wallIds)
}

/** Changes thickness or heights on walls. */
export function setWallProps(tx: Tx, wallIds: Iterable<Id>, props: WallProps): void {
  for (const id of wallIds) {
    const wall = tx.wall(id)
    if (!wall) continue
    tx.putWall({ ...wall, ...props })
  }
}
