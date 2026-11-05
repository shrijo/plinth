import { describe, expect, it } from 'vitest'
import { PlinthDocument } from './document.ts'
import { parcelsFromGeoJSON, pointsFromXYZ } from './exchange/geodata.ts'
import { parseProject, serializeProject } from './file.ts'
import { createBuilding } from './ops/buildings.ts'
import { createParcel, moveParcelCorner } from './ops/parcels.ts'
import { parcelAt, parcelFigures } from './parcels.ts'

describe('parcels', () => {
  it('measure their area, the buildings on them, coverage and floor area ratio', () => {
    const doc = PlinthDocument.createEmpty()
    const parcel = doc.transact((tx) => createParcel(tx, [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 20 }, { x: 0, y: 20 }]))!
    expect(parcel.name).toBe('Parcel 1')
    // A 10 × 6 m building of three floors on it, one off it.
    doc.transact((tx) => createBuilding(tx, [{ x: 5, y: 5 }, { x: 15, y: 5 }, { x: 15, y: 11 }, { x: 5, y: 11 }], { floors: 3, floorHeight: 3 }))
    doc.transact((tx) => createBuilding(tx, [{ x: 50, y: 5 }, { x: 60, y: 5 }, { x: 60, y: 11 }, { x: 50, y: 11 }], { floors: 1, floorHeight: 3 }))
    const figures = parcelFigures(doc.getSnapshot(), parcel)
    expect(figures.area).toBeCloseTo(600)
    expect(figures.perimeter).toBeCloseTo(100)
    expect(figures.buildings).toHaveLength(1)
    // Footprints are the outer faces of the walls: the drawn outline grown by half a wall.
    expect(figures.covered).toBeGreaterThan(60)
    expect(figures.covered).toBeLessThan(64)
    expect(figures.coverage).toBeCloseTo(figures.covered / 600)
    expect(figures.floorAreaRatio).toBeCloseTo((figures.covered * 3) / 600, 1)
    expect(figures.coverageCode).toBe('ÜZ')
    expect(parcelFigures(doc.getSnapshot(), parcel, 'din277').coverageCode).toBe('GRZ')
    expect(parcelAt(doc.getSnapshot(), { x: 1, y: 1 })?.id).toBe(parcel.id)
    expect(parcelAt(doc.getSnapshot(), { x: 40, y: 1 })).toBeNull()
    doc.transact((tx) => moveParcelCorner(tx, parcel.id, 2, { x: 40, y: 20 }))
    expect(parcelFigures(doc.getSnapshot(), doc.getSnapshot().parcels[parcel.id]!).area).toBeCloseTo(700)
    expect(parseProject(serializeProject(doc.getSnapshot())).parcels).toHaveLength(1)
  })
})

describe('geodata', () => {
  it('reads parcels from GeoJSON in longitude and latitude, in metres round their middle', () => {
    // About 100 × 100 m near Zurich.
    const lat = 47.37
    const dLat = 100 / 111195
    const dLon = 100 / (111195 * Math.cos((lat * Math.PI) / 180))
    const square = [[8.54, lat], [8.54 + dLon, lat], [8.54 + dLon, lat + dLat], [8.54, lat + dLat], [8.54, lat]]
    const json = JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { NUMMER: '1234' }, geometry: { type: 'Polygon', coordinates: [square] } }] })
    const { parcels, origin } = parcelsFromGeoJSON(json, undefined)
    expect(origin.kind).toBe('lonlat')
    expect(parcels).toHaveLength(1)
    expect(parcels[0]!.name).toBe('1234')
    expect(parcels[0]!.points).toHaveLength(4)
    const xs = parcels[0]!.points.map((p) => p.x)
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(100, 0)
    expect(Math.min(...xs)).toBeCloseTo(-50, 0)
  })

  it('reads projected coordinates (LV95) and keeps the project origin for later imports', () => {
    const json = JSON.stringify({ type: 'Feature', properties: { name: 'Lot' }, geometry: { type: 'MultiPolygon', coordinates: [[[[2683000, 1247000], [2683040, 1247000], [2683040, 1247030], [2683000, 1247030], [2683000, 1247000]]]] } })
    const first = parcelsFromGeoJSON(json, undefined)
    expect(first.origin).toEqual({ kind: 'projected', x: 2683020, y: 1247015 })
    expect(first.parcels[0]!.points[0]).toEqual({ x: -20, y: -15 })
    const terrain = pointsFromXYZ('# x y z\n2683020 1247015 412.5\n2683030;1247015;413\n', first.origin)
    expect(terrain.points).toEqual([{ x: 0, y: 0, z: 412.5 }, { x: 10, y: 0, z: 413 }])
  })

  it('says what is wrong with a file it cannot read', () => {
    expect(() => parcelsFromGeoJSON('nope', undefined)).toThrow(/not a GeoJSON/)
    expect(() => parcelsFromGeoJSON('{"type":"FeatureCollection","features":[]}', undefined)).toThrow(/no polygons/)
    expect(() => pointsFromXYZ('a b c', undefined)).toThrow(/no lines/)
  })
})
