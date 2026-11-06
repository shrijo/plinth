import earcut from 'earcut'
import type { BuildingFeature, Line, RoadFeature } from './features.ts'
import { clipLine, clipShape, ringCentroid, UNIT, type Rect } from './clip.ts'
import type { Ground } from './ground.ts'
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
  /** Outline: pairs of points along the sharp edges (buildings). */
  edges?: Float32Array
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
export function groundMesh(tile: TileId, heightAt: HeightAt, segments: number, waterAt?: (lon: number, lat: number) => number | null): GroundMesh {
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
      let h = heightAt(lons[i]!, lats[j]!)
      // Under water the ground falls away into a basin, so it never shows through the surface.
      const water = waterAt?.(lons[i]!, lats[j]!)
      if (water !== undefined && water !== null) h = Math.min(h, water - WATER_DEPTH)
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

/** How far the ground lies under the water's surface (metres). */
const WATER_DEPTH = 1.5

// Water

/**
 * The water surfaces in a tile: each lake, river or bit of sea in the map
 * data, cut to the tile, at its surface (see Ground), finely enough to
 * follow the Earth's curve and a river's fall. Its `level` is the average
 * height of the surface, for the reflection.
 */
export function waterMesh(tile: TileId, ground: Ground): (MeshBuffers & { level: number }) | null {
  const source = ground.source
  if (!source || ground.water.length === 0 || source.z > tile.z) return null
  const scale = 2 ** (tile.z - source.z)
  const rect: Rect = {
    minX: tile.x / scale - source.x,
    maxX: (tile.x + 1) / scale - source.x,
    minY: tile.y / scale - source.y,
    maxY: (tile.y + 1) / scale - source.y,
  }
  const longest = (rect.maxX - rect.minX) / 12
  const frame = tileFrame(tile)
  const n = 2 ** source.z
  const positions: number[] = []
  const normals: number[] = []
  const indices: number[] = []
  const scratch = new Float32Array(3)
  let total = 0
  for (const shape of ground.water) {
    const clipped = clipShape(shape, rect)
    if (!clipped) continue
    const flat: number[] = []
    const holes: number[] = []
    for (const [r, ring] of [clipped.outer, ...clipped.holes].entries()) {
      if (r > 0) holes.push(flat.length / 2)
      for (const v of ring) flat.push(v)
    }
    const triangles = earcut(flat, holes, 2)
    // Split long triangles (longest edge first) so the surface can bend.
    const out: number[] = []
    const emit = (a: [number, number], b: [number, number], c: [number, number], depth: number) => {
      const ab = Math.hypot(a[0] - b[0], a[1] - b[1])
      const bc = Math.hypot(b[0] - c[0], b[1] - c[1])
      const ca = Math.hypot(c[0] - a[0], c[1] - a[1])
      const most = Math.max(ab, bc, ca)
      if (most > longest && depth < 12) {
        const mid = (p: [number, number], q: [number, number]): [number, number] => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]
        if (most === ab) {
          const m = mid(a, b)
          emit(a, m, c, depth + 1)
          emit(m, b, c, depth + 1)
        } else if (most === bc) {
          const m = mid(b, c)
          emit(a, b, m, depth + 1)
          emit(a, m, c, depth + 1)
        } else {
          const m = mid(c, a)
          emit(a, b, m, depth + 1)
          emit(m, b, c, depth + 1)
        }
        return
      }
      out.push(a[0], a[1], b[0], b[1], c[0], c[1])
    }
    for (let t = 0; t < triangles.length; t += 3) {
      const p = (k: number): [number, number] => [flat[triangles[t + k]! * 2]!, flat[triangles[t + k]! * 2 + 1]!]
      emit(p(0), p(1), p(2), 0)
    }
    const cache = new Map<string, number>()
    for (let i = 0; i < out.length; i += 6) {
      const tri: number[] = []
      for (let k = 0; k < 3; k++) {
        const u = out[i + k * 2]!
        const v = out[i + k * 2 + 1]!
        const key = `${u},${v}`
        let index = cache.get(key)
        if (index === undefined) {
          const lon = ((source.x + u) / n) * 360 - 180
          const lat = tileLat(source.y + v, source.z)
          const level = ground.surface(lon, lat)
          total += level
          place(frame, ecefFromLonLat(lon, lat, level), scratch, 0)
          positions.push(scratch[0]!, scratch[1]!, scratch[2]!)
          const up = upIn(frame, lon, lat)
          normals.push(up[0], up[1], up[2])
          index = positions.length / 3 - 1
          cache.set(key, index)
        }
        tri.push(index)
      }
      // Facing up: anticlockwise seen from above (y runs south in tile units, so clockwise there).
      const [a, b, c] = tri as [number, number, number]
      const ax = positions[a * 3]!
      const az = positions[a * 3 + 2]!
      const cross = (positions[b * 3]! - ax) * (positions[c * 3 + 2]! - az) - (positions[b * 3 + 2]! - az) * (positions[c * 3]! - ax)
      if (cross < 0) indices.push(a, b, c)
      else indices.push(a, c, b)
    }
  }
  if (indices.length === 0) return null
  return {
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    indices: Uint32Array.from(indices),
    level: total / (positions.length / 3),
  }
}

