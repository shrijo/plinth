import earcut from 'earcut'
import {
  CURB_HEIGHT,
  difference,
  intersection,
  labelPoint,
  layerStreetPieces,
  layerStreetSurfaces,
  regionArea,
  streetGeometry,
  type MultiPolygon,
  type Snapshot,
  type StreetPiece,
  type Vec2,
} from '@plinth/core'
import { DECK, decksOf, withBridges, withOtherBridges, type Deck, type OtherBridge } from './bridges.ts'
import { insideRing } from './clip.ts'
import type { RoadFeature, RoadKind, Shape } from './features.ts'
import type { Ground } from './ground.ts'
import { ecefFromLonLat, type Frame } from './geo.ts'
import { tileFrame, tileWidth, type MeshBuffers } from './mesh.ts'
import { looksLikeRoundabout, tidyNetwork, type StreetLine } from './network.ts'
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
  /** Block fills: the land between the streets, and its green spaces. */
  land?: [number, number, number]
  green?: [number, number, number]
}

/** How far each street's solid reaches below its surface (metres). */
const DEPTH = 4
/** Road surfaces (bike and parking lanes too) lie this far above the street bed; paint a little higher. */
const ROAD = 0.06
const PAINT = 0.075
/** The walking plane: block fills and paved squares stand at kerb height over the bed, and follow it this finely (metres). */
const KERB = ROAD + CURB_HEIGHT
const FILL_STEP = 11
/** Surfaces are split to this length (metres) and sides to this, so they follow the bed (smooth over 18 m). */
const STEP = 14
const SIDE_STEP = 24
/** A deck's surfaces and sides are split finer: it rises and falls along a bridge. */
const DECK_STEP = 4
const DECK_SIDE_STEP = 3
/** A bridge's parapets stand this high over its surface and are this thick (metres), where the deck stands this far over what's beneath. */
const PARAPET = 1
const PARAPET_THICKNESS = 0.3
const PARAPET_FROM = 0.7
/** Where another deck lies this far beyond a deck's edge (metres), they're one bridge: no parapet between them. */
const PARAPET_GAP = [0.5, 1.5, 3, 4.5]

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

