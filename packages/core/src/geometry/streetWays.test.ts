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

  it('makes a junction where the cross-section changes', () => {
    const s = draw([
      [0, 0],
      [40, 0],
    ])
    const doc = PlinthDocument.createEmpty()
    doc.transact((tx) => {
      insertStreet(tx, { x: 0, y: 0 }, { x: 40, y: 0 })
      insertStreet(tx, { x: 40, y: 0 }, { x: 80, y: 0 }, { lanes: 4 })
    })
    expect(junctions(s)).toBe(0)
    expect(junctions(doc.getSnapshot())).toBe(1)
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
