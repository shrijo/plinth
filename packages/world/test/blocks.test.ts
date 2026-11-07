import { describe, expect, it } from 'vitest'
import type { Ground } from '../src/ground.ts'
import { tileWidth } from '../src/mesh.ts'
import { streetMesh } from '../src/streets.ts'
import type { RoadFeature } from '../src/features.ts'

const tile = { z: 14, x: 8580, y: 5737 }
const m = tileWidth(tile)
const flat: Ground = { at: () => 400, level: () => 400, waterAt: () => null, surface: () => 400, water: [], source: tile, town: true }
const land: [number, number, number] = [0.5, 0.4, 0.3]
const green: [number, number, number] = [0.1, 0.8, 0.1]
const grey: [number, number, number] = [0.6, 0.6, 0.6]
const colours = { road: grey, bike: grey, parking: grey, sidewalk: [0.9, 0.9, 0.9] as [number, number, number], curb: grey, marking: [1, 1, 1] as [number, number, number], land, green }

const road = (points: [number, number][]): RoadFeature => ({
  line: Float64Array.from(points.flatMap(([u, v]) => [u, v])),
  kind: 'minor',
  width: 8,
  tunnel: false,
  bridge: false,
  layer: 0,
  name: '',
  oneway: false,
  service: '',
  subclass: '',
})

describe('block fills', () => {
  // A 120 m square loop of streets in the tile's middle.
  const d = 60 / m
  const c = 0.5
  const loop = [
    road([[c - d, c - d], [c + d, c - d]]),
    road([[c + d, c - d], [c + d, c + d]]),
    road([[c + d, c + d], [c - d, c + d]]),
    road([[c - d, c + d], [c - d, c - d]]),
  ]

  it('fills the square between the streets, on the ground', () => {
    const mesh = streetMesh(tile, loop, flat, colours)!
    let inside = 0
    for (let i = 0; i < mesh.positions.length / 3; i++) {
      const r = mesh.colors![i * 3]!
      const g = mesh.colors![i * 3 + 1]!
      if (Math.abs(r - land[0]) > 1e-3 || Math.abs(g - land[1]) > 1e-3) continue
      const x = mesh.positions[i * 3]!
      const z = mesh.positions[i * 3 + 2]!
      // Inside the loop (the tile frame is centred on the tile).
      if (Math.abs(x) < 55 && Math.abs(z) < 55) inside++
      // On the ground, just over it.
      expect(mesh.positions[i * 3 + 1]!).toBeGreaterThan(399)
      expect(mesh.positions[i * 3 + 1]!).toBeLessThan(400.4)
    }
    expect(inside).toBeGreaterThan(20)
  })

  it('leaves the open country unfilled', () => {
    const open = streetMesh(tile, [loop[0]!], { ...flat, town: false }, colours)!
    for (let i = 0; i < open.positions.length / 3; i++) {
      expect(Math.abs(open.colors![i * 3]! - land[0])).toBeGreaterThan(1e-3)
    }
  })
})
