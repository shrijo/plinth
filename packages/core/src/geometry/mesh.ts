import earcut from 'earcut'
import { add, dist, dot, normalize, perpLeft, scale, signedArea2, sub, type Vec2 } from '../math.ts'
import type { Opening } from '../model.ts'
import type { WallFootprint } from './footprint.ts'
import { flatten, normalizePolygon, type MultiPolygon } from './regions.ts'

/**
 * Renderer-neutral triangle mesh in world coordinates: Y is up and a plan
 * point (x, y) maps to world (x, height, -y), the three.js and glTF convention.
 * Faces are flat-shaded (vertices are not shared between faces).
 */
export interface MeshData {
  positions: Float32Array
  normals: Float32Array
  indices: Uint32Array
}

type V3 = [number, number, number]

/** Plan point at a height to world coordinates. */
export function toWorld(p: Vec2, height: number): V3 {
  return [p.x, height, -p.y]
}

/** A plan direction as a world vector. */
const worldDir = (d: Vec2): V3 => [d.x, 0, -d.y]

class MeshBuilder {
  private positions: number[] = []
  private normals: number[] = []
  private indices: number[] = []

  /** Adds a planar convex face; its winding is fixed to face along `normal`. */
  face(vertices: V3[], normal: V3): void {
    if (vertices.length < 3) return
    const ordered = faces(vertices[0]!, vertices[1]!, vertices[2]!, normal) ? vertices : [...vertices].reverse()
    const base = this.positions.length / 3
    for (const v of ordered) {
      this.positions.push(...v)
      this.normals.push(...normal)
    }
    for (let i = 1; i < ordered.length - 1; i++) this.indices.push(base, base + i, base + i + 1)
  }

  /** Adds triangles sharing one normal; each is wound to face along it. */
  triangles(vertices: V3[], triangles: readonly number[], normal: V3): void {
    const base = this.positions.length / 3
    for (const v of vertices) {
      this.positions.push(...v)
      this.normals.push(...normal)
    }
    for (let i = 0; i < triangles.length; i += 3) {
      const i0 = triangles[i]!
      const i1 = triangles[i + 1]!
      const i2 = triangles[i + 2]!
      const p0 = vertices[i0]!
      const p1 = vertices[i1]!
      const p2 = vertices[i2]!
      const n = triangleNormal(p0, p1, p2)
      const size = Math.hypot(...n)
      if (size < 1e-12) continue
      if (dot3(n, normal) > 0) this.indices.push(base + i0, base + i1, base + i2)
      else this.indices.push(base + i0, base + i2, base + i1)
    }
  }

  append(data: MeshData): void {
    const base = this.positions.length / 3
    this.positions.push(...data.positions)
    this.normals.push(...data.normals)
    for (const index of data.indices) this.indices.push(base + index)
  }

  build(): MeshData {
    return {
      positions: new Float32Array(this.positions),
      normals: new Float32Array(this.normals),
      indices: new Uint32Array(this.indices),
    }
  }
}

const dot3 = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

function triangleNormal(p0: V3, p1: V3, p2: V3): V3 {
  const e1 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]] as const
  const e2 = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]] as const
  return [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]
}

function faces(p0: V3, p1: V3, p2: V3, normal: V3): boolean {
  return dot3(triangleNormal(p0, p1, p2), normal) >= 0
}

/** An opening cut through a wall: a stretch along the wall and a height range above its base. */
export interface OpeningCut {
  /** Along the centre line, measured from the wall's start, in metres. */
  start: number
  end: number
  /** Above the wall's base, in metres. */
  sill: number
  head: number
}

/** Room left above an opening and beside it, so walls never become paper-thin. */
const MIN_LINTEL = 0.05
const EDGE_MARGIN = 0.02

/**
 * Where an opening actually goes in a wall: shifted along the wall to stay
 * on its straight stretch, and lowered to leave a lintel under the top.
 * Null if it doesn't fit at all.
 */
