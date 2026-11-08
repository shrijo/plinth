import { describe, expect, it } from 'vitest'
import { testSite } from '../test-helpers.ts'
import { dist } from '../math.ts'
import { openingCopies, rowReach, type Snapshot } from '../model.ts'
import { parseProject, serializeProject } from '../file.ts'
import { connectIntersection, disconnectNode, findIntersections } from './intersections.ts'
import { addOpening, splitRow, updateOpening } from './openings.ts'
import { deleteWalls, insertRectangle, insertWall } from './walls.ts'

const setup = testSite

/** Where an opening's centre is in plan. */
function centreOf(s: Snapshot, openingId: string) {
  const opening = s.openings[openingId]!
  const wall = s.walls[opening.wallId]!
  const a = s.nodes[wall.a]!
  const b = s.nodes[wall.b]!
  const t = opening.offset / dist(a, b)
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
}

describe('openings', () => {
  it('takes its size from its type', () => {
    const { doc, levelId } = setup()
    const [wallId] = doc.transact((tx) => insertWall(tx, levelId, { x: 0, y: 0 }, { x: 6, y: 0 }))
    const opening = doc.transact((tx) => addOpening(tx, wallId!, { kind: 'door', typeId: 'door', offset: 2 }))
    expect(opening).toMatchObject({ width: 0.9, height: 2.1, sill: 0 })
  })

  it('moves to the right part when its wall is split', () => {
    const { doc, levelId } = setup()
    const [wallId] = doc.transact((tx) => insertWall(tx, levelId, { x: 0, y: 0 }, { x: 8, y: 0 }))
    const near = doc.transact((tx) => addOpening(tx, wallId!, { kind: 'window', typeId: 'window', offset: 1.5 }))
    const far = doc.transact((tx) => addOpening(tx, wallId!, { kind: 'window', typeId: 'window', offset: 6 }))
    doc.transact((tx) => insertWall(tx, levelId, { x: 4, y: 0 }, { x: 4, y: 3 }))
    doc.transact((tx) => connectIntersection(tx, findIntersections(doc.getSnapshot(), levelId)[0]!))
    const s = doc.getSnapshot()
    expect(s.openings[near.id]!.wallId).toBe(wallId)
    expect(s.openings[far.id]!.wallId).not.toBe(wallId)
    expect(centreOf(s, near.id)).toEqual({ x: 1.5, y: 0 })
    expect(centreOf(s, far.id).x).toBeCloseTo(6)
  })

  it('stays in place when a split wall heals back together', () => {
    const { doc, levelId } = setup()
    const [wallId] = doc.transact((tx) => insertWall(tx, levelId, { x: 0, y: 0 }, { x: 8, y: 0 }))
    const branch = doc.transact((tx) => insertWall(tx, levelId, { x: 4, y: 0 }, { x: 4, y: 3 }))
    doc.transact((tx) => connectIntersection(tx, findIntersections(doc.getSnapshot(), levelId)[0]!))
    const s1 = doc.getSnapshot()
    const secondHalf = Object.values(s1.walls).find((w) => w.id !== wallId && !branch.includes(w.id))!
    const opening = doc.transact((tx) => addOpening(tx, secondHalf.id, { kind: 'window', typeId: 'window', offset: 2 }))
    const before = centreOf(doc.getSnapshot(), opening.id)
    doc.transact((tx) => deleteWalls(tx, branch))
    const s2 = doc.getSnapshot()
    expect(Object.keys(s2.walls)).toHaveLength(1)
    expect(s2.openings[opening.id]!.wallId).toBe(wallId)
    expect(centreOf(s2, opening.id).x).toBeCloseTo(before.x)
  })

  it('is deleted with its wall', () => {
    const { doc, levelId } = setup()
    const walls = doc.transact((tx) => insertRectangle(tx, levelId, { x: 0, y: 0 }, { x: 5, y: 4 }))
    const opening = doc.transact((tx) => addOpening(tx, walls[0]!, { kind: 'window', typeId: 'window', offset: 2 }))
    doc.transact((tx) => deleteWalls(tx, [walls[0]!]))
    expect(doc.getSnapshot().openings[opening.id]).toBeUndefined()
  })

  it('moves to the surviving wall when a duplicate is drawn over its wall', () => {
    const { doc, levelId } = setup()
    const [wallId] = doc.transact((tx) => insertWall(tx, levelId, { x: 0, y: 0 }, { x: 4, y: 0 }))
    const opening = doc.transact((tx) => addOpening(tx, wallId!, { kind: 'window', typeId: 'window', offset: 1 }))
    doc.transact((tx) => insertWall(tx, levelId, { x: 4, y: 0 }, { x: 0, y: 0 }))
    const s = doc.getSnapshot()
    expect(Object.keys(s.walls)).toHaveLength(1)
    expect(centreOf(s, opening.id).x).toBeCloseTo(1)
  })
})

