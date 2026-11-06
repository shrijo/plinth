import type { RoadFeature, Shape, TileFeatures } from './features.ts'
import { insideRing } from './clip.ts'
import { tileWidth } from './mesh.ts'
import type { HeightTile } from './terrarium.ts'
import { tileLat, type TileId } from './tiles.ts'

/**
 * The ground as the world is built on it: the elevation data, smoothed
 * (in cities the open elevation data has buildings and trees in it, so
 * streets would bump over them), with a level bed along each street, the
 * way open-world games shape their terrain to their roads (landscape
 * splines in Unreal, Unigine's road tool): flat across, following the
 * land along it, blending back into the land beside it. Water lies at a
 * level of its own, over a basin. Every tile and every building is built
 * on the same ground, so they meet.
 */

/** Sidewalks either side of town streets, in metres. */
export const SIDEWALK = 2.5
/** Kinds of road with sidewalks in town. */
export const TOWN_STREETS = new Set(['minor', 'tertiary', 'secondary', 'primary'])
/** Over this far beyond its edge (metres) a road's bed blends back into the land. */
const FALLOFF = 7
/** Smoothing of the land, and of a road's bed (radius, metres). */
const LAND_SMOOTHING = 8
const BED_SMOOTHING = 18
/**
 * A water surface is the land's height smoothed this widely (metres): flat
 * enough on a lake, following a river down its valley, and the same
 * wherever it's asked, so a lake cut across tiles meets itself.
 */
const WATER_SMOOTHING = 45

export interface Ground {
  /** The ground's height at a point, metres above sea level. */
  at(lon: number, lat: number): number
  /** Water there: the height of its surface, or null on land. */
  waterAt(lon: number, lat: number): number | null
  /** The height a water surface has at a point (whether or not there's water). */
  surface(lon: number, lat: number): number
  /** The water in the map data (tile units of `source`). */
  water: Shape[]
  source: TileId | null
  /** Whether the tile is town (it has many buildings): streets get sidewalks. */
  town: boolean
}

interface Segment {
  ax: number
  ay: number
  bx: number
  by: number
  half: number
}

/**
 * The ground for a part of the world, from heights (the finest tile there)
 * and map data (the tile of the finest zoom over it, for its streets and
 * water; none far out, where the land is just the heights).
 */
export function makeGround(heights: readonly HeightTile[], features: TileFeatures | null, options: { roads?: boolean } = {}): Ground {
  const raw = mosaic(heights)
  // Metres to degrees here (east, north): good enough over the few metres the smoothing reaches.
  const lat0 = heights[0] ? tileLat(heights[0].tile.y + 0.5, heights[0].tile.z) : 0
  const degNorth = 1 / 111320
  const degEast = 1 / (111320 * Math.max(Math.cos((lat0 * Math.PI) / 180), 0.01))
  const smooth = (lon: number, lat: number, r: number) => {
    let sum = raw(lon, lat) * 2
    let weight = 2
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4
      sum += raw(lon + Math.cos(a) * r * degEast, lat + Math.sin(a) * r * degNorth)
      weight++
    }
    return sum / weight
  }

  const source = features?.tile ?? null
  const water: Shape[] = features ? features.areas.filter((a) => a.kind === 'water').map((a) => a.shape) : []
  const boxes = water.map((shape) => {
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity]
    for (let i = 0; i < shape.outer.length; i += 2) {
      x0 = Math.min(x0, shape.outer[i]!)
      x1 = Math.max(x1, shape.outer[i]!)
      y0 = Math.min(y0, shape.outer[i + 1]!)
      y1 = Math.max(y1, shape.outer[i + 1]!)
    }
    return [x0, y0, x1, y1] as const
  })

  // Streets, in metres in the source tile (indexed in a grid of cells), with their half widths.
  const segments: Segment[] = []
  const cells = new Map<number, number[]>()
  const CELLS = 32
  let metres = 1
  let town = false
  if (features && source && options.roads !== false) {
    metres = tileWidth(source)
    town = features.buildings.length > 150
    const reach = (road: RoadFeature) => road.width / 2 + (town && TOWN_STREETS.has(road.kind) ? SIDEWALK : 0)
    for (const road of features.roads) {
      if (road.tunnel || road.bridge || road.kind === 'path' || road.kind === 'track' || road.kind === 'pier') continue
      const half = reach(road)
      const line = road.line
      for (let i = 0; i + 3 < line.length; i += 2) {
        const s = { ax: line[i]! * metres, ay: line[i + 1]! * metres, bx: line[i + 2]! * metres, by: line[i + 3]! * metres, half }
        const index = segments.push(s) - 1
        const pad = half + FALLOFF
        const cell = metres / CELLS
        const x0 = Math.floor((Math.min(s.ax, s.bx) - pad) / cell)
        const x1 = Math.floor((Math.max(s.ax, s.bx) + pad) / cell)
        const y0 = Math.floor((Math.min(s.ay, s.by) - pad) / cell)
        const y1 = Math.floor((Math.max(s.ay, s.by) + pad) / cell)
        for (let y = y0; y <= y1; y++) {
          for (let x = x0; x <= x1; x++) {
            if (x < -2 || y < -2 || x > CELLS + 1 || y > CELLS + 1) continue
            const key = (y + 4) * 64 + (x + 4)
            const list = cells.get(key)
            if (list) list.push(index)
            else cells.set(key, [index])
          }
        }
      }
    }
  }

  const n = source ? 2 ** source.z : 1
  const toSource = (lon: number, lat: number): [number, number] => {
    const x = ((lon + 180) / 360) * n - source!.x
    const φ = (lat * Math.PI) / 180
    const y = ((1 - Math.log(Math.tan(φ) + 1 / Math.cos(φ)) / Math.PI) / 2) * n - source!.y
    return [x, y]
  }
  const fromSource = (x: number, y: number): [number, number] => {
    const lon = ((source!.x + x) / n) * 360 - 180
    return [lon, tileLat(source!.y + y, source!.z)]
  }

  const at = (lon: number, lat: number): number => {
    const land = smooth(lon, lat, LAND_SMOOTHING)
    if (segments.length === 0) return land
    const [u, v] = toSource(lon, lat)
    const px = u * metres
    const py = v * metres
    const cell = metres / CELLS
    const list = cells.get((Math.floor(py / cell) + 4) * 64 + (Math.floor(px / cell) + 4))
    if (!list) return land
    // The road whose bed reaches here most strongly.
    let best = 0
    let bx = 0
    let by = 0
    for (const index of list) {
      const s = segments[index]!
      const dx = s.bx - s.ax
      const dy = s.by - s.ay
      const l = dx * dx + dy * dy
      const t = l === 0 ? 0 : Math.max(0, Math.min(1, ((px - s.ax) * dx + (py - s.ay) * dy) / l))
      const qx = s.ax + dx * t
      const qy = s.ay + dy * t
      const d = Math.hypot(px - qx, py - qy)
      if (d > s.half + FALLOFF) continue
      const w = d <= s.half ? 1 : smoothstep(1 - (d - s.half) / FALLOFF)
      if (w > best) {
        best = w
        bx = qx
        by = qy
      }
    }
    if (best === 0) return land
    // Level across: the bed's height is the land's at the middle of the road, smoothed along it.
    const [qlon, qlat] = fromSource(bx / metres, by / metres)
    const bed = smooth(qlon, qlat, BED_SMOOTHING)
    return land + (bed - land) * best
  }

  const waterAt = (lon: number, lat: number): number | null => {
    if (water.length === 0) return null
    const [u, v] = toSource(lon, lat)
    for (let i = 0; i < water.length; i++) {
      const [x0, y0, x1, y1] = boxes[i]!
      if (u < x0 || u > x1 || v < y0 || v > y1) continue
      const shape = water[i]!
      if (insideRing(shape.outer, u, v) && !shape.holes.some((h) => insideRing(h, u, v))) return surface(lon, lat)
    }
    return null
  }

  /** The water's surface: the land under and round it, smoothed widely (two rings), and never below the sea. */
  const surface = (lon: number, lat: number): number => {
    let sum = raw(lon, lat)
    let weight = 1
    for (const r of [WATER_SMOOTHING * 0.5, WATER_SMOOTHING]) {
      for (let k = 0; k < 8; k++) {
        const a = (k * Math.PI) / 4 + r * 0.01
        sum += raw(lon + Math.cos(a) * r * degEast, lat + Math.sin(a) * r * degNorth)
        weight++
      }
    }
    return sum / weight
  }

  return { at, waterAt, surface, water, source, town }
}

