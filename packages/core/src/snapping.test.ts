import { describe, expect, it } from 'vitest'
import { DEFAULT_SNAP_SETTINGS, snap, type SnapContext } from './snapping.ts'

const base: SnapContext = {
  points: [
    { id: 'n1', x: 0, y: 0 },
    { id: 'n2', x: 4, y: 0 },
  ],
  segments: [{ wallId: 'w1', a: { x: 0, y: 0 }, b: { x: 4, y: 0 } }],
  settings: DEFAULT_SNAP_SETTINGS,
  tolerance: 0.2,
}

describe('snap', () => {
  it('snaps to a nearby node first', () => {
    const r = snap({ x: 4.1, y: 0.05 }, base)
    expect(r.kind).toBe('node')
    expect(r.nodeId).toBe('n2')
    expect(r.point).toEqual({ x: 4, y: 0 })
  })

  it('snaps to a wall midpoint', () => {
    const r = snap({ x: 2.05, y: 0.05 }, base)
    expect(r.kind).toBe('midpoint')
    expect(r.point).toEqual({ x: 2, y: 0 })
  })

  it('snaps onto a wall', () => {
    const r = snap({ x: 3.03, y: 0.1 }, base)
    expect(r.kind).toBe('wall')
    expect(r.wallId).toBe('w1')
    expect(r.point.y).toBeCloseTo(0)
    expect(r.point.x).toBeCloseTo(3.03)
  })

  it('locks to the angle step from the anchor and rounds the length', () => {
    const r = snap({ x: 10.02, y: 3.08 }, { ...base, anchor: { x: 10, y: 0 }, points: [], segments: [] })
    expect(r.kind).toBe('angle')
    expect(r.point.x).toBeCloseTo(10)
    expect(r.point.y).toBeCloseTo(3.1)
    expect(r.guides[0]?.kind).toBe('y')
  })

  it('finds where an angle guide meets a wall', () => {
    const r = snap({ x: 2.6, y: 0.12 }, { ...base, anchor: { x: 2.5, y: 3 } })
    expect(r.kind).toBe('intersection')
    expect(r.wallId).toBe('w1')
    expect(r.point.x).toBeCloseTo(2.5)
    expect(r.point.y).toBeCloseTo(0)
  })

  it('aligns with an existing node', () => {
    const r = snap({ x: 4.05, y: 6.3 }, { ...base, segments: [] })
    expect(r.kind).toBe('guide')
    expect(r.point.x).toBeCloseTo(4)
    expect(r.point.y).toBeCloseTo(6.3)
  })

  it('falls back to the grid', () => {
    const r = snap({ x: 7.13, y: 8.86 }, base)
    expect(r.kind).toBe('grid')
    expect(r.point).toEqual({ x: 7.25, y: 8.75 })
  })

  it('returns the cursor unchanged when snapping is off', () => {
    const r = snap({ x: 4.1, y: 0 }, { ...base, settings: { ...DEFAULT_SNAP_SETTINGS, enabled: false } })
    expect(r.kind).toBe('free')
    expect(r.point).toEqual({ x: 4.1, y: 0 })
  })
})
