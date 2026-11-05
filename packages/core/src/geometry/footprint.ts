import {
  add,
  angleOf,
  cross,
  dist,
  dot,
  intersectLines,
  normalize,
  perpLeft,
  projectOnSegment,
  scale,
  sub,
  type Vec2,
} from '../math.ts'
import type { Id, Wall, WallNode } from '../model.ts'

/**
 * The plan outline of one wall, with its ends shaped to meet the walls
 * around it. Walls meeting at a node share their corner points, and each
 * wall's outline runs into the node's centre, so together they fill the
 * junction with no gaps or overlaps.
 */
export interface WallFootprint {
  wallId: Id
  /** Counter-clockwise outline in plan coordinates. */
  polygon: Vec2[]
  /** The wall's centre line. */
  a: Vec2
  b: Vec2
  thickness: number
  /** Index of the outline edge along the wall's right face (seen from a to b). */
  rightEdge: number
  /** Index of the outline edge along the wall's left face. */
  leftEdge: number
  /**
   * The stretch of the wall, measured from a along the centre line, where
   * both faces run straight: openings must stay within it.
   */
  clearStart: number
  clearEnd: number
}

/** How far a mitred corner may reach past its node, in wall thicknesses. */
const MITER_LIMIT = 4

interface End {
  wall: Wall
  /** Unit direction from this node along the wall. */
  dir: Vec2
  /** Unit normal to the left of `dir`. */
  left: Vec2
  halfThickness: number
  length: number
  angle: number
}

interface EndCorners {
  left: Vec2
  right: Vec2
  /** Whether the outline should pass through the node's centre here. */
  throughCentre: boolean
}

/**
 * Computes the outlines of all given walls (one level's worth).
 * `thicknessOf` resolves each wall's thickness.
 */
export function computeFootprints(
  nodes: Readonly<Record<Id, WallNode>>,
  walls: readonly Wall[],
  thicknessOf: (wall: Wall) => number,
): Map<Id, WallFootprint> {
  // Group wall ends by node.
  const endsAtNode = new Map<Id, End[]>()
  for (const wall of walls) {
    const a = nodes[wall.a]
    const b = nodes[wall.b]
    if (!a || !b) continue
    const length = dist(a, b)
    if (length === 0) continue
    const halfThickness = thicknessOf(wall) / 2
    for (const [from, to] of [
      [a, b],
      [b, a],
    ] as const) {
      const dir = normalize(sub(to, from))
      const list = endsAtNode.get(from.id) ?? []
      list.push({ wall, dir, left: perpLeft(dir), halfThickness, length, angle: angleOf(dir) })
      endsAtNode.set(from.id, list)
    }
  }

  // Corner points per (node, wall).
  const corners = new Map<string, EndCorners>()
  for (const [nodeId, ends] of endsAtNode) {
    const node = nodes[nodeId]!
    ends.sort((p, q) => p.angle - q.angle)

    if (ends.length === 1) {
      const end = ends[0]!
      corners.set(key(nodeId, end.wall.id), {
        left: add(node, scale(end.left, end.halfThickness)),
        right: add(node, scale(end.left, -end.halfThickness)),
        throughCentre: false,
      })
      continue
    }

    // For each pair of neighbours (counter-clockwise), find where the first
    // one's left face meets the next one's right face.
    const lefts: Vec2[] = []
    const rights: Vec2[] = new Array<Vec2>(ends.length)
    for (let i = 0; i < ends.length; i++) {
      const cur = ends[i]!
      const nextIndex = (i + 1) % ends.length
      const next = ends[nextIndex]!
      const meet = faceIntersection(node, cur, next)
      lefts[i] = meet ?? add(node, scale(cur.left, cur.halfThickness))
      rights[nextIndex] = meet ?? add(node, scale(next.left, -next.halfThickness))
    }
    for (let i = 0; i < ends.length; i++) {
      corners.set(key(nodeId, ends[i]!.wall.id), {
        left: lefts[i]!,
        right: rights[i]!,
        throughCentre: true,
      })
    }
  }

  const result = new Map<Id, WallFootprint>()
  for (const wall of walls) {
    const a = nodes[wall.a]
    const b = nodes[wall.b]
    const atA = corners.get(key(wall.a, wall.id))
    const atB = corners.get(key(wall.b, wall.id))
    if (!a || !b || !atA || !atB) continue
    const thickness = thicknessOf(wall)
    result.set(wall.id, { wallId: wall.id, a, b, thickness, ...outline(a, b, atA, atB, thickness / 2) })
  }

  // A wall that ends on (or just inside) another wall without being joined to
  // it is trimmed at that wall's centre line, so its end or mitred corner
  // can't poke out of the far side. The other wall covers the rest.
  for (const wall of walls) {
    let footprint = result.get(wall.id)
    if (!footprint) continue
    for (const nodeId of [wall.a, wall.b]) {
      const end = nodes[nodeId]
      const far = nodes[nodeId === wall.a ? wall.b : wall.a]
      if (!end || !far) continue
      for (const other of walls) {
        if (other.id === wall.id || other.a === nodeId || other.b === nodeId) continue
        const c = nodes[other.a]
        const d = nodes[other.b]
        if (!c || !d) continue
        const { t, distance } = projectOnSegment(end, c, d)
        if (t <= 0 || t >= 1 || distance > thicknessOf(other) / 2 + 1e-6) continue
        const line = normalize(sub(d, c))
        const side = cross(line, sub(far, end))
        if (Math.abs(side) < 1e-9) continue
        footprint = trimToSide(footprint, c, line, Math.sign(side))
      }
    }
    result.set(wall.id, footprint)
  }
  return result
}

