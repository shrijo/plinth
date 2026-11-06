import {
  createId,
  FLAT_ROOF,
  insertPolyline,
  insertStreet,
  intersection,
  levelName,
  longestSideAngle,
  polygonCentroid,
  restackLevels,
  signedArea2,
  addSpotHeights,
  groundUnder,
  terrainThrough,
  type MultiPolygon,
  type Roof,
  type RoofKind,
  type StreetProps,
  type Tx,
  type Vec2,
} from '@plinth/core'
import type { BuildingFeature, RoadKind, TileFeatures } from './features.ts'
import { clipLine, type Rect } from './clip.ts'
import { enuFrame, frameToLonLat, lonLatToFrame, type Frame } from './geo.ts'
import type { OsmBuilding, OsmData } from './osm.ts'
import { tileLat, tileLon, tilesCovering, type LonLatBounds } from './tiles.ts'

/**
 * A site made from a square of the real world: its buildings (each with
 * floors, height and roof as far as the map says), its streets (with
 * lanes and sidewalks by their kind) and the lie of the land as spot
 * heights. Planned from map data first (plain numbers, in site metres
 * east and north of the square's middle), then built into a document.
 */

export interface SitePlan {
  name: string
  lon: number
  lat: number
  /** The height above sea level the site's zero stands for: the ground at the middle. */
  ground: number
  /** The square, in site metres. */
  area: Vec2[]
  buildings: PlannedBuilding[]
  streets: PlannedStreet[]
  /** Heights above sea level, as spot heights keep them (the site is drawn from `ground`). */
  spots: { x: number; y: number; z: number }[]
  /** Where the buildings and streets came from: OpenStreetMap itself, or map tiles. */
  source: 'osm' | 'tiles'
}

export interface PlannedBuilding {
  name: string
  outline: Vec2[]
  floors: number
  floorHeight: number
  roof: Roof | null
}

export interface PlannedStreet {
  points: Vec2[]
  props: Partial<StreetProps>
}

/** The square round a point: its corners in site metres and its extent in longitude and latitude. */
export function squareAround(lon: number, lat: number, size: number, margin = 0): { frame: Frame; area: Vec2[]; bounds: LonLatBounds } {
  const frame = enuFrame(lon, lat, 0)
  const h = size / 2
  const area = [
    { x: -h, y: -h },
    { x: h, y: -h },
    { x: h, y: h },
    { x: -h, y: h },
  ]
  const m = h + margin
  const sw = frameToLonLat(frame, -m, -m)
  const ne = frameToLonLat(frame, m, m)
  const nw = frameToLonLat(frame, -m, m)
  const se = frameToLonLat(frame, m, -m)
  return {
    frame,
    area,
    bounds: {
      west: Math.min(sw.lon, nw.lon),
      east: Math.max(ne.lon, se.lon),
      south: Math.min(sw.lat, se.lat),
      north: Math.max(ne.lat, nw.lat),
    },
  }
}

export interface PlanInput {
  name: string
  lon: number
  lat: number
  size: number
  /** Ground heights above sea level. */
  heightAt: (lon: number, lat: number) => number
}

/** Spot heights on a grid over the square, closer on small sites. */
function spotsFor(input: PlanInput, frame: Frame): SitePlan['spots'] {
  const step = Math.min(Math.max(input.size / 24, 8), 25)
  const n = Math.ceil(input.size / step)
  const spots: SitePlan['spots'] = []
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const x = -input.size / 2 + (i * input.size) / n
      const y = -input.size / 2 + (j * input.size) / n
      const place = frameToLonLat(frame, x, y)
      spots.push({ x: round(x), y: round(y), z: round(input.heightAt(place.lon, place.lat)) })
    }
  }
  return spots
}

const round = (v: number, step = 0.01) => Math.round(v / step) * step

// From OpenStreetMap

