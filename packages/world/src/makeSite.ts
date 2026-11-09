import { fetchOsm } from './osm.ts'
import { planFromOsm, planFromTiles, squareAround, type SitePlan } from './site.ts'
import type { TileFeatures } from './features.ts'
import { makeGround } from './ground.ts'
import { fetchFeatures, fetchHeights, fetchWithRetry } from './sources.ts'
import { lonLatToTileXY, tilesCovering } from './tiles.ts'

/**
 * Plans a site from a square of the world, fetching what it needs: ground
 * heights, then OpenStreetMap's buildings and streets (or, if its servers
 * don't answer in time, those in the map tiles), and a name for the place
 * if it has none.
 */
export async function planSite(
  area: { lon: number; lat: number; size: number; name: string | null },
  options: { signal?: AbortSignal; onProgress?: (text: string) => void } = {},
): Promise<SitePlan> {
  const { signal, onProgress } = options
  const { bounds } = squareAround(area.lon, area.lat, area.size, 30)
  onProgress?.('Fetching the lie of the land…')
  const heights = Promise.all(tilesCovering(bounds, 15).map((t) => fetchHeights(t, signal)))
  const tiles = Promise.all(tilesCovering(bounds, 14).map((t) => fetchFeatures(t, signal)))
  // Kept from failing loudly while it waits its turn.
  tiles.catch(() => undefined)
  const name = area.name ? Promise.resolve(area.name) : placeName(area.lon, area.lat, signal)
  // The ground as the world shows it: smoothed, with level beds under the streets and basins under the water.
  const heightTiles = (await heights).filter((h) => h !== null)
  const mapTiles = (await tiles.catch(() => [] as (TileFeatures | null)[])).filter((t) => t !== null)
  const grounds = mapTiles.length > 0 ? mapTiles.map((t) => makeGround(heightTiles, t)) : [makeGround(heightTiles, null)]
  const groundAt = (lon: number, lat: number) => {
    const { x, y } = lonLatToTileXY(lon, lat, 14)
    return grounds.find((g) => g.source && g.source.x === Math.floor(x) && g.source.y === Math.floor(y)) ?? grounds[0]!
  }
  const input = {
    name: await name,
    lon: area.lon,
    lat: area.lat,
    size: area.size,
    // The street bed: the site's streets are draped over its terrain, and meet the world's streets at its edge.
    heightAt: (lon: number, lat: number) => groundAt(lon, lat).level(lon, lat),
    waterAt: (lon: number, lat: number) => groundAt(lon, lat).waterAt(lon, lat),
    shores: shoresOf(mapTiles, bounds),
  }
  onProgress?.('Fetching buildings and streets from OpenStreetMap…')
  try {
    const osm = await fetchOsm(bounds, signal)
    if (osm.buildings.length > 0 || osm.streets.length > 0) return planFromOsm(input, osm)
  } catch (error) {
    if (signal?.aborted) throw error
  }
  onProgress?.('OpenStreetMap is busy: using map tiles instead…')
  return planFromTiles(input, mapTiles)
}

/** The outlines of the water in map tiles, near some bounds, as longitudes and latitudes. */
function shoresOf(tiles: readonly TileFeatures[], bounds: { west: number; east: number; south: number; north: number }): { lon: number; lat: number }[][] {
  const shores: { lon: number; lat: number }[][] = []
  for (const data of tiles) {
    const n = 2 ** data.tile.z
    for (const area of data.areas) {
      if (area.kind !== 'water') continue
      for (const ring of [area.shape.outer, ...area.shape.holes]) {
        const points: { lon: number; lat: number }[] = []
        for (let i = 0; i + 1 < ring.length; i += 2) {
          const lon = ((data.tile.x + ring[i]!) / n) * 360 - 180
          const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (data.tile.y + ring[i + 1]!)) / n))) * 180) / Math.PI
          points.push({ lon, lat })
        }
        if (points.length < 2) continue
        // Closed, and only if it comes near (a long straight shore can cross the bounds with no point in them).
        points.push(points[0]!)
        const lons = points.map((p) => p.lon)
        const lats = points.map((p) => p.lat)
        if (Math.max(...lons) >= bounds.west && Math.min(...lons) <= bounds.east && Math.max(...lats) >= bounds.south && Math.min(...lats) <= bounds.north) shores.push(points)
      }
    }
  }
  return shores
}

/** What a place is called (its street and town), or its coordinates. */
export async function placeName(lon: number, lat: number, signal?: AbortSignal): Promise<string> {
  const fallback = `Site at ${lat.toFixed(4)}, ${lon.toFixed(4)}`
  try {
    const response = await fetchWithRetry(`https://photon.komoot.io/reverse?lon=${lon}&lat=${lat}&limit=1`, signal, 1)
    const json = (await response.json()) as { features?: { properties: Record<string, string | undefined> }[] }
    const p = json.features?.[0]?.properties
    if (!p) return fallback
    const street = p.street ?? p.name
    const town = p.city ?? p.town ?? p.village ?? p.district ?? p.county
    return [street, town].filter(Boolean).join(', ') || fallback
  } catch {
    return fallback
  }
}
