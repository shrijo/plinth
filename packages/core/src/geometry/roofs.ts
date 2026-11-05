import earcut from 'earcut'
import { add, cross, dist, dot, fromAngle, intersectLines, normalize, perpLeft, scale, sub, type Vec2 } from '../math.ts'
import type { Roof } from '../model.ts'
import { toWorld, type MeshData } from './mesh.ts'
import { difference, flatten, fromRing, normalizePolygon, union, type MultiPolygon, type PolygonRings, type Ring } from './regions.ts'
import { straightSkeleton } from './skeleton.ts'

/**
 * Roofs as meshes, from a building's top outline (the outer faces of its
 * walls) and the height of its flat top.
 *
 * - Flat: nothing on top, a parapet if asked for, a cornice for an overhang.
 * - Shed: one plane falling the roof's way, lowest at the far side of the outline.
 * - Gable: two planes meeting over the middle of the outline; the walls
 *   carried up under them to the ridge at the ends.
 * - Hip: every side slopes at the same pitch, from the straight skeleton of
 *   the outline, so any shape works (an L gets a valley, a courtyard block
 *   a ring of slopes). A gable on a courtyard block is one too.
 *
 * Pitched roofs reach out past the walls by the overhang and drop below the
 * flat top there, as eaves do. Each is a slab of the roof's thickness, with
 * an underside and an edge all round.
 */

export interface RoofGeometry {
  /** The roof itself: its top, underside and edges. */
  roof: MeshData
  /** Walls carried up to it (gable ends, the high side under a shed roof) or round it (a parapet). */
  walls: MeshData
  /** How far above the flat top the roof reaches, in metres. */
  height: number
}

type V3 = [number, number, number]

/** A pitched surface: a plan region, the height at each point, and which way it faces. */
interface Surface {
  polygon: PolygonRings
  z: (p: Vec2) => number
  /** World-space normal of the top. */
  normal: V3
  /** Whether each ring edge (ring by ring, edge i from point i) lies on the roof's outer edge and gets a fascia. */
  outer: (a: Vec2, b: Vec2) => boolean
}

export function roofGeometry(region: MultiPolygon, base: number, roof: Roof, wallThickness: number): RoofGeometry {
  const polygons = region.map(normalizePolygon).filter((p) => p[0] && p[0].length >= 3)
  const roofMesh = new Builder()
  const walls = new Builder()
  if (polygons.length === 0) return { roof: roofMesh.build(), walls: walls.build(), height: 0 }

  if (roof.kind === 'flat' || roof.pitch <= 0) {
    if (roof.parapet > 0) {
      const ring = difference(polygons, offsetRegion(polygons, -wallThickness))
      walls.extrude(ring, base, base + roof.parapet)
    }
    if (roof.overhang > 0) {
      const cornice = difference(offsetRegion(polygons, roof.overhang), polygons)
      roofMesh.extrude(cornice, base - roof.thickness, base)
    }
    return { roof: roofMesh.build(), walls: walls.build(), height: roof.kind === 'flat' ? roof.parapet : 0 }
  }

  const slope = Math.tan((Math.min(roof.pitch, 85) * Math.PI) / 180)
  const drop = roof.thickness * Math.sqrt(1 + slope * slope)
  const direction = fromAngle(((roof.direction ?? longestSideAngle(polygons)) * Math.PI) / 180)
  const eaves = offsetRegion(polygons, roof.overhang)
  const surfaces: Surface[] = []
  let height = 0

  const hasHoles = polygons.some((p) => p.length > 1)
  if (roof.kind === 'hip' || (roof.kind === 'gable' && hasHoles)) {
    for (const polygon of eaves) {
      const faces = straightSkeleton(polygon)
      if (!faces) continue
      for (const face of faces) {
        const inward = perpLeft(normalize(sub(face.b, face.a)))
        const lift = (p: Vec2) => base + slope * (dot(sub(p, face.a), inward) - roof.overhang)
        for (const p of face.points) height = Math.max(height, slope * (p.t - roof.overhang))
        const eave = face.a
        const eaveEnd = face.b
        surfaces.push({
          polygon: [face.points.map((p): [number, number] => [p.x, p.y])],
          z: lift,
          normal: slopeNormal(scale(inward, slope)),
          outer: (a, b) => (same(a, eave) && same(b, eaveEnd)) || (same(a, eaveEnd) && same(b, eave)),
        })
      }
    }
  } else if (roof.kind === 'gable') {
    // The ridge runs along `direction`, over the middle of the outline across it.
    const across = perpLeft(direction)
    const [low, high] = extent(polygons, across)
    const middle = (low + high) / 2
    const half = (high - low) / 2
    height = slope * half
    const offRidge = (p: Vec2) => dot(p, across) - middle
    for (const side of [1, -1]) {
      const halfRegion = difference(eaves, halfPlane(across, middle, -side))
      const z = (p: Vec2) => base + slope * (half - side * offRidge(p))
      for (const polygon of halfRegion) {
        surfaces.push({
          polygon,
          z,
          normal: slopeNormal(scale(across, -side * slope)),
          outer: (a, b) => Math.abs(offRidge(a)) > 1e-6 || Math.abs(offRidge(b)) > 1e-6,
        })
      }
    }
    for (const polygon of polygons) {
      walls.infill(polygon, (p) => base + slope * (half - Math.abs(offRidge(p))) - drop, base, wallThickness, (a, b) => {
        // Where the edge crosses the ridge, the roof above it bends.
        const sa = offRidge(a)
        const sb = offRidge(b)
        return sa * sb < 0 ? [sa / (sa - sb)] : []
      })
    }
  } else {
    // Shed: falls along `direction`, lowest at the far side of the outline.
    const [low, high] = extent(polygons, direction)
    height = slope * (high - low)
    const z = (p: Vec2) => base + slope * (high - dot(p, direction))
    for (const polygon of eaves) surfaces.push({ polygon, z, normal: slopeNormal(scale(direction, -slope)), outer: () => true })
    for (const polygon of polygons) walls.infill(polygon, (p) => z(p) - drop, base, wallThickness, () => [])
  }

  for (const surface of surfaces) roofMesh.surface(surface, drop)
  return { roof: roofMesh.build(), walls: walls.build(), height }
}

