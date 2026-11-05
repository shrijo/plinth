import { describe, expect, it } from 'vitest'
import { PlinthDocument } from '../document.ts'
import { testSite } from '../test-helpers.ts'
import { dist, type Vec2 } from '../math.ts'
import type { Snapshot, Wall } from '../model.ts'
import { connectIntersection, disconnectNode, findIntersections } from './intersections.ts'
import {
  deleteWalls,
  finishNodeMove,
  insertPolyline,
  insertRectangle,
  insertWall,
  moveNodes,
  removeNode,
  setWallProps,
} from './walls.ts'

const setup = testSite

/** Walls as sorted coordinate pairs, for comparing shapes regardless of IDs. */
function shape(s: Snapshot): string[] {
  const fmt = (p: Vec2) => `${round(p.x)},${round(p.y)}`
  return Object.values(s.walls)
    .map((w) => [fmt(s.nodes[w.a]!), fmt(s.nodes[w.b]!)].sort().join(' – '))
    .sort()
}
const round = (n: number) => Math.round(n * 1000) / 1000 + 0

function degree(s: Snapshot, p: Vec2): number {
  const node = Object.values(s.nodes).find((n) => dist(n, p) < 1e-6)
  if (!node) return 0
  return Object.values(s.walls).filter((w) => w.a === node.id || w.b === node.id).length
}

