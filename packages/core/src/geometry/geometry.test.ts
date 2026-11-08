import { describe, expect, it } from 'vitest'
import { signedArea2, type Vec2 } from '../math.ts'
import type { Wall, WallNode } from '../model.ts'
import { computeFootprints } from './footprint.ts'
import { buildSlabMesh, buildWallMesh, placeOpening } from './mesh.ts'

function graph(points: Record<string, [number, number]>, edges: [string, string][]) {
  const nodes: Record<string, WallNode> = {}
  for (const [id, [x, y]] of Object.entries(points)) nodes[id] = { id, levelId: 'L', x, y }
  const walls: Wall[] = edges.map(([a, b], i) => ({
    id: `w${i}`,
    levelId: 'L',
    a,
    b,
    thickness: null,
    height: null,
    heightEnd: null,
  }))
  return { nodes, walls }
}

const area = (polygon: Vec2[]) => signedArea2(polygon) / 2
const has = (polygon: Vec2[], x: number, y: number) =>
  polygon.some((p) => Math.abs(p.x - x) < 1e-9 && Math.abs(p.y - y) < 1e-9)

describe('computeFootprints', () => {
  it('gives a lone wall a rectangle', () => {
    const { nodes, walls } = graph({ a: [0, 0], b: [4, 0] }, [['a', 'b']])
    const fp = computeFootprints(nodes, walls, () => 0.2).get('w0')!
    expect(fp.polygon).toHaveLength(4)
    expect(area(fp.polygon)).toBeCloseTo(0.8)
  })

  it('mitres an L corner so the walls share their corner points', () => {
    const { nodes, walls } = graph(
      { a: [0, 0], b: [4, 0], c: [4, 3] },
      [
        ['a', 'b'],
        ['b', 'c'],
      ],
    )
    const fps = computeFootprints(nodes, walls, () => 0.2)
    const w0 = fps.get('w0')!.polygon
    const w1 = fps.get('w1')!.polygon
    // Outer corner (4.1, -0.1) and inner corner (3.9, 0.1) belong to both walls.
    for (const poly of [w0, w1]) {
      expect(has(poly, 4.1, -0.1)).toBe(true)
      expect(has(poly, 3.9, 0.1)).toBe(true)
      expect(area(poly)).toBeGreaterThan(0)
    }
    // Together they cover the corner exactly once: total area = centre-line length × thickness.
    expect(area(w0) + area(w1)).toBeCloseTo((4 + 3) * 0.2)
  })

  it('stops the branch of a T at the face of the through wall', () => {
    const { nodes, walls } = graph(
      { a: [0, 0], m: [2, 0], b: [4, 0], c: [2, 3] },
      [
        ['a', 'm'],
        ['m', 'b'],
        ['m', 'c'],
      ],
    )
    const fps = computeFootprints(nodes, walls, () => 0.2)
    const branch = fps.get('w2')!.polygon
    expect(has(branch, 1.9, 0.1)).toBe(true)
    expect(has(branch, 2.1, 0.1)).toBe(true)
    const total = [...fps.values()].reduce((sum, fp) => sum + area(fp.polygon), 0)
    // Through wall 4 × 0.2, plus the branch from the through wall's face: 2.9 × 0.2.
    expect(total).toBeCloseTo(4 * 0.2 + 2.9 * 0.2)
  })

  it('falls back to a rectangle when a wall is too short for its mitres', () => {
    const { nodes, walls } = graph(
      { a: [0, 0], b: [0.05, 0], c: [0.05, 3], d: [0, -3] },
      [
        ['a', 'b'],
        ['b', 'c'],
        ['a', 'd'],
      ],
    )
    const fp = computeFootprints(nodes, walls, () => 0.4).get('w0')!
    expect(area(fp.polygon)).toBeGreaterThan(0)
  })
})

