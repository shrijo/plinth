import earcut from 'earcut'
import { CURB_HEIGHT, difference, streetGeometry, type MultiPolygon, type Snapshot, type Vec2 } from '@plinth/core'
import type { RoadFeature, RoadKind } from './features.ts'
import type { Ground } from './ground.ts'
import { ecefFromLonLat, type Frame } from './geo.ts'
import { tileFrame, tileWidth, type MeshBuffers } from './mesh.ts'
import { tidyNetwork, type StreetLine } from './network.ts'
import { streetFromTags } from './site.ts'
import { tileLat, type TileId } from './tiles.ts'

/**
 * The real world's streets in 3D, built the way the editor builds a site's
 * streets (core's street geometry: carriageway, bike and parking lanes,
 * raised sidewalks with curbs, lane markings, junctions with rounded
 * kerbs), from a tile's map data. They sit on the ground's level street
 * bed (see Ground.level: flat across, smooth along), and every surface
 * reaches down into the ground as a solid, so no gap shows under a street
 * and none floats where the land drops away. Cut to the tile, so
 * neighbouring tiles meet edge to edge.
 */

export interface StreetColours {
  road: [number, number, number]
  bike: [number, number, number]
  parking: [number, number, number]
  sidewalk: [number, number, number]
  curb: [number, number, number]
  marking: [number, number, number]
}

/** How far each street's solid reaches below its surface (metres). */
const DEPTH = 4
/** Road surfaces lie this far above the street bed; lanes and paint a little higher. */
const ROAD = 0.06
const LANES = 0.068
const PAINT = 0.075
/** Surfaces are split to this length (metres) and sides to this, so they follow the bed (smooth over 18 m). */
const STEP = 14
const SIDE_STEP = 24

const HIGHWAYS: Partial<Record<RoadKind, string>> = {
  motorway: 'motorway',
  trunk: 'trunk',
  primary: 'primary',
  secondary: 'secondary',
  tertiary: 'tertiary',
  minor: 'residential',
  service: 'service',
  path: 'pedestrian',
}

/** A street's cross-section from what the map says of it (as a site made from the map gets). */
function propsOf(road: RoadFeature, town: boolean) {
  const highway = HIGHWAYS[road.kind]
  if (!highway) return null
  if (road.kind === 'service' && road.service && road.service !== 'alley') return null
  // Of the paths, only pedestrian streets: footways (often a street's own sidewalk, mapped apart), steps and trails stay painted.
  if (road.kind === 'path' && road.subclass !== 'pedestrian') return null
  const props = streetFromTags({ highway, ...(road.oneway ? { oneway: 'yes' } : {}) })
  if (!props) return null
  // Out of town, no sidewalks.
  if (!town) props.sidewalkLeft = props.sidewalkRight = 0
  return props
}

/**
 * The streets of a tile (zoom 14 map data), as one mesh in the tile's frame
 * with a colour per vertex. Null when there are none.
 */