/** The way up at a point, in a frame's three.js axes. */
function upIn(frame: Frame, lon: number, lat: number): Vec3 {
  const up = enuFrame(lon, lat, 0).up
  const e = frame.east[0] * up[0] + frame.east[1] * up[1] + frame.east[2] * up[2]
  const n = frame.north[0] * up[0] + frame.north[1] * up[1] + frame.north[2] * up[2]
  const u = frame.up[0] * up[0] + frame.up[1] * up[1] + frame.up[2] * up[2]
  return [e, u, -n]
}

// Buildings

export interface BuildingColours {
  wall: [number, number, number]
  roof: [number, number, number]
  /** Bridge decks. */
  road?: [number, number, number]
}

export interface BuildingOptions {
  /** Leaves out buildings whose middle (longitude, latitude) this says no to. */
  keep?: (lon: number, lat: number) => boolean
  /** Roads and railways, for their bridges. */
  roads?: readonly RoadFeature[]
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
    for (const [r, ring] of rings.entries()) {
      const points: number[] = []
      const count = ring.length / 2
      // The ground under the outline: at up to a dozen of its corners (enough to find its lowest).
      const every = r === 0 ? Math.max(1, Math.floor(count / 12)) : Infinity
      for (let i = 0; i < count; i++) {
        const lon = lonOf(ring[i * 2]!)
        const lat = latOf(ring[i * 2 + 1]!)
        if (i % every === 0) base = Math.min(base, heightAt(lon, lat))
        points.push(lon, lat)
      }
      ground.push(points)
    }
    if (!Number.isFinite(base)) continue
    const bottom = building.minHeight > 0 ? base + building.minHeight : base - FOOTING
    const top = base + building.height
    // Edges along the tile's edge are where a building was cut: no outline there.
    const on = (a: number, b: number, edge: number) => Math.abs(a - edge) < 1e-9 && Math.abs(b - edge) < 1e-9
    const seams = rings.map((ring) => {
      const n = ring.length / 2
      return Array.from({ length: n }, (_, i) => {
        const j = (i + 1) % n
        const [ax, ay, bx, by] = [ring[i * 2]!, ring[i * 2 + 1]!, ring[j * 2]!, ring[j * 2 + 1]!]
        return on(ax, bx, rect.minX) || on(ax, bx, rect.maxX) || on(ay, by, rect.minY) || on(ay, by, rect.maxY)
      })
    })
    writer.prism(frame, ground, bottom, top, building.minHeight > 0, colours, seams)
  }
  for (const road of options.roads ?? []) {
    if (!road.bridge || road.tunnel) continue
    bridge(writer, frame, road, rect, lonOf, latOf, heightAt, colours)
  }
  return writer.finish()
}

/** Bridge decks: this thick (metres), and this much wider than the road. */
const DECK = 1.1
const DECK_MARGIN = 0.8

/**
 * A bridge's deck, as a slab along the road: level with the ground where
 * it lands at either end, straight between, and always clear of the
 * ground (or water) it crosses. An end cut off by the tile's edge takes the
 * other end's height.
 */