describe('buildWallMesh', () => {
  it('builds a closed box for a lone wall', () => {
    const { nodes, walls } = graph({ a: [0, 0], b: [4, 0] }, [['a', 'b']])
    const fp = computeFootprints(nodes, walls, () => 0.2).get('w0')!
    const mesh = buildWallMesh(fp, 0, 3, 3)
    // 2 caps × 2 triangles + 4 sides × 2 triangles.
    expect(mesh.indices.length / 3).toBe(12)
    const ys = [...mesh.positions].filter((_, i) => i % 3 === 1)
    expect(Math.max(...ys)).toBeCloseTo(3)
    expect(Math.min(...ys)).toBeCloseTo(0)
  })

  it('winds every triangle to face along its normal', () => {
    const { nodes, walls } = graph(
      { a: [0, 0], b: [4, 0], c: [4, 3] },
      [
        ['a', 'b'],
        ['b', 'c'],
      ],
    )
    const fp = computeFootprints(nodes, walls, () => 0.2).get('w0')!
    const { positions, normals, indices } = buildWallMesh(fp, 1, 2, 4)
    for (let i = 0; i < indices.length; i += 3) {
      const [p, q, r] = [indices[i]!, indices[i + 1]!, indices[i + 2]!].map((k) => [
        positions[k * 3]!,
        positions[k * 3 + 1]!,
        positions[k * 3 + 2]!,
      ]) as [number[], number[], number[]]
      const e1 = [q[0]! - p[0]!, q[1]! - p[1]!, q[2]! - p[2]!]
      const e2 = [r[0]! - p[0]!, r[1]! - p[1]!, r[2]! - p[2]!]
      const n = [
        e1[1]! * e2[2]! - e1[2]! * e2[1]!,
        e1[2]! * e2[0]! - e1[0]! * e2[2]!,
        e1[0]! * e2[1]! - e1[1]! * e2[0]!,
      ]
      const k = indices[i]! * 3
      const facing = n[0]! * normals[k]! + n[1]! * normals[k + 1]! + n[2]! * normals[k + 2]!
      expect(facing).toBeGreaterThan(0)
    }
  })
})

/** Checks that every triangle winds to face along its vertex normal. */
function expectOutwardWinding({ positions, normals, indices }: ReturnType<typeof buildWallMesh>) {
  for (let i = 0; i < indices.length; i += 3) {
    const [p, q, r] = [indices[i]!, indices[i + 1]!, indices[i + 2]!].map((k) => [
      positions[k * 3]!,
      positions[k * 3 + 1]!,
      positions[k * 3 + 2]!,
    ]) as [number[], number[], number[]]
    const e1 = [q[0]! - p[0]!, q[1]! - p[1]!, q[2]! - p[2]!]
    const e2 = [r[0]! - p[0]!, r[1]! - p[1]!, r[2]! - p[2]!]
    const n = [
      e1[1]! * e2[2]! - e1[2]! * e2[1]!,
      e1[2]! * e2[0]! - e1[0]! * e2[2]!,
      e1[0]! * e2[1]! - e1[1]! * e2[0]!,
    ]
    const k = indices[i]! * 3
    expect(n[0]! * normals[k]! + n[1]! * normals[k + 1]! + n[2]! * normals[k + 2]!).toBeGreaterThan(0)
  }
}

/** Total area of triangles whose normal points along +z (world), i.e. the wall's right face here. */
function faceArea({ positions, normals, indices }: ReturnType<typeof buildWallMesh>, axis: number, sign: number) {
  let area = 0
  for (let i = 0; i < indices.length; i += 3) {
    const k = indices[i]! * 3
    if (Math.sign(normals[k + axis]!) !== sign || Math.abs(normals[k + axis]!) < 0.99) continue
    const [p, q, r] = [indices[i]!, indices[i + 1]!, indices[i + 2]!].map((j) => [
      positions[j * 3]!,
      positions[j * 3 + 1]!,
      positions[j * 3 + 2]!,
    ]) as [number[], number[], number[]]
    const e1 = [q[0]! - p[0]!, q[1]! - p[1]!, q[2]! - p[2]!]
    const e2 = [r[0]! - p[0]!, r[1]! - p[1]!, r[2]! - p[2]!]
    area += Math.hypot(e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!) / 2
  }
  return area
}

