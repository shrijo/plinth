import { add, dist, lerp, normalize, perpLeft, projectOnSegment, scale, sub, type Vec2 } from '../math.ts'

/**
 * Street centre lines: straight, or a quadratic curve through a control
 * point. Curves are sampled evenly in their parameter t, so a point's index
 * in the samples converts back to t.
 */
export interface Curve {
  a: Vec2
  b: Vec2
  control: Vec2 | null
}

export function pointOnCurve({ a, b, control }: Curve, t: number): Vec2 {
  if (!control) return lerp(a, b, t)
  const u = 1 - t
  return add(add(scale(a, u * u), scale(control, 2 * u * t)), scale(b, t * t))
}

/** Samples along the curve: 2 for a straight line, more for a curve (about one per 1.5 m). */
export function sampleCurve(curve: Curve): Vec2[] {
  if (!curve.control) return [curve.a, curve.b]
  const rough = dist(curve.a, curve.control) + dist(curve.control, curve.b)
  const segments = Math.max(8, Math.min(96, Math.ceil(rough / 1.5)))
  return Array.from({ length: segments + 1 }, (_, i) => pointOnCurve(curve, i / segments))
}

/** Splits a curve at t into two curves that together trace the same path (de Casteljau). */
export function splitCurve(curve: Curve, t: number): [Curve, Curve] {
  const middle = pointOnCurve(curve, t)
  if (!curve.control) return [{ a: curve.a, b: middle, control: null }, { a: middle, b: curve.b, control: null }]
  const c1 = lerp(curve.a, curve.control, t)
  const c2 = lerp(curve.control, curve.b, t)
  return [
    { a: curve.a, b: middle, control: c1 },
    { a: middle, b: curve.b, control: c2 },
  ]
}

/** The control point that makes a curve from a to b pass through `through` at its middle. */
export function controlThrough(a: Vec2, b: Vec2, through: Vec2): Vec2 {
  // P(0.5) = a/4 + c/2 + b/4, so c = 2·P(0.5) − (a + b)/2.
  return sub(scale(through, 2), scale(add(a, b), 0.5))
}

export interface CurveProjection {
  t: number
  point: Vec2
  distance: number
}

/** The nearest point on a sampled curve, with its parameter t. */
export function projectOnCurve(samples: readonly Vec2[], p: Vec2): CurveProjection {
  const n = samples.length - 1
  let best: CurveProjection = { t: 0, point: samples[0]!, distance: Infinity }
  for (let i = 0; i < n; i++) {
    const hit = projectOnSegment(p, samples[i]!, samples[i + 1]!)
    if (hit.distance < best.distance) best = { t: (i + hit.t) / n, point: hit.point, distance: hit.distance }
  }
  return best
}

export function polylineLength(points: readonly Vec2[]): number {
  let length = 0
  for (let i = 1; i < points.length; i++) length += dist(points[i - 1]!, points[i]!)
  return length
}

/** The part of a polyline between two distances along it. */
export function slicePolyline(points: readonly Vec2[], from: number, to: number): Vec2[] {
  const result: Vec2[] = []
  let walked = 0
  for (let i = 1; i < points.length; i++) {
    const p = points[i - 1]!
    const q = points[i]!
    const length = dist(p, q)
    const start = walked
    const end = walked + length
    walked = end
    if (end < from || start > to || length === 0) continue
    const t0 = Math.max(0, (from - start) / length)
    const t1 = Math.min(1, (to - start) / length)
    if (result.length === 0) result.push(lerp(p, q, t0))
    result.push(lerp(p, q, t1))
  }
  return result
}

/** A line offset sideways (positive to the left), with mitred corners. */
export function offsetPolyline(points: readonly Vec2[], distance: number): Vec2[] {
  if (points.length < 2 || distance === 0) return [...points]
  const result: Vec2[] = []
  for (let i = 0; i < points.length; i++) {
    const prev = points[i - 1]
    const next = points[i + 1]
    const p = points[i]!
    const n1 = prev ? perpLeft(normalize(sub(p, prev))) : null
    const n2 = next ? perpLeft(normalize(sub(next, p))) : null
    if (!n1 || !n2) {
      result.push(add(p, scale((n1 ?? n2)!, distance)))
      continue
    }
    const mid = normalize(add(n1, n2))
    const cosine = Math.max(0.25, mid.x * n1.x + mid.y * n1.y)
    result.push(add(p, scale(mid, distance / cosine)))
  }
  return result
}

/** Position and direction a distance along a polyline (straight on past its end). */
export function frameAt(line: readonly Vec2[], s: number): { p: Vec2; d: Vec2 } {
  let walked = 0
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1]!
    const b = line[i]!
    const len = dist(a, b)
    if (len === 0) continue
    if (walked + len >= s || i === line.length - 1) return { p: lerp(a, b, (s - walked) / len), d: scale(sub(b, a), 1 / len) }
    walked += len
  }
  return { p: line[0] ?? { x: 0, y: 0 }, d: { x: 1, y: 0 } }
}