function bridge(
  writer: MeshWriter,
  frame: Frame,
  road: RoadFeature,
  rect: Rect,
  lonOf: (u: number) => number,
  latOf: (v: number) => number,
  heightAt: HeightAt,
  colours: BuildingColours,
): void {
  const line = road.line
  const count = line.length / 2
  const inside = (u: number, v: number) => u > -0.005 && u < 1.005 && v > -0.005 && v < 1.005
  const endHeight = (k: number) => heightAt(lonOf(line[k * 2]!), latOf(line[k * 2 + 1]!))
  const firstIn = inside(line[0]!, line[1]!)
  const lastIn = inside(line[(count - 1) * 2]!, line[(count - 1) * 2 + 1]!)
  let start = firstIn ? endHeight(0) : null
  let end = lastIn ? endHeight(count - 1) : null
  start ??= end ?? endHeight(0)
  end ??= start
  // Length along the whole line, for the slope between the ends.
  const along = [0]
  for (let k = 1; k < count; k++) along.push(along[k - 1]! + Math.hypot(line[k * 2]! - line[k * 2 - 2]!, line[k * 2 + 1]! - line[k * 2 - 1]!))
  const total = along[count - 1]! || 1
  const levelAt = (u: number, v: number) => {
    // Where along the line the point lies (nearest segment).
    let best = Infinity
    let at = 0
    for (let k = 0; k + 1 < count; k++) {
      const ax = line[k * 2]!
      const ay = line[k * 2 + 1]!
      const dx = line[k * 2 + 2]! - ax
      const dy = line[k * 2 + 3]! - ay
      const l = dx * dx + dy * dy
      const t = l === 0 ? 0 : Math.max(0, Math.min(1, ((u - ax) * dx + (v - ay) * dy) / l))
      const d = Math.hypot(u - ax - dx * t, v - ay - dy * t)
      if (d < best) {
        best = d
        at = along[k]! + Math.sqrt(l) * t
      }
    }
    return start! + (end! - start!) * (at / total)
  }
  const width = (road.kind === 'rail' ? 6 : road.width) + DECK_MARGIN
  // Footways and tracks often run on a road's bridge, mapped as their own: a little lower, so the road's deck shows.
  const lower = road.kind === 'path' || road.kind === 'track' || road.kind === 'rail' ? 0.12 : 0
  for (const piece of clipLine(line, rect)) {
    // Points every few metres, as longitude and latitude, with the deck's height.
    const points: { lon: number; lat: number; top: number }[] = []
    for (let i = 0; i + 3 < piece.length; i += 2) {
      const steps = 8
      for (let s = 0; s < steps || (i + 4 >= piece.length && s === steps); s++) {
        const t = s / steps
        const u = piece[i]! + (piece[i + 2]! - piece[i]!) * t
        const v = piece[i + 1]! + (piece[i + 3]! - piece[i + 1]!) * t
        const lon = lonOf(u)
        const lat = latOf(v)
        points.push({ lon, lat, top: Math.max(levelAt(u, v), heightAt(lon, lat) + 0.4) + 0.25 - lower })
      }
    }
    writer.deck(frame, points, width, DECK, colours)
  }
}

/** A ring turned so it runs anticlockwise on the map (outer) or clockwise (hole). */
function orient(ring: Line, outer: boolean): Line {
  // Shoelace in tile units, with y running south: negative is anticlockwise on the map.
  let sum = 0
  const n = ring.length / 2
  for (let i = 0, j = n - 1; i < n; j = i++) sum += ring[j * 2]! * ring[i * 2 + 1]! - ring[i * 2]! * ring[j * 2 + 1]!
  if (sum < 0 === outer) return ring
  const reversed = new Float64Array(ring.length)
  for (let i = 0; i < n; i++) {
    reversed[i * 2] = ring[(n - 1 - i) * 2]!
    reversed[i * 2 + 1] = ring[(n - 1 - i) * 2 + 1]!
  }
  return reversed
}