export function planFromOsm(input: PlanInput, osm: OsmData): SitePlan {
  const { frame, area } = squareAround(input.lon, input.lat, input.size)
  const toSite = ([lon, lat]: [number, number]): Vec2 => {
    const [e, n] = lonLatToFrame(frame, lon, lat, 0)
    return { x: e, y: n }
  }
  const ground = Math.round(input.heightAt(input.lon, input.lat))
  const half = input.size / 2
  const inside = (p: Vec2) => Math.abs(p.x) <= half && Math.abs(p.y) <= half

  const buildings: PlannedBuilding[] = []
  const named = new Map<string, number>()
  for (const building of osm.buildings) {
    if (!keepBuilding(building.tags)) continue
    const outer = building.outer.map(toSite)
    const holes = building.holes.map((h) => h.map(toSite))
    for (const outline of piecesWithoutHoles(outer, holes)) {
      const clean = tidyOutline(outline)
      if (!clean || !inside(polygonCentroid(clean))) continue
      buildings.push(buildingFromTags(clean, building, named))
    }
  }

  const streets: PlannedStreet[] = []
  const rect: Rect = { minX: -half, minY: -half, maxX: half, maxY: half }
  for (const way of osm.streets) {
    const props = streetFromTags(way.tags)
    if (!props) continue
    const line = Float64Array.from(way.points.flatMap((p) => {
      const s = toSite(p)
      return [s.x, s.y]
    }))
    for (const piece of clipLine(line, rect)) {
      const points = simplify(toPoints(piece), 0.4)
      if (points.length >= 2) streets.push({ points, props })
    }
  }

  return { name: input.name, lon: input.lon, lat: input.lat, ground, area, buildings, streets, spots: spotsFor(input, frame), source: 'osm' }
}

/** Open structures (carports, canopies) and buildings being demolished aren't buildings to model. */
function keepBuilding(tags: Record<string, string>): boolean {
  const kind = tags.building
  if (!kind || kind === 'no' || kind === 'roof' || kind === 'carport' || kind === 'ruins' || kind === 'construction') return false
  if (tags['demolished:building'] || tags['razed:building']) return false
  return true
}

const SMALL = new Set(['garage', 'garages', 'shed', 'hut', 'kiosk', 'cabin', 'service', 'transformer_tower', 'toilets', 'bunker', 'greenhouse'])
const HOUSES = new Set(['house', 'detached', 'semidetached_house', 'terrace', 'bungalow', 'farm', 'residential', 'villa'])

const ROOF_SHAPES: Record<string, RoofKind> = {
  gabled: 'gable',
  'double_saltbox': 'gable',
  saltbox: 'gable',
  gambrel: 'gable',
  hipped: 'hip',
  'half-hipped': 'hip',
  'side_hipped': 'hip',
  pyramidal: 'hip',
  mansard: 'hip',
  skillion: 'shed',
  lean_to: 'shed',
  flat: 'flat',
}
const DEFAULT_PITCH: Record<RoofKind, number> = { flat: 35, gable: 40, hip: 35, shed: 15 }