/** How far above the flat top a roof reaches, in metres (cheaper than building it, but a hip roof still needs its skeleton). */
export function roofHeight(region: MultiPolygon, roof: Roof): number {
  if (roof.kind === 'flat') return roof.parapet
  if (roof.pitch <= 0) return 0
  const polygons = region.map(normalizePolygon).filter((p) => p[0] && p[0].length >= 3)
  if (polygons.length === 0) return 0
  const slope = Math.tan((Math.min(roof.pitch, 85) * Math.PI) / 180)
  const direction = fromAngle(((roof.direction ?? longestSideAngle(polygons)) * Math.PI) / 180)
  if (roof.kind === 'shed') {
    const [low, high] = extent(polygons, direction)
    return slope * (high - low)
  }
  if (roof.kind === 'gable' && polygons.every((p) => p.length === 1)) {
    const [low, high] = extent(polygons, perpLeft(direction))
    return (slope * (high - low)) / 2
  }
  let highest = 0
  for (const polygon of polygons) {
    for (const face of straightSkeleton(polygon) ?? []) for (const p of face.points) highest = Math.max(highest, p.t)
  }
  return slope * highest
}

/** The direction of the outline's longest side, in degrees. */
export function longestSideAngle(polygons: MultiPolygon): number {
  let best = 0
  let angle = 0
  for (const polygon of polygons) {
    const ring = fromRing(polygon[0]!)
    ring.forEach((a, i) => {
      const b = ring[(i + 1) % ring.length]!
      const length = dist(a, b)
      if (length > best + 1e-9) {
        best = length
        angle = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI
      }
    })
  }
  return angle
}

/**
 * The region grown (or, for a negative distance, shrunk) by `distance`, its
 * corners mitred: each edge moves out parallel to itself.
 */