/** Whether a bridge carries a street the streets' mesh builds: the bridge is built as that street, lifted. */
export function carriesStreet(road: RoadFeature): boolean {
  return road.bridge && !road.tunnel && propsOf(road, false) !== null
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
): StreetsBuilt {
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
  // Street bridges: the streets they carry, lifted (see bridges.ts). Other bridges (railways, footways) stand
  // with the buildings (see buildingMesh).
  const bridgeLines: StreetLine[] = []
  for (const road of roads) {
    if (!road.bridge || road.tunnel) continue
    const props = propsOf(road, ground.town)
    if (!props) continue
    const line = simplify(road.line, 0.4 / metres)
    const points: Vec2[] = []
    for (let i = 0; i + 1 < line.length; i += 2) points.push(toPlan(line[i]!, line[i + 1]!))
    if (points.length >= 2) bridgeLines.push({ points, props })
  }
  // And the other bridges (footways, paths, railways and tram lines): alongside a street's deck, part of its
  // bridge; on their own, spans of their own (see withOtherBridges).
  const otherBridges: OtherBridge[] = []
  for (const road of roads) {
    if (!road.bridge || road.tunnel || road.kind === 'pier' || carriesStreet(road)) continue
    const line = simplify(road.line, 0.4 / metres)
    const points: Vec2[] = []
    for (let i = 0; i + 1 < line.length; i += 2) points.push(toPlan(line[i]!, line[i + 1]!))
    if (points.length < 2) continue
    const walk = road.kind === 'path' || road.kind === 'track'
    const width = road.kind === 'rail' ? (road.subclass === 'tram' ? 3.5 : 5) : Math.max(road.width, walk ? 2 : 3)
    otherBridges.push({ points, width, walk })
  }
  if (lines.length === 0 && squares.length === 0 && bridgeLines.length === 0 && otherBridges.length === 0) return { mesh: null, cover: [], greenFills: [], paved: [] }
  // Ends at the data's edge (beyond the tile) are where it was cut, not dead ends.
  const atEdge = (p: Vec2) => p.x < 1 || p.x > metres - 1 || p.y > -1 || p.y < -metres + 1
  // One junction per crossing, no stray stubs, no sidewalks down the middle of a divided road.
  const onGround = tidyNetwork(lines, {
    keepEnd: atEdge,
    apart: (p) => apart.has(placeKey(p)),
    footways,
  })
  // The bridges tidied the same way among themselves (a way ending on another joins it, as on the ground),
  // their landings held where the streets on the ground stop for them; then landing there.
  const landings = new Set(Object.values(onGround.nodes).map(placeKey))
  const lands = (p: Vec2) => landings.has(placeKey(p))
  // (A bridge doesn't end in mid-air: a loose end reaches further for the deck it branches from.)
  const network = withBridges(onGround, tidyNetwork(bridgeLines, { keepEnd: (p) => atEdge(p) || lands(p), apart: lands, snap: 12 }), atEdge)
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
  // Whether a polygon's bounds overlap the area's (a long street can cross it with no corner near it).
  const near = (polygon: MultiPolygon[number]) => {
    if (!holeBox) return false
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity]
    for (const [x, y] of polygon[0]!) {
      x0 = Math.min(x0, x)
      x1 = Math.max(x1, x)
      y0 = Math.min(y0, y)
      y1 = Math.max(y1, y)
    }
    return x1 > holeBox.minX && x0 < holeBox.maxX && y1 > holeBox.minY && y0 < holeBox.maxY
  }
  // Cut to the tile, and the area left out: a polygon at a time, so overlapping ones aren't merged into a few
  // huge shapes (which triangulate into long slivers).
  const cut = (region: MultiPolygon): MultiPolygon =>
    clip(region, rect).flatMap((polygon) => (hole && near(polygon) ? difference([polygon], [[hole]]) : [polygon]))
  const writer = new StreetWriter(tile, metres, ground)
  // The surfaces layered (see layerStreetSurfaces): a sidewalk never lies on a road, nor a parking lane on
  // another street's road. Every surface is a solid: nothing may show under its edges.
  const ring = (line: Float64Array): [number, number][] => {
    const points: [number, number][] = []
    for (let i = 0; i + 1 < line.length; i += 2) {
      const p = toPlan(line[i]!, line[i + 1]!)
      points.push([p.x, p.y])
    }
    return points
  }
  // Squares are paved surfaces of their own (the shared layer): roads through them cut them.
  const paving: StreetPiece[] = squares.map((shape, i) => {
    const outer = ring(shape.outer)
    return {
      key: `square:${i}`,
      road: [[outer, ...shape.holes.map(ring)]],
      bike: [],
      parking: [],
      sidewalks: [],
      markings: [],
      crosswalks: [],
      centre: { x: outer[0]?.[0] ?? 0, y: outer[0]?.[1] ?? 0 },
      shared: true,
    }
  })
  // What's on the ground and what's on a bridge's deck are layered apart: a street under a bridge isn't cut
  // away by the deck over it.
  const surfaces = layerStreetSurfaces([...geometry.pieces.filter((p) => !p.bridge), ...paving])
  const onDecks = withOtherBridges(layerStreetPieces(geometry.pieces.filter((p) => p.bridge)), otherBridges)
  const cover: MultiPolygon = []
  const greenFills: MultiPolygon = []
  const paved: MultiPolygon = []
  const laid = (region: MultiPolygon): MultiPolygon => {
    const own = cut(region)
    cover.push(...own)
    paved.push(...own)
    return own
  }
  // The decks: each from the street's level where it lands, clear of what it crosses between.
  const onStreet = regionIndex([surfaces.road, surfaces.bike, surfaces.parking, surfaces.paved])
  const onDeck = regionIndex(onDecks.map((p) => [...p.road, ...p.bike, ...p.parking]))
  const decks = decksOf(
    onDecks,
    network,
    {
      bed: (x, y) => writer.bed(x, y),
      land: (x, y) => {
        const { lon, lat } = writer.lonLat(x, y)
        return ground.at(lon, lat)
      },
      water: (x, y) => {
        const { lon, lat } = writer.lonLat(x, y)
        return ground.waterAt(lon, lat)
      },
    },
    (x, y) => (onStreet(x, y) ? 'ground' : onDeck(x, y) ? 'deck' : null),
  )
  // Where a deck lies on the ground (as it lands), the ground leaves itself out, and the block fills leave its
  // road free (its pavement is level with theirs: they run on into it).
  const lying: MultiPolygon = []
  for (const [piece, deck] of decks) {
    const low = cut(deck.low)
    if (low.length === 0) continue
    cover.push(...low)
    paved.push(...low)
    lying.push(...(piece.shared ? low : intersection(low, [...piece.road, ...piece.bike, ...piece.parking])))
  }
  // Bike and parking lanes are the road's own asphalt, level with it (their lines tell them apart), so a
  // street runs on into its junctions as one surface.
  writer.slab(laid(surfaces.road), ROAD, colours.road, colours.curb)
  writer.slab(laid(surfaces.bike), ROAD, colours.bike, colours.curb)
  writer.slab(laid(surfaces.parking), ROAD, colours.parking, colours.curb)
  // Living streets, pedestrian zones and squares are paved level with the blocks: one walking plane.
  writer.slab(laid(surfaces.paved), KERB, colours.sidewalk, colours.curb)
  // There are no sidewalk strips of their own: in town the raised fills are the pavement (below), and the
  // sidewalk widths say how far the kerb stands from the carriageway.
  // The blocks between the streets, raised to kerb height: one plane from the kerbs to the buildings,
  // wrapping the kerbs' arcs at junctions (the fill is the road plan's complement), green where the map has
  // parks and greenery. So the terrain is ours wherever the city is.
  if (ground.town && colours.land) {
    const bounded: { polygon: MultiPolygon[number]; box: PlanRect }[] = []
    for (const region of [surfaces.road, surfaces.bike, surfaces.parking, surfaces.paved, lying]) {
      for (const polygon of region) bounded.push({ polygon, box: boundsOfRing(polygon[0]!) })
    }
    const waterPlan: MultiPolygon = ground.water.map((shape) => {
      const rings = [shape.outer, ...shape.holes].map((line) => {
        const points: [number, number][] = []
        for (let i = 0; i + 1 < line.length; i += 2) {
          const p = toPlan(line[i]!, line[i + 1]!)
          points.push([p.x, p.y])
        }
        return points
      })
      return rings
    })
    const waterBoxes = waterPlan.map((polygon) => boundsOfRing(polygon[0]!))
    const greenAt = (x: number, y: number): boolean => {
      const u = x / metres
      const v = -y / metres
      return greens.some((shape) => insideShape(shape, u, v))
    }
    const CELL = 300
    const cellsAcross = Math.max(1, Math.round(metres / CELL))
    const size = metres / cellsAcross
    for (let j = 0; j < cellsAcross; j++) {
      for (let i = 0; i < cellsAcross; i++) {
        const box: PlanRect = { minX: i * size, maxX: (i + 1) * size, minY: -(j + 1) * size, maxY: -j * size }
        const overlaps = (b: PlanRect) => b.maxX > box.minX && b.minX < box.maxX && b.maxY > box.minY && b.minY < box.maxY
        const near = bounded.filter((c) => overlaps(c.box)).map((c) => [c.polygon] as MultiPolygon)
        if (near.length === 0) continue
        const water = waterPlan.filter((_, k) => overlaps(waterBoxes[k]!)).map((polygon) => [polygon] as MultiPolygon)
        const cell: MultiPolygon = [[[[box.minX, box.minY], [box.maxX, box.minY], [box.maxX, box.maxY], [box.minX, box.maxY]]]]
        for (const face of difference(cell, ...near, ...water)) {
          const area = regionArea([face])
          if (area < 4) continue
          if (area > 60000) {
            // Open country within town (a big park, the lakefront): no block fill, but the streets along it
            // keep their pavements — the sidewalk strips of the plan, raised like the fills.
            for (const strip of intersection([face], surfaces.sidewalks)) {
              if (regionArea([strip]) < 2) continue
              const at = labelPoint([strip])
              if (!at) continue
              const kept = cut([strip])
              if (kept.length === 0) continue
              cover.push(...kept)
              const green = greenAt(at.x, at.y)
              ;(green ? greenFills : paved).push(...kept)
              writer.slab(kept, KERB, green ? (colours.green ?? colours.land) : colours.land, colours.curb, FILL_STEP)
            }
            continue
          }
          const at = labelPoint([face])
          if (!at) continue
          const fill = cut([face])
          if (fill.length === 0) continue
          cover.push(...fill)
          const green = greenAt(at.x, at.y)
          ;(green ? greenFills : paved).push(...fill)
          writer.slab(fill, KERB, green ? (colours.green ?? colours.land) : colours.land, colours.curb, FILL_STEP)
        }
      }
    }
  }
  // The bridges: the street's own surfaces on the deck (its sidewalks the town's pavement, as the block
  // fills they run on from), the deck's fascia and parapets (see sides), and its underside.
  const walk = ground.town && colours.land ? colours.land : colours.sidewalk
  for (const piece of onDecks) {
    const deck = decks.get(piece)
    if (!deck) continue
    writer.slab(cut(piece.shared ? [] : piece.road), ROAD, colours.road, colours.curb, DECK_STEP, deck)
    writer.slab(cut(piece.bike), ROAD, colours.bike, colours.curb, DECK_STEP, deck)
    writer.slab(cut(piece.parking), ROAD, colours.parking, colours.curb, DECK_STEP, deck)
    if (piece.shared) writer.slab(cut(piece.road), KERB, colours.sidewalk, colours.curb, DECK_STEP, deck)
    writer.slab(cut(piece.sidewalks), KERB, walk, colours.curb, DECK_STEP, deck)
    writer.underside(cut([...piece.road, ...piece.bike, ...piece.parking, ...piece.sidewalks]), colours.curb, deck)
  }
  for (const piece of [...geometry.pieces.filter((p) => !p.bridge), ...onDecks]) {
    const deck = piece.bridge ? (decks.get(piece) ?? null) : null
    for (const mark of [...piece.markings, ...piece.crosswalks]) {
      // A line can run the length of a long street: cut like the surfaces, not judged by its middle.
      const region = cut([[mark.map((p) => [p.x, p.y] as [number, number])]])
      if (region.length > 0) writer.top(region, PAINT, colours.marking, deck ? DECK_STEP : STEP, deck)
    }
  }
  return { mesh: writer.finish(), cover, greenFills, paved }
}

