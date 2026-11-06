import { fetchWithRetry } from './sources.ts'

/**
 * Finding places by name: Photon (komoot's geocoder over OpenStreetMap,
 * made for searching as you type), with Nominatim to fall back on. Typed
 * coordinates ("47.37, 8.54") go straight there.
 */

export interface Place {
  name: string
  /** Where it is: the city, region and country it's in. */
  detail: string
  lon: number
  lat: number
  /** How big it is, roughly (metres across), to choose how close to fly. */
  size: number
}

const PHOTON = 'https://photon.komoot.io/api/'
const NOMINATIM = 'https://nominatim.openstreetmap.org/search'

export async function searchPlaces(query: string, signal?: AbortSignal): Promise<Place[]> {
  const text = query.trim()
  if (!text) return []
  const coordinates = parseCoordinates(text)
  if (coordinates) return [{ name: text, detail: 'Coordinates', ...coordinates, size: 600 }]
  try {
    return await photon(text, signal)
  } catch (error) {
    if (signal?.aborted) throw error
    return nominatim(text, signal)
  }
}

/** "47.37, 8.54" (latitude first, as maps give them) or "8.54 47.37 lon lat" style pairs. */
export function parseCoordinates(text: string): { lon: number; lat: number } | null {
  const match = /^\s*(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(text)
  if (!match) return null
  const a = Number(match[1])
  const b = Number(match[2])
  if (Math.abs(a) <= 90 && Math.abs(b) <= 180) return { lat: a, lon: b }
  if (Math.abs(b) <= 90 && Math.abs(a) <= 180) return { lat: b, lon: a }
  return null
}

interface PhotonFeature {
  geometry: { coordinates: [number, number] }
  properties: {
    name?: string
    street?: string
    housenumber?: string
    city?: string
    state?: string
    country?: string
    extent?: [number, number, number, number]
    type?: string
  }
}

async function photon(text: string, signal?: AbortSignal): Promise<Place[]> {
  const response = await fetchWithRetry(`${PHOTON}?q=${encodeURIComponent(text)}&limit=6`, signal, 2)
  const json = (await response.json()) as { features?: PhotonFeature[] }
  return (json.features ?? []).map((f) => {
    const p = f.properties
    const [lon, lat] = f.geometry.coordinates
    const street = p.street ? `${p.street}${p.housenumber ? ` ${p.housenumber}` : ''}` : ''
    const name = p.name ?? street ?? text
    const detail = [p.name ? street : '', p.city !== name ? p.city : '', p.state, p.country].filter(Boolean).join(', ')
    return { name: name || text, detail, lon, lat, size: sizeOf(p.extent, p.type) }
  })
}

function sizeOf(extent: [number, number, number, number] | undefined, type: string | undefined): number {
  if (extent) {
    const [west, north, east, south] = extent
    const lat = ((north + south) / 2) * (Math.PI / 180)
    const across = Math.abs(east - west) * 111320 * Math.cos(lat)
    const up = Math.abs(north - south) * 110540
    return Math.min(Math.max(across, up, 300), 4_000_000)
  }
  return type === 'house' || type === 'street' ? 400 : 3000
}

interface NominatimResult {
  display_name: string
  name?: string
  lat: string
  lon: string
  boundingbox?: [string, string, string, string]
}

async function nominatim(text: string, signal?: AbortSignal): Promise<Place[]> {
  const response = await fetchWithRetry(`${NOMINATIM}?q=${encodeURIComponent(text)}&format=jsonv2&limit=6`, signal, 2)
  const json = (await response.json()) as NominatimResult[]
  return json.map((r) => {
    const parts = r.display_name.split(', ')
    const box = r.boundingbox?.map(Number)
    const extent: [number, number, number, number] | undefined = box ? [box[2]!, box[1]!, box[3]!, box[0]!] : undefined
    return {
      name: r.name || parts[0] || text,
      detail: parts.slice(1).join(', '),
      lon: Number(r.lon),
      lat: Number(r.lat),
      size: sizeOf(extent, undefined),
    }
  })
}