describe('openings in walls', () => {
  const { nodes, walls } = graph({ a: [0, 0], b: [5, 0] }, [['a', 'b']])
  const fp = computeFootprints(nodes, walls, () => 0.2).get('w0')!

  it('cuts a window out of both faces and adds reveals', () => {
    const cut = placeOpening(fp, { offset: 2.5, width: 1.2, height: 1.4, sill: 0.9 }, 3, 3)!
    expect(cut.start).toBeCloseTo(1.9)
    expect(cut.end).toBeCloseTo(3.1)
    expect(cut.sill).toBeCloseTo(0.9)
    expect(cut.head).toBeCloseTo(2.3)
    const mesh = buildWallMesh(fp, 0, 3, 3, [cut])
    expectOutwardWinding(mesh)
    // The right face (seen from a) faces world +z: 5 × 3 minus the 1.2 × 1.4 window.
    expect(faceArea(mesh, 2, 1)).toBeCloseTo(5 * 3 - 1.2 * 1.4)
    expect(faceArea(mesh, 2, -1)).toBeCloseTo(5 * 3 - 1.2 * 1.4)
    // Sill faces up next to the top face; head faces down next to the bottom.
    expect(faceArea(mesh, 1, 1)).toBeCloseTo(5 * 0.2 + 1.2 * 0.2)
    expect(faceArea(mesh, 1, -1)).toBeCloseTo(5 * 0.2 + 1.2 * 0.2)
  })

  it('cuts a door as a notch in the bottom edge', () => {
    const cut = placeOpening(fp, { offset: 1, width: 0.9, height: 2.1, sill: 0 }, 3, 3)!
    const mesh = buildWallMesh(fp, 0, 3, 3, [cut])
    expectOutwardWinding(mesh)
    expect(faceArea(mesh, 2, 1)).toBeCloseTo(5 * 3 - 0.9 * 2.1)
  })

  it('keeps an opening on the straight part of the wall', () => {
    const cut = placeOpening(fp, { offset: 0.1, width: 1, height: 1, sill: 1 }, 3, 3)!
    expect(cut.start).toBeCloseTo(0.02)
    expect(placeOpening(fp, { offset: 2.5, width: 6, height: 1, sill: 1 }, 3, 3)).toBeNull()
  })

  it('leaves a lintel under a low wall top', () => {
    const cut = placeOpening(fp, { offset: 2.5, width: 1, height: 2.5, sill: 0 }, 2.2, 2.2)!
    expect(cut.head).toBeCloseTo(2.15)
  })
})

describe('buildSlabMesh', () => {
  it('builds a slab with a hole', () => {
    const outer: [number, number][] = [[0, 0], [4, 0], [4, 4], [0, 4]]
    const hole: [number, number][] = [[1, 1], [1, 3], [3, 3], [3, 1]]
    const mesh = buildSlabMesh([[outer, hole]], -0.25, 0)
    expectOutwardWinding(mesh)
    expect(faceArea(mesh, 1, 1)).toBeCloseTo(16 - 4)
  })
})

describe('walls that touch another wall without joining it', () => {
  it('keeps a corner sitting on a wall from poking out of its far side', () => {
    // A thin wall along y = 0, and a thicker V whose point sits on its centre line.
    const { nodes, walls } = graph(
      { a: [0, 0], b: [6, 0], p: [2, 3], v: [3, 0], q: [4, 3] },
      [
        ['a', 'b'],
        ['p', 'v'],
        ['v', 'q'],
      ],
    )
    const fps = computeFootprints(nodes, walls, (w) => (w.id === 'w0' ? 0.2 : 0.4))
    for (const id of ['w1', 'w2']) {
      const fp = fps.get(id)!
      expect(Math.min(...fp.polygon.map((p) => p.y))).toBeGreaterThanOrEqual(-1e-9)
      expect(fp.clearEnd).toBeGreaterThan(fp.clearStart)
    }
  })

  it('trims a square end that reaches past the centre line', () => {
    const { nodes, walls } = graph(
      { a: [0, 0], b: [6, 0], p: [3, 3], e: [3, -0.08] },
      [
        ['a', 'b'],
        ['p', 'e'],
      ],
    )
    const fp = computeFootprints(nodes, walls, () => 0.2).get('w1')!
    expect(Math.min(...fp.polygon.map((p) => p.y))).toBeCloseTo(0)
  })

  it('leaves a wall that stops before the other wall alone', () => {
    const { nodes, walls } = graph(
      { a: [0, 0], b: [6, 0], p: [3, 3], e: [3, 0.5] },
      [
        ['a', 'b'],
        ['p', 'e'],
      ],
    )
    const fp = computeFootprints(nodes, walls, () => 0.2).get('w1')!
    expect(fp.polygon).toHaveLength(4)
  })
})

