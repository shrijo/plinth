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
})
