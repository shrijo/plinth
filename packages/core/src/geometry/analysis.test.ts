import { describe, expect, it } from 'vitest'
import { testSite } from '../test-helpers.ts'
import { addLevel, setRepeatCount } from '../ops/levels.ts'
import { insertRectangle, insertWall } from '../ops/walls.ts'
import { analyzeSite as analyzeBuilding } from './analysis.ts'
import { regionArea } from './regions.ts'

const setup = testSite

describe('rooms', () => {
  it('finds a room inside a closed loop, measured inside the walls', () => {
    const { doc, groundId } = setup()
    doc.transact((tx) => insertRectangle(tx, groundId, { x: 0, y: 0 }, { x: 4, y: 3 }))
    const level = analyzeBuilding(doc.getSnapshot()).byLevel.get(groundId)!
    expect(level.rooms).toHaveLength(1)
    // 4 × 3 on the centre lines, 0.2 m walls: 3.8 × 2.8 inside, 4.2 × 3.2 outside.
    expect(level.rooms[0]!.area).toBeCloseTo(3.8 * 2.8)
    expect(level.rooms[0]!.perimeter).toBeCloseTo(2 * (3.8 + 2.8))
    expect(level.grossArea).toBeCloseTo(4.2 * 3.2)
  })

  it('finds no room in open walls', () => {
    const { doc, groundId } = setup()
    doc.transact((tx) => {
      insertWall(tx, groundId, { x: 0, y: 0 }, { x: 4, y: 0 })
      insertWall(tx, groundId, { x: 4, y: 0 }, { x: 4, y: 3 })
    })
    const level = analyzeBuilding(doc.getSnapshot()).byLevel.get(groundId)!
    expect(level.rooms).toHaveLength(0)
    expect(level.grossArea).toBe(0)
  })

  it('splits a room in two with a partition', () => {
    const { doc, groundId } = setup()
    doc.transact((tx) => {
      insertRectangle(tx, groundId, { x: 0, y: 0 }, { x: 6, y: 4 })
      insertWall(tx, groundId, { x: 2, y: 0 }, { x: 2, y: 4 })
    })
    const level = analyzeBuilding(doc.getSnapshot()).byLevel.get(groundId)!
    const areas = level.rooms.map((r) => r.area).sort((p, q) => p - q)
    expect(areas[0]).toBeCloseTo(1.8 * 3.8)
    expect(areas[1]).toBeCloseTo(3.8 * 3.8)
    expect(level.netArea).toBeCloseTo(1.8 * 3.8 + 3.8 * 3.8)
  })

  it('cuts a free-standing wall out of the floor', () => {
    const { doc, groundId } = setup()
    doc.transact((tx) => {
      insertRectangle(tx, groundId, { x: 0, y: 0 }, { x: 6, y: 4 })
      insertWall(tx, groundId, { x: 2, y: 2 }, { x: 4, y: 2 })
    })
    const room = analyzeBuilding(doc.getSnapshot()).byLevel.get(groundId)!.rooms[0]!
    // The free-standing wall has square ends: 2 m × 0.2 m.
    expect(room.area).toBeCloseTo(5.8 * 3.8 - 2 * 0.2)
  })

  it('cuts a room inside another room out of it', () => {
    const { doc, groundId } = setup()
    doc.transact((tx) => {
      insertRectangle(tx, groundId, { x: 0, y: 0 }, { x: 10, y: 10 })
      insertRectangle(tx, groundId, { x: 4, y: 4 }, { x: 6, y: 6 })
    })
    const rooms = analyzeBuilding(doc.getSnapshot()).byLevel.get(groundId)!.rooms
    const areas = rooms.map((r) => r.area).sort((p, q) => p - q)
    expect(areas[0]).toBeCloseTo(1.8 * 1.8)
    expect(areas[1]).toBeCloseTo(9.8 * 9.8 - 2.2 * 2.2)
  })
})

