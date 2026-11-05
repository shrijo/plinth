import { describe, expect, it } from 'vitest'
import { PlinthDocument } from '../document.ts'
import { testSite } from '../test-helpers.ts'
import { sortedLevels } from '../model.ts'
import { analyzeSite } from '../geometry/analysis.ts'
import { addLevel, deleteLevel, detachLevel, setRepeatCount, updateLevel } from './levels.ts'
import { addOpening } from './openings.ts'
import { insertRectangle } from './walls.ts'

const setup = testSite

const stack = (doc: PlinthDocument) =>
  sortedLevels(doc.getSnapshot()).map((l) => [l.name, l.elevation, l.height, l.masterId ?? null])

describe('levels', () => {
  it('stacks a new level on top', () => {
    const { doc, buildingId } = setup()
    doc.transact((tx) => addLevel(tx, buildingId))
    doc.transact((tx) => addLevel(tx, buildingId))
    expect(stack(doc)).toEqual([
      ['Ground floor', 0, 3, null],
      ['Floor 1', 3, 3, null],
      ['Floor 2', 6, 3, null],
    ])
  })

  it('inserts a level between two others and moves the upper one up', () => {
    const { doc, groundId, buildingId } = setup()
    doc.transact((tx) => addLevel(tx, buildingId))
    doc.transact((tx) => addLevel(tx, buildingId, groundId, 'Mezzanine'))
    expect(stack(doc).map((l) => [l[0], l[1]])).toEqual([
      ['Ground floor', 0],
      ['Mezzanine', 3],
      ['Floor 1', 6],
    ])
  })

  it('moves the levels above when a height changes', () => {
    const { doc, groundId, buildingId } = setup()
    doc.transact((tx) => addLevel(tx, buildingId))
    doc.transact((tx) => updateLevel(tx, groundId, { height: 4.5 }))
    expect(stack(doc)[1]![1]).toBe(4.5)
  })

  it('only lets the lowest level set the elevation', () => {
    const { doc, groundId, buildingId } = setup()
    const upper = doc.transact((tx) => addLevel(tx, buildingId))
    doc.transact((tx) => updateLevel(tx, upper.id, { elevation: 10 }))
    expect(stack(doc)[1]![1]).toBe(3)
    doc.transact((tx) => updateLevel(tx, groundId, { elevation: -1 }))
    expect(stack(doc).map((l) => l[1])).toEqual([-1, 2])
  })

  it('repeats a master floor as one run of copies, and follows its height', () => {
    const { doc, buildingId } = setup()
    const first = doc.transact((tx) => addLevel(tx, buildingId))
    doc.transact((tx) => setRepeatCount(tx, first.id, 3))
    // One record for the three copies.
    expect(stack(doc).map((l) => [l[1], l[3]])).toEqual([
      [0, null],
      [3, null],
      [6, first.id],
    ])
    const floors = () =>
      analyzeSite(doc.getSnapshot()).levels.flatMap((l) =>
        Array.from({ length: l.floors }, (_, k) => [l.level.elevation + k * l.level.height, l.level.height]),
      )
    expect(floors()).toEqual([
      [0, 3],
      [3, 3],
      [6, 3],
      [9, 3],
      [12, 3],
    ])
    doc.transact((tx) => updateLevel(tx, first.id, { height: 3.5 }))
    expect(floors()).toEqual([
      [0, 3],
      [3, 3.5],
      [6.5, 3.5],
      [10, 3.5],
      [13.5, 3.5],
    ])
    doc.transact((tx) => setRepeatCount(tx, first.id, 1))
    expect(floors()).toHaveLength(3)
    doc.transact((tx) => setRepeatCount(tx, first.id, 0))
    expect(stack(doc)).toHaveLength(2)
  })

  it('detaches one floor of a run, leaving the rest a run above it', () => {
    const { doc, groundId } = setup()
    doc.transact((tx) => insertRectangle(tx, groundId, { x: 0, y: 0 }, { x: 6, y: 4 }))
    doc.transact((tx) => setRepeatCount(tx, groundId, 4))
    const run = sortedLevels(doc.getSnapshot())[1]!
    doc.transact((tx) => detachLevel(tx, run.id))
    expect(stack(doc).map((l) => [l[1], l[3]])).toEqual([
      [0, null],
      [3, null],
      [6, groundId],
    ])
    expect(analyzeSite(doc.getSnapshot()).levels.reduce((sum, l) => sum + l.floors, 0)).toBe(5)
  })

  it('gives a detached copy its own walls and openings', () => {
    const { doc, groundId } = setup()
    const walls = doc.transact((tx) => insertRectangle(tx, groundId, { x: 0, y: 0 }, { x: 6, y: 4 }))
    doc.transact((tx) => addOpening(tx, walls[0]!, { kind: 'door', typeId: 'door', offset: 2 }))
    doc.transact((tx) => setRepeatCount(tx, groundId, 1))
    const copy = sortedLevels(doc.getSnapshot())[1]!
    doc.transact((tx) => detachLevel(tx, copy.id))
    const s = doc.getSnapshot()
    expect(s.levels[copy.id]!.masterId).toBeNull()
    expect(Object.values(s.walls).filter((w) => w.levelId === copy.id)).toHaveLength(4)
    expect(Object.values(s.nodes).filter((n) => n.levelId === copy.id)).toHaveLength(4)
    expect(Object.values(s.openings)).toHaveLength(2)
  })

  it('detaches the copies of a deleted master', () => {
    const { doc, groundId } = setup()
    doc.transact((tx) => insertRectangle(tx, groundId, { x: 0, y: 0 }, { x: 6, y: 4 }))
    doc.transact((tx) => setRepeatCount(tx, groundId, 2))
    doc.transact((tx) => deleteLevel(tx, groundId))
    const s = doc.getSnapshot()
    expect(stack(doc).map((l) => [l[1], l[3]])).toEqual([
      [0, null],
      [3, null],
    ])
    expect(Object.keys(s.walls)).toHaveLength(8)
  })

  it('keeps the last level', () => {
    const { doc, groundId } = setup()
    expect(doc.transact((tx) => deleteLevel(tx, groundId))).toBe(false)
    expect(stack(doc)).toHaveLength(1)
  })
})