export function offsetRegion(region: MultiPolygon, distance: number): MultiPolygon {
  if (Math.abs(distance) < 1e-9) return region
  const moved = region.map(normalizePolygon).map((polygon) =>
    polygon.map((ring): Ring => {
      const points = fromRing(ring)
      const n = points.length
      return points.map((here, i) => {
        const prev = points[(i - 1 + n) % n]!
        const next = points[(i + 1) % n]!
        const d1 = normalize(sub(here, prev))
        const d2 = normalize(sub(next, here))
        // Outward is to the right of each edge (rings run with the inside on their left).
        const o1 = scale(perpLeft(d1), -distance)
        const o2 = scale(perpLeft(d2), -distance)
        const hit = Math.abs(cross(d1, d2)) > 1e-6 ? intersectLines(add(prev, o1), d1, add(here, o2), d2) : null
        const p = hit ? hit.point : add(here, o2)
        return [p.x, p.y]
      })
    }),
  )
  // Shrinking can turn a thin part inside out; the union sorts that out.
  return distance < 0 ? moved.flatMap((polygon) => union(clipInverted(polygon))) : union(moved)
}

/** Rings that turned inside out while shrinking are dropped. */
function clipInverted(polygon: PolygonRings): MultiPolygon {
  const outer = polygon[0]
  if (!outer) return []
  const area = signedArea(fromRing(outer))
  return area > 0 ? [polygon] : []
}

const signedArea = (points: Vec2[]) => points.reduce((sum, p, i) => sum + cross(p, points[(i + 1) % points.length]!), 0) / 2

/** The span of the outline along a direction: lowest and highest dot product. */
function extent(polygons: MultiPolygon, along: Vec2): [number, number] {
  let low = Infinity
  let high = -Infinity
  for (const polygon of polygons) {
    for (const [x, y] of polygon[0]!) {
      const s = x * along.x + y * along.y
      low = Math.min(low, s)
      high = Math.max(high, s)
    }
  }
  return [low, high]
}

/** A huge square covering the side of the line (points p with dot(p, normal) = offset) the normal points to, times `side`. */
function halfPlane(normal: Vec2, offset: number, side: number): MultiPolygon {
  const n = scale(normal, side)
  const along = perpLeft(n)
  const far = 1e6
  const origin = scale(normal, offset)
  const corner = (u: number, v: number) => add(origin, add(scale(along, u), scale(n, v)))
  const points = [corner(-far, 0), corner(far, 0), corner(far, far), corner(-far, far)]
  return [[points.map((p): [number, number] => [p.x, p.y])]]
}

/** World normal of a plane rising along `gradient` (plan), as the roof does. */
function slopeNormal(gradient: Vec2): V3 {
  const n: V3 = [-gradient.x, 1, gradient.y]
  const length = Math.hypot(...n)
  return [n[0] / length, n[1] / length, n[2] / length]
}

const same = (a: Vec2, b: Vec2) => Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6

/** Collects triangles in world coordinates (plan (x, y) at height h is (x, h, -y)), flat-shaded. */
class Builder {
  private positions: number[] = []
  private normals: number[] = []
  private indices: number[] = []

