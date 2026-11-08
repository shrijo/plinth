import { add, dist, dot, lerp, normalize, perpLeft, scale, sub, type Vec2 } from '../math.ts'
import { isSharedStreet, type Id, type Snapshot, type Street } from '../model.ts'
import { frameAt, offsetPolyline, polylineLength, sampleCurve, slicePolyline } from './curves.ts'
import { buildJunction, CURB_RADIUS, type JunctionEnd } from './junctions.ts'
import { difference, toRing, union, type MultiPolygon } from './regions.ts'

/**
 * The street network as drawable pieces. Each street's cross-section runs
 * from its centre line outwards, per side: half the carriageway, a bike
 * lane, a parking lane, then the raised sidewalk. Junctions are filled in
 * with rounded kerbs (see junctions.ts), sidewalks wrap round the corners,
 * and lanes, markings and crosswalks stop where a junction begins.
 *
 * Every street and every junction is its own piece, built directly from
 * its outlines with no polygon operations: neighbouring pieces meet edge
 * to edge (overlapping by a centimetre), so a network of thousands of
 * streets builds in linear time.
 */
export interface StreetPiece {
  /** `street:<id>` for a street's own stretch between junctions, `junction:<node id>` for a junction. */
  key: string
  /** Road level: carriageway and junction. */
  road: MultiPolygon
  bike: MultiPolygon
  parking: MultiPolygon
  /** Raised to curb height. */
  sidewalks: MultiPolygon
  /** Lane lines and edge lines, as thin quads. */
  markings: Vec2[][]
  /** Zebra stripes. */
  crosswalks: Vec2[][]
  /** Roughly where the piece is, for grouping pieces into tiles. */
  centre: Vec2
  /** One paved surface (a living street or pedestrian zone): its road is drawn as paving. */
  shared: boolean
}

export interface StreetGeometry {
  pieces: StreetPiece[]
  /** Each street's own outline (road and sidewalks), for picking. */
  outlines: Map<Id, Vec2[]>
  /** Each street's sampled centre line. */
  centreLines: Map<Id, Vec2[]>
}

/** The pieces' surfaces merged into single regions (for measuring; the editor draws the pieces). */
export function mergeStreetRegions(geometry: StreetGeometry): {
  road: MultiPolygon
  sidewalks: MultiPolygon
  bike: MultiPolygon
  parking: MultiPolygon
} {
  const all = (pick: (p: StreetPiece) => MultiPolygon) => union(...geometry.pieces.map(pick))
  // Bike and parking lanes are part of the road, as before they lay beside the carriageway.
  const road = union(all((p) => p.road), all((p) => p.bike), all((p) => p.parking))
  return {
    road,
    sidewalks: difference(all((p) => p.sidewalks), road),
    bike: all((p) => p.bike),
    parking: all((p) => p.parking),
  }
}

const MARKING_WIDTH = 0.12
const OVERLAP = 0.01
const DASH = 3
const GAP = 4
const CROSSWALK_DEPTH = 3
const STRIPE = 0.5

export interface CrossSection {
  /** Half of the carriageway (all driving lanes), from the centre line. */
  carriageway: number
  /** Road-level width each side: carriageway half, bike and parking lanes. */
  roadLeft: number
  roadRight: number
  /** Overall width each side, sidewalks included. */
  outerLeft: number
  outerRight: number
}

export function crossSection(street: Street): CrossSection {
  const carriageway = (street.lanes * street.laneWidth) / 2
  const roadLeft = carriageway + street.bikeLeft + street.parkingLeft
  const roadRight = carriageway + street.bikeRight + street.parkingRight
  return {
    carriageway,
    roadLeft,
    roadRight,
    outerLeft: roadLeft + street.sidewalkLeft,
    outerRight: roadRight + street.sidewalkRight,
  }
}

const cache = new WeakMap<object, { nodes: Snapshot['streetNodes']; geometry: StreetGeometry }>()

export function streetGeometry(snapshot: Snapshot): StreetGeometry {
  const hit = cache.get(snapshot.streets)
  if (hit && hit.nodes === snapshot.streetNodes) return hit.geometry
  const geometry = build(snapshot)
  cache.set(snapshot.streets, { nodes: snapshot.streetNodes, geometry })
  return geometry
}

/** The strip between two sideways offsets of a line, as a closed outline. */
function band(points: readonly Vec2[], from: number, to: number): Vec2[] {
  if (points.length < 2 || Math.abs(to - from) < 1e-6) return []
  return [...offsetPolyline(points, from), ...offsetPolyline(points, to).reverse()]
}