export function placeOpening(
  footprint: WallFootprint,
  opening: Pick<Opening, 'offset' | 'width' | 'height' | 'sill'>,
  heightStart: number,
  heightEnd: number,
): OpeningCut | null {
  const clearStart = footprint.clearStart + EDGE_MARGIN
  const clearEnd = footprint.clearEnd - EDGE_MARGIN
  if (opening.width > clearEnd - clearStart) return null
  let start = opening.offset - opening.width / 2
  start = Math.min(Math.max(start, clearStart), clearEnd - opening.width)
  const end = start + opening.width
  const length = dist(footprint.a, footprint.b)
  const heightAt = (s: number) => heightStart + (heightEnd - heightStart) * (length > 0 ? s / length : 0)
  const sill = Math.max(0, opening.sill)
  const head = Math.min(sill + opening.height, Math.min(heightAt(start), heightAt(end)) - MIN_LINTEL)
  if (head - sill < 0.1) return null
  return { start, end, sill, head }
}

/**
 * Extrudes a wall footprint from `base` (world height of its bottom) up by
 * `heightStart` at its a end and `heightEnd` at its b end, interpolating
 * along the wall so a sloped top stays planar. Openings are cut through
 * both faces, with reveals (jambs, sill, head) across the thickness.
 */
export function buildWallMesh(
  footprint: WallFootprint,
  base: number,
  heightStart: number,
  heightEnd: number,
  cuts: readonly OpeningCut[] = [],
): MeshData {
  const { polygon, a, b } = footprint
  const mesh = new MeshBuilder()
  const length = dist(a, b)
  const dir = normalize(sub(b, a))
  const along = (p: Vec2) => dot(sub(p, a), dir)
  const topAt = (p: Vec2): number => {
    const t = length === 0 ? 0 : Math.min(1, Math.max(0, along(p) / length))
    return base + heightStart + (heightEnd - heightStart) * t
  }
  const spans = nonOverlapping(cuts)

  // Top and bottom faces.
  const tris = earcut(polygon.flatMap((p) => [p.x, p.y]))
  mesh.triangles(
    polygon.map((p) => toWorld(p, topAt(p))),
    tris,
    topNormal(dir, heightStart, heightEnd, length),
  )
  mesh.triangles(
    polygon.map((p) => toWorld(p, base)),
    tris,
    [0, -1, 0],
  )

  // Side faces, one per outline edge, facing outward.
  for (let i = 0; i < polygon.length; i++) {
    const p = polygon[i]!
    const q = polygon[(i + 1) % polygon.length]!
    if (dist(p, q) < 1e-9) continue
    const edge = normalize(sub(q, p))
    // Outward normal of a counter-clockwise outline is the edge's right side.
    const normal: V3 = [edge.y, 0, edge.x]
    if (spans.length > 0 && (i === footprint.rightEdge || i === footprint.leftEdge)) {
      sideWithOpenings(mesh, p, q, normal, spans, base, along, topAt)
    } else {
      mesh.face([toWorld(p, base), toWorld(q, base), toWorld(q, topAt(q)), toWorld(p, topAt(p))], normal)
    }
  }

  // Reveals: the faces inside each opening, across the wall's thickness.
  const half = footprint.thickness / 2
  const n = perpLeft(dir)
  const right = (s: number) => sub(add(a, scale(dir, s)), scale(n, half))
  const left = (s: number) => add(add(a, scale(dir, s)), scale(n, half))
  for (const cut of spans) {
    const zs = base + cut.sill
    const zh = base + cut.head
    const jamb = (s: number, facing: V3) =>
      mesh.face([toWorld(right(s), zs), toWorld(left(s), zs), toWorld(left(s), zh), toWorld(right(s), zh)], facing)
    jamb(cut.start, worldDir(dir))
    jamb(cut.end, worldDir(scale(dir, -1)))
    const level = (z: number, facing: V3) =>
      mesh.face(
        [toWorld(right(cut.start), z), toWorld(right(cut.end), z), toWorld(left(cut.end), z), toWorld(left(cut.start), z)],
        facing,
      )
    if (cut.sill > 1e-6) level(zs, [0, 1, 0])
    level(zh, [0, -1, 0])
  }

  return mesh.build()
}

/** Drops cuts that overlap an earlier one, sorted along the wall. */
function nonOverlapping(cuts: readonly OpeningCut[]): OpeningCut[] {
  const sorted = [...cuts].sort((p, q) => p.start - q.start)
  const result: OpeningCut[] = []
  for (const cut of sorted) {
    const last = result.at(-1)
    if (!last || cut.start > last.end + 1e-3) result.push(cut)
  }
  return result
}

