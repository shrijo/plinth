import { describe, expect, it } from 'vitest'
import { PlinthDocument } from '../document.ts'
import { analyzeSite } from '../geometry/analysis.ts'
import { sortedLevels } from '../model.ts'
import { findStacks } from '../stacks.ts'
import { buildingCentre, createBuilding, deleteBuilding, moveBuilding, rotateBuilding, setFloorCount } from './buildings.ts'

const square = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 8 },
  { x: 0, y: 8 },
]

describe('buildings', () => {
  it('creates floors with outer walls along the outline', () => {
    const doc = PlinthDocument.createEmpty()
    const building = doc.transact((tx) => createBuilding(tx, square, { floors: 3, floorHeight: 3.2 }))!
    const s = doc.getSnapshot()
    expect(sortedLevels(s, building.id).map((l) => [l.name, l.elevation])).toEqual([
      ['Ground floor', 0],
      ['Floor 1', 3.2],
      ['Floor 2', 6.4],
    ])
    expect(Object.keys(s.walls)).toHaveLength(12)
    // Each floor's walls line up with the floors above and below.
    for (const ids of findStacks(s).walls.values()) expect(ids).toHaveLength(3)
    const site = analyzeSite(s)
    expect(site.buildings.get(building.id)!.levels.every((l) => l.exteriorWalls.size === 4)).toBe(true)
    expect(site.grossArea).toBeCloseTo(3 * 10.2 * 8.2)
  })

  it('keeps buildings and their slabs apart', () => {
    const doc = PlinthDocument.createEmpty()
    const first = doc.transact((tx) => createBuilding(tx, square, { floors: 2 }))!
    const second = doc.transact((tx) => createBuilding(tx, square.map((p) => ({ x: p.x + 20, y: p.y })), { floors: 4 }))!
    const site = analyzeSite(doc.getSnapshot())
    expect(site.buildings.get(first.id)!.slabs).toHaveLength(3)
    expect(site.buildings.get(second.id)!.slabs).toHaveLength(5)
    expect(sortedLevels(doc.getSnapshot(), second.id).at(-1)!.elevation).toBe(9)
  })

  it('moves and rotates a building as a whole', () => {
    const doc = PlinthDocument.createEmpty()
    const building = doc.transact((tx) => createBuilding(tx, square, { floors: 2 }))!
    doc.transact((tx) => moveBuilding(tx, building.id, { x: 5, y: -2 }))
    expect(doc.transact((tx) => buildingCentre(tx, building.id))).toEqual({ x: 10, y: 2 })
    doc.transact((tx) => rotateBuilding(tx, building.id, Math.PI / 2, { x: 10, y: 2 }))
    const xs = Object.values(doc.getSnapshot().nodes).map((n) => n.x)
    // 10 m wide along x before, 8 m after a quarter turn.
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(8)
  })

  it('adds floors that copy the top floor, and removes floors from the top', () => {
    const doc = PlinthDocument.createEmpty()
    const building = doc.transact((tx) => createBuilding(tx, square, { floors: 2 }))!
    doc.transact((tx) => setFloorCount(tx, building.id, 4))
    let s = doc.getSnapshot()
    expect(sortedLevels(s, building.id)).toHaveLength(4)
    expect(Object.keys(s.walls)).toHaveLength(16)
    doc.transact((tx) => setFloorCount(tx, building.id, 1))
    s = doc.getSnapshot()
    expect(sortedLevels(s, building.id)).toHaveLength(1)
    expect(Object.keys(s.walls)).toHaveLength(4)
  })

  it('deletes a building with everything in it', () => {
    const doc = PlinthDocument.createEmpty()
    const building = doc.transact((tx) => createBuilding(tx, square, { floors: 2 }))!
    doc.transact((tx) => deleteBuilding(tx, building.id))
    const s = doc.getSnapshot()
    expect([Object.keys(s.buildings), Object.keys(s.levels), Object.keys(s.walls), Object.keys(s.nodes)]).toEqual([[], [], [], []])
  })

  it('refuses an outline without area', () => {
    const doc = PlinthDocument.createEmpty()
    expect(doc.transact((tx) => createBuilding(tx, [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }]))).toBeNull()
  })
})
