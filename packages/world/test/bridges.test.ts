import { describe, expect, it } from 'vitest'
import { makeGround } from '../src/ground.ts'
import type { RoadFeature, TileFeatures } from '../src/features.ts'
import { streetMesh, type StreetColours } from '../src/streets.ts'
import { lonLatFromEcef, fromFrame } from '../src/geo.ts'
import { tileFrame, tileWidth } from '../src/mesh.ts'
import { DECK, withBridges } from '../src/bridges.ts'
import { DEFAULT_STREET } from '@plinth/core'

/** A flat town at 400 m with a river across the tile's middle, and a street crossing it on a bridge. */
const tile = { z: 14, x: 8580, y: 5737 }
const SIZE = 16
const flat = { tile, size: SIZE, heights: Float32Array.from({ length: SIZE * SIZE }, () => 400) }
const road = (line: number[], extra: Partial<RoadFeature> = {}): RoadFeature => ({
  line: new Float64Array(line),
  kind: 'minor',
  width: 8,
  tunnel: false,
  bridge: false,
  layer: 0,
  name: '',
  oneway: false,
  service: '',
  subclass: '',
  ...extra,
})
const LANDINGS = [0.42, 0.58]
const features: TileFeatures = {
  tile,
  buildings: Array.from({ length: 200 }, () => ({ shape: { outer: new Float64Array([0, 0, 0.001, 0, 0.001, 0.001]), holes: [] }, height: 5, minHeight: 0 })),
  roads: [
    road([0.5, 0.1, 0.5, LANDINGS[0]!]),
    road([0.5, LANDINGS[0]!, 0.5, LANDINGS[1]!], { bridge: true, layer: 1 }),
    road([0.5, LANDINGS[1]!, 0.5, 0.9]),
    // A footway mapped as a bridge of its own beside the street's: part of the same bridge.
    road([0.5025, LANDINGS[0]!, 0.5025, LANDINGS[1]!], { kind: 'path', subclass: 'footway', width: 2, bridge: true, layer: 1 }),
  ],
  areas: [{ shape: { outer: new Float64Array([0.2, 0.45, 0.8, 0.45, 0.8, 0.55, 0.2, 0.55]), holes: [] }, kind: 'water' }],
  waterways: [],
}
const ROAD: [number, number, number] = [0.6, 0.6, 0.6]
const LAND: [number, number, number] = [0.8, 0.75, 0.7]
const colours: StreetColours = {
  road: ROAD,
  bike: ROAD,
  parking: ROAD,
  sidewalk: [0.9, 0.9, 0.9],
  curb: [0.5, 0.5, 0.5],
  marking: [1, 1, 1],
  land: LAND,
}
const same = (a: ArrayLike<number>, i: number, c: readonly number[]) => c.every((v, k) => Math.abs(a[i * 3 + k]! - v) < 1e-6)

describe('bridges in the network', () => {
  it('lands on the street, one node with it, and carries its cross-section on, turned as the bridge is drawn', () => {
    const street = { ...DEFAULT_STREET, sidewalkLeft: 1, sidewalkRight: 3, control: null }
    const ground = {
      nodes: { n0: { id: 'n0', x: 0, y: 0 }, n1: { id: 'n1', x: 0, y: 40 } },
      streets: { s0: { ...street, id: 's0', a: 'n0', b: 'n1' } },
    }
    // Drawn the other way: from beyond the river back to where the street stops.
    const bridges = {
      nodes: { n0: { id: 'n0', x: 0, y: 80 }, n1: { id: 'n1', x: 0, y: 40 } },
      streets: { s0: { ...DEFAULT_STREET, id: 's0', a: 'n0', b: 'n1', control: null } },
    }
    const network = withBridges(ground, bridges, () => false)
    const bridge = Object.values(network.streets).find((s) => s.bridge)!
    expect(bridge.b).toBe('n1')
    expect(Object.keys(network.nodes)).toHaveLength(3)
    // The street's west sidewalk (its left, going north) is the bridge's right (going south).
    expect(bridge.sidewalkRight).toBe(1)
    expect(bridge.sidewalkLeft).toBe(3)
  })
})

describe('street bridges', () => {
  const ground = makeGround([flat], features)
  const metres = tileWidth(tile)
  const n = 2 ** tile.z
  const frame = tileFrame(tile)
  const built = streetMesh(tile, features.roads, ground, colours)
  const mesh = built.mesh!
  /** Every upward face's vertex of a colour, in plan metres across the street (from its middle) and along the tile (v), with its height. */
  const tops = (colour: readonly number[]) => {
    const out: { across: number; v: number; height: number; lon: number; lat: number }[] = []
    for (let i = 0; i < mesh.positions.length / 3; i++) {
      if (mesh.normals[i * 3 + 1]! < 0.99 || !same(mesh.colors!, i, colour)) continue
      const p = lonLatFromEcef(fromFrame(frame, [mesh.positions[i * 3]!, -mesh.positions[i * 3 + 2]!, mesh.positions[i * 3 + 1]!]))
      const u = ((p.lon + 180) / 360) * n - tile.x
      const φ = (p.lat * Math.PI) / 180
      const v = ((1 - Math.log(Math.tan(φ) + 1 / Math.cos(φ)) / Math.PI) / 2) * n - tile.y
      out.push({ across: (u - 0.5) * metres, v, height: p.height, lon: p.lon, lat: p.lat })
    }
    return out
  }
  const road = tops(ROAD).filter((t) => Math.abs(t.across) < 4)

  it('lands on the street with no step: the deck starts at the street’s own level', () => {
    for (const landing of LANDINGS) {
      const near = road.filter((t) => Math.abs((t.v - landing) * metres) < 3)
      expect(near.length).toBeGreaterThan(4)
      const heights = near.map((t) => t.height)
      expect(Math.max(...heights) - Math.min(...heights)).toBeLessThan(0.05)
    }
  })

  it('rises clear of the water between its landings', () => {
    const middle = road.filter((t) => Math.abs(t.v - 0.5) * metres < 5)
    expect(middle.length).toBeGreaterThan(2)
    for (const t of middle) expect(t.height).toBeGreaterThan(ground.surface(t.lon, t.lat) + DECK)
  })

  it('keeps the block fills off the deck where it lands', () => {
    // The fills stand at kerb height: none of them over the carriageway as it goes onto the bridge.
    const fills = tops(LAND).filter((t) => Math.abs(t.across) < 2 && t.v > LANDINGS[0]! && t.v < LANDINGS[0]! + 10 / metres)
    expect(fills).toHaveLength(0)
  })

  it('draws the footway alongside as the same deck, not a slab of its own', () => {
    // Its walkway is the town's pavement, at the deck's level beside the road: no higher than the kerb over it.
    const walk = tops(LAND).filter((t) => t.across > 3 && t.across < 6 && Math.abs(t.v - 0.5) * metres < 5)
    expect(walk.length).toBeGreaterThan(0)
    const deck = Math.max(...road.filter((t) => Math.abs(t.v - 0.5) * metres < 5).map((t) => t.height))
    for (const t of walk) expect(Math.abs(t.height - deck - 0.15)).toBeLessThan(0.1)
  })
})