/** A street walked one way or the other along a way. */
interface Walk {
  street: Street
  /** From a to b. */
  forward: boolean
}

/**
 * A way: streets chained end to end through bends, as OpenStreetMap draws
 * a street (one line through many points, its tags changing along it).
 * Bends are where exactly two streets meet at a gentle angle; everywhere
 * else a way ends, at a junction or a dead end. Where the cross-section
 * changes along a way (more lanes, a sidewalk starting), it tapers from
 * one to the other: the street carries on, its edges unbroken.
 */
interface Way {
  walks: Walk[]
  line: Vec2[]
  /** Each walk's cross-section as walked: left and right seen along the way. */
  sections: Street[]
  /** Where each walk starts along the line, and (last) the line's length. */
  stops: number[]
  start: Id
  end: Id
  /** A living street or pedestrian zone: one paved surface. */
  shared: boolean
}

/** A bend sharper than this (degrees off straight on) is a junction, not a bend. */
const MAX_BEND = 55
/** A change of cross-section tapers over this many times the largest shift of an edge (metres per metre), within limits. */
const TAPER_RATE = 5
const MIN_TAPER = 2
const MAX_TAPER = 30

const SIDES: [keyof Street, keyof Street][] = [
  ['bikeLeft', 'bikeRight'],
  ['parkingLeft', 'parkingRight'],
  ['sidewalkLeft', 'sidewalkRight'],
  ['crosswalkA', 'crosswalkB'],
]

/** A street's record as walked: walked backwards, its left is its right (and its start its end). */
function walked(walk: Walk): Street {
  if (walk.forward) return walk.street
  const turned = { ...walk.street } as Record<string, unknown>
  for (const [l, r] of SIDES) {
    turned[l] = walk.street[r]
    turned[r] = walk.street[l]
  }
  return turned as unknown as Street
}

/**
 * A cross-section as the offsets of its edges from the centre line, left
 * then right: carriageway, bike lane, parking lane, sidewalk (each edge
 * the outer side of that strip).
 */
type Edges = [number, number, number, number, number, number, number, number]
const C_L = 0
const B_L = 1
const P_L = 2
const O_L = 3
const C_R = 4
const B_R = 5
const P_R = 6
const O_R = 7

function edgesOf(street: Street): Edges {
  const c = (street.lanes * street.laneWidth) / 2
  const bl = c + street.bikeLeft
  const br = c + street.bikeRight
  const pl = bl + street.parkingLeft
  const pr = br + street.parkingRight
  return [c, bl, pl, pl + street.sidewalkLeft, c, br, pr, pr + street.sidewalkRight]
}

const sameEdges = (a: Edges, b: Edges) => a.every((v, i) => Math.abs(v - b[i]!) < 1e-6)

function taperLength(a: Edges, b: Edges): number {
  const shift = Math.max(...a.map((v, i) => Math.abs(v - b[i]!)))
  return Math.min(Math.max(shift * TAPER_RATE, MIN_TAPER), MAX_TAPER)
}

/** A cross-section along a way: edges at points along it, straight from one to the next (and level beyond the first and last). */
interface Knot {
  s: number
  edges: Edges
}

function edgesAt(knots: readonly Knot[], s: number): Edges {
  if (s <= knots[0]!.s) return knots[0]!.edges
  for (let i = 1; i < knots.length; i++) {
    const k = knots[i]!
    if (s <= k.s) {
      const j = knots[i - 1]!
      const t = k.s - j.s < 1e-9 ? 1 : (s - j.s) / (k.s - j.s)
      return j.edges.map((v, e) => v + (k.edges[e]! - v) * t) as Edges
    }
  }
  return knots[knots.length - 1]!.edges
}

/** A polyline's points between two distances along it, with a point at each of `breaks` too, and how far along each lies. */
function sliceAt(line: readonly Vec2[], from: number, to: number, breaks: readonly number[]): { points: Vec2[]; at: number[] } {
  const marks = [...new Set([from, ...breaks.filter((b) => b > from && b < to), to])].sort((a, b) => a - b)
  const points: Vec2[] = []
  const at: number[] = []
  let walked = 0
  let m = 0
  const push = (p: Vec2, s: number) => {
    if (at.length > 0 && s - at[at.length - 1]! < 1e-6) return
    points.push(p)
    at.push(s)
  }
  for (let i = 1; i < line.length && m < marks.length; i++) {
    const p = line[i - 1]!
    const q = line[i]!
    const length = dist(p, q)
    if (length === 0) continue
    const end = walked + length
    // The marks on this segment, then its end point if it's inside the slice.
    while (m < marks.length && (marks[m]! <= end || i === line.length - 1)) {
      const s = marks[m]!
      push(lerp(p, q, Math.min(Math.max((s - walked) / length, 0), 1)), s)
      m++
    }
    if (end > from && end < to) push(q, end)
    walked = end
  }
  return { points, at }
}

