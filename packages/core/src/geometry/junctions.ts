import { add, angleOf, dist, dot, intersectLines, normalize, perpLeft, scale, sub, type Vec2 } from '../math.ts'
import { frameAt, offsetPolyline, slicePolyline } from './curves.ts'

/**
 * The shape of a street junction: where streets meet, the road is filled
 * in with rounded curbs on every corner (a real kerb radius, so the
 * sidewalks wrap round smoothly), a bend between two streets is drawn as
 * one continuous curve, and a change of width tapers instead of jumping.
 */

/** Kerb radius at street corners, in metres. */
export const CURB_RADIUS = 6
/** Two streets within this angle of a straight line just continue (with a taper if their widths differ). */
const STRAIGHT = (15 * Math.PI) / 180
/** A change of width tapers over this many times the difference, on each side of the junction. */
/** Neighbouring streets closer than this angle (radians, about 20°) leave a junction side by side. */
const TIGHT = 0.35
const TAPER = 2
const ARC_STEP = Math.PI / 24

export interface HalfWidths {
  /** Left and right of the street, looking out of the junction. */
  left: number
  right: number
}

export interface JunctionEnd {
  /** The street's centre line, starting at the junction and running outwards. */
  line: readonly Vec2[]
  /** To the outer edge of the road (lanes, bike and parking lanes). */
  road: HalfWidths
  /** To the outer edge of the sidewalks. */
  outer: HalfWidths
  /** How far along the street the junction may reach at most. */
  limit: number
}

export interface Junction {
  /** The road surface of the junction itself; the streets start at their setbacks. */
  road: Vec2[]
  /** The junction out to the back of the sidewalks. */
  outer: Vec2[]
  /**
   * The sidewalk corners between neighbouring streets: each the strip
   * between the kerb and the back of the sidewalk, built from the same
   * paths as the outlines, so no polygon operations are needed.
   */
  sidewalks: Vec2[][]
  /** Per end (in the order given): where along the street the junction ends. */
  setbacks: number[]
}

type Layer = 'road' | 'outer'

interface Fillet {
  /** Where the corner sits along each of the two streets. */
  along: [number, number]
  /** The kerb arc: from the tangent point on the first street to the one on the second. */
  from: Vec2
  to: Vec2
  centre: Vec2
  corner: Vec2
  radius: number
}

interface Sector {
  kind: 'fillet' | 'straight' | 'round' | 'tight'
  fillet: Record<Layer, Fillet | null>
}

/** A point on a street's edge: `side` 1 is its left, -1 its right. */
function edgePoint(end: JunctionEnd, side: 1 | -1, width: number, s: number): Vec2 {
  const { p, d } = frameAt(end.line, s)
  return add(p, scale(perpLeft(d), side * width))
}

/** Points along an arc round `centre` from `from` to `to`, the short way, easing the radius if the ends differ. */
function arc(centre: Vec2, from: Vec2, to: Vec2): Vec2[] {
  const a0 = angleOf(sub(from, centre))
  let sweep = angleOf(sub(to, centre)) - a0
  while (sweep > Math.PI) sweep -= 2 * Math.PI
  while (sweep < -Math.PI) sweep += 2 * Math.PI
  const r0 = dist(from, centre)
  const r1 = dist(to, centre)
  const steps = Math.max(1, Math.ceil(Math.abs(sweep) / ARC_STEP))
  const points: Vec2[] = []
  for (let k = 0; k <= steps; k++) {
    const t = k / steps
    const angle = a0 + sweep * t
    const r = r0 + (r1 - r0) * t
    points.push({ x: centre.x + Math.cos(angle) * r, y: centre.y + Math.sin(angle) * r })
  }
  return points
}

/**
 * The rounded corner between the left edge of one street (`a` from its
 * centre line) and the right edge of the next street anticlockwise (`b`).
 * The edges are taken as straight lines along each street's direction at
 * `sI` and `sJ`, so a curved street is met where the corner actually is.
 * The radius shrinks if the corner wouldn't fit on the streets.
 */
