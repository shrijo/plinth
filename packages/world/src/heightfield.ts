import type { HeightTile } from './terrarium.ts'
import type { LonLatBounds } from './tiles.ts'

/**
 * Heights over an area as one grid, on the elevation tiles' own pixels (or
 * every `step`th of them), so that a point has the same height whichever
 * tile asks: every tile's grid is a window onto the same lattice, filled
 * and smoothed the same way. Asking is one bilinear look-up.
 */
export interface HeightGrid {
  /** The height at a longitude and latitude (bilinear between the grid's points; outside it, its edge). */
  at(lon: number, lat: number): number
  /** The same, for a place given as its share of the way across the Mercator map (0 to 1 eastwards and southwards). */
  atMercator(x: number, y: number): number
}

interface Lattice {
  /** Pixels across the whole world at the heights' zoom. */
  world: number
  /** The grid's first pixel, and how many it has each way; `step` pixels apart. */
  x0: number
  y0: number
  cols: number
  rows: number
  step: number
  values: Float32Array
}

/** The grid of raw heights over `bounds` (and `pad` pixels round it), from tiles of one zoom. Sea floor counts as sea level. */
function lattice(tiles: readonly HeightTile[], bounds: LonLatBounds, pad: number): Lattice | null {
  const first = tiles[0]
  if (!first) return null
  const z = first.tile.z
  const size = first.size
  const world = 2 ** z * size
  const byPlace = new Map<number, HeightTile>()
  for (const tile of tiles) if (tile.tile.z === z && tile.size === size) byPlace.set(tile.tile.y * 2 ** z + tile.tile.x, tile)
  const px = (lon: number) => ((lon + 180) / 360) * world
  const py = (lat: number) => {
    const φ = (Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180
    return ((1 - Math.log(Math.tan(φ) + 1 / Math.cos(φ)) / Math.PI) / 2) * world
  }
  const x0 = Math.floor(px(bounds.west)) - pad
  const x1 = Math.ceil(px(bounds.east)) + pad
  const y0 = Math.floor(py(bounds.north)) - pad
  const y1 = Math.ceil(py(bounds.south)) + pad
  const cols = x1 - x0 + 1
  const rows = y1 - y0 + 1
  const values = new Float32Array(cols * rows)
  // Tile by tile, a row at a time; where there's no tile (open sea, or beyond what was loaded), the nearest
  // pixel there is.
  const filled = new Uint8Array(cols * rows)
  for (const tile of byPlace.values()) {
    const tx = tile.tile.x * size
    const ty = tile.tile.y * size
    const fromX = Math.max(x0, tx)
    const toX = Math.min(x1, tx + size - 1)
    const fromY = Math.max(y0, ty)
    const toY = Math.min(y1, ty + size - 1)
    for (let y = fromY; y <= toY; y++) {
      const row = (y - y0) * cols
      const source = (y - ty) * size
      for (let x = fromX; x <= toX; x++) {
        const h = tile.heights[source + x - tx]!
        values[row + x - x0] = h > 0 ? h : 0
        filled[row + x - x0] = 1
      }
    }
  }
  spread(values, filled, cols, rows)
  return { world, x0, y0, cols, rows, step: 1, values }
}

/** Fills the gaps of a grid from the nearest filled pixel along its row, then its column. */
function spread(values: Float32Array, filled: Uint8Array, cols: number, rows: number): void {
  for (let y = 0; y < rows; y++) {
    const row = y * cols
    let last = -1
    for (let x = 0; x < cols; x++) {
      if (filled[row + x]) {
        if (last < 0) for (let k = 0; k < x; k++) values[row + k] = values[row + x]!
        last = x
      } else if (last >= 0) values[row + x] = values[row + last]!
    }
    if (last >= 0) for (let x = 0; x < cols; x++) filled[row + x] = 1
  }
  for (let x = 0; x < cols; x++) {
    let last = -1
    for (let y = 0; y < rows; y++) {
      if (filled[y * cols + x]) {
        if (last < 0) for (let k = 0; k < y; k++) values[k * cols + x] = values[y * cols + x]!
        last = y
      } else if (last >= 0) values[y * cols + x] = values[last * cols + x]!
    }
  }
}

/** A grid smoothed with a Gaussian of `sigma` pixels (of its own spacing). */
function blurred(grid: Lattice, sigma: number): Lattice {
  if (sigma < 0.3) return grid
  const radius = Math.max(1, Math.ceil(sigma * 3))
  const kernel = new Float32Array(radius * 2 + 1)
  let total = 0
  for (let k = -radius; k <= radius; k++) {
    kernel[k + radius] = Math.exp((-k * k) / (2 * sigma * sigma))
    total += kernel[k + radius]!
  }
  for (let k = 0; k < kernel.length; k++) kernel[k] = kernel[k]! / total
  const { cols, rows } = grid
  const across = new Float32Array(cols * rows)
  const out = new Float32Array(cols * rows)
  for (let y = 0; y < rows; y++) {
    const row = y * cols
    for (let x = 0; x < cols; x++) {
      let sum = 0
      for (let k = -radius; k <= radius; k++) {
        const i = x + k
        sum += grid.values[row + (i < 0 ? 0 : i >= cols ? cols - 1 : i)]! * kernel[k + radius]!
      }
      across[row + x] = sum
    }
  }
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      let sum = 0
      for (let k = -radius; k <= radius; k++) {
        const j = y + k
        sum += across[(j < 0 ? 0 : j >= rows ? rows - 1 : j) * cols + x]! * kernel[k + radius]!
      }
      out[y * cols + x] = sum
    }
  }
  return { ...grid, values: out }
}

