import { crossSection, CURB_HEIGHT, labelPoint, streetGeometry, type MultiPolygon, type Snapshot, type Street, type StreetPiece, type Vec2 } from '@plinth/core'
import { CLEARANCE, solveElevation, type Passing } from './elevation.ts'
import { clipLine, UNIT } from './clip.ts'
import type { BuildingFeature, RoadFeature, RoadKind, Shape } from './features.ts'
import { LineField } from './field.ts'
import type { Ground } from './ground.ts'
import { ecefFromLonLat, type Frame } from './geo.ts'
import { tileFrame, tileWidth, type MeshBuffers } from './mesh.ts'
import { looksLikeRoundabout, tidyNetwork, type StreetLine } from './network.ts'
import { areaOf, common, disc, grown, inRegion, merged, polygonsOf, rectangle, regionOf, rounded, stroked, without, type Region } from './plan.ts'
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
const ISLAND = 60
/** A road lies at least this far over the ground under it (metres). */
const OVER_GROUND = 0.1
/** With the tiles round it, a tile's network is worked out this far past its edges (metres): a ramp's length and more. */
const REACH = 250
/** A street's own height reaches this far beyond its road (metres), fading into the ground's. */
const BED_REACH = 7
/** A deck's surface is closed over gaps narrower than twice this (metres). */
const DECK_CLOSE = 4
/** Decks side by side are one where their heights are within this of each other (metres). */
const LEVEL = 0.4
/** A deck is level across out to this far beyond its roads (metres): its walkways, however far out they were mapped. */
const DECK_REACH = 20
/** A bridge's deck: this deep under its road (metres), with an edge beam this wide and parapets this wide and high. */
const DECK = 0.9
const EDGE = 0.3
const PARAPET_WIDTH = 0.25
const PARAPET = 1.1
/** Where a deck stands less than this over the ground (metres), it's a solid down to it: an abutment, a ramp. */
const SOLID = 1.5
/** Looked for across a deck in cells this wide (metres). */
const LOW_CELL = 2.5
/** A bridge holds the road in its mouth up to itself over this far from where it lands (metres). */
const HEAD = 14
/** A deck's road and the road it lands on are rounded as one this far round its landing, beyond its own width (metres). */
const MOUTH_JOIN = 6
/**
 * Water shut in behind a bridge's landing is its deck's: within this far of the landing beyond the bridge's own
 * width, no further on along the bridge than `MOUTH_AHEAD` (metres), and no more of it than `PUDDLE` (square metres).
 */
const MOUTH_REACH = 24
const MOUTH_AHEAD = 3
const PUDDLE = 300
/**
 * A deck takes up what the ground stands over (or under) it where they meet over this far from there (metres);
 * where they differ by `EASE_MOST` or more they don't meet.
 */
const EASE = 10
const EASE_MOST = 0.8
/** No parapet stands on a deck's edge within this of the ground beside it (metres), looked for this far beyond a landing's reach. */
const FLUSH = 0.5
const FLUSH_REACH = 12
/** Water open to the rest by a slot no wider than twice this (metres) is shut in all the same. */
const SLOT = 0.5
/** A deck's road and the ground's are brought edge to edge where they're within this of each other (metres). */
const SEAM = 0.12
/** A deck is shaped from what lies this far round the part being laid (metres): its mouths' reach, and what shapes them. */
const DECK_AROUND = 56
/** Piers stand this far apart along a bridge (metres), where its underside is at least this far over what's under it. */
const PIER_EVERY = 24
const PIER_FROM = 2.5
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
  /** What stands clear of the ground and casts shadows on it: bridge decks with their parapets and piers. */
  structures: MeshBuffers | null
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
  /**
   * The roads of the tiles round this one (each `dx`, `dy` tiles east and south of it). With them the network
   * is worked out a few hundred metres past the tile's edges: a junction at an edge is whole, a bridge crossing
   * one has both its landings, and the two tiles make the same of what they share.
   */
  around?: readonly { dx: number; dy: number; roads: readonly RoadFeature[] }[]
  /** Filled in with how long each stage took (ms), for looking into it. */
  timings?: Record<string, number>
}

/**
 * The height people walk at, at a point (metres above sea level): in town,
 * the top of the block fills and paved squares (see streetMesh); elsewhere
 * the land. Buildings stand on it (see buildingMesh).
 */
export function walkingLevel(ground: Ground): (lon: number, lat: number) => number {
  return ground.town ? (lon, lat) => ground.level(lon, lat) + KERB : (lon, lat) => ground.at(lon, lat)
}

/** Railways that count as something to clear (a tram runs in the street, on the bridge with it). */
const RAILWAYS = new Set(['rail', 'light_rail', 'narrow_gauge', 'preserved', ''])

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
  const plan = planStreets(tile, roads, ground, squares, greens, options)
  return plan ? layStreets(plan, colours, { mask, timings: options.timings }) : { mesh: null, structures: null, cover: [], greenFills: [], paved: [] }
}

/**
 * A tile's streets worked out, ready to lay (see layStreets): the network tidied, every street's and
 * junction's outline, how high each runs, and what each block between them is. Laying is most of the work
 * and can be done a part of the tile at a time; this is done once for all of them.
 */
