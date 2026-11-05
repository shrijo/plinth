/**
 * 2D vector math for the plan (top-down) view.
 *
 * Plan coordinates are metres, x to the right and y "up" on the plan
 * (counter-clockwise is positive). The 3D world is Y-up: a plan point
 * (x, y) at elevation h sits at world (x, h, -y). See `toWorld` in geometry.
 */

export interface Vec2 {
  readonly x: number
  readonly y: number
}

/** Two points closer than this (metres) are treated as the same point. */
export const DIST_EPS = 1e-4

/** Below this, a cross product of unit vectors counts as parallel. */
export const PARALLEL_EPS = 1e-9

export const vec = (x: number, y: number): Vec2 => ({ x, y })
export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y })
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y })
export const scale = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, y: a.y * s })
export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y
export const cross = (a: Vec2, b: Vec2): number => a.x * b.y - a.y * b.x
export const length = (a: Vec2): number => Math.hypot(a.x, a.y)
export const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y)
export const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
})
export const midpoint = (a: Vec2, b: Vec2): Vec2 => lerp(a, b, 0.5)

/** Rotates 90° counter-clockwise: the left-hand normal of a direction. */
export const perpLeft = (a: Vec2): Vec2 => ({ x: -a.y, y: a.x })

export function normalize(a: Vec2): Vec2 {
  const l = length(a)
  return l === 0 ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l }
}

export const fromAngle = (radians: number): Vec2 => ({
  x: Math.cos(radians),
  y: Math.sin(radians),
})

export const angleOf = (a: Vec2): number => Math.atan2(a.y, a.x)

export interface SegmentProjection {
  /** Position along the segment, clamped to 0..1. */
  t: number
  point: Vec2
  distance: number
}

export function projectOnSegment(p: Vec2, a: Vec2, b: Vec2): SegmentProjection {
  const ab = sub(b, a)
  const lenSq = dot(ab, ab)
  const t = lenSq === 0 ? 0 : Math.min(1, Math.max(0, dot(sub(p, a), ab) / lenSq))
  const point = lerp(a, b, t)
  return { t, point, distance: dist(p, point) }
}

/**
 * True when p lies on segment ab, strictly between its ends
 * (more than DIST_EPS away from both).
 */
export function isOnSegmentInterior(p: Vec2, a: Vec2, b: Vec2): boolean {
  const segLen = dist(a, b)
  if (segLen < 2 * DIST_EPS) return false
  const { t, distance } = projectOnSegment(p, a, b)
  return distance < DIST_EPS && t * segLen > DIST_EPS && (1 - t) * segLen > DIST_EPS
}

/**
 * Intersects the lines p + t·r and q + u·s.
 * Returns null when they are parallel.
 */
export function intersectLines(
  p: Vec2,
  r: Vec2,
  q: Vec2,
  s: Vec2,
): { t: number; u: number; point: Vec2 } | null {
  const denom = cross(r, s)
  if (Math.abs(denom) < PARALLEL_EPS * length(r) * length(s)) return null
  const qp = sub(q, p)
  const t = cross(qp, s) / denom
  const u = cross(qp, r) / denom
  return { t, u, point: add(p, scale(r, t)) }
}

/**
 * Where segments ab and cd cross, strictly inside both
 * (not at or near either end). Null for touching, parallel or no contact.
 */
export function properCrossing(a: Vec2, b: Vec2, c: Vec2, d: Vec2): Vec2 | null {
  const hit = intersectLines(a, sub(b, a), c, sub(d, c))
  if (!hit) return null
  const lenAB = dist(a, b)
  const lenCD = dist(c, d)
  const inside = (t: number, len: number) => t * len > DIST_EPS && (1 - t) * len > DIST_EPS
  return inside(hit.t, lenAB) && inside(hit.u, lenCD) ? hit.point : null
}

/** Twice the signed area of a polygon; positive when counter-clockwise. */
export function signedArea2(points: readonly Vec2[]): number {
  let sum = 0
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!
    const q = points[(i + 1) % points.length]!
    sum += p.x * q.y - q.x * p.y
  }
  return sum
}

/** Whether p lies inside a closed ring (even-odd rule). */
export function pointInRing(p: Vec2, ring: readonly Vec2[]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!
    const b = ring[j]!
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

/** Area-weighted centroid of a simple polygon. */
export function polygonCentroid(points: readonly Vec2[]): Vec2 {
  let area = 0
  let cx = 0
  let cy = 0
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!
    const q = points[(i + 1) % points.length]!
    const c = p.x * q.y - q.x * p.y
    area += c
    cx += (p.x + q.x) * c
    cy += (p.y + q.y) * c
  }
  if (Math.abs(area) < 1e-12) {
    const n = points.length || 1
    return {
      x: points.reduce((s, p) => s + p.x, 0) / n,
      y: points.reduce((s, p) => s + p.y, 0) / n,
    }
  }
  return { x: cx / (3 * area), y: cy / (3 * area) }
}
