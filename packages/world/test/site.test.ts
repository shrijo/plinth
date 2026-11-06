import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { PlinthDocument, analyzeSite, floorsOf, sortedLevels, terrainOf } from '@plinth/core'
import { readTile } from '../src/features.ts'
import { buildSite, piecesWithoutHoles, planFromOsm, planFromTiles, squareAround, streetFromTags, tagNumber } from '../src/site.ts'
import { joinRings, readOverpass, type OsmData } from '../src/osm.ts'
import { frameToLonLat } from '../src/geo.ts'
import { tileLat, tileLon } from '../src/tiles.ts'

const LON = 8.5417
const LAT = 47.3769

/** A hill rising 1 m every 10 m eastwards, from 400 m at the middle. */
const hill = (lon: number) => 400 + (lon - LON) * 111320 * Math.cos((LAT * Math.PI) / 180) * 0.1

function lonLat(x: number, y: number): [number, number] {
  const { frame } = squareAround(LON, LAT, 1)
  const p = frameToLonLat(frame, x, y)
  return [p.lon, p.lat]
}

const rect = (x0: number, y0: number, x1: number, y1: number) => [lonLat(x0, y0), lonLat(x1, y0), lonLat(x1, y1), lonLat(x0, y1)]

const osm: OsmData = {
  buildings: [
    { id: 'w1', outer: rect(-40, -20, -10, 0), holes: [], tags: { building: 'apartments', 'building:levels': '5', 'roof:shape': 'gabled', name: 'Hof' } },
    // A block round a courtyard.
    { id: 'r2', outer: rect(10, 10, 60, 60), holes: [rect(25, 25, 45, 45)], tags: { building: 'yes', height: '18' } },
    { id: 'w3', outer: rect(70, -10, 76, -4), holes: [], tags: { building: 'garage' } },
    // Its middle is outside the square: left to the world around.
    { id: 'w4', outer: rect(140, 0, 170, 20), holes: [], tags: { building: 'yes' } },
    { id: 'w5', outer: rect(-60, 40, -50, 50), holes: [], tags: { building: 'roof' } },
  ],
  streets: [
    { id: 'w10', points: [lonLat(-200, -30), lonLat(0, -30), lonLat(200, -30)], tags: { highway: 'secondary', sidewalk: 'both' } },
    { id: 'w11', points: [lonLat(0, -30), lonLat(0, 120)], tags: { highway: 'residential', oneway: 'yes' } },
    { id: 'w12', points: [lonLat(-50, -100), lonLat(-50, -40)], tags: { highway: 'footway' } },
  ],
}

describe('planning a site from OpenStreetMap', () => {
  const plan = planFromOsm({ name: 'Test', lon: LON, lat: LAT, size: 300, heightAt: (lon) => hill(lon) }, osm)

  it('keeps buildings whose middle is in the square, and leaves out open roofs', () => {
    // The courtyard block comes in pieces.
    expect(plan.buildings.length).toBeGreaterThanOrEqual(4)
    expect(plan.buildings.some((b) => b.name === 'Hof')).toBe(true)
    for (const b of plan.buildings) for (const p of b.outline) expect(Math.abs(p.x)).toBeLessThan(160)
  })

  it('reads floors, heights and roofs from the tags', () => {
    const hof = plan.buildings.find((b) => b.name === 'Hof')!
    expect(hof.floors).toBe(5)
    expect(hof.roof?.kind).toBe('gable')
    const block = plan.buildings.filter((b) => b.floors === 6)
    expect(block.length).toBeGreaterThanOrEqual(2)
    expect(block[0]!.floorHeight).toBeCloseTo(3)
    const garage = plan.buildings.find((b) => Math.abs(b.outline[0]!.x - 73) < 4)!
    expect(garage.floors).toBe(1)
  })

  it('cuts streets to the square, leaves out footpaths and joins a street ending on another', () => {
    // The secondary road is split where the residential one meets it: three streets at one point.
    expect(plan.streets).toHaveLength(3)
    const atJunction = plan.streets.filter((s) => s.points.some((p) => Math.hypot(p.x, p.y + 30) < 0.1))
    expect(atJunction).toHaveLength(3)
    for (const s of plan.streets) for (const p of s.points) expect(Math.max(Math.abs(p.x), Math.abs(p.y))).toBeLessThanOrEqual(150.0001)
  })

  it('sets the zero at the ground in the middle and the spot heights from it', () => {
    expect(plan.ground).toBe(400)
    // Kept as heights above sea level; the site is drawn from its zero.
    const east = plan.spots.filter((s) => s.x > 149)
    for (const s of east) expect(s.z).toBeCloseTo(415, 0)
  })

  it('builds into a document: buildings on the terrain, streets joined', () => {
    const doc = new PlinthDocument()
    const result = doc.transact((tx) => buildSite(tx, plan))
    expect(result.buildings).toBe(plan.buildings.length)
    const snapshot = doc.getSnapshot()
    expect(snapshot.meta.origin).toEqual({ kind: 'lonlat', lon: LON, lat: LAT })
    expect(snapshot.meta.ground).toBe(400)
    expect(snapshot.meta.worldArea).toHaveLength(4)
    expect(terrainOf(snapshot)).not.toBeNull()
    // The two streets meet at a junction: three street points or more, one shared.
    const nodes = Object.values(snapshot.streetNodes)
    expect(nodes.some((n) => Math.abs(n.x) < 0.1 && Math.abs(n.y + 30) < 0.1)).toBe(true)
    const analysis = analyzeSite(snapshot)
    expect(analysis.buildings.size).toBe(plan.buildings.length)
    const hof = Object.values(snapshot.buildings).find((b) => b.name === 'Hof')!
    const levels = sortedLevels(snapshot, hof.id)
    expect(levels.reduce((n, l) => n + floorsOf(l), 0)).toBe(5)
    // On the slope: the lowest corner of the ground under it (x = -40 m: 4 m below the middle).
    expect(levels[0]!.elevation).toBeCloseTo(-4, 0)
  })
})