describe('insertWall', () => {
  it('adds a single wall with two nodes', () => {
    const { doc, levelId } = setup()
    const ids = doc.transact((tx) => insertWall(tx, levelId, { x: 0, y: 0 }, { x: 4, y: 0 }))
    const s = doc.getSnapshot()
    expect(ids).toHaveLength(1)
    expect(Object.keys(s.nodes)).toHaveLength(2)
    expect(shape(s)).toEqual(['0,0 – 4,0'])
  })

  it('ignores walls that are too short', () => {
    const { doc, levelId } = setup()
    const ids = doc.transact((tx) => insertWall(tx, levelId, { x: 0, y: 0 }, { x: 0.001, y: 0 }))
    expect(ids).toEqual([])
    expect(Object.keys(doc.getSnapshot().walls)).toHaveLength(0)
  })

  it('reuses an existing node at an end', () => {
    const { doc, levelId } = setup()
    doc.transact((tx) => {
      insertWall(tx, levelId, { x: 0, y: 0 }, { x: 4, y: 0 })
      insertWall(tx, levelId, { x: 4, y: 0 }, { x: 4, y: 3 })
    })
    const s = doc.getSnapshot()
    expect(Object.keys(s.nodes)).toHaveLength(3)
    expect(degree(s, { x: 4, y: 0 })).toBe(2)
  })

  it('leaves a wall that starts partway along another wall separate (T)', () => {
    const { doc, levelId } = setup()
    doc.transact((tx) => {
      insertWall(tx, levelId, { x: 0, y: 0 }, { x: 4, y: 0 })
      insertWall(tx, levelId, { x: 2, y: 0 }, { x: 2, y: 3 })
    })
    const s = doc.getSnapshot()
    expect(shape(s)).toEqual(['0,0 – 4,0', '2,0 – 2,3'])
    expect(findIntersections(s, levelId).map((i) => i.kind)).toEqual(['touch'])
  })

  it('joins a T when connected, and separates it again', () => {
    const { doc, levelId } = setup()
    doc.transact((tx) => {
      insertWall(tx, levelId, { x: 0, y: 0 }, { x: 4, y: 0 })
      insertWall(tx, levelId, { x: 2, y: 0 }, { x: 2, y: 3 })
    })
    const touch = findIntersections(doc.getSnapshot(), levelId)[0]!
    doc.transact((tx) => connectIntersection(tx, touch))
    let s = doc.getSnapshot()
    expect(shape(s)).toEqual(['0,0 – 2,0', '2,0 – 2,3', '2,0 – 4,0'])
    expect(degree(s, { x: 2, y: 0 })).toBe(3)
    const junction = findIntersections(s, levelId).find((i) => i.kind === 'junction')!
    expect(junction.point).toEqual({ x: 2, y: 0 })
    doc.transact((tx) => disconnectNode(tx, junction.nodeId!))
    s = doc.getSnapshot()
    expect(shape(s)).toEqual(['0,0 – 4,0', '2,0 – 2,3'])
  })

  it('leaves crossing walls separate until connected', () => {
    const { doc, levelId } = setup()
    doc.transact((tx) => {
      insertWall(tx, levelId, { x: 0, y: 0 }, { x: 4, y: 0 })
      insertWall(tx, levelId, { x: 2, y: -2 }, { x: 2, y: 2 })
    })
    const crossing = findIntersections(doc.getSnapshot(), levelId)
    expect(crossing.map((i) => [i.kind, i.point])).toEqual([['crossing', { x: 2, y: 0 }]])
    doc.transact((tx) => connectIntersection(tx, crossing[0]!))
    const s = doc.getSnapshot()
    expect(shape(s)).toEqual(['0,0 – 2,0', '2,-2 – 2,0', '2,0 – 2,2', '2,0 – 4,0'])
    expect(degree(s, { x: 2, y: 0 })).toBe(4)
    // Separating an X makes two whole walls again, with no node left behind.
    const node = findIntersections(s, levelId).find((i) => i.kind === 'junction')!.nodeId!
    doc.transact((tx) => disconnectNode(tx, node))
    expect(shape(doc.getSnapshot())).toEqual(['0,0 – 4,0', '2,-2 – 2,2'])
    expect(Object.keys(doc.getSnapshot().nodes)).toHaveLength(4)
  })

  it('reports a corner sitting on a wall as one touch', () => {
    const { doc, levelId } = setup()
    doc.transact((tx) => {
      insertWall(tx, levelId, { x: 0, y: 0 }, { x: 6, y: 0 })
      insertPolyline(tx, levelId, [{ x: 1, y: 2 }, { x: 3, y: 0 }, { x: 5, y: 2 }], false)
    })
    const touches = findIntersections(doc.getSnapshot(), levelId)
    expect(touches).toHaveLength(1)
    expect(touches[0]!.wallIds).toHaveLength(3)
    doc.transact((tx) => connectIntersection(tx, touches[0]!))
    expect(degree(doc.getSnapshot(), { x: 3, y: 0 })).toBe(4)
  })

  it('finds every crossing of a long wall', () => {
    const { doc, levelId } = setup()
    doc.transact((tx) => {
      insertWall(tx, levelId, { x: 1, y: -1 }, { x: 1, y: 1 })
      insertWall(tx, levelId, { x: 2, y: -1 }, { x: 2, y: 1 })
      insertWall(tx, levelId, { x: 3, y: -1 }, { x: 3, y: 1 })
      insertWall(tx, levelId, { x: 0, y: 0 }, { x: 4, y: 0 })
    })
    const s = doc.getSnapshot()
    expect(Object.keys(s.walls)).toHaveLength(4)
    expect(findIntersections(s, levelId).filter((i) => i.kind === 'crossing')).toHaveLength(3)
  })

  it('does not duplicate a wall drawn over an existing one', () => {
    const { doc, levelId } = setup()
    doc.transact((tx) => {
      insertWall(tx, levelId, { x: 0, y: 0 }, { x: 4, y: 0 })
      insertWall(tx, levelId, { x: 4, y: 0 }, { x: 0, y: 0 })
    })
    expect(shape(doc.getSnapshot())).toEqual(['0,0 – 4,0'])
  })

  it('keeps walls on different levels apart', () => {
    const { doc, levelId } = setup()
    doc.transact((tx) => {
      tx.putLevel({ id: 'upper', buildingId: doc.getSnapshot().levels[levelId]!.buildingId, name: 'First floor', elevation: 3, height: 3 })
      insertWall(tx, levelId, { x: 0, y: 0 }, { x: 4, y: 0 })
      insertWall(tx, 'upper', { x: 2, y: -2 }, { x: 2, y: 2 })
    })
    expect(Object.keys(doc.getSnapshot().walls)).toHaveLength(2)
  })

  it('interpolates heights when a T connects to a sloped wall', () => {
    const { doc, levelId } = setup()
    doc.transact((tx) => {
      insertWall(tx, levelId, { x: 0, y: 0 }, { x: 4, y: 0 }, { height: 2, heightEnd: 4 })
      insertWall(tx, levelId, { x: 1, y: 0 }, { x: 1, y: 2 })
    })
    doc.transact((tx) => connectIntersection(tx, findIntersections(doc.getSnapshot(), levelId)[0]!))
    const s = doc.getSnapshot()
    const sloped = Object.values(s.walls).filter((w) => w.heightEnd !== null)
    const heights = sloped
      .map((w: Wall) => [w.height, w.heightEnd])
      .sort((p, q) => (p[0] ?? 0) - (q[0] ?? 0))
    expect(heights).toEqual([
      [2, 2.5],
      [2.5, 4],
    ])
  })
})