class MeshWriter {
  private edges: number[] = []
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
  prism(frame: Frame, rings: number[][], bottom: number, top: number, underside: boolean, colours: BuildingColours, seams?: boolean[][]): void {
    const at = (lon: number, lat: number, h: number): Vec3 => {
      place(frame, ecefFromLonLat(lon, lat, h), this.scratch, 0)
      return [this.scratch[0]!, this.scratch[1]!, this.scratch[2]!]
    }
    for (const [r, ring] of rings.entries()) {
      const n = ring.length / 2
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n
        const seam = seams?.[r]?.[i] ?? false
        const a = at(ring[i * 2]!, ring[i * 2 + 1]!, bottom)
        const b = at(ring[j * 2]!, ring[j * 2 + 1]!, bottom)
        // Outwards: to the right of the edge seen from above (x east, z south).
        const dx = b[0] - a[0]
        const dz = b[2] - a[2]
        const l = Math.hypot(dx, dz)
        if (l < 0.05) continue
        const normal: Vec3 = [-dz / l, 0, dx / l]
        // Outline: along the top, and up the corners that turn.
        const topA = at(ring[i * 2]!, ring[i * 2 + 1]!, top)
        const topB = at(ring[j * 2]!, ring[j * 2 + 1]!, top)
        if (!seam) this.edges.push(...topA, ...topB)
        if (underside && !seam) this.edges.push(...a, ...b)
        const h = (i + n - 1) % n
        const before = at(ring[h * 2]!, ring[h * 2 + 1]!, bottom)
        const ex = a[0] - before[0]
        const ez = a[2] - before[2]
        const turn = Math.abs(Math.atan2(ex * dz - ez * dx, ex * dx + ez * dz))
        const seamBefore = seams?.[r]?.[h] ?? false
        if (turn > (25 * Math.PI) / 180 && !(seam && seamBefore)) this.edges.push(...a, ...topA)
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

  /** A slab along points (deck heights given), `width` wide and `thickness` deep: top, sides and underside. */
  deck(frame: Frame, points: { lon: number; lat: number; top: number }[], width: number, thickness: number, colours: BuildingColours): void {
    if (points.length < 2) return
    const at = (lon: number, lat: number, h: number): Vec3 => {
      place(frame, ecefFromLonLat(lon, lat, h), this.scratch, 0)
      return [this.scratch[0]!, this.scratch[1]!, this.scratch[2]!]
    }
    // Centre line in the frame, and the sideways direction at each point.
    const centre = points.map((p) => at(p.lon, p.lat, p.top))
    const side = centre.map((_, i) => {
      const a = centre[Math.max(0, i - 1)]!
      const b = centre[Math.min(centre.length - 1, i + 1)]!
      const dx = b[0] - a[0]
      const dz = b[2] - a[2]
      const l = Math.hypot(dx, dz) || 1
      // To the right of the way the line runs, seen from above (x east, z south).
      return [-dz / l, dx / l] as const
    })
    const road = colours.road ?? colours.roof
    const quad = (p: Vec3[], normal: Vec3, colour: readonly number[]) => {
      const first = this.positions.length / 3
      for (const q of p) {
        this.positions.push(q[0], q[1], q[2])
        this.normals.push(normal[0], normal[1], normal[2])
        this.colors.push(colour[0]!, colour[1]!, colour[2]!)
      }
      // Facing the way the normal points.
      const [a, b, c] = p as [Vec3, Vec3, Vec3]
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
      const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
      const f = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!]
      const ok = f[0]! * normal[0] + f[1]! * normal[1] + f[2]! * normal[2] >= 0
      this.indices.push(...(ok ? [first, first + 1, first + 2, first, first + 2, first + 3] : [first, first + 2, first + 1, first, first + 3, first + 2]))
    }
    const half = width / 2
    for (let i = 0; i + 1 < centre.length; i++) {
      const [a, b] = [centre[i]!, centre[i + 1]!]
      const [sa, sb] = [side[i]!, side[i + 1]!]
      const corner = (c: Vec3, s: readonly [number, number], w: number, dy: number): Vec3 => [c[0] + s[0] * w, c[1] + dy, c[2] + s[1] * w]
      const la = corner(a, sa, -half, 0)
      const ra = corner(a, sa, half, 0)
      const lb = corner(b, sb, -half, 0)
      const rb = corner(b, sb, half, 0)
      const la2 = corner(a, sa, -half, -thickness)
      const ra2 = corner(a, sa, half, -thickness)
      const lb2 = corner(b, sb, -half, -thickness)
      const rb2 = corner(b, sb, half, -thickness)
      quad([la, ra, rb, lb], [0, 1, 0], road)
      quad([ra, ra2, rb2, rb], [sa[0], 0, sa[1]], colours.wall)
      quad([la2, la, lb, lb2], [-sa[0], 0, -sa[1]], colours.wall)
      quad([la2, lb2, rb2, ra2], [0, -1, 0], colours.wall)
    }
  }

  finish(): MeshBuffers | null {
    if (this.indices.length === 0) return null
    return {
      positions: Float32Array.from(this.positions),
      normals: Float32Array.from(this.normals),
      colors: Float32Array.from(this.colors),
      indices: Uint32Array.from(this.indices),
      edges: Float32Array.from(this.edges),
    }
  }
}
