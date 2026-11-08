import { describe, expect, it } from 'vitest'
import { makeGround } from '../src/ground.ts'
import type { TileFeatures } from '../src/features.ts'

/** A flat land at 400 m, as a height tile. */
const tile = { z: 14, x: 8580, y: 5737 }
const SIZE = 16
const flat = { tile, size: SIZE, heights: Float32Array.from({ length: SIZE * SIZE }, () => 400) }

/** A river across the tile's middle (tile units), and a residential street crossing it. */
const features: TileFeatures = {
  tile,
  buildings: Array.from({ length: 200 }, () => ({ shape: { outer: new Float64Array([0, 0, 0.001, 0, 0.001, 0.001]), holes: [] }, height: 5, minHeight: 0 })),
  roads: [
    {
      line: new Float64Array([0.5, 0.1, 0.5, 0.9]),
      kind: 'minor',
      width: 8,
      tunnel: false,
      bridge: false,
      layer: 0,
      name: '',
      oneway: false,
      service: '',
      subclass: '',
    },
  ],
  areas: [
    {
      shape: { outer: new Float64Array([0.2, 0.45, 0.8, 0.45, 0.8, 0.55, 0.2, 0.55]), holes: [] },
      kind: 'water',
    },
  ],
  waterways: [],
}

describe('ground at water', () => {
  const ground = makeGround([flat], features)
  const lonAt = (u: number) => ((tile.x + u) / 2 ** 14) * 360 - 180
  const latAt = (v: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * (tile.y + v)) / 2 ** 14))) * 180) / Math.PI

  it('keeps a street crossing water on a causeway above the surface', () => {
    const lon = lonAt(0.5)
    const lat = latAt(0.5)
    const surface = ground.surface(lon, lat)
    expect(ground.waterAt(lon, lat)).not.toBeNull()
    expect(ground.level(lon, lat)).toBeGreaterThanOrEqual(surface + 0.44)
    // Under the street: an embankment just below its bed, above the water.
    expect(ground.at(lon, lat)).toBeGreaterThan(surface)
  })

  it('drops the ground into a basin away from the street', () => {
    const lon = lonAt(0.3)
    const lat = latAt(0.5)
    const surface = ground.surface(lon, lat)
    expect(ground.at(lon, lat)).toBeLessThanOrEqual(surface - 1.4)
  })

  it('gives the shore a bank, not a long smooth ramp', () => {
    // Just outside the water (a few metres north of its edge).
    const lon = lonAt(0.3)
    const lat = latAt(0.4497)
    expect(ground.waterAt(lon, lat)).toBeNull()
    expect(ground.at(lon, lat)).toBeGreaterThanOrEqual(ground.surface(lon, lat) + 0.24)
  })
})