describe('insertPolyline and insertRectangle', () => {
  it('closes a polyline back to its start', () => {
    const { doc, levelId } = setup()
    doc.transact((tx) =>
      insertPolyline(tx, levelId, [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }], true),
    )
    const s = doc.getSnapshot()
    expect(Object.keys(s.walls)).toHaveLength(3)
    expect(Object.keys(s.nodes)).toHaveLength(3)
  })

  it('draws a rectangle as four walls', () => {
    const { doc, levelId } = setup()
    doc.transact((tx) => insertRectangle(tx, levelId, { x: 4, y: 3 }, { x: 0, y: 0 }))
    expect(shape(doc.getSnapshot())).toEqual(['0,0 – 0,3', '0,0 – 4,0', '0,3 – 4,3', '4,0 – 4,3'])
  })
})

describe('deleteWalls', () => {
  it('removes nodes left without walls', () => {
    const { doc, levelId } = setup()
    const [id] = doc.transact((tx) => insertWall(tx, levelId, { x: 0, y: 0 }, { x: 4, y: 0 }))
    doc.transact((tx) => deleteWalls(tx, [id!]))
    const s = doc.getSnapshot()
    expect(Object.keys(s.walls)).toHaveLength(0)
    expect(Object.keys(s.nodes)).toHaveLength(0)
  })

  it('heals a straight joint after removing the branch of a connected T', () => {
    const { doc, levelId } = setup()
    const branch = doc.transact((tx) => {
      insertWall(tx, levelId, { x: 0, y: 0 }, { x: 4, y: 0 })
      return insertWall(tx, levelId, { x: 2, y: 0 }, { x: 2, y: 3 })
    })
    doc.transact((tx) => connectIntersection(tx, findIntersections(doc.getSnapshot(), levelId)[0]!))
    expect(Object.keys(doc.getSnapshot().walls)).toHaveLength(3)
    doc.transact((tx) => deleteWalls(tx, branch))
    const s = doc.getSnapshot()
    expect(shape(s)).toEqual(['0,0 – 4,0'])
    expect(Object.keys(s.nodes)).toHaveLength(2)
  })

  it('keeps a joint when the walls differ in thickness', () => {
    const { doc, levelId } = setup()
    const branch = doc.transact((tx) => {
      insertWall(tx, levelId, { x: 0, y: 0 }, { x: 2, y: 0 }, { thickness: 0.3 })
      insertWall(tx, levelId, { x: 2, y: 0 }, { x: 4, y: 0 })
      return insertWall(tx, levelId, { x: 2, y: 0 }, { x: 2, y: 3 })
    })
    doc.transact((tx) => deleteWalls(tx, branch))
    expect(Object.keys(doc.getSnapshot().walls)).toHaveLength(2)
  })
})

describe('moving nodes', () => {
  it('joins a node dropped onto another node', () => {
    const { doc, levelId } = setup()
    doc.transact((tx) => {
      insertWall(tx, levelId, { x: 0, y: 0 }, { x: 4, y: 0 })
      insertWall(tx, levelId, { x: 4, y: 1 }, { x: 4, y: 3 })
    })
    const moving = Object.values(doc.getSnapshot().nodes).find((n) => n.x === 4 && n.y === 1)!
    doc.transact((tx) => {
      moveNodes(tx, new Map([[moving.id, { x: 4, y: 0 }]]))
      finishNodeMove(tx, [moving.id])
    })
    const s = doc.getSnapshot()
    expect(Object.keys(s.nodes)).toHaveLength(3)
    expect(degree(s, { x: 4, y: 0 })).toBe(2)
  })

  it('leaves walls that a moved wall now crosses separate', () => {
    const { doc, levelId } = setup()
    doc.transact((tx) => {
      insertWall(tx, levelId, { x: 0, y: 0 }, { x: 4, y: 0 })
      insertWall(tx, levelId, { x: 2, y: 1 }, { x: 2, y: 3 })
    })
    const moving = Object.values(doc.getSnapshot().nodes).find((n) => n.x === 2 && n.y === 1)!
    doc.transact((tx) => {
      moveNodes(tx, new Map([[moving.id, { x: 2, y: -1 }]]))
      finishNodeMove(tx, [moving.id])
    })
    const s = doc.getSnapshot()
    expect(Object.keys(s.walls)).toHaveLength(2)
    expect(findIntersections(s, levelId).map((i) => i.kind)).toEqual(['crossing'])
  })
})

