import type { LonLatBounds } from './tiles.ts'

/**
 * OpenStreetMap's own data for an area, through the Overpass API: every
 * building one by one with its tags (floors, height, roof shape, name,
 * address) and streets as connected ways. Richer than map tiles, which
 * merge neighbouring buildings and keep only their heights, but the public
 * servers are busy: each is tried in turn, and callers fall back on tiles.
 */

export type LonLat = [lon: number, lat: number]

export interface OsmBuilding {
  id: string
  outer: LonLat[]
  holes: LonLat[][]
  tags: Record<string, string>
}

export interface OsmWay {
  id: string
  points: LonLat[]
  tags: Record<string, string>
}

/** A surveyed surface: the outline of a carriageway, sidewalk or square (see Key:area:highway). */
export interface OsmArea {
  id: string
  /** The area:highway value: a road class, or footway, pedestrian, ... */
  kind: string
  outer: LonLat[]
  holes: LonLat[][]
}

/** A pedestrian crossing mapped as a node on the way. */
export interface OsmCrossing {
  at: LonLat
  tags: Record<string, string>
}

export interface OsmData {
  buildings: OsmBuilding[]
  streets: OsmWay[]
  /** Surveyed street surfaces, where the city maps them (area:highway). */
  areas?: OsmArea[]
  crossings?: OsmCrossing[]
}

export const OVERPASS_SERVERS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
]

/** Kinds of street a site gets (footpaths, tracks and the like are left out). */
const STREETS =
  'motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|pedestrian|road|busway|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link'

export function overpassQuery(b: LonLatBounds): string {
  const box = `${b.south},${b.west},${b.north},${b.east}`
  return `[out:json][timeout:40];
(
  way["building"](${box});
  relation["building"]["type"="multipolygon"](${box});
  way["highway"~"^(${STREETS})$"](${box});
  way["highway"~"^(footway|path)$"]["footway"="sidewalk"](${box});
  way["area:highway"](${box});
  relation["area:highway"]["type"="multipolygon"](${box});
  node["highway"="crossing"](${box});
);
out body geom;`
}

/**
 * Fetches an area's buildings and streets. The servers are asked one after
 * another a few seconds apart (a busy server can keep a request waiting a
 * long time), the first good answer wins, and after `seconds` it gives up.
 */
export async function fetchOsm(bounds: LonLatBounds, signal?: AbortSignal, seconds = 18, stagger = 4): Promise<OsmData> {
  const query = overpassQuery(bounds)
  const stop = new AbortController()
  const deadline = AbortSignal.timeout(seconds * 1000)
  const all = AbortSignal.any([stop.signal, deadline, ...(signal ? [signal] : [])])
  const ask = async (server: string, delay: number): Promise<OsmData> => {
    if (delay > 0) await sleep(delay, all)
    const response = await fetch(server, { method: 'POST', body: new URLSearchParams({ data: query }), signal: all })
    if (!response.ok) throw new Error(`Overpass ${response.status}`)
    const json = (await response.json()) as { elements?: Element[]; remark?: string }
    // A server out of time or memory answers with a remark and few elements.
    if (json.remark && /runtime error|timed out|out of memory/i.test(json.remark)) throw new Error(json.remark)
    return readOverpass(json.elements ?? [])
  }
  try {
    return await Promise.any(OVERPASS_SERVERS.map((server, i) => ask(server, i * stagger * 1000)))
  } catch {
    if (signal?.aborted) throw signal.reason
    throw new Error('OpenStreetMap\'s servers did not answer in time')
  } finally {
    stop.abort()
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(signal.reason)
    }, { once: true })
  })
}


interface Point {
  lat: number
  lon: number
}

type Element =
  | { type: 'way'; id: number; geometry?: (Point | null)[]; tags?: Record<string, string> }
  | { type: 'relation'; id: number; members?: { type: string; role: string; geometry?: (Point | null)[] }[]; tags?: Record<string, string> }
  | { type: 'node'; id: number; lat?: number; lon?: number; tags?: Record<string, string> }

/** Buildings, streets, surveyed surfaces and crossings from Overpass's answer. */
export function readOverpass(elements: readonly Element[]): OsmData {
  const data: OsmData = { buildings: [], streets: [], areas: [], crossings: [] }
  for (const element of elements) {
    if (element.type === 'node') {
      const tags = element.tags ?? {}
      if (tags.highway === 'crossing' && element.lon !== undefined && element.lat !== undefined) {
        data.crossings!.push({ at: [element.lon, element.lat], tags })
      }
    } else if (element.type === 'way') {
      const tags = element.tags ?? {}
      const points = (element.geometry ?? []).filter((p): p is Point => !!p).map((p): LonLat => [p.lon, p.lat])
      if (tags['area:highway']) {
        const ring = openRing(points)
        if (ring.length >= 3) data.areas!.push({ id: `w${element.id}`, kind: tags['area:highway'], outer: ring, holes: [] })
      } else if (tags.building) {
        const ring = openRing(points)
        if (ring.length >= 3) data.buildings.push({ id: `w${element.id}`, outer: ring, holes: [], tags })
      } else if (tags.highway && points.length >= 2) data.streets.push({ id: `w${element.id}`, points, tags })
    } else if (element.type === 'relation') {
      const tags = element.tags ?? {}
      const members = element.members ?? []
      const lines = (role: string) =>
        members
          .filter((m) => m.type === 'way' && (m.role || 'outer') === role)
          .map((m) => (m.geometry ?? []).filter((p): p is Point => !!p).map((p): LonLat => [p.lon, p.lat]))
      const outers = joinRings(lines('outer'))
      const inners = joinRings(lines('inner'))
      outers.forEach((outer, i) => {
        const holes = inners.filter((hole) => hole.length > 0 && insideLonLat(outer, hole[0]!))
        if (tags['area:highway']) data.areas!.push({ id: `r${element.id}-${i}`, kind: tags['area:highway'], outer, holes })
        else data.buildings.push({ id: `r${element.id}-${i}`, outer, holes, tags })
      })
    }
  }
  return data
}

/** A closed way's points without its repeated last point. */
function openRing(points: LonLat[]): LonLat[] {
  const first = points[0]
  const last = points.at(-1)
  if (first && last && points.length > 1 && first[0] === last[0] && first[1] === last[1]) return points.slice(0, -1)
  return points
}

/** Ways joined end to end into closed rings (a multipolygon's ring may be split over several). */
export function joinRings(lines: LonLat[][]): LonLat[][] {
  const same = (a: LonLat, b: LonLat) => a[0] === b[0] && a[1] === b[1]
  const rest = lines.filter((l) => l.length >= 2).map((l) => [...l])
  const rings: LonLat[][] = []
  while (rest.length > 0) {
    let ring = rest.shift()!
    let grown = true
    while (!same(ring[0]!, ring.at(-1)!) && grown) {
      grown = false
      for (let i = 0; i < rest.length; i++) {
        const line = rest[i]!
        const end = ring.at(-1)!
        if (same(line[0]!, end)) ring = [...ring, ...line.slice(1)]
        else if (same(line.at(-1)!, end)) ring = [...ring, ...[...line].reverse().slice(1)]
        else continue
        rest.splice(i, 1)
        grown = true
        break
      }
    }
    if (same(ring[0]!, ring.at(-1)!)) {
      const open = ring.slice(0, -1)
      if (open.length >= 3) rings.push(open)
    }
  }
  return rings
}

function insideLonLat(ring: LonLat[], [x, y]: LonLat): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!
    const [xj, yj] = ring[j]!
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}
