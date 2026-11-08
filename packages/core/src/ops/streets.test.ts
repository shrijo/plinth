import { describe, expect, it } from 'vitest'
import { PlinthDocument } from '../document.ts'
import { pointInRegion, regionArea } from '../geometry/regions.ts'
import { mergeStreetRegions, streetGeometry, type StreetGeometry } from '../geometry/streets.ts'
import type { Snapshot as SnapshotOf } from '../model.ts'

/** The street pieces merged, for measuring. */
const merged = (s: SnapshotOf) => {
  const g: StreetGeometry = streetGeometry(s)
  return {
    ...mergeStreetRegions(g),
    markings: g.pieces.flatMap((p) => p.markings),
    crosswalks: g.pieces.flatMap((p) => p.crosswalks),
  }
}
import { dist } from '../math.ts'
import type { Snapshot } from '../model.ts'
import { deleteStreets, insertStreet, setStreetCurve, setStreetProps } from './streets.ts'

const degree = (s: Snapshot, x: number, y: number) => {
  const node = Object.values(s.streetNodes).find((n) => dist(n, { x, y }) < 1e-6)
  return node ? Object.values(s.streets).filter((st) => st.a === node.id || st.b === node.id).length : 0
}

describe('streets', () => {
  it('joins a street that ends on another (T)', () => {
    const doc = PlinthDocument.createEmpty()
    doc.transact((tx) => insertStreet(tx, { x: -50, y: 0 }, { x: 50, y: 0 }))
    doc.transact((tx) => insertStreet(tx, { x: 0, y: 0 }, { x: 0, y: 40 }))
    const s = doc.getSnapshot()
    expect(Object.keys(s.streets)).toHaveLength(3)
    expect(degree(s, 0, 0)).toBe(3)
  })

  it('joins crossing streets at the crossing (X)', () => {
    const doc = PlinthDocument.createEmpty()
    doc.transact((tx) => insertStreet(tx, { x: -50, y: 0 }, { x: 50, y: 0 }))
    doc.transact((tx) => insertStreet(tx, { x: 10, y: -30 }, { x: 10, y: 30 }))
    const s = doc.getSnapshot()
    expect(Object.keys(s.streets)).toHaveLength(4)
    expect(degree(s, 10, 0)).toBe(4)
  })

  it('splits a curved street exactly where another meets it', () => {
    const doc = PlinthDocument.createEmpty()
    const [curved] = doc.transact((tx) => insertStreet(tx, { x: -40, y: 0 }, { x: 40, y: 0 }, {}, { x: 0, y: 40 }))
    expect(curved).toBeDefined()
    // The curve's middle is at (0, 20); a street across it splits it there.
    doc.transact((tx) => insertStreet(tx, { x: 0, y: -10 }, { x: 0, y: 60 }))
    const s = doc.getSnapshot()
    expect(Object.keys(s.streets)).toHaveLength(4)
    const node = Object.values(s.streetNodes).find((n) => Math.abs(n.x) < 0.01 && Math.abs(n.y - 20) < 0.05)
    expect(node).toBeDefined()
    expect(Object.values(s.streets).filter((st) => st.control).length).toBe(2)
  })

  it('heals a straight street when the street that split it goes', () => {
    const doc = PlinthDocument.createEmpty()
    doc.transact((tx) => insertStreet(tx, { x: -50, y: 0 }, { x: 50, y: 0 }))
    const branch = doc.transact((tx) => insertStreet(tx, { x: 0, y: 0 }, { x: 0, y: 40 }))
    doc.transact((tx) => deleteStreets(tx, branch))
    const s = doc.getSnapshot()
    expect(Object.keys(s.streets)).toHaveLength(1)
    expect(Object.keys(s.streetNodes)).toHaveLength(2)
  })

  it('builds road, sidewalks, lanes and crosswalks', () => {
    const doc = PlinthDocument.createEmpty()
    const [id] = doc.transact((tx) => insertStreet(tx, { x: 0, y: 0 }, { x: 100, y: 0 }))
    let g = merged(doc.getSnapshot())
    // Two 3.25 m lanes, 2 m sidewalks each side, 100 m long.
    expect(regionArea(g.road)).toBeCloseTo(6.5 * 100)
    expect(regionArea(g.sidewalks)).toBeCloseTo(4 * 100)
    expect(g.markings.length).toBe(1)

    doc.transact((tx) =>
      setStreetProps(tx, [id!], { lanes: 4, bikeLeft: 1.5, parkingRight: 2.5, crosswalkA: true }),
    )
    g = merged(doc.getSnapshot())
    expect(regionArea(g.road)).toBeCloseTo((13 + 1.5 + 2.5) * 100)
    expect(regionArea(g.bike)).toBeCloseTo(1.5 * 100)
    expect(regionArea(g.parking)).toBeCloseTo(2.5 * 100)
    expect(g.crosswalks.length).toBeGreaterThan(5)
  })

  it('fills a crossing with rounded kerbs and wraps the sidewalks round them', () => {
    const doc = PlinthDocument.createEmpty()
    doc.transact((tx) => insertStreet(tx, { x: -50, y: 0 }, { x: 50, y: 0 }))
    doc.transact((tx) => insertStreet(tx, { x: 0, y: -50 }, { x: 0, y: 50 }))
    const g = merged(doc.getSnapshot())
    // Two 100 m roads 6.5 m wide crossing (the middle square counts once), plus four kerb corners of
    // radius r: r² (1 - π/4) each. The radius is sized to the narrowest road: 0.9 of its half width.
    const r = 3.25 * 0.9
    const corners = 4 * r ** 2 * (1 - Math.PI / 4)
    const area = regionArea(g.road)
    expect(area).toBeGreaterThan(2 * 6.5 * 100 - 6.5 * 6.5 + corners * 0.95)
    expect(area).toBeLessThan(2 * 6.5 * 100 - 6.5 * 6.5 + corners * 1.02)
    // Just inside where a square kerb corner would be is road now, not sidewalk.
    expect(pointInRegion({ x: 3.6, y: 3.6 }, g.road)).toBe(true)
    expect(pointInRegion({ x: 3.6, y: 3.6 }, g.sidewalks)).toBe(false)
    // Four sidewalk corners, each one piece.
    expect(g.sidewalks).toHaveLength(4)
  })

  it('draws a bend as one curve that keeps its width', () => {
    const doc = PlinthDocument.createEmpty()
    doc.transact((tx) => insertStreet(tx, { x: 50, y: 0 }, { x: 0, y: 0 }))
    doc.transact((tx) => insertStreet(tx, { x: 0, y: 0 }, { x: 0, y: 50 }))
    const g = merged(doc.getSnapshot())
    expect(g.road).toHaveLength(1)
    // Inside and outside sidewalks, each continuous round the bend.
    expect(g.sidewalks).toHaveLength(2)
    // The outside of the bend is round, not a square corner.
    expect(pointInRegion({ x: -3, y: -3 }, g.road)).toBe(false)
    // Halfway round, the road is still 6.5 m wide: the inside kerb has radius r (0.9 of the road's half
    // width) round a centre at (3.25 + r, 3.25 + r), the outside r + 6.5.
    const r = 3.25 * 0.9
    const c = 3.25 + r
    const diagonal = (d: number) => ({ x: c - d / Math.SQRT2, y: c - d / Math.SQRT2 })
    expect(pointInRegion(diagonal(r + 0.2), g.road)).toBe(true)
    expect(pointInRegion(diagonal(r + 6.3), g.road)).toBe(true)
    expect(pointInRegion(diagonal(r + 6.7), g.road)).toBe(false)
  })

  it('merges a junction with its streets at awkward coordinates', () => {
    // From the editor: a T whose side street was snapped onto the main one.
    const doc = PlinthDocument.createEmpty()
    doc.transact((tx) => insertStreet(tx, { x: -94.25, y: 0.5 }, { x: 45.4, y: 0.5 }))
    doc.transact((tx) => insertStreet(tx, { x: 1.746200508474275, y: 0.5 }, { x: 1.746200508474275, y: -48.35 }))
    const g = merged(doc.getSnapshot())
    expect(g.road).toHaveLength(1)
    // The north sidewalk and the two corners either side of the side street.
    expect(g.sidewalks).toHaveLength(3)
  })

  it('tapers where a street gets wider instead of jumping', () => {
    const doc = PlinthDocument.createEmpty()
    doc.transact((tx) => insertStreet(tx, { x: -50, y: 0 }, { x: 0, y: 0 }))
    const [wide] = doc.transact((tx) => insertStreet(tx, { x: 0, y: 0 }, { x: 50, y: 0 }))
    doc.transact((tx) => setStreetProps(tx, [wide!], { bikeRight: 1.8 }))
    const g = merged(doc.getSnapshot())
    expect(g.road).toHaveLength(1)
    // At the joint the right edge is halfway between 3.25 and 5.05.
    expect(pointInRegion({ x: 0, y: -4.0 }, g.road)).toBe(true)
    expect(pointInRegion({ x: 0, y: -4.3 }, g.road)).toBe(false)
  })

  it('bends and straightens a street', () => {
    const doc = PlinthDocument.createEmpty()
    const [id] = doc.transact((tx) => insertStreet(tx, { x: 0, y: 0 }, { x: 100, y: 0 }))
    doc.transact((tx) => setStreetCurve(tx, id!, { x: 50, y: 40 }))
    expect(streetGeometry(doc.getSnapshot()).centreLines.get(id!)!.length).toBeGreaterThan(2)
    doc.transact((tx) => setStreetCurve(tx, id!, null))
    expect(streetGeometry(doc.getSnapshot()).centreLines.get(id!)!.length).toBe(2)
  })
})