/** Whether a plan point lies on any of some regions' polygons. */
function regionIndex(regions: readonly MultiPolygon[]): (x: number, y: number) => boolean {
  const polygons: { polygon: MultiPolygon[number]; box: PlanRect }[] = []
  const grid = new Map<number, number[]>()
  const key = (cx: number, cy: number) => (cy + 4096) * 8192 + (cx + 4096)
  for (const region of regions) {
    for (const polygon of region) {
      if (!polygon[0] || polygon[0].length < 3) continue
      const box = boundsOfRing(polygon[0])
      const k = polygons.push({ polygon, box }) - 1
      for (let cy = Math.floor(box.minY / COVER_CELL); cy <= Math.floor(box.maxY / COVER_CELL); cy++) {
        for (let cx = Math.floor(box.minX / COVER_CELL); cx <= Math.floor(box.maxX / COVER_CELL); cx++) {
          const list = grid.get(key(cx, cy))
          if (list) list.push(k)
          else grid.set(key(cx, cy), [k])
        }
      }
    }
  }
  return (x, y) =>
    (grid.get(key(Math.floor(x / COVER_CELL), Math.floor(y / COVER_CELL))) ?? []).some((k) => {
      const { polygon, box } = polygons[k]!
      return x >= box.minX && x <= box.maxX && y >= box.minY && y <= box.maxY && insidePlan(polygon[0]!, x, y) && !polygon.slice(1).some((h) => insidePlan(h, x, y))
    })
}

