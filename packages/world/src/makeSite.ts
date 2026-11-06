import { fetchOsm } from './osm.ts'
import { planFromOsm, planFromTiles, squareAround, type SitePlan } from './site.ts'
import { fetchFeatures, fetchHeights, fetchWithRetry, HeightField } from './sources.ts'
import { tilesCovering } from './tiles.ts'

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
  const field = new HeightField((await heights).filter((h) => h !== null))
  const input = { name: await name, lon: area.lon, lat: area.lat, size: area.size, heightAt: (lon: number, lat: number) => field.at(lon, lat) }
  onProgress?.('Fetching buildings and streets from OpenStreetMap…')
  try {
    const osm = await fetchOsm(bounds, signal)
    if (osm.buildings.length > 0 || osm.streets.length > 0) return planFromOsm(input, osm)
  } catch (error) {
    if (signal?.aborted) throw error
  }
  onProgress?.('OpenStreetMap is busy: using map tiles instead…')
  const data = (await tiles).filter((t) => t !== null)
  return planFromTiles(input, data)
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