export function planStreets(
  tile: TileId,
  roads: readonly RoadFeature[],
  ground: Ground,
  squares: readonly Shape[] = [],
  greens: readonly Shape[] = [],
  options: StreetOptions = {},
) {
  let last = performance.now()
  const mark = (stage: string) => {
    if (!options.timings) return
    const now = performance.now()
    options.timings[stage] = (options.timings[stage] ?? 0) + now - last
    last = now
  }
  const metres = tileWidth(tile)
  // Plan metres: x east, y north (tile units run south), as the editor's sites.
  const toPlan = (u: number, v: number): Vec2 => ({ x: u * metres, y: -v * metres })
  const planLine = (line: Float64Array): Vec2[] => {
    const points: Vec2[] = []
    for (let i = 0; i + 1 < line.length; i += 2) points.push(toPlan(line[i]!, line[i + 1]!))
    return points
  }
  // With the tiles round it: this tile's roads cut to its own edges, and theirs (as far as REACH from it) put
  // beside them, so each road is there once and the pieces meet at the edges (see tidyNetwork: ends that meet join).
  const reach = options.around ? REACH / metres : 0
  if (options.around) {
    const pieces: RoadFeature[] = []
    for (const road of roads) for (const line of clipLine(road.line, UNIT)) pieces.push({ ...road, line })
    for (const { dx, dy, roads: theirs } of options.around) {
      // Theirs as far as REACH from this tile; their bridges whole (a long one is one structure, its height
      // set from landing to landing: both tiles must see all of it to make the same of it).
      const all = { minX: dx, maxX: dx + 1, minY: dy, maxY: dy + 1 }
      const rect = { minX: Math.max(dx, -reach), maxX: Math.min(dx + 1, 1 + reach), minY: Math.max(dy, -reach), maxY: Math.min(dy + 1, 1 + reach) }
      for (const road of theirs) {
        if (!road.bridge && (rect.minX >= rect.maxX || rect.minY >= rect.maxY)) continue
        const moved = road.line.map((value, i) => value + (i % 2 === 0 ? dx : dy))
        for (const line of clipLine(moved, road.bridge ? all : rect)) pieces.push({ ...road, line })
      }
    }
    roads = pieces
  }
  const lines: StreetLine[] = []
  // Where streets go on as tunnels (not drawn): their ends there stay apart, flat.
  const apart = new Set<string>()
  const placeKey = (p: Vec2) => `${Math.round(p.x * 100)}:${Math.round(p.y * 100)}`
  for (const road of roads) {
    if (!road.tunnel) continue
    const line = road.line
    const end = line.length - 2
    for (const i of [0, end]) apart.add(placeKey(toPlan(line[i]!, line[i + 1]!)))
  }
  // Footways on the level: where a city maps its sidewalks as ways of their own, they show where they are.
  const footways: Vec2[][] = []
  // Bridges that aren't streets (railways, footbridges): decks of their own. And railways on the ground: bridges clear them.
  const spanLines: Span[] = []
  const under: Passing[] = []
  for (const road of roads) {
    if (road.tunnel) continue
    if (road.kind === 'path' && !road.bridge && (road.subclass === 'footway' || road.subclass === 'path')) footways.push(planLine(road.line))
    if (road.kind === 'rail' && !road.bridge && RAILWAYS.has(road.subclass)) under.push({ points: planLine(road.line), level: 0, half: 2.2, clearance: CLEARANCE.rail })
    const props = propsOf(road, ground.town)
    if (!props) {
      if (road.bridge) spanLines.push({ points: planLine(road.line), level: Math.max(road.layer, 1), kind: road.kind, width: (road.kind === 'rail' ? 6 : road.width) + 0.8, box: EVERYWHERE })
      continue
    }
    const points = planLine(simplify(road.line, 0.4 / metres))
    // A bridge is a street on a level of its own: it passes over what it crosses, and lands where it ends.
    if (road.bridge) lines.push({ points, props: { ...props, level: Math.max(road.layer, 1) } })
    // A roundabout's ring: the tiles drop junction=roundabout and the one-way, single-lane running it implies.
    else if (looksLikeRoundabout(points)) lines.push({ points, props: { ...props, oneway: true, lanes: 1, laneWidth: Math.max(props.laneWidth, 4) } })
    else lines.push({ points, props })
  }
  const spans = chained(spanLines)
  if (lines.length === 0 && squares.length === 0 && spans.length === 0) return null
  // One junction per crossing, no stray stubs, no sidewalks down the middle of a divided road; ends at the
  // data's edge (beyond the tile) are where it was cut, not dead ends.
  const edge = reach * metres - 1
  const network = tidyNetwork(lines, {
    keepEnd: (p) => p.x < -edge || p.x > metres + edge || p.y > edge || p.y < -metres - edge,
    apart: (p) => apart.has(placeKey(p)),
    footways,
  })
  mark('network')
  const geometry = streetGeometry({ streetNodes: network.nodes, streets: network.streets } as unknown as Snapshot)
  mark('geometry')

  const n = 2 ** tile.z
  /** The street bed's height at a point of the plan. */
  const bed: HeightOn = (x, y) => ground.level(((tile.x + x / metres) / n) * 360 - 180, tileLat(tile.y - y / metres, tile.z))
  /**
   * A street's height along its middle: the land's trend there (the same whichever tile asks, also past this
   * one's edges), and over water a causeway just above it.
   */
  const along: HeightOn = (x, y) => {
    const lon = ((tile.x + x / metres) / n) * 360 - 180
    const lat = tileLat(tile.y - y / metres, tile.z)
    const surface = ground.waterAt(lon, lat)
    const trend = ground.trend(lon, lat)
    return surface !== null ? Math.max(trend, surface + 0.45) : trend
  }
  /** The ground itself at a point of the plan (see Ground.at). */
  const landAt: HeightOn = (x, y) => ground.at(((tile.x + x / metres) / n) * 360 - 180, tileLat(tile.y - y / metres, tile.z))
  /** The water's surface at a point of the plan, or null on land. */
  const waterAt = (x: number, y: number) => ground.waterAt(((tile.x + x / metres) / n) * 360 - 180, tileLat(tile.y - y / metres, tile.z))
  const roadHalf = (street: Street) => {
    const section = crossSection(street)
    return Math.max(section.roadLeft, section.roadRight)
  }
  // How high everything runs: on its bed, or over it on a bridge and the ramps up to one.
  const elevation = solveElevation({
    nodes: network.nodes,
    streets: network.streets,
    bed: along,
    water: waterAt,
    // With the tiles round it a bridge is there whole; alone, one that ends at the tile's edge goes on beyond it.
    cut: options.around ? undefined : (node) => node.x < 1 || node.x > metres - 1 || node.y > -1 || node.y < -metres + 1,
    half: roadHalf,
    under,
    spans: spans.map((span) => ({ points: span.points, level: span.level, gradient: span.kind === 'rail' ? 0.12 : 0.35 })),
  })
  mark('heights')
  // The roads' own heights: each street level across at its height, however wide it was built (the ground's
  // beds are only as wide as each road's class says), blended where streets meet. A bridge counts for the
  // ground's roads only where it lands, so the road in its mouth is held up to it.
  const beds = new LineField(BED_REACH)
  const decks = elevation.structures.map(() => new LineField(DECK_REACH, true))
  const landings = new Set(elevation.structures.flatMap((structure) => structure.landings))
  const meeting = new Map<string, Street[]>()
  for (const street of Object.values(network.streets)) {
    const a = network.nodes[street.a]
    const b = network.nodes[street.b]
    if (!a || !b) continue
    const length = Math.hypot(b.x - a.x, b.y - a.y)
    if (length < 1e-6) continue
    for (const end of [street.a, street.b]) {
      const list = meeting.get(end)
      if (list) list.push(street)
      else meeting.set(end, [street])
    }
    const line = { ax: a.x, ay: a.y, bx: b.x, by: b.y, half: roadHalf(street), height: elevation.heightOf(street.id) }
    const structure = elevation.structureOf.get(street.id)
    if (structure === undefined) {
      beds.add(line)
      continue
    }
    decks[structure]!.add(line)
    if (landings.has(street.a)) beds.add({ ...line, from: 0, to: Math.min(HEAD, length) })
    if (landings.has(street.b)) beds.add({ ...line, from: Math.max(0, length - HEAD), to: length })
  }
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
  // through them. Each bridge's pieces are a plan of their own, on its deck.
  const roadPieces: MultiPolygon = []
  const pavedPieces: MultiPolygon = shapes(squares)
  const bikePieces: MultiPolygon = []
  const parkingPieces: MultiPolygon = []
  const walkPieces: MultiPolygon = []
  const marks: Vec2[][] = []
  const onDeck = elevation.structures.map(() => ({ road: [] as MultiPolygon, walks: [] as MultiPolygon, marks: [] as Vec2[][], mouths: [] as MultiPolygon, leads: [] as MultiPolygon }))
  /** The bridge a piece is part of, or -1 for one on the ground. */
  const structureOfPiece = (piece: StreetPiece): number => {
    if (!piece.level) return -1
    if (piece.key.startsWith('street:')) return elevation.structureOf.get(piece.key.slice(7)) ?? -1
    for (const node of piece.key.slice(piece.key.indexOf(':') + 1).split('+')) {
      for (const street of meeting.get(node) ?? []) {
        const structure = elevation.structureOf.get(street.id)
        if (structure !== undefined && (street.level ?? 0) === piece.level) return structure
      }
    }
    return -1
  }
  for (const piece of geometry.pieces) {
    const structure = structureOfPiece(piece)
    if (structure >= 0) {
      const deck = onDeck[structure]!
      deck.road.push(...piece.road, ...piece.bike, ...piece.parking)
      deck.walks.push(...piece.sidewalks)
      deck.marks.push(...piece.markings, ...piece.crosswalks)
      continue
    }
    if (piece.shared) pavedPieces.push(...piece.road)
    else roadPieces.push(...piece.road, ...piece.bike, ...piece.parking)
    bikePieces.push(...piece.bike)
    parkingPieces.push(...piece.parking)
    walkPieces.push(...piece.sidewalks)
    marks.push(...piece.markings, ...piece.crosswalks)
    // The junction a bridge lands in is its mouth: no parapet stands across it. (A street that runs up to a
    // landing leads into it: the deck's road goes over into that street's.)
    const lead = piece.key.startsWith('street:') ? network.streets[piece.key.slice(7)] : undefined
    for (const node of piece.key.startsWith('junction:') ? piece.key.slice(9).split('+') : lead ? [lead.a, lead.b] : []) {
      if (!landings.has(node)) continue
      for (const street of meeting.get(node) ?? []) {
        const structure = elevation.structureOf.get(street.id)
        if (structure !== undefined) onDeck[structure]![lead ? 'leads' : 'mouths'].push(...piece.road)
      }
    }
  }

  // What else the plan is laid from: the water, the buildings standing on the ground, the greenery.
  const waters = boxed(shapes(ground.water))
  const footprints = boxed(shapes((options.buildings ?? []).filter((b) => b.minHeight === 0).map((b) => b.shape)))
  const greenery = boxed(shapes(greens))
  // Which blocks are open country (see openBlocks): decided for the tile as a whole, so its parts agree.
  const open =
    ground.town
      ? openBlocks(
          metres,
          Object.values(network.streets)
            .filter((street) => !street.level)
            .map((street) => ({ a: network.nodes[street.a]!, b: network.nodes[street.b]!, half: roadHalf(street) })),
          [...waters, ...boxed(pavedPieces)].map((entry) => entry.polygon),
          footprints.map((entry) => entry.polygon),
        )
      : () => false
  mark('blocks')
  return {
    tile,
    metres,
    ground,
    bed,
    landAt,
    waterAt,
    network,
    elevation,
    beds,
    decks,
    landings,
    roadHalf,
    spans,
    open,
    waters,
    footprints,
    greenery,
    roads: boxed(roadPieces),
    paved: boxed(pavedPieces),
    bikes: boxed(bikePieces),
    parking: boxed(parkingPieces),
    walks: boxed(walkPieces),
    marks: marks.map((mark) => ({ mark, box: boundsOf(mark.map((p) => [p.x, p.y])) })),
    onDeck: onDeck.map((deck) => ({ road: boxed(deck.road), walks: boxed(deck.walks), marks: deck.marks, mouths: deck.mouths, leads: deck.leads })),
  }
}