/**
 * Every `step`th pixel of a grid, each the average of the pixels round it
 * (a small tent), on the world's lattice (pixels whose place divides by
 * `step`), so neighbouring grids take the same ones.
 */
function thinned(grid: Lattice, step: number): Lattice {
  if (step <= 1) return grid
  const x0 = Math.ceil(grid.x0 / step)
  const y0 = Math.ceil(grid.y0 / step)
  const x1 = Math.floor((grid.x0 + grid.cols - 1) / step)
  const y1 = Math.floor((grid.y0 + grid.rows - 1) / step)
  const cols = Math.max(1, x1 - x0 + 1)
  const rows = Math.max(1, y1 - y0 + 1)
  const values = new Float32Array(cols * rows)
  const reach = step - 1
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const cx = (x0 + i) * step - grid.x0
      const cy = (y0 + j) * step - grid.y0
      let sum = 0
      let weight = 0
      for (let dy = -reach; dy <= reach; dy++) {
        const y = cy + dy
        if (y < 0 || y >= grid.rows) continue
        for (let dx = -reach; dx <= reach; dx++) {
          const x = cx + dx
          if (x < 0 || x >= grid.cols) continue
          const w = (step - Math.abs(dx)) * (step - Math.abs(dy))
          sum += grid.values[y * grid.cols + x]! * w
          weight += w
        }
      }
      values[j * cols + i] = weight > 0 ? sum / weight : 0
    }
  }
  return { world: grid.world, x0: x0 * step, y0: y0 * step, cols, rows, step, values }
}

function sampler(grid: Lattice): HeightGrid {
  const { world, x0, y0, cols, rows, step, values } = grid
  const maxX = cols - 1
  const maxY = rows - 1
  const right = cols > 1 ? 1 : 0
  const down = rows > 1 ? cols : 0
  const atMercator = (x: number, y: number): number => {
    // Pixel centres lie half a pixel in.
    let fx = (x * world - 0.5 - x0) / step
    let fy = (y * world - 0.5 - y0) / step
    fx = fx < 0 ? 0 : fx > maxX ? maxX : fx
    fy = fy < 0 ? 0 : fy > maxY ? maxY : fy
    const i = fx >= maxX ? Math.max(maxX - 1, 0) : Math.floor(fx)
    const j = fy >= maxY ? Math.max(maxY - 1, 0) : Math.floor(fy)
    const tx = fx - i
    const ty = fy - j
    const a = j * cols + i
    return (values[a]! * (1 - tx) + values[a + right]! * tx) * (1 - ty) + (values[a + down]! * (1 - tx) + values[a + down + right]! * tx) * ty
  }
  return {
    atMercator,
    at(lon, lat) {
      const φ = (lat > 85.05 ? 85.05 : lat < -85.05 ? -85.05 : lat) * (Math.PI / 180)
      return atMercator((lon + 180) / 360, (1 - Math.log(Math.tan(φ) + 1 / Math.cos(φ)) / Math.PI) / 2)
    },
  }
}

