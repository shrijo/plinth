import { describe, expect, it } from 'vitest'
import { selectTiles, type View } from '../src/lod.ts'
import { ecefFromLonLat } from '../src/geo.ts'
import { tileKey, type TileId } from '../src/tiles.ts'

/** A view looking straight down from a height over Zurich, seeing everything within `radius` metres of the point below. */
function viewFrom(height: number, radius: number): View {
  const below = ecefFromLonLat(8.54, 47.37, 0)
  return {
    camera: ecefFromLonLat(8.54, 47.37, height),
    inView: (centre, r) => Math.hypot(centre[0] - below[0], centre[1] - below[1], centre[2] - below[2]) - r < radius,
    pixelsPerMetre: 1000,
    textureSize: 512,
    maxError: 1.2,
    maxZoom: 17,
  }
}

const everythingReady = { isReady: () => true, heightRange: (): [number, number] => [0, 500] }

describe('choosing tiles', () => {
  it('goes finer closer to the ground', () => {
    const high = selectTiles(viewFrom(200000, 100000), everythingReady)
    const low = selectTiles(viewFrom(1000, 1500), everythingReady)
    const deepest = (tiles: TileId[]) => Math.max(...tiles.map((t) => t.z))
    expect(deepest(low.draw)).toBeGreaterThan(deepest(high.draw))
    expect(deepest(low.draw)).toBeGreaterThanOrEqual(14)
    expect(deepest(high.draw)).toBeLessThan(12)
  })

  it('covers the view once: no tile drawn with its ancestor', () => {
    const { draw } = selectTiles(viewFrom(1000, 1500), everythingReady)
    const keys = new Set(draw.map(tileKey))
    for (const tile of draw) {
      for (let z = tile.z - 1; z >= 0; z--) {
        const shift = tile.z - z
        expect(keys.has(`${z}/${tile.x >> shift}/${tile.y >> shift}`)).toBe(false)
      }
    }
  })

  it('stands in a ready parent for children still loading, and asks for them coarsest first', () => {
    const ready = new Set<string>()
    for (let z = 0; z <= 10; z++) {
      const n = 2 ** z
      const x = Math.floor(((8.54 + 180) / 360) * n)
      const lat = (47.37 * Math.PI) / 180
      const y = Math.floor(((1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2) * n)
      ready.add(`${z}/${x}/${y}`)
    }
    const { draw, want } = selectTiles(viewFrom(1000, 1500), { isReady: (k) => ready.has(k), heightRange: () => [0, 500] })
    expect(draw.length).toBeGreaterThan(0)
    expect(want.length).toBeGreaterThan(0)
    for (let i = 1; i < want.length; i++) expect(want[i]!.z).toBeGreaterThanOrEqual(want[i - 1]!.z)
  })

  it('asks for the middle of the view before its edges, within a level (foveated)', () => {
    // Looking east, low over Zurich: of the tiles wanted at one zoom, those ahead come before those to the side.
    const camera = ecefFromLonLat(8.54, 47.37, 600)
    const ahead = ecefFromLonLat(8.56, 47.37, 0)
    const length = Math.hypot(ahead[0] - camera[0], ahead[1] - camera[1], ahead[2] - camera[2])
    const forward: [number, number, number] = [
      (ahead[0] - camera[0]) / length,
      (ahead[1] - camera[1]) / length,
      (ahead[2] - camera[2]) / length,
    ]
    const view: View = { ...viewFrom(600, 2500), camera, forward }
    const { want } = selectTiles(view, { isReady: (k) => Number(k.split('/')[0]) < 12, heightRange: () => [0, 500] })
    const level = Math.max(...want.map((t) => t.z))
    const finest = want.filter((t) => t.z === level)
    expect(finest.length).toBeGreaterThan(4)
    // The first few lie east of the camera (ahead), on average further east than the last few.
    const east = (t: TileId) => t.x + 0.5
    const firsts = finest.slice(0, 3).reduce((sum, t) => sum + east(t), 0) / 3
    const lasts = finest.slice(-3).reduce((sum, t) => sum + east(t), 0) / 3
    expect(firsts).toBeGreaterThan(lasts)
  })
})
