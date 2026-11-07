import { describe, expect, it } from 'vitest'
import { buildingMesh, tileWidth } from '../src/mesh.ts'
import type { BuildingFeature } from '../src/features.ts'

const tile = { z: 14, x: 8580, y: 5737 }
const m = tileWidth(tile)
const colours = {
  wall: [0.9, 0.9, 0.9] as [number, number, number],
  roof: [0.8, 0.8, 0.8] as [number, number, number],
  pitched: [0.7, 0.6, 0.5] as [number, number, number],
}

/** A rectangular building (metres) centred in the tile. */
const house = (width: number, depth: number, height: number): BuildingFeature => {
  const w = width / m / 2
  const d = depth / m / 2
  return {
    shape: { outer: new Float64Array([0.5 - w, 0.5 - d, 0.5 + w, 0.5 - d, 0.5 + w, 0.5 + d, 0.5 - w, 0.5 + d]), holes: [] },
    height,
    minHeight: 0,
  }
}

describe('roofs from assumptions', () => {
  it('gives a house a pitched roof up to its mapped height', () => {
    const mesh = buildingMesh(tile, [house(12, 9, 10)], () => 400, colours)!
    let sloped = 0
    let peak = 0
    for (let i = 0; i < mesh.positions.length / 3; i++) {
      const r = mesh.colors![i * 3]!
      peak = Math.max(peak, mesh.positions[i * 3 + 1]!)
      if (Math.abs(r - 0.7) > 1e-3) continue
      const ny = mesh.normals[i * 3 + 1]!
      if (ny > 0.3 && ny < 0.97) sloped++
    }
    expect(sloped).toBeGreaterThan(6)
    // The ridge reaches the mapped height (above the flat ground at 400).
    expect(peak).toBeGreaterThan(409)
    expect(peak).toBeLessThan(410.8)
  })

  it('keeps a big hall flat', () => {
    const mesh = buildingMesh(tile, [house(60, 40, 12)], () => 400, colours)!
    for (let i = 0; i < mesh.positions.length / 3; i++) {
      expect(Math.abs(mesh.colors![i * 3]! - 0.7)).toBeGreaterThan(1e-3)
    }
  })

  it('keeps a terrace of many doors flat (one long roof would swallow it)', () => {
    const mesh = buildingMesh(tile, [house(60, 7, 9)], () => 400, colours)!
    for (let i = 0; i < mesh.positions.length / 3; i++) {
      expect(Math.abs(mesh.colors![i * 3]! - 0.7)).toBeGreaterThan(1e-3)
    }
  })

  it('stands the roof on the walls when the height was only guessed', () => {
    const guessed = { ...house(12, 9, 5), guessedHeight: true }
    const mesh = buildingMesh(tile, [guessed], () => 400, colours)!
    let peak = 0
    let walls = 0
    for (let i = 0; i < mesh.positions.length / 3; i++) {
      peak = Math.max(peak, mesh.positions[i * 3 + 1]!)
      // Wall-coloured vertices still reach the guessed height.
      if (Math.abs(mesh.colors![i * 3]! - 0.9) < 1e-3) walls = Math.max(walls, mesh.positions[i * 3 + 1]!)
    }
    expect(walls).toBeGreaterThan(404.5)
    expect(peak).toBeGreaterThan(406.5)
  })

  it('keeps a tower flat', () => {
    const mesh = buildingMesh(tile, [house(14, 14, 40)], () => 400, colours)!
    for (let i = 0; i < mesh.positions.length / 3; i++) {
      expect(Math.abs(mesh.colors![i * 3]! - 0.7)).toBeGreaterThan(1e-3)
    }
  })
})
