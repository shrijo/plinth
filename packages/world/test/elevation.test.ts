import { describe, expect, it } from 'vitest'
import { DEFAULT_STREET, type Street, type StreetNode } from '@plinth/core'
import { CLEARANCE, solveElevation, TUNNEL_COVER } from '../src/elevation.ts'

/** A network from points and the streets between them (`level` 1: a bridge). */
function network(points: Record<string, [number, number]>, links: [string, string, number?][]) {
  const nodes: Record<string, StreetNode> = {}
  for (const [id, [x, y]] of Object.entries(points)) nodes[id] = { id, x, y }
  const streets: Record<string, Street> = {}
  links.forEach(([a, b, level], k) => {
    streets[`s${k}`] = { ...DEFAULT_STREET, id: `s${k}`, a, b, control: null, ...(level ? { level } : {}) }
  })
  return { nodes, streets }
}

const flat = { bed: () => 400, water: () => null, half: () => 4 }

describe('how high streets run', () => {
  // A street west to east; another from the south that crosses over it on a bridge and goes on north.
  const crossing = network(
    { w: [-200, 0], e: [200, 0], far: [0, -300], south: [0, -30], north: [0, 30], on: [0, 300] },
    [
      ['w', 'e'],
      ['far', 'south'],
      ['south', 'north', 1],
      ['north', 'on'],
    ],
  )

  it('lifts a bridge clear of the street it crosses', () => {
    const elevation = solveElevation({ ...crossing, ...flat })
    const deck = elevation.heightOf('s2')
    // Over the street's middle: headroom and the deck's own depth.
    expect(deck(30)).toBeGreaterThanOrEqual(400 + CLEARANCE.street - 0.01)
    // The street under it stays on the ground.
    expect(elevation.heightOf('s0')(200)).toBeCloseTo(400, 3)
    expect(elevation.structures).toHaveLength(1)
    expect(elevation.structures[0]!.landings.sort()).toEqual(['north', 'south'])
  })

  it('brings the streets up to it on ramps no steeper than a road', () => {
    const elevation = solveElevation({ ...crossing, ...flat })
    const approach = elevation.heightOf('s1')
    // At the landing the street is as high as the deck there, and it starts back on the ground.
    expect(approach(270)).toBeCloseTo(elevation.heightOf('s2')(0), 3)
    expect(approach(270)).toBeGreaterThan(402)
    expect(approach(0)).toBeCloseTo(400, 3)
    let steepest = 0
    for (let s = 0; s < 270; s += 5) steepest = Math.max(steepest, Math.abs(approach(s + 5) - approach(s)) / 5)
    expect(steepest).toBeLessThan(0.08)
    const deck = elevation.heightOf('s2')
    for (let s = 0; s < 60; s += 5) steepest = Math.max(steepest, Math.abs(deck(s + 5) - deck(s)) / 5)
    expect(steepest).toBeLessThan(0.08)
  })

  it('leaves a bridge level from bank to bank when nothing under it needs more', () => {
    // A river 20 m wide whose banks stand well over it.
    const river = network({ a: [-100, 0], west: [-15, 0], east: [15, 0], b: [100, 0] }, [
      ['a', 'west'],
      ['west', 'east', 1],
      ['east', 'b'],
    ])
    const elevation = solveElevation({ ...river, ...flat, water: (x) => (Math.abs(x) < 10 ? 396 : null) })
    const deck = elevation.heightOf('s1')
    for (let s = 0; s <= 30; s += 3) expect(deck(s)).toBeCloseTo(400, 2)
    expect(elevation.riseOf('s0')).toEqual([0, 0])
  })

  it('arches a bridge whose banks lie low over the water', () => {
    const river = network({ a: [-100, 0], west: [-15, 0], east: [15, 0], b: [100, 0] }, [
      ['a', 'west'],
      ['west', 'east', 1],
      ['east', 'b'],
    ])
    const elevation = solveElevation({ ...river, ...flat, water: (x) => (Math.abs(x) < 10 ? 399.5 : null) })
    expect(elevation.heightOf('s1')(15)).toBeGreaterThan(401)
  })

  it('gives a footbridge over a street a deck of its own, its ends on the ground', () => {
    const street = network({ w: [-100, 0], e: [100, 0] }, [['w', 'e']])
    const elevation = solveElevation({
      ...street,
      ...flat,
      spans: [{ points: [{ x: 0, y: -40 }, { x: 0, y: 40 }], level: 1, gradient: 0.35 }],
    })
    const span = elevation.spans[0]!
    expect(span(40)).toBeGreaterThanOrEqual(400 + CLEARANCE.street - 0.01)
    expect(span(0)).toBeCloseTo(400, 3)
    expect(span(80)).toBeCloseTo(400, 3)
  })

  // A street west to east; another from the south that goes under it in a tunnel (a level below the ground) and on north.
  const under = network(
    { w: [-200, 0], e: [200, 0], far: [0, -300], south: [0, -40], north: [0, 40], on: [0, 300] },
    [
      ['w', 'e'],
      ['far', 'south'],
      ['south', 'north', -1],
      ['north', 'on'],
    ],
  )

  it('takes a tunnel on flat land down under what crosses it, the streets into it sinking to its mouths', () => {
    const elevation = solveElevation({ ...under, ...flat })
    const road = elevation.heightOf('s2')
    // Under the street's middle: its headroom and roof under the street, and the ground over it.
    expect(road(40)).toBeLessThanOrEqual(400 - CLEARANCE.street + 0.01)
    expect(road(40)).toBeLessThanOrEqual(400 - TUNNEL_COVER + 0.01)
    // The street over it stays on the ground.
    expect(elevation.heightOf('s0')(200)).toBeCloseTo(400, 3)
    expect(elevation.structures).toHaveLength(1)
    expect(elevation.structures[0]!.level).toBe(-1)
    expect(elevation.structures[0]!.landings.sort()).toEqual(['north', 'south'])
    // Already well down at its mouths, and the street leading in on its way down from further back: a cutting.
    expect(road(0)).toBeLessThan(400 - 3)
    const approach = elevation.heightOf('s1')
    expect(approach(260)).toBeCloseTo(road(0), 2)
    expect(elevation.sunkOf('s1')(260)).toBeGreaterThan(3)
    expect(approach(100)).toBeCloseTo(400, 3)
    expect(elevation.sunkOf('s1')(100)).toBe(0)
    // Never steeper than a street can be.
    let steepest = 0
    for (let s = 0; s < 260; s += 5) steepest = Math.max(steepest, Math.abs(approach(s + 5) - approach(s)) / 5)
    for (let s = 0; s < 80; s += 5) steepest = Math.max(steepest, Math.abs(road(s + 5) - road(s)) / 5)
    expect(steepest).toBeLessThan(0.08)
    // And nothing is lifted for it.
    expect(elevation.riseOf('s1')).toEqual([0, 0])
  })

  it('runs a tunnel under a hill in level: nothing over it needs it lower', () => {
    // A ridge 40 m high between the portals, the land flat beyond them.
    const hill = (_: number, y: number) => 400 + Math.max(0, 40 - Math.abs(y)) * 4
    const elevation = solveElevation({ ...under, ...flat, bed: hill })
    const road = elevation.heightOf('s2')
    for (let s = 0; s <= 80; s += 8) expect(road(s)).toBeCloseTo(400, 2)
    expect(elevation.sunkOf('s1')(260)).toBe(0)
    expect(elevation.heightOf('s1')(260)).toBeCloseTo(400, 3)
  })

  it('takes a tunnel under water well under its surface', () => {
    const elevation = solveElevation({ ...under, ...flat, water: (_, y) => (Math.abs(y) < 10 ? 399 : null) })
    expect(elevation.heightOf('s2')(40)).toBeLessThan(399 - 8)
  })
})
