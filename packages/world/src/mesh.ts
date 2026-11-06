import earcut from 'earcut'
import type { BuildingFeature, Line } from './features.ts'
import { clipShape, ringCentroid, UNIT, type Rect } from './clip.ts'
import { ecefFromLonLat, enuFrame, type Frame, type Vec3 } from './geo.ts'
import { tileLat, tileLon, type TileId } from './tiles.ts'

/**
 * Meshes for a tile, each in a frame of its own at the tile's middle (see
 * tileFrame), so coordinates stay small and precise. Positions are in
 * three.js's axes: x east, y up, z south.
 */

export interface MeshBuffers {
  positions: Float32Array
  normals: Float32Array
  indices: Uint32Array
  /** Texture coordinates (ground) or colours per vertex (buildings). */
  uvs?: Float32Array
  colors?: Float32Array
}

/** A tile's frame: east, north and up at its middle, on the ellipsoid. */
export function tileFrame(tile: TileId): Frame & { lon: number; lat: number } {
  const lon = tileLon(tile.x + 0.5, tile.z)
  const lat = tileLat(tile.y + 0.5, tile.z)
  return { ...enuFrame(lon, lat, 0), lon, lat }
}

/** Ground heights at points of a tile (tile units), in metres above sea level. */
export type HeightAt = (lon: number, lat: number) => number

/** A point (longitude, latitude, height) in a frame, in three.js axes. */
function place(frame: Frame, ecef: Vec3, out: Float32Array, at: number): void {
  const dx = ecef[0] - frame.origin[0]
  const dy = ecef[1] - frame.origin[1]
  const dz = ecef[2] - frame.origin[2]
  const e = frame.east[0] * dx + frame.east[1] * dy + frame.east[2] * dz
  const n = frame.north[0] * dx + frame.north[1] * dy + frame.north[2] * dz
  const u = frame.up[0] * dx + frame.up[1] * dy + frame.up[2] * dz
  out[at] = e
  out[at + 1] = u
  out[at + 2] = -n
}

// Ground

export interface GroundMesh extends MeshBuffers {
  uvs: Float32Array
  low: number
  high: number
}

/**
 * The ground of a tile: a grid of `segments` × `segments` squares draped
 * over the heights (and following the Earth's curve), with a skirt hanging
 * down round its edge so no gap shows where it meets a neighbour drawn in
 * less detail. Texture coordinates run from the north-west corner.
 */
export function groundMesh(tile: TileId, heightAt: HeightAt, segments: number): GroundMesh {
  const frame = tileFrame(tile)
  const side = segments + 1
  const grid = side * side
  // A ring of skirt points below the edge.
  const skirtCount = segments * 4
  const total = grid + skirtCount
  const positions = new Float32Array(total * 3)
  const uvs = new Float32Array(total * 2)
  const heights = new Float32Array(grid)
  let low = Infinity
  let high = -Infinity
  const lons = new Float64Array(side)
  const lats = new Float64Array(side)
  for (let i = 0; i < side; i++) {
    lons[i] = tileLon(tile.x + i / segments, tile.z)
    lats[i] = tileLat(tile.y + i / segments, tile.z)
  }
  for (let j = 0; j < side; j++) {
    for (let i = 0; i < side; i++) {
      const k = j * side + i
      const h = heightAt(lons[i]!, lats[j]!)
      heights[k] = h
      low = Math.min(low, h)
      high = Math.max(high, h)
      place(frame, ecefFromLonLat(lons[i]!, lats[j]!, h), positions, k * 3)
      uvs[k * 2] = i / segments
      uvs[k * 2 + 1] = j / segments
    }
  }
  const indices: number[] = []
  for (let j = 0; j < segments; j++) {
    for (let i = 0; i < segments; i++) {
      const a = j * side + i
      const b = a + 1
      const c = a + side
      const d = c + 1
      // Counter-clockwise seen from above (north is up the grid's rows, which run south).
      indices.push(a, c, b, b, c, d)
    }
  }
  const normals = gridNormals(positions, indices, total)

  // The skirt: the edge, walked round, and the same points dropped by a share of the tile's size.
  const width = tileWidth(tile)
  const drop = Math.min(width * 0.03 + 5, 3000)
  const edge: number[] = []
  for (let i = 0; i < segments; i++) edge.push(i) // north edge, west to east
  for (let j = 0; j < segments; j++) edge.push(j * side + segments) // east edge, north to south
  for (let i = segments; i > 0; i--) edge.push(segments * side + i) // south edge, east to west
  for (let j = segments; j > 0; j--) edge.push(j * side) // west edge, south to north
  edge.forEach((k, s) => {
    const at = grid + s
    const i = k % side
    const j = Math.floor(k / side)
    place(frame, ecefFromLonLat(lons[i]!, lats[j]!, heights[k]! - drop), positions, at * 3)
    uvs[at * 2] = uvs[k * 2]!
    uvs[at * 2 + 1] = uvs[k * 2 + 1]!
    normals[at * 3] = normals[k * 3]!
    normals[at * 3 + 1] = normals[k * 3 + 1]!
    normals[at * 3 + 2] = normals[k * 3 + 2]!
  })
  for (let s = 0; s < edge.length; s++) {
    const a = edge[s]!
    const b = edge[(s + 1) % edge.length]!
    const a2 = grid + s
    const b2 = grid + ((s + 1) % edge.length)
    // Both ways round, so a gap seen from either side shows the skirt (lit as the ground is: it shares its normals).
    indices.push(a, b, a2, b, b2, a2, a, a2, b, b, a2, b2)
  }
  return { positions, normals, uvs, indices: Uint32Array.from(indices), low, high }
}

