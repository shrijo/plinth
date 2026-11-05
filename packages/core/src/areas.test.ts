import { describe, expect, it } from 'vitest'
import { areaFigures, roomTagsOf, roomTitle, tagRoom } from './areas.ts'
import { PlinthDocument } from './document.ts'
import { parseProject, serializeProject } from './file.ts'
import { analyzeSite } from './geometry/analysis.ts'
import { createBuilding, moveBuilding } from './ops/buildings.ts'
import { setRepeatCount } from './ops/levels.ts'
import { insertWall } from './ops/walls.ts'
import { areaReportCSV } from './report.ts'

/** A 10 × 6 m building, two floors, its ground floor split into two rooms by a wall at x = 4. */
function setup() {
  const doc = PlinthDocument.createEmpty()
  const building = doc.transact((tx) => createBuilding(tx, [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 6 }, { x: 0, y: 6 }], { floors: 2, floorHeight: 3 }))!
  const ground = Object.values(doc.getSnapshot().levels).find((l) => l.buildingId === building.id && l.elevation === 0)!
  doc.transact((tx) => insertWall(tx, ground.id, { x: 4, y: 0 }, { x: 4, y: 6 }))
  return { doc, buildingId: building.id, groundId: ground.id }
}

const level = (doc: PlinthDocument, id: string) => analyzeSite(doc.getSnapshot()).byLevel.get(id)!
const value = (lines: { code: string; value: number }[], code: string) => lines.find((l) => l.code === code)!.value

describe('room tags', () => {
  it('name a room and give it a use, staying with it when the building moves', () => {
    const { doc, buildingId, groundId } = setup()
    const rooms = level(doc, groundId).rooms
    expect(rooms).toHaveLength(2)
    const west = rooms.findIndex((r) => r.labelPoint!.x < 4)
    doc.transact((tx) => tagRoom(tx, rooms[west]!, undefined, { name: 'Hall', use: 'circulation' }))
    let tags = roomTagsOf(doc.getSnapshot(), level(doc, groundId))
    expect(roomTitle(west, tags[west])).toBe('Hall')
    expect(tags[west]!.use).toBe('circulation')
    expect(roomTitle(1 - west, tags[1 - west])).toMatch(/^Room \d$/)
    doc.transact((tx) => moveBuilding(tx, buildingId, { x: 50, y: 20 }))
    const moved = level(doc, groundId)
    tags = roomTagsOf(doc.getSnapshot(), moved)
    expect(tags.filter(Boolean).map((t) => t!.name)).toEqual(['Hall'])
    // Saved and loaded with the project.
    expect(parseProject(serializeProject(doc.getSnapshot())).roomTags).toHaveLength(1)
  })
})

describe('area figures', () => {
  it('splits floor area by SIA 416 and DIN 277', () => {
    const { doc, buildingId, groundId } = setup()
    const rooms = level(doc, groundId).rooms
    const west = rooms.findIndex((r) => r.labelPoint!.x < 4)
    doc.transact((tx) => tagRoom(tx, rooms[west]!, undefined, { use: 'circulation' }))
    doc.transact((tx) => tagRoom(tx, rooms[1 - west]!, undefined, { use: 'office' }))
    const building = analyzeSite(doc.getSnapshot()).buildings.get(buildingId)!

    const sia = areaFigures(doc.getSnapshot(), buildingId, 'sia416')
    expect(value(sia.lines, 'GF')).toBeCloseTo(building.grossArea)
    expect(value(sia.lines, 'NGF')).toBeCloseTo(building.netArea)
    expect(value(sia.lines, 'KF')).toBeCloseTo(building.grossArea - building.netArea)
    expect(value(sia.lines, 'VF')).toBeCloseTo(rooms[west]!.area)
    // The upper floor's room has no use: main usable area, reported as not set.
    const upper = building.levels[1]!.rooms[0]!.area
    expect(value(sia.lines, 'HNF')).toBeCloseTo(rooms[1 - west]!.area + upper)
    expect(sia.unset).toBeCloseTo(upper)
    expect(value(sia.lines, 'NF')).toBeCloseTo(value(sia.lines, 'HNF') + value(sia.lines, 'NNF'))
    expect(value(sia.lines, 'NGF')).toBeCloseTo(value(sia.lines, 'NF') + value(sia.lines, 'VF') + value(sia.lines, 'FF'))
    expect(value(sia.lines, 'GV')).toBeCloseTo(building.grossArea * 3)

    const din = areaFigures(doc.getSnapshot(), buildingId, 'din277')
    expect(value(din.lines, 'BGF')).toBeCloseTo(building.grossArea)
    expect(value(din.lines, 'NUF 2')).toBeCloseTo(rooms[1 - west]!.area)
    expect(value(din.lines, 'NRF')).toBeCloseTo(value(din.lines, 'NUF') + value(din.lines, 'TF') + value(din.lines, 'VF'))
  })

  it("counts every floor of a run of copies, with the master floor's tags", () => {
    const { doc, buildingId, groundId } = setup()
    const rooms = level(doc, groundId).rooms
    doc.transact((tx) => tagRoom(tx, rooms[0]!, undefined, { use: 'storage' }))
    doc.transact((tx) => setRepeatCount(tx, groundId, 3))
    const sia = areaFigures(doc.getSnapshot(), buildingId, 'sia416')
    expect(value(sia.lines, 'NNF')).toBeCloseTo(rooms[0]!.area * 4)
  })

  it("reports names, uses and the standard's figures in the CSV", () => {
    const { doc, groundId } = setup()
    const rooms = level(doc, groundId).rooms
    doc.transact((tx) => tagRoom(tx, rooms[0]!, undefined, { name: 'Kitchen', use: 'living' }))
    const csv = areaReportCSV(doc.getSnapshot())
    expect(csv).toContain('Kitchen,Living,HNF')
    expect(csv).toMatch(/Site,GF,Floor area,\d/)
  })
})
