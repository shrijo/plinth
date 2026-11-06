import { readTile, type TileFeatures } from './features.ts'
import { decodePng } from './png.ts'
import { heightsFromTerrarium, sampleHeight, type HeightTile } from './terrarium.ts'
import { tileLat, tileLon, type TileId } from './tiles.ts'

/**
 * Where the world's data comes from, all open and free to use with credit:
 * map data from OpenStreetMap as vector tiles (OpenFreeMap, in the
 * OpenMapTiles scheme) and ground heights as terrarium tiles (the open
 * terrain tiles on AWS, from SRTM and other public data).
 */

export const VECTOR_TILEJSON = 'https://tiles.openfreemap.org/planet'
export const TERRAIN_TILES = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'
/** The finest zoom each source has: below it, tiles show part of one at this zoom. */
export const VECTOR_MAX_ZOOM = 14
export const TERRAIN_MAX_ZOOM = 15

export const ATTRIBUTION = '© OpenStreetMap contributors · OpenFreeMap · OpenMapTiles · Terrain: Mapzen, AWS'

export class FetchError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

/** A fetch tried again after a short wait if the network or the server stumbles (not for a 404). */
export async function fetchWithRetry(url: string, signal?: AbortSignal, tries = 3, init: RequestInit = {}): Promise<Response> {
  let last: unknown
  for (let attempt = 0; attempt < tries; attempt++) {
    if (attempt > 0) await wait(400 * 2 ** attempt, signal)
    try {
      const response = await fetch(url, { ...init, signal })
      if (response.ok) return response
      last = new FetchError(`${response.status} for ${url}`, response.status)
      if (response.status === 404 || response.status === 400 || response.status === 403) break
    } catch (error) {
      if (signal?.aborted) throw error
      last = error
    }
  }
  throw last
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(signal.reason)
      },
      { once: true },
    )
  })
}

let template: Promise<string> | null = null

/** The vector tiles' address pattern (it names the data's date, so it's read from the TileJSON). */
function vectorTemplate(): Promise<string> {
  template ??= fetchWithRetry(VECTOR_TILEJSON)
    .then((r) => r.json() as Promise<{ tiles?: string[] }>)
    .then((json) => {
      const url = json.tiles?.[0]
      if (!url) throw new Error('No tile address in the TileJSON')
      return url
    })
    .catch((error: unknown) => {
      template = null
      throw error
    })
  return template
}

const address = (pattern: string, t: TileId) =>
  pattern.replace('{z}', String(t.z)).replace('{x}', String(t.x)).replace('{y}', String(t.y))

/** A tile's map data, or null where there is none (open sea, mostly). */
export async function fetchFeatures(tile: TileId, signal?: AbortSignal): Promise<TileFeatures | null> {
  const pattern = await vectorTemplate()
  try {
    const response = await fetchWithRetry(address(pattern, tile), signal)
    const bytes = new Uint8Array(await response.arrayBuffer())
    return readTile(tile, bytes)
  } catch (error) {
    if (error instanceof FetchError && error.status === 404) return null
    throw error
  }
}

/** A tile's ground heights. */
export async function fetchHeights(tile: TileId, signal?: AbortSignal): Promise<HeightTile | null> {
  try {
    const response = await fetchWithRetry(address(TERRAIN_TILES, tile), signal)
    // Read here rather than through a canvas: the pixels are numbers, and must come out exactly.
    const image = await decodePng(new Uint8Array(await response.arrayBuffer()))
    return heightsFromTerrarium(tile, image.data, image.width)
  } catch (error) {
    if (error instanceof FetchError && error.status === 404) return null
    throw error
  }
}

/** A tile at a zoom, or the one it lies in at a coarser zoom. */
export function ancestorAt(tile: TileId, z: number): TileId {
  if (tile.z <= z) return tile
  const shift = tile.z - z
  return { z, x: tile.x >> shift, y: tile.y >> shift }
}

/**
 * Heights from a height tile as a function of longitude and latitude.
 * Below sea level counts as sea level: the sea floor is in the data, but
 * the sea's surface is what's seen.
 */
export function heightSampler(source: HeightTile | null): (lon: number, lat: number) => number {
  if (!source) return () => 0
  return (lon, lat) => Math.max(0, sampleHeight(source, lon, lat) ?? 0)
}

/**
 * Heights over an area from several height tiles (the finest zoom by
 * default), for when an area spans more than one.
 */
export class HeightField {
  private readonly tiles: HeightTile[]
  constructor(tiles: HeightTile[]) {
    this.tiles = tiles
  }

  at(lon: number, lat: number): number {
    for (const tile of this.tiles) {
      const h = sampleHeight(tile, lon, lat)
      if (h !== null) return Math.max(0, h)
    }
    return 0
  }
}

/** Keeps the most recently used values, up to a number of them. */
export class Lru<V> {
  private readonly map = new Map<string, V>()
  private readonly capacity: number
  constructor(capacity: number) {
    this.capacity = capacity
  }

  get(key: string): V | undefined {
    const value = this.map.get(key)
    if (value !== undefined) {
      this.map.delete(key)
      this.map.set(key, value)
    }
    return value
  }

  delete(key: string): void {
    this.map.delete(key)
  }

  set(key: string, value: V): void {
    this.map.delete(key)
    this.map.set(key, value)
    while (this.map.size > this.capacity) this.map.delete(this.map.keys().next().value!)
  }
}

/** A tile's middle. */
export function tileMiddle(tile: TileId): { lon: number; lat: number } {
  return { lon: tileLon(tile.x + 0.5, tile.z), lat: tileLat(tile.y + 0.5, tile.z) }
}