function gridNormals(positions: Float32Array, indices: number[], count: number): Float32Array {
  const normals = new Float32Array(count * 3)
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t]! * 3
    const b = indices[t + 1]! * 3
    const c = indices[t + 2]! * 3
    const ux = positions[b]! - positions[a]!
    const uy = positions[b + 1]! - positions[a + 1]!
    const uz = positions[b + 2]! - positions[a + 2]!
    const vx = positions[c]! - positions[a]!
    const vy = positions[c + 1]! - positions[a + 1]!
    const vz = positions[c + 2]! - positions[a + 2]!
    const nx = uy * vz - uz * vy
    const ny = uz * vx - ux * vz
    const nz = ux * vy - uy * vx
    for (const k of [a, b, c]) {
      normals[k] = normals[k]! + nx
      normals[k + 1] = normals[k + 1]! + ny
      normals[k + 2] = normals[k + 2]! + nz
    }
  }
  for (let k = 0; k < normals.length; k += 3) {
    const l = Math.hypot(normals[k]!, normals[k + 1]!, normals[k + 2]!) || 1
    normals[k] = normals[k]! / l
    normals[k + 1] = normals[k + 1]! / l
    normals[k + 2] = normals[k + 2]! / l
  }
  return normals
}

/** A tile's width at its middle, in metres. */
export function tileWidth(tile: TileId): number {
  const lat = tileLat(tile.y + 0.5, tile.z)
  return (2 * Math.PI * 6378137 * Math.cos((lat * Math.PI) / 180)) / 2 ** tile.z
}

// Buildings

export interface BuildingColours {
  wall: [number, number, number]
  roof: [number, number, number]
}

export interface BuildingOptions {
  /** Leaves out buildings whose middle (longitude, latitude) this says no to. */
  keep?: (lon: number, lat: number) => boolean
  /** Only what's inside this part of the tile (tile units); the whole tile by default. */
  rect?: Rect
}

/** How far walls reach below the lowest ground under a building, so slopes never show a gap. */
const FOOTING = 3

/**
 * The buildings of a tile, extruded from their footprints: walls straight
 * up from below the ground to their height, and a flat top. Each is cut to
 * the tile, so buildings across a seam are drawn by both tiles, each its
 * part, and never twice.
 */
export function buildingMesh(
  tile: TileId,
  buildings: readonly BuildingFeature[],
  heightAt: HeightAt,
  colours: BuildingColours,
  options: BuildingOptions = {},
): MeshBuffers | null {
  const frame = tileFrame(tile)
  const writer = new MeshWriter()
  const rect = options.rect ?? UNIT
  const n = 2 ** tile.z
  const lonOf = (u: number) => ((tile.x + u) / n) * 360 - 180
  const latOf = (v: number) => tileLat(tile.y + v, tile.z)
  for (const building of buildings) {
    const shape = clipShape(building.shape, rect)
    if (!shape) continue
    if (options.keep) {
      const [cu, cv] = ringCentroid(building.shape.outer)
      if (!options.keep(lonOf(cu), latOf(cv))) continue
    }
    const rings = [orient(shape.outer, true), ...shape.holes.map((h) => orient(h, false))]
    // Points on the ellipsoid and the way up there, once per corner.
    const ground: number[][] = []
    let base = Infinity
    for (const ring of rings) {
      const points: number[] = []
      for (let i = 0; i < ring.length; i += 2) {
        const lon = lonOf(ring[i]!)
        const lat = latOf(ring[i + 1]!)
        base = Math.min(base, heightAt(lon, lat))
        points.push(lon, lat)
      }
      ground.push(points)
    }
    if (!Number.isFinite(base)) continue
    const bottom = building.minHeight > 0 ? base + building.minHeight : base - FOOTING
    const top = base + building.height
    writer.prism(frame, ground, bottom, top, building.minHeight > 0, colours)
  }
  return writer.finish()
}

/** A ring turned so it runs anticlockwise on the map (outer) or clockwise (hole). */
function orient(ring: Line, outer: boolean): Line {
  // Shoelace with y southwards: positive is anticlockwise on the map.
  let sum = 0
  const n = ring.length / 2
  for (let i = 0, j = n - 1; i < n; j = i++) sum += ring[j * 2]! * ring[i * 2 + 1]! - ring[i * 2]! * ring[j * 2 + 1]!
  if (sum > 0 === outer) return ring
  const reversed = new Float64Array(ring.length)
  for (let i = 0; i < n; i++) {
    reversed[i * 2] = ring[(n - 1 - i) * 2]!
    reversed[i * 2 + 1] = ring[(n - 1 - i) * 2 + 1]!
  }
  return reversed
}

