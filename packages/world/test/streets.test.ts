import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { decodePng } from '../src/png.ts'
import { heightsFromTerrarium } from '../src/terrarium.ts'
import { readTile } from '../src/features.ts'
import { makeGround } from '../src/ground.ts'
import { streetMesh } from '../src/streets.ts'
import { lonLatFromEcef, fromFrame } from '../src/geo.ts'
import { tileFrame } from '../src/mesh.ts'

const tile = { z: 14, x: 8580, y: 5737 }
const grey: [number, number, number] = [0.6, 0.6, 0.6]
const colours = { road: grey, bike: grey, parking: grey, sidewalk: [0.9, 0.9, 0.9] as [number, number, number], curb: grey, marking: [1, 1, 1] as [number, number, number] }

describe('streets in 3D', async () => {
  const image = await decodePng(new Uint8Array(readFileSync(new URL('./terrarium-14-8580-5737.png', import.meta.url))))
  const heights = heightsFromTerrarium(tile, image.data, image.width)
  const features = readTile(tile, readFileSync(new URL('./zurich-14-8580-5737.pbf', import.meta.url)))
  const ground = makeGround([heights], features)

  it('builds a tile of streets, on the street bed, above the land, quickly enough', () => {
    const started = performance.now()
    const mesh = streetMesh(tile, features.roads, ground, colours).mesh!
    const ms = performance.now() - started
    console.log('streets:', mesh.indices.length / 3, 'triangles in', Math.round(ms), 'ms')
    expect(mesh.indices.length / 3).toBeGreaterThan(10000)
    expect(ms).toBeLessThan(8000)
    // Road tops (normal up, road colour) lie just above the street bed and above the land under them.
    const frame = tileFrame(tile)
    let checked = 0
    for (let i = 0; i < mesh.positions.length / 3 && checked < 400; i += 97) {
      if (mesh.normals[i * 3 + 1]! < 0.99 || Math.abs(mesh.colors![i * 3]! - 0.6) > 1e-6) continue
      const p = fromFrame(frame, [mesh.positions[i * 3]!, -mesh.positions[i * 3 + 2]!, mesh.positions[i * 3 + 1]!])
      const place = lonLatFromEcef(p)
      expect(place.height).toBeGreaterThan(ground.at(place.lon, place.lat))
      expect(place.height - ground.level(place.lon, place.lat)).toBeLessThan(0.2)
      checked++
    }
    expect(checked).toBeGreaterThan(50)
  })

  it('leaves out an area (a site stands there)', () => {
    const frame = tileFrame(tile)
    const corner = (e: number, n: number) => {
      const p = lonLatFromEcef(fromFrame(frame, [e, n, 0]))
      return { lon: p.lon, lat: p.lat }
    }
    const mask = [corner(-150, -150), corner(150, -150), corner(150, 150), corner(-150, 150)]
    const whole = streetMesh(tile, features.roads, ground, colours).mesh!
    const holed = streetMesh(tile, features.roads, ground, colours, mask).mesh!
    expect(holed.indices.length).toBeLessThan(whole.indices.length)
    for (let i = 0; i < holed.positions.length / 3; i++) {
      const x = holed.positions[i * 3]!
      const z = holed.positions[i * 3 + 2]!
      expect(Math.abs(x) < 149 && Math.abs(z) < 149).toBe(false)
    }
  }, 20000)

  it('stays inside its tile', () => {
    const mesh = streetMesh(tile, features.roads, ground, colours).mesh!
    const frame = tileFrame(tile)
    const n = 2 ** tile.z
    for (let i = 0; i < mesh.positions.length / 3; i += 13) {
      const p = lonLatFromEcef(fromFrame(frame, [mesh.positions[i * 3]!, -mesh.positions[i * 3 + 2]!, mesh.positions[i * 3 + 1]!]))
      const u = ((p.lon + 180) / 360) * n - tile.x
      expect(u).toBeGreaterThan(-1e-4)
      expect(u).toBeLessThan(1 + 1e-4)
    }
  })
})