/** A line offset sideways by a distance per point (positive to the left), with mitred corners. */
function offsetVarying(points: readonly Vec2[], distances: readonly number[]): Vec2[] {
  return points.map((p, i) => {
    const prev = points[i - 1]
    const next = points[i + 1]
    const n1 = prev ? perpLeft(normalize(sub(p, prev))) : null
    const n2 = next ? perpLeft(normalize(sub(next, p))) : null
    const d = distances[i]!
    if (!n1 || !n2) return add(p, scale((n1 ?? n2)!, d))
    const mid = normalize(add(n1, n2))
    const cosine = Math.max(0.25, dot(mid, n1))
    return add(p, scale(mid, d / cosine))
  })
}

/**
 * The strip between two edges of a way's cross-section (sideways offsets,
 * signed: positive to the left) from one distance along it to another, as
 * outlines: one per stretch where it has any width (a sidewalk that starts
 * and stops along the way is several).
 */
function strip(
  line: readonly Vec2[],
  knots: readonly Knot[],
  from: number,
  to: number,
  inner: (e: Edges) => number,
  outer: (e: Edges) => number,
): Vec2[][] {
  if (to - from < 1e-6) return []
  const { points, at } = sliceAt(
    line,
    from,
    to,
    knots.map((k) => k.s),
  )
  if (points.length < 2) return []
  const edges = at.map((s) => edgesAt(knots, s))
  const a = edges.map(inner)
  const b = edges.map(outer)
  const wide = (i: number) => Math.abs(b[i]! - a[i]!) > 1e-4
  const outlines: Vec2[][] = []
  let i = 0
  while (i < points.length - 1) {
    if (!wide(i) && !wide(i + 1)) {
      i++
      continue
    }
    let j = i + 1
    while (j < points.length - 1 && (wide(j) || wide(j + 1))) j++
    const run = points.slice(i, j + 1)
    outlines.push([...offsetVarying(run, a.slice(i, j + 1)), ...offsetVarying(run, b.slice(i, j + 1)).reverse()])
    i = j
  }
  return outlines
}

/** Whether a street can carry on into the next through a bend: both paved as one surface, or neither. */
function continues(arriving: Street, leaving: Street): boolean {
  return isSharedStreet(arriving) === isSharedStreet(leaving)
}