/** A tile's streets worked out and ready to lay: see planStreets. */
export type StreetPlan = NonNullable<ReturnType<typeof planStreets>>

/** A part of a tile to lay on its own (plan metres: x east from its west edge, y north from its north edge, so y is negative). */
export interface PlanRect {
  minX: number
  maxX: number
  minY: number
  maxY: number
}

/** A tile's quarters, north-west first (as its children at the next zoom): each can be laid on its own, in any order. */
export function quarterOf(metres: number, quarter: number): PlanRect {
  const half = metres / 2
  const column = quarter % 2
  const row = Math.floor(quarter / 2)
  return { minX: column * half, maxX: (column + 1) * half, minY: -(row + 1) * half, maxY: -row * half }
}

export interface LayOptions {
  /** An area to leave out (a site's own streets are there): longitudes and latitudes of its corners. */
  mask?: readonly { lon: number; lat: number }[]
  /** Only this part of the tile (see quarterOf); all of it by default. */
  part?: PlanRect
  /** Filled in with how long each stage took (ms), for looking into it. */
  timings?: Record<string, number>
}

/** What's laid of a plan takes in what lies this far round the part being laid (metres): enough for every rounding to come out the same from either side of a part's edge. */
const AROUND = 16

/**
 * A plan laid as meshes: all of its tile, or a part of it. Parts meet edge to edge (each is cut to its own
 * rectangle and follows the same heights), so a tile can be laid a quarter at a time, the nearest first.
 */
