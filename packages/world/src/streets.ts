import { crossSection, CURB_HEIGHT, streetGeometry, type MultiPolygon, type Snapshot, type Vec2 } from '@plinth/core'
import type { BuildingFeature, RoadFeature, RoadKind, Shape } from './features.ts'
import { LineField, stations } from './field.ts'
import type { Ground } from './ground.ts'
import { ecefFromLonLat, type Frame } from './geo.ts'
import { tileFrame, tileWidth, type MeshBuffers } from './mesh.ts'
import { looksLikeRoundabout, tidyNetwork, type StreetLine } from './network.ts'
import { areaOf, common, merged, polygonsOf, rectangle, regionOf, rounded, without, type Region } from './plan.ts'
import { streetFromTags } from './site.ts'
import { tileLat, type TileId } from './tiles.ts'
import { triangulate } from './triangulate.ts'

/**
 * The real world's streets in 3D, from a tile's map data: tidied into a
 * network, given their cross-sections and junctions the way the editor
 * builds a site's streets (core's street geometry), and then laid as one
 * plan. Everything at road level is merged into a single surface, closed
 * over the slivers map data leaves between ways mapped side by side and
 * its corners rounded to a kerb's radius, so a crossing of many ways is
 * one clean piece of road however it was mapped. The blocks between the
 * streets are that plan's complement, raised to kerb height. They sit on
 * the ground's level street bed (see Ground.level: flat across, smooth
 * along), and every surface reaches down into the ground as a solid, so
 * no gap shows under a street and none floats where the land drops away.
 * Cut to the tile, so neighbouring tiles meet edge to edge.
 */

export interface StreetColours {
  road: [number, number, number]
  bike: [number, number, number]
  parking: [number, number, number]
  sidewalk: [number, number, number]
  curb: [number, number, number]
  marking: [number, number, number]
  /** Block fills: the land between the streets, and its green spaces. */
  land?: [number, number, number]
  green?: [number, number, number]
}

/** How far each street's solid reaches below its surface (metres). */
const DEPTH = 4
/** Road surfaces lie this far above the street bed; paint a little higher. */
const ROAD = 0.06
const PAINT = 0.09
/** The walking plane: block fills and paved squares stand at kerb height over the bed. */
const KERB = ROAD + CURB_HEIGHT
/** Sides are split to this length (metres), so they follow the bed. */
const SIDE_STEP = 24
/**
 * The road plan is closed over gaps narrower than twice this (metres: the slivers between ways mapped side by
 * side, a lane's width of island) and its inward corners rounded to it, a tight kerb's radius; then spikes
 * and necks thinner than twice `THIN` go.
 */
const ROUND = 2.4
const THIN = 0.6
/** An island in the road smaller than this (square metres) is road. */
const ISLAND = 30
/** A street's own height reaches this far beyond its road (metres), fading into the ground's. */
const BED_REACH = 7
/** A block bigger than this (square metres) with next to nothing built on it is open country: no fill, only the streets' pavements. */
const OPEN_BLOCK = 45000
const BUILT = 0.03

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

