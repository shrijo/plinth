import { describe, expect, it } from 'vitest'
import { STREET_TYPES, type StreetProps, type Vec2 } from '@plinth/core'
import { tidyNetwork } from '../src/network.ts'

const residential: StreetProps = { ...STREET_TYPES.residential.props }
const oneway = (kind: keyof typeof STREET_TYPES, lanes = 1): StreetProps => ({ ...STREET_TYPES[kind].props, oneway: true, lanes })
const line = (points: [number, number][], props = residential) => ({ points: points.map(([x, y]): Vec2 => ({ x, y })), props })

/** The streets meeting at a point (within half a metre). */
const at = (network: ReturnType<typeof tidyNetwork>, x: number, y: number) =>
  Object.values(network.streets).filter((s) =>
    [network.nodes[s.a]!, network.nodes[s.b]!].some((n) => Math.hypot(n.x - x, n.y - y) < 0.5),
  )

describe('tidying map data into a street network', () => {
  it('makes a junction where two streets cross with no shared point', () => {
    const network = tidyNetwork([
      line([
        [-50, 0],
        [50, 0],
      ]),
      line([
        [0, -50],
        [0, 50],
      ]),
    ])
    expect(at(network, 0, 0)).toHaveLength(4)
  })

  it('joins a street ending on another, and one stopping at its kerb', () => {
    const network = tidyNetwork([
      line([
        [-50, 0],
        [50, 0],
      ]),
      // Ends on the line, between its points.
      line([
        [-20, 40],
        [-20, 0.3],
      ]),
      // Heads straight for it and stops at the kerb, 4.5 m from its middle.
      line([
        [20, -40],
        [20, -4.5],
      ]),
    ])
    expect(at(network, -20, 0)).toHaveLength(3)
    expect(at(network, 20, 0)).toHaveLength(3)
  })

  it("doesn't join a street passing alongside the end of another", () => {
    // A dead end 5 m off another street's side, running parallel to it: no junction.
    const network = tidyNetwork([
      line([
        [-50, 0],
        [50, 0],
      ]),
      line([
        [-40, 5],
        [-10, 5],
        [-10, 40],
      ]),
    ])
    expect(at(network, -40, 5)).toHaveLength(1)
    expect(Object.values(network.nodes).some((n) => Math.abs(n.y) < 0.05 && Math.abs(n.x + 40) < 1)).toBe(false)
  })

  it('draws a street mapped twice once, keeping the greater', () => {
    const network = tidyNetwork([
      line([
        [-100, 0],
        [100, 0],
      ]),
      line(
        [
          [-50, 0],
          [-20, 1.5],
          [20, 1.5],
          [50, 0],
        ],
        { ...STREET_TYPES.service.props },
      ),
    ])
    const kinds = Object.values(network.streets).map((s) => s.kind)
    expect(kinds).not.toContain('service')
    expect(kinds).toContain('residential')
  })

  it('takes the sidewalks out of the middle of a divided road, all along it', () => {
    const props = oneway('primary')
    const network = tidyNetwork([
      // Two carriageways 12 m apart, each drawn in its direction of travel, one in several pieces.
      line(
        [
          [-100, 6],
          [-30, 6],
          [10, 6],
          [100, 6],
        ],
        props,
      ),
      line(
        [
          [100, -6],
          [-100, -6],
        ],
        props,
      ),
    ])
    for (const street of Object.values(network.streets)) {
      const y = network.nodes[street.a]!.y
      // The north one runs east: the middle is on its right. The south one runs west: also on its right.
      expect(street.sidewalkRight).toBe(0)
      expect(street.sidewalkLeft).toBeGreaterThan(0)
      expect(Math.abs(y)).toBeCloseTo(6)
    }
  })

  it('keeps the sidewalks of one-way streets a block apart', () => {
    const network = tidyNetwork([
      line(
        [
          [-100, 0],
          [100, 0],
        ],
        oneway('residential'),
      ),
      line(
        [
          [100, -26],
          [-100, -26],
        ],
        oneway('residential'),
      ),
    ])
    for (const street of Object.values(network.streets)) {
      expect(street.sidewalkLeft).toBeGreaterThan(0)
      expect(street.sidewalkRight).toBeGreaterThan(0)
    }
  })

  it('keeps the sidewalks between two streets running close together (layered, they pave the space between)', () => {
    const network = tidyNetwork([
      line([
        [-100, 0],
        [100, 0],
      ]),
      line(
        [
          [-100, 5],
          [100, 5],
        ],
        { ...STREET_TYPES.service.props, sidewalkLeft: 1.5, sidewalkRight: 1.5 },
      ),
    ])
    for (const street of Object.values(network.streets)) {
      expect(street.sidewalkLeft).toBeGreaterThan(0)
      expect(street.sidewalkRight).toBeGreaterThan(0)
    }
  })

  it('keeps the sidewalks in a narrow median of a divided road', () => {
    const props = oneway('primary')
    // Carriageways 7 m apart: a median under 4 m, narrower than two 3 m sidewalks.
    const network = tidyNetwork([
      line(
        [
          [-100, 3.5],
          [100, 3.5],
        ],
        props,
      ),
      line(
        [
          [100, -3.5],
          [-100, -3.5],
        ],
        props,
      ),
    ])
    for (const street of Object.values(network.streets)) expect(street.sidewalkRight).toBeGreaterThan(0)
  })

  it('puts the sidewalks where footways are mapped alongside, and the road out to meet them', () => {
    // A residential street (2.75 m either side of its middle) with footways 8 m out on both sides.
    const network = tidyNetwork([line([[-100, 0], [100, 0]])], {
      footways: [
        [{ x: -100, y: 8 }, { x: 100, y: 8 }],
        [{ x: 100, y: -8 }, { x: -100, y: -8 }],
      ],
    })
    for (const street of Object.values(network.streets)) {
      const road = (street.lanes * street.laneWidth) / 2
      const left = road + street.bikeLeft + street.parkingLeft
      const right = road + street.bikeRight + street.parkingRight
      // The footway runs down the middle of the sidewalk.
      expect(left + street.sidewalkLeft / 2).toBeCloseTo(8, 1)
      expect(right + street.sidewalkRight / 2).toBeCloseTo(8, 1)
      expect(left).toBeGreaterThan(5)
    }
  })

  it("leaves a street as it is where a footway runs along only a little of it, or belongs to the street beyond", () => {
    const network = tidyNetwork(
      [
        line([[-100, 0], [100, 0]]),
        // Another street 14 m off, with its own footway just beyond it.
        line([[-100, 14], [100, 14]]),
      ],
      {
        footways: [
          // Along 30 m of 200.
          [{ x: 0, y: -7 }, { x: 30, y: -7 }],
          [{ x: -100, y: 19 }, { x: 100, y: 19 }],
        ],
      },
    )
    const street = Object.values(network.streets).find((s) => network.nodes[s.a]!.y === 0)!
    expect(street.parkingLeft).toBe(0)
    expect(street.parkingRight).toBe(0)
    expect(street.laneWidth).toBe(STREET_TYPES.residential.props.laneWidth)
  })

  it('fits kerbs and sidewalks to surveyed surfaces, which win over footways', () => {
    const ring = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [
      { x: x0, y: y0 },
      { x: x1, y: y0 },
      { x: x1, y: y1 },
      { x: x0, y: y1 },
    ]
    const network = tidyNetwork([line([[-100, 0], [100, 0]])], {
      roadAreas: [ring(-100, -3.6, 100, 3.6)],
      sidewalkAreas: [ring(-100, 3.6, 100, 5.6), ring(-100, -5.6, 100, -3.6)],
      // A footway much further out: the surveyed surfaces decide, not it.
      footways: [[{ x: -100, y: 9 }, { x: 100, y: 9 }]],
    })
    for (const street of Object.values(network.streets)) {
      const kerb = (street.lanes * street.laneWidth) / 2 + street.parkingLeft
      expect(kerb).toBeGreaterThan(3.3)
      expect(kerb).toBeLessThan(3.9)
      expect(street.sidewalkLeft).toBeGreaterThan(1.6)
      expect(street.sidewalkLeft).toBeLessThan(2.4)
      expect(street.sidewalkRight).toBeGreaterThan(1.6)
      expect(street.sidewalkRight).toBeLessThan(2.4)
    }
  })
})