/** A number from a tag ("12", "12.5 m", "12,5"), or null. */
export function tagNumber(value: string | undefined): number | null {
  if (!value) return null
  const match = /-?\d+(?:[.,]\d+)?/.exec(value)
  if (!match) return null
  let n = Number(match[0].replace(',', '.'))
  // Feet, if marked as such.
  if (/ft|'/.test(value)) n *= 0.3048
  return Number.isFinite(n) ? n : null
}

function buildingFromTags(outline: Vec2[], building: OsmBuilding, named: Map<string, number>): PlannedBuilding {
  const tags = building.tags
  const levels = tagNumber(tags['building:levels'])
  const height = tagNumber(tags.height) ?? tagNumber(tags['building:height'])
  const kind = ROOF_SHAPES[tags['roof:shape'] ?? ''] ?? 'flat'
  const pitched = kind !== 'flat'
  let roofHeight = tagNumber(tags['roof:height'])
  const area = Math.abs(signedArea2(outline)) / 2
  let perimeter = 0
  outline.forEach((a, i) => {
    const b = outline[(i + 1) % outline.length]!
    perimeter += Math.hypot(b.x - a.x, b.y - a.y)
  })
  // Half the building's depth, about: exact for a square, a little more for a long block.
  const halfDepth = Math.max((2 * area) / Math.max(perimeter, 1), 2)

  let pitch = DEFAULT_PITCH[kind]
  const angle = tagNumber(tags['roof:angle'])
  if (angle !== null && angle > 3 && angle < 75) pitch = angle
  else if (pitched && roofHeight !== null && roofHeight > 0) {
    const run = kind === 'shed' ? halfDepth * 2 : halfDepth
    pitch = Math.min(Math.max((Math.atan(roofHeight / run) * 180) / Math.PI, 8), 65)
  }
  if (pitched && roofHeight === null) {
    const run = kind === 'shed' ? halfDepth * 2 : halfDepth
    roofHeight = Math.tan((pitch * Math.PI) / 180) * run
  }

  let floors: number
  let floorHeight = 3
  const walls = height !== null ? Math.max(height - (pitched ? (roofHeight ?? 0) : 0), 2.4) : null
  if (levels !== null && levels >= 1) {
    floors = Math.round(levels)
    if (walls !== null) floorHeight = walls / floors
  } else if (walls !== null) {
    floors = Math.max(1, Math.round(walls / 3.1))
    floorHeight = walls / floors
  } else {
    floors = SMALL.has(tags.building ?? '') ? 1 : HOUSES.has(tags.building ?? '') ? 2 : 3
  }
  floors = Math.min(Math.max(floors, 1), 120)
  floorHeight = Math.round(Math.min(Math.max(floorHeight, 2.5), 6) * 100) / 100

  let roof: Roof | null = null
  if (pitched) {
    let direction: number | null = null
    const facing = tagNumber(tags['roof:direction'])
    if (kind === 'shed' && facing !== null) direction = (((90 - facing) % 360) + 360) % 360
    else if (tags['roof:orientation'] === 'across') {
      direction = (((longestSideAngle([[outline.map((p) => [p.x, p.y] as [number, number])]]) + 90) % 360) + 360) % 360
    }
    roof = { ...FLAT_ROOF, kind, pitch: Math.round(pitch), overhang: 0.3, direction }
  }

  const street = tags['addr:street']
  const number = tags['addr:housenumber']
  let name = tags.name ?? (street ? `${street}${number ? ` ${number}` : ''}` : '')
  if (name) {
    // Parts of one building, or one address over several: numbered.
    const seen = named.get(name) ?? 0
    named.set(name, seen + 1)
    if (seen > 0) name = `${name} (${seen + 1})`
  }
  return { name, outline, floors, floorHeight, roof }
}

/** Kinds of street, their lanes and widths. */
const STREET_KINDS: Record<string, Partial<StreetProps> & { lanes: number }> = {
  motorway: { lanes: 2, laneWidth: 3.5, sidewalkLeft: 0, sidewalkRight: 0 },
  trunk: { lanes: 2, laneWidth: 3.5, sidewalkLeft: 0, sidewalkRight: 0 },
  primary: { lanes: 2, laneWidth: 3.25, sidewalkLeft: 3, sidewalkRight: 3 },
  secondary: { lanes: 2, laneWidth: 3.25, sidewalkLeft: 2.5, sidewalkRight: 2.5 },
  tertiary: { lanes: 2, laneWidth: 3, sidewalkLeft: 2, sidewalkRight: 2 },
  unclassified: { lanes: 2, laneWidth: 2.75, sidewalkLeft: 1.5, sidewalkRight: 1.5 },
  residential: { lanes: 2, laneWidth: 2.75, sidewalkLeft: 1.8, sidewalkRight: 1.8 },
  road: { lanes: 2, laneWidth: 2.75, sidewalkLeft: 1.5, sidewalkRight: 1.5 },
  living_street: { lanes: 1, laneWidth: 4, sidewalkLeft: 0, sidewalkRight: 0 },
  pedestrian: { lanes: 1, laneWidth: 5, sidewalkLeft: 0, sidewalkRight: 0 },
  busway: { lanes: 1, laneWidth: 3.5, sidewalkLeft: 0, sidewalkRight: 0 },
  service: { lanes: 1, laneWidth: 3, sidewalkLeft: 0, sidewalkRight: 0 },
}

/** A street's cross-section from its tags, or null for ways that aren't streets to model. */
export function streetFromTags(tags: Record<string, string>): Partial<StreetProps> | null {
  const highway = (tags.highway ?? '').replace(/_link$/, '')
  const base = STREET_KINDS[highway]
  if (!base) return null
  if (tags.area === 'yes' || tags.tunnel === 'yes' || tags.tunnel === 'building_passage' || tags.covered === 'yes') return null
  if (highway === 'service' && tags.service && tags.service !== 'alley') return null
  const props: Partial<StreetProps> & { lanes: number } = { crosswalkA: false, crosswalkB: false, ...base }
  const oneway = tags.oneway === 'yes' || tags.oneway === '1' || tags.oneway === '-1' || highway === 'motorway'
  const lanes = tagNumber(tags.lanes)
  if (lanes !== null && lanes >= 1) props.lanes = Math.min(Math.round(lanes), 8)
  else if (oneway && highway !== 'motorway' && highway !== 'trunk') props.lanes = 1
  if ((tags.highway ?? '').endsWith('_link')) props.lanes = Math.min(props.lanes, 1)
  const width = props.laneWidth ?? 3
  if (props.lanes === 1 && width < 3.25 && highway !== 'service') props.laneWidth = 3.5
  // Sidewalks as tagged, where they are; mapped separately, the street has none of its own.
  const sidewalk = tags.sidewalk ?? tags['sidewalk:both']
  const side = base.sidewalkLeft || 1.8
  if (sidewalk === 'both' || sidewalk === 'yes') props.sidewalkLeft = props.sidewalkRight = side
  else if (sidewalk === 'left') {
    props.sidewalkLeft = side
    props.sidewalkRight = 0
  } else if (sidewalk === 'right') {
    props.sidewalkLeft = 0
    props.sidewalkRight = side
  } else if (sidewalk === 'no' || sidewalk === 'none' || sidewalk === 'separate') props.sidewalkLeft = props.sidewalkRight = 0
  const cycle = (key: string) => /lane|track|exclusive/.test(tags[key] ?? '')
  if (cycle('cycleway') || cycle('cycleway:both')) props.bikeLeft = props.bikeRight = 1.6
  if (cycle('cycleway:left')) props.bikeLeft = 1.6
  if (cycle('cycleway:right')) props.bikeRight = 1.6
  const parks = (key: string) => /parallel|lane|diagonal|perpendicular|yes/.test(tags[key] ?? '')
  if (parks('parking:both') || parks('parking:lane:both')) props.parkingLeft = props.parkingRight = 2.2
  if (parks('parking:left') || parks('parking:lane:left')) props.parkingLeft = 2.2
  if (parks('parking:right') || parks('parking:lane:right')) props.parkingRight = 2.2
  return props
}

// From map tiles (when OpenStreetMap's servers are busy)

const TILE_STREETS: Partial<Record<RoadKind, string>> = {
  motorway: 'motorway',
  trunk: 'trunk',
  primary: 'primary',
  secondary: 'secondary',
  tertiary: 'tertiary',
  minor: 'residential',
  service: 'service',
}

export function planFromTiles(input: PlanInput, tiles: readonly TileFeatures[]): SitePlan {
  const { frame, area } = squareAround(input.lon, input.lat, input.size)
  const ground = Math.round(input.heightAt(input.lon, input.lat))
  const half = input.size / 2
  const rect: Rect = { minX: -half, minY: -half, maxX: half, maxY: half }
  const buildings: PlannedBuilding[] = []
  const streets: PlannedStreet[] = []
  for (const data of tiles) {
    const { z, x, y } = data.tile
    const toSite = (u: number, v: number): Vec2 => {
      const [e, n] = lonLatToFrame(frame, tileLon(x + u, z), tileLat(y + v, z), 0)
      return { x: e, y: n }
    }
    const ring = (line: Float64Array) => {
      const points: Vec2[] = []
      for (let i = 0; i < line.length; i += 2) points.push(toSite(line[i]!, line[i + 1]!))
      return points
    }
    // Each tile's own part (they overlap a little), and only what's in the square.
    const corners: [number, number][] = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ]
    const own: MultiPolygon = [[corners.map(([u, v]) => {
      const p = toSite(u, v)
      return [p.x, p.y] as [number, number]
    })]]
    for (const building of data.buildings as BuildingFeature[]) {
      const outer = ring(building.shape.outer)
      const holes = building.shape.holes.map(ring)
      const clipped = intersection([[outer, ...holes].map((r) => r.map((p) => [p.x, p.y] as [number, number]))], own)
      for (const polygon of clipped) {
        const [o, ...h] = polygon.map((r) => r.map(([px, py]) => ({ x: px, y: py })))
        for (const outline of piecesWithoutHoles(o!, h)) {
          const clean = tidyOutline(outline)
          if (!clean) continue
          const c = polygonCentroid(clean)
          if (Math.abs(c.x) > half || Math.abs(c.y) > half) continue
          const floors = Math.max(1, Math.round(building.height / 3.2))
          buildings.push({ name: '', outline: clean, floors, floorHeight: Math.round(Math.min(Math.max(building.height / floors, 2.5), 6) * 100) / 100, roof: null })
        }
      }
    }
    for (const road of data.roads) {
      const highway = TILE_STREETS[road.kind]
      if (!highway || road.tunnel) continue
      const props = streetFromTags({ highway })!
      const tileRect = ownRect(toSite)
      const line = Float64Array.from(ring(road.line).flatMap((p) => [p.x, p.y]))
      for (const piece of clipLine(line, tileRect).flatMap((l) => clipLine(l, rect))) {
        const points = simplify(toPoints(piece), 0.4)
        if (points.length >= 2) streets.push({ points, props })
      }
    }
  }
  return { name: input.name, lon: input.lon, lat: input.lat, ground, area, buildings, streets, spots: spotsFor(input, frame), source: 'tiles' }
}