describe('undo', () => {
  it('undoes and redoes one operation as one step', () => {
    const { doc, levelId } = setup()
    doc.transact((tx) => insertRectangle(tx, levelId, { x: 0, y: 0 }, { x: 4, y: 3 }))
    doc.transact((tx) => insertWall(tx, levelId, { x: 2, y: 0 }, { x: 2, y: 3 }))
    expect(Object.keys(doc.getSnapshot().walls)).toHaveLength(5)
    doc.undo()
    expect(Object.keys(doc.getSnapshot().walls)).toHaveLength(4)
    doc.undo()
    expect(Object.keys(doc.getSnapshot().walls)).toHaveLength(0)
    expect(doc.getHistory()).toEqual({ canUndo: false, canRedo: true })
    doc.redo()
    expect(Object.keys(doc.getSnapshot().walls)).toHaveLength(4)
  })

  it('merges a gesture into one undo step', () => {
    const { doc, levelId } = setup()
    doc.transact((tx) => insertWall(tx, levelId, { x: 0, y: 0 }, { x: 4, y: 0 }))
    const node = Object.values(doc.getSnapshot().nodes).find((n) => n.x === 4)!
    for (let i = 1; i <= 5; i++) {
      doc.transact((tx) => moveNodes(tx, new Map([[node.id, { x: 4 + i, y: 0 }]])), { merge: i > 1 })
    }
    expect(doc.getSnapshot().nodes[node.id]!.x).toBe(9)
    doc.undo()
    expect(doc.getSnapshot().nodes[node.id]!.x).toBe(4)
  })

  it('does not undo setting up a new project', () => {
    expect(PlinthDocument.createEmpty().getHistory().canUndo).toBe(false)
  })
})

describe('setWallProps', () => {
  it('keeps unchanged records identical in the snapshot', () => {
    const { doc, levelId } = setup()
    const [w1] = doc.transact((tx) => insertWall(tx, levelId, { x: 0, y: 0 }, { x: 4, y: 0 }))
    const [w2] = doc.transact((tx) => insertWall(tx, levelId, { x: 0, y: 2 }, { x: 4, y: 2 }))
    const before = doc.getSnapshot()
    doc.transact((tx) => setWallProps(tx, [w1!], { thickness: 0.35 }))
    const after = doc.getSnapshot()
    expect(after.walls[w1!]!.thickness).toBe(0.35)
    expect(after.walls[w2!]).toBe(before.walls[w2!])
    expect(after.nodes).toBe(before.nodes)
  })
})

describe('removeNode', () => {
  const nodeAt = (s: Snapshot, x: number, y: number) => Object.values(s.nodes).find((n) => n.x === x && n.y === y)!

  it('joins the walls on either side of a removed point', () => {
    const { doc, levelId } = setup()
    doc.transact((tx) => insertPolyline(tx, levelId, [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }], false))
    doc.transact((tx) => removeNode(tx, nodeAt(doc.getSnapshot(), 4, 0).id))
    expect(shape(doc.getSnapshot())).toEqual(['0,0 – 4,3'])
  })

  it('turns a rectangle into a triangle', () => {
    const { doc, levelId } = setup()
    doc.transact((tx) => insertRectangle(tx, levelId, { x: 0, y: 0 }, { x: 4, y: 3 }))
    doc.transact((tx) => removeNode(tx, nodeAt(doc.getSnapshot(), 4, 3).id))
    expect(shape(doc.getSnapshot())).toEqual(['0,0 – 0,3', '0,0 – 4,0', '0,3 – 4,0'])
  })

  it('removes the wall with a point at its end', () => {
    const { doc, levelId } = setup()
    doc.transact((tx) => insertPolyline(tx, levelId, [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }], false))
    doc.transact((tx) => removeNode(tx, nodeAt(doc.getSnapshot(), 4, 3).id))
    expect(shape(doc.getSnapshot())).toEqual(['0,0 – 4,0'])
    expect(Object.keys(doc.getSnapshot().nodes)).toHaveLength(2)
  })

  it('keeps an opening on the joined wall', () => {
    const { doc, levelId } = setup()
    const walls = doc.transact((tx) => insertPolyline(tx, levelId, [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 8, y: 0 }], false))
    const second = walls.find((id) => doc.getSnapshot().nodes[doc.getSnapshot().walls[id]!.b]!.x === 8)!
    doc.transact((tx) => tx.putOpening({ id: 'o', wallId: second, kind: 'window', typeId: 'window', offset: 2, width: 1, height: 1, sill: 1 }))
    doc.transact((tx) => removeNode(tx, nodeAt(doc.getSnapshot(), 4, 0).id))
    const s = doc.getSnapshot()
    const opening = s.openings.o!
    const wall = s.walls[opening.wallId]!
    expect(Object.keys(s.walls)).toHaveLength(1)
    expect(s.nodes[wall.a]!.x + opening.offset).toBeCloseTo(6)
  })
})