  private add(vertices: V3[], triangles: readonly number[], normal: V3): void {
    const base = this.positions.length / 3
    for (const v of vertices) {
      this.positions.push(...v)
      this.normals.push(...normal)
    }
    for (let i = 0; i < triangles.length; i += 3) {
      const a = vertices[triangles[i]!]!
      const b = vertices[triangles[i + 1]!]!
      const c = vertices[triangles[i + 2]!]!
      const n = [
        (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]),
        (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]),
        (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]),
      ] as const
      const facing = n[0] * normal[0] + n[1] * normal[1] + n[2] * normal[2]
      if (Math.abs(facing) < 1e-12) continue
      if (facing > 0) this.indices.push(base + triangles[i]!, base + triangles[i + 1]!, base + triangles[i + 2]!)
      else this.indices.push(base + triangles[i]!, base + triangles[i + 2]!, base + triangles[i + 1]!)
    }
  }

  /** A pitched surface: its top, its underside `drop` lower, and an edge strip where it's on the roof's rim. */
  surface(surface: Surface, drop: number): void {
    const polygon = normalizePolygon(surface.polygon)
    const { coords, holes } = flatten(polygon)
    if (coords.length < 6) return
    const triangles = earcut(coords, holes)
    const points: Vec2[] = []
    for (let i = 0; i < coords.length; i += 2) points.push({ x: coords[i]!, y: coords[i + 1]! })
    this.add(
      points.map((p) => toWorld(p, surface.z(p))),
      triangles,
      surface.normal,
    )
    const [nx, ny, nz] = surface.normal
    this.add(
      points.map((p) => toWorld(p, surface.z(p) - drop)),
      triangles,
      [-nx, -ny, -nz],
    )
    for (const ring of polygon) {
      const ringPoints = fromRing(ring)
      ringPoints.forEach((a, i) => {
        const b = ringPoints[(i + 1) % ringPoints.length]!
        if (dist(a, b) < 1e-9 || !surface.outer(a, b)) return
        const d = normalize(sub(b, a))
        // Rings run with the inside on their left: the rim faces right.
        const out: V3 = [d.y, 0, d.x]
        this.add(
          [toWorld(a, surface.z(a) - drop), toWorld(b, surface.z(b) - drop), toWorld(b, surface.z(b)), toWorld(a, surface.z(a))],
          [0, 1, 2, 0, 2, 3],
          out,
        )
      })
    }
  }

  /** A plan region extruded between two heights (top, bottom and sides). */
  extrude(region: MultiPolygon, bottom: number, top: number): void {
    for (const raw of region) {
      const polygon = normalizePolygon(raw)
      const { coords, holes } = flatten(polygon)
      if (coords.length < 6) continue
      const triangles = earcut(coords, holes)
      const points: Vec2[] = []
      for (let i = 0; i < coords.length; i += 2) points.push({ x: coords[i]!, y: coords[i + 1]! })
      this.add(
        points.map((p) => toWorld(p, top)),
        triangles,
        [0, 1, 0],
      )
      this.add(
        points.map((p) => toWorld(p, bottom)),
        triangles,
        [0, -1, 0],
      )
      for (const ring of polygon) {
        const ringPoints = fromRing(ring)
        ringPoints.forEach((a, i) => {
          const b = ringPoints[(i + 1) % ringPoints.length]!
          if (dist(a, b) < 1e-9) return
          const d = normalize(sub(b, a))
          this.add([toWorld(a, bottom), toWorld(b, bottom), toWorld(b, top), toWorld(a, top)], [0, 1, 2, 0, 2, 3], [d.y, 0, d.x])
        })
      }
    }
  }

  /**
   * Walls carried up from `base` to the height `top` gives along each edge
   * of the outline (where that's above `base`), as thick as the walls below.
   * `bends` gives where along an edge (0 to 1) the height stops being straight.
   */
  infill(
    polygon: PolygonRings,
    top: (p: Vec2) => number,
    base: number,
    thickness: number,
    bends: (a: Vec2, b: Vec2) => number[],
  ): void {
    for (const ring of normalizePolygon(polygon)) {
      const points = fromRing(ring)
      points.forEach((a, i) => {
        const b = points[(i + 1) % points.length]!
        const length = dist(a, b)
        if (length < 1e-9) return
        const d = scale(sub(b, a), 1 / length)
        const at = (u: number) => add(a, scale(d, u))
        // Where the height bends or crosses the base, in order along the edge.
        const stops = [0, ...bends(a, b).map((f) => f * length), length].sort((x, y) => x - y)
        const profile: { u: number; z: number }[] = []
        stops.forEach((u, k) => {
          const z = top(at(u)) - base
          if (k > 0) {
            const prev = stops[k - 1]!
            const zPrev = top(at(prev)) - base
            if (zPrev * z < 0) {
              const cross = prev + ((u - prev) * zPrev) / (zPrev - z)
              profile.push({ u: cross, z: 0 })
            }
          }
          profile.push({ u, z: Math.max(z, 0) })
        })
        if (profile.every((p) => p.z < 1e-4)) return
        // The face in (along, up) coordinates: along the base, then back along the top.
        const flat: number[] = [0, 0, length, 0]
        for (let k = profile.length - 1; k >= 0; k--) flat.push(profile[k]!.u, profile[k]!.z)
        const triangles = earcut(flat)
        const inward = perpLeft(d)
        for (const [shift, face] of [
          [0, [d.y, 0, d.x]],
          [thickness, [-d.y, 0, -d.x]],
        ] as const) {
          const vertices: V3[] = []
          for (let k = 0; k < flat.length; k += 2) vertices.push(toWorld(add(at(flat[k]!), scale(inward, shift)), base + flat[k + 1]!))
          this.add(vertices, triangles, face as V3)
        }
      })
    }
  }

  build(): MeshData {
    return {
      positions: new Float32Array(this.positions),
      normals: new Float32Array(this.normals),
      indices: new Uint32Array(this.indices),
    }
  }
}