describe('slabs', () => {
  it('puts a floor under each level and a roof on top', () => {
    const { doc, groundId, buildingId } = setup()
    doc.transact((tx) => insertRectangle(tx, groundId, { x: 0, y: 0 }, { x: 4, y: 3 }))
    const upper = doc.transact((tx) => addLevel(tx, buildingId))
    doc.transact((tx) => insertRectangle(tx, upper.id, { x: 0, y: 0 }, { x: 4, y: 3 }))
    const { slabs } = analyzeBuilding(doc.getSnapshot())
    expect(slabs.map((s) => [s.levelId, s.top, s.bottom])).toEqual([
      [groundId, 0, -0.25],
      [upper.id, 3, 2.75],
      [null, 6, 5.75],
    ])
    // Out to the outer faces of the walls: 4 × 3 on the centre lines, plus 0.1 m all round.
    for (const slab of slabs) expect(regionArea(slab.region)).toBeCloseTo(4.2 * 3.2)
  })

  it('covers a terrace where the floor above is smaller', () => {
    const { doc, groundId, buildingId } = setup()
    doc.transact((tx) => insertRectangle(tx, groundId, { x: 0, y: 0 }, { x: 6, y: 3 }))
    const upper = doc.transact((tx) => addLevel(tx, buildingId))
    doc.transact((tx) => insertRectangle(tx, upper.id, { x: 0, y: 0 }, { x: 4, y: 3 }))
    const { slabs } = analyzeBuilding(doc.getSnapshot())
    expect(regionArea(slabs.find((s) => s.levelId === upper.id)!.region)).toBeCloseTo(6.2 * 3.2)
    expect(regionArea(slabs.find((s) => s.levelId === null)!.region)).toBeCloseTo(4.2 * 3.2)
  })

  it('makes no slab under walls that enclose nothing', () => {
    const { doc, groundId } = setup()
    doc.transact((tx) => insertWall(tx, groundId, { x: 0, y: 0 }, { x: 6, y: 0 }))
    expect(analyzeBuilding(doc.getSnapshot()).slabs).toEqual([])
  })

  it('extends the floor under an overhang', () => {
    const { doc, groundId, buildingId } = setup()
    doc.transact((tx) => insertRectangle(tx, groundId, { x: 0, y: 0 }, { x: 4, y: 3 }))
    const upper = doc.transact((tx) => addLevel(tx, buildingId))
    doc.transact((tx) => insertRectangle(tx, upper.id, { x: 0, y: 0 }, { x: 6, y: 3 }))
    const floor = analyzeBuilding(doc.getSnapshot()).slabs.find((s) => s.levelId === upper.id)!
    // The whole upper outline, which contains the lower one.
    expect(regionArea(floor.region)).toBeCloseTo(6.2 * 3.2)
  })

  it('gives copies the same rooms as their master', () => {
    const { doc, groundId } = setup()
    doc.transact((tx) => insertRectangle(tx, groundId, { x: 0, y: 0 }, { x: 4, y: 3 }))
    doc.transact((tx) => setRepeatCount(tx, groundId, 2))
    const building = analyzeBuilding(doc.getSnapshot())
    // The master and one run of two copies.
    expect(building.levels.map((l) => [l.rooms.length, l.floors])).toEqual([
      [1, 1],
      [1, 2],
    ])
    expect(building.netArea).toBeCloseTo(3 * 3.8 * 2.8)
    // Floor slabs at all three floors (one entry repeating for the run), and the roof.
    expect(building.slabs.reduce((sum, s) => sum + s.count, 0)).toBe(4)
  })

  it('reuses the analysis when only openings change', () => {
    const { doc, groundId } = setup()
    const walls = doc.transact((tx) => insertRectangle(tx, groundId, { x: 0, y: 0 }, { x: 4, y: 3 }))
    const first = analyzeBuilding(doc.getSnapshot())
    doc.transact((tx) =>
      tx.putOpening({ id: 'o', wallId: walls[0]!, kind: 'window', typeId: 'window', offset: 2, width: 1, height: 1, sill: 1 }),
    )
    expect(analyzeBuilding(doc.getSnapshot())).toBe(first)
  })
})

describe('the fast path for a simple loop of walls', () => {
  it('matches the general polygon operations', async () => {
    const { PlinthDocument } = await import('../document.ts')
    const { testSite } = await import('../test-helpers.ts')
    const { insertPolyline, setWallProps } = await import('../ops/walls.ts')
    const { computeFootprints } = await import('./footprint.ts')
    const { union, regionArea, toRing } = await import('./regions.ts')
    void PlinthDocument
    for (const shape of [
      // An L, walked clockwise, with one thicker wall.
      [
        { x: 0, y: 0 },
        { x: 0, y: 8 },
        { x: 4, y: 8 },
        { x: 4, y: 3 },
        { x: 10, y: 3 },
        { x: 10, y: 0 },
      ],
      // A hexagon.
      Array.from({ length: 6 }, (_, i) => ({ x: 6 * Math.cos((i * Math.PI) / 3), y: 6 * Math.sin((i * Math.PI) / 3) })),
    ]) {
      const { doc, groundId } = testSite()
      const ids = doc.transact((tx) => insertPolyline(tx, groundId, shape, true))
      doc.transact((tx) => setWallProps(tx, [ids[1]!], { thickness: 0.45 }))
      const s = doc.getSnapshot()
      const level = analyzeBuilding(s).byLevel.get(groundId)!
      // The general way: union of the footprints, its hole is the room.
      const walls = Object.values(s.walls).filter((w) => w.levelId === groundId)
      const footprints = computeFootprints(s.nodes, walls, (w) => w.thickness ?? s.meta.wallThickness)
      const region = union(...[...footprints.values()].map((fp) => [[toRing(fp.polygon)]]))
      expect(region).toHaveLength(1)
      const [outer, hole] = region[0]!
      expect(level.grossArea).toBeCloseTo(regionArea([[outer!]]), 3)
      expect(level.rooms).toHaveLength(1)
      expect(level.rooms[0]!.area).toBeCloseTo(regionArea([[hole!]]), 3)
      expect(level.exteriorWalls.size).toBe(walls.length)
    }
  })
})