class MeshWriter {
  private positions: number[] = []
  private normals: number[] = []
  private colors: number[] = []
  private indices: number[] = []
  private scratch = new Float32Array(3)

  private vertex(frame: Frame, lon: number, lat: number, height: number, normal: Vec3, colour: readonly number[]): number {
    place(frame, ecefFromLonLat(lon, lat, height), this.scratch, 0)
    this.positions.push(this.scratch[0]!, this.scratch[1]!, this.scratch[2]!)
    this.normals.push(normal[0], normal[1], normal[2])
    this.colors.push(colour[0]!, colour[1]!, colour[2]!)
    return this.positions.length / 3 - 1
  }

  /** Walls round each ring (lon, lat pairs) from `bottom` to `top`, a roof, and a floor if it's raised. */
  prism(frame: Frame, rings: number[][], bottom: number, top: number, underside: boolean, colours: BuildingColours): void {
    const at = (lon: number, lat: number, h: number): Vec3 => {
      place(frame, ecefFromLonLat(lon, lat, h), this.scratch, 0)
      return [this.scratch[0]!, this.scratch[1]!, this.scratch[2]!]
    }
    for (const ring of rings) {
      const n = ring.length / 2
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n
        const a = at(ring[i * 2]!, ring[i * 2 + 1]!, bottom)
        const b = at(ring[j * 2]!, ring[j * 2 + 1]!, bottom)
        // Outwards: to the right of the edge seen from above (x east, z south).
        const dx = b[0] - a[0]
        const dz = b[2] - a[2]
        const l = Math.hypot(dx, dz)
        if (l < 0.05) continue
        const normal: Vec3 = [-dz / l, 0, dx / l]
        const k0 = this.vertex(frame, ring[i * 2]!, ring[i * 2 + 1]!, bottom, normal, colours.wall)
        const k1 = this.vertex(frame, ring[j * 2]!, ring[j * 2 + 1]!, bottom, normal, colours.wall)
        const k2 = this.vertex(frame, ring[j * 2]!, ring[j * 2 + 1]!, top, normal, colours.wall)
        const k3 = this.vertex(frame, ring[i * 2]!, ring[i * 2 + 1]!, top, normal, colours.wall)
        this.indices.push(k0, k1, k2, k0, k2, k3)
      }
    }
    // The roof, triangulated on the map (east, north) and laid at the top.
    const flat: number[] = []
    const holes: number[] = []
    const lonLat: number[] = []
    rings.forEach((ring, r) => {
      if (r > 0) holes.push(flat.length / 2)
      for (let i = 0; i < ring.length; i += 2) {
        const p = at(ring[i]!, ring[i + 1]!, top)
        flat.push(p[0], -p[2])
        lonLat.push(ring[i]!, ring[i + 1]!)
      }
    })
    const triangles = earcut(flat, holes, 2)
    if (triangles.length === 0) return
    const up: Vec3 = [0, 1, 0]
    const first = this.positions.length / 3
    for (let i = 0; i < lonLat.length; i += 2) this.vertex(frame, lonLat[i]!, lonLat[i + 1]!, top, up, colours.roof)
    for (let t = 0; t < triangles.length; t += 3) {
      const a = triangles[t]!
      const b = triangles[t + 1]!
      const c = triangles[t + 2]!
      // Anticlockwise on the map faces up.
      const ccw = (flat[b * 2]! - flat[a * 2]!) * (flat[c * 2 + 1]! - flat[a * 2 + 1]!) - (flat[b * 2 + 1]! - flat[a * 2 + 1]!) * (flat[c * 2]! - flat[a * 2]!) > 0
      if (ccw) this.indices.push(first + a, first + b, first + c)
      else this.indices.push(first + a, first + c, first + b)
    }
    if (!underside) return
    const down: Vec3 = [0, -1, 0]
    const below = this.positions.length / 3
    for (let i = 0; i < lonLat.length; i += 2) this.vertex(frame, lonLat[i]!, lonLat[i + 1]!, bottom, down, colours.wall)
    for (let t = 0; t < triangles.length; t += 3) {
      const a = triangles[t]!
      const b = triangles[t + 1]!
      const c = triangles[t + 2]!
      const ccw = (flat[b * 2]! - flat[a * 2]!) * (flat[c * 2 + 1]! - flat[a * 2 + 1]!) - (flat[b * 2 + 1]! - flat[a * 2 + 1]!) * (flat[c * 2]! - flat[a * 2]!) > 0
      if (ccw) this.indices.push(below + a, below + c, below + b)
      else this.indices.push(below + a, below + b, below + c)
    }
  }

  finish(): MeshBuffers | null {
    if (this.indices.length === 0) return null
    return {
      positions: Float32Array.from(this.positions),
      normals: Float32Array.from(this.normals),
      colors: Float32Array.from(this.colors),
      indices: Uint32Array.from(this.indices),
    }
  }
}