/**
 * One face of a wall with openings cut out. Works in the face's own 2D
 * coordinates (u along the face, z up): windows are holes, doors (no sill)
 * are notches in the bottom edge.
 */
function sideWithOpenings(
  mesh: MeshBuilder,
  p: Vec2,
  q: Vec2,
  normal: V3,
  cuts: readonly OpeningCut[],
  base: number,
  along: (p: Vec2) => number,
  topAt: (p: Vec2) => number,
): void {
  const edge = normalize(sub(q, p))
  const length = dist(p, q)
  const sP = along(p)
  const sign = along(q) >= sP ? 1 : -1
  const u = (s: number) => (s - sP) * sign

  const spans = cuts
    .map((c) => {
      const u0 = Math.min(u(c.start), u(c.end))
      const u1 = Math.max(u(c.start), u(c.end))
      return { u0, u1, sill: base + c.sill, head: base + c.head, door: c.sill <= 1e-6 }
    })
    .filter((s) => s.u0 > 1e-6 && s.u1 < length - 1e-6)
    .sort((x, y) => x.u0 - y.u0)

  const outer: [number, number][] = [[0, base]]
  for (const s of spans) {
    if (s.door) outer.push([s.u0, base], [s.u0, s.head], [s.u1, s.head], [s.u1, base])
  }
  outer.push([length, base], [length, topAt(q)], [0, topAt(p)])
  const holes = spans
    .filter((s) => !s.door)
    .map((s): [number, number][] => [
      [s.u0, s.sill],
      [s.u1, s.sill],
      [s.u1, s.head],
      [s.u0, s.head],
    ])

  const points = [...outer, ...holes.flat()]
  const holeStarts: number[] = []
  let index = outer.length
  for (const hole of holes) {
    holeStarts.push(index)
    index += hole.length
  }
  const tris = earcut(
    points.flatMap(([x, y]) => [x, y]),
    holeStarts,
  )
  mesh.triangles(
    points.map(([uu, z]) => toWorld(add(p, scale(edge, uu)), z)),
    tris,
    normal,
  )
}

/** Normal of the (possibly sloped) top face. */
function topNormal(dir: Vec2, heightStart: number, heightEnd: number, length: number): V3 {
  if (length === 0 || heightStart === heightEnd) return [0, 1, 0]
  // The top rises by (heightEnd - heightStart) over the wall's length along `dir`.
  const slope = (heightEnd - heightStart) / length
  const nx = -slope * dir.x
  const nz = slope * dir.y
  const l = Math.hypot(nx, 1, nz)
  return [nx / l, 1 / l, nz / l]
}

/** Extrudes a plan region (polygons with holes) between two heights. */
export function buildSlabMesh(region: MultiPolygon, bottom: number, top: number): MeshData {
  const mesh = new MeshBuilder()
  for (const raw of region) {
    const polygon = normalizePolygon(raw)
    const { coords, holes } = flatten(polygon)
    if (coords.length < 6) continue
    const tris = earcut(coords, holes)
    const points: Vec2[] = []
    for (let i = 0; i < coords.length; i += 2) points.push({ x: coords[i]!, y: coords[i + 1]! })
    if (Math.abs(signedArea2(points)) < 1e-12) continue
    mesh.triangles(
      points.map((p) => toWorld(p, top)),
      tris,
      [0, 1, 0],
    )
    mesh.triangles(
      points.map((p) => toWorld(p, bottom)),
      tris,
      [0, -1, 0],
    )
    // Outer rings run counter-clockwise and holes clockwise, so every edge's
    // right side faces out of the solid.
    for (const ring of polygon) {
      for (let i = 0; i < ring.length; i++) {
        const [x0, y0] = ring[i]!
        const [x1, y1] = ring[(i + 1) % ring.length]!
        const p = { x: x0, y: y0 }
        const q = { x: x1, y: y1 }
        if (dist(p, q) < 1e-9) continue
        const edge = normalize(sub(q, p))
        mesh.face([toWorld(p, bottom), toWorld(q, bottom), toWorld(q, top), toWorld(p, top)], [edge.y, 0, edge.x])
      }
    }
  }
  return mesh.build()
}

/** Merges several meshes into one. */
export function mergeMeshes(meshes: readonly MeshData[]): MeshData {
  const builder = new MeshBuilder()
  for (const mesh of meshes) builder.append(mesh)
  return builder.build()
}
