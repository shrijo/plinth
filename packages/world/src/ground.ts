import type { RoadFeature, Shape, TileFeatures } from './features.ts'
import { insideRing } from './clip.ts'
import { heightGrids } from './heightfield.ts'
import { tileWidth, WATER_DEPTH } from './mesh.ts'
import type { HeightTile } from './terrarium.ts'
import { tileBounds, type LonLatBounds, type TileId } from './tiles.ts'

/**
 * The ground as the world is built on it: the elevation data, smoothed
 * (in cities the open elevation data has buildings and trees in it, so
 * streets would bump over them), with a level bed along each street, the
 * way open-world games shape their terrain to their roads (landscape
 * splines in Unreal, Unigine's road tool): flat across, following the
 * land along it, blending back into the land beside it. Every building
 * stands on a level pad laid into the land (a plot levelled for a house),
 * so none is swallowed by a hillside. Water lies at a level of its own,
 * over a basin. Every tile and every building is built on the same
 * ground, so they meet.
 */

/** Sidewalks either side of town streets, in metres. */
export const SIDEWALK = 2.5
/** Kinds of road with sidewalks in town. */
export const TOWN_STREETS = new Set(['minor', 'tertiary', 'secondary', 'primary'])
/** Over this far beyond its edge (metres) a road's bed blends back into the land. */
const FALLOFF = 7
/** Under a street the land lies this much lower than its bed, so it never shows through the street built on it. */
const DIP = 0.35
/**
 * Smoothing of the land, and of a road's bed (a Gaussian's width, metres): a bed curves gently, like a real
 * road's vertical alignment, not with every bump the elevation data has. Water surfaces are the land smoothed
 * as widely as a bed: flat enough on a lake, following a river down its valley, and the same wherever it's
 * asked, so a lake cut across tiles meets itself.
 */
const LAND_SMOOTHING = 6
const BED_SMOOTHING = 36
/** A water's surface is the lowest ground within this far (metres): on water that's the water, even right under a high bank. */
const WATER_REACH = 45
/**
 * A building stands on a level pad: the ground is its base height under it and this far round it (metres),
 * blending back into the land by `PAD_REACH`, as a plot is levelled for a house. The elevation data is too
 * coarse (and in town, too full of the buildings themselves) to say what the ground does under one building:
 * left as it is, houses on a slope stand in hollows behind humps a storey high.
 */
const PAD_FLAT = 2.5
const PAD_REACH = 10
/** A building's base is no lower than a street bed that reaches its outline at least this strongly (see padBase). */
const PAD_STREET = 0.25
/**
 * A pad is never further than this (metres) from the land's trend at any point: a house's is level, but
 * under a building a hundred metres long on a slope the ground steps with the hill rather than being cut
 * and banked a storey or two.
 */
const PAD_STEP = 2.5
/**
 * Near anything built, the land is its trend, not its every bump: wholly within `SETTLE_NEAR` metres of a
 * building or a street's edge, back to the land as it is by `SETTLE_REACH`. In town the elevation data's
 * bumps are mostly the buildings and trees themselves; left in, the ground between houses heaves. (No further
 * than a tile carries of its neighbours, so the ground is the same from both sides of a seam.)
 */
const SETTLE_NEAR = 6
const SETTLE_REACH = 20
/** A street's bed is this much wider each side than its class says (metres): streets are built wider than that where the map shows them so. */
const BED_MARGIN = 1.5
/**
 * Where a street that isn't a bridge crosses water, the ground under its middle (this far either side, metres)
 * is banked up to it: narrower than any road, so the bank never shows beside the road built on it (whose own
 * sides reach down into the water), and a road along a quay doesn't bank the water beside it.
 */
const CAUSEWAY = 2
/** The heights are prepared this far beyond the map data's tile (metres): streets are followed a little past its edges. */
const MARGIN = 130