describe('rows of windows', () => {
  /** Plan x of each window's centre, in order, on walls along the x axis from 0. */
  function windowXs(s: Snapshot): number[] {
    return Object.values(s.openings)
      .flatMap((o) => openingCopies(o).map((c) => centreOf({ ...s, openings: { [c.id]: c } }, c.id).x))
      .map((x) => Math.round(x * 1000) / 1000)
      .sort((a, b) => a - b)
  }

  it('stands for evenly spaced copies centred on its offset', () => {
    const { doc, levelId } = setup()
    const [wallId] = doc.transact((tx) => insertWall(tx, levelId, { x: 0, y: 0 }, { x: 12, y: 0 }))
    const row = doc.transact((tx) => addOpening(tx, wallId!, { kind: 'window', typeId: 'window', offset: 6 }))
    doc.transact((tx) => updateOpening(tx, row.id, { count: 4, spacing: 2.5 }))
    const s = doc.getSnapshot()
    expect(openingCopies(s.openings[row.id]!).map((o) => o.offset)).toEqual([2.25, 4.75, 7.25, 9.75])
    expect(rowReach(s.openings[row.id]!)).toBeCloseTo(3.75 + 0.6)
    // Every copy keeps the row's id, so picking any of them picks the row.
    expect(new Set(openingCopies(s.openings[row.id]!).map((o) => o.id))).toEqual(new Set([row.id]))
  })

  it('goes back to a single window at a count of one, and never overlaps itself', () => {
    const { doc, levelId } = setup()
    const [wallId] = doc.transact((tx) => insertWall(tx, levelId, { x: 0, y: 0 }, { x: 12, y: 0 }))
    const row = doc.transact((tx) => addOpening(tx, wallId!, { kind: 'window', typeId: 'window', offset: 6 }))
    doc.transact((tx) => updateOpening(tx, row.id, { count: 3, spacing: 0.5 }))
    expect(doc.getSnapshot().openings[row.id]!.spacing).toBe(1.2)
    doc.transact((tx) => updateOpening(tx, row.id, { count: 1 }))
    const single = doc.getSnapshot().openings[row.id]!
    expect(single.count).toBeUndefined()
    expect(single.spacing).toBeUndefined()
  })

  it('splits where its wall is split, each window staying where it was', () => {
    const { doc, levelId } = setup()
    const [wallId] = doc.transact((tx) => insertWall(tx, levelId, { x: 0, y: 0 }, { x: 12, y: 0 }))
    const row = doc.transact((tx) => addOpening(tx, wallId!, { kind: 'window', typeId: 'window', offset: 6 }))
    doc.transact((tx) => updateOpening(tx, row.id, { count: 4, spacing: 2.5 }))
    const before = windowXs(doc.getSnapshot())
    doc.transact((tx) => insertWall(tx, levelId, { x: 6, y: 0 }, { x: 6, y: 3 }))
    doc.transact((tx) => connectIntersection(tx, findIntersections(doc.getSnapshot(), levelId)[0]!))
    const s = doc.getSnapshot()
    const rows = Object.values(s.openings)
    expect(rows).toHaveLength(2)
    expect(rows.map((o) => o.count)).toEqual([2, 2])
    expect(new Set(rows.map((o) => o.wallId)).size).toBe(2)
    expect(windowXs(s)).toEqual(before)
  })

  it('splits into a single window and a row, or not at all', () => {
    const row = { id: 'r', wallId: 'w', kind: 'window', typeId: 'window', offset: 5, width: 1, height: 1, sill: 1, count: 3, spacing: 2 } as const
    const { before, after } = splitRow(row, 4)
    expect(before).toMatchObject({ id: 'r', offset: 3 })
    expect(before?.count).toBeUndefined()
    expect(after).toMatchObject({ offset: 6, count: 2, spacing: 2 })
    expect(splitRow(row, 0)).toEqual({ before: null, after: row })
    expect(splitRow(row, 10).after).toBeNull()
  })

  it('is saved and loaded with its count and spacing', () => {
    const { doc, levelId } = setup()
    const [wallId] = doc.transact((tx) => insertWall(tx, levelId, { x: 0, y: 0 }, { x: 12, y: 0 }))
    const row = doc.transact((tx) => addOpening(tx, wallId!, { kind: 'window', typeId: 'window', offset: 6 }))
    doc.transact((tx) => updateOpening(tx, row.id, { count: 4, spacing: 2.5 }))
    const file = parseProject(serializeProject(doc.getSnapshot()))
    expect(file.openings[0]).toMatchObject({ count: 4, spacing: 2.5 })
  })
})

describe('separating a junction', () => {
  it('keeps openings where they are', () => {
    const { doc, levelId } = setup()
    doc.transact((tx) => {
      insertWall(tx, levelId, { x: 0, y: 0 }, { x: 8, y: 0 })
      insertWall(tx, levelId, { x: 4, y: 0 }, { x: 4, y: 3 })
    })
    doc.transact((tx) => connectIntersection(tx, findIntersections(doc.getSnapshot(), levelId)[0]!))
    const s1 = doc.getSnapshot()
    const right = Object.values(s1.walls).find((w) => s1.nodes[w.a]!.x === 4 && s1.nodes[w.b]!.x === 8)!
    const opening = doc.transact((tx) => addOpening(tx, right.id, { kind: 'window', typeId: 'window', offset: 2 }))
    const junction = findIntersections(s1, levelId).find((i) => i.kind === 'junction')!
    doc.transact((tx) => disconnectNode(tx, junction.nodeId!))
    expect(centreOf(doc.getSnapshot(), opening.id).x).toBeCloseTo(6)
  })
})