describe('streets from tags', () => {
  it('reads lanes, sidewalks and bike lanes', () => {
    const props = streetFromTags({ highway: 'primary', lanes: '4', sidewalk: 'right', cycleway: 'lane' })!
    expect(props.lanes).toBe(4)
    expect(props.sidewalkLeft).toBe(0)
    expect(props.sidewalkRight).toBeGreaterThan(0)
    expect(props.bikeLeft).toBeGreaterThan(0)
  })

  it('leaves out tunnels, footpaths and parking aisles', () => {
    expect(streetFromTags({ highway: 'footway' })).toBeNull()
    expect(streetFromTags({ highway: 'primary', tunnel: 'yes' })).toBeNull()
    expect(streetFromTags({ highway: 'service', service: 'parking_aisle' })).toBeNull()
  })

  it('reads numbers with units', () => {
    expect(tagNumber('12.5 m')).toBe(12.5)
    expect(tagNumber('7,5')).toBe(7.5)
    expect(tagNumber('30 ft')).toBeCloseTo(9.144)
    expect(tagNumber('tall')).toBeNull()
  })
})

describe('outlines', () => {
  it('cuts a courtyard block into pieces without holes, with the same area', () => {
    const square = (h: number) => [
      { x: -h, y: -h },
      { x: h, y: -h },
      { x: h, y: h },
      { x: -h, y: h },
    ]
    const pieces = piecesWithoutHoles(square(20), [square(10)])
    expect(pieces.length).toBeGreaterThanOrEqual(2)
    const area = (ring: { x: number; y: number }[]) =>
      Math.abs(ring.reduce((s, p, i) => s + p.x * ring[(i + 1) % ring.length]!.y - ring[(i + 1) % ring.length]!.x * p.y, 0) / 2)
    expect(pieces.reduce((s, p) => s + area(p), 0)).toBeCloseTo(1600 - 400)
  })

  it('joins a ring split over several ways', () => {
    const rings = joinRings([
      [
        [0, 0],
        [1, 0],
      ],
      [
        [1, 1],
        [1, 0],
      ],
      [
        [1, 1],
        [0, 1],
        [0, 0],
      ],
    ])
    expect(rings).toHaveLength(1)
    expect(rings[0]).toHaveLength(4)
  })

  it('reads an Overpass answer', () => {
    const data = readOverpass([
      { type: 'way', id: 1, tags: { building: 'yes' }, geometry: [{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }, { lat: 1, lon: 1 }, { lat: 0, lon: 0 }] },
      { type: 'way', id: 2, tags: { highway: 'residential' }, geometry: [{ lat: 0, lon: 0 }, { lat: 1, lon: 1 }] },
    ])
    expect(data.buildings).toHaveLength(1)
    expect(data.buildings[0]!.outer).toHaveLength(3)
    expect(data.streets).toHaveLength(1)
  })
})

describe('planning from map tiles', () => {
  const tile = { z: 14, x: 8580, y: 5737 }
  const features = readTile(tile, readFileSync(new URL('./zurich-14-8580-5737.pbf', import.meta.url)))
  const lon = tileLon(tile.x + 0.5, tile.z)
  const lat = tileLat(tile.y + 0.5, tile.z)

  it('makes buildings and streets from a real tile, fast enough', () => {
    const plan = planFromTiles({ name: 'Zurich', lon, lat, size: 400, heightAt: () => 410 }, [features])
    expect(plan.buildings.length).toBeGreaterThan(50)
    expect(plan.streets.length).toBeGreaterThan(20)
    const doc = new PlinthDocument()
    const started = performance.now()
    doc.transact((tx) => buildSite(tx, plan))
    const seconds = (performance.now() - started) / 1000
    expect(Object.keys(doc.getSnapshot().buildings).length).toBe(plan.buildings.length)
    expect(seconds).toBeLessThan(20)
  })
})
