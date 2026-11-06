import { describe, expect, it } from 'vitest'
import { makeCloudNoise } from '../src/cloudNoise.ts'

describe('cloud noise', () => {
  it('makes textures that tile, quickly enough to make once', () => {
    const t0 = performance.now()
    const noise = makeCloudNoise(32, 16)
    const ms = performance.now() - t0
    expect(noise.shape.length).toBe(32 ** 3 * 4)
    expect(ms).toBeLessThan(5000)
    // Opposite faces of the cube meet: neighbours across the seam differ about as much as neighbours inside.
    const s = noise.shapeSize
    const at = (x: number, y: number, z: number, c: number) => noise.shape[((z * s + y) * s + x) * 4 + c]!
    let seam = 0
    let inside = 0
    for (let z = 0; z < s; z++) {
      for (let y = 0; y < s; y++) {
        seam += Math.abs(at(s - 1, y, z, 1) - at(0, y, z, 1))
        inside += Math.abs(at(s / 2, y, z, 1) - at(s / 2 - 1, y, z, 1))
      }
    }
    expect(seam).toBeLessThan(inside * 1.6)
    // A spread of values, not flat.
    const values = Array.from({ length: 1000 }, (_, i) => noise.shape[i * 4]!)
    expect(Math.max(...values) - Math.min(...values)).toBeGreaterThan(80)
  })
})