export function streetMesh(
  tile: TileId,
  roads: readonly RoadFeature[],
  ground: Ground,
  colours: StreetColours,
  /** An area to leave out (a site's own streets are there): longitudes and latitudes of its corners. */
  mask?: readonly { lon: number; lat: number }[],
): MeshBuffers | null {
  const metres = tileWidth(tile)
  // Plan metres: x east, y north (tile units run south), as the editor's sites.
  const toPlan = (u: number, v: number): Vec2 => ({ x: u * metres, y: -v * metres })
  const lines: StreetLine[] = []
  for (const road of roads) {
    if (road.tunnel || road.bridge) continue
    const props = propsOf(road, ground.town)
    if (!props) continue
    const line = simplify(road.line, 0.4 / metres)
    const points: Vec2[] = []
    for (let i = 0; i + 1 < line.length; i += 2) points.push(toPlan(line[i]!, line[i + 1]!))
    lines.push({ points, props })
  }
  if (lines.length === 0) return null
  // One junction per crossing, no stray stubs, no sidewalks down the middle of a divided road; ends at the
  // data's edge (beyond the tile) are where it was cut, not dead ends.
  const network = tidyNetwork(lines, {
    keepEnd: (p) => p.x < 1 || p.x > metres - 1 || p.y > -1 || p.y < -metres + 1,
  })
  const geometry = streetGeometry({ streetNodes: network.nodes, streets: network.streets } as unknown as Snapshot)

  // The tile itself, in plan metres: everything is cut to it.
  const rect = { minX: 0, maxX: metres, minY: -metres, maxY: 0 }
  // The area left out, in plan metres, and its bounds (only pieces near it need cutting).
  const n = 2 ** tile.z
  const hole: [number, number][] | null = mask
    ? mask.map(({ lon, lat }) => {
        const φ = (lat * Math.PI) / 180
        const u = ((lon + 180) / 360) * n - tile.x
        const v = ((1 - Math.log(Math.tan(φ) + 1 / Math.cos(φ)) / Math.PI) / 2) * n - tile.y
        const p = toPlan(u, v)
        return [p.x, p.y]
      })
    : null
  const holeBox = hole && {
    minX: Math.min(...hole.map((p) => p[0])),
    maxX: Math.max(...hole.map((p) => p[0])),
    minY: Math.min(...hole.map((p) => p[1])),
    maxY: Math.max(...hole.map((p) => p[1])),
  }
  // Whether a region's bounds overlap the area's (a long street can cross it with no corner near it).
  const near = (region: MultiPolygon) =>
    !!holeBox &&
    region.some((polygon) => {
      let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity]
      for (const [x, y] of polygon[0]!) {
        x0 = Math.min(x0, x)
        x1 = Math.max(x1, x)
        y0 = Math.min(y0, y)
        y1 = Math.max(y1, y)
      }
      return x1 > holeBox.minX && x0 < holeBox.maxX && y1 > holeBox.minY && y0 < holeBox.maxY
    })
  const cut = (region: MultiPolygon): MultiPolygon => {
    const own = clip(region, rect)
    return hole && near(own) ? difference(own, [[hole]]) : own
  }
  const writer = new StreetWriter(tile, metres, ground)
  for (const piece of geometry.pieces) {
    // Every surface is a solid: a road may have a sidewalk on one side only, or a bike or parking lane at its
    // edge, and nothing may show under it.
    const road = cut(piece.road)
    // A living street or pedestrian zone is paved like a sidewalk, wall to wall, at sidewalk height.
    if (piece.shared) writer.slab(road, ROAD + 0.04, colours.sidewalk, colours.curb)
    else writer.slab(road, ROAD, colours.road, colours.curb)
    writer.slab(cut(piece.bike), LANES, colours.bike, colours.curb)
    writer.slab(cut(piece.parking), LANES, colours.parking, colours.curb)
    writer.slab(cut(piece.sidewalks), ROAD + CURB_HEIGHT, colours.sidewalk, colours.curb)
    for (const mark of [...piece.markings, ...piece.crosswalks]) {
      // A line can run the length of a long street: cut like the surfaces, not judged by its middle.
      const region = cut([[mark.map((p) => [p.x, p.y] as [number, number])]])
      if (region.length > 0) writer.top(region, PAINT, colours.marking)
    }
  }
  return writer.finish()
}

const UP = [0, 1, 0] as const

class StreetWriter {
  private positions: number[] = []
  private normals: number[] = []
  private colors: number[] = []
  private indices: number[] = []
  private readonly frame: Frame
  private readonly tile: TileId
  private readonly metres: number
  private readonly ground: Ground
  private readonly heights = new Map<string, number>()
  /** Top vertices by place, height and colour: shared between the triangles that meet there. */
  private readonly tops = new Map<string, number>()

  constructor(tile: TileId, metres: number, ground: Ground) {
    this.tile = tile
    this.metres = metres
    this.ground = ground
    this.frame = tileFrame(tile)
  }

  /** A plan point on the globe: its longitude and latitude, and the street bed's height there. */
  private site(x: number, y: number): { lon: number; lat: number; bed: number } {
    const n = 2 ** this.tile.z
    const u = x / this.metres
    const v = -y / this.metres
    const lon = ((this.tile.x + u) / n) * 360 - 180
    const lat = tileLat(this.tile.y + v, this.tile.z)
    // Shared corners are asked for again and again.
    const key = `${Math.round(x * 100)}:${Math.round(y * 100)}`
    let bed = this.heights.get(key)
    if (bed === undefined) {
      bed = this.ground.level(lon, lat)
      this.heights.set(key, bed)
    }
    return { lon, lat, bed }
  }

