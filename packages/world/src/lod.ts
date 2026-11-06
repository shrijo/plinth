import { ecefFromLonLat, EARTH_RADIUS_A, type Vec3 } from './geo.ts'
import { tileWidth } from './mesh.ts'
import { tileChildren, tileKey, tileLat, tileLon, type TileId } from './tiles.ts'

/**
 * Which tiles to draw for a view: a quadtree from the whole world down,
 * each tile split into its four children while its texture would show
 * coarser than `maxError` pixels per texel. Tiles out of view or behind
 * the horizon are left out. Only tiles that are ready can be drawn; where
 * a tile's children aren't all ready yet, it stands in for them.
 */

export interface View {
  /** The camera, in ECEF. */
  camera: Vec3
  /** Whether a sphere (ECEF centre, radius in metres) is at least partly in view. */
  inView: (centre: Vec3, radius: number) => boolean
  /** Pixels per metre at one metre from the camera (screen height over the view's height there). */
  pixelsPerMetre: number
  /** Texture pixels per tile side. */
  textureSize: number
  /** Coarsest acceptable detail: screen pixels per texel. */
  maxError: number
  maxZoom: number
  /** Tiles further than this from the camera (metres) are left out; infinite by default. */
  maxDistance?: number
}

export interface Bounds {
  centre: Vec3
  radius: number
}

/** A sphere round a tile, for heights from `low` to `high`. */
export function tileSphere(tile: TileId, low: number, high: number): Bounds {
  const points: Vec3[] = []
  const steps = tile.z < 3 ? 4 : 2
  for (let j = 0; j <= steps; j++) {
    for (let i = 0; i <= steps; i++) {
      const lon = tileLon(tile.x + i / steps, tile.z)
      const lat = tileLat(tile.y + j / steps, tile.z)
      points.push(ecefFromLonLat(lon, lat, low), ecefFromLonLat(lon, lat, high))
    }
  }
  const centre: Vec3 = [0, 0, 0]
  for (const p of points) for (let k = 0; k < 3; k++) centre[k]! += p[k]! / points.length
  let radius = 0
  for (const p of points) radius = Math.max(radius, Math.hypot(p[0] - centre[0], p[1] - centre[1], p[2] - centre[2]))
  // The curve bulges between the samples.
  return { centre, radius: radius * (tile.z < 3 ? 1.15 : 1.02) }
}

/**
 * Levels the search may go past tiles not loaded yet. Until a tile is in,
 * its heights (and so its bounds) are guesses; going deeper on guesses would
 * ask for far more tiles than the view needs.
 */
const MAX_UNREADY = 3

export interface Selection {
  /** Tiles to draw: ready, covering the view once each. */
  draw: TileId[]
  /** The tiles the view calls for, ready or not (where splitting stops). */
  ideal: TileId[]
  /** Tiles to load, the most needed first. */
  want: TileId[]
}

export interface Selector {
  isReady: (key: string) => boolean
  /** Ground heights known for a tile (from it or an ancestor), for its bounds. */
  heightRange: (tile: TileId) => [number, number]
}

const boundsCache = new Map<string, { bounds: Bounds; low: number; high: number }>()

function boundsOf(tile: TileId, key: string, low: number, high: number): Bounds {
  const hit = boundsCache.get(key)
  if (hit && hit.low === low && hit.high === high) return hit.bounds
  const bounds = tileSphere(tile, low, high)
  if (boundsCache.size > 20000) boundsCache.clear()
  boundsCache.set(key, { bounds, low, high })
  return bounds
}

/** Whether a sphere is entirely below the horizon seen from `camera`. */
function behindHorizon(camera: Vec3, bounds: Bounds): boolean {
  const d = Math.hypot(camera[0], camera[1], camera[2])
  // The polar radius: the smallest the Earth gets, so nothing is hidden that shouldn't be.
  const r = 6356752
  if (d <= r) return false
  const toward = (bounds.centre[0] * camera[0] + bounds.centre[1] * camera[1] + bounds.centre[2] * camera[2]) / d
  return toward + bounds.radius < (r * r) / d
}

export function selectTiles(view: View, selector: Selector): Selection {
  const draw: TileId[] = []
  const ideal: TileId[] = []
  const want: { tile: TileId; priority: number }[] = []
  /** `unready`: how many tiles above this one aren't loaded yet; the search goes no more than a few levels past them. */
  const cover = (tile: TileId, unready = 0): TileId[] | null => {
    const key = tileKey(tile)
    const [low, high] = selector.heightRange(tile)
    const bounds = boundsOf(tile, key, low, high)
    if (tile.z >= 2 && behindHorizon(view.camera, bounds)) return []
    if (tile.z >= 1 && !view.inView(bounds.centre, bounds.radius)) return []
    const distance = Math.max(
      Math.hypot(view.camera[0] - bounds.centre[0], view.camera[1] - bounds.centre[1], view.camera[2] - bounds.centre[2]) - bounds.radius,
      1,
    )
    if (view.maxDistance !== undefined && distance > view.maxDistance && tile.z > 2) return []
    const texel = tileWidth(tile) / view.textureSize
    const error = (texel / distance) * view.pixelsPerMetre
    const ready = selector.isReady(key)
    const unknown = ready ? 0 : unready + 1
    const refine = tile.z < view.maxZoom && (tile.z < 2 || error > view.maxError) && unknown <= MAX_UNREADY
    if (!refine) ideal.push(tile)
    if (refine) {
      const parts: TileId[] = []
      let covered = true
      for (const child of tileChildren(tile)) {
        const part = cover(child, unknown)
        if (part === null) covered = false
        else parts.push(...part)
      }
      if (covered) return parts
    }
    if (!ready) want.push({ tile, priority: tile.z * 1e9 + distance })
    return ready ? [tile] : null
  }
  draw.push(...(cover({ z: 0, x: 0, y: 0 }) ?? []))
  want.sort((a, b) => a.priority - b.priority)
  return { draw, ideal, want: want.map((w) => w.tile) }
}

/** Metres from the Earth's middle to its surface at the equator. */
export const EQUATOR_RADIUS = EARTH_RADIUS_A