const UP = [0, 1, 0] as const
const DOWN = [0, -1, 0] as const

/** A solid whose sides are still to come (see StreetWriter.sides). */
interface Solid {
  region: MultiPolygon
  lift: number
  side: readonly number[]
  /** On a bridge's deck, or (null) on the street bed. */
  deck: Deck | null
}

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
  /** Surfaces drawn as solids, their sides still to come (see sides). */
  private readonly solids: Solid[] = []

  constructor(tile: TileId, metres: number, ground: Ground) {
    this.tile = tile
    this.metres = metres
    this.ground = ground
    this.frame = tileFrame(tile)
  }

  /** A plan point's longitude and latitude. */
  lonLat(x: number, y: number): { lon: number; lat: number } {
    const n = 2 ** this.tile.z
    const lon = ((this.tile.x + x / this.metres) / n) * 360 - 180
    const lat = tileLat(this.tile.y - y / this.metres, this.tile.z)
    return { lon, lat }
  }

  /** The street bed's height at a plan point. */
  bed(x: number, y: number): number {
    // Shared corners are asked for again and again.
    const key = `${Math.round(x * 100)}:${Math.round(y * 100)}`
    let bed = this.heights.get(key)
    if (bed === undefined) {
      const { lon, lat } = this.lonLat(x, y)
      bed = this.ground.level(lon, lat)
      this.heights.set(key, bed)
    }
    return bed
  }

  /** What a surface stands on at a plan point: the street bed, or a bridge's deck. */
  private base(x: number, y: number, deck: Deck | null): number {
    return deck ? deck.level(x, y) : this.bed(x, y)
  }

  /** A vertex at a plan point and a height (metres above sea level). */
  private vertex(x: number, y: number, height: number, normal: readonly number[], colour: readonly number[]): number {
    const { lon, lat } = this.lonLat(x, y)
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

  /** A surface at a height over the bed (or a deck): its top, split finely enough to follow it. */
  top(region: MultiPolygon, lift: number, colour: readonly number[], step = STEP, deck: Deck | null = null): void {
    this.faces(region, colour, step, (x, y) => this.base(x, y, deck) + lift, UP, `${lift}:${deck?.id ?? -1}`)
  }

  /** A deck's underside, facing down. */
  underside(region: MultiPolygon, colour: readonly number[], deck: Deck): void {
    this.faces(region, colour, DECK_STEP, (x, y) => deck.level(x, y) - DECK, DOWN, `under:${deck.id}`)
  }

  private faces(
    region: MultiPolygon,
    colour: readonly number[],
    step: number,
    height: (x: number, y: number) => number,
    normal: readonly number[],
    layer: string,
  ): void {
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
        this.triangle(p(0), p(1), p(2), colour, 0, step, height, normal, layer)
      }
    }
  }

  private triangle(
    a: [number, number],
    b: [number, number],
    c: [number, number],
    colour: readonly number[],
    depth: number,
    step: number,
    height: (x: number, y: number) => number,
    normal: readonly number[],
    layer: string,
  ): void {
    const ab = Math.hypot(a[0] - b[0], a[1] - b[1])
    const bc = Math.hypot(b[0] - c[0], b[1] - c[1])
    const ca = Math.hypot(c[0] - a[0], c[1] - a[1])
    const most = Math.max(ab, bc, ca)
    if (most > step && depth < 12) {
      const mid = (p: [number, number], q: [number, number]): [number, number] => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]
      const next = depth + 1
      if (most === ab) {
        const m = mid(a, b)
        this.triangle(a, m, c, colour, next, step, height, normal, layer)
        this.triangle(m, b, c, colour, next, step, height, normal, layer)
      } else if (most === bc) {
        const m = mid(b, c)
        this.triangle(a, b, m, colour, next, step, height, normal, layer)
        this.triangle(a, m, c, colour, next, step, height, normal, layer)
      } else {
        const m = mid(c, a)
        this.triangle(a, b, m, colour, next, step, height, normal, layer)
        this.triangle(m, b, c, colour, next, step, height, normal, layer)
      }
      return
    }
    const shared = (p: [number, number]) => {
      const key = `${Math.round(p[0] * 1000)}:${Math.round(p[1] * 1000)}:${layer}:${colour.join(',')}`
      let index = this.tops.get(key)
      if (index === undefined) {
        index = this.vertex(p[0], p[1], height(p[0], p[1]), normal, colour)
        this.tops.set(key, index)
      }
      return index
    }
    const i = shared(a)
    const j = shared(b)
    const k = shared(c)
    // Facing its way: anticlockwise on the plan (x east, y north) faces up.
    const ccw = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) > 0
    this.indices.push(...(ccw === normal[1]! > 0 ? [i, j, k] : [i, k, j]))
  }

  /**
   * A street surface as a solid: its top at a height over the bed (or a
   * deck), and its sides down into the ground, or a deck's fascia (no
   * bottom on the ground: nobody sees it). The sides are drawn last, once
   * every surface is known (see sides).
   */
  slab(region: MultiPolygon, lift: number, colour: readonly number[], side: readonly number[], step = STEP, deck: Deck | null = null): void {
    if (region.length === 0) return
    this.top(region, lift, colour, step, deck)
    this.solids.push({ region, lift, side, deck })
  }

  /**
   * The solids' sides: only where they show, an edge with nothing as high
   * beside it (a kerb, a road's edge on open ground, a deck's fascia).
   * Where a surface meets another at its level (a street running into its
   * junction, a bike lane beside the road, the block fills meeting across
   * their cells, a deck where it lands), the side would stand inside the
   * other, and where the two tops differ by a hair, show through it as a
   * dark seam: there's none.
   */
  private sides(): void {
    const tops = coverage(this.solids, (x, y, deck) => this.base(x, y, deck))
    for (const solid of this.solids) {
      for (const polygon of solid.region) {
        for (const [r, ring] of polygon.entries()) this.sidesOf(orient(openRing(ring), r === 0), solid, tops)
      }
    }
  }

  /** A ring's sides (outer rings anticlockwise, holes clockwise), from its top down into the ground (or the deck's foot). */
  private sidesOf(ring: Ring, { lift, side, deck }: Solid, tops: Coverage): void {
    const top = (x: number, y: number) => this.base(x, y, deck) + lift
    // Per stretch of an edge: drawn or not, and on a deck, whether it's the deck's edge (with a parapet).
    const stretches: { x0: number; y0: number; x1: number; y1: number; nx: number; ny: number; parapet: boolean }[] = []
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i]!
      const q = ring[(i + 1) % ring.length]!
      const length = Math.hypot(q[0] - p[0], q[1] - p[1])
      if (length < 1e-6) continue
      // Outwards: to the right of the edge.
      const nx = (q[1] - p[1]) / length
      const ny = -(q[0] - p[0]) / length
      const pieces = Math.max(1, Math.ceil(length / (deck ? DECK_SIDE_STEP : SIDE_STEP)))
      for (let k = 0; k < pieces; k++) {
        const x0 = p[0] + ((q[0] - p[0]) * k) / pieces
        const y0 = p[1] + ((q[1] - p[1]) * k) / pieces
        const x1 = p[0] + ((q[0] - p[0]) * (k + 1)) / pieces
        const y1 = p[1] + ((q[1] - p[1]) * (k + 1)) / pieces
        // Just outside the edge, along it: what stands there, against this surface's top.
        const at = length / pieces < 2 ? [0.5] : [0.15, 0.5, 0.85]
        const beside = at.map((t) => {
          const x = x0 + (x1 - x0) * t + nx * BESIDE
          const y = y0 + (y1 - y0) * t + ny * BESIDE
          return { own: top(x, y), there: tops(x, y), x, y }
        })
        // Another surface at its level all along (or a little above, as the block fills over a road): inside it.
        if (beside.every(({ own, there }) => there.some((o) => o.top >= own - LEVEL && o.top <= own + ADJACENT))) continue
        if (!deck) {
          stretches.push({ x0, y0, x1, y1, nx, ny, parapet: false })
          continue
        }
        // On a deck: a kerb to the deck's road beside it, or the deck's edge, with a parapet where it stands
        // over what's beneath (not where it lies level with the ground, as it lands).
        const kerb = beside.every(({ own, there }) => there.some((o) => o.deck && o.top < own && o.top > own - 1))
        const mid = beside[Math.floor(beside.length / 2)]!
        const { lon, lat } = this.lonLat(mid.x, mid.y)
        const under = Math.max(this.ground.waterAt(lon, lat) ?? -Infinity, this.ground.at(lon, lat), ...mid.there.map((o) => o.top))
        // Another deck of the same bridge just beyond (its carriageways mapped apart): no parapet between them.
        const alongside = PARAPET_GAP.some((d) => tops(mid.x + nx * d, mid.y + ny * d).some((o) => o.deck))
        stretches.push({ x0, y0, x1, y1, nx, ny, parapet: !kerb && !alongside && mid.own - under > PARAPET_FROM })
      }
    }
    for (let s = 0; s < stretches.length; s++) {
      const { x0, y0, x1, y1, nx, ny, parapet } = stretches[s]!
      const normal = [nx, 0, -ny]
      const t0 = top(x0, y0)
      const t1 = top(x1, y1)
      // Down into the ground; a deck's side to its foot (its fascia), or a kerb on it to the deck's road.
      const f0 = deck ? deck.foot(x0, y0) : this.bed(x0, y0) - DEPTH
      const f1 = deck ? deck.foot(x1, y1) : this.bed(x1, y1) - DEPTH
      const h0 = parapet ? t0 + PARAPET : t0
      const h1 = parapet ? t1 + PARAPET : t1
      const a = this.vertex(x0, y0, f0, normal, side)
      const b = this.vertex(x1, y1, f1, normal, side)
      const c = this.vertex(x1, y1, h1, normal, side)
      const d = this.vertex(x0, y0, h0, normal, side)
      this.indices.push(a, b, c, a, c, d)
      if (!parapet) continue
      // The parapet: its cap and its inner face, a hand's width in from the edge, and its ends where it stops.
      const ix0 = x0 - nx * PARAPET_THICKNESS
      const iy0 = y0 - ny * PARAPET_THICKNESS
      const ix1 = x1 - nx * PARAPET_THICKNESS
      const iy1 = y1 - ny * PARAPET_THICKNESS
      const e = this.vertex(x0, y0, h0, UP, side)
      const f = this.vertex(x1, y1, h1, UP, side)
      const g = this.vertex(ix1, iy1, h1, UP, side)
      const h = this.vertex(ix0, iy0, h0, UP, side)
      this.indices.push(e, f, g, e, g, h)
      const inward = [-nx, 0, ny]
      const i0 = this.vertex(ix1, iy1, top(ix1, iy1), inward, side)
      const i1 = this.vertex(ix0, iy0, top(ix0, iy0), inward, side)
      const i2 = this.vertex(ix0, iy0, h0, inward, side)
      const i3 = this.vertex(ix1, iy1, h1, inward, side)
      this.indices.push(i0, i1, i2, i0, i2, i3)
      // An end: a face across the parapet from a to b, facing to the right of a to b (as the sides do).
      const cap = (ax: number, ay: number, bx: number, by: number, h: number) => {
        const l = Math.hypot(bx - ax, by - ay) || 1
        const n = [(by - ay) / l, 0, (bx - ax) / l]
        const p0 = this.vertex(ax, ay, top(ax, ay), n, side)
        const p1 = this.vertex(bx, by, top(bx, by), n, side)
        const p2 = this.vertex(bx, by, h, n, side)
        const p3 = this.vertex(ax, ay, h, n, side)
        this.indices.push(p0, p1, p2, p0, p2, p3)
      }
      const joined = (o: (typeof stretches)[number] | undefined, x: number, y: number) =>
        !!o && o !== stretches[s] && o.parapet && (Math.hypot(o.x1 - x, o.y1 - y) < 1e-3 || Math.hypot(o.x0 - x, o.y0 - y) < 1e-3)
      if (!joined(stretches[(s + stretches.length - 1) % stretches.length], x0, y0)) cap(ix0, iy0, x0, y0, h0)
      if (!joined(stretches[(s + 1) % stretches.length], x1, y1)) cap(x1, y1, ix1, iy1, h1)
    }
  }

  finish(): MeshBuffers | null {
    this.sides()
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

/** How far outside an edge (metres) to look for a surface beside it: past the centimetre neighbours overlap by. */
const BESIDE = 0.03
/** Surfaces this much lower (metres) still count as level with one another. */
const LEVEL = 0.005
/** A surface beside an edge up to this much higher (metres) stands against it (a block fill over a road), not over it (a deck). */
const ADJACENT = 1.2
/** Grid cells for finding the surfaces at a point (metres). */
const COVER_CELL = 25

/** The surfaces at a point: each one's top (metres above sea level), and whether it's on a deck. */
type Coverage = (x: number, y: number) => { top: number; deck: boolean }[]

function coverage(solids: readonly Solid[], base: (x: number, y: number, deck: Deck | null) => number): Coverage {
  const entries: { polygon: MultiPolygon[number]; lift: number; deck: Deck | null; box: PlanRect }[] = []
  const grid = new Map<number, number[]>()
  const key = (cx: number, cy: number) => (cy + 4096) * 8192 + (cx + 4096)
  for (const { region, lift, deck } of solids) {
    for (const polygon of region) {
      if (!polygon[0] || polygon[0].length < 3) continue
      const box = boundsOfRing(polygon[0])
      const k = entries.push({ polygon, lift, deck, box }) - 1
      for (let cy = Math.floor(box.minY / COVER_CELL); cy <= Math.floor(box.maxY / COVER_CELL); cy++) {
        for (let cx = Math.floor(box.minX / COVER_CELL); cx <= Math.floor(box.maxX / COVER_CELL); cx++) {
          const list = grid.get(key(cx, cy))
          if (list) list.push(k)
          else grid.set(key(cx, cy), [k])
        }
      }
    }
  }
  return (x, y) => {
    const found: { top: number; deck: boolean }[] = []
    for (const k of grid.get(key(Math.floor(x / COVER_CELL), Math.floor(y / COVER_CELL))) ?? []) {
      const { polygon, lift, deck, box } = entries[k]!
      if (x < box.minX || x > box.maxX || y < box.minY || y > box.maxY) continue
      if (insidePlan(polygon[0]!, x, y) && !polygon.slice(1).some((hole) => insidePlan(hole, x, y))) found.push({ top: base(x, y, deck) + lift, deck: !!deck })
    }
    return found
  }
}

function insidePlan(ring: Ring, x: number, y: number): boolean {
  let hit = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!
    const [xj, yj] = ring[j]!
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit
  }
  return hit
}

/** A ring's bounds on the plan. */
function boundsOfRing(ring: Ring): PlanRect {
  const box = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity }
  for (const [x, y] of ring) {
    box.minX = Math.min(box.minX, x)
    box.maxX = Math.max(box.maxX, x)
    box.minY = Math.min(box.minY, y)
    box.maxY = Math.max(box.maxY, y)
  }
  return box
}

/** Whether a point (tile units) lies in a shape. */
function insideShape(shape: Shape, u: number, v: number): boolean {
  return insideRing(shape.outer, u, v) && !shape.holes.some((hole) => insideRing(hole, u, v))
}

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
