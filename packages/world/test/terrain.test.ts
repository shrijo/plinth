import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { decodePng } from '../src/png.ts'
import { heightsFromTerrarium, sampleHeight } from '../src/terrarium.ts'
import { groundMesh, buildingMesh } from '../src/mesh.ts'
import { readTile } from '../src/features.ts'
import { tileBounds } from '../src/tiles.ts'
import { ecefFromLonLat, enuFrame, frameToLonLat, lonLatFromEcef, lonLatToFrame } from '../src/geo.ts'

const tile = { z: 14, x: 8580, y: 5737 }

describe('ground heights', async () => {
  const image = await decodePng(new Uint8Array(readFileSync(new URL('./terrarium-14-8580-5737.png', import.meta.url))))
  const heights = heightsFromTerrarium(tile, image.data, image.width)

  it('reads the image', () => {
    expect(image.width).toBe(256)
    expect(image.height).toBe(256)
  })

  it('gives Zurich its heights: the lake at about 406 m, hills up to about 700', () => {
    let low = Infinity
    let high = -Infinity
    for (const h of heights.heights) {
      low = Math.min(low, h)
      high = Math.max(high, h)
    }
    expect(low).toBeGreaterThan(380)
    expect(low).toBeLessThan(420)
    expect(high).toBeLessThan(900)
  })

  it('has no lone spikes', () => {
    const size = heights.size
    let worst = 0
    for (let y = 1; y < size - 1; y++) {
      for (let x = 1; x < size - 1; x++) {
        const h = (i: number, j: number) => heights.heights[j * size + i]!
        const around = (h(x - 1, y) + h(x + 1, y) + h(x, y - 1) + h(x, y + 1)) / 4
        worst = Math.max(worst, Math.abs(h(x, y) - around))
      }
    }
    expect(worst).toBeLessThan(60)
  })

  it('samples between pixels', () => {
    const b = tileBounds(tile)
    const h = sampleHeight(heights, (b.west + b.east) / 2, (b.north + b.south) / 2)!
    expect(h).toBeGreaterThan(380)
    expect(sampleHeight(heights, b.east + 0.01, b.north)).toBeNull()
  })

  it('drapes the ground over them and puts buildings on it', () => {
    const at = (lon: number, lat: number) => sampleHeight(heights, lon, lat) ?? 0
    const ground = groundMesh(tile, at, 32)
    expect(ground.low).toBeGreaterThan(380)
    expect(ground.indices.length).toBeGreaterThan(32 * 32 * 6)
    const features = readTile(tile, readFileSync(new URL('./zurich-14-8580-5737.pbf', import.meta.url)))
    const mesh = buildingMesh(tile, features.buildings, at, { wall: [1, 1, 1], roof: [0.9, 0.9, 0.9] })!
    expect(mesh.positions.length / 3).toBeGreaterThan(10000)
    for (let i = 0; i < mesh.normals.length; i += 3) {
      expect(Math.hypot(mesh.normals[i]!, mesh.normals[i + 1]!, mesh.normals[i + 2]!)).toBeCloseTo(1, 3)
    }
  })
})

describe('the Earth', () => {
  it('goes to ECEF and back', () => {
    const p = ecefFromLonLat(8.54, 47.37, 410)
    const back = lonLatFromEcef(p)
    expect(back.lon).toBeCloseTo(8.54, 9)
    expect(back.lat).toBeCloseTo(47.37, 9)
    expect(back.height).toBeCloseTo(410, 3)
  })

  it('measures metres east and north in a local frame', () => {
    const frame = enuFrame(8.54, 47.37)
    const there = frameToLonLat(frame, 1000, 500)
    const [e, n] = lonLatToFrame(frame, there.lon, there.lat)
    expect(e).toBeCloseTo(1000, 3)
    expect(n).toBeCloseTo(500, 3)
  })
})
