/**
 * The Earth's shape (WGS 84) and local frames on it. Positions on the
 * globe are Earth-centred, Earth-fixed coordinates (ECEF, metres): huge
 * numbers, so everything drawn is placed in a local frame instead, with
 * east, north and up axes at a point on the surface, where metres are
 * small and precise.
 */

export type Vec3 = [number, number, number]

export const EARTH_RADIUS_A = 6378137
const FLATTENING = 1 / 298.257223563
const E2 = FLATTENING * (2 - FLATTENING)
/** The radius used where the Earth is taken as a sphere (horizon checks, the ray onto the ground). */
export const EARTH_RADIUS = 6371008.8

const RAD = Math.PI / 180

/** A point on the globe (degrees, metres above the ellipsoid) as ECEF. */
export function ecefFromLonLat(lon: number, lat: number, height = 0): Vec3 {
  const λ = lon * RAD
  const φ = lat * RAD
  const sinφ = Math.sin(φ)
  const cosφ = Math.cos(φ)
  const n = EARTH_RADIUS_A / Math.sqrt(1 - E2 * sinφ * sinφ)
  return [(n + height) * cosφ * Math.cos(λ), (n + height) * cosφ * Math.sin(λ), (n * (1 - E2) + height) * sinφ]
}

/** ECEF back to longitude, latitude (degrees) and height (Bowring's method, millimetre-exact on Earth). */
export function lonLatFromEcef([x, y, z]: Vec3): { lon: number; lat: number; height: number } {
  const b = EARTH_RADIUS_A * (1 - FLATTENING)
  const ep2 = (EARTH_RADIUS_A * EARTH_RADIUS_A - b * b) / (b * b)
  const p = Math.hypot(x, y)
  const θ = Math.atan2(z * EARTH_RADIUS_A, p * b)
  const φ = Math.atan2(z + ep2 * b * Math.sin(θ) ** 3, p - E2 * EARTH_RADIUS_A * Math.cos(θ) ** 3)
  const λ = Math.atan2(y, x)
  const n = EARTH_RADIUS_A / Math.sqrt(1 - E2 * Math.sin(φ) ** 2)
  const height = Math.abs(Math.cos(φ)) > 1e-9 ? p / Math.cos(φ) - n : Math.abs(z) - b
  return { lon: λ / RAD, lat: φ / RAD, height }
}

/** A local frame: an origin on the globe and its east, north and up directions. */
export interface Frame {
  origin: Vec3
  east: Vec3
  north: Vec3
  up: Vec3
}

export function enuFrame(lon: number, lat: number, height = 0): Frame {
  const λ = lon * RAD
  const φ = lat * RAD
  const sinλ = Math.sin(λ)
  const cosλ = Math.cos(λ)
  const sinφ = Math.sin(φ)
  const cosφ = Math.cos(φ)
  return {
    origin: ecefFromLonLat(lon, lat, height),
    east: [-sinλ, cosλ, 0],
    north: [-sinφ * cosλ, -sinφ * sinλ, cosφ],
    up: [cosφ * cosλ, cosφ * sinλ, sinφ],
  }
}

/** An ECEF point in a frame: [east, north, up] metres from its origin. */
export function toFrame(frame: Frame, p: Vec3): Vec3 {
  const dx = p[0] - frame.origin[0]
  const dy = p[1] - frame.origin[1]
  const dz = p[2] - frame.origin[2]
  return [dot(frame.east, dx, dy, dz), dot(frame.north, dx, dy, dz), dot(frame.up, dx, dy, dz)]
}

/** [east, north, up] in a frame back to ECEF. */
export function fromFrame(frame: Frame, [e, n, u]: Vec3): Vec3 {
  return [
    frame.origin[0] + frame.east[0] * e + frame.north[0] * n + frame.up[0] * u,
    frame.origin[1] + frame.east[1] * e + frame.north[1] * n + frame.up[1] * u,
    frame.origin[2] + frame.east[2] * e + frame.north[2] * n + frame.up[2] * u,
  ]
}

/** Longitude, latitude and height straight into a frame. */
export function lonLatToFrame(frame: Frame, lon: number, lat: number, height = 0): Vec3 {
  return toFrame(frame, ecefFromLonLat(lon, lat, height))
}

/** A frame's position in plan around another's origin (metres east and north), back to longitude and latitude. */
export function frameToLonLat(frame: Frame, east: number, north: number, up = 0): { lon: number; lat: number; height: number } {
  return lonLatFromEcef(fromFrame(frame, [east, north, up]))
}

/**
 * How a frame's coordinates map into another's: a 3 × 3 rotation (rows of
 * `into`'s axes dotted with `from`'s) and the translation of `from`'s
 * origin. Exact in double precision; used to place a tile's mesh, built in
 * its own frame, in the view's frame.
 */
export function frameToFrame(from: Frame, into: Frame): { rotation: number[]; translation: Vec3 } {
  const axes = [from.east, from.north, from.up]
  const rows = [into.east, into.north, into.up]
  const rotation: number[] = []
  for (const row of rows) for (const axis of axes) rotation.push(row[0] * axis[0] + row[1] * axis[1] + row[2] * axis[2])
  return { rotation, translation: toFrame(into, from.origin) }
}

/** Great-circle distance between two points, in metres. */
export function distanceBetween(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const φ1 = lat1 * RAD
  const φ2 = lat2 * RAD
  const dφ = φ2 - φ1
  const dλ = (lon2 - lon1) * RAD
  const h = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2
  return 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(h)))
}

function dot(axis: Vec3, x: number, y: number, z: number): number {
  return axis[0] * x + axis[1] * y + axis[2] * z
}