/** A street's cross-section from what the map says of it (as a site made from the map gets), or null if it isn't built. */
export function propsOf(road: RoadFeature, town: boolean) {
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

export interface StreetsBuilt {
  /** One mesh in the tile's frame with a colour per vertex, or null when there are no streets. */
  mesh: MeshBuffers | null
  /**
   * Everything the mesh covers (streets, paving, block fills), in plan
   * metres: where the ground needn't be drawn, since ours stands over it.
   */
  cover: MultiPolygon
  /** Of the cover: the green block fills (parks and greenery in town, raised to kerb height), where grass grows. */
  greenFills: MultiPolygon
  /** Of the cover: everything else (streets, paving, plain fills), where no grass grows. */
  paved: MultiPolygon
}

export interface StreetOptions {
  /** The tile's buildings: the blocks' surface is cut round those standing on the ground, so it meets each wall at its base. */
  buildings?: readonly BuildingFeature[]
}

/**
 * The height people walk at, at a point (metres above sea level): in town,
 * the top of the block fills and paved squares (see streetMesh); elsewhere
 * the land. Buildings stand on it (see buildingMesh).
 */
export function walkingLevel(ground: Ground): (lon: number, lat: number) => number {
  return ground.town ? (lon, lat) => ground.level(lon, lat) + KERB : (lon, lat) => ground.at(lon, lat)
}

/** The streets of a tile (zoom 14 map data): see StreetsBuilt. */
export function streetMesh(
  tile: TileId,
  roads: readonly RoadFeature[],
  ground: Ground,
  colours: StreetColours,
  /** An area to leave out (a site's own streets are there): longitudes and latitudes of its corners. */
  mask?: readonly { lon: number; lat: number }[],
  /** Squares, pedestrian areas and platforms (tile units): paved at sidewalk height, the streets' sidewalks running into them. */
  squares: readonly Shape[] = [],
  /** Green spaces (parks, grass, woods; tile units): block fills there are green. */
  greens: readonly Shape[] = [],
  options: StreetOptions = {},
): StreetsBuilt {
  const __t: Record<string, number> = ((globalThis as Record<string, unknown>).__T as Record<string, number>) ?? {}
  let __l = performance.now()
  const __m = (k: string) => { const n = performance.now(); __t[k] = (__t[k] ?? 0) + Math.round(n - __l); __l = n }
  const metres = tileWidth(tile)
  // Plan metres: x east, y north (tile units run south), as the editor's sites.
  const toPlan = (u: number, v: number): Vec2 => ({ x: u * metres, y: -v * metres })
  const lines: StreetLine[] = []
  // Where streets go on as bridges or tunnels (drawn apart): their ends there stay apart, flat.
  const apart = new Set<string>()
  const placeKey = (p: Vec2) => `${Math.round(p.x * 100)}:${Math.round(p.y * 100)}`
  for (const road of roads) {
    if (!road.tunnel && !road.bridge) continue
    const line = road.line
    const last = line.length - 2
    for (const i of [0, last]) apart.add(placeKey(toPlan(line[i]!, line[i + 1]!)))
  }
  // Footways on the level: where a city maps its sidewalks as ways of their own, they show where they are.
  const footways: Vec2[][] = []
  for (const road of roads) {
    if (road.kind !== 'path' || road.tunnel || road.bridge || (road.subclass !== 'footway' && road.subclass !== 'path')) continue
    const points: Vec2[] = []
    for (let i = 0; i + 1 < road.line.length; i += 2) points.push(toPlan(road.line[i]!, road.line[i + 1]!))
    footways.push(points)
  }
  for (const road of roads) {
    if (road.tunnel || road.bridge) continue
    const props = propsOf(road, ground.town)
    if (!props) continue
    const line = simplify(road.line, 0.4 / metres)
    const points: Vec2[] = []
    for (let i = 0; i + 1 < line.length; i += 2) points.push(toPlan(line[i]!, line[i + 1]!))
    // A roundabout's ring: the tiles drop junction=roundabout and the one-way, single-lane running it implies.
    if (looksLikeRoundabout(points)) lines.push({ points, props: { ...props, oneway: true, lanes: 1, laneWidth: Math.max(props.laneWidth, 4) } })
    else lines.push({ points, props })
  }
  if (lines.length === 0 && squares.length === 0) return { mesh: null, cover: [], greenFills: [], paved: [] }
  // One junction per crossing, no stray stubs, no sidewalks down the middle of a divided road; ends at the
  // data's edge (beyond the tile) are where it was cut, not dead ends.
  const network = tidyNetwork(lines, {
    keepEnd: (p) => p.x < 1 || p.x > metres - 1 || p.y > -1 || p.y < -metres + 1,
    apart: (p) => apart.has(placeKey(p)),
    footways,
  })
  __m('network')
  const geometry = streetGeometry({ streetNodes: network.nodes, streets: network.streets } as unknown as Snapshot)
  __m('geometry')

  const writer = new StreetWriter(tile, metres, ground)
  // The roads' own heights: each street level across at its bed's height, however wide it was built (the
  // ground's beds are only as wide as each road's class says), blended where streets meet.
  const beds = new LineField(BED_REACH)
  for (const street of Object.values(network.streets)) {
    const a = network.nodes[street.a]
    const b = network.nodes[street.b]
    if (!a || !b) continue
    const length = Math.hypot(b.x - a.x, b.y - a.y)
    if (length < 1e-6) continue
    const section = crossSection(street)
    beds.add({
      ax: a.x,
      ay: a.y,
      bx: b.x,
      by: b.y,
      half: Math.max(section.roadLeft, section.roadRight),
      height: stations(length, 4, (along) => writer.bed(a.x + ((b.x - a.x) * along) / length, a.y + ((b.y - a.y) * along) / length)),
    })
  }
  const roadHeight: HeightOn = (x, y) => beds.at(x, y, writer.bed)
  const roadLaid = new Laid()
  const roadLaying: Laying = { ...ROAD_LAYING, height: roadHeight, record: roadLaid }
  // Paint lies on the road as laid, split often enough to follow it.
  const paintLaying: Laying = { tolerance: Infinity, most: 6, least: 6, height: (x, y) => roadLaid.at(x, y) ?? roadHeight(x, y) }

  // Shapes of the map data (tile units) on the plan.
  const ring = (line: Float64Array): [number, number][] => {
    const points: [number, number][] = []
    for (let i = 0; i + 1 < line.length; i += 2) points.push([line[i]! * metres, -line[i + 1]! * metres])
    return points
  }
  const shapes = (list: readonly Shape[]): MultiPolygon => list.map((shape) => [ring(shape.outer), ...shape.holes.map(ring)])

  // The plan. Everything at road level is one surface: where map data runs ways side by side or brings many
  // together, their roads are merged, the slivers between them closed and the corners rounded to a kerb's
  // radius. Living streets, pedestrian zones and squares are paved level with the blocks, and roads cut
  // through them.
  const roadPieces: MultiPolygon = []
  const pavedPieces: MultiPolygon = shapes(squares)
  const bikePieces: MultiPolygon = []
  const parkingPieces: MultiPolygon = []
  const walkPieces: MultiPolygon = []
  for (const piece of geometry.pieces) {
    if (piece.shared) pavedPieces.push(...piece.road)
    else roadPieces.push(...piece.road, ...piece.bike, ...piece.parking)
    bikePieces.push(...piece.bike)
    parkingPieces.push(...piece.parking)
    walkPieces.push(...piece.sidewalks)
  }
  // The tile itself, and the area left out: everything is cut to them.
  const whole = rectangle(0, -metres, metres, 0)
  const n = 2 ** tile.z
  const hole: Region = mask
    ? regionOf([
        [
          mask.map(({ lon, lat }) => {
            const φ = (lat * Math.PI) / 180
            const u = ((lon + 180) / 360) * n - tile.x
            const v = ((1 - Math.log(Math.tan(φ) + 1 / Math.cos(φ)) / Math.PI) / 2) * n - tile.y
            return [u * metres, -v * metres] as [number, number]
          }),
        ],
      ])
    : []
  const cut = (region: Region): Region => without(common(region, whole), hole)

  const road = cut(withoutIslands(rounded(merged(regionOf(roadPieces)), ROUND, THIN), ISLAND))
  const paving = without(cut(rounded(merged(regionOf(pavedPieces)), 1, 0)), road)
  __m('roadplan')

  // The blocks between the streets, raised to kerb height: one plane from the kerbs to the buildings (the
  // plan's complement), green where the map has parks and greenery. So the terrain is ours wherever the
  // city is. Open country within town (a big park, the lakefront) gets no fill, but the streets along it
  // keep their pavements: the sidewalk strips of the plan, raised like the fills.
  let land: Region = []
  let green: Region = []
  let footprints: Region = []
  if (ground.town && colours.land) {
    const water = regionOf(shapes(ground.water))
    footprints = merged(regionOf(shapes((options.buildings ?? []).filter((b) => b.minHeight === 0).map((b) => b.shape))))
    const blocks = polygonsOf(without(without(whole, hole), road, paving, water))
    const filled: MultiPolygon = []
    const open: MultiPolygon = []
    for (const block of blocks) {
      const area = blockArea(block)
      if (area < 4) continue
      // A big block counts as built up by how much of it buildings stand on.
      if (area < OPEN_BLOCK || areaOf(common(regionOf([block]), footprints)) / area >= BUILT) filled.push(block)
      else open.push(block)
    }
    const pavements = open.length > 0 ? common(regionOf(open), merged(regionOf(walkPieces))) : []
    const raised = pavements.length > 0 ? merged(regionOf(filled), pavements) : regionOf(filled)
    const greenery = merged(regionOf(shapes(greens)))
    green = common(raised, greenery)
    land = without(raised, greenery)
  }
  __m('blocks')

  const cover: MultiPolygon = []
  const greenFills: MultiPolygon = []
  const paved: MultiPolygon = []
  /** A surface laid: its top, or `tops` if what's drawn of it differs from what it covers. */
  const lay = (region: Region, lift: number, colour: readonly number[], kind: 'paved' | 'green', laying: Laying, tops?: Region) => {
    if (region.length === 0) return
    const polygons = polygonsOf(region)
    cover.push(...polygons)
    ;(kind === 'green' ? greenFills : paved).push(...polygons)
    __m('lay-cut')
    const __p = tops ? polygonsOf(tops) : polygons
    __m('lay-holes')
    const __n = writer.count()
    writer.top(__p, lift, colour, laying)
    __m('lay-top')
    __t['tris@' + lift + '/' + kind + (tops ? 'h' : '')] = (writer.count() - __n) / 3
  }
  // The road, with its parking strips and bike lanes laid into it as parts of the one surface (not on top:
  // two surfaces a hair apart show through each other).
  const parking = common(merged(regionOf(parkingPieces)), road)
  const bikes = common(merged(regionOf(bikePieces)), road)
  lay(road, ROAD, colours.road, 'paved', roadLaying, without(road, parking, bikes))
  writer.top(polygonsOf(without(parking, bikes)), ROAD, colours.parking, roadLaying)
  writer.top(polygonsOf(bikes), ROAD, colours.bike, roadLaying)
  lay(paving, KERB, colours.sidewalk, 'paved', FILL_LAYING)
  // The blocks' surface is cut round the buildings standing on it, so it meets each wall at its base.
  lay(land, KERB, colours.land ?? colours.sidewalk, 'paved', FILL_LAYING, without(land, footprints))
  lay(green, KERB, colours.green ?? colours.land ?? colours.sidewalk, 'green', FILL_LAYING, without(green, footprints))
  __m('tops')
  // Sides: every raised surface is a solid (its kerb faces, and its banks where the land drops away), and so
  // is the plan as a whole, down into the ground. Not along the tile's own edges, where the next tile goes on.
  const onEdge = (x: number, y: number) => x < 1e-3 || x > metres - 1e-3 || y > -1e-3 || y < -metres + 1e-3
  const seam = (ax: number, ay: number, bx: number, by: number) => onEdge(ax, ay) && onEdge(bx, by) && (Math.abs(ax - bx) < 1e-3 || Math.abs(ay - by) < 1e-3)
  const raisedLand = merged(land, green, paving)
  writer.sides(polygonsOf(raisedLand), KERB, colours.curb, seam)
  writer.sides(polygonsOf(merged(road, raisedLand)), ROAD, colours.curb, seam, roadHeight)
  // The road's own edge, where it stands clear of what's beside it (a block lower than the road, or none).
  writer.sides(polygonsOf(road), ROAD, colours.curb, (ax, ay, bx, by) => seam(ax, ay, bx, by) || (roadHeight(ax, ay) + ROAD < writer.bed(ax, ay) + KERB - 0.02 && roadHeight(bx, by) + ROAD < writer.bed(bx, by) + KERB - 0.02), roadHeight)
  __m('sides')

  // Lines and zebras on top.
  const rect = { minX: 0, maxX: metres, minY: -metres, maxY: 0 }
  const holeRing = mask ? polygonsOf(hole)[0]?.[0] : undefined
  for (const piece of geometry.pieces) {
    for (const mark of [...piece.markings, ...piece.crosswalks]) {
      // A line can run the length of a long street: cut like the surfaces, not judged by its middle.
      const clipped = clipRingPlan(mark.map((p) => [p.x, p.y] as [number, number]), rect)
      if (!clipped) continue
      if (holeRing && clipped.some(([x, y]) => insidePolygon([holeRing], x, y))) continue
      writer.top([[clipped]], PAINT, colours.marking, paintLaying)
    }
  }
  __m('lanes+marks')
  const __mesh = writer.finish()
  __m('finish')
  return { mesh: __mesh, cover, greenFills, paved }
}

/** A region without its holes smaller than an area (square metres): an island too small to stand on is road. */
function withoutIslands(region: Region, least: number): Region {
  return region.filter((path) => {
    const area = areaOf([path])
    return area > 0 || -area >= least
  })
}

/** A polygon's area: its outline's less its holes'. */
function blockArea(polygon: MultiPolygon[number]): number {
  let total = 0
  polygon.forEach((ring, r) => {
    let sum = 0
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) sum += ring[j]![0] * ring[i]![1] - ring[i]![0] * ring[j]![1]
    total += (r === 0 ? 1 : -1) * Math.abs(sum / 2)
  })
  return total
}

