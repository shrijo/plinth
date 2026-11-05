import { describe, expect, it } from 'vitest'
import { PlinthDocument } from '../document.ts'
import { analyzeSite } from '../geometry/analysis.ts'
import { mergeStreetRegions, streetGeometry, type StreetGeometry } from '../geometry/streets.ts'
import type { Snapshot as SnapshotOf } from '../model.ts'

/** The street pieces merged, for measuring. */
const merged = (s: SnapshotOf) => {
  const g: StreetGeometry = streetGeometry(s)
  return {
    ...mergeStreetRegions(g),
    markings: g.pieces.flatMap((p) => p.markings),
    crosswalks: g.pieces.flatMap((p) => p.crosswalks),
  }
}
import { moveBuilding } from '../ops/buildings.ts'
import { buildExampleCity, EXAMPLE_CITY_NAME } from './exampleCity.ts'

describe('the example city', () => {
  it('builds a large site that analyses quickly, and re-analyses one changed building quicker still', () => {
    const doc = PlinthDocument.createEmpty()
    let started = performance.now()
    doc.transact((tx) => buildExampleCity(tx))
    const buildMs = performance.now() - started
    const s = doc.getSnapshot()
    expect(s.meta.name).toBe(EXAMPLE_CITY_NAME)
    expect(Object.keys(s.buildings).length).toBeGreaterThan(140)
    expect(Object.keys(s.streets).length).toBeGreaterThan(40)

    started = performance.now()
    const analysis = analyzeSite(s)
    const analyseMs = performance.now() - started
    expect(analysis.buildings.size).toBe(Object.keys(s.buildings).length)
    // Every building encloses floor area on every level.
    for (const building of analysis.buildings.values()) expect(building.grossArea).toBeGreaterThan(0)
    // The town hall's rooms: five to the south of the corridor, four to the north, the corridor itself.
    const hall = Object.values(s.buildings).find((b) => b.name === 'Town Hall')!
    expect(analysis.buildings.get(hall.id)!.levels[0]!.rooms).toHaveLength(10)

    started = performance.now()
    const streets = merged(s)
    const streetsMs = performance.now() - started
    expect(streets.road).toHaveLength(1)

    // Moving one building re-analyses only that one; the rest keep their results.
    const someone = Object.values(s.buildings).find((b) => b.name === 'Museum')!
    doc.transact((tx) => moveBuilding(tx, someone.id, { x: 1, y: 0 }))
    started = performance.now()
    const again = analyzeSite(doc.getSnapshot())
    const editMs = performance.now() - started
    expect(again.buildings.get(hall.id)).toBe(analysis.buildings.get(hall.id))
    expect(again.buildings.get(someone.id)).not.toBe(analysis.buildings.get(someone.id))

    console.info(
      `example city: ${Object.keys(s.buildings).length} buildings, ${Object.keys(s.levels).length} levels, ` +
        `${Object.keys(s.walls).length} walls, ${Object.keys(s.openings).length} openings, ${Object.keys(s.streets).length} streets; ` +
        `build ${buildMs.toFixed(0)} ms, analyse ${analyseMs.toFixed(0)} ms, streets ${streetsMs.toFixed(0)} ms, after an edit ${editMs.toFixed(1)} ms`,
    )
    expect(editMs).toBeLessThan(analyseMs)
  })
})
