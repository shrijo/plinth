import { describe, expect, it } from 'vitest'
import { PlinthDocument } from '../document.ts'
import { insertStreet, setStreetProps } from '../ops/streets.ts'
import { STREET_TYPES } from '../streetTypes.ts'
import { streetGeometry } from './streets.ts'

/** A street drawn through points, as the street tool draws one. */
function draw(points: [number, number][], props = {}) {
  const doc = PlinthDocument.createEmpty()
  doc.transact((tx) => {
    for (let i = 0; i + 1 < points.length; i++) {
      insertStreet(tx, { x: points[i]![0], y: points[i]![1] }, { x: points[i + 1]![0], y: points[i + 1]![1] }, props)
    }
  })
  return doc.getSnapshot()
}

const junctions = (s: ReturnType<typeof draw>) => streetGeometry(s).pieces.filter((p) => p.key.startsWith('junction')).length

describe('streets as ways', () => {
  it('runs through gentle bends as one street: no junction, one unbroken middle line', () => {
    const s = draw([
      [0, 0],
      [40, 0],
      [80, 12],
      [120, 30],
    ])
    expect(Object.keys(s.streets)).toHaveLength(3)
    expect(junctions(s)).toBe(0)
    const pieces = streetGeometry(s).pieces
    expect(pieces).toHaveLength(1)
    // The default street has two lanes: its middle line is solid, one band along the whole way.
    expect(pieces[0]!.markings).toHaveLength(1)
  })

  it('turns a sharp corner with a junction', () => {
    const s = draw([
      [0, 0],
      [40, 0],
      [40, 40],
    ])
    expect(junctions(s)).toBe(1)
  })

  it('carries on through a change of cross-section, tapering from one to the other', () => {
    const doc = PlinthDocument.createEmpty()
    doc.transact((tx) => {
      insertStreet(tx, { x: 0, y: 0 }, { x: 40, y: 0 }, { lanes: 2, laneWidth: 3, sidewalkLeft: 0, sidewalkRight: 2 })
      insertStreet(tx, { x: 40, y: 0 }, { x: 80, y: 0 }, { lanes: 4, laneWidth: 3, sidewalkLeft: 2, sidewalkRight: 2 })
    })
    const s = doc.getSnapshot()
    expect(junctions(s)).toBe(0)
    const pieces = streetGeometry(s).pieces
    expect(pieces).toHaveLength(1)
    const piece = pieces[0]!
    // The road widens from two lanes to four, gradually, around the change.
    const halfWidth = (x: number) => Math.max(...piece.road[0]![0]!.filter(([px]) => Math.abs(px - x) < 1e-6).map(([, y]) => Math.abs(y)))
    expect(halfWidth(0)).toBeCloseTo(3)
    expect(halfWidth(80)).toBeCloseTo(6)
    const xs = piece.road[0]![0]!.map(([x]) => x)
    // The taper starts before the change and ends after it.
    expect(xs.some((x) => x > 15 && x < 39)).toBe(true)
    expect(xs.some((x) => x > 41 && x < 65)).toBe(true)
    // The sidewalk on the right runs unbroken; the one on the left starts at the change, tapering in.
    expect(piece.sidewalks).toHaveLength(2)
    const left = piece.sidewalks.find((polygon) => polygon[0]!.some(([, y]) => y > 3))!
    const start = Math.min(...left[0]!.map(([x]) => x))
    expect(start).toBeGreaterThan(15)
    expect(start).toBeLessThan(40)
  })

  it('keeps lane lines off the taper', () => {
    const doc = PlinthDocument.createEmpty()
    doc.transact((tx) => {
      insertStreet(tx, { x: 0, y: 0 }, { x: 40, y: 0 }, { lanes: 2, laneWidth: 3 })
      insertStreet(tx, { x: 40, y: 0 }, { x: 80, y: 0 }, { lanes: 4, laneWidth: 3 })
    })
    const piece = streetGeometry(doc.getSnapshot()).pieces[0]!
    for (const mark of piece.markings) {
      const xs = mark.map((p) => p.x)
      const [x0, x1] = [Math.min(...xs), Math.max(...xs)]
      // No line runs through the middle of the change.
      expect(x1 < 38 || x0 > 42).toBe(true)
    }
  })

  it('joins streets drawn in opposite directions with mirrored sides as one', () => {
    const doc = PlinthDocument.createEmpty()
    doc.transact((tx) => {
      insertStreet(tx, { x: 0, y: 0 }, { x: 40, y: 0 }, { sidewalkLeft: 3, sidewalkRight: 1 })
      // Drawn back towards the first: its right is the first's left.
      insertStreet(tx, { x: 80, y: 0 }, { x: 40, y: 0 }, { sidewalkLeft: 1, sidewalkRight: 3 })
    })
    expect(junctions(doc.getSnapshot())).toBe(0)
  })

  it('leaves the middle line out on a one-way street', () => {
    const s = draw(
      [
        [0, 0],
        [60, 0],
      ],
      { oneway: true },
    )
    const markings = streetGeometry(s).pieces[0]!.markings
    // Two lanes one way: a dashed line between them (several dashes), no solid band.
    expect(markings.length).toBeGreaterThan(3)
  })

  it('paves a living street as one surface, without sidewalks or lines', () => {
    const s = draw(
      [
        [0, 0],
        [60, 0],
      ],
      STREET_TYPES.living_street.props,
    )
    const piece = streetGeometry(s).pieces[0]!
    expect(piece.shared).toBe(true)
    expect(piece.sidewalks).toHaveLength(0)
    expect(piece.markings).toHaveLength(0)
  })

  it('ends a way where a bridge lands: the deck is a piece of its own, edge to edge with the street', () => {
    const doc = PlinthDocument.createEmpty()
    doc.transact((tx) => {
      insertStreet(tx, { x: 0, y: 0 }, { x: 40, y: 0 })
      insertStreet(tx, { x: 40, y: 0 }, { x: 100, y: 4 }, { bridge: true })
      insertStreet(tx, { x: 100, y: 4 }, { x: 140, y: 4 })
    })
    const pieces = streetGeometry(doc.getSnapshot()).pieces
    const streets = pieces.filter((p) => p.key.startsWith('street'))
    expect(streets).toHaveLength(3)
    const decks = streets.filter((p) => p.bridge)
    expect(decks).toHaveLength(1)
    // The deck runs between its landings, along its own centre line.
    const line = decks[0]!.line!
    expect(line[0]!.x).toBeGreaterThan(39)
    expect(line[0]!.x).toBeLessThan(45)
    expect(line[line.length - 1]!.x).toBeGreaterThan(95)
    expect(line[line.length - 1]!.x).toBeLessThan(101)
    // Where it lands, the junction is on the ground; the deck carries the street's lines on.
    expect(pieces.filter((p) => p.key.startsWith('junction')).every((p) => !p.bridge)).toBe(true)
    expect(decks[0]!.markings.length).toBeGreaterThan(0)
  })

  it('keeps a bridge flag through the file format', () => {
    const doc = PlinthDocument.createEmpty()
    doc.transact((tx) => insertStreet(tx, { x: 0, y: 0 }, { x: 40, y: 0 }, { bridge: true }))
    expect(Object.values(doc.getSnapshot().streets)[0]!.bridge).toBe(true)
  })

  it('keeps a type and one-way through editing', () => {
    const doc = PlinthDocument.createEmpty()
    doc.transact((tx) => insertStreet(tx, { x: 0, y: 0 }, { x: 40, y: 0 }))
    const id = Object.keys(doc.getSnapshot().streets)[0]!
    doc.transact((tx) => setStreetProps(tx, [id], { ...STREET_TYPES.primary.props, oneway: true }))
    const street = doc.getSnapshot().streets[id]!
    expect(street.kind).toBe('primary')
    expect(street.oneway).toBe(true)
  })
})
