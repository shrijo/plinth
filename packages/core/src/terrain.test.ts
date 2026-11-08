import { describe, expect, it } from 'vitest'
import { PlinthDocument } from './document.ts'
import { addSpotHeights, contours, groundUnder, heightAt, terrainMesh, terrainOf } from './terrain.ts'

/** A slope rising 1 m for every 10 m east, over 100 × 100 m. */
function slope() {
  const doc = PlinthDocument.createEmpty()
  doc.transact((tx) =>
    addSpotHeights(tx, [
      { x: 0, y: 0, z: 400 },
      { x: 100, y: 0, z: 410 },
      { x: 100, y: 100, z: 410 },
      { x: 0, y: 100, z: 400 },
      { x: 50, y: 50, z: 405 },
    ]),
  )
  return doc
}

describe('terrain', () => {
  it('needs three spot heights', () => {
    const doc = PlinthDocument.createEmpty()
    expect(terrainOf(doc.getSnapshot())).toBeNull()
  })

  it('gives the height anywhere on it, and none off it', () => {
    const terrain = terrainOf(slope().getSnapshot())!
    expect(terrain.triangles.length).toBe(12)
    expect(heightAt(terrain, { x: 25, y: 70 })).toBeCloseTo(402.5)
    expect(heightAt(terrain, { x: 90, y: 10 })).toBeCloseTo(409)
    expect(heightAt(terrain, { x: 150, y: 10 })).toBeNull()
  })

  it('draws contour lines at a tidy interval', () => {
    const terrain = terrainOf(slope().getSnapshot())!
    const lines = contours(terrain)
    // 400 to 410: every 0.25 m makes 41 levels; the interval keeps it to 50 or fewer.
    expect(lines.length).toBeLessThanOrEqual(51)
    const at405 = contours(terrain, 1).find((c) => c.z === 405)!
    expect(at405.major).toBe(true)
    // The 405 m line runs north–south at x = 50.
    for (const [a, b] of at405.segments) {
      expect(a.x).toBeCloseTo(50)
      expect(b.x).toBeCloseTo(50)
    }
  })

  it('makes an upward-facing mesh', () => {
    const mesh = terrainMesh(terrainOf(slope().getSnapshot())!)
    expect(mesh.positions.length).toBe(15)
    for (let i = 1; i < mesh.normals.length; i += 3) expect(mesh.normals[i]!).toBeGreaterThan(0.9)
  })

  it('finds the ground under a building: the lowest under its corners', () => {
    const terrain = terrainOf(slope().getSnapshot())!
    expect(groundUnder(terrain, [{ x: 20, y: 20 }, { x: 40, y: 20 }, { x: 40, y: 30 }])).toBeCloseTo(402)
    expect(groundUnder(terrain, [{ x: 200, y: 20 }])).toBeNull()
  })
})