/** Whether a point lies in a polygon (in its outline, in none of its holes). */
function insidePolygon(polygon: MultiPolygon[number], x: number, y: number): boolean {
  const inRing = (ring: [number, number][]) => {
    let hit = false
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i]!
      const [xj, yj] = ring[j]!
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit
    }
    return hit
  }
  return polygon.length > 0 && inRing(polygon[0]!) && !polygon.slice(1).some(inRing)
}

const UP = [0, 1, 0] as const

/** A height (metres above sea level) at a point of the plan. */
type HeightOn = (x: number, y: number) => number

/** How a surface is laid: how closely it follows its heights, and which heights. */
interface Laying {
  /** A surface may lie this far (metres) off its heights between its points. */
  tolerance: number
  /** And no edge of it is longer than this (metres), nor split when shorter than `least`. */
  most: number
  least: number
  /** Its heights (before the lift); the street bed by default. */
  height?: HeightOn
  /** Keeps the surface as laid (see Laid), for what is to lie exactly on it. */
  record?: Laid
}

/**
 * A surface as it was laid: its triangles, to ask the height of the surface itself at a point (flat between
 * its points, not the heights it follows). Paint on a road takes its heights from here, so it lies on the road
 * as drawn and never dips under it.
 */
class Laid {
  private readonly triangles: number[] = []
  private readonly cells = new Map<number, number[]>()
  private static readonly CELL = 8