export interface Ground {
  /** The ground's height at a point, metres above sea level (a little lower under streets: they're built over it). */
  at(lon: number, lat: number): number
  /** The height a street is built at: the level bed (the land itself away from streets). */
  level(lon: number, lat: number): number
  /** Water there: the height of its surface, or null on land. */
  waterAt(lon: number, lat: number): number | null
  /** The height a water surface has at a point (whether or not there's water). */
  surface(lon: number, lat: number): number
  /**
   * The land's trend at a point: what a street's bed follows along its middle. The same from whichever tile
   * it's asked (as far as its heights reach), also beyond the tile's own map data.
   */
  trend(lon: number, lat: number): number
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
  /** How far either side of its middle it carries a causeway where it crosses water (see CAUSEWAY). */
  core: number
}

/** A building's footprint on the ground, for its pad. */
interface Pad {
  /** Rings in metres in the source tile (outer first), and their bounds. */
  rings: Float64Array[]
  minX: number
  minY: number
  maxX: number
  maxY: number
  /** The pad's height, worked out when first asked for. */
  base?: number
  /**
   * Where the building crosses the tile's own edges (tile units, a few points along each crossing): its pad's
   * height is taken there, where the tile beside this one sees the very same of it (each tile has a building
   * only as far as its data reaches, so its whole outline would give each a height of its own).
   */
  crossings?: number[]
}

/** Where a ring (tile units) crosses the tile's edges: points along each crossing, x and y interleaved; or none. */
function edgeCrossings(ring: Float64Array): number[] | undefined {
  const out: number[] = []
  // A corner inside it: that alone (all four tiles round the corner take it).
  for (const [cu, cv] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) if (insideRing(ring, cu, cv)) return [cu, cv]
  for (const [axis, value] of [[0, 0], [0, 1], [1, 0], [1, 1]] as const) {
    // Where its outline crosses the edge's line, within the edge; inside it between each pair.
    const hits: number[] = []
    for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
      const a = ring[j + axis]!
      const b = ring[i + axis]!
      if (a > value === b > value) continue
      const other = ring[j + 1 - axis]! + ((value - a) / (b - a)) * (ring[i + 1 - axis]! - ring[j + 1 - axis]!)
      hits.push(other)
    }
    hits.sort((p, q) => p - q)
    for (let k = 0; k + 1 < hits.length; k += 2) {
      const from = Math.max(hits[k]!, 0)
      const to = Math.min(hits[k + 1]!, 1)
      if (to <= from) continue
      for (const t of [0.1, 0.3, 0.5, 0.7, 0.9]) {
        const along = from + (to - from) * t
        if (axis === 0) out.push(value, along)
        else out.push(along, value)
      }
    }
  }
  return out.length > 0 ? out : undefined
}

function insideMetres(ring: Float64Array, x: number, y: number): boolean {
  let hit = false
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    const xi = ring[i]!
    const yi = ring[i + 1]!
    const xj = ring[j]!
    const yj = ring[j + 1]!
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit
  }
  return hit
}

/** The square of the distance from a point to a ring's edges. */
function ringDistance2(ring: Float64Array, x: number, y: number): number {
  let best = Infinity
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    const ax = ring[j]!
    const ay = ring[j + 1]!
    const dx = ring[i]! - ax
    const dy = ring[i + 1]! - ay
    const l = dx * dx + dy * dy
    const t = l === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l))
    const ex = x - ax - dx * t
    const ey = y - ay - dy * t
    const d = ex * ex + ey * ey
    if (d < best) best = d
  }
  return best
}

/**
 * Where shapes lie over a tile (and a little round it), as a grid of cells: 0 outside them all, 1 inside one,
 * 2 at an edge (where the shapes themselves must be asked). Asking whether a point lies in a lake is then one
 * look-up, not a walk round the lake's whole shore, for all but the points right at the shore.
 */