function filletAt(
  endI: JunctionEnd,
  a: number,
  sI: number,
  endJ: JunctionEnd,
  b: number,
  sJ: number,
  radius: number,
): Fillet | null {
  const fi = frameAt(endI.line, sI)
  const fj = frameAt(endJ.line, sJ)
  let phi = angleOf(fj.d) - angleOf(fi.d)
  while (phi <= 0) phi += 2 * Math.PI
  while (phi > 2 * Math.PI) phi -= 2 * Math.PI
  if (phi >= Math.PI - 1e-3) return null
  const hit = intersectLines(add(fi.p, scale(perpLeft(fi.d), a)), fi.d, sub(fj.p, scale(perpLeft(fj.d), b)), fj.d)
  if (!hit) return null
  const u = sI + hit.t
  const v = sJ + hit.u
  const tanHalf = Math.tan(phi / 2)
  const room = Math.min(endI.limit - u, endJ.limit - v)
  const t = Math.max(0, Math.min(radius / tanHalf, room))
  const r = t * tanHalf
  return {
    along: [u + t, v + t],
    from: add(hit.point, scale(fi.d, t)),
    to: add(hit.point, scale(fj.d, t)),
    centre: add(hit.point, scale(normalize(add(fi.d, fj.d)), r / Math.sin(phi / 2))),
    corner: hit.point,
    radius: r,
  }
}

/** A fillet, refined a few times for curved streets: each pass measures the edges where the last one put the corner. */
function fillet(endI: JunctionEnd, a: number, endJ: JunctionEnd, b: number, radius: number): Fillet | null {
  const curved = endI.line.length > 2 || endJ.line.length > 2
  let result: Fillet | null = null
  let s: [number, number] = [0, 0]
  for (let pass = 0; pass < (curved ? 4 : 1); pass++) {
    const f = filletAt(endI, a, s[0], endJ, b, s[1], radius)
    if (!f) break
    result = f
    const next: [number, number] = [
      Math.min(Math.max(f.along[0], 0), endI.limit),
      Math.min(Math.max(f.along[1], 0), endJ.limit),
    ]
    if (Math.abs(next[0] - s[0]) < 1e-3 && Math.abs(next[1] - s[1]) < 1e-3) break
    s = next
  }
  return result
}

/** Points along a street's edge between two distances (in that order); only needed where the street curves. */
function edgeRun(end: JunctionEnd, side: 1 | -1, width: number, from: number, to: number): Vec2[] {
  if (end.line.length <= 2 || Math.abs(to - from) < 1e-3) return []
  const piece = slicePolyline(end.line, Math.max(0, Math.min(from, to)), Math.max(from, to))
  if (piece.length < 2) return []
  const edge = offsetPolyline(piece, side * width)
  return from > to ? edge.reverse() : edge
}

/** The foot of the perpendicular from `p` to the edge `width` to the side of a line through `node` along `d`. */
function foot(node: Vec2, d: Vec2, side: 1 | -1, width: number, p: Vec2): Vec2 {
  return add(add(node, scale(perpLeft(d), side * width)), scale(d, dot(sub(p, node), d)))
}

/**
 * Builds the junction where two or more streets meet at `node`. Returns
 * the road and sidewalk outlines of the junction and, per street, how far
 * from the node the street's own surface starts.
 */
