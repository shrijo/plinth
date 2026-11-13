import { describe, expect, it } from 'vitest'
import { makeGround } from '../src/ground.ts'
import type { TileFeatures } from '../src/features.ts'
import { tileWidth } from '../src/mesh.ts'
import { tileLat, tileLon } from '../src/tiles.ts'

/** A hillside falling to the east, a metre in five, with bumps a couple of metres high on it (as elevation data has in town). */
const tile = { z: 14, x: 8580, y: 5737 }
const SIZE = 256
const metres = tileWidth(tile)
const slope = { tile, size: SIZE, heights: Float32Array.from({ length: SIZE * SIZE }, (_, k) => 500 - ((k % SIZE) / SIZE) * metres * 0.2 + 2 * Math.sin((k % SIZE) * 0.9) * Math.cos(Math.floor(k / SIZE) * 0.7)) }

/** A house 12 m square (tile units), its middle at a place. */
const house = (u: number, v: number) => {
  const h = 6 / metres
  return { shape: { outer: new Float64Array([u - h, v - h, u + h, v - h, u + h, v + h, u - h, v + h]), holes: [] }, height: 7, minHeight: 0 }
}
const features: TileFeatures = { tile, buildings: [house(0.5, 0.5), house(0.52, 0.5), house(0.3, 0.7)], roads: [], areas: [], waterways: [] }
const lon = (u: number) => tileLon(tile.x + u, tile.z)
const lat = (v: number) => tileLat(tile.y + v, tile.z)

describe('the ground under buildings', () => {
  const ground = makeGround([slope], features)
  const bare = makeGround([slope], { ...features, buildings: [] })

  it('is level under each building, at one height', () => {
    const h = 6 / metres
    const heights: number[] = []
    for (const du of [-0.9, -0.4, 0, 0.5, 0.9]) for (const dv of [-0.9, 0, 0.9]) heights.push(ground.at(lon(0.5 + du * h), lat(0.5 + dv * h)))
    expect(Math.max(...heights) - Math.min(...heights)).toBeLessThan(0.01)
    // Where the bare hillside falls well over two metres across the same square.
    const fall = bare.at(lon(0.5 - 0.9 * h), lat(0.5)) - bare.at(lon(0.5 + 0.9 * h), lat(0.5))
    expect(fall).toBeGreaterThan(1.5)
  })

  it('never stands above a building\'s base at its walls: no house is swallowed', () => {
    const h = 6 / metres
    const base = ground.at(lon(0.3), lat(0.7))
    // Round the house, half a metre out from its walls.
    const out = 6.5 / metres
    for (let k = 0; k < 40; k++) {
      const t = (k / 40) * 2 - 1
      for (const [u, v] of [
        [0.3 + t * h, 0.7 - out],
        [0.3 + t * h, 0.7 + out],
        [0.3 - out, 0.7 + t * h],
        [0.3 + out, 0.7 + t * h],
      ] as const) {
        expect(ground.at(lon(u), lat(v))).toBeLessThan(base + 0.05)
        expect(ground.at(lon(u), lat(v))).toBeGreaterThan(base - 0.05)
      }
    }
  })

  it('follows the slope, not the bumps: neighbours stand in step', () => {
    // Two houses 33 m apart down the slope: the lower one about 6.6 m lower (0.2 x 33), whatever the bumps under each.
    const upper = ground.at(lon(0.5), lat(0.5))
    const lower = ground.at(lon(0.52), lat(0.5))
    expect(upper - lower).toBeGreaterThan(0.02 * metres * 0.2 - 1)
    expect(upper - lower).toBeLessThan(0.02 * metres * 0.2 + 1)
  })

  it('leaves the land as it is away from anything built', () => {
    expect(ground.at(lon(0.8), lat(0.2))).toBeCloseTo(bare.at(lon(0.8), lat(0.2)), 6)
  })
})

describe('a building across the edge of a tile', () => {
  // A long building on the slope, crossing the tile's east edge: each tile has it only as far as its data reaches.
  const h = 8 / metres
  const across = (from: number, to: number) => ({ shape: { outer: new Float64Array([from, 0.5 - h, to, 0.5 - h, to, 0.5 + h, from, 0.5 + h]), holes: [] }, height: 12, minHeight: 0 })
  const east = { z: 14, x: tile.x + 1, y: tile.y }
  const eastSlope = { tile: east, size: SIZE, heights: Float32Array.from({ length: SIZE * SIZE }, (_, k) => 500 - (1 + (k % SIZE) / SIZE) * metres * 0.2 + 2 * Math.sin(((k % SIZE) + SIZE) * 0.9) * Math.cos(Math.floor(k / SIZE) * 0.7)) }
  // As map tiles carry them: cut a little past each tile's own edge.
  const west = makeGround([slope, eastSlope], { ...features, buildings: [across(0.95, 1.015)] })
  const other = makeGround([slope, eastSlope], { tile: east, buildings: [across(-0.015, 0.06)], roads: [], areas: [], waterways: [] })

  it('stands at one height from both sides, so the ground meets at the seam', () => {
    for (const dv of [-0.8, -0.3, 0, 0.4, 0.8]) {
      const at = [lon(1), lat(0.5 + dv * h)] as const
      expect(west.at(...at)).toBeCloseTo(other.at(...at), 2)
    }
  })

  it('steps with the hill rather than being cut level along its whole length', () => {
    // 80 m into the tile the hill is 16 m higher than at the edge: the ground under the building follows it to within a step.
    const far = west.at(lon(0.955), lat(0.5))
    const near = west.at(lon(0.999), lat(0.5))
    expect(far - near).toBeGreaterThan(8)
  })
})