export function layStreets(plan: StreetPlan, colours: StreetColours, options: LayOptions = {}): StreetsBuilt {
  const { tile, metres, ground, bed, landAt, waterAt, network, elevation, beds, decks, landings, roadHalf, spans, onDeck } = plan
  const mask = options.mask
  let last = performance.now()
  const mark = (stage: string) => {
    if (!options.timings) return
    const now = performance.now()
    options.timings[stage] = (options.timings[stage] ?? 0) + now - last
    last = now
  }
  const part = options.part ?? { minX: 0, maxX: metres, minY: -metres, maxY: 0 }
  /** Of a list, what lies in or near the part. */
  const near = <T extends { box: PlanRect }>(list: readonly T[]): T[] =>
    list.filter(({ box }) => box.maxX > part.minX - AROUND && box.minX < part.maxX + AROUND && box.maxY > part.minY - AROUND && box.minY < part.maxY + AROUND)
  const polygonsNear = (list: readonly Boxed[]): MultiPolygon => near(list).map((b) => b.polygon)
  const n = 2 ** tile.z
  const writer = new StreetWriter(tile, metres, bed)
  // The road's height: its streets', and never under the ground itself (where a road was built wider than the
  // ground's bed for it, on the uphill side the land would otherwise stand through it).
  const roadHeight: HeightOn = (x, y) => Math.max(beds.at(x, y, bed), landAt(x, y) + OVER_GROUND)
  const roadLaid = new Laid()
  const roadLaying: Laying = { ...ROAD_LAYING, height: roadHeight, record: roadLaid }
  // The blocks' height: the street bed's, and beside a road that runs lower than the bed there (where a bridge
  // lands, where the network's own heights and the ground's part ways) the road's, so a kerb is a kerb's height
  // and no more. (Not up with a road that climbs over the bed: beside a ramp the blocks, and the buildings on
  // them, stay on the ground.)
  const fillHeight: HeightOn = (x, y) => {
    const level = bed(x, y)
    return Math.min(level, beds.at(x, y, () => level))
  }
  const fillLaying: Laying = { ...FILL_LAYING, height: fillHeight }
  // Paint lies on the road as laid, split often enough to follow it.
  const paintOn = (laid: Laid, height: HeightOn): Laying => ({ tolerance: Infinity, most: 6, least: 6, height: (x, y) => laid.at(x, y) ?? height(x, y) })

  // The tile itself, and the area left out: everything is cut to them.
  const whole = rectangle(part.minX, part.minY, part.maxX, part.maxY)
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
  const holeRing = mask ? polygonsOf(hole)[0]?.[0] : undefined
  const kept = (x: number, y: number) => x >= part.minX && x <= part.maxX && y <= part.maxY && y >= part.minY && !(holeRing && insidePolygon([holeRing], x, y))
  const onEdge = (x: number, y: number) => x < part.minX + 1e-3 || x > part.maxX - 1e-3 || y > part.maxY - 1e-3 || y < part.minY + 1e-3
  /** An edge along the part's own edge: where the next part or tile goes on, not a side. */
  const seam = (ax: number, ay: number, bx: number, by: number) => onEdge(ax, ay) && onEdge(bx, by) && (Math.abs(ax - bx) < 1e-3 || Math.abs(ay - by) < 1e-3)

  const roadPlan = withoutIslands(rounded(merged(regionOf(polygonsNear(plan.roads))), ROUND, THIN), ISLAND)
  const road = cut(roadPlan)
  const allPaving = without(cut(rounded(merged(regionOf(polygonsNear(plan.paved))), 1, 0)), road)
  mark('road plan')

  // The bridges' decks, and where each stands so low over the ground that it's a solid down to it (its
  // abutments, an approach on a ramp): nothing of the blocks shows there.
  const structures = new StreetWriter(tile, metres, bed)
  const laidDecks: { deck: Region; low: Region }[] = []
  // Footways and tracks mapped as bridges of their own beside a street's bridge are that bridge's walkways
  // (and a tram's rails on it are in its road): part of its deck, not decks of their own. Stretch by stretch:
  // a footway that runs along the bridge and then turns off across its mouth is its walkway only so far.
  const spanNear = spans.map((span) => near([span]).length > 0)
  const spanTaken = spans.map((span) => {
    const taken = new Uint8Array(Math.max(0, span.points.length - 1))
    for (let k = 0; k < taken.length; k++) if (Math.hypot(span.points[k + 1]!.x - span.points[k]!.x, span.points[k + 1]!.y - span.points[k]!.y) < 1e-6) taken[k] = 1
    return taken
  })
  /** Of a list, what lies within a distance of the part: a deck is shaped whole about its ends, wherever the part's edge runs. */
  const within = (list: readonly Boxed[], far: number): MultiPolygon =>
    list.filter(({ box }) => box.maxX > part.minX - far && box.minX < part.maxX + far && box.maxY > part.minY - far && box.minY < part.maxY + far).map((b) => b.polygon)
  /** Where a bridge lands (where its deck begins): the point, the way the bridge runs on from it, and how far round it is its mouth. */
  interface DeckEnd {
    x: number
    y: number
    dx: number
    dy: number
    outer: number
    reach: number
  }
  interface DeckShape {
    index: number
    level: number
    carriageway: Region
    surface: Region
    ends: DeckEnd[]
    /** Water at its ends taken into its deck (see below). */
    closed: Region
    /** The ground's road where it lands: the deck's walkways stop at it. */
    mouthRoad: Region
  }
  // First where each lands, then each deck's shape, then (their shapes known) what's left open between a
  // deck's end and the shore.
  const endsOf = elevation.structures.map((structure, index): DeckEnd[] => {
    if (onDeck[index]!.road.length === 0) return []
    const ends: DeckEnd[] = []
    for (const id of structure.streets) {
      const street = network.streets[id]!
      const a = network.nodes[street.a]!
      const b = network.nodes[street.b]!
      const length = Math.hypot(b.x - a.x, b.y - a.y)
      if (length < 1e-6) continue
      const section = crossSection(street)
      const outer = Math.max(section.outerLeft, section.outerRight)
      for (const [node, other] of [[a, b], [b, a]] as const) {
        if (!landings.has(node.id)) continue
        const reach = outer + MOUTH_REACH
        const dx = (other.x - node.x) / length
        const dy = (other.y - node.y) / length
        // Where its deck begins: the junction it lands in reaches some way out along it.
        let from = Infinity
        for (const { polygon, box } of onDeck[index]!.road) {
          if (box.maxX < node.x - 60 || box.minX > node.x + 60 || box.maxY < node.y - 60 || box.minY > node.y + 60) continue
          for (const [x, y] of polygon[0]!) {
            const along = (x - node.x) * dx + (y - node.y) * dy
            if (along > -2 && along < from && Math.abs((x - node.x) * dy - (y - node.y) * dx) <= outer + 1) from = along
          }
        }
        from = Number.isFinite(from) ? Math.max(0, from) : 0
        const x = node.x + dx * from
        const y = node.y + dy * from
        if (x < part.minX - reach || x > part.maxX + reach || y < part.minY - reach || y > part.maxY + reach) continue
        ends.push({ x, y, dx, dy, outer, reach })
      }
    }
    return ends
  })
  /** The ground's road about the landings (all that's asked of it there: the whole plan needn't be gone through for each deck). */
  const landed = endsOf.flat()
  const roadAtMouths = landed.length > 0 ? common(roadPlan, merged(...landed.map((end) => disc(end.x, end.y, end.reach)))) : []
  const besideRoad = grown(roadAtMouths, SEAM)
  const shapes: DeckShape[] = []
  /** What decks have taken of the mouths so far, so that two landing side by side don't both take what's between them. */
  let claimed: Region = []
  elevation.structures.forEach((structure, index) => {
    const pieces = onDeck[index]!
    const deckRoads = within(pieces.road, DECK_AROUND)
    if (deckRoads.length === 0) return
    const ends = endsOf[index]!
    const roads = merged(regionOf(deckRoads))
    let carriageway = rounded(roads, ROUND, 0)
    // Where it lands, its road and the ground's are one surface: rounded together, so that no wedge is left
    // open between a deck and the junction it lands in (each rounded for itself would give up the slivers
    // between them). What the ground's road doesn't have of that is the deck's, and so is the hair's breadth
    // between the two that tidying each has cost: they meet edge to edge.
    let mouthRoad: Region = []
    if (ends.length > 0 && pieces.mouths.length + pieces.leads.length > 0) {
      const round = merged(...ends.map((end) => disc(end.x, end.y, end.outer + MOUTH_JOIN)))
      // (Only what's about the landings is gone through: a little more than is kept, so the rounding there is whole.)
      const about = merged(...ends.map((end) => disc(end.x, end.y, end.reach)))
      const lands = common(merged(regionOf(pieces.mouths), regionOf(pieces.leads)), about)
      mouthRoad = common(roadAtMouths, grown(lands, ROUND + 0.5))
      const joint = rounded(merged(common(roads, about), lands), ROUND, THIN)
      const filled = rounded(common(without(joint, roadAtMouths, claimed), round), 0, 0.08)
      if (filled.length > 0) carriageway = merged(carriageway, filled)
      const between = without(common(common(grown(common(carriageway, about), SEAM), besideRoad), round), roadAtMouths, claimed)
      if (between.length > 0) carriageway = merged(carriageway, between)
      claimed = merged(claimed, filled, between)
    }
    carriageway = withoutIslands(carriageway, 4 * ISLAND)
    let surface = merged(carriageway, regionOf(within(pieces.walks, DECK_AROUND)))
    const reach = boundsOf(deckRoads.flatMap((polygon) => polygon[0]!))
    let beside: Region | null = null
    const lines = structure.streets.map((id) => network.streets[id]!).map((street) => [network.nodes[street.a]!, network.nodes[street.b]!] as const)
    spans.forEach((span, i) => {
      if (!spanNear[i]) return
      // Only those anywhere near it are looked at closely.
      if (span.box.maxX < reach.minX - 4 || span.box.minX > reach.maxX + 4 || span.box.maxY < reach.minY - 4 || span.box.minY > reach.maxY + 4) return
      const taken = spanTaken[i]!
      const runs: Vec2[][] = []
      let run: Vec2[] = []
      for (let k = 0; k < taken.length; k++) {
        const p = span.points[k]!
        const q = span.points[k + 1]!
        let ours = false
        if (!taken[k] && Math.max(p.x, q.x) > reach.minX - 4 && Math.min(p.x, q.x) < reach.maxX + 4 && Math.max(p.y, q.y) > reach.minY - 4 && Math.min(p.y, q.y) < reach.maxY + 4) {
          beside ??= grown(surface, 3.5)
          const stretch = stroked([[p, q]], span.width)
          const area = areaOf(stretch)
          // Beside it, and along it, not across: a path that passes under or over the bridge is no walkway of it.
          ours = area > 0 && areaOf(common(stretch, beside)) >= area * 0.6 && alongside([p, q], lines)
        }
        if (ours) {
          taken[k] = 1
          if (run.length === 0) run.push(p)
          run.push(q)
        } else if (run.length > 0) {
          runs.push(run)
          run = []
        }
      }
      if (run.length > 0) runs.push(run)
      if (runs.length > 0 && span.kind !== 'rail') surface = merged(surface, stroked(runs, span.width))
    })
    shapes.push({ index, level: structure.level, carriageway, surface, ends, closed: [], mouthRoad })
  })
  // The decks closed over their slots: between a road and a walkway mapped a little apart from it, in the
  // notch where two carriageways come apart to land, and between decks that run side by side at one height
  // (a street mapped as two carriageways is two bridges to the map, and one to the eye). What closes a slot
  // is the deck's it lies against; between two decks, theirs only if they're level with each other there.
  /** A deck's height as its bridge runs: level across, at its own street's height. */
  const levelOn = (shape: DeckShape): HeightOn => {
    const field = decks[shape.index]!
    return (x, y) => field.at(x, y, bed)
  }
  // A deck's height as it's laid: its bridge's, eased onto the ground's where it lands. The bridge runs level
  // across at its own street's height; the ground it lands on has the heights of all that meets there (a quay
  // that climbs past the bridge's mouth, a bank that stands a little over the street). Along the seam itself
  // (the deck's edge where dry ground lies against it, behind its landings) the deck takes the ground's height
  // exactly, and gives the difference up over its first metres, so nothing steps where the two meet.
  const eased = new Map<DeckShape, HeightOn>()
  const heightOn = (shape: DeckShape): HeightOn => {
    let height = eased.get(shape)
    if (height) return height
    const level = levelOn(shape)
    const seamAt: number[] = []
    if (shape.ends.length > 0) {
      const landing = (x: number, y: number) =>
        shape.ends.some((end) => {
          const rx = x - end.x
          const ry = y - end.y
          return rx * rx + ry * ry < end.reach * end.reach && rx * end.dx + ry * end.dy < 1.5
        })
      for (const path of shape.surface) {
        for (let i = 0; i < path.length; i++) {
          const ax = path[i]!.X / 1000
          const ay = path[i]!.Y / 1000
          const bx = path[(i + 1) % path.length]!.X / 1000
          const by = path[(i + 1) % path.length]!.Y / 1000
          const length = Math.hypot(bx - ax, by - ay)
          if (length < 1e-6 || !(landing(ax, ay) || landing(bx, by))) continue
          // Out from the edge: to its right (outlines run anticlockwise, holes clockwise).
          const nx = ((by - ay) / length) * 0.4
          const ny = (-(bx - ax) / length) * 0.4
          const count = Math.max(1, Math.ceil(length))
          for (let k = 0; k < count; k++) {
            const x = ax + ((bx - ax) * (k + 0.5)) / count
            const y = ay + ((by - ay) * (k + 0.5)) / count
            if (!landing(x + nx, y + ny)) continue
            // What lies against it there: the road it lands on (which may run out over the water itself), or a block.
            const onRoad = inRegion(roadAtMouths, x + nx, y + ny)
            if (!onRoad && waterAt(x + nx, y + ny) !== null) continue
            // (Its height at the deck's very edge: the ground may slope away from there.)
            const over = (onRoad ? roadHeight(x, y) : fillHeight(x, y)) - level(x, y)
            if (Math.abs(over) < EASE_MOST) seamAt.push(x, y, over)
          }
        }
      }
    }
    height =
      seamAt.length === 0
        ? level
        : (x, y) => {
            let sum = 0
            let weights = 0
            for (let i = 0; i < seamAt.length; i += 3) {
              const dx = x - seamAt[i]!
              const dy = y - seamAt[i + 1]!
              const d2 = dx * dx + dy * dy
              if (d2 >= EASE * EASE) continue
              const weight = 1 / (d2 * d2 + 1e-4)
              sum += weight * seamAt[i + 2]! * (1 - smoothstep(Math.sqrt(d2) / EASE))
              weights += weight
            }
            return weights > 0 ? level(x, y) + sum / weights : level(x, y)
          }
    eased.set(shape, height)
    return height
  }
  if (shapes.length > 0) {
    const all = merged(...shapes.map((shape) => shape.surface))
    const boxes = shapes.map((shape) => regionBox(shape.surface))
    for (const polygon of polygonsOf(rounded(without(rounded(all, DECK_CLOSE, 0), all), 0, 0.04))) {
      const box = boundsOf(polygon[0]!)
      const against = grown(regionOf([polygon]), 0.3)
      const beside = shapes.filter((shape, i) => apart(boxes[i]!, box) < 0.5 && common(against, shape.surface).length > 0)
      const first = beside[0]
      if (!first) continue
      if (beside.length > 1) {
        const at = labelPoint([polygon]) ?? { x: polygon[0]![0]![0], y: polygon[0]![0]![1] }
        const here = levelOn(first)(at.x, at.y)
        if (beside.some((shape) => Math.abs(levelOn(shape)(at.x, at.y) - here) > LEVEL)) continue
      }
      first.surface = merged(first.surface, grown(regionOf([polygon]), 0.05))
    }
  }
  // Water left between a bridge's end and the shore is the bridge's: the map's shoreline and where its
  // bridge begins seldom agree, and the blocks stop at the water, so a patch of it would show behind the
  // landing (between the deck's walkway and the road running up to it, round an island in its mouth, in the
  // slot between a walkway's end and the bank). Only what's shut in there by the decks, the roads and the
  // shore (or all but: open to the rest by no more than a slot), small, behind a landing and against the
  // deck: never the water a bridge crosses.
  const allEnds = shapes.flatMap((shape) => shape.ends.map((end) => ({ end, shape })))
  if (allEnds.length > 0 && plan.waters.length > 0) {
    // (The water about the ends cut out once: the lake needn't be gone through for each.)
    const water = common(regionOf(polygonsNear(plan.waters)), merged(...allEnds.map(({ end }) => disc(end.x, end.y, end.reach + 2))))
    const wet = allEnds.filter(({ end }) => water.some((path) => path.some((p) => Math.hypot(p.X / 1000 - end.x, p.Y / 1000 - end.y) < end.reach + 2.5)))
    if (wet.length > 0) {
      // The roads about the ends: what's been worked out of them already, and about an end near the part's
      // edge (where the part hasn't all of them) worked out whole, so that every part finds the same.
      const edging = wet.filter(({ end }) => end.x - end.reach < part.minX - 10 || end.x + end.reach > part.maxX + 10 || end.y - end.reach < part.minY - 10 || end.y + end.reach > part.maxY + 10)
      const about = (list: readonly Boxed[], ends: typeof wet): MultiPolygon =>
        list
          .filter(({ box }) => ends.some(({ end }) => box.maxX > end.x - end.reach - 8 && box.minX < end.x + end.reach + 8 && box.maxY > end.y - end.reach - 8 && box.minY < end.y + end.reach + 8))
          .map((b) => b.polygon)
      const there = edging.length > 0 ? merged(...edging.map(({ end }) => disc(end.x, end.y, end.reach + 8))) : []
      const roadsThere = edging.length > 0 ? merged(roadAtMouths, withoutIslands(rounded(common(merged(regionOf(about(plan.roads, edging))), there), ROUND, THIN), ISLAND)) : roadAtMouths
      const pavedThere = regionOf(about(plan.paved, wet))
      const left = without(water, roadsThere, pavedThere, ...shapes.map((shape) => shape.surface))
      // The open water and the puddles each for itself, and the slots between them (not the hair's breadths
      // between one surface and the next).
      const wide = rounded(left, 0, SLOT)
      const slots = rounded(without(left, grown(wide, 0.02)), 0, 0.1)
      const found: { polygon: MultiPolygon[number]; back: number }[] = [
        ...polygonsOf(wide).map((polygon) => ({ polygon, back: SLOT + 0.05 })),
        ...polygonsOf(slots).map((polygon) => ({ polygon, back: 0.15 })),
      ]
      for (const { polygon, back } of found) {
        if (blockArea(polygon) > PUDDLE) continue
        const by = new Set<DeckShape>()
        const behind = polygon[0]!.every(([x, y]) => {
          let any = false
          for (const { end, shape } of wet) {
            const rx = x - end.x
            const ry = y - end.y
            if (rx * rx + ry * ry > end.reach * end.reach || rx * end.dx + ry * end.dy > MOUTH_AHEAD) continue
            any = true
            by.add(shape)
          }
          return any
        })
        if (!behind) continue
        // As it was before the slots were told from the rest (their corners and all), and a little over its edges.
        const puddle = grown(common(grown(regionOf([polygon]), back), left), 0.05)
        const against = grown(puddle, 0.3)
        const shape = [...by].find((shape) => common(against, shape.surface).length > 0)
        if (!shape) continue
        shape.surface = merged(shape.surface, puddle)
        shape.closed = merged(shape.closed, puddle)
      }
    }
  }
  // The road each level's decks land on: a deck's walkways stop at it (its own, and that of a deck beside it).
  const mouthRoads = new Map<number, Region>()
  for (const shape of shapes) if (shape.mouthRoad.length > 0) mouthRoads.set(shape.level, merged(mouthRoads.get(shape.level) ?? [], shape.mouthRoad))
  const boxes = shapes.map((shape) => regionBox(shape.surface))
  for (const [s, shape] of shapes.entries()) {
    // (Shaped for the sake of those beside it, if none of it lies in the part itself.)
    if (boxes[s]!.maxX < part.minX - 1 || boxes[s]!.minX > part.maxX + 1 || boxes[s]!.maxY < part.minY - 1 || boxes[s]!.minY > part.maxY + 1) continue
    const { index, carriageway, surface, closed: puddles } = shape
    const mouthRoad = mouthRoads.get(shape.level) ?? []
    const structure = elevation.structures[index]!
    const pieces = onDeck[index]!
    const height = heightOn(shape)
    // Its mouths: the junctions it lands in, and round each landing the width of the road.
    const mouths: Region[] = [grown(merged(regionOf(pieces.mouths)), 0.5), grown(puddles, 1)]
    // And where a deck runs beside it at its own height the two are one: no edge, no parapet between them.
    let edge: Region | null = null
    for (const [o, other] of shapes.entries()) {
      if (o === s || other.level !== shape.level || apart(boxes[o]!, boxes[s]!) > 1) continue
      edge ??= grown(surface, 0.6)
      for (const strip of polygonsOf(common(edge, other.surface))) {
        const ring = strip[0]!
        const step = Math.max(1, Math.floor(ring.length / 8))
        let level = true
        for (let i = 0; i < ring.length && level; i += step) level = Math.abs(levelOn(other)(ring[i]![0], ring[i]![1]) - levelOn(shape)(ring[i]![0], ring[i]![1])) <= LEVEL
        if (level) mouths.push(grown(regionOf([strip]), 1))
      }
    }
    // Nor where its edge runs level with dry ground beside it: at a landing, along the islands in its mouth.
    if (shape.ends.length > 0) {
      const flush: Vec2[][] = []
      const about = (x: number, y: number) => shape.ends.some((end) => Math.hypot(x - end.x, y - end.y) < end.reach + FLUSH_REACH)
      for (const path of surface) {
        let run: Vec2[] = []
        for (let i = 0; i < path.length; i++) {
          const ax = path[i]!.X / 1000
          const ay = path[i]!.Y / 1000
          const bx = path[(i + 1) % path.length]!.X / 1000
          const by = path[(i + 1) % path.length]!.Y / 1000
          const length = Math.hypot(bx - ax, by - ay)
          if (length < 1e-6 || !(about(ax, ay) || about(bx, by))) {
            if (run.length > 1) flush.push(run)
            run = []
            continue
          }
          // Out from the edge: to its right (outlines run anticlockwise, holes clockwise).
          const nx = ((by - ay) / length) * 0.8
          const ny = (-(bx - ax) / length) * 0.8
          const count = Math.max(1, Math.ceil(length / 2))
          for (let k = 0; k <= count; k++) {
            const x = ax + ((bx - ax) * k) / count
            const y = ay + ((by - ay) * k) / count
            if (about(x, y) && waterAt(x + nx, y + ny) === null && Math.abs(height(x + nx, y + ny) - bed(x + nx, y + ny)) < FLUSH) run.push({ x, y })
            else {
              if (run.length > 1) flush.push(run)
              run = []
            }
          }
        }
        if (run.length > 1) flush.push(run)
      }
      if (flush.length > 0) mouths.push(stroked(flush, 2.4))
    }
    const landed: Vec2[] = []
    const lowLines: Vec2[][] = []
    let widest = 0
    for (const id of structure.streets) {
      const street = network.streets[id]!
      const a = network.nodes[street.a]!
      const b = network.nodes[street.b]!
      const section = crossSection(street)
      const outer = Math.max(section.outerLeft, section.outerRight)
      widest = Math.max(widest, outer)
      for (const node of [a, b]) if (landings.has(node.id)) landed.push(node)
      // Low: where the deck is within a man's height of the ground under it (not over water).
      const length = Math.hypot(b.x - a.x, b.y - a.y)
      const along = elevation.heightOf(id)
      const count = Math.max(1, Math.ceil(length / 4))
      let run: Vec2[] = []
      for (let k = 0; k <= count; k++) {
        const x = a.x + ((b.x - a.x) * k) / count
        const y = a.y + ((b.y - a.y) * k) / count
        const low = along((k / count) * length) - bed(x, y) < SOLID && waterAt(x, y) === null
        if (low) run.push({ x, y })
        if ((!low || k === count) && run.length > 0) {
          if (run.length === 1) run.push({ x: run[0]!.x + 0.01, y: run[0]!.y })
          lowLines.push(run)
          run = []
        }
      }
    }
    // Round each landing, the road it lands on (and a little of the deck's own width): open, no parapet across.
    for (const node of landed) {
      const round = widest + 4
      const roadsThere = plan.roads.filter(({ box }) => box.maxX > node.x - round && box.minX < node.x + round && box.maxY > node.y - round && box.minY < node.y + round).map((b) => b.polygon)
      mouths.push(disc(node.x, node.y, widest + EDGE + 0.6), grown(common(merged(regionOf(roadsThere)), disc(node.x, node.y, round)), 0.6))
    }
    const mouth = merged(...mouths)
    // The deck: its surface and an edge beam round it (not across its mouths).
    const outline = merged(surface, without(grown(surface, EDGE), mouth))
    const deck = cut(outline)
    if (deck.length === 0) continue
    let low = lowLines.length > 0 ? common(deck, grown(stroked(lowLines, 2 * widest + 2), 2)) : []
    // And wherever else it's as low over dry ground (out to its sides, where the shore runs slantwise under
    // it): looked for cell by cell, or the bank's blocks would be laid under it there and stand up through it.
    {
      const box = regionBox(deck)
      const cells: Region = []
      for (let cy = box.minY + LOW_CELL / 2; cy < box.maxY; cy += LOW_CELL) {
        for (let cx = box.minX + LOW_CELL / 2; cx < box.maxX; cx += LOW_CELL) {
          if (waterAt(cx, cy) !== null || height(cx, cy) - bed(cx, cy) >= SOLID) continue
          if (!inRegion(deck, cx, cy) || inRegion(low, cx, cy)) continue
          cells.push(...rectangle(cx - LOW_CELL / 2 - 0.3, cy - LOW_CELL / 2 - 0.3, cx + LOW_CELL / 2 + 0.3, cy + LOW_CELL / 2 + 0.3))
        }
      }
      if (cells.length > 0) low = merged(low, common(deck, merged(cells)))
    }
    const high = without(deck, low)
    laidDecks.push({ deck, low })
    const laid = new Laid()
    const flat: Laying = { ...FILL_LAYING, height }
    structures.top(polygonsOf(cut(carriageway)), ROAD, colours.road, { ...ROAD_LAYING, height, record: laid })
    // (Its walkways stop at the road it lands on: closed over its notches, the deck's shape reaches a little over it.)
    const walkways = without(deck, carriageway, mouthRoad)
    structures.top(polygonsOf(walkways), KERB, colours.sidewalk, flat)
    // The kerb's face and the deck's edge, down to its underside; under it, where it's clear of the ground.
    structures.sides(polygonsOf(walkways), KERB, colours.curb, seam, height, (x, y) => height(x, y) - DECK)
    structures.top(polygonsOf(high), -DECK, colours.curb, flat, true)
    // (From the road's own level, and not along the road it lands on: where the deck goes over into the ground's
    // road, nothing stands across it.)
    const landsOn = (ax: number, ay: number, bx: number, by: number) => {
      const length = Math.hypot(bx - ax, by - ay) || 1
      return inRegion(mouthRoad, (ax + bx) / 2 + ((by - ay) / length) * 0.1, (ay + by) / 2 - ((bx - ax) / length) * 0.1)
    }
    structures.sides(polygonsOf(low), ROAD, colours.curb, (ax, ay, bx, by) => seam(ax, ay, bx, by) || (mouthRoad.length > 0 && landsOn(ax, ay, bx, by)), height)
    // Parapets along its edges.
    // Along its outer edges only: not round the notches where a walkway ends short of the road, nor across a mouth.
    const closed = grown(grown(outline, 6), -6)
    // (Not the odd stub left standing between one mouth and the next.)
    const parapet = polygonsOf(cut(without(common(without(outline, grown(outline, -PARAPET_WIDTH)), without(closed, grown(closed, -PARAPET_WIDTH - 0.05))), mouth))).filter((polygon) => blockArea(polygon) > 0.5)
    structures.top(parapet, PARAPET, colours.curb, flat)
    structures.sides(parapet, PARAPET, colours.curb, seam, height, (x, y) => height(x, y) - DECK)
    for (const mark of pieces.marks) {
      const clipped = clipRingPlan(mark.map((p) => [p.x, p.y] as [number, number]), part)
      if (clipped && !(holeRing && clipped.some(([x, y]) => insidePolygon([holeRing], x, y)))) structures.top([[clipped]], PAINT, colours.marking, paintOn(laid, height))
    }
  }
  const solid = merged(...laidDecks.map((d) => d.low))
  // (A paved path that runs through under a deck so low isn't there: the deck is a solid down to the ground.)
  const paving = without(allPaving, solid)
  mark('decks')

  // The blocks between the streets, raised to kerb height: one plane from the kerbs to the buildings (the
  // plan's complement), green where the map has parks and greenery. So the terrain is ours wherever the
  // city is. Open country within town (a big park, the lakefront) gets no fill, but the streets along it
  // keep their pavements: the sidewalk strips of the plan, raised like the fills.
  let land: Region = []
  let green: Region = []
  let footprints: Region = []
  if (ground.town && colours.land) {
    const water = regionOf(polygonsNear(plan.waters))
    footprints = merged(regionOf(polygonsNear(plan.footprints)))
    const blocks = polygonsOf(without(without(whole, hole), road, paving, water, solid))
    const filled: MultiPolygon = []
    const open: MultiPolygon = []
    for (const block of blocks) {
      if (blockArea(block) < 4) continue
      const inside = labelPoint([block])
      if (inside && plan.open(inside.x, inside.y)) open.push(block)
      else filled.push(block)
    }
    const pavements = open.length > 0 ? common(regionOf(open), merged(regionOf(polygonsNear(plan.walks)))) : []
    const raised = pavements.length > 0 ? merged(regionOf(filled), pavements) : regionOf(filled)
    const greenery = merged(regionOf(polygonsNear(plan.greenery)))
    green = common(raised, greenery)
    land = without(raised, greenery)
  }
  mark('blocks')

  const cover: MultiPolygon = polygonsOf(solid)
  const greenFills: MultiPolygon = []
  const paved: MultiPolygon = [...cover]
  /** A surface laid: its top, or `tops` if what's drawn of it differs from what it covers. */
  const lay = (region: Region, lift: number, colour: readonly number[], kind: 'paved' | 'green', laying: Laying, tops?: Region) => {
    if (region.length === 0) return
    const polygons = polygonsOf(region)
    cover.push(...polygons)
    ;(kind === 'green' ? greenFills : paved).push(...polygons)
    writer.top(tops ? polygonsOf(tops) : polygons, lift, colour, laying)
  }
  // The road, with its parking strips and bike lanes laid into it as parts of the one surface (not on top:
  // two surfaces a hair apart show through each other).
  const parking = common(merged(regionOf(polygonsNear(plan.parking))), road)
  const bikes = common(merged(regionOf(polygonsNear(plan.bikes))), road)
  lay(road, ROAD, colours.road, 'paved', roadLaying, without(road, parking, bikes))
  writer.top(polygonsOf(without(parking, bikes)), ROAD, colours.parking, roadLaying)
  writer.top(polygonsOf(bikes), ROAD, colours.bike, roadLaying)
  lay(paving, KERB, colours.sidewalk, 'paved', fillLaying)
  // The blocks' surface is cut round the buildings standing on it, so it meets each wall at its base.
  lay(land, KERB, colours.land ?? colours.sidewalk, 'paved', fillLaying, without(land, footprints))
  lay(green, KERB, colours.green ?? colours.land ?? colours.sidewalk, 'green', fillLaying, without(green, footprints))
  mark('surfaces')
  // Sides: every raised surface is a solid (its kerb faces, and its banks where the land drops away), and so
  // is the plan as a whole, down into the ground. Not along the tile's own edges, where the next tile goes on.
  const raisedLand = merged(land, green, paving)
  writer.sides(polygonsOf(raisedLand), KERB, colours.curb, seam, fillHeight)
  writer.sides(polygonsOf(merged(road, raisedLand)), ROAD, colours.curb, seam, roadHeight)
  // The road's own edge, where it stands clear of what's beside it (on a ramp up to a bridge; a block lower than the road).
  const sunk = (x: number, y: number) => roadHeight(x, y) + ROAD < fillHeight(x, y) + KERB - 0.02
  writer.sides(polygonsOf(road), ROAD, colours.curb, (ax, ay, bx, by) => seam(ax, ay, bx, by) || (sunk(ax, ay) && sunk(bx, by)), roadHeight)
  mark('sides')

  // Lines and zebras on top.
  const paint = paintOn(roadLaid, roadHeight)
  for (const { mark } of near(plan.marks)) {
    // A line can run the length of a long street: cut like the surfaces, not judged by its middle.
    const clipped = clipRingPlan(mark.map((p) => [p.x, p.y] as [number, number]), part)
    if (!clipped) continue
    if (holeRing && clipped.some(([x, y]) => insidePolygon([holeRing], x, y))) continue
    writer.top([[clipped]], PAINT, colours.marking, paint)
  }
  mark('paint')

  // Piers under the decks, where they stand high enough over the ground: a row of them every so often along
  // each bridge street (by where it lies on the map, so both tiles a bridge crosses put them at the same
  // places), not on a road passing under.
  const roadAround = elevation.structures.length > 0 ? merged(regionOf(polygonsNear(plan.roads))) : []
  elevation.structures.forEach((structure) => {
    for (const id of structure.streets) {
      const street = network.streets[id]!
      const a = network.nodes[street.a]!
      const b = network.nodes[street.b]!
      const length = Math.hypot(b.x - a.x, b.y - a.y)
      if (length < 1e-6) continue
      const dx = (b.x - a.x) / length
      const dy = (b.y - a.y) / length
      const from = a.x * dx + a.y * dy
      const along = elevation.heightOf(id)
      const across = Math.min(Math.max(roadHalf(street) * 1.2, 1.6), 6)
      for (let m = Math.ceil(from / PIER_EVERY); m * PIER_EVERY <= from + length; m++) {
        const s = m * PIER_EVERY - from
        const x = a.x + dx * s
        const y = a.y + dy * s
        if (!kept(x, y)) continue
        const lon = ((tile.x + x / metres) / n) * 360 - 180
        const lat = tileLat(tile.y - y / metres, tile.z)
        const surface = waterAt(x, y)
        const under = surface ?? bed(x, y)
        const head = along(s) - DECK
        if (head - under < PIER_FROM) continue
        const corners: [number, number][] = [
          [x - dy * across - dx * 0.55, y + dx * across - dy * 0.55],
          [x + dy * across - dx * 0.55, y - dx * across - dy * 0.55],
          [x + dy * across + dx * 0.55, y - dx * across + dy * 0.55],
          [x - dy * across + dx * 0.55, y + dx * across + dy * 0.55],
        ]
        // Not standing in a road under the bridge.
        if ([[x, y] as [number, number], ...corners].some(([px, py]) => inRegion(roadAround, px, py))) continue
        structures.box(corners, (surface !== null ? ground.at(lon, lat) : under) - 1, head, colours.curb)
      }
    }
  })
  // Railway bridges and footbridges: a plain deck each, on abutments where it ends up in the air.
  spans.forEach((span, index) => {
    const taken = spanTaken[index]!
    if (!spanNear[index] || taken.every((t) => t === 1)) return
    const along = elevation.spans[index]!
    const field = new LineField(4, true)
    let walked = 0
    const lowLines: Vec2[][] = []
    let run: Vec2[] = []
    for (let i = 0; i + 1 < span.points.length; i++) {
      const p = span.points[i]!
      const q = span.points[i + 1]!
      const length = Math.hypot(q.x - p.x, q.y - p.y)
      if (length < 1e-6) continue
      const start = walked
      field.add({ ax: p.x, ay: p.y, bx: q.x, by: q.y, half: span.width / 2, height: (s) => along(start + s) })
      const count = Math.max(1, Math.ceil(length / 4))
      for (let k = 0; k <= count; k++) {
        const x = p.x + ((q.x - p.x) * k) / count
        const y = p.y + ((q.y - p.y) * k) / count
        const low = along(start + (length * k) / count) - bed(x, y) < SOLID / 2 && waterAt(x, y) === null
        if (low) run.push({ x, y })
        else if (run.length > 0) {
          if (run.length > 1) lowLines.push(run)
          run = []
        }
      }
      walked += length
    }
    if (run.length > 1) lowLines.push(run)
    // What a street's bridge hasn't taken of it.
    const runs: Vec2[][] = []
    let left: Vec2[] = []
    for (let k = 0; k < taken.length; k++) {
      if (!taken[k]) {
        if (left.length === 0) left.push(span.points[k]!)
        left.push(span.points[k + 1]!)
      } else if (left.length > 0) {
        runs.push(left)
        left = []
      }
    }
    if (left.length > 0) runs.push(left)
    const height: HeightOn = (x, y) => field.at(x, y, bed)
    let own = stroked(runs, span.width)
    // Where it only crosses a street on the level (on a street's bridge, or on the ground) it's no deck: a crossing.
    const box = regionBox(own)
    for (const [s, shape] of shapes.entries()) {
      if (apart(boxes[s]!, box) > 0) continue
      const over = common(own, shape.surface)[0]?.[0]
      if (over && Math.abs(height(over.X / 1000, over.Y / 1000) - heightOn(shape)(over.X / 1000, over.Y / 1000)) < 1) own = without(own, shape.surface)
    }
    if (lowLines.length > 0) own = without(own, common(road, stroked(lowLines, span.width + 2)))
    const deck = cut(own)
    if (deck.length === 0) return
    const flat: Laying = { ...FILL_LAYING, height }
    const depth = span.kind === 'path' || span.kind === 'track' ? 0.45 : DECK
    const low = lowLines.length > 0 ? common(deck, stroked(lowLines, span.width + 2)) : []
    const high = without(deck, low)
    structures.top(polygonsOf(deck), 0, span.kind === 'rail' ? colours.road : colours.sidewalk, flat)
    structures.top(polygonsOf(high), -depth, colours.curb, flat, true)
    structures.sides(polygonsOf(high), 0, colours.curb, seam, height, (x, y) => height(x, y) - depth)
    structures.sides(polygonsOf(low), 0, colours.curb, seam, height)
    // An end left in the air (it had to clear something right at its landing) stands on an abutment.
    for (const [end, next, s] of [
      [span.points[0]!, span.points[1]!, 0],
      [span.points[span.points.length - 1]!, span.points[span.points.length - 2]!, walked],
    ] as const) {
      const base = bed(end.x, end.y)
      if (along(s) - base < 0.8 || !kept(end.x, end.y) || taken[s === 0 ? 0 : taken.length - 1]) continue
      const l = Math.hypot(next.x - end.x, next.y - end.y) || 1
      const dx = (next.x - end.x) / l
      const dy = (next.y - end.y) / l
      const w = span.width / 2
      structures.box(
        [
          [end.x - dy * w, end.y + dx * w],
          [end.x + dy * w, end.y - dx * w],
          [end.x + dy * w + dx * 1.2, end.y - dx * w + dy * 1.2],
          [end.x - dy * w + dx * 1.2, end.y + dx * w + dy * 1.2],
        ],
        base - 1,
        along(s) - depth,
        colours.curb,
      )
    }
  })
  mark('bridges')
  return { mesh: writer.finish(), structures: structures.finish(), cover, greenFills, paved }
}