  add(ax: number, ay: number, ah: number, bx: number, by: number, bh: number, cx: number, cy: number, ch: number): void {
    const index = this.triangles.length
    this.triangles.push(ax, ay, ah, bx, by, bh, cx, cy, ch)
    const size = Laid.CELL
    const x0 = Math.floor(Math.min(ax, bx, cx) / size)
    const x1 = Math.floor(Math.max(ax, bx, cx) / size)
    const y0 = Math.floor(Math.min(ay, by, cy) / size)
    const y1 = Math.floor(Math.max(ay, by, cy) / size)
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const key = (y + 65536) * 131072 + x + 65536
        const list = this.cells.get(key)
        if (list) list.push(index)
        else this.cells.set(key, [index])
      }
    }
  }

  /** The surface's height at a point, or null where it isn't. */
  at(x: number, y: number): number | null {
    const list = this.cells.get((Math.floor(y / Laid.CELL) + 65536) * 131072 + Math.floor(x / Laid.CELL) + 65536)
    if (!list) return null
    const t = this.triangles
    for (const i of list) {
      const ax = t[i]!
      const ay = t[i + 1]!
      const ux = t[i + 3]! - ax
      const uy = t[i + 4]! - ay
      const vx = t[i + 6]! - ax
      const vy = t[i + 7]! - ay
      const den = ux * vy - uy * vx
      if (den === 0) continue
      const px = x - ax
      const py = y - ay
      const p = (px * vy - py * vx) / den
      const q = (ux * py - uy * px) / den
      if (p < -1e-6 || q < -1e-6 || p + q > 1 + 1e-6) continue
      return t[i + 2]! + (t[i + 5]! - t[i + 2]!) * p + (t[i + 8]! - t[i + 2]!) * q
    }
    return null
  }
}

