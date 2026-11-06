import type { AreaKind, Line, RoadKind, Shape, TileFeatures } from './features.ts'
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
  },
  road: '#d3d1cc',
  majorRoad: '#cfcdc8',
  path: '#dcdad5',
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

  fillShapes(
    features.buildings.filter((b) => b.minHeight === 0).map((b) => b.shape),
    style.building,
  )

  // Roads by layer, then the bigger over the smaller; tunnels are left out.
  const roads = features.roads
    .filter((r) => !r.tunnel)
    .sort((a, b) => a.layer - b.layer || ROAD_ORDER.indexOf(a.kind) - ROAD_ORDER.indexOf(b.kind))
  for (const road of roads) {
    const rail = road.kind === 'rail'
    const width = (rail ? 1.4 : road.width) / metresPerPixel
    const smallest = MAJOR.has(road.kind) ? 0.9 : road.kind === 'path' || road.kind === 'track' ? 0.35 : 0.5
    if (width < smallest * 0.35) continue
    context.lineWidth = Math.max(width, smallest)
    context.strokeStyle = rail ? style.rail : MAJOR.has(road.kind) ? style.majorRoad : road.kind === 'path' || road.kind === 'track' ? style.path : style.road
    context.beginPath()
    trace(road.line, false)
    context.stroke()
  }
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
): void {
  for (const kind of AREA_ORDER) {
    // Plain land kinds stay transparent: the site's ground shows through.
    if (kind === 'residential' || kind === 'commercial' || kind === 'industrial' || kind === 'farmland') continue
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