export function buildJunction(node: Vec2, given: readonly JunctionEnd[], radius = CURB_RADIUS): Junction {
  const order = given
    .map((end, index) => ({ end, index, dir: frameAt(end.line, 0).d }))
    .sort((p, q) => angleOf(p.dir) - angleOf(q.dir))
  const n = order.length
  const setbacks = order.map(() => 0)
  const need = (k: number, s: number) => {
    setbacks[k] = Math.max(setbacks[k]!, Math.min(s, order[k]!.end.limit))
  }

  const sectors: Sector[] = order.map((current, k) => {
    const next = order[(k + 1) % n]!
    let phi = angleOf(next.dir) - angleOf(current.dir)
    if (phi <= 1e-6) phi += 2 * Math.PI
    // Streets leaving almost side by side (as the two halves of a divided road do) have no kerb between
    // them to round: their edges are joined straight, where the two strips part.
    const kind = phi < TIGHT ? 'tight' : phi < Math.PI - STRAIGHT ? 'fillet' : phi <= Math.PI + STRAIGHT ? 'straight' : 'round'
    const sector: Sector = { kind, fillet: { road: null, outer: null } }
    if (kind === 'tight') {
      const apart = (current.end.outer.left + next.end.outer.right) / Math.max(Math.tan(phi), 1e-3)
      need(k, apart)
      need((k + 1) % n, apart)
    } else if (kind === 'fillet') {
      const road = fillet(current.end, current.end.road.left, next.end, next.end.road.right, radius)
      // The back of the sidewalk follows the kerb, the sidewalk's width further in.
      const sidewalk = Math.max(
        current.end.outer.left - current.end.road.left,
        next.end.outer.right - next.end.road.right,
      )
      const outerRadius = Math.max(0, (road?.radius ?? 0) - sidewalk)
      const outer = fillet(current.end, current.end.outer.left, next.end, next.end.outer.right, outerRadius)
      // A kerb that would reach past either street's end (a short street, a shallow angle) is joined straight instead.
      const fits = (f: typeof road) => !!f && f.along[0] <= current.end.limit * 1.01 && f.along[1] <= next.end.limit * 1.01
      sector.fillet = { road: fits(road) ? road : null, outer: fits(outer) ? outer : null }
      for (const f of [sector.fillet.road, sector.fillet.outer]) {
        if (!f) continue
        need(k, f.along[0])
        need((k + 1) % n, f.along[1])
      }
    } else if (kind === 'straight') {
      for (const layer of ['road', 'outer'] as const) {
        const taper = TAPER * Math.abs(current.end[layer].left - next.end[layer].right)
        need(k, taper)
        need((k + 1) % n, taper)
      }
    }
    return sector
  })

  // A bend between two streets: the outside of the bend is centred on the
  // inside kerb, so the road keeps its width round the bend.
  const bendCentre = n === 2 ? (sectors.find((s) => s.kind === 'fillet')?.fillet.road?.centre ?? null) : null

  /**
   * One layer's edge between neighbouring streets k and k + 1: from this
   * street's left edge at its setback, round the corner, to the next
   * street's right edge at its setback.
   */
  const sectorPath = (layer: Layer, k: number): Vec2[] => {
    const current = order[k]!
    const next = order[(k + 1) % n]!
    const widths = current.end[layer]
    const points: Vec2[] = [edgePoint(current.end, 1, widths.left, setbacks[k]!)]
    {
      const sector = sectors[k]!
      const nextRight = next.end[layer].right
      const nextSetback = setbacks[(k + 1) % n]!
      if (sector.kind === 'fillet') {
        const f = sector.fillet[layer]
        if (f) {
          // Back along this street's edge to the kerb, round it, and out along the next street's edge.
          points.push(...edgeRun(current.end, 1, widths.left, setbacks[k]!, f.along[0]))
          points.push(...(f.radius > 1e-3 ? arc(f.centre, f.from, f.to) : [f.corner]))
          points.push(...edgeRun(next.end, -1, nextRight, f.along[1], nextSetback))
        }
      } else if (sector.kind === 'round') {
        const centre = bendCentre ?? node
        const from = foot(node, current.dir, 1, widths.left, centre)
        const to = foot(node, next.dir, -1, nextRight, centre)
        points.push(...edgeRun(current.end, 1, widths.left, setbacks[k]!, dot(sub(from, node), current.dir)))
        points.push(...arc(centre, from, to))
        points.push(...edgeRun(next.end, -1, nextRight, dot(sub(to, node), next.dir), nextSetback))
      }
    }
    points.push(edgePoint(next.end, -1, next.end[layer].right, setbacks[(k + 1) % n]!))
    return points
  }

  const road = order.map((_, k) => sectorPath('road', k))
  const outer = order.map((_, k) => sectorPath('outer', k))
  const unsorted = order.map(() => 0)
  order.forEach((o, k) => (unsorted[o.index] = setbacks[k]!))
  return {
    road: road.flat(),
    outer: outer.flat(),
    // Each corner: along the kerb, then back along the back of the sidewalk.
    sidewalks: road.map((path, k) => [...path, ...[...outer[k]!].reverse()]),
    setbacks: unsorted,
  }
}