  private vertex(x: number, y: number, lift: number, normal: readonly number[], colour: readonly number[]): number {
    const { lon, lat, bed } = this.site(x, y)
    const p = ecefFromLonLat(lon, lat, bed + lift)
    const f = this.frame
    const dx = p[0] - f.origin[0]
    const dy = p[1] - f.origin[1]
    const dz = p[2] - f.origin[2]
    this.positions.push(
      f.east[0] * dx + f.east[1] * dy + f.east[2] * dz,
      f.up[0] * dx + f.up[1] * dy + f.up[2] * dz,
      -(f.north[0] * dx + f.north[1] * dy + f.north[2] * dz),
    )
    this.normals.push(normal[0]!, normal[1]!, normal[2]!)
    this.colors.push(colour[0]!, colour[1]!, colour[2]!)
    return this.positions.length / 3 - 1
  }

  /** A surface at a height over the bed: its top, split finely enough to follow the bed. */
  top(region: MultiPolygon, lift: number, colour: readonly number[]): void {
    for (const polygon of region) {
      const flat: number[] = []
      const holes: number[] = []
      polygon.forEach((ring, r) => {
        if (r > 0) holes.push(flat.length / 2)
        const open = openRing(ring)
        for (const [x, y] of open) flat.push(x, y)
      })
      if (flat.length < 6) continue
      const triangles = earcut(flat, holes, 2)
      for (let t = 0; t < triangles.length; t += 3) {
        const p = (k: number): [number, number] => [flat[triangles[t + k]! * 2]!, flat[triangles[t + k]! * 2 + 1]!]
        this.triangle(p(0), p(1), p(2), lift, colour, 0)
      }
    }
  }

  private triangle(a: [number, number], b: [number, number], c: [number, number], lift: number, colour: readonly number[], depth: number): void {
    const ab = Math.hypot(a[0] - b[0], a[1] - b[1])
    const bc = Math.hypot(b[0] - c[0], b[1] - c[1])
    const ca = Math.hypot(c[0] - a[0], c[1] - a[1])
    const most = Math.max(ab, bc, ca)
    if (most > STEP && depth < 10) {
      const mid = (p: [number, number], q: [number, number]): [number, number] => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]
      if (most === ab) {
        const m = mid(a, b)
        this.triangle(a, m, c, lift, colour, depth + 1)
        this.triangle(m, b, c, lift, colour, depth + 1)
      } else if (most === bc) {
        const m = mid(b, c)
        this.triangle(a, b, m, lift, colour, depth + 1)
        this.triangle(a, m, c, lift, colour, depth + 1)
      } else {
        const m = mid(c, a)
        this.triangle(a, b, m, lift, colour, depth + 1)
        this.triangle(m, b, c, lift, colour, depth + 1)
      }
      return
    }
    const shared = (p: [number, number]) => {
      const key = `${Math.round(p[0] * 1000)}:${Math.round(p[1] * 1000)}:${lift}:${colour.join(',')}`
      let index = this.tops.get(key)
      if (index === undefined) {
        index = this.vertex(p[0], p[1], lift, UP, colour)
        this.tops.set(key, index)
      }
      return index
    }
    const i = shared(a)
    const j = shared(b)
    const k = shared(c)
    // Facing up: anticlockwise on the plan (x east, y north).
    const ccw = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) > 0
    this.indices.push(...(ccw ? [i, j, k] : [i, k, j]))
  }

  /**
   * A street surface as a solid: its top at a height over the bed, and its
   * sides down into the ground (no bottom: nobody sees it).
   */
  slab(region: MultiPolygon, lift: number, colour: readonly number[], side: readonly number[]): void {
    if (region.length === 0) return
    this.top(region, lift, colour)
    for (const polygon of region) {
      for (const [r, ring] of polygon.entries()) {
        const open = orient(openRing(ring), r === 0)
        for (let i = 0; i < open.length; i++) {
          const p = open[i]!
          const q = open[(i + 1) % open.length]!
          const length = Math.hypot(q[0] - p[0], q[1] - p[1])
          if (length < 1e-6) continue
          // Outwards: to the right of the edge (outer rings anticlockwise, holes clockwise).
          const nx = (q[1] - p[1]) / length
          const ny = -(q[0] - p[0]) / length
          const normal = [nx, 0, -ny]
          const pieces = Math.max(1, Math.ceil(length / SIDE_STEP))
          for (let k = 0; k < pieces; k++) {
            const s0 = k / pieces
            const s1 = (k + 1) / pieces
            const x0 = p[0] + (q[0] - p[0]) * s0
            const y0 = p[1] + (q[1] - p[1]) * s0
            const x1 = p[0] + (q[0] - p[0]) * s1
            const y1 = p[1] + (q[1] - p[1]) * s1
            const a = this.vertex(x0, y0, -DEPTH, normal, side)
            const b = this.vertex(x1, y1, -DEPTH, normal, side)
            const c = this.vertex(x1, y1, lift, normal, side)
            const d = this.vertex(x0, y0, lift, normal, side)
            this.indices.push(a, b, c, a, c, d)
          }
        }
      }
    }
  }

  finish(): MeshBuffers | null {
    if (this.indices.length === 0) return null
    return {
      positions: Float32Array.from(this.positions),
      normals: Float32Array.from(this.normals),
      colors: Float32Array.from(this.colors),
      indices: Uint32Array.from(this.indices),
    }
  }
}