/** A tile's own extent in site metres, near enough as a rectangle at site scale. */
function ownRect(toSite: (u: number, v: number) => Vec2): Rect {
  const a = toSite(0, 0)
  const b = toSite(1, 1)
  return { minX: Math.min(a.x, b.x), minY: Math.min(a.y, b.y), maxX: Math.max(a.x, b.x), maxY: Math.max(a.y, b.y) }
}

/** The z14 tiles covering an area. */
export function tilesFor(bounds: LonLatBounds) {
  return tilesCovering(bounds, 14)
}

// Outlines

/**
 * A polygon with holes as pieces without: cut across each hole (through
 * its middle) until none is left. A block round a courtyard becomes its
 * wings; buildings in Plinth are solid outlines.
 */
export function piecesWithoutHoles(outer: Vec2[], holes: Vec2[][]): Vec2[][] {
  const start: MultiPolygon = [[outer, ...holes].map((r) => r.map((p) => [p.x, p.y] as [number, number]))]
  const done: Vec2[][] = []
  let queue: { polygon: MultiPolygon[number]; depth: number }[] = start.map((polygon) => ({ polygon, depth: 0 }))
  while (queue.length > 0) {
    const next: typeof queue = []
    for (const { polygon, depth } of queue) {
      const [ring, ...inner] = polygon
      if (!ring) continue
      if (inner.length === 0 || depth > 6) {
        done.push(ring.map(([x, y]) => ({ x, y })))
        continue
      }
      // Cut through the first hole's middle, across the polygon's longer way.
      const hole = inner[0]!
      const xs = ring.map((p) => p[0])
      const ys = ring.map((p) => p[1])
      const minX = Math.min(...xs) - 1
      const maxX = Math.max(...xs) + 1
      const minY = Math.min(...ys) - 1
      const maxY = Math.max(...ys) + 1
      const hx = hole.reduce((s, p) => s + p[0], 0) / hole.length
      const hy = hole.reduce((s, p) => s + p[1], 0) / hole.length
      const across = maxX - minX < maxY - minY
      const box = (x0: number, y0: number, x1: number, y1: number): MultiPolygon => [
        [
          [
            [x0, y0],
            [x1, y0],
            [x1, y1],
            [x0, y1],
          ],
        ],
      ]
      const halves = across ? [box(minX, minY, maxX, hy), box(minX, hy, maxX, maxY)] : [box(minX, minY, hx, maxY), box(hx, minY, maxX, maxY)]
      for (const half of halves) for (const piece of intersection([polygon], half)) next.push({ polygon: piece, depth: depth + 1 })
    }
    queue = next
  }
  return done.map((ring) => {
    const first = ring[0]
    const last = ring.at(-1)
    return first && last && ring.length > 1 && first.x === last.x && first.y === last.y ? ring.slice(0, -1) : ring
  })
}