/** A bridge that isn't a street: a railway's, a footbridge. */
interface Span {
  points: Vec2[]
  level: number
  kind: RoadKind
  width: number
  /** Its bounds on the plan (grown by its width). */
  box: PlanRect
}

/** Bridges mapped in pieces joined end to end into one each (by kind and level), so a viaduct is one deck. */
function chained(spans: readonly Span[]): Span[] {
  const key = (p: Vec2, span: Span) => `${Math.round(p.x * 10)}:${Math.round(p.y * 10)}:${span.kind}:${span.level}`
  const ends = new Map<string, number[]>()
  spans.forEach((span, i) => {
    for (const p of [span.points[0]!, span.points[span.points.length - 1]!]) {
      const k = key(p, span)
      const list = ends.get(k)
      if (list) list.push(i)
      else ends.set(k, [i])
    }
  })
  const used = new Uint8Array(spans.length)
  const out: Span[] = []
  spans.forEach((span, i) => {
    if (used[i]) return
    used[i] = 1
    let points = [...span.points]
    // On from each end while exactly one other piece carries on from there.
    for (const forwards of [true, false]) {
      for (let guard = 0; guard < 1000; guard++) {
        const end = forwards ? points[points.length - 1]! : points[0]!
        const next = (ends.get(key(end, span)) ?? []).filter((j) => !used[j])
        if (next.length !== 1) break
        const other = spans[next[0]!]!
        used[next[0]!] = 1
        const first = other.points[0]!
        const starts = Math.hypot(first.x - end.x, first.y - end.y) < 0.2
        const more = starts ? other.points.slice(1) : [...other.points].reverse().slice(1)
        points = forwards ? [...points, ...more] : [...more.reverse(), ...points]
      }
    }
    const box = boundsOf(points.map((q) => [q.x, q.y]))
    out.push({ ...span, points, box: { minX: box.minX - span.width, maxX: box.maxX + span.width, minY: box.minY - span.width, maxY: box.maxY + span.width } })
  })
  return out
}