type Ring = [number, number][]

function openRing(ring: Ring): Ring {
  const first = ring[0]
  const last = ring[ring.length - 1]
  return first && last && ring.length > 1 && first[0] === last[0] && first[1] === last[1] ? ring.slice(0, -1) : ring
}

/** A ring turned anticlockwise (outer) or clockwise (hole) on the plan. */
function orient(ring: Ring, outer: boolean): Ring {
  let area = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) area += ring[j]![0] * ring[i]![1] - ring[i]![0] * ring[j]![1]
  return area > 0 === outer ? ring : [...ring].reverse()
}

interface PlanRect {
  minX: number
  maxX: number
  minY: number
  maxY: number
}

/** A ring cut to a rectangle (Sutherland–Hodgman), or null if nothing's left. */
function clipRingPlan(ring: Ring, rect: PlanRect): Ring | null {
  let points = openRing(ring)
  const edges: [0 | 1, number, boolean][] = [
    [0, rect.minX, true],
    [0, rect.maxX, false],
    [1, rect.minY, true],
    [1, rect.maxY, false],
  ]
  for (const [axis, value, above] of edges) {
    if (points.length === 0) return null
    const inside = (p: [number, number]) => (above ? p[axis] >= value : p[axis] <= value)
    const out: Ring = []
    for (let i = 0; i < points.length; i++) {
      const a = points[(i + points.length - 1) % points.length]!
      const b = points[i]!
      const cross = (): [number, number] => {
        const t = (value - a[axis]) / (b[axis] - a[axis])
        return axis === 0 ? [value, a[1] + (b[1] - a[1]) * t] : [a[0] + (b[0] - a[0]) * t, value]
      }
      if (inside(b)) {
        if (!inside(a)) out.push(cross())
        out.push(b)
      } else if (inside(a)) out.push(cross())
    }
    points = out
  }
  return points.length >= 3 ? points : null
}

function clip(region: MultiPolygon, rect: PlanRect): MultiPolygon {
  const out: MultiPolygon = []
  for (const polygon of region) {
    const outer = polygon[0] && clipRingPlan(polygon[0], rect)
    if (!outer) continue
    const holes = polygon.slice(1).map((h) => clipRingPlan(h, rect)).filter((h): h is Ring => !!h)
    out.push([outer, ...holes])
  }
  return out
}

/** Douglas–Peucker on a line in tile units. */
function simplify(line: Float64Array, tolerance: number): Float64Array {
  const n = line.length / 2
  if (n <= 2) return line
  const keep = new Uint8Array(n)
  keep[0] = keep[n - 1] = 1
  const stack: [number, number][] = [[0, n - 1]]
  while (stack.length > 0) {
    const [a, b] = stack.pop()!
    const [ax, ay, bx, by] = [line[a * 2]!, line[a * 2 + 1]!, line[b * 2]!, line[b * 2 + 1]!]
    const dx = bx - ax
    const dy = by - ay
    const l = dx * dx + dy * dy
    let worst = -1
    let far = tolerance
    for (let i = a + 1; i < b; i++) {
      const px = line[i * 2]!
      const py = line[i * 2 + 1]!
      const t = l === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l))
      const d = Math.hypot(px - ax - dx * t, py - ay - dy * t)
      if (d > far) {
        far = d
        worst = i
      }
    }
    if (worst >= 0) {
      keep[worst] = 1
      stack.push([a, worst], [worst, b])
    }
  }
  const out: number[] = []
  for (let i = 0; i < n; i++) if (keep[i]) out.push(line[i * 2]!, line[i * 2 + 1]!)
  return Float64Array.from(out)
}