/**
 * Each point's low ground: the height a fifth of the points within `radius` of it (a square round it) lie
 * under. Not the very lowest: elevation data has pits, over water above all, and one would sink the lot.
 */
function lowest(grid: Lattice, radius: number): Lattice {
  const { cols, rows } = grid
  const out = new Float32Array(cols * rows)
  const window = new Float32Array((radius * 2 + 1) ** 2)
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      let count = 0
      for (let j = Math.max(0, y - radius); j <= Math.min(rows - 1, y + radius); j++) {
        const row = j * cols
        for (let i = Math.max(0, x - radius); i <= Math.min(cols - 1, x + radius); i++) window[count++] = grid.values[row + i]!
      }
      const sorted = window.subarray(0, count).sort()
      out[y * cols + x] = sorted[Math.floor(count * 0.2)]!
    }
  }
  return { ...grid, values: out }
}

export interface HeightGrids {
  /** The heights as they are (bilinear between pixels). */
  raw: HeightGrid
  /** Smoothed with a Gaussian of this many metres; `coarse` for wide ones (worked out on every other pixel or fewer). */
  smoothed(metres: number): HeightGrid
  /**
   * The low ground within `reach` metres of each point, smoothed a little: where there's water, its level
   * (the elevation data is flat on water and rises at its banks, so smoothing the land itself would tilt a
   * river up towards a high bank).
   */
  lowered(reach: number): HeightGrid
}

/**
 * Grids of the heights over `bounds` and `margin` metres round it, from
 * tiles of one zoom: the raw heights, and smoothed ones made when first
 * asked for and kept.
 */
export function heightGrids(tiles: readonly HeightTile[], bounds: LonLatBounds, margin: number): HeightGrids {
  const flat: HeightGrid = { at: () => 0, atMercator: () => 0 }
  const first = tiles[0]
  if (!first) return { raw: flat, smoothed: () => flat, lowered: () => flat }
  const lat = (bounds.north + bounds.south) / 2
  /** Metres to a pixel here. */
  const pixel = (40075016.686 * Math.max(Math.cos((lat * Math.PI) / 180), 0.01)) / (2 ** first.tile.z * first.size)
  const base = lattice(tiles, bounds, Math.ceil(margin / pixel) + 2)
  if (!base) return { raw: flat, smoothed: () => flat, lowered: () => flat }
  const raw = sampler(base)
  const made = new Map<number, HeightGrid>()
  const low = new Map<number, HeightGrid>()
  return {
    raw,
    lowered(reach) {
      let grid = low.get(reach)
      if (!grid) {
        // On every fourth pixel or so (the world's lattice, as the wide blurs), when pixels are fine enough.
        const step = reach / pixel >= 12 ? 4 : reach / pixel >= 6 ? 2 : 1
        const thin = thinned(base, step)
        const radius = Math.round(reach / (pixel * step))
        grid = radius < 1 ? raw : sampler(blurred(lowest(thin, radius), Math.max(radius / 2, 1)))
        low.set(reach, grid)
      }
      return grid
    },
    smoothed(metres) {
      let grid = made.get(metres)
      if (!grid) {
        const sigma = metres / pixel
        // A wide blur has no fine detail: worked out on fewer pixels (a power of two apart, on the world's lattice).
        const step = sigma >= 6 ? 2 ** Math.min(3, Math.floor(Math.log2(sigma / 3))) : 1
        grid = sigma < 0.3 ? raw : sampler(blurred(thinned(base, step), sigma / step))
        made.set(metres, grid)
      }
      return grid
    },
  }
}
