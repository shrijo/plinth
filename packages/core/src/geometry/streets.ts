import type { Vec2 } from '../math.ts'
import type { Id, Snapshot, Street } from '../model.ts'
import { offsetPolyline, polylineLength, sampleCurve, slicePolyline } from './curves.ts'
import { buildJunction, type JunctionEnd } from './junctions.ts'
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


function build(snapshot: Snapshot): StreetGeometry {
  const streets = Object.values(snapshot.streets)
  const centreLines = new Map<Id, Vec2[]>()
  const sections = new Map<Id, CrossSection>()
  const atNode = new Map<Id, Street[]>()
  for (const street of streets) {
    const a = snapshot.streetNodes[street.a]
    const b = snapshot.streetNodes[street.b]
    if (!a || !b || street.a === street.b) continue
    centreLines.set(street.id, sampleCurve({ a, b, control: street.control }))
    sections.set(street.id, crossSection(street))
    for (const id of [street.a, street.b]) {
      const list = atNode.get(id)
      if (list) list.push(street)
      else atNode.set(id, [street])
    }
  }

  const pieces: StreetPiece[] = []
  const outlines = new Map<Id, Vec2[]>()
  const ring = (points: Vec2[]): MultiPolygon => (points.length >= 3 ? [[toRing(points)]] : [])

  // Junctions: where two or more streets meet. Each street's own surface
  // starts where the junction ends (its setback at that end).
  const setbacks = new Map<string, number>()
  const isJunction = (nodeId: Id) => (atNode.get(nodeId)?.length ?? 0) >= 2
  for (const [nodeId, meeting] of atNode) {
    const node = snapshot.streetNodes[nodeId]
    if (!node || meeting.length < 2) continue
    const ends: JunctionEnd[] = meeting.map((street) => {
      const line = centreLines.get(street.id)!
      const section = sections.get(street.id)!
      const atStart = street.a === nodeId
      const otherEnd = atStart ? street.b : street.a
      return {
        line: atStart ? line : [...line].reverse(),
        road: atStart
          ? { left: section.roadLeft, right: section.roadRight }
          : { left: section.roadRight, right: section.roadLeft },
        outer: atStart
          ? { left: section.outerLeft, right: section.outerRight }
          : { left: section.outerRight, right: section.outerLeft },
        limit: polylineLength(line) * (isJunction(otherEnd) ? 0.5 : 0.95),
      }
    })
    const junction = buildJunction(node, ends)
    pieces.push({
      key: `junction:${nodeId}`,
      road: ring(junction.road),
      bike: [],
      parking: [],
      sidewalks: junction.sidewalks.flatMap(ring),
      markings: [],
      crosswalks: [],
      centre: { x: node.x, y: node.y },
    })
    meeting.forEach((street, i) => setbacks.set(`${street.id}:${street.a === nodeId ? 'a' : 'b'}`, junction.setbacks[i]!))
  }

  for (const street of streets) {
    const line = centreLines.get(street.id)
    const section = sections.get(street.id)
    if (!line || !section) continue
    const { carriageway, roadLeft, roadRight, outerLeft, outerRight } = section
    outlines.set(street.id, band(line, -outerRight, outerLeft))

    // The street's own surface, lanes, markings and crosswalks run between the junctions.
    const length = polylineLength(line)
    const startTrim = setbacks.get(`${street.id}:a`) ?? 0
    const endTrim = setbacks.get(`${street.id}:b`) ?? 0
    if (length - startTrim - endTrim < 1e-3) continue
    const inner = slicePolyline(line, startTrim, length - endTrim)
    // Overlapping the junctions a little, so rounding can't leave a hairline gap between them.
    const surface = slicePolyline(line, Math.max(0, startTrim - OVERLAP), Math.min(length, length - endTrim + OVERLAP))
    // With room for lanes, the road is the carriageway and the bike and
    // parking lanes lie beside it, edge to edge: nothing overlaps, so all of
    // it can be drawn as one mesh. (A stub too short for lanes is all road.)
    const laned = length - startTrim - endTrim >= 0.5
    const piece: StreetPiece = {
      key: `street:${street.id}`,
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
    }
    pieces.push(piece)
    if (!laned) continue

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
    // Lane lines: solid down the middle between the directions, dashed between lanes.
    const middle = Math.floor(street.lanes / 2)
    for (let k = 1; k < street.lanes; k++) {
      const offset = -carriageway + k * street.laneWidth
      if (k === middle) {
        markings.push(band(slicePolyline(inner, markStart, markEnd), offset - MARKING_WIDTH / 2, offset + MARKING_WIDTH / 2))
      } else {
        for (let s = markStart; s < markEnd; s += DASH + GAP) {
          const piece = slicePolyline(inner, s, Math.min(s + DASH, markEnd))
          if (piece.length >= 2) markings.push(band(piece, offset - MARKING_WIDTH / 2, offset + MARKING_WIDTH / 2))
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
  }

  return { pieces, outlines, centreLines }
}

/** The length of a street's centre line. */
export function streetLength(snapshot: Snapshot, street: Street): number {
  const a = snapshot.streetNodes[street.a]
  const b = snapshot.streetNodes[street.b]
  return a && b ? polylineLength(sampleCurve({ a, b, control: street.control })) : 0
}

