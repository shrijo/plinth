import { pointInRing, polygonCentroid, signedArea2, type Vec2 } from './math.ts'
import type { AreaStandard, Id, Parcel, Snapshot } from './model.ts'
import { analyzeSite } from './geometry/analysis.ts'
import { intersection, regionArea, toRing, type MultiPolygon } from './geometry/regions.ts'

/**
 * A parcel's figures: its area, the buildings standing on it, how much of
 * it they cover (site coverage: SIA's Überbauungsziffer ÜZ, Germany's
 * Grundflächenzahl GRZ) and how much floor area they have for its size
 * (floor area ratio: Geschossflächenziffer / -zahl GFZ in both).
 */
export interface ParcelFigures {
  area: number
  perimeter: number
  /** Buildings whose footprint's middle is on the parcel. */
  buildings: Id[]
  /** Footprint area on the parcel. */
  covered: number
  coverage: number
  /** Gross floor area of the buildings on it. */
  floorArea: number
  floorAreaRatio: number
  /** The codes the project's standard uses for coverage and floor area ratio. */
  coverageCode: string
  ratioCode: string
}

export function parcelRegion(parcel: Parcel): MultiPolygon {
  const points = signedArea2(parcel.points) >= 0 ? parcel.points : [...parcel.points].reverse()
  return [[toRing(points)]]
}

export function parcelFigures(snapshot: Snapshot, parcel: Parcel, standard: AreaStandard = snapshot.meta.areaStandard): ParcelFigures {
  const analysis = analyzeSite(snapshot)
  const region = parcelRegion(parcel)
  const area = Math.abs(signedArea2(parcel.points)) / 2
  const perimeter = parcel.points.reduce((sum, p, i) => {
    const q = parcel.points[(i + 1) % parcel.points.length]!
    return sum + Math.hypot(q.x - p.x, q.y - p.y)
  }, 0)
  const buildings: Id[] = []
  let covered = 0
  let floorArea = 0
  for (const building of analysis.buildings.values()) {
    const ground = building.levels[0]
    if (!ground || ground.outline.length === 0) continue
    const middle = regionMiddle(ground.outline)
    if (!middle || !pointInRing(middle, parcel.points)) continue
    buildings.push(building.buildingId)
    covered += regionArea(intersection(ground.outline, region))
    floorArea += building.grossArea
  }
  return {
    area,
    perimeter,
    buildings,
    covered,
    coverage: area > 0 ? covered / area : 0,
    floorArea,
    floorAreaRatio: area > 0 ? floorArea / area : 0,
    coverageCode: standard === 'sia416' ? 'ÜZ' : 'GRZ',
    ratioCode: 'GFZ',
  }
}

/** The parcel a plan point is on, if any (the smallest, where they overlap). */
export function parcelAt(snapshot: Snapshot, p: Vec2): Parcel | null {
  let best: Parcel | null = null
  let bestArea = Infinity
  for (const parcel of Object.values(snapshot.parcels)) {
    if (!pointInRing(p, parcel.points)) continue
    const area = Math.abs(signedArea2(parcel.points))
    if (area < bestArea) {
      best = parcel
      bestArea = area
    }
  }
  return best
}

function regionMiddle(region: MultiPolygon): Vec2 | null {
  const outer = region[0]?.[0]
  if (!outer) return null
  return polygonCentroid(outer.map(([x, y]) => ({ x, y })))
}
