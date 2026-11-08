import type { Line, Shape } from './features.ts'

/**
 * Cutting shapes and lines to a rectangle (in tile units). Tiles overlap a
 * little, so whatever is kept from each must be cut to the tile itself to
 * have each building and road once.
 */

export interface Rect {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export const UNIT: Rect = { minX: 0, minY: 0, maxX: 1, maxY: 1 }

/** A ring cut to a rectangle (Sutherland–Hodgman), or null if nothing of it is inside. */
export function clipRing(ring: Line, rect: Rect): Line | null {
  let points: number[] = Array.from(ring)
  const edges: [axis: 0 | 1, value: number, keepAbove: boolean][] = [
    [0, rect.minX, true],
    [0, rect.maxX, false],
    [1, rect.minY, true],
    [1, rect.maxY, false],
  ]
  for (const [axis, value, above] of edges) {
    const n = points.length / 2
    if (n === 0) break
    const out: number[] = []
    const inside = (i: number) => (above ? points[i * 2 + axis]! >= value : points[i * 2 + axis]! <= value)
    for (let i = 0; i < n; i++) {
      const j = (i + n - 1) % n
      const a = inside(j)
      const b = inside(i)
      if (b) {
        if (!a) out.push(...crossing(points, j, i, axis, value))
        out.push(points[i * 2]!, points[i * 2 + 1]!)
      } else if (a) out.push(...crossing(points, j, i, axis, value))
    }
    points = out
  }
  return points.length >= 6 ? Float64Array.from(points) : null
}

function crossing(points: number[], j: number, i: number, axis: 0 | 1, value: number): [number, number] {
  const ax = points[j * 2]!
  const ay = points[j * 2 + 1]!
  const bx = points[i * 2]!
  const by = points[i * 2 + 1]!
  const t = axis === 0 ? (value - ax) / (bx - ax) : (value - ay) / (by - ay)
  return axis === 0 ? [value, ay + (by - ay) * t] : [ax + (bx - ax) * t, value]
}

/** A shape cut to a rectangle (holes too), or null if it's outside. */
export function clipShape(shape: Shape, rect: Rect): Shape | null {
  if (!overlaps(shape.outer, rect)) return null
  const outer = clipRing(shape.outer, rect)
  if (!outer) return null
  const holes = shape.holes.map((h) => clipRing(h, rect)).filter((h): h is Line => !!h)
  return { outer, holes }
}

/** The pieces of a line inside a rectangle (Liang–Barsky per segment, joined where they run on). */
export function clipLine(line: Line, rect: Rect): Line[] {
  const pieces: Line[] = []
  let current: number[] = []
  const flush = () => {
    if (current.length >= 4) pieces.push(Float64Array.from(current))
    current = []
  }
  const n = line.length / 2
  for (let i = 0; i + 1 < n; i++) {
    const x0 = line[i * 2]!
    const y0 = line[i * 2 + 1]!
    const x1 = line[i * 2 + 2]!
    const y1 = line[i * 2 + 3]!
    const dx = x1 - x0
    const dy = y1 - y0
    let t0 = 0
    let t1 = 1
    const p = [-dx, dx, -dy, dy]
    const q = [x0 - rect.minX, rect.maxX - x0, y0 - rect.minY, rect.maxY - y0]
    let visible = true
    for (let k = 0; k < 4; k++) {
      if (p[k] === 0) {
        if (q[k]! < 0) visible = false
      } else {
        const t = q[k]! / p[k]!
        if (p[k]! < 0) t0 = Math.max(t0, t)
        else t1 = Math.min(t1, t)
      }
    }
    if (!visible || t0 > t1) {
      flush()
      continue
    }
    // Ends inside stay exactly where they are.
    const ax = t0 === 0 ? x0 : x0 + dx * t0
    const ay = t0 === 0 ? y0 : y0 + dy * t0
    const bx = t1 === 1 ? x1 : x0 + dx * t1
    const by = t1 === 1 ? y1 : y0 + dy * t1
    const last = current.length
    if (last === 0 || current[last - 2] !== ax || current[last - 1] !== ay) {
      flush()
      current.push(ax, ay)
    }
    current.push(bx, by)
    if (t1 < 1) flush()
  }
  flush()
  return pieces
}

function overlaps(ring: Line, rect: Rect): boolean {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let i = 0; i < ring.length; i += 2) {
    minX = Math.min(minX, ring[i]!)
    maxX = Math.max(maxX, ring[i]!)
    minY = Math.min(minY, ring[i + 1]!)
    maxY = Math.max(maxY, ring[i + 1]!)
  }
  return maxX > rect.minX && minX < rect.maxX && maxY > rect.minY && minY < rect.maxY
}

/** Whether a point is inside a ring (even-odd). */
export function insideRing(ring: Line, x: number, y: number): boolean {
  let inside = false
  const n = ring.length / 2
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i * 2]!
    const yi = ring[i * 2 + 1]!
    const xj = ring[j * 2]!
    const yj = ring[j * 2 + 1]!
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** The middle of a ring by area (its centroid), or its first point if it has none. */
export function ringCentroid(ring: Line): [number, number] {
  let a = 0
  let cx = 0
  let cy = 0
  const n = ring.length / 2
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const f = ring[j * 2]! * ring[i * 2 + 1]! - ring[i * 2]! * ring[j * 2 + 1]!
    a += f
    cx += (ring[j * 2]! + ring[i * 2]!) * f
    cy += (ring[j * 2 + 1]! + ring[i * 2 + 1]!) * f
  }
  if (Math.abs(a) < 1e-18) return [ring[0]!, ring[1]!]
  return [cx / (3 * a), cy / (3 * a)]
}
