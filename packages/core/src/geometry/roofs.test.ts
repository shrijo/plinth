import { describe, expect, it } from 'vitest'
import { PlinthDocument } from '../document.ts'
import { parseProject, serializeProject } from '../file.ts'
import { FLAT_ROOF, type Roof } from '../model.ts'
import { rotateBuilding, setRoof } from '../ops/buildings.ts'
import { analyzeSite } from './analysis.ts'
import type { MeshData } from './mesh.ts'
import { offsetRegion, roofGeometry, roofHeight } from './roofs.ts'
import type { MultiPolygon } from './regions.ts'
import { createBuilding } from '../ops/buildings.ts'

const rectangle = (w: number, d: number): MultiPolygon => [[[[0, 0], [w, 0], [w, d], [0, d]]]]
const pitched = (kind: Roof['kind'], extra: Partial<Roof> = {}): Roof => ({ ...FLAT_ROOF, kind, pitch: 45, overhang: 0, thickness: 0.2, direction: 0, ...extra })

/** Highest and lowest world height (y) of a mesh. */
function heights(mesh: MeshData): [number, number] {
  let low = Infinity
  let high = -Infinity
  for (let i = 1; i < mesh.positions.length; i += 3) {
    low = Math.min(low, mesh.positions[i]!)
    high = Math.max(high, mesh.positions[i]!)
  }
  return [low, high]
}
/** Plan x of every vertex of a mesh above a height. */
const xsAbove = (mesh: MeshData, y: number) => {
  const xs: number[] = []
  for (let i = 0; i < mesh.positions.length; i += 3) if (mesh.positions[i + 1]! > y + 1e-6) xs.push(Math.round(mesh.positions[i]! * 1000) / 1000)
  return [...new Set(xs)].sort((a, b) => a - b)
}

describe('roofs', () => {
  it('builds a gable over the middle, carrying the end walls up to it', () => {
    // 10 m along the ridge (east), 6 m across: a 45° roof rises 3 m.
    const geometry = roofGeometry(rectangle(10, 6), 9, pitched('gable'), 0.2)
    expect(geometry.height).toBeCloseTo(3)
    expect(heights(geometry.roof)[1]).toBeCloseTo(12)
    // The gable walls are at the two ends (x = 0 and x = 10, and the wall thickness in from them), not along the sides.
    expect(xsAbove(geometry.walls, 9.01)).toEqual([0, 0.2, 9.8, 10])
    expect(roofHeight(rectangle(10, 6), pitched('gable'))).toBeCloseTo(3)
  })

  it('turns the ridge with its direction', () => {
    const geometry = roofGeometry(rectangle(10, 6), 0, pitched('gable', { direction: 90 }), 0.2)
    expect(geometry.height).toBeCloseTo(5)
  })

  it('runs the ridge along the longest side when left to itself', () => {
    expect(roofHeight(rectangle(6, 10), pitched('gable', { direction: null }))).toBeCloseTo(3)
    expect(roofHeight(rectangle(10, 6), pitched('gable', { direction: null }))).toBeCloseTo(3)
  })

  it('builds a hip roof as high as a gable over a rectangle, with no walls carried up', () => {
    const geometry = roofGeometry(rectangle(10, 6), 0, pitched('hip'), 0.2)
    expect(geometry.height).toBeCloseTo(3)
    expect(geometry.walls.indices.length).toBe(0)
    expect(roofHeight(rectangle(10, 6), pitched('hip'))).toBeCloseTo(3)
  })

  it('drops the eaves below the top by the overhang', () => {
    const geometry = roofGeometry(rectangle(10, 6), 9, pitched('hip', { overhang: 0.5 }), 0.2)
    const [low, high] = heights(geometry.roof)
    expect(high).toBeCloseTo(12)
    // Eaves 0.5 m out at 45° are 0.5 m lower, and the underside a thickness below that.
    expect(low).toBeCloseTo(9 - 0.5 - 0.2 * Math.SQRT2, 4)
  })

  it('builds a shed roof falling its way, with the high wall carried up', () => {
    const geometry = roofGeometry(rectangle(10, 6), 0, pitched('shed', { direction: 270, pitch: 20 }), 0.2)
    expect(geometry.height).toBeCloseTo(6 * Math.tan((20 * Math.PI) / 180))
    expect(geometry.walls.indices.length).toBeGreaterThan(0)
  })

  it('gives a flat roof a parapet when asked', () => {
    const plain = roofGeometry(rectangle(10, 6), 9, FLAT_ROOF, 0.2)
    expect(plain.roof.indices.length + plain.walls.indices.length).toBe(0)
    const parapet = roofGeometry(rectangle(10, 6), 9, { ...FLAT_ROOF, parapet: 1 }, 0.2)
    expect(heights(parapet.walls)).toEqual([9, 10])
    expect(parapet.height).toBe(1)
  })

  it('rings a courtyard block with slopes, gable or hip', () => {
    const block: MultiPolygon = [[[[0, 0], [30, 0], [30, 30], [0, 30]], [[10, 10], [20, 10], [20, 20], [10, 20]]]]
    for (const kind of ['gable', 'hip'] as const) {
      const geometry = roofGeometry(block, 0, pitched(kind), 0.2)
      expect(geometry.height).toBeCloseTo(5)
      expect(geometry.roof.indices.length).toBeGreaterThan(0)
    }
  })

  it('grows and shrinks outlines with mitred corners', () => {
    const grown = offsetRegion(rectangle(10, 6), 1)
    const xs = grown[0]![0]!.map(([x]) => x)
    expect(Math.min(...xs)).toBeCloseTo(-1)
    expect(Math.max(...xs)).toBeCloseTo(11)
    expect(offsetRegion(rectangle(10, 6), -4)).toEqual([])
  })

  it('is kept with the building: saved, analysed, and turned with it', () => {
    const doc = PlinthDocument.createEmpty()
    const id = doc.transact((tx) => createBuilding(tx, [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 6 }, { x: 0, y: 6 }], { floors: 2, floorHeight: 3 }))!.id
    expect(analyzeSite(doc.getSnapshot()).buildings.get(id)!.roof).toEqual(FLAT_ROOF)
    doc.transact((tx) => setRoof(tx, id, pitched('gable', { direction: 0 })))
    expect(analyzeSite(doc.getSnapshot()).buildings.get(id)!.roof.kind).toBe('gable')
    doc.transact((tx) => rotateBuilding(tx, id, Math.PI / 2, { x: 5, y: 3 }))
    expect(doc.getSnapshot().buildings[id]!.roof!.direction).toBe(90)
    const file = parseProject(serializeProject(doc.getSnapshot()))
    expect(file.buildings[0]!.roof).toMatchObject({ kind: 'gable', direction: 90 })
    // A roof that makes no sense is dropped, not the building.
    const broken = JSON.parse(serializeProject(doc.getSnapshot()))
    broken.buildings[0].roof.pitch = 'steep'
    const repaired = parseProject(JSON.stringify(broken))
    expect(repaired.buildings).toHaveLength(1)
    expect(repaired.buildings[0]!.roof).toBeUndefined()
    doc.transact((tx) => setRoof(tx, id, null))
    expect(doc.getSnapshot().buildings[id]!.roof).toBeUndefined()
  })
})
