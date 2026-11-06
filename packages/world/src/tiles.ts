/**
 * Map tiles in the web Mercator scheme every web map uses: zoom z splits
 * the world into 2^z × 2^z squares, x from the antimeridian eastwards, y
 * from the north (85° N) southwards.
 */

export interface TileId {
  z: number
  x: number
  y: number
}

export interface LonLatBounds {
  west: number
  south: number
  east: number
  north: number
}

/** Mercator's limit: the map is square between these latitudes. */
export const MAX_LATITUDE = 85.0511287798

export const tileKey = (t: TileId) => `${t.z}/${t.x}/${t.y}`

export function tileLon(x: number, z: number): number {
  return (x / 2 ** z) * 360 - 180
}

export function tileLat(y: number, z: number): number {
  const n = Math.PI * (1 - (2 * y) / 2 ** z)
  return (Math.atan(Math.sinh(n)) * 180) / Math.PI
}

export function tileBounds({ z, x, y }: TileId): LonLatBounds {
  return { west: tileLon(x, z), east: tileLon(x + 1, z), north: tileLat(y, z), south: tileLat(y + 1, z) }
}

/** Where a longitude and latitude fall in tile units at a zoom (fractional). */
export function lonLatToTileXY(lon: number, lat: number, z: number): { x: number; y: number } {
  const n = 2 ** z
  const φ = (Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, lat)) * Math.PI) / 180
  return { x: ((lon + 180) / 360) * n, y: ((1 - Math.log(Math.tan(φ) + 1 / Math.cos(φ)) / Math.PI) / 2) * n }
}

/** A point inside a tile, in the tile's own units (0 to `extent` across), as longitude and latitude. */
export function tilePointToLonLat(tile: TileId, px: number, py: number, extent: number): { lon: number; lat: number } {
  return { lon: tileLon(tile.x + px / extent, tile.z), lat: tileLat(tile.y + py / extent, tile.z) }
}

export function tileChildren({ z, x, y }: TileId): TileId[] {
  return [
    { z: z + 1, x: 2 * x, y: 2 * y },
    { z: z + 1, x: 2 * x + 1, y: 2 * y },
    { z: z + 1, x: 2 * x, y: 2 * y + 1 },
    { z: z + 1, x: 2 * x + 1, y: 2 * y + 1 },
  ]
}

export function tileParent({ z, x, y }: TileId): TileId | null {
  return z === 0 ? null : { z: z - 1, x: Math.floor(x / 2), y: Math.floor(y / 2) }
}

/** The tiles at a zoom that cover an area. */
export function tilesCovering(bounds: LonLatBounds, z: number): TileId[] {
  const a = lonLatToTileXY(bounds.west, bounds.north, z)
  const b = lonLatToTileXY(bounds.east, bounds.south, z)
  const tiles: TileId[] = []
  for (let x = Math.floor(a.x); x <= Math.floor(b.x - 1e-9); x++) {
    for (let y = Math.floor(a.y); y <= Math.floor(b.y - 1e-9); y++) tiles.push({ z, x, y })
  }
  return tiles
}
