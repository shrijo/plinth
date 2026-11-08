import { tileBounds, type TileId } from './tiles.ts'

/**
 * Ground heights from "terrarium" elevation tiles (as the open terrain
 * tiles on AWS serve them): a PNG per web Mercator tile whose pixels encode
 * metres above sea level as (red × 256 + green + blue / 256) − 32768. The
 * sea floor is below zero.
 */
export interface HeightTile {
  tile: TileId
  size: number
  heights: Float32Array
}

/** Heights from a decoded image's RGBA bytes. */
export function heightsFromTerrarium(tile: TileId, rgba: Uint8ClampedArray | Uint8Array, size: number): HeightTile {
  const heights = new Float32Array(size * size)
  for (let i = 0; i < size * size; i++) {
    heights[i] = rgba[i * 4]! * 256 + rgba[i * 4 + 1]! + rgba[i * 4 + 2]! / 256 - 32768
  }
  return { tile, size, heights }
}

/** The height at a longitude and latitude inside a height tile (bilinear), or null outside it. */
export function sampleHeight(source: HeightTile, lon: number, lat: number): number | null {
  const { west, east, north, south } = tileBounds(source.tile)
  if (lon < west || lon > east || lat > north || lat < south) return null
  const n = 2 ** source.tile.z
  // Fractional pixel position, in Mercator so it matches the image.
  const x = ((lon + 180) / 360) * n - source.tile.x
  const φ = (lat * Math.PI) / 180
  const y = ((1 - Math.log(Math.tan(φ) + 1 / Math.cos(φ)) / Math.PI) / 2) * n - source.tile.y
  const fx = Math.min(Math.max(x * source.size - 0.5, 0), source.size - 1)
  const fy = Math.min(Math.max(y * source.size - 0.5, 0), source.size - 1)
  const x0 = Math.floor(fx)
  const y0 = Math.floor(fy)
  const x1 = Math.min(x0 + 1, source.size - 1)
  const y1 = Math.min(y0 + 1, source.size - 1)
  const tx = fx - x0
  const ty = fy - y0
  const h = (px: number, py: number) => source.heights[py * source.size + px]!
  return (h(x0, y0) * (1 - tx) + h(x1, y0) * tx) * (1 - ty) + (h(x0, y1) * (1 - tx) + h(x1, y1) * tx) * ty
}
