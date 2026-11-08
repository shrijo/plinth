import { describe, expect, it } from 'vitest'
import { fillLayout, openingType, type FillLeaf } from './openingTypes.ts'

/** Where a leaf's free edge ends up (opening-local x, z) when fully open. */
function openEdge(leaf: FillLeaf): [number, number] {
  const far = leaf.parts.reduce((best, p) => (Math.abs(p.center[0]) > Math.abs(best.center[0]) ? p : best))
  const x = far.center[0] + Math.sign(far.center[0]) * (far.size[0] / 2)
  const c = Math.cos(leaf.openAngle)
  const s = Math.sin(leaf.openAngle)
  // Rotation about +y: (x, z) → (x cos + z sin, −x sin + z cos), from the hinge.
  return [leaf.hinge[0] + x * c, leaf.hinge[2] - x * s]
}

describe('fillLayout', () => {
  const door = openingType('door', 'door')

  it('hangs a door on the start jamb and swings it to the right face', () => {
    const { leaves } = fillLayout(door, 0.9, 2.1, 0.2)
    expect(leaves).toHaveLength(1)
    expect(leaves[0]!.hinge[0]).toBeLessThan(0)
    const [, z] = openEdge(leaves[0]!)
    expect(z).toBeGreaterThan(0.7)
  })

  it('flips the hinge and the side', () => {
    const { leaves } = fillLayout(door, 0.9, 2.1, 0.2, { flipHinge: true, flipSide: true })
    expect(leaves[0]!.hinge[0]).toBeGreaterThan(0)
    const [, z] = openEdge(leaves[0]!)
    expect(z).toBeLessThan(-0.7)
  })

  it('hangs double doors on both jambs, opening the same way', () => {
    const { leaves } = fillLayout(openingType('door-double', 'door'), 1.6, 2.1, 0.2)
    expect(leaves.map((l) => Math.sign(l.hinge[0]))).toEqual([-1, 1])
    for (const leaf of leaves) expect(openEdge(leaf)[1]).toBeGreaterThan(0.6)
  })

  it('gives fixed glazing no leaves', () => {
    const layout = fillLayout(openingType('window-tall', 'window'), 1.2, 2.3, 0.2)
    expect(layout.leaves).toHaveLength(0)
    expect(layout.frame.some((p) => p.material === 'glass')).toBe(true)
  })

  it('leaves an empty opening empty', () => {
    expect(fillLayout(openingType('door-empty', 'door'), 0.9, 2.1, 0.2)).toEqual({ frame: [], leaves: [] })
  })
})
