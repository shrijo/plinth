import { signedArea2, type Vec2 } from '../math.ts'
import type { GeoOrigin } from '../model.ts'

/**
 * Real-world data brought onto the site: parcels from GeoJSON, terrain
 * points from XYZ or CSV. Coordinates are longitude and latitude (WGS 84,
 * as GeoJSON is meant to be) or projected metres (as cadastral data often
 * comes, Swiss LV95 for one). Either way they're turned into site metres
 * around an origin: the project's, or (for its first import) the middle of
 * the data, which then becomes the project's.
 */

const EARTH_RADIUS = 6371008.8

/** Turns real-world coordinates into site metres, and says which origin it used. */
export interface SiteProjection {
  origin: GeoOrigin
  toSite: (x: number, y: number) => Vec2
}

/** Whether coordinates are longitude and latitude rather than metres. */
export function looksLonLat(points: readonly [number, number][]): boolean {
  return points.length > 0 && points.every(([x, y]) => Math.abs(x) <= 180 && Math.abs(y) <= 90)
}

/**
 * A projection onto the site for some data: around the project's origin if
 * it has one of the same kind, otherwise around the data's own middle.
 */
export function siteProjection(points: readonly [number, number][], current: GeoOrigin | undefined): SiteProjection {
  const lonLat = looksLonLat(points)
  const middle = middleOf(points)
  if (lonLat) {
    const origin: GeoOrigin = current?.kind === 'lonlat' ? current : { kind: 'lonlat', lon: middle.x, lat: middle.y }
    const metresPerDegree = (EARTH_RADIUS * Math.PI) / 180
    const across = Math.cos((origin.lat * Math.PI) / 180) * metresPerDegree
    return { origin, toSite: (lon, lat) => ({ x: (lon - origin.lon) * across, y: (lat - origin.lat) * metresPerDegree }) }
  }
  const origin: GeoOrigin = current?.kind === 'projected' ? current : { kind: 'projected', x: Math.round(middle.x), y: Math.round(middle.y) }
  return { origin, toSite: (x, y) => ({ x: x - origin.x, y: y - origin.y }) }
}

function middleOf(points: readonly [number, number][]): Vec2 {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [x, y] of points) {
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 }
}

// Parcels from GeoJSON

export interface ImportedParcel {
  name: string
  points: Vec2[]
}

export class GeoDataError extends Error {}

const NAME_KEYS = ['name', 'Name', 'NAME', 'nummer', 'Nummer', 'NUMMER', 'number', 'parcel', 'EGRIS_EGRID', 'egrid', 'EGRID', 'id', 'ID']

/**
 * Parcels from a GeoJSON file: every polygon (the outer ring of each part
 * of a multipolygon) of its features, named from the feature's properties.
 */
export function parcelsFromGeoJSON(text: string, current: GeoOrigin | undefined): { parcels: ImportedParcel[]; origin: GeoOrigin } {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new GeoDataError('This is not a GeoJSON file.')
  }
  const rings: { name: string; ring: [number, number][] }[] = []
  const features = featuresOf(data)
  features.forEach((feature, i) => {
    const name = nameOf(feature.properties) ?? (feature.id !== undefined ? String(feature.id) : `Parcel ${i + 1}`)
    const geometry = feature.geometry
    if (!geometry || typeof geometry !== 'object') return
    const parts: unknown[] =
      geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.type === 'MultiPolygon' ? (geometry.coordinates as unknown[]) : []
    parts.forEach((part, k) => {
      const outer = Array.isArray(part) ? part[0] : undefined
      if (!Array.isArray(outer)) return
      const ring = outer.filter(
        (p): p is [number, number] => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]),
      )
      if (ring.length >= 4) rings.push({ name: parts.length > 1 ? `${name} (${k + 1})` : name, ring: ring.map(([x, y]) => [x, y]) })
    })
  })
  if (rings.length === 0) throw new GeoDataError('The file has no polygons to make parcels from.')
  const projection = siteProjection(
    rings.flatMap((r) => r.ring),
    current,
  )
  const parcels = rings.flatMap(({ name, ring }) => {
    let points = ring.map(([x, y]) => projection.toSite(x, y))
    // GeoJSON rings repeat their first point at the end.
    const first = points[0]!
    const last = points.at(-1)!
    if (Math.hypot(first.x - last.x, first.y - last.y) < 1e-6) points = points.slice(0, -1)
    if (points.length < 3 || Math.abs(signedArea2(points)) < 1e-3) return []
    return [{ name, points }]
  })
  return { parcels, origin: projection.origin }
}

interface Feature {
  id?: unknown
  properties?: Record<string, unknown> | null
  geometry?: { type?: string; coordinates?: unknown } | null
}

function featuresOf(data: unknown): Feature[] {
  if (!data || typeof data !== 'object') return []
  const object = data as { type?: string; features?: unknown; geometry?: unknown }
  if (object.type === 'FeatureCollection' && Array.isArray(object.features)) return object.features as Feature[]
  if (object.type === 'Feature') return [object as Feature]
  if (object.type === 'Polygon' || object.type === 'MultiPolygon') return [{ geometry: object as Feature['geometry'] }]
  return []
}

function nameOf(properties: Feature['properties']): string | null {
  if (!properties) return null
  for (const key of NAME_KEYS) {
    const value = properties[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number') return String(value)
  }
  return null
}

// Terrain points from XYZ or CSV

/**
 * Terrain points from a text file of x, y, z per line (separated by spaces,
 * tabs, commas or semicolons; a header line or comments are skipped).
 * x and y as longitude and latitude or projected metres, z in metres.
 */
export function pointsFromXYZ(text: string, current: GeoOrigin | undefined): { points: { x: number; y: number; z: number }[]; origin: GeoOrigin } {
  const raw: [number, number, number][] = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const values = trimmed.split(/[\s,;]+/).map(Number)
    if (values.length < 3 || values.slice(0, 3).some((v) => !Number.isFinite(v))) continue
    raw.push([values[0]!, values[1]!, values[2]!])
  }
  if (raw.length === 0) throw new GeoDataError('The file has no lines of x, y and height.')
  const projection = siteProjection(
    raw.map(([x, y]) => [x, y]),
    current,
  )
  return {
    points: raw.map(([x, y, z]) => ({ ...projection.toSite(x, y), z })),
    origin: projection.origin,
  }
}


