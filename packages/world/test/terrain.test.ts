import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { decodePng } from '../src/png.ts'
import { heightsFromTerrarium, sampleHeight } from '../src/terrarium.ts'
import { groundMesh, buildingMesh, tileWidth, waterMesh } from '../src/mesh.ts'
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

describe('buildings', () => {
  const square = (x0: number, y0: number, x1: number, y1: number, clockwise: boolean) => {
    // Tile units, y running south.
    const ring = [x0, y0, x1, y0, x1, y1, x0, y1]
    if (!clockwise) for (let i = 0; i < 2; i++) [ring[2 + i], ring[6 + i]] = [ring[6 + i]!, ring[2 + i]!]
    return Float64Array.from(ring)
  }

  for (const clockwise of [true, false]) {
    it(`faces walls outwards and the roof up, whichever way the outline runs (${clockwise ? 'clockwise' : 'anticlockwise'})`, () => {
      const outer = square(0.4, 0.4, 0.6, 0.6, clockwise)
      const mesh = buildingMesh(tile, [{ shape: { outer, holes: [] }, height: 20, minHeight: 0 }], () => 400, {
        wall: [1, 1, 1],
        roof: [0.9, 0.9, 0.9],
      })!
      const p = mesh.positions
      const centre = [0, 0, 0]
      for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) centre[k]! += p[i + k]! / (p.length / 3)
      let walls = 0
      for (let t = 0; t < mesh.indices.length; t += 3) {
        const [a, b, c] = [mesh.indices[t]!, mesh.indices[t + 1]!, mesh.indices[t + 2]!].map((k) => [p[k * 3]!, p[k * 3 + 1]!, p[k * 3 + 2]!])
        const u = [b![0]! - a![0]!, b![1]! - a![1]!, b![2]! - a![2]!]
        const v = [c![0]! - a![0]!, c![1]! - a![1]!, c![2]! - a![2]!]
        // The way the triangle faces (anticlockwise front), and the normal given with it.
        const face = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!]
        const k = mesh.indices[t]! * 3
        const normal = [mesh.normals[k]!, mesh.normals[k + 1]!, mesh.normals[k + 2]!]
        expect(face[0]! * normal[0]! + face[1]! * normal[1]! + face[2]! * normal[2]!).toBeGreaterThan(0)
        if (Math.abs(normal[1]!) < 0.1) {
          walls++
          const out = [a![0]! - centre[0]!, 0, a![2]! - centre[2]!]
          expect(out[0]! * normal[0]! + out[2]! * normal[2]!).toBeGreaterThan(0)
        } else expect(normal[1]).toBeGreaterThan(0.9)
      }
      expect(walls).toBe(8)
    })
  }
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

describe('the ground', async () => {
  const { makeGround, mosaic } = await import('../src/ground.ts')
  const image = await decodePng(new Uint8Array(readFileSync(new URL('./terrarium-14-8580-5737.png', import.meta.url))))
  const left = heightsFromTerrarium(tile, image.data, image.width)
  // The same tile again as its eastern neighbour, so the seam between them can be checked.
  const right = { ...left, tile: { ...tile, x: tile.x + 1 } }

  it('has one height at a seam, whichever tile asks', () => {
    const b = tileBounds(tile)
    const a = mosaic([left, right])
    const c = mosaic([right, left])
    for (let k = 0; k <= 10; k++) {
      const lat = b.south + ((b.north - b.south) * k) / 10
      expect(a(b.east, lat)).toBeCloseTo(c(b.east, lat), 9)
    }
  })

  it('lays a level bed along streets: flat across them', () => {
    const features = readTile(tile, readFileSync(new URL('./zurich-14-8580-5737.pbf', import.meta.url)))
    const ground = makeGround([left], features)
    const n = 2 ** tile.z
    const lonOf = (u: number) => ((tile.x + u) / n) * 360 - 180
    const latOf = (v: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * (tile.y + v)) / n))) * 180) / Math.PI
    const metres = tileWidth(tile)
    let checked = 0
    for (const road of features.roads) {
      if (road.bridge || road.tunnel || !['minor', 'tertiary', 'secondary', 'primary'].includes(road.kind)) continue
      const [ax, ay, bx, by] = [road.line[0]!, road.line[1]!, road.line[2]!, road.line[3]!]
      const length = Math.hypot(bx - ax, by - ay)
      if (length * metres < 20 || ax < 0.05 || ax > 0.95 || ay < 0.05 || ay > 0.95) continue
      const [mx, my] = [(ax + bx) / 2, (ay + by) / 2]
      const across = (road.width / 2 - 0.5) / metres
      const [px, py] = [(-(by - ay) / length) * across, ((bx - ax) / length) * across]
      const one = ground.at(lonOf(mx + px), latOf(my + py))
      const other = ground.at(lonOf(mx - px), latOf(my - py))
      expect(Math.abs(one - other)).toBeLessThan(0.6)
      if (++checked >= 40) break
    }
    expect(checked).toBeGreaterThan(10)
  })

  it('puts water above the ground under it', () => {
    const features = readTile(tile, readFileSync(new URL('./zurich-14-8580-5737.pbf', import.meta.url)))
    const ground = makeGround([left], features)
    const mesh = waterMesh(tile, ground)!
    expect(mesh).not.toBeNull()
    expect(mesh.level).toBeGreaterThan(390)
    expect(mesh.level).toBeLessThan(420)
  })
})