const EVERYWHERE: PlanRect = { minX: -Infinity, maxX: Infinity, minY: -Infinity, maxY: Infinity }

/** A polygon with its bounds on the plan, for picking out what lies near a part of the tile. */
interface Boxed {
  polygon: MultiPolygon[number]
  box: PlanRect
}

function boundsOf(ring: readonly (readonly [number, number])[] | readonly number[][]): PlanRect {
  const box = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity }
  for (const p of ring) {
    if (p[0]! < box.minX) box.minX = p[0]!
    if (p[0]! > box.maxX) box.maxX = p[0]!
    if (p[1]! < box.minY) box.minY = p[1]!
    if (p[1]! > box.maxY) box.maxY = p[1]!
  }
  return box
}

/** Whether a line runs along the nearest of some segments (within half a right angle of it, by its middle), not across it. */
function alongside(line: readonly Vec2[], segments: readonly (readonly [Vec2, Vec2])[]): boolean {
  if (line.length < 2 || segments.length === 0) return true
  let length = 0
  for (let i = 1; i < line.length; i++) length += Math.hypot(line[i]!.x - line[i - 1]!.x, line[i]!.y - line[i - 1]!.y)
  // Its middle, and the way it runs there.
  let walked = 0
  let mid = line[0]!
  let way = { x: line[1]!.x - line[0]!.x, y: line[1]!.y - line[0]!.y }
  for (let i = 1; i < line.length; i++) {
    const step = Math.hypot(line[i]!.x - line[i - 1]!.x, line[i]!.y - line[i - 1]!.y)
    if (walked + step >= length / 2 && step > 1e-9) {
      const t = (length / 2 - walked) / step
      mid = { x: line[i - 1]!.x + (line[i]!.x - line[i - 1]!.x) * t, y: line[i - 1]!.y + (line[i]!.y - line[i - 1]!.y) * t }
      way = { x: line[i]!.x - line[i - 1]!.x, y: line[i]!.y - line[i - 1]!.y }
      break
    }
    walked += step
  }
  let nearest = Infinity
  let cos = 1
  for (const [a, b] of segments) {
    const dx = b.x - a.x
    const dy = b.y - a.y
    const span = Math.hypot(dx, dy)
    if (span < 1e-9) continue
    const t = Math.max(0, Math.min(1, ((mid.x - a.x) * dx + (mid.y - a.y) * dy) / (span * span)))
    const d = Math.hypot(mid.x - a.x - dx * t, mid.y - a.y - dy * t)
    if (d < nearest) {
      nearest = d
      cos = Math.abs(dx * way.x + dy * way.y) / (span * Math.hypot(way.x, way.y) || 1)
    }
  }
  return cos > Math.SQRT1_2
}

