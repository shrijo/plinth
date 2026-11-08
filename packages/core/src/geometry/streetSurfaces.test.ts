import { describe, expect, it } from 'vitest'
import { regionArea, type MultiPolygon } from './regions.ts'
import { layerStreetPieces, layerStreetSurfaces } from './streetSurfaces.ts'
import type { StreetPiece } from './streets.ts'

const rect = (x0: number, y0: number, x1: number, y1: number): MultiPolygon => [
  [
    [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ],
  ],
]

const piece = (key: string, parts: Partial<StreetPiece>): StreetPiece => ({
  key,
  road: [],
  bike: [],
  parking: [],
  sidewalks: [],
  markings: [],
  crosswalks: [],
  centre: { x: 0, y: 0 },
  shared: false,
  ...parts,
})

describe('layering street surfaces', () => {
  it("cuts a sidewalk where another street's road crosses it", () => {
    const along = piece('a', { road: rect(0, -2, 20, 2), sidewalks: rect(0, 2, 20, 4) })
    const across = piece('b', { road: rect(8, -10, 12, 10) })
    const [a, b] = layerStreetPieces([along, across])
    // 20 x 2 m of sidewalk, less the 4 x 2 m the other road covers.
    expect(regionArea(a!.sidewalks)).toBeCloseTo(32, 3)
    // The road that wins is left as it was.
    expect(b).toBe(across)
  })

  it('leaves surfaces that only touch as they are', () => {
    const street = piece('a', { road: rect(0, -2, 20, 2), sidewalks: [...rect(0, 2, 20, 4), ...rect(0, -4, 20, -2)] })
    const next = piece('b', { road: rect(20, -2, 30, 2), sidewalks: rect(20, 2, 30, 4) })
    const layered = layerStreetPieces([street, next])
    expect(layered[0]).toBe(street)
    expect(layered[1]).toBe(next)
  })

  it('cuts parking lanes where another road lies on them, and keeps paving under roads out', () => {
    const street = piece('a', { road: rect(0, -2, 20, 2), parking: rect(0, 2, 20, 4.5) })
    const zone = piece('z', { road: rect(-5, 3, 25, 12), shared: true })
    const across = piece('b', { road: rect(8, -10, 12, 10) })
    const surfaces = layerStreetSurfaces([street, zone, across])
    expect(regionArea(surfaces.parking)).toBeCloseTo(20 * 2.5 - 4 * 2.5, 3)
    // The paved zone loses what the parking lane and the crossing road cover.
    expect(regionArea(surfaces.paved)).toBeCloseTo(30 * 9 - 20 * 1.5 - 4 * 7 + 4 * 1.5, 3)
  })

  it('paves a crumb of sidewalk stranded in a junction as road', () => {
    // Road all round a 2 x 2 m gap (as the corners of a cluster of junctions leave one).
    const junction = piece('j', { road: [...rect(-10, -10, 10, -1), ...rect(-10, 1, 10, 10), ...rect(-10, -1, -1, 1), ...rect(1, -1, 10, 1)] })
    const crumb = piece('c', {
      road: rect(20, 0, 30, 4),
      sidewalks: [...rect(-1, -1, 1, 1), ...rect(20, 4, 30, 6)],
    })
    const [, layered] = layerStreetPieces([junction, crumb])
    // The 2 x 2 m island inside the junction is road now; the sidewalk along its own road stays.
    expect(regionArea(layered!.sidewalks)).toBeCloseTo(20, 3)
    expect(regionArea(layered!.road)).toBeCloseTo(44, 3)
  })

  it('paves an island made of two pieces of sidewalk as road', () => {
    const junction = piece('j', { road: [...rect(-10, -10, 10, -1), ...rect(-10, 1, 10, 10), ...rect(-10, -1, -1, 1), ...rect(1, -1, 10, 1)] })
    const left = piece('l', { sidewalks: rect(-1, -1, 0, 1) })
    const right = piece('r', { sidewalks: rect(0, -1, 1, 1) })
    const layered = layerStreetPieces([junction, left, right])
    expect(layered[1]!.sidewalks).toHaveLength(0)
    expect(layered[2]!.sidewalks).toHaveLength(0)
  })

  it('paves a scrap of road with sidewalk all round it', () => {
    const square = piece('s', { sidewalks: [...rect(-10, -10, 10, -1), ...rect(-10, 1, 10, 10), ...rect(-10, -1, -1, 1), ...rect(1, -1, 10, 1)] })
    const stub = piece('t', { road: rect(-1, -1, 1, 1) })
    const [, scrap] = layerStreetPieces([square, stub])
    expect(scrap!.road).toHaveLength(0)
    expect(regionArea(scrap!.sidewalks)).toBeCloseTo(4, 3)
  })

  it("keeps a small sidewalk that's part of a large paved area", () => {
    const square = piece('s', { sidewalks: rect(-20, -20, 20, 20) })
    const bit = piece('b', { road: rect(30, -2, 40, 2), sidewalks: rect(-1, -1, 1, 1) })
    const layered = layerStreetPieces([square, bit])
    expect(layered[1]).toBe(bit)
  })
})
