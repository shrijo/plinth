import { describe, expect, it } from 'vitest'
import { PlinthDocument } from '../document.ts'
import { buildExampleCity } from '../examples/exampleCity.ts'
import { analyzeSite } from './analysis.ts'
import type { PolygonRings } from './regions.ts'
import { straightSkeleton } from './skeleton.ts'

const ring = (...points: [number, number][]) => points
const highest = (faces: NonNullable<ReturnType<typeof straightSkeleton>>) => Math.max(...faces.flatMap((f) => f.points.map((p) => p.t)))

describe('straight skeleton', () => {
  it('makes a hip roof of a rectangle: two trapezoids, two triangles, a ridge down the middle', () => {
    const faces = straightSkeleton([ring([0, 0], [10, 0], [10, 6], [0, 6])])!
    expect(faces).toHaveLength(4)
    expect(highest(faces)).toBeCloseTo(3)
    expect(faces.map((f) => f.points.length).sort()).toEqual([3, 3, 4, 4])
    const ridge = faces.flatMap((f) => f.points).filter((p) => Math.abs(p.t - 3) < 1e-6)
    expect(Math.min(...ridge.map((p) => p.x))).toBeCloseTo(3)
    expect(Math.max(...ridge.map((p) => p.x))).toBeCloseTo(7)
  })

  it('brings a square to a point', () => {
    const faces = straightSkeleton([ring([0, 0], [4, 0], [4, 4], [0, 4])])!
    expect(faces).toHaveLength(4)
    for (const face of faces) expect(face.points).toHaveLength(3)
    expect(highest(faces)).toBeCloseTo(2)
  })

  it('handles an L, with a valley at the inside corner', () => {
    const faces = straightSkeleton([ring([0, 0], [12, 0], [12, 4], [4, 4], [4, 10], [0, 10])])!
    expect(faces).toHaveLength(6)
    expect(highest(faces)).toBeCloseTo(2)
    // The valley runs from the inside corner (4, 4) in towards (2, 2).
    const inside = faces.flatMap((f) => f.points).find((p) => Math.abs(p.x - 4) < 1e-6 && Math.abs(p.y - 4) < 1e-6)
    expect(inside?.t).toBeCloseTo(0)
  })

  it('handles a T, a U and a cross', () => {
    const shapes: PolygonRings[] = [
      [ring([0, 0], [12, 0], [12, 4], [8, 4], [8, 12], [4, 12], [4, 4], [0, 4])],
      [ring([0, 0], [12, 0], [12, 10], [8, 10], [8, 4], [4, 4], [4, 10], [0, 10])],
      [ring([4, 0], [8, 0], [8, 4], [12, 4], [12, 8], [8, 8], [8, 12], [4, 12], [4, 8], [0, 8], [0, 4], [4, 4])],
    ]
    for (const shape of shapes) {
      const faces = straightSkeleton(shape)
      expect(faces).not.toBeNull()
      expect(highest(faces!)).toBeCloseTo(2)
    }
  })

  it('handles a courtyard block (a ring with a hole)', () => {
    const faces = straightSkeleton([ring([0, 0], [30, 0], [30, 30], [0, 30]), ring([10, 10], [20, 10], [20, 20], [10, 20])])!
    expect(faces).toHaveLength(8)
    expect(highest(faces)).toBeCloseTo(5)
  })

  it('handles slanted and irregular outlines', () => {
    const shapes: PolygonRings[] = [
      [ring([0, 0], [9, 1], [11, 7], [3, 9], [-1, 5])],
      [ring([0, 0], [10, 0], [10, 3], [7, 3], [7, 7], [10, 7], [10, 10], [0, 10])],
      [ring([0, 0], [6, 0], [6, 2], [9, 5], [6, 8], [6, 10], [0, 10])],
    ]
    for (const shape of shapes) expect(straightSkeleton(shape)).not.toBeNull()
  })

  it('handles every building outline of the example city', () => {
    const doc = PlinthDocument.createEmpty()
    doc.build((tx) => buildExampleCity(tx))
    for (const building of analyzeSite(doc.getSnapshot()).buildings.values()) {
      const top = building.slabs.find((s) => s.levelId === null)
      for (const polygon of top?.region ?? []) expect(straightSkeleton(polygon)).not.toBeNull()
    }
  })

  it('handles random star-shaped and notched outlines', () => {
    let seed = 7
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
    for (let k = 0; k < 150; k++) {
      const n = 5 + Math.floor(random() * 14)
      const star: [number, number][] = []
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + random() * 0.3
        const r = 5 + random() * 10
        star.push([Math.cos(a) * r, Math.sin(a) * r])
      }
      expect(straightSkeleton([star])).not.toBeNull()
      const w = 10 + Math.floor(random() * 20)
      const h = 8 + Math.floor(random() * 14)
      const nx = 2 + Math.floor(random() * (w - 4))
      const nw = 1 + Math.floor(random() * Math.max(1, w - nx - 1))
      const nd = 1 + Math.floor(random() * (h - 2))
      const notched = ring([0, 0], [w, 0], [w, h], [nx + nw, h], [nx + nw, h - nd], [nx, h - nd], [nx, h], [0, h])
      expect(straightSkeleton([notched])).not.toBeNull()
    }
  })
})
