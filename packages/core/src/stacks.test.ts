import { describe, expect, it } from 'vitest'
import { testSite } from './test-helpers.ts'
import { addLevel, setRepeatCount } from './ops/levels.ts'
import { insertRectangle, insertWall } from './ops/walls.ts'
import { findStacks } from './stacks.ts'

const setup = testSite

describe('findStacks', () => {
  it('lines up walls and points with the same position on different floors', () => {
    const { doc, groundId, buildingId } = setup()
    doc.transact((tx) => insertRectangle(tx, groundId, { x: 0, y: 0 }, { x: 6, y: 4 }))
    const first = doc.transact((tx) => addLevel(tx, buildingId))
    // Drawn the other way round on the upper floor: still the same walls.
    doc.transact((tx) => insertRectangle(tx, first.id, { x: 6, y: 4 }, { x: 0, y: 0 }))
    doc.transact((tx) => insertWall(tx, first.id, { x: 3, y: 0 }, { x: 3, y: 4 }))
    const s = doc.getSnapshot()
    const stacks = findStacks(s)

    const groundWall = Object.values(s.walls).find((w) => w.levelId === groundId)!
    const stack = stacks.walls.get(groundWall.id)!
    expect(stack).toHaveLength(2)
    expect(stack[0]).toBe(groundWall.id)

    const corner = Object.values(s.nodes).find((n) => n.levelId === groundId && n.x === 6 && n.y === 4)!
    expect(stacks.nodes.get(corner.id)).toHaveLength(2)

    const partition = Object.values(s.walls).find((w) => s.nodes[w.a]!.x === 3 && s.nodes[w.b]!.x === 3)!
    expect(stacks.walls.get(partition.id)).toEqual([partition.id])
  })

  it('leaves copies out', () => {
    const { doc, groundId } = setup()
    doc.transact((tx) => insertRectangle(tx, groundId, { x: 0, y: 0 }, { x: 6, y: 4 }))
    doc.transact((tx) => setRepeatCount(tx, groundId, 2))
    const stacks = findStacks(doc.getSnapshot())
    for (const ids of stacks.walls.values()) expect(ids).toHaveLength(1)
  })
})