/** Roads follow their bed closely (paint lies centimetres above them); the blocks' fills needn't. */
const ROAD_LAYING: Laying = { tolerance: 0.06, most: 48, least: 6 }
const FILL_LAYING: Laying = { tolerance: 0.12, most: 48, least: 8 }

/** Whole centimetres of the plan as one number, for looking points up. */
const placeOf = (x: number, y: number) => (Math.round(x * 100) + 1048576) * 2097152 + Math.round(y * 100) + 1048576

class StreetWriter {
  private positions: number[] = []
  private normals: number[] = []
  private colors: number[] = []
  private indices: number[] = []
  private readonly frame: Frame
  private readonly tile: TileId
  private readonly metres: number
  /** The street bed's height at a point of the plan. */
  readonly bed: HeightOn
  /** Heights already asked for, per way of asking. */
  private readonly known = new Map<HeightOn, Map<number, number>>()
  /** Top vertices by place, per lift, colour and heights: shared between the triangles that meet there. */
  private readonly tops = new Map<string, Map<number, number>>()

  constructor(tile: TileId, metres: number, ground: Ground) {
    this.tile = tile
    this.metres = metres
    this.frame = tileFrame(tile)
    const n = 2 ** tile.z
    this.bed = (x, y) => ground.level(((tile.x + x / metres) / n) * 360 - 180, tileLat(tile.y - y / metres, tile.z))
  }