const smoothstep = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t))

/** A region's bounds on the plan. */
function regionBox(region: Region): PlanRect {
  const box = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity }
  for (const path of region) {
    for (const p of path) {
      if (p.X < box.minX) box.minX = p.X
      if (p.X > box.maxX) box.maxX = p.X
      if (p.Y < box.minY) box.minY = p.Y
      if (p.Y > box.maxY) box.maxY = p.Y
    }
  }
  return { minX: box.minX / 1000, maxX: box.maxX / 1000, minY: box.minY / 1000, maxY: box.maxY / 1000 }
}

/** How far apart two rectangles are (0 if they meet). */
const apart = (a: PlanRect, b: PlanRect): number => Math.max(a.minX - b.maxX, b.minX - a.maxX, a.minY - b.maxY, b.minY - a.maxY, 0)

const boxed = (polygons: MultiPolygon): Boxed[] => polygons.filter((polygon) => polygon[0] && polygon[0].length >= 3).map((polygon) => ({ polygon, box: boundsOf(polygon[0]!) }))

/** The blocks' picture is this fine (metres a cell). */
const BLOCK_CELL = 2.5

/**
 * Which of a tile's blocks are open country: bigger than OPEN_BLOCK with next to nothing built on them (a
 * big park, the lakefront, a railway yard). Worked out on a coarse picture of the tile: the roads, the
 * water and the paving drawn in, what's left between them flooded block by block and each block's size and
 * buildings counted. Returns whether the block at a point of the plan is open.
 */
