import { describe, expect, it } from 'vitest'
import { fromFrame, lonLatFromEcef } from '../src/geo.ts'
import { groundMesh, tileFrame } from '../src/mesh.ts'
import { tileLat, tileLon } from '../src/tiles.ts'

/** Hilly: heights that change a lot between grid points. */
const hills = (lon: number, lat: number) => 400 + 30 * Math.sin(lon * 4000) + 20 * Math.cos(lat * 5000)

describe("a ground tile's slide into its parent's shape", () => {
  const parent = { z: 15, x: 17161, y: 11474 }
  const child = { z: 16, x: 34323, y: 22949 }
  const segments = 8
  const fine = groundMesh(child, hills, segments, undefined, 'same')
  const coarse = groundMesh(parent, hills, segments)
  const side = segments + 1

  /** Where a child point lies, slid all the way. */
  const slid = (k: number) => {
    const frame = tileFrame(child)
    const p = [0, 1, 2].map((c) => fine.positions[k * 3 + c]! + fine.morph![k * 3 + c]!) as [number, number, number]
    return lonLatFromEcef(fromFrame(frame, [p[0], -p[2], p[1]]))
  }
  /** The parent's height at a point, on its triangles (split from each square's north-east corner to its south-west). */
  const parentHeight = (lon: number, lat: number) => {
    const u = ((lon - tileLon(parent.x, parent.z)) / (tileLon(parent.x + 1, parent.z) - tileLon(parent.x, parent.z))) * segments
    const v = ((lat - tileLat(parent.y, parent.z)) / (tileLat(parent.y + 1, parent.z) - tileLat(parent.y, parent.z))) * segments
    const i = Math.min(Math.floor(u), segments - 1)
    const j = Math.min(Math.floor(v), segments - 1)
    const fu = u - i
    const fv = v - j
    const h = (a: number, b: number) => coarse.heights[(j + b) * side + i + a]!
    // Upper-left triangle (a, c, b) when fu + fv <= 1, else the lower-right (b, c, d).
    return fu + fv <= 1 ? h(0, 0) + (h(1, 0) - h(0, 0)) * fu + (h(0, 1) - h(0, 0)) * fv : h(1, 1) + (h(0, 1) - h(1, 1)) * (1 - fu) + (h(1, 0) - h(1, 1)) * (1 - fv)
  }

  it("lands every point on the parent's surface", () => {
    expect(fine.morph).toBeDefined()
    for (let k = 0; k < side * side; k++) {
      const place = slid(k)
      expect(place.height).toBeCloseTo(parentHeight(place.lon, place.lat), 2)
    }
  })

  it("leaves the points it shares with its parent where they are", () => {
    for (let j = 0; j < side; j += 2) {
      for (let i = 0; i < side; i += 2) {
        const k = j * side + i
        expect(Math.hypot(fine.morph![k * 3]!, fine.morph![k * 3 + 1]!, fine.morph![k * 3 + 2]!)).toBeLessThan(1e-3)
      }
    }
  })
})