/**
 * Cuts a footprint along a line, keeping the part on one side (`keep` is the
 * sign of the cross product of the line's direction with a kept point). The
 * wall's face edges are tracked through the cut, and the clear stretch for
 * openings is recomputed from them.
 */
function trimToSide(footprint: WallFootprint, origin: Vec2, direction: Vec2, keep: number): WallFootprint {
  const inside = (p: Vec2) => keep * cross(direction, sub(p, origin)) >= -1e-9
  const crossing = (p: Vec2, q: Vec2) => intersectLines(p, sub(q, p), origin, direction)?.point ?? p
  const { polygon } = footprint
  const tagOf = (i: number) => (i === footprint.rightEdge ? 'right' : i === footprint.leftEdge ? 'left' : 'other')
  if (polygon.every(inside)) return footprint

  // Sutherland–Hodgman against one half-plane. Each output point carries the
  // tag of the edge that leaves it.
  const points: Vec2[] = []
  const tags: string[] = []
  for (let i = 0; i < polygon.length; i++) {
    const prev = (i - 1 + polygon.length) % polygon.length
    const s = polygon[prev]!
    const e = polygon[i]!
    if (inside(e)) {
      if (!inside(s)) {
        points.push(crossing(s, e))
        tags.push(tagOf(prev))
      }
      points.push(e)
      tags.push(tagOf(i))
    } else if (inside(s)) {
      points.push(crossing(s, e))
      tags.push('cut')
    }
  }
  if (points.length < 3) return footprint

  const rightEdge = tags.indexOf('right')
  const leftEdge = tags.indexOf('left')
  const axis = normalize(sub(footprint.b, footprint.a))
  const along = (p: Vec2) => dot(sub(p, footprint.a), axis)
  const at = (i: number) => points[i % points.length]!
  const clear =
    rightEdge >= 0 && leftEdge >= 0
      ? {
          clearStart: Math.max(along(at(rightEdge)), along(at(leftEdge + 1))),
          clearEnd: Math.min(along(at(rightEdge + 1)), along(at(leftEdge))),
        }
      : { clearStart: 0, clearEnd: 0 }
  return { ...footprint, polygon: points, rightEdge, leftEdge, ...clear }
}

function key(nodeId: Id, wallId: Id): string {
  return `${nodeId}:${wallId}`
}

/**
 * Where `cur`'s left face meets `next`'s right face. Null when they are
 * parallel, or when the meeting point is too far away to be a sensible
 * mitre (very sharp angles, or walls shorter than the mitre).
 */
function faceIntersection(node: Vec2, cur: End, next: End): Vec2 | null {
  const p = add(node, scale(cur.left, cur.halfThickness))
  const q = add(node, scale(next.left, -next.halfThickness))
  const hit = intersectLines(p, cur.dir, q, next.dir)
  if (!hit) return null
  const reach = MITER_LIMIT * Math.max(cur.halfThickness, next.halfThickness, 1e-3) * 2
  if (Math.abs(hit.t) > reach || Math.abs(hit.u) > reach) return null
  if (hit.t > cur.length || hit.u > next.length) return null
  return hit.point
}

/**
 * Counter-clockwise outline: along the right face from a to b, round the
 * b end, back along the left face, round the a end. "Left" and "right" at
 * each end are as seen looking along the wall from that end.
 */
function outline(
  a: Vec2,
  b: Vec2,
  atA: EndCorners,
  atB: EndCorners,
  half: number,
): Pick<WallFootprint, 'polygon' | 'rightEdge' | 'leftEdge' | 'clearStart' | 'clearEnd'> {
  const dir = normalize(sub(b, a))
  const along = (p: Vec2) => dot(sub(p, a), dir)
  // The right face (seen from a) runs from atA.right to atB.left, the left face
  // from atB.right to atA.left. If the mitres overlap the wall is too short
  // for them, and a plain rectangle is the safest outline.
  const valid = along(atA.right) < along(atB.left) && along(atA.left) < along(atB.right)
  if (!valid) {
    const n = scale(perpLeft(dir), half)
    return {
      polygon: [sub(a, n), sub(b, n), add(b, n), add(a, n)],
      rightEdge: 0,
      leftEdge: 2,
      clearStart: 0,
      clearEnd: dist(a, b),
    }
  }
  const polygon: Vec2[] = [atA.right, atB.left]
  if (atB.throughCentre) polygon.push(b)
  const leftEdge = polygon.length
  polygon.push(atB.right, atA.left)
  if (atA.throughCentre) polygon.push(a)
  return {
    polygon,
    rightEdge: 0,
    leftEdge,
    clearStart: Math.max(along(atA.right), along(atA.left)),
    clearEnd: Math.min(along(atB.left), along(atB.right)),
  }
}