/** An outline without repeated or nearly-straight-through points, or null if too small to be a building. */
export function tidyOutline(points: Vec2[]): Vec2[] | null {
  let ring = simplifyRing(points, 0.12)
  // Anticlockwise, as Plinth draws outlines.
  if (signedArea2(ring) < 0) ring = [...ring].reverse()
  if (ring.length < 3 || Math.abs(signedArea2(ring)) / 2 < 6) return null
  return ring.map((p) => ({ x: round(p.x), y: round(p.y) }))
}

function toPoints(line: Float64Array): Vec2[] {
  const points: Vec2[] = []
  for (let i = 0; i < line.length; i += 2) points.push({ x: line[i]!, y: line[i + 1]! })
  return points
}

/** Douglas–Peucker: points closer than `tolerance` to the line through their neighbours go. */
export function simplify(points: Vec2[], tolerance: number): Vec2[] {
  if (points.length <= 2) return points
  const keep = new Uint8Array(points.length)
  keep[0] = keep[points.length - 1] = 1
  const stack: [number, number][] = [[0, points.length - 1]]
  while (stack.length > 0) {
    const [a, b] = stack.pop()!
    let worst = -1
    let far = tolerance
    for (let i = a + 1; i < b; i++) {
      const d = distanceToSegment(points[i]!, points[a]!, points[b]!)
      if (d > far) {
        far = d
        worst = i
      }
    }
    if (worst >= 0) {
      keep[worst] = 1
      stack.push([a, worst], [worst, b])
    }
  }
  return points.filter((_, i) => keep[i])
}