  /** A height at a point, remembered: shared corners are asked for again and again. */
  private heightAt(height: HeightOn, x: number, y: number): number {
    let known = this.known.get(height)
    if (!known) this.known.set(height, (known = new Map()))
    const key = placeOf(x, y)
    let h = known.get(key)
    if (h === undefined) {
      h = height(x, y)
      known.set(key, h)
    }
    return h
  }

  /** A point of the plan at a height, in the tile's frame. */
  private vertex(x: number, y: number, height: number, normal: readonly number[], colour: readonly number[]): number {
    const n = 2 ** this.tile.z
    const lon = ((this.tile.x + x / this.metres) / n) * 360 - 180
    const lat = tileLat(this.tile.y - y / this.metres, this.tile.z)
    const p = ecefFromLonLat(lon, lat, height)
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

  /**
   * A surface at a lift over its heights: its top (or, facing `down`, its underside), split where it would
   * otherwise leave its heights by more than its laying allows. An edge is split or not whichever triangle it
   * is seen from, so neighbours stay joined.
   */
  top(region: MultiPolygon, lift: number, colour: readonly number[], laying: Laying = ROAD_LAYING, down = false): void {
    const height = laying.height ?? this.bed
    const key = `${lift}:${colour.join(',')}:${down ? 'd' : 'u'}`
    let shared = this.tops.get(key)
    if (!shared) this.tops.set(key, (shared = new Map()))
    // Separate surfaces at one lift and colour but different heights (two decks) never share a place: one map does.
    const normal = down ? [0, -1, 0] : UP
    const corner = (x: number, y: number): number => {
      const place = placeOf(x, y)
      let index = shared.get(place)
      if (index === undefined) {
        index = this.vertex(x, y, this.heightAt(height, x, y) + lift, normal, colour)
        shared.set(place, index)
      }
      return index
    }
    /** How much an edge wants splitting: its length if it leaves the heights (or is too long), else 0. */
    const wants = (ax: number, ay: number, bx: number, by: number): number => {
      const length = Math.hypot(bx - ax, by - ay)
      if (length > laying.most) return length
      if (length < laying.least) return 0
      const off = Math.abs(this.heightAt(height, (ax + bx) / 2, (ay + by) / 2) - (this.heightAt(height, ax, ay) + this.heightAt(height, bx, by)) / 2)
      return off > laying.tolerance ? length : 0
    }
    const triangle = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number, depth: number): void => {
      if (depth < 14) {
        const ab = wants(ax, ay, bx, by)
        const bc = wants(bx, by, cx, cy)
        const ca = wants(cx, cy, ax, ay)
        const most = Math.max(ab, bc, ca)
        if (most > 0) {
          if (most === ab) {
            const mx = (ax + bx) / 2
            const my = (ay + by) / 2
            triangle(ax, ay, mx, my, cx, cy, depth + 1)
            triangle(mx, my, bx, by, cx, cy, depth + 1)
          } else if (most === bc) {
            const mx = (bx + cx) / 2
            const my = (by + cy) / 2
            triangle(ax, ay, bx, by, mx, my, depth + 1)
            triangle(ax, ay, mx, my, cx, cy, depth + 1)
          } else {
            const mx = (cx + ax) / 2
            const my = (cy + ay) / 2
            triangle(ax, ay, bx, by, mx, my, depth + 1)
            triangle(mx, my, bx, by, cx, cy, depth + 1)
          }
          return
        }
      }
      const i = corner(ax, ay)
      const j = corner(bx, by)
      const k = corner(cx, cy)
      laying.record?.add(ax, ay, this.heightAt(height, ax, ay), bx, by, this.heightAt(height, bx, by), cx, cy, this.heightAt(height, cx, cy))
      // Facing up: anticlockwise on the plan (x east, y north).
      const ccw = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax) > 0
      if (ccw !== down) this.indices.push(i, j, k)
      else this.indices.push(i, k, j)
    }
    for (const polygon of region) {
      const __t0 = performance.now()
      const { points, triangles } = triangulate(polygon)
      const __tt = ((globalThis as Record<string, unknown>).__T as Record<string, number>) ?? {}
      __tt.triangulate = (__tt.triangulate ?? 0) + performance.now() - __t0
      __tt.polygons = (__tt.polygons ?? 0) + 1
      __tt.cdtTris = (__tt.cdtTris ?? 0) + triangles.length / 3
      for (let t = 0; t < triangles.length; t += 3) {
        const a = triangles[t]! * 2
        const b = triangles[t + 1]! * 2
        const c = triangles[t + 2]! * 2
        triangle(points[a]!, points[a + 1]!, points[b]!, points[b + 1]!, points[c]!, points[c + 1]!, 0)
      }
    }
  }

  /**
   * A surface's sides, along every edge of the region but those `skip` says to leave out: from its top (a
   * lift over `height`, the bed by default) down to `foot` (four metres into the ground by default; no
   * bottom: nobody sees it).
   */
  sides(
    region: MultiPolygon,
    lift: number,
    side: readonly number[],
    skip?: (ax: number, ay: number, bx: number, by: number) => boolean,
    height: HeightOn = this.bed,
    foot?: HeightOn,
  ): void {
    for (const polygon of region) {
      for (const [r, ring] of polygon.entries()) {
        const open = orient(openRing(ring), r === 0)
        for (let i = 0; i < open.length; i++) {
          const p = open[i]!
          const q = open[(i + 1) % open.length]!
          const length = Math.hypot(q[0] - p[0], q[1] - p[1])
          if (length < 1e-6 || skip?.(p[0], p[1], q[0], q[1])) continue
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
            const top0 = this.heightAt(height, x0, y0) + lift
            const top1 = this.heightAt(height, x1, y1) + lift
            const a = this.vertex(x0, y0, foot ? this.heightAt(foot, x0, y0) : this.heightAt(this.bed, x0, y0) - DEPTH, normal, side)
            const b = this.vertex(x1, y1, foot ? this.heightAt(foot, x1, y1) : this.heightAt(this.bed, x1, y1) - DEPTH, normal, side)
            const c = this.vertex(x1, y1, top1, normal, side)
            const d = this.vertex(x0, y0, top0, normal, side)
            this.indices.push(a, b, c, a, c, d)
          }
        }
      }
    }
  }

  /** A box standing on the plan (a pier): its four walls, from `foot` up to `head` (metres above sea level). */
  box(corners: readonly [number, number][], foot: number, head: number, colour: readonly number[]): void {
    const ring = orient([...corners], true)
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i]!
      const q = ring[(i + 1) % ring.length]!
      const length = Math.hypot(q[0] - p[0], q[1] - p[1])
      if (length < 1e-6) continue
      const normal = [(q[1] - p[1]) / length, 0, (q[0] - p[0]) / length]
      const a = this.vertex(p[0], p[1], foot, normal, colour)
      const b = this.vertex(q[0], q[1], foot, normal, colour)
      const c = this.vertex(q[0], q[1], head, normal, colour)
      const d = this.vertex(p[0], p[1], head, normal, colour)
      this.indices.push(a, b, c, a, c, d)
    }
  }

  count(): number {
    return this.indices.length
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