function openBlocks(
  metres: number,
  roads: readonly { a: Vec2; b: Vec2; half: number }[],
  /** Water and paving: not part of any block. */
  apart: MultiPolygon,
  footprints: MultiPolygon,
): (x: number, y: number) => boolean {
  const size = Math.ceil(metres / BLOCK_CELL)
  // 1: not a block's (road, water, paving); 2: built on.
  const cells = new Uint8Array(size * size)
  const column = (x: number) => Math.floor(x / BLOCK_CELL)
  const row = (y: number) => Math.floor(-y / BLOCK_CELL)
  const fill = (polygon: MultiPolygon[number], value: number, only = 0) => {
    const box = boundsOf(polygon[0]!)
    const crossings: number[] = []
    for (let r = Math.max(0, row(box.maxY)); r <= Math.min(size - 1, row(box.minY)); r++) {
      const y = -(r + 0.5) * BLOCK_CELL
      crossings.length = 0
      for (const ring of polygon) {
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const [xi, yi] = ring[i]!
          const [xj, yj] = ring[j]!
          if (yi > y !== yj > y) crossings.push(xi + ((y - yi) / (yj - yi)) * (xj - xi))
        }
      }
      crossings.sort((p, q) => p - q)
      for (let k = 0; k + 1 < crossings.length; k += 2) {
        const from = Math.max(0, Math.ceil(crossings[k]! / BLOCK_CELL - 0.5))
        const to = Math.min(size - 1, Math.floor(crossings[k + 1]! / BLOCK_CELL - 0.5))
        for (let c = from; c <= to; c++) if (cells[r * size + c] === only) cells[r * size + c] = value
      }
    }
  }
  for (const polygon of apart) fill(polygon, 1)
  for (const { a, b, half } of roads) {
    const reach = half + BLOCK_CELL * 0.75
    const dx = b.x - a.x
    const dy = b.y - a.y
    const l = dx * dx + dy * dy
    for (let r = Math.max(0, row(Math.max(a.y, b.y) + reach)); r <= Math.min(size - 1, row(Math.min(a.y, b.y) - reach)); r++) {
      for (let c = Math.max(0, column(Math.min(a.x, b.x) - reach)); c <= Math.min(size - 1, column(Math.max(a.x, b.x) + reach)); c++) {
        const x = (c + 0.5) * BLOCK_CELL
        const y = -(r + 0.5) * BLOCK_CELL
        const t = l === 0 ? 0 : Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / l))
        if (Math.hypot(x - a.x - dx * t, y - a.y - dy * t) <= reach) cells[r * size + c] = 1
      }
    }
  }
  for (const polygon of footprints) fill(polygon, 2)
  // The blocks: what's left, flooded from each free cell; each one's size and how much of it is built on.
  const block = new Int32Array(size * size).fill(-1)
  const open: boolean[] = []
  const stack: number[] = []
  for (let start = 0; start < cells.length; start++) {
    if (cells[start] === 1 || block[start] !== -1) continue
    const id = open.length
    let area = 0
    let built = 0
    block[start] = id
    stack.push(start)
    while (stack.length > 0) {
      const cell = stack.pop()!
      area++
      if (cells[cell] === 2) built++
      const c = cell % size
      if (c > 0 && cells[cell - 1] !== 1 && block[cell - 1] === -1) {
        block[cell - 1] = id
        stack.push(cell - 1)
      }
      if (c < size - 1 && cells[cell + 1] !== 1 && block[cell + 1] === -1) {
        block[cell + 1] = id
        stack.push(cell + 1)
      }
      if (cell >= size && cells[cell - size] !== 1 && block[cell - size] === -1) {
        block[cell - size] = id
        stack.push(cell - size)
      }
      if (cell < cells.length - size && cells[cell + size] !== 1 && block[cell + size] === -1) {
        block[cell + size] = id
        stack.push(cell + size)
      }
    }
    open.push(area * BLOCK_CELL * BLOCK_CELL >= OPEN_BLOCK && built / area < BUILT)
  }
  return (x, y) => {
    const c = Math.min(Math.max(column(x), 0), size - 1)
    const r = Math.min(Math.max(row(y), 0), size - 1)
    // The block there, or (the point being on a road's edge in this coarse picture) the one beside it.
    for (const [dc, dr] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]] as const) {
      const cc = c + dc
      const rr = r + dr
      if (cc < 0 || rr < 0 || cc >= size || rr >= size) continue
      const id = block[rr * size + cc]!
      if (id >= 0) return open[id]!
    }
    return false
  }
}

/**
 * A region without its holes smaller than an area (square metres): an island too small to stand on is road.
 */
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

  constructor(tile: TileId, metres: number, bed: HeightOn) {
    this.tile = tile
    this.metres = metres
    this.frame = tileFrame(tile)
    this.bed = bed
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
      const { points, triangles } = triangulate(polygon)
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