function simplifyRing(points: Vec2[], tolerance: number): Vec2[] {
  // Without repeats first, then simplified as a loop (split at the point furthest from the first).
  const unique = points.filter((p, i) => {
    const q = points[(i + 1) % points.length]!
    return Math.hypot(p.x - q.x, p.y - q.y) > 0.02
  })
  if (unique.length < 4) return unique
  let far = 0
  let split = 0
  unique.forEach((p, i) => {
    const d = Math.hypot(p.x - unique[0]!.x, p.y - unique[0]!.y)
    if (d > far) {
      far = d
      split = i
    }
  })
  const first = simplify(unique.slice(0, split + 1), tolerance)
  const second = simplify([...unique.slice(split), unique[0]!], tolerance)
  return [...first.slice(0, -1), ...second.slice(0, -1)]
}

function distanceToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const l = dx * dx + dy * dy
  const t = l === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l))
  return Math.hypot(p.x - a.x - dx * t, p.y - a.y - dy * t)
}

// Into the document

/**
 * Builds a planned site: the meta (its place on Earth, its ground height
 * and area), spot heights, streets, then the buildings, each on the
 * terrain under it: a ground floor with its walls and a run of copies of
 * it for the floors above, and its roof.
 */
export function buildSite(tx: Tx, plan: SitePlan): { buildings: number; streets: number } {
  tx.setMeta({ name: plan.name, origin: { kind: 'lonlat', lon: plan.lon, lat: plan.lat }, ground: plan.ground, worldArea: plan.area })
  addSpotHeights(tx, plan.spots)
  const terrain = terrainThrough(plan.spots.map((s, i) => ({ id: String(i), ...s })))
  let streets = 0
  for (const street of plan.streets) {
    for (let i = 0; i + 1 < street.points.length; i++) streets += insertStreet(tx, street.points[i]!, street.points[i + 1]!, street.props).length > 0 ? 1 : 0
  }
  let count = 0
  for (const planned of plan.buildings) {
    count++
    const id = createId()
    tx.putBuilding({ id, name: planned.name || `Building ${count}`, ...(planned.roof ? { roof: planned.roof } : {}) })
    const ground = tx.putLevel({ id: createId(), buildingId: id, name: levelName(0), elevation: 0, height: planned.floorHeight, masterId: null })
    insertPolyline(tx, ground.id, planned.outline, true)
    if (planned.floors > 1) {
      tx.putLevel({
        id: createId(),
        buildingId: id,
        name: `${levelName(1)} – ${levelName(planned.floors - 1)}`,
        elevation: planned.floorHeight,
        height: planned.floorHeight,
        masterId: ground.id,
        count: planned.floors - 1,
      })
    }
    // On the lowest ground under its corners, measured from the site's zero.
    const under = terrain ? groundUnder(terrain, planned.outline) : null
    restackLevels(tx, id, under === null ? 0 : Math.round((under - plan.ground) * 100) / 100)
  }
  return { buildings: count, streets }
}