function build(snapshot: Snapshot): StreetGeometry {
  const streets = Object.values(snapshot.streets)
  const centreLines = new Map<Id, Vec2[]>()
  const atNode = new Map<Id, Street[]>()
  for (const street of streets) {
    const a = snapshot.streetNodes[street.a]
    const b = snapshot.streetNodes[street.b]
    if (!a || !b || street.a === street.b) continue
    centreLines.set(street.id, sampleCurve({ a, b, control: street.control }))
    for (const id of [street.a, street.b]) {
      const list = atNode.get(id)
      if (list) list.push(street)
      else atNode.set(id, [street])
    }
  }

  // Bends: points where the street just goes on.
  const linked = new Map<string, { street: Street; end: 'a' | 'b' }>()
  const bends = new Set<Id>()
  const direction = (line: Vec2[], fromEnd: boolean): Vec2 => {
    const p = fromEnd ? line[line.length - 2]! : line[0]!
    const q = fromEnd ? line[line.length - 1]! : line[1]!
    return normalize(sub(q, p))
  }
  for (const [nodeId, meeting] of atNode) {
    if (meeting.length !== 2) continue
    const [s1, s2] = meeting as [Street, Street]
    if (s1.id === s2.id || !continues(s1, s2)) continue
    const l1 = centreLines.get(s1.id)!
    const l2 = centreLines.get(s2.id)!
    const into = s1.b === nodeId ? direction(l1, true) : scale(direction(l1, false), -1)
    const out = s2.a === nodeId ? direction(l2, false) : scale(direction(l2, true), -1)
    if (dot(into, out) < Math.cos((MAX_BEND * Math.PI) / 180)) continue
    bends.add(nodeId)
    const e1 = s1.a === nodeId ? 'a' : 'b'
    const e2 = s2.a === nodeId ? 'a' : 'b'
    linked.set(`${s1.id}:${e1}`, { street: s2, end: e2 })
    linked.set(`${s2.id}:${e2}`, { street: s1, end: e1 })
  }

  // Ways: each street joined with its neighbours through bends.
  const ways: Way[] = []
  const done = new Set<Id>()
  for (const street of streets) {
    if (done.has(street.id) || !centreLines.has(street.id)) continue
    // Back to the way's start (or round a loop to this street again).
    let first = street
    let enter: 'a' | 'b' = 'a'
    for (let guard = 0; guard < 100000; guard++) {
      const back = linked.get(`${first.id}:${enter}`)
      if (!back || back.street.id === street.id) break
      first = back.street
      enter = back.end === 'a' ? 'b' : 'a'
    }
    const walks: Walk[] = []
    let current = first
    let entering = enter
    for (;;) {
      walks.push({ street: current, forward: entering === 'a' })
      done.add(current.id)
      const leave = entering === 'a' ? 'b' : 'a'
      const next = linked.get(`${current.id}:${leave}`)
      if (!next || done.has(next.street.id)) break
      current = next.street
      entering = next.end
    }
    const line: Vec2[] = []
    const stops: number[] = []
    let walkedSoFar = 0
    for (const walk of walks) {
      const own = centreLines.get(walk.street.id)!
      const points = walk.forward ? own : [...own].reverse()
      stops.push(walkedSoFar)
      walkedSoFar += polylineLength(points)
      line.push(...(line.length > 0 ? points.slice(1) : points))
    }
    stops.push(walkedSoFar)
    const head = walks[0]!
    const tail = walks[walks.length - 1]!
    ways.push({
      walks,
      line,
      sections: walks.map(walked),
      stops,
      start: head.forward ? head.street.a : head.street.b,
      end: tail.forward ? tail.street.b : tail.street.a,
      shared: isSharedStreet(head.street),
    })
  }

  const pieces: StreetPiece[] = []
  const outlines = new Map<Id, Vec2[]>()
  const ring = (points: Vec2[]): MultiPolygon => (points.length >= 3 ? [[toRing(points)]] : [])
  for (const street of streets) {
    const line = centreLines.get(street.id)
    if (!line) continue
    const section = crossSection(street)
    outlines.set(street.id, band(line, -section.outerRight, section.outerLeft))
  }

  // Junctions: where ways end together. Each way's own surface starts where the junction ends (its setback there).
  const endsAt = new Map<Id, { way: number; atStart: boolean }[]>()
  ways.forEach((way, index) => {
    for (const [node, atStart] of [
      [way.start, true],
      [way.end, false],
    ] as const) {
      const list = endsAt.get(node)
      if (list) list.push({ way: index, atStart })
      else endsAt.set(node, [{ way: index, atStart }])
    }
  })
  const isJunction = (nodeId: Id) => !bends.has(nodeId) && (endsAt.get(nodeId)?.length ?? 0) >= 2
  const setbacks = new Map<string, number>()
  for (const [nodeId, meeting] of endsAt) {
    const node = snapshot.streetNodes[nodeId]
    if (!node || !isJunction(nodeId)) continue
    const ends: JunctionEnd[] = meeting.map(({ way: index, atStart }) => {
      const way = ways[index]!
      // The way's cross-section where it leaves the junction (its first or last street's), as seen looking out.
      const section = crossSection(atStart ? way.sections[0]! : way.sections[way.sections.length - 1]!)
      const otherEnd = atStart ? way.end : way.start
      return {
        line: atStart ? way.line : [...way.line].reverse(),
        road: atStart ? { left: section.roadLeft, right: section.roadRight } : { left: section.roadRight, right: section.roadLeft },
        outer: atStart ? { left: section.outerLeft, right: section.outerRight } : { left: section.outerRight, right: section.outerLeft },
        limit: polylineLength(way.line) * (isJunction(otherEnd) ? 0.5 : 0.95),
      }
    })
    // Corners sized like real kerbs: from the narrowest road that meets here (its sidewalks don't make the
    // turn wider), tighter for a lane than for an avenue, so the network stays crisp.
    const narrowest = Math.min(...ends.map((e) => Math.min(e.road.left, e.road.right)))
    const junction = buildJunction(node, ends, Math.min(Math.max(narrowest * 0.9, 1.5), CURB_RADIUS))
    const shared = meeting.every(({ way }) => ways[way]!.shared)
    pieces.push({
      key: `junction:${nodeId}`,
      road: shared ? ring(junction.road).concat(junction.sidewalks.flatMap(ring)) : ring(junction.road),
      bike: [],
      parking: [],
      sidewalks: shared ? [] : junction.sidewalks.flatMap(ring),
      markings: [],
      crosswalks: [],
      centre: { x: node.x, y: node.y },
      shared,
    })
    meeting.forEach(({ way, atStart }, i) => setbacks.set(`${way}:${atStart ? 'start' : 'end'}`, junction.setbacks[i]!))
  }

  ways.forEach((way, index) => {
    const line = way.line
    const length = way.stops[way.stops.length - 1]!
    const startTrim = setbacks.get(`${index}:start`) ?? 0
    const endTrim = setbacks.get(`${index}:end`) ?? 0
    if (length - startTrim - endTrim < 1e-3) return
    const from = startTrim
    const to = length - endTrim

    // The cross-section along the way: each street's own, tapering where it changes.
    let knots: Knot[] = [{ s: 0, edges: edgesOf(way.sections[0]!) }]
    /** How far the taper at each change of street reaches back and on (none where the cross-section stays). */
    const back = way.sections.map(() => 0)
    const on = way.sections.map(() => 0)
    for (let i = 1; i < way.sections.length; i++) {
      const before = edgesOf(way.sections[i - 1]!)
      const after = edgesOf(way.sections[i]!)
      if (sameEdges(before, after)) continue
      const at = way.stops[i]!
      const half = taperLength(before, after) / 2
      const h1 = Math.min(half, 0.45 * (at - way.stops[i - 1]!))
      const h2 = Math.min(half, 0.45 * (way.stops[i + 1]! - at))
      knots.push({ s: at - h1, edges: before }, { s: at + h2, edges: after })
      back[i] = h1
      on[i] = h2
    }
    knots.push({ s: length, edges: edgesOf(way.sections[way.sections.length - 1]!) })
    // At a junction the way has the cross-section it meets the junction with (a change of section within the
    // junction tapers from its edge instead).
    let clearFrom = from
    let clearTo = to
    if (knots.some((k) => k.s > 1e-9 && k.s < from)) {
      const old = knots
      const own = old[0]!.edges
      const there = edgesAt(old, from)
      const rest = old.filter((k) => k.s > from)
      if (sameEdges(own, there)) knots = [{ s: from, edges: own }, ...rest]
      else {
        const s2 = Math.min(from + taperLength(own, there), (from + to) / 2)
        knots = [{ s: from, edges: own }, { s: s2, edges: edgesAt(old, s2) }, ...rest.filter((k) => k.s > s2)]
        clearFrom = s2
      }
    }
    if (knots.some((k) => k.s < length - 1e-9 && k.s > to)) {
      const old = knots
      const own = old[old.length - 1]!.edges
      const there = edgesAt(old, to)
      const rest = old.filter((k) => k.s < to)
      if (sameEdges(own, there)) knots = [...rest, { s: to, edges: own }]
      else {
        const s2 = Math.max(to - taperLength(own, there), (from + to) / 2)
        knots = [...rest.filter((k) => k.s < s2), { s: s2, edges: edgesAt(old, s2) }, { s: to, edges: own }]
        clearTo = s2
      }
    }

    // Overlapping the junctions a little, so rounding can't leave a hairline gap between them.
    const s0 = Math.max(0, from - OVERLAP)
    const s1 = Math.min(length, to + OVERLAP)
    const mid = frameAt(line, (from + to) / 2).p
    const piece = (road: MultiPolygon, shared: boolean): StreetPiece => ({
      key: `street:${way.walks[0]!.street.id}`,
      road,
      bike: [],
      parking: [],
      sidewalks: [],
      markings: [],
      crosswalks: [],
      centre: mid,
      shared,
    })
    const strips = (inner: (e: Edges) => number, outer: (e: Edges) => number): MultiPolygon =>
      strip(line, knots, s0, s1, inner, outer).flatMap(ring)

    if (way.shared) {
      // A living street or pedestrian zone: one paved surface from wall to wall.
      pieces.push(piece(strips((e) => -e[O_R], (e) => e[O_L]), true))
      return
    }
    // With room for lanes, the road is the carriageway and the bike and
    // parking lanes lie beside it, edge to edge: nothing overlaps, so all of
    // it can be drawn as one mesh. (A stub too short for lanes is all road.)
    const laned = to - from >= 0.5
    const own = piece(laned ? strips((e) => -e[C_R], (e) => e[C_L]) : strips((e) => -e[P_R], (e) => e[P_L]), false)
    own.sidewalks = [...strips((e) => e[P_L], (e) => e[O_L]), ...strips((e) => -e[O_R], (e) => -e[P_R])]
    pieces.push(own)
    if (!laned) return
    own.bike = [...strips((e) => e[C_L], (e) => e[B_L]), ...strips((e) => -e[B_R], (e) => -e[C_R])]
    own.parking = [...strips((e) => e[B_L], (e) => e[P_L]), ...strips((e) => -e[P_R], (e) => -e[B_R])]

    // Zebra crossings across the whole road width near the way's flagged ends.
    const head = way.sections[0]!
    const tail = way.sections[way.sections.length - 1]!
    const crossDepth = Math.min(CROSSWALK_DEPTH, (to - from) / 3)
    const zebra = (at: number, section: Street) => {
      const stretch = slicePolyline(line, at, at + crossDepth)
      if (stretch.length < 2) return
      const { roadLeft, roadRight } = crossSection(section)
      for (let o = -roadRight + STRIPE / 2; o + STRIPE <= roadLeft; o += STRIPE * 2) own.crosswalks.push(band(stretch, o, o + STRIPE))
    }
    if (head.crosswalkA) zebra(from, head)
    if (tail.crosswalkB) zebra(to - crossDepth, tail)
    const markFrom = Math.max(from + (head.crosswalkA ? crossDepth + 0.5 : 0), clearFrom)
    const markTo = Math.min(to - (tail.crosswalkB ? crossDepth + 0.5 : 0), clearTo)

    // Lines, per run of streets with the same lanes (a change of lanes tapers, unmarked): solid down the middle
    // between the directions (none on a one-way street), dashed between lanes, and edge lines where the
    // carriageway meets a bike or parking lane.
    const signature = (s: Street) => `${s.lanes}:${s.laneWidth}:${!!s.oneway}:${s.bikeLeft + s.parkingLeft > 0}:${s.bikeRight + s.parkingRight > 0}`
    const markings = own.markings
    let r = 0
    for (let i = 1; i <= way.sections.length; i++) {
      if (i < way.sections.length && signature(way.sections[i]!) === signature(way.sections[r]!)) continue
      // Walks r..i-1 make one run, its lines clear of the tapers at either end.
      const runFrom = Math.max(markFrom, way.stops[r]! + on[r]!)
      const runTo = Math.min(markTo, way.stops[i]! - (i < way.sections.length ? back[i]! : 0))
      const street = way.sections[r]!
      if (runTo - runFrom > 0.5) {
        const run = slicePolyline(line, runFrom, runTo)
        const carriageway = (street.lanes * street.laneWidth) / 2
        const middle = street.oneway ? -1 : Math.floor(street.lanes / 2)
        for (let k = 1; k < street.lanes; k++) {
          const offset = -carriageway + k * street.laneWidth
          if (k === middle) {
            markings.push(band(run, offset - MARKING_WIDTH / 2, offset + MARKING_WIDTH / 2))
          } else {
            const runLength = runTo - runFrom
            for (let s = 0; s < runLength; s += DASH + GAP) {
              const dash = slicePolyline(run, s, Math.min(s + DASH, runLength))
              if (dash.length >= 2) markings.push(band(dash, offset - MARKING_WIDTH / 2, offset + MARKING_WIDTH / 2))
            }
          }
        }
        if (street.bikeLeft + street.parkingLeft > 0) markings.push(band(run, carriageway - MARKING_WIDTH, carriageway))
        if (street.bikeRight + street.parkingRight > 0) markings.push(band(run, -carriageway, -carriageway + MARKING_WIDTH))
      }
      r = i
    }
    own.markings = markings.filter((m) => m.length >= 4)
    own.crosswalks = own.crosswalks.filter((m) => m.length >= 4)
  })

  return { pieces, outlines, centreLines }
}

/** The length of a street's centre line. */
export function streetLength(snapshot: Snapshot, street: Street): number {
  const a = snapshot.streetNodes[street.a]
  const b = snapshot.streetNodes[street.b]
  return a && b ? polylineLength(sampleCurve({ a, b, control: street.control })) : 0
}

