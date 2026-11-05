import earcut from 'earcut'
import polygonClipping from 'polygon-clipping'
import { pointInRing, polygonCentroid, signedArea2, type Vec2 } from '../math.ts'

/**
 * Plan regions as polygons with holes, in the [x, y] pair format the
 * polygon-clipping library uses. A ring is closed implicitly or explicitly.
 */
export type Ring = [number, number][]
/** Outer ring followed by hole rings. */
export type PolygonRings = Ring[]
export type MultiPolygon = PolygonRings[]

export const toRing = (points: readonly Vec2[]): Ring => points.map((p) => [p.x, p.y])
export const fromRing = (ring: Ring): Vec2[] => openRing(ring).map(([x, y]) => ({ x, y }))

/** The ring without a repeated closing point. */
export function openRing(ring: Ring): Ring {
  if (ring.length > 1) {
    const first = ring[0]!
    const last = ring.at(-1)!
    if (first[0] === last[0] && first[1] === last[1]) return ring.slice(0, -1)
  }
  return ring
}

/** Coordinates are snapped to this grid (a micrometre) before boolean operations. */
const GRID = 1e6
const snapCoord = (v: number) => Math.round(v * GRID) / GRID

/**
 * Snaps a region to the grid and drops repeated points and degenerate
 * rings. The clipping library fails on float noise such as a point at
 * -8.750000000000002 right after one at -8.75 ("Unable to complete output
 * ring"); this keeps its input clean.
 */
export function tidyRegion(region: MultiPolygon): MultiPolygon {
  const result: MultiPolygon = []
  for (const polygon of region) {
    const rings: Ring[] = []
    for (const [index, ring] of polygon.entries()) {
      const clean: Ring = []
      for (const [x, y] of ring) {
        const p: [number, number] = [snapCoord(x), snapCoord(y)]
        const last = clean.at(-1)
        if (!last || last[0] !== p[0] || last[1] !== p[1]) clean.push(p)
      }
      const open = openRing(clean)
      if (open.length >= 3) rings.push(open)
      else if (index === 0) break // No outer ring, no polygon.
    }
    if (rings.length > 0) result.push(rings)
  }
  return result
}

/**
 * Boolean operations that never throw: the clipping library can fail on
 * degenerate input, and a missing slab is better than a crashed editor.
 * If merging everything at once fails, the parts are merged one by one,
 * and a part that still can't be merged is kept as it is.
 */
export function union(...regions: MultiPolygon[]): MultiPolygon {
  const parts = regions.map(tidyRegion).filter((r) => r.length > 0)
  if (parts.length === 0) return []
  try {
    return polygonClipping.union(parts[0]!, ...parts.slice(1))
  } catch {
    let merged: MultiPolygon = []
    for (const part of parts) {
      try {
        merged = merged.length === 0 ? polygonClipping.union(part) : polygonClipping.union(merged, part)
      } catch {
        merged = [...merged, ...part]
      }
    }
    return merged
  }
}

/** Where two regions overlap. Empty when they don't, or when the clipping library can't tell. */
export function intersection(a: MultiPolygon, b: MultiPolygon): MultiPolygon {
  const left = tidyRegion(a)
  const right = tidyRegion(b)
  if (left.length === 0 || right.length === 0) return []
  try {
    return polygonClipping.intersection(left, right)
  } catch {
    return []
  }
}

export function difference(subject: MultiPolygon, ...clips: MultiPolygon[]): MultiPolygon {
  const tidySubject = tidyRegion(subject)
  if (tidySubject.length === 0) return []
  const parts = clips.map(tidyRegion).filter((r) => r.length > 0)
  if (parts.length === 0) return tidySubject
  try {
    return polygonClipping.difference(tidySubject, ...parts)
  } catch {
    // One clip at a time, skipping any the library can't handle.
    let rest = tidySubject
    for (const part of parts) {
      try {
        rest = polygonClipping.difference(rest, part)
      } catch {
        // Keep what's left.
      }
    }
    return rest
  }
}

export function ringArea(ring: Ring): number {
  return Math.abs(signedArea2(fromRing(ring))) / 2
}

export function regionArea(region: MultiPolygon): number {
  let area = 0
  for (const [outer, ...holes] of region) {
    if (!outer) continue
    area += ringArea(outer) - holes.reduce((sum, hole) => sum + ringArea(hole), 0)
  }
  return area
}

export function regionPerimeter(region: MultiPolygon): number {
  let length = 0
  for (const polygon of region) {
    for (const ring of polygon) {
      const points = openRing(ring)
      for (let i = 0; i < points.length; i++) {
        const [x0, y0] = points[i]!
        const [x1, y1] = points[(i + 1) % points.length]!
        length += Math.hypot(x1 - x0, y1 - y0)
      }
    }
  }
  return length
}

export function pointInRegion(p: Vec2, region: MultiPolygon): boolean {
  return region.some(
    ([outer, ...holes]) =>
      !!outer && pointInRing(p, fromRing(outer)) && !holes.some((h) => pointInRing(p, fromRing(h))),
  )
}

/** A point well inside the region's largest part, for a label. */
export function labelPoint(region: MultiPolygon): Vec2 | null {
  let best: PolygonRings | undefined
  let bestArea = 0
  for (const polygon of region) {
    const area = regionArea([polygon])
    if (area > bestArea) {
      best = polygon
      bestArea = area
    }
  }
  if (!best?.[0]) return null
  const centroid = polygonCentroid(fromRing(best[0]))
  if (pointInRegion(centroid, [best])) return centroid
  // Concave shape: use the middle of its largest triangle instead.
  const { coords, holes } = flatten(best)
  const tris = earcut(coords, holes)
  let largest: Vec2 | null = null
  let largestArea = 0
  for (let i = 0; i < tris.length; i += 3) {
    const pts = [tris[i]!, tris[i + 1]!, tris[i + 2]!].map((k) => ({ x: coords[k * 2]!, y: coords[k * 2 + 1]! }))
    const area = Math.abs(signedArea2(pts))
    if (area > largestArea) {
      largestArea = area
      largest = { x: (pts[0]!.x + pts[1]!.x + pts[2]!.x) / 3, y: (pts[0]!.y + pts[1]!.y + pts[2]!.y) / 3 }
    }
  }
  return largest
}

/** Flat coordinates and hole start indices for earcut. */
export function flatten(polygon: PolygonRings): { coords: number[]; holes: number[] } {
  const coords: number[] = []
  const holes: number[] = []
  polygon.forEach((ring, i) => {
    if (i > 0) holes.push(coords.length / 2)
    for (const [x, y] of openRing(ring)) coords.push(x, y)
  })
  return { coords, holes }
}

/** Outer ring counter-clockwise, holes clockwise, no closing points. */
export function normalizePolygon(polygon: PolygonRings): PolygonRings {
  return polygon.map((ring, i) => {
    const open = openRing(ring)
    const ccw = signedArea2(fromRing(open)) > 0
    const wantCcw = i === 0
    return ccw === wantCcw ? open : [...open].reverse()
  })
}
