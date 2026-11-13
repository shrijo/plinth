import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { decodePng } from '../src/png.ts'
import { heightsFromTerrarium } from '../src/terrarium.ts'
import { readTile } from '../src/features.ts'
import { makeGround } from '../src/ground.ts'
import { layStreets, planStreets, quarterOf, streetMesh } from '../src/streets.ts'
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

  const started = performance.now()
  const whole = streetMesh(tile, features.roads, ground, colours)
  const ms = performance.now() - started

  it('builds a tile of streets, on the street bed, above the land, quickly enough', () => {
    const mesh = whole.mesh!
    console.log('streets:', mesh.indices.length / 3, 'triangles in', Math.round(ms), 'ms')
    expect(mesh.indices.length / 3).toBeGreaterThan(10000)
    // The heart of a city, all of it at once (the world lays a quarter at a time, side by side).
    expect(ms).toBeLessThan(20000)
    // Road tops (normal up, road colour) lie above the land under them, and most just above the street bed (the
    // rest are held up to a bridge where it lands, on the ramp up to one, or on a road built wider than its
    // class's bed, level out over land that falls away beside it).
    const frame = tileFrame(tile)
    let checked = 0
    let lifted = 0
    for (let i = 0; i < mesh.positions.length / 3 && checked < 400; i += 97) {
      if (mesh.normals[i * 3 + 1]! < 0.99 || Math.abs(mesh.colors![i * 3]! - 0.6) > 1e-6) continue
      const p = fromFrame(frame, [mesh.positions[i * 3]!, -mesh.positions[i * 3 + 2]!, mesh.positions[i * 3 + 1]!])
      const place = lonLatFromEcef(p)
      expect(place.height).toBeGreaterThan(ground.at(place.lon, place.lat))
      if (place.height - ground.level(place.lon, place.lat) > 0.2) lifted++
      checked++
    }
    expect(checked).toBeGreaterThan(50)
    expect(lifted).toBeLessThan(checked * 0.25)
    // Bridges are part of it: decks standing clear of the ground.
    expect(whole.structures!.indices.length / 3).toBeGreaterThan(1000)
  })

  it('leaves out an area (a site stands there)', () => {
    const frame = tileFrame(tile)
    const corner = (e: number, n: number) => {
      const p = lonLatFromEcef(fromFrame(frame, [e, n, 0]))
      return { lon: p.lon, lat: p.lat }
    }
    const mask = [corner(-150, -150), corner(150, -150), corner(150, 150), corner(-150, 150)]
    const holed = streetMesh(tile, features.roads, ground, colours, mask).mesh!
    expect(holed.indices.length).toBeLessThan(whole.mesh!.indices.length)
    for (let i = 0; i < holed.positions.length / 3; i++) {
      const x = holed.positions[i * 3]!
      const z = holed.positions[i * 3 + 2]!
      expect(Math.abs(x) < 149 && Math.abs(z) < 149).toBe(false)
    }
  }, 60000)

  it('stays inside its tile', () => {
    const mesh = whole.mesh!
    const frame = tileFrame(tile)
    const n = 2 ** tile.z
    for (let i = 0; i < mesh.positions.length / 3; i += 13) {
      const p = lonLatFromEcef(fromFrame(frame, [mesh.positions[i * 3]!, -mesh.positions[i * 3 + 2]!, mesh.positions[i * 3 + 1]!]))
      const u = ((p.lon + 180) / 360) * n - tile.x
      expect(u).toBeGreaterThan(-1e-4)
      expect(u).toBeLessThan(1 + 1e-4)
    }
  })

  it('lays a tile a quarter at a time: each inside its own quarter, together the whole', () => {
    const plan = planStreets(tile, features.roads, ground)!
    const metres = plan.metres
    const area = (polygons: readonly (readonly [number, number][][])[]) => {
      let sum = 0
      for (const polygon of polygons) {
        polygon.forEach((ring, r) => {
          let ringArea = 0
          for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) ringArea += ring[j]![0] * ring[i]![1] - ring[i]![0] * ring[j]![1]
          sum += (r === 0 ? 1 : -1) * Math.abs(ringArea / 2)
        })
      }
      return sum
    }
    let covered = 0
    let triangles = 0
    for (let quarter = 0; quarter < 4; quarter++) {
      const rect = quarterOf(metres, quarter)
      const part = layStreets(plan, colours, { part: rect })
      covered += area(part.cover)
      triangles += part.mesh!.indices.length / 3
      // Each point of it, on the map: within the quarter (to a few centimetres).
      const frame = tileFrame(tile)
      const n = 2 ** tile.z
      for (let i = 0; i < part.mesh!.positions.length / 3; i += 7) {
        const p = lonLatFromEcef(fromFrame(frame, [part.mesh!.positions[i * 3]!, -part.mesh!.positions[i * 3 + 2]!, part.mesh!.positions[i * 3 + 1]!]))
        const φ = (p.lat * Math.PI) / 180
        const x = (((p.lon + 180) / 360) * n - tile.x) * metres
        const y = -(((1 - Math.log(Math.tan(φ) + 1 / Math.cos(φ)) / Math.PI) / 2) * n - tile.y) * metres
        expect(x).toBeGreaterThan(rect.minX - 0.05)
        expect(x).toBeLessThan(rect.maxX + 0.05)
        expect(y).toBeGreaterThan(rect.minY - 0.05)
        expect(y).toBeLessThan(rect.maxY + 0.05)
      }
    }
    // The same ground covered as when laid in one go, to within what the rounding at the quarters' edges leaves.
    const all = area(whole.cover)
    expect(Math.abs(covered - all) / all).toBeLessThan(0.002)
    expect(triangles).toBeGreaterThan(whole.mesh!.indices.length / 3 * 0.9)
  }, 60000)
})
