import Delaunator from 'delaunator'
import { createId } from './ids.ts'
import type { Vec2 } from './math.ts'
import type { Id, Snapshot, SpotHeight } from './model.ts'
import type { Tx } from './tx.ts'
import type { MeshData } from './geometry/mesh.ts'

/**
 * The ground's shape, from spot heights: a surface of triangles through
 * them (Delaunay: as close to equal-sided as they come), the height at any
 * point on it, and contour lines. Buildings and streets keep their own
 * heights; "set on the terrain" puts a building's ground floor at the
 * ground under it.
 */
export interface Terrain {
  points: readonly SpotHeight[]
  /** Corner indices into `points`, three per triangle. */
  triangles: Uint32Array
  low: number
  high: number
}

const cache = new WeakMap<object, Terrain | null>()

/** The site's terrain, or null with fewer than three spot heights (or all in a line). */
export function terrainOf(snapshot: Snapshot): Terrain | null {
  const hit = cache.get(snapshot.spotHeights)
  if (hit !== undefined) return hit
  const points = Object.values(snapshot.spotHeights)
  let terrain: Terrain | null = null
  if (points.length >= 3) {
    const delaunay = Delaunator.from(
      points,
      (p) => p.x,
      (p) => p.y,
    )
    if (delaunay.triangles.length >= 3) {
      const zs = points.map((p) => p.z)
      terrain = { points, triangles: delaunay.triangles, low: Math.min(...zs), high: Math.max(...zs) }
    }
  }
  cache.set(snapshot.spotHeights, terrain)
  return terrain
}

/** The ground's height at a plan point, or null outside the terrain. */
export function heightAt(terrain: Terrain, p: Vec2): number | null {
  const { points, triangles } = terrain
  for (let i = 0; i < triangles.length; i += 3) {
    const a = points[triangles[i]!]!
    const b = points[triangles[i + 1]!]!
    const c = points[triangles[i + 2]!]!
    const det = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y)
    if (Math.abs(det) < 1e-12) continue
    const u = ((b.y - c.y) * (p.x - c.x) + (c.x - b.x) * (p.y - c.y)) / det
    const v = ((c.y - a.y) * (p.x - c.x) + (a.x - c.x) * (p.y - c.y)) / det
    const w = 1 - u - v
    if (u >= -1e-9 && v >= -1e-9 && w >= -1e-9) return u * a.z + v * b.z + w * c.z
  }
  return null
}

/** The terrain as a smooth-shaded mesh, in world coordinates (Y up, plan y as -z). */
export function terrainMesh(terrain: Terrain): MeshData {
  const { points, triangles } = terrain
  const positions = new Float32Array(points.length * 3)
  const normals = new Float32Array(points.length * 3)
  points.forEach((p, i) => {
    positions[i * 3] = p.x
    positions[i * 3 + 1] = p.z
    positions[i * 3 + 2] = -p.y
  })
  const indices = new Uint32Array(triangles.length)
  for (let i = 0; i < triangles.length; i += 3) {
    // Delaunator winds triangles clockwise in plan; facing up in the world means the other way.
    const a = triangles[i]!
    const b = triangles[i + 1]!
    const c = triangles[i + 2]!
    indices[i] = a
    indices[i + 1] = c
    indices[i + 2] = b
    // Each corner's normal is the sum of its triangles' (area-weighted) normals.
    const pa = points[a]!
    const pb = points[b]!
    const pc = points[c]!
    const ux = pc.x - pa.x
    const uy = pc.z - pa.z
    const uz = -(pc.y - pa.y)
    const vx = pb.x - pa.x
    const vy = pb.z - pa.z
    const vz = -(pb.y - pa.y)
    let nx = uy * vz - uz * vy
    let ny = uz * vx - ux * vz
    let nz = ux * vy - uy * vx
    if (ny < 0) {
      nx = -nx
      ny = -ny
      nz = -nz
    }
    for (const k of [a, b, c]) {
      normals[k * 3] = normals[k * 3]! + nx
      normals[k * 3 + 1] = normals[k * 3 + 1]! + ny
      normals[k * 3 + 2] = normals[k * 3 + 2]! + nz
    }
  }
  for (let k = 0; k < points.length; k++) {
    const length = Math.hypot(normals[k * 3]!, normals[k * 3 + 1]!, normals[k * 3 + 2]!) || 1
    normals[k * 3] = normals[k * 3]! / length
    normals[k * 3 + 1] = normals[k * 3 + 1]! / length
    normals[k * 3 + 2] = normals[k * 3 + 2]! / length
  }
  return { positions, normals, indices }
}

/** A contour line: its height and its pieces in plan. */
export interface Contour {
  z: number
  /** Every fifth line is an index contour, drawn stronger. */
  major: boolean
  segments: [Vec2, Vec2][]
}

/** A tidy step between contour lines for a height range: about 20 to 50 lines over it. */
export function contourInterval(low: number, high: number): number {
  const range = Math.max(high - low, 0.01)
  for (const step of [0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10, 20, 25, 50, 100]) if (range / step <= 50) return step
  return 200
}

export function contours(terrain: Terrain, interval = contourInterval(terrain.low, terrain.high)): Contour[] {
  const { points, triangles } = terrain
  const result: Contour[] = []
  const first = Math.ceil(terrain.low / interval)
  const last = Math.floor(terrain.high / interval)
  for (let n = first; n <= last; n++) {
    const z = n * interval
    const segments: [Vec2, Vec2][] = []
    for (let i = 0; i < triangles.length; i += 3) {
      const corners = [points[triangles[i]!]!, points[triangles[i + 1]!]!, points[triangles[i + 2]!]!]
      const crossings: Vec2[] = []
      for (let k = 0; k < 3; k++) {
        const p = corners[k]!
        const q = corners[(k + 1) % 3]!
        // Each edge counts the level once: at its low end, not its high end.
        if ((p.z < z && q.z >= z) || (q.z < z && p.z >= z)) {
          const t = (z - p.z) / (q.z - p.z)
          crossings.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t })
        }
      }
      if (crossings.length === 2) segments.push([crossings[0]!, crossings[1]!])
    }
    if (segments.length > 0) result.push({ z, major: n % 5 === 0, segments })
  }
  return result
}

// Editing

export function addSpotHeights(tx: Tx, points: readonly { x: number; y: number; z: number }[]): Id[] {
  return points.map((p) => tx.putSpotHeight({ id: createId(), x: p.x, y: p.y, z: p.z }).id)
}

export function moveSpotHeight(tx: Tx, id: Id, to: Vec2): void {
  const spot = tx.spotHeight(id)
  if (spot) tx.putSpotHeight({ ...spot, x: to.x, y: to.y })
}

export function setSpotHeight(tx: Tx, id: Id, z: number): void {
  const spot = tx.spotHeight(id)
  if (spot) tx.putSpotHeight({ ...spot, z })
}

/**
 * The height a building's ground floor should stand at to sit on the
 * terrain: the lowest ground under its corners (so no corner floats), or
 * null where it isn't over the terrain.
 */
export function groundUnder(terrain: Terrain, corners: readonly Vec2[]): number | null {
  let lowest: number | null = null
  for (const corner of corners) {
    const z = heightAt(terrain, corner)
    if (z !== null) lowest = lowest === null ? z : Math.min(lowest, z)
  }
  return lowest === null ? null : Math.round(lowest * 100) / 100
}