class ShapeMask {
  private static readonly SIZE = 640
  private static readonly FROM = -0.03
  private static readonly SPAN = 1.06
  private readonly cells = new Uint8Array(ShapeMask.SIZE * ShapeMask.SIZE)

  constructor(shapes: readonly Shape[]) {
    const size = ShapeMask.SIZE
    const toCell = (value: number) => ((value - ShapeMask.FROM) / ShapeMask.SPAN) * size
    const crossings: number[] = []
    for (const shape of shapes) {
      const rings = [shape.outer, ...shape.holes]
      let low = Infinity
      let high = -Infinity
      for (let i = 1; i < shape.outer.length; i += 2) {
        low = Math.min(low, shape.outer[i]!)
        high = Math.max(high, shape.outer[i]!)
      }
      // Inside: each row of cells, between the crossings of the rings (at the cells' middles).
      for (let row = Math.max(0, Math.floor(toCell(low))); row <= Math.min(size - 1, Math.ceil(toCell(high))); row++) {
        const v = ShapeMask.FROM + ((row + 0.5) / size) * ShapeMask.SPAN
        crossings.length = 0
        for (const ring of rings) {
          for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
            const yi = ring[i + 1]!
            const yj = ring[j + 1]!
            if (yi > v !== yj > v) crossings.push(ring[i]! + ((v - yi) / (yj - yi)) * (ring[j]! - ring[i]!))
          }
        }
        crossings.sort((a, b) => a - b)
        for (let k = 0; k + 1 < crossings.length; k += 2) {
          const from = Math.max(0, Math.ceil(toCell(crossings[k]!) - 0.5))
          const to = Math.min(size - 1, Math.floor(toCell(crossings[k + 1]!) - 0.5))
          for (let column = from; column <= to; column++) this.cells[row * size + column] = 1
        }
      }
    }
    // Edges: every cell an edge passes through, and those beside it.
    for (const shape of shapes) {
      for (const ring of [shape.outer, ...shape.holes]) {
        for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
          const ax = toCell(ring[j]!)
          const ay = toCell(ring[j + 1]!)
          const bx = toCell(ring[i]!)
          const by = toCell(ring[i + 1]!)
          const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) * 2))
          for (let k = 0; k <= steps; k++) {
            const cx = Math.floor(ax + ((bx - ax) * k) / steps)
            const cy = Math.floor(ay + ((by - ay) * k) / steps)
            for (let dy = -1; dy <= 1; dy++) {
              const y = cy + dy
              if (y < 0 || y >= size) continue
              for (let dx = -1; dx <= 1; dx++) {
                const x = cx + dx
                if (x >= 0 && x < size) this.cells[y * size + x] = 2
              }
            }
          }
        }
      }
    }
  }

  /** 0, 1, or 2 where the shapes themselves must be asked (at an edge, or beyond the grid). */
  at(u: number, v: number): number {
    const x = Math.floor(((u - ShapeMask.FROM) / ShapeMask.SPAN) * ShapeMask.SIZE)
    const y = Math.floor(((v - ShapeMask.FROM) / ShapeMask.SPAN) * ShapeMask.SIZE)
    if (x < 0 || y < 0 || x >= ShapeMask.SIZE || y >= ShapeMask.SIZE) return 2
    return this.cells[y * ShapeMask.SIZE + x]!
  }
}

export interface GroundOptions {
  /** Whether the ground is shaped for streets, squares and buildings (close up); yes by default. */
  roads?: boolean
  /** How far beyond the map data's tile the heights are prepared (metres). */
  margin?: number
}

/**
 * The ground for a part of the world, from heights (the finest tiles there,
 * covering the map data's tile and a margin round it) and map data (the
 * tile of the finest zoom over it, for its streets, buildings and water;
 * none far out, where the land is just the heights).
 */
