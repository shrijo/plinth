import type { AreaKind, Line, RoadFeature, RoadKind, Shape, TileFeatures } from './features.ts'
import { propsOf } from './streets.ts'
import { SIDEWALK, TOWN_STREETS } from './ground.ts'
import { tileWidth } from './mesh.ts'
import type { TileId } from './tiles.ts'

/**
 * The ground's picture for a tile: land, water, parks and woods, roads and
 * railways and the outlines of buildings, painted from map data onto a
 * canvas that becomes the tile's texture. The colours are the model's
 * pale greys, with only a hint of green and blue.
 */

export interface GroundStyle {
  land: string
  areas: Record<AreaKind, string>
  road: string
  majorRoad: string
  sidewalk: string
  curb: string
  marking: string
  path: string
  rail: string
  building: string
}

export const GROUND_STYLE: GroundStyle = {
  land: '#e6e5e1',
  areas: {
    water: '#cdd6dc',
    park: '#dfe2d8',
    grass: '#e0e3d9',
    wood: '#d8ddd1',
    farmland: '#e8e7e1',
    residential: '#e2e1dd',
    commercial: '#e0dfdb',
    industrial: '#dedcd8',
    sport: '#dde1d8',
    cemetery: '#dcdfd6',
    ice: '#f3f4f4',
    sand: '#ebe8de',
    rock: '#dedcd7',
    wetland: '#dbe0da',
    airport: '#e1e0dc',
    runway: '#d3d1cc',
    square: '#eeede8',
  },
  // As the site editor's streets: grey asphalt, pale sidewalks with a curb, white paint.
  road: '#d0cec9',
  majorRoad: '#cbc9c4',
  // As the raised block fills near by: in town the pavement is the blocks' plane.
  sidewalk: '#e3dfd3',
  curb: '#d9d7d1',
  marking: '#fbfbf9',
  path: '#eceae5',
  rail: '#c4c2bd',
  building: '#dedcd7',
}

type Context = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D

/** Areas are painted in this order: later ones over earlier ones (water last). */
const AREA_ORDER: AreaKind[] = [
  'farmland',
  'residential',
  'commercial',
  'industrial',
  'airport',
  'wood',
  'grass',
  'park',
  'sport',
  'cemetery',
  'wetland',
  'sand',
  'rock',
  'ice',
  'runway',
  'square',
  'water',
]

const ROAD_ORDER: RoadKind[] = ['path', 'track', 'pier', 'service', 'minor', 'tertiary', 'secondary', 'primary', 'trunk', 'motorway']
const MAJOR = new Set<RoadKind>(['primary', 'trunk', 'motorway', 'secondary'])

/**
 * Paints `target`'s ground onto a square canvas of `size` pixels, from the
 * features of a tile at its zoom or above it (a tile of the finest data
 * covers its children: they show its part, in more detail).
 */
export function paintGround(context: Context, size: number, target: TileId, features: TileFeatures | null, style: GroundStyle): void {
  context.fillStyle = style.land
  context.fillRect(0, 0, size, size)
  if (!features) return
  const source = features.tile
  const scale = 2 ** (target.z - source.z)
  const offsetX = target.x - source.x * scale
  const offsetY = target.y - source.y * scale
  const px = (u: number) => (u * scale - offsetX) * size
  const py = (v: number) => (v * scale - offsetY) * size
  const metresPerPixel = tileWidth(target) / size

  const trace = (line: Line, close: boolean) => {
    context.moveTo(px(line[0]!), py(line[1]!))
    for (let i = 2; i < line.length; i += 2) context.lineTo(px(line[i]!), py(line[i + 1]!))
    if (close) context.closePath()
  }
  const fillShapes = (shapes: Shape[], colour: string) => {
    if (shapes.length === 0) return
    context.beginPath()
    for (const shape of shapes) {
      trace(shape.outer, true)
      for (const hole of shape.holes) trace(hole, true)
    }
    context.fillStyle = colour
    context.fill('evenodd')
  }

  for (const kind of AREA_ORDER) {
    fillShapes(
      features.areas.filter((a) => a.kind === kind).map((a) => a.shape),
      style.areas[kind],
    )
  }

  context.lineJoin = 'round'
  context.lineCap = 'round'
  context.strokeStyle = style.areas.water
  for (const river of features.waterways) {
    const width = river.width / metresPerPixel
    if (width < 0.25) continue
    context.lineWidth = Math.max(width, 0.6)
    context.beginPath()
    trace(river.line, false)
    context.stroke()
  }

  paintStreets(context, features, target, metresPerPixel, style, trace)

  // Footprints last: the buildings stand on them, and sidewalks run up to their walls.
  fillShapes(
    features.buildings.filter((b) => b.minHeight === 0).map((b) => b.shape),
    style.building,
  )
}

/** Below this zoom bridges are painted; from it on they are built (see buildingMesh). */
const BRIDGE_ZOOM = 14
/** From this zoom streets are built in 3D (see streets.ts): the picture keeps only plain asphalt under them. */
const STREETS_3D_ZOOM = 16

/** Under a 3D street: its lanes at their narrowest (2.5 m), or the road's usual width if it isn't built in 3D. */
function plainWidth(road: RoadFeature, town: boolean): number {
  if (road.tunnel) return 0
  const props = propsOf(road, town)
  return props ? props.lanes * 2.5 : road.width
}