function smoothstep(t: number): number {
  const x = Math.min(Math.max(t, 0), 1)
  return x * x * (3 - 2 * x)
}

/**
 * Heights from several tiles of one zoom as one picture: bilinear between
 * pixel centres across tile edges too, so a point has the same height
 * whichever tiles are asked. Outside them, the nearest pixel there is.
 */
export function mosaic(heights: readonly HeightTile[]): (lon: number, lat: number) => number {
  if (heights.length === 0) return () => 0
  const z = heights[0]!.tile.z
  const size = heights[0]!.size
  const n = 2 ** z
  const tx0 = Math.min(...heights.map((t) => t.tile.x))
  const ty0 = Math.min(...heights.map((t) => t.tile.y))
  const cols = Math.max(...heights.map((t) => t.tile.x)) - tx0 + 1
  const rows = Math.max(...heights.map((t) => t.tile.y)) - ty0 + 1
  // The tiles in a grid by their place, first come first served; gaps take the first tile.
  const grid: (HeightTile | undefined)[] = new Array(cols * rows)
  for (const tile of heights) {
    if (tile.tile.z !== z || tile.size !== size) continue
    const k = (tile.tile.y - ty0) * cols + (tile.tile.x - tx0)
    grid[k] ??= tile
  }
  const [minX, maxX, minY, maxY] = [tx0 * size, (tx0 + cols) * size - 1, ty0 * size, (ty0 + rows) * size - 1]
  const fallback = heights[0]!
  const pixel = (gx: number, gy: number): number => {
    const x = gx < minX ? minX : gx > maxX ? maxX : gx
    const y = gy < minY ? minY : gy > maxY ? maxY : gy
    const cx = Math.floor(x / size)
    const cy = Math.floor(y / size)
    const tile = grid[(cy - ty0) * cols + (cx - tx0)] ?? fallback
    let lx = x - tile.tile.x * size
    let ly = y - tile.tile.y * size
    lx = lx < 0 ? 0 : lx >= size ? size - 1 : lx
    ly = ly < 0 ? 0 : ly >= size ? size - 1 : ly
    const h = tile.heights[ly * size + lx]!
    return h > 0 ? h : 0
  }
  return (lon, lat) => {
    const φ = (Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180
    const fx = ((lon + 180) / 360) * n * size - 0.5
    const fy = ((1 - Math.log(Math.tan(φ) + 1 / Math.cos(φ)) / Math.PI) / 2) * n * size - 0.5
    const x0 = Math.floor(fx)
    const y0 = Math.floor(fy)
    const tx = fx - x0
    const ty = fy - y0
    return (pixel(x0, y0) * (1 - tx) + pixel(x0 + 1, y0) * tx) * (1 - ty) + (pixel(x0, y0 + 1) * (1 - tx) + pixel(x0 + 1, y0 + 1) * tx) * ty
  }
}