export function makeGround(heights: readonly HeightTile[], features: TileFeatures | null, options: GroundOptions = {}): Ground {
  const source = features?.tile ?? null
  // Where heights are wanted: the map data's tile, or else wherever there are heights.
  const bounds: LonLatBounds = source
    ? tileBounds(source)
    : heights.map((h) => tileBounds(h.tile)).reduce((a, b) => ({ west: Math.min(a.west, b.west), east: Math.max(a.east, b.east), south: Math.min(a.south, b.south), north: Math.max(a.north, b.north) }), { west: 180, east: -180, south: 90, north: -90 })
  const grids = heightGrids(heights, bounds, options.margin ?? MARGIN)
  const landGrid = grids.smoothed(LAND_SMOOTHING)
  /** The land's trend: what street beds and building pads follow. Made when first needed. */
  let wide: ReturnType<typeof grids.smoothed> | null = null
  const trend = () => (wide ??= grids.smoothed(BED_SMOOTHING))
  /** Where water lies: level with the lowest ground round it (see HeightGrids.lowered). Made when first needed. */
  let lowest: ReturnType<typeof grids.lowered> | null = null
  const waterLevel = () => (lowest ??= grids.lowered(WATER_REACH))

  const water: Shape[] = features ? features.areas.filter((a) => a.kind === 'water').map((a) => a.shape) : []
  /** How far beyond the water a shore keeps its bank (metres, in tile units once divided by the tile's width). */
  const BANK_REACH = 30
  const boxOf = (shape: Shape) => {
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity]
    for (let i = 0; i < shape.outer.length; i += 2) {
      x0 = Math.min(x0, shape.outer[i]!)
      x1 = Math.max(x1, shape.outer[i]!)
      y0 = Math.min(y0, shape.outer[i + 1]!)
      y1 = Math.max(y1, shape.outer[i + 1]!)
    }
    return [x0, y0, x1, y1] as const
  }
  const boxes = water.map(boxOf)

  // Squares and platforms: paved (see streetMesh), so the land dips under them as under streets.
  const squares: Shape[] = features && options.roads !== false ? features.areas.filter((a) => a.kind === 'square').map((a) => a.shape) : []
  const squareBoxes = squares.map(boxOf)
  let squareMask: ShapeMask | null = null
  /** Whether a point (source tile units) is on a square. */
  const onSquare = (u: number, v: number) => {
    const quick = (squareMask ??= new ShapeMask(squares)).at(u, v)
    return quick === 2 ? onSquareExactly(u, v) : quick === 1
  }
  const onSquareExactly = (u: number, v: number) =>
    squares.some((shape, k) => {
      const [x0, y0, x1, y1] = squareBoxes[k]!
      return u >= x0 && u <= x1 && v >= y0 && v <= y1 && insideRing(shape.outer, u, v) && !shape.holes.some((hole) => insideRing(hole, u, v))
    })

  // Streets, in metres in the source tile (indexed in a grid of cells), with their half widths.
  const segments: Segment[] = []
  const cells = new Map<number, number[]>()
  const CELLS = 96
  const metres = source ? tileWidth(source) : 1
  let town = false
  // Buildings standing on the ground, in a grid of cells by where their pads reach.
  const pads: Pad[] = []
  const padCells = new Map<number, number[]>()
  const PAD_CELLS = 96
  const padCell = metres / PAD_CELLS
  if (features && source && options.roads !== false) {
    town = features.buildings.length > 150
    for (const building of features.buildings) {
      if (building.minHeight > 0) continue
      const rings = [building.shape.outer, ...building.shape.holes].map((ring) => ring.map((value) => value * metres))
      const pad: Pad = { rings, minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity, crossings: edgeCrossings(building.shape.outer) }
      const outer = rings[0]!
      for (let i = 0; i < outer.length; i += 2) {
        pad.minX = Math.min(pad.minX, outer[i]!)
        pad.maxX = Math.max(pad.maxX, outer[i]!)
        pad.minY = Math.min(pad.minY, outer[i + 1]!)
        pad.maxY = Math.max(pad.maxY, outer[i + 1]!)
      }
      const index = pads.push(pad) - 1
      for (let cy = Math.floor((pad.minY - SETTLE_REACH) / padCell); cy <= Math.floor((pad.maxY + SETTLE_REACH) / padCell); cy++) {
        for (let cx = Math.floor((pad.minX - SETTLE_REACH) / padCell); cx <= Math.floor((pad.maxX + SETTLE_REACH) / padCell); cx++) {
          if (cx < -8 || cy < -8 || cx > PAD_CELLS + 7 || cy > PAD_CELLS + 7) continue
          const key = (cy + 8) * 256 + (cx + 8)
          const list = padCells.get(key)
          if (list) list.push(index)
          else padCells.set(key, [index])
        }
      }
    }
    const reach = (road: RoadFeature) => road.width / 2 + BED_MARGIN + (town && TOWN_STREETS.has(road.kind) ? SIDEWALK : 0)
    for (const road of features.roads) {
      if (road.tunnel || road.bridge || road.kind === 'path' || road.kind === 'track' || road.kind === 'pier') continue
      const half = reach(road)
      const line = road.line
      for (let i = 0; i + 3 < line.length; i += 2) {
        const s = { ax: line[i]! * metres, ay: line[i + 1]! * metres, bx: line[i + 2]! * metres, by: line[i + 3]! * metres, half, core: Math.min(road.width / 2, CAUSEWAY) }
        const index = segments.push(s) - 1
        const pad = half + SETTLE_REACH
        const cell = metres / CELLS
        const x0 = Math.floor((Math.min(s.ax, s.bx) - pad) / cell)
        const x1 = Math.floor((Math.max(s.ax, s.bx) + pad) / cell)
        const y0 = Math.floor((Math.min(s.ay, s.by) - pad) / cell)
        const y1 = Math.floor((Math.max(s.ay, s.by) + pad) / cell)
        for (let y = y0; y <= y1; y++) {
          for (let x = x0; x <= x1; x++) {
            if (x < -8 || y < -8 || x > CELLS + 7 || y > CELLS + 7) continue
            const key = (y + 8) * 256 + (x + 8)
            const list = cells.get(key)
            if (list) list.push(index)
            else cells.set(key, [index])
          }
        }
      }
    }
  }

  // Places as shares of the way across the Mercator map (what the height grids are asked by), and in the
  // source tile's own units.
  const n = source ? 2 ** source.z : 1
  const mercatorX = (lon: number) => (lon + 180) / 360
  const mercatorY = (lat: number) => {
    const φ = ((lat > 85.05 ? 85.05 : lat < -85.05 ? -85.05 : lat) * Math.PI) / 180
    return (1 - Math.log(Math.tan(φ) + 1 / Math.cos(φ)) / Math.PI) / 2
  }
  /** Metres in the source tile to the Mercator map. */
  const acrossX = (px: number) => (source!.x + px / metres) / n
  const acrossY = (py: number) => (source!.y + py / metres) / n

  /** Whether a point (source tile units) lies on water, and whether it lies near any water's box. */
  let waterMask: ShapeMask | null = null
  const inWater = (u: number, v: number): boolean => {
    const quick = (waterMask ??= new ShapeMask(water)).at(u, v)
    return quick === 2 ? inWaterExactly(u, v) : quick === 1
  }
  const inWaterExactly = (u: number, v: number): boolean => {
    for (let i = 0; i < water.length; i++) {
      const [x0, y0, x1, y1] = boxes[i]!
      if (u < x0 || u > x1 || v < y0 || v > y1) continue
      const shape = water[i]!
      if (insideRing(shape.outer, u, v) && !shape.holes.some((h) => insideRing(h, u, v))) return true
    }
    return false
  }
  // Near water: a coarse grid of the cells the waters' boxes (and a bank's reach round them) touch.
  const NEAR = 96
  let nearMask: Uint8Array | null = null
  const nearWater = (u: number, v: number): boolean => {
    const pad = source ? BANK_REACH / metres : 0
    if (!nearMask) {
      nearMask = new Uint8Array(NEAR * NEAR)
      const cellOf = (value: number) => Math.floor(((value + 0.03) / 1.06) * NEAR)
      for (const [x0, y0, x1, y1] of boxes) {
        for (let y = Math.max(0, cellOf(y0 - pad)); y <= Math.min(NEAR - 1, cellOf(y1 + pad)); y++) {
          for (let x = Math.max(0, cellOf(x0 - pad)); x <= Math.min(NEAR - 1, cellOf(x1 + pad)); x++) nearMask[y * NEAR + x] = 1
        }
      }
    }
    const cx = Math.floor(((u + 0.03) / 1.06) * NEAR)
    const cy = Math.floor(((v + 0.03) / 1.06) * NEAR)
    if (cx >= 0 && cy >= 0 && cx < NEAR && cy < NEAR && nearMask[cy * NEAR + cx] === 0) return false
    for (const [x0, y0, x1, y1] of boxes) {
      if (u >= x0 - pad && u <= x1 + pad && v >= y0 - pad && v <= y1 + pad) return true
    }
    return false
  }

  /** How strongly street beds reach the point last asked of `shape` (0 to 1). */
  let reached = 0

  /**
   * The height of a building's pad: the land's trend along its outline (not its every bump: neighbours then
   * stand at heights that follow the slope, not the noise), and no lower than a street bed that reaches it (a
   * building on a street has its ground floor at the street's level, not below it). Never under water.
   */
  const padBase = (pad: Pad): number => {
    if (pad.base !== undefined) return pad.base
    if (pad.crossings) {
      // Across the tile's edge: the trend where it crosses, the same from both sides.
      const wideGrid = trend()
      let sum = 0
      for (let i = 0; i < pad.crossings.length; i += 2) sum += wideGrid.atMercator((source!.x + pad.crossings[i]!) / n, (source!.y + pad.crossings[i + 1]!) / n)
      pad.base = sum / (pad.crossings.length / 2)
      return pad.base
    }
    let total = 0
    let sum = 0
    let front = -Infinity
    const outer = pad.rings[0]!
    const wideGrid = trend()
    for (let i = 0, j = outer.length - 2; i < outer.length; j = i, i += 2) {
      const ax = outer[j]!
      const ay = outer[j + 1]!
      const length = Math.hypot(outer[i]! - ax, outer[i + 1]! - ay)
      if (length < 1e-6) continue
      const steps = Math.max(1, Math.ceil(length / 4))
      for (let k = 0; k < steps; k++) {
        const t = (k + 0.5) / steps
        const px = ax + (outer[i]! - ax) * t
        const py = ay + (outer[i + 1]! - ay) * t
        const x = acrossX(px)
        const y = acrossY(py)
        sum += wideGrid.atMercator(x, y) * (length / steps)
        total += length / steps
        // The ground as it is without pads: a street's bed here, or water.
        const here = shapeAt(x, y, px, py, false)
        if (reached >= PAD_STREET) front = Math.max(front, here.level)
        if (here.wet) front = Math.max(front, waterLevel().atMercator(x, y) + 0.5)
      }
    }
    pad.base = total > 0 ? Math.max(sum / total, front) : 0
    return pad.base
  }

  /** What `pads` found round the point last asked of it: the nearest building (metres; 0 inside one), and its pads. */
  let padNear = Infinity
  let padInside = -Infinity
  let padSum = 0
  let padWeights = 0
  let padMost = 0

  /** A pad's height at a point where the land's trend is `here`: its base, within a step of the trend (see PAD_STEP). */
  const stepped = (base: number, here: number) => (base > here + PAD_STEP ? here + PAD_STEP : base < here - PAD_STEP ? here - PAD_STEP : base)

  /** The buildings round a point (in the source tile's metres, where the land's trend is `here`): see padNear and the rest. */
  const padsAt = (px: number, py: number, here: number): void => {
    padNear = Infinity
    padInside = -Infinity
    padSum = 0
    padWeights = 0
    padMost = 0
    const list = padCells.get((Math.floor(py / padCell) + 8) * 256 + (Math.floor(px / padCell) + 8))
    if (!list) return
    for (const index of list) {
      const pad = pads[index]!
      // By its box first: too far to settle the land, or to matter beside a nearer building with no pad of its own here.
      const ex = px < pad.minX ? pad.minX - px : px > pad.maxX ? px - pad.maxX : 0
      const ey = py < pad.minY ? pad.minY - py : py > pad.maxY ? py - pad.maxY : 0
      const boxed = ex > ey ? ex : ey
      if (boxed >= SETTLE_REACH || (boxed >= PAD_REACH && boxed >= padNear)) continue
      let d2 = Infinity
      let within = px >= pad.minX && px <= pad.maxX && py >= pad.minY && py <= pad.maxY && insideMetres(pad.rings[0]!, px, py)
      if (within) {
        // In a courtyard: outside the building, near its walls.
        for (let r = 1; r < pad.rings.length; r++) {
          if (insideMetres(pad.rings[r]!, px, py)) {
            within = false
            d2 = ringDistance2(pad.rings[r]!, px, py)
            break
          }
        }
        if (within) {
          padInside = Math.max(padInside, stepped(padBase(pad), here))
          padNear = 0
          continue
        }
      } else d2 = ringDistance2(pad.rings[0]!, px, py)
      if (d2 >= SETTLE_REACH * SETTLE_REACH) continue
      const d = Math.sqrt(d2)
      if (d < padNear) padNear = d
      if (d >= PAD_REACH) continue
      const f = d <= PAD_FLAT ? 1 : smoothstep(1 - (d - PAD_FLAT) / (PAD_REACH - PAD_FLAT))
      if (f <= 0) continue
      // Nearer walls count for far more, so at a wall the ground is that building's base.
      const k = f / (d2 + 0.0025)
      padWeights += k
      padSum += k * stepped(padBase(pad), here)
      if (f > padMost) padMost = f
    }
  }

  /** How settled the land is (see SETTLE_NEAR), this far from the nearest thing built. */
  const settled = (distance: number) => (distance <= SETTLE_NEAR ? 1 : distance >= SETTLE_REACH ? 0 : smoothstep(1 - (distance - SETTLE_NEAR) / (SETTLE_REACH - SETTLE_NEAR)))

  const plain = water.length === 0 && segments.length === 0 && squares.length === 0 && pads.length === 0
  const out = { level: 0, land: 0, wet: false }
  const result = (level: number, land: number, wet: boolean) => {
    out.level = level
    out.land = land
    out.wet = wet
    return out
  }

  /**
   * The bed (street level) and the land (dipped under streets, a basin under water) at a point, given as its
   * place on the Mercator map and in the source tile's metres. Without `withPads`, the land as it is before
   * the buildings' pads are laid into it. (What it returns is overwritten by the next call.)
   */
  const shapeAt = (x: number, y: number, px: number, py: number, withPads: boolean): { level: number; land: number; wet: boolean } => {
    reached = 0
    const u = px / metres
    const v = py / metres
    const wet = water.length > 0 && inWater(u, v)
    // Every street whose bed reaches here, weighted by how strongly: where two meet, their beds blend, so the
    // ground has no step at a junction (taking only the strongest would jump from one to the other).
    let weights = 0
    let beds = 0
    let under = 0
    let crossing = 0
    let nearRoad = Infinity
    const cell = metres / CELLS
    const list = segments.length > 0 ? cells.get((Math.floor(py / cell) + 8) * 256 + (Math.floor(px / cell) + 8)) : undefined
    if (list) {
      const wideGrid = trend()
      for (const index of list) {
        const s = segments[index]!
        const dx = s.bx - s.ax
        const dy = s.by - s.ay
        const l = dx * dx + dy * dy
        const t = l === 0 ? 0 : Math.max(0, Math.min(1, ((px - s.ax) * dx + (py - s.ay) * dy) / l))
        const qx = s.ax + dx * t
        const qy = s.ay + dy * t
        const d = Math.hypot(px - qx, py - qy)
        if (d - s.half < nearRoad) nearRoad = d - s.half
        if (d > s.half + FALLOFF) continue
        const w = d <= s.half ? 1 : smoothstep(1 - (d - s.half) / FALLOFF)
        if (w < 0.005) continue
        // Level across: a street's bed is the land's trend at the middle of the street.
        weights += w
        beds += w * wideGrid.atMercator(acrossX(qx), acrossY(qy))
        under = Math.max(under, d <= s.half ? 1 : smoothstep(1 - (d - s.half) / 2))
        // Over water only the middle of the road counts: a quay's road beside the water is not a road across it.
        if (wet) crossing = Math.max(crossing, d <= s.core ? 1 : smoothstep(1 - (d - s.core)))
      }
    }
    // The land: its trend near anything built, and each building's pad laid into it.
    let land = landGrid.atMercator(x, y)
    const padding = withPads && pads.length > 0
    if (padding) padsAt(px, py, trend().atMercator(x, y))
    const settle = settled(Math.min(nearRoad, padding ? padNear : Infinity))
    if (settle > 0) land += (trend().atMercator(x, y) - land) * settle
    // A shore has a bank, not a long smooth ramp: on land near water, the ground stays above the surface.
    if (!wet && water.length > 0 && nearWater(u, v)) land = Math.max(land, waterLevel().atMercator(x, y) + 0.25)
    if (padding) {
      if (padInside > -Infinity) land = padInside
      else if (padWeights > 0) land += (padSum / padWeights - land) * padMost
    }
    const paved = squares.length > 0 && onSquare(u, v)
    reached = Math.min(weights, 1)
    if (wet) {
      // Over water a street rides on a causeway just above the surface; under it the ground is an
      // embankment just below its bed, and away from it the basin.
      const top = waterLevel().atMercator(x, y)
      const basin = Math.min(land, top - WATER_DEPTH)
      if (weights === 0 || crossing === 0) return result(land, basin, wet)
      let level = land + (beds / weights - land) * Math.min(weights, 1)
      if (weights > 0.05) level = Math.max(level, top + 0.45)
      return result(level, basin + (level - DIP - basin) * crossing, wet)
    }
    if (weights === 0) return result(land, paved ? land - DIP : land, wet)
    const level = land + (beds / weights - land) * Math.min(weights, 1)
    return result(level, level - DIP * (paved ? 1 : under), wet)
  }

  const shape = (lon: number, lat: number) => {
    const x = mercatorX(lon)
    const y = mercatorY(lat)
    if (plain) {
      const land = landGrid.atMercator(x, y)
      return result(land, land, false)
    }
    return shapeAt(x, y, (x * n - source!.x) * metres, (y * n - source!.y) * metres, true)
  }
  const at = (lon: number, lat: number): number => shape(lon, lat).land
  const level = (lon: number, lat: number): number => shape(lon, lat).level

  /** The water's surface: level with the lowest ground round the point, and never below the sea. */
  const surface = (lon: number, lat: number): number => waterLevel().at(lon, lat)

  const waterAt = (lon: number, lat: number): number | null => {
    if (water.length === 0) return null
    const u = mercatorX(lon) * n - source!.x
    const v = mercatorY(lat) * n - source!.y
    return inWater(u, v) ? surface(lon, lat) : null
  }

  return { at, level, waterAt, surface, trend: (lon, lat) => trend().at(lon, lat), water, source, town }
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
