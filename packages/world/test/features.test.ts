import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { readTile, ringArea } from '../src/features.ts'
import { clipLine, clipRing, clipShape, UNIT } from '../src/clip.ts'

const bytes = readFileSync(new URL('./zurich-14-8580-5737.pbf', import.meta.url))
const tile = { z: 14, x: 8580, y: 5737 }

describe('reading a vector tile', () => {
  const features = readTile(tile, bytes)

  it('finds buildings with heights', () => {
    expect(features.buildings.length).toBeGreaterThan(1000)
    for (const b of features.buildings) {
      expect(b.height).toBeGreaterThan(b.minHeight)
      expect(b.shape.outer.length).toBeGreaterThanOrEqual(6)
    }
    expect(Math.max(...features.buildings.map((b) => b.height))).toBeGreaterThan(20)
  })

  it('keeps outer rings one way round and holes the other', () => {
    for (const b of features.buildings) {
      expect(ringArea(b.shape.outer)).toBeGreaterThan(0)
      for (const hole of b.shape.holes) expect(ringArea(hole)).toBeLessThan(0)
    }
  })

  it('finds roads of several kinds, water and green areas', () => {
    const kinds = new Set(features.roads.map((r) => r.kind))
    expect(kinds.has('primary') || kinds.has('secondary')).toBe(true)
    expect(kinds.has('minor')).toBe(true)
    expect(kinds.has('path')).toBe(true)
    expect(features.areas.some((a) => a.kind === 'water')).toBe(true)
    expect(features.areas.some((a) => a.kind === 'park' || a.kind === 'grass' || a.kind === 'wood')).toBe(true)
  })

  it('keeps coordinates in tile units, with a little beyond', () => {
    for (const road of features.roads) {
      for (const v of road.line) {
        expect(v).toBeGreaterThan(-0.2)
        expect(v).toBeLessThan(1.2)
      }
    }
  })
})

describe('clipping', () => {
  it('cuts a ring to the tile', () => {
    const ring = Float64Array.from([-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5])
    const clipped = clipRing(ring, UNIT)!
    expect(Math.abs(ringArea(clipped))).toBeCloseTo(0.25)
  })

  it('drops shapes outside', () => {
    const ring = Float64Array.from([1.1, 0, 1.2, 0, 1.2, 0.1])
    expect(clipShape({ outer: ring, holes: [] }, UNIT)).toBeNull()
  })

  it('cuts a line into the pieces inside', () => {
    const line = Float64Array.from([-1, 0.5, 0.5, 0.5, 0.5, 2, 0.6, 2, 0.6, 0.2])
    const pieces = clipLine(line, UNIT)
    expect(pieces).toHaveLength(2)
    expect(Array.from(pieces[0]!)).toEqual([0, 0.5, 0.5, 0.5, 0.5, 1])
    expect(Array.from(pieces[1]!)).toEqual([0.6, 1, 0.6, 0.2])
  })
})