/**
 * Streets as layered decals, the way games lay roads over terrain: every
 * street's sidewalks first, then the curbs, then the asphalt, then the
 * paint, so junctions merge into one surface. Detail comes in as it
 * becomes visible: sidewalks and curbs once a pixel is under a couple of
 * metres, lane lines once it's under half a metre.
 */
function paintStreets(
  context: Context,
  features: TileFeatures,
  target: TileId,
  metresPerPixel: number,
  style: GroundStyle,
  trace: (line: Line, close: boolean) => void,
): void {
  const town = features.buildings.length > 150
  const order = (a: RoadFeature, b: RoadFeature) => a.layer - b.layer || ROAD_ORDER.indexOf(a.kind) - ROAD_ORDER.indexOf(b.kind)
  const roads = features.roads.filter((r) => !r.tunnel && !(r.bridge && target.z >= BRIDGE_ZOOM)).sort(order)
  const streets = roads.filter((r) => r.kind !== 'path' && r.kind !== 'track' && r.kind !== 'rail' && r.kind !== 'pier')
  const stroke = (road: RoadFeature, width: number, colour: string, least = 0) => {
    const pixels = width / metresPerPixel
    if (pixels < least * 0.35) return
    context.lineWidth = Math.max(pixels, least)
    context.strokeStyle = colour
    context.beginPath()
    trace(road.line, false)
    context.stroke()
  }
  context.lineJoin = 'round'
  context.lineCap = 'round'
  context.setLineDash([])

  // Paths and tracks first: everything else goes over them.
  for (const road of roads) if (road.kind === 'path' || road.kind === 'track' || road.kind === 'pier') stroke(road, road.width, style.path, 0.35)
  const plain = target.z >= STREETS_3D_ZOOM
  const sidewalks = town && metresPerPixel < 2 && !plain
  if (sidewalks) {
    for (const road of streets) if (TOWN_STREETS.has(road.kind)) stroke(road, road.width + SIDEWALK * 2, style.sidewalk)
  }
  if (metresPerPixel < 0.8 && !plain) for (const road of streets) stroke(road, road.width + 0.5, style.curb)
  for (const road of streets) {
    // Under the 3D streets only a strip no wider than their narrowest road, so none shows past their kerbs.
    const width = plain ? plainWidth(road, town) : road.width
    if (width > 0) stroke(road, width, MAJOR.has(road.kind) ? style.majorRoad : style.road, MAJOR.has(road.kind) ? 0.9 : 0.5)
  }
  for (const road of roads) if (road.kind === 'rail') stroke(road, 1.6, style.rail, 0.6)

  if (metresPerPixel > 0.5 || plain) return
  // Lane lines: dashed down the middle of two-way streets, solid along the edges of the big ones.
  const line = Math.max(0.15 / metresPerPixel, 1)
  context.strokeStyle = style.marking
  for (const road of streets) {
    if (road.width < 7 || road.kind === 'service') continue
    if (MAJOR.has(road.kind)) {
      // Edge lines: a stroke as wide as the road less a margin, its middle painted over again.
      context.setLineDash([])
      context.lineCap = 'round'
      context.strokeStyle = style.marking
      context.lineWidth = (road.width - 0.6) / metresPerPixel
      context.beginPath()
      trace(road.line, false)
      context.stroke()
      context.lineWidth = (road.width - 0.6) / metresPerPixel - 2 * line
      context.strokeStyle = style.majorRoad
      context.beginPath()
      trace(road.line, false)
      context.stroke()
    }
    context.strokeStyle = style.marking
    context.lineWidth = line
    context.lineCap = 'butt'
    context.setLineDash([3 / metresPerPixel, 6 / metresPerPixel])
    context.beginPath()
    trace(road.line, false)
    context.stroke()
    context.setLineDash([])
  }
  context.setLineDash([])
  context.lineCap = 'round'
}

/**
 * Water and green areas only, on a transparent canvas: for laying over a
 * site's own terrain, which has its own streets and buildings. `place`
 * gives the affine map from each tile's units to the canvas's pixels.
 */
export function paintAreas(
  context: Context,
  tiles: readonly TileFeatures[],
  place: (tile: TileId) => [a: number, b: number, c: number, d: number, e: number, f: number],
  style: GroundStyle,
  /** Kinds drawn some other way, left out (and transparent). */
  leaveOut: ReadonlySet<string> = new Set(),
): void {
  for (const kind of AREA_ORDER) {
    // Plain land kinds stay transparent: the site's ground shows through.
    if (kind === 'residential' || kind === 'commercial' || kind === 'industrial' || kind === 'farmland' || leaveOut.has(kind)) continue
    context.fillStyle = style.areas[kind]
    for (const data of tiles) {
      const shapes = data.areas.filter((a) => a.kind === kind)
      if (shapes.length === 0) continue
      context.setTransform(...place(data.tile))
      context.beginPath()
      for (const { shape } of shapes) {
        for (const ring of [shape.outer, ...shape.holes]) {
          context.moveTo(ring[0]!, ring[1]!)
          for (let i = 2; i < ring.length; i += 2) context.lineTo(ring[i]!, ring[i + 1]!)
          context.closePath()
        }
      }
      context.fill('evenodd')
    }
  }
  context.setTransform(1, 0, 0, 1, 0, 0)
}
