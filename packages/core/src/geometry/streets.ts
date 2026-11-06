import { dot, normalize, scale, sub, type Vec2 } from '../math.ts'
import { isSharedStreet, type Id, type Snapshot, type Street } from '../model.ts'
import { offsetPolyline, polylineLength, sampleCurve, slicePolyline } from './curves.ts'
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
 * a street (one line through many points). Bends are where exactly two
 * streets of the same cross-section meet at a gentle angle; everywhere
 * else a way ends, at a junction or a dead end.
 */
interface Way {
  walks: Walk[]
  line: Vec2[]
  /** The cross-section as walked: left and right seen along the way. */
  street: Street
  start: Id
  end: Id
}

/** A bend sharper than this (degrees off straight on) is a junction, not a bend. */
const MAX_BEND = 55

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

/** Whether two walks (one arriving at a point, one leaving it) have the same cross-section, so they can be one way. */
function sameSection(arriving: Walk, leaving: Walk): boolean {
  const a = walked(arriving)
  const b = walked(leaving)
  const near = (x: number, y: number) => Math.abs(x - y) < 1e-6
  if ((a.kind ?? 'residential') !== (b.kind ?? 'residential')) return false
  if (!!a.oneway !== !!b.oneway) return false
  // One way, the same way.
  if (a.oneway && arriving.forward !== leaving.forward) return false
  return (
    a.lanes === b.lanes &&
    near(a.laneWidth, b.laneWidth) &&
    near(a.bikeLeft, b.bikeLeft) &&
    near(a.bikeRight, b.bikeRight) &&
    near(a.parkingLeft, b.parkingLeft) &&
    near(a.parkingRight, b.parkingRight) &&
    near(a.sidewalkLeft, b.sidewalkLeft) &&
    near(a.sidewalkRight, b.sidewalkRight)
  )
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
    const arriving: Walk = { street: s1, forward: s1.b === nodeId }
    const leaving: Walk = { street: s2, forward: s2.a === nodeId }
    if (!sameSection(arriving, leaving)) continue
    const l1 = centreLines.get(s1.id)!
    const l2 = centreLines.get(s2.id)!
    const into = arriving.forward ? direction(l1, true) : scale(direction(l1, false), -1)
    const out = leaving.forward ? direction(l2, false) : scale(direction(l2, true), -1)
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
    for (const walk of walks) {
      const own = centreLines.get(walk.street.id)!
      const points = walk.forward ? own : [...own].reverse()
      line.push(...(line.length > 0 ? points.slice(1) : points))
    }
    const head = walks[0]!
    const tail = walks[walks.length - 1]!
    // The way's cross-section as walked; its crossings are its first street's at the start and its last's at the end.
    const section = { ...walked(head), crosswalkB: walked(tail).crosswalkB }
    ways.push({
      walks,
      line,
      street: section,
      start: head.forward ? head.street.a : head.street.b,
      end: tail.forward ? tail.street.b : tail.street.a,
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
      const section = crossSection(way.street)
      const otherEnd = atStart ? way.end : way.start
      return {
        line: atStart ? way.line : [...way.line].reverse(),
        road: atStart ? { left: section.roadLeft, right: section.roadRight } : { left: section.roadRight, right: section.roadLeft },
        outer: atStart ? { left: section.outerLeft, right: section.outerRight } : { left: section.outerRight, right: section.outerLeft },
        limit: polylineLength(way.line) * (isJunction(otherEnd) ? 0.5 : 0.95),
      }
    })
    // Corners sized to the streets: a lane's turn is tighter than a boulevard's.
    const narrowest = Math.min(...ends.map((e) => Math.min(e.outer.left, e.outer.right)))
    const junction = buildJunction(node, ends, Math.min(Math.max(narrowest * 1.2, 2.5), CURB_RADIUS))
    const shared = meeting.every(({ way }) => isSharedStreet(ways[way]!.street))
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
    const street = way.street
    const line = way.line
    const { carriageway, roadLeft, roadRight, outerLeft, outerRight } = crossSection(street)
    const shared = isSharedStreet(street)

    // The way's own surface, lanes, markings and crosswalks run between the junctions.
    const length = polylineLength(line)
    const startTrim = setbacks.get(`${index}:start`) ?? 0
    const endTrim = setbacks.get(`${index}:end`) ?? 0
    if (length - startTrim - endTrim < 1e-3) return
    const inner = slicePolyline(line, startTrim, length - endTrim)
    // Overlapping the junctions a little, so rounding can't leave a hairline gap between them.
    const surface = slicePolyline(line, Math.max(0, startTrim - OVERLAP), Math.min(length, length - endTrim + OVERLAP))
    if (shared) {
      // A living street or pedestrian zone: one paved surface from wall to wall.
      pieces.push({
        key: `street:${way.walks[0]!.street.id}`,
        road: ring(band(surface, -outerRight, outerLeft)),
        bike: [],
        parking: [],
        sidewalks: [],
        markings: [],
        crosswalks: [],
        centre: inner[Math.floor(inner.length / 2)] ?? line[0]!,
        shared: true,
      })
      return
    }
    // With room for lanes, the road is the carriageway and the bike and
    // parking lanes lie beside it, edge to edge: nothing overlaps, so all of
    // it can be drawn as one mesh. (A stub too short for lanes is all road.)
    const laned = length - startTrim - endTrim >= 0.5
    const piece: StreetPiece = {
      key: `street:${way.walks[0]!.street.id}`,
      road: ring(laned ? band(surface, -carriageway, carriageway) : band(surface, -roadRight, roadLeft)),
      bike: [],
      parking: [],
      sidewalks: [
        ...(street.sidewalkLeft > 0 ? ring(band(surface, roadLeft, outerLeft)) : []),
        ...(street.sidewalkRight > 0 ? ring(band(surface, -outerRight, -roadRight)) : []),
      ],
      markings: [],
      crosswalks: [],
      centre: inner[Math.floor(inner.length / 2)] ?? line[0]!,
      shared: false,
    }
    pieces.push(piece)
    if (!laned) return

    if (street.bikeLeft > 0) piece.bike.push(...ring(band(surface, carriageway, carriageway + street.bikeLeft)))
    if (street.bikeRight > 0) piece.bike.push(...ring(band(surface, -carriageway - street.bikeRight, -carriageway)))
    if (street.parkingLeft > 0) {
      const from = carriageway + street.bikeLeft
      piece.parking.push(...ring(band(surface, from, from + street.parkingLeft)))
    }
    if (street.parkingRight > 0) {
      const from = carriageway + street.bikeRight
      piece.parking.push(...ring(band(surface, -from - street.parkingRight, -from)))
    }

    const innerLength = polylineLength(inner)
    const crossDepth = Math.min(CROSSWALK_DEPTH, innerLength / 3)
    const markStart = street.crosswalkA ? crossDepth + 0.5 : 0
    const markEnd = innerLength - (street.crosswalkB ? crossDepth + 0.5 : 0)
    const markings = piece.markings
    // Lane lines: solid down the middle between the directions (none on a one-way street), dashed between lanes.
    const middle = street.oneway ? -1 : Math.floor(street.lanes / 2)
    for (let k = 1; k < street.lanes; k++) {
      const offset = -carriageway + k * street.laneWidth
      if (k === middle) {
        markings.push(band(slicePolyline(inner, markStart, markEnd), offset - MARKING_WIDTH / 2, offset + MARKING_WIDTH / 2))
      } else {
        for (let s = markStart; s < markEnd; s += DASH + GAP) {
          const dash = slicePolyline(inner, s, Math.min(s + DASH, markEnd))
          if (dash.length >= 2) markings.push(band(dash, offset - MARKING_WIDTH / 2, offset + MARKING_WIDTH / 2))
        }
      }
    }
    // Edge lines where the carriageway meets a bike or parking lane.
    if (street.bikeLeft + street.parkingLeft > 0) markings.push(band(inner, carriageway - MARKING_WIDTH, carriageway))
    if (street.bikeRight + street.parkingRight > 0) markings.push(band(inner, -carriageway, -carriageway + MARKING_WIDTH))

    // Zebra crossings across the whole road width near each flagged end.
    const zebra = (from: number) => {
      const stretch = slicePolyline(inner, from, from + crossDepth)
      if (stretch.length < 2) return
      for (let o = -roadRight + STRIPE / 2; o + STRIPE <= roadLeft; o += STRIPE * 2) {
        piece.crosswalks.push(band(stretch, o, o + STRIPE))
      }
    }
    if (street.crosswalkA) zebra(0)
    if (street.crosswalkB) zebra(innerLength - crossDepth)
    piece.markings = markings.filter((m) => m.length >= 4)
    piece.crosswalks = piece.crosswalks.filter((m) => m.length >= 4)
  })

  return { pieces, outlines, centreLines }
}

/** The length of a street's centre line. */
export function streetLength(snapshot: Snapshot, street: Street): number {
  const a = snapshot.streetNodes[street.a]
  const b = snapshot.streetNodes[street.b]
  return a && b ? polylineLength(sampleCurve({ a, b, control: street.control })) : 0
}

