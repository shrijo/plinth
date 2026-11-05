import { createId } from '../ids.ts'
import type { Vec2 } from '../math.ts'
import { DEFAULT_STREET, type Id, type StreetProps } from '../model.ts'
import type { Tx } from '../tx.ts'

/**
 * "Metropolis": a city the size of Manhattan, for stress tests. A grid of
 * avenues and cross streets about 21 km long and 3.5 km wide, a large park
 * in the middle, and tens of thousands of buildings lining the blocks:
 * mostly four to eight storeys, rising to towers of 30 to 90 floors
 * downtown and in midtown.
 *
 * Built lean: every building is a ground floor, one typical upper floor and
 * a run of copies of it for the floors above, and each row of windows along
 * a facade is one record, so even this many buildings stay a manageable
 * document. Everything is written directly, without the tidying
 * that drawing does; the grid is laid out so nothing needs it.
 */

export const METROPOLIS_NAME = 'Metropolis'

export interface MetropolisOptions {
  /** Cross streets (rows of blocks, south to north). Manhattan has about 200. */
  rows?: number
  /** Avenues (columns of blocks are one fewer). Manhattan has about 12. */
  avenues?: number
  seed?: number
}

const AVENUE_SPACING = 270
const STREET_SPACING = 80
const GROUND_HEIGHT = 4.2
const FLOOR_HEIGHT = 3.3

/** A window or door and how far apart its row is spaced. */
interface Glazing {
  typeId: string
  width: number
  height: number
  sill: number
  spacing: number
}
/** Keeps rows of windows clear of the corners. */
const EDGE = 0.6
const DOOR = { typeId: 'door-glass', width: 1.1, height: 2.6, sill: 0 }
const DOUBLE_DOOR = { typeId: 'door-double', width: 2, height: 2.8, sill: 0 }
const SHOPFRONT: Glazing = { typeId: 'window-tall', width: 2.4, height: 2.9, sill: 0.45, spacing: 3 }
/** Windows of ordinary buildings, one style per building. */
const WINDOWS: readonly Glazing[] = [
  { typeId: 'window', width: 1.2, height: 1.6, sill: 0.85, spacing: 2.4 },
  { typeId: 'window-casement', width: 1.4, height: 1.7, sill: 0.8, spacing: 3 },
  { typeId: 'window-grid', width: 1.5, height: 1.8, sill: 0.7, spacing: 2.6 },
  { typeId: 'window-tall', width: 1.1, height: 2.3, sill: 0.3, spacing: 2.2 },
]
/** Towers: nearly floor-to-ceiling glass, close together. */
const TOWER_WINDOWS: Glazing = { typeId: 'window-tall', width: 1.5, height: 2.6, sill: 0.25, spacing: 1.75 }

const AVENUE: StreetProps = {
  ...DEFAULT_STREET,
  lanes: 4,
  laneWidth: 3.2,
  parkingLeft: 2.4,
  parkingRight: 2.4,
  sidewalkLeft: 4.5,
  sidewalkRight: 4.5,
}
const STREET: StreetProps = {
  ...DEFAULT_STREET,
  lanes: 2,
  laneWidth: 3,
  parkingLeft: 2.2,
  parkingRight: 2.2,
  sidewalkLeft: 3,
  sidewalkRight: 3,
}
/** Every tenth cross street is a wide one. */
const WIDE_STREET: StreetProps = { ...STREET, lanes: 4, laneWidth: 3.2, sidewalkLeft: 4, sidewalkRight: 4 }

const halfWidth = (s: StreetProps) =>
  (s.lanes * s.laneWidth) / 2 + Math.max(s.bikeLeft + s.parkingLeft + s.sidewalkLeft, s.bikeRight + s.parkingRight + s.sidewalkRight)

function seeded(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Fills an empty document with Metropolis. Returns how many buildings it made. */
export function buildMetropolis(tx: Tx, options: MetropolisOptions = {}): number {
  const rows = options.rows ?? 200
  const avenues = options.avenues ?? 12
  const random = seeded(options.seed ?? 1811)
  tx.setMeta({ name: METROPOLIS_NAME })

  const width = (avenues - 1) * AVENUE_SPACING
  const length = rows * STREET_SPACING
  // The park: three blocks wide, a quarter of the city long, a little north of the middle.
  const park = {
    col0: Math.floor((avenues - 1) / 2) - 1,
    col1: Math.floor((avenues - 1) / 2) + 2,
    row0: Math.round(rows * 0.55),
    row1: Math.round(rows * 0.8),
  }
  const inPark = (col: number, row: number) => col >= park.col0 && col < park.col1 && row >= park.row0 && row < park.row1
  const streetProps = (row: number) => (row % 10 === 0 ? WIDE_STREET : STREET)

  // Street points at every crossing.
  const nodes: Id[][] = []
  for (let col = 0; col < avenues; col++) {
    nodes.push([])
    for (let row = 0; row <= rows; row++) {
      const id = createId()
      tx.putStreetNode({ id, x: col * AVENUE_SPACING - width / 2, y: row * STREET_SPACING - length / 2 })
      nodes[col]!.push(id)
    }
  }
  const degree = new Map<Id, number>()
  const streets: [Id, Id, StreetProps][] = []
  const addStreet = (a: Id, b: Id, props: StreetProps) => {
    streets.push([a, b, props])
    degree.set(a, (degree.get(a) ?? 0) + 1)
    degree.set(b, (degree.get(b) ?? 0) + 1)
  }
  // Avenues, south to north, interrupted by the park.
  for (let col = 0; col < avenues; col++) {
    for (let row = 0; row < rows; row++) {
      const insidePark = col > park.col0 && col < park.col1 && row >= park.row0 && row < park.row1
      if (!insidePark) addStreet(nodes[col]![row]!, nodes[col]![row + 1]!, AVENUE)
    }
  }
  // Cross streets, west to east, not through the park.
  for (let row = 0; row <= rows; row++) {
    for (let col = 0; col < avenues - 1; col++) {
      const insidePark = col >= park.col0 && col < park.col1 && row > park.row0 && row < park.row1
      if (!insidePark) addStreet(nodes[col]![row]!, nodes[col + 1]![row]!, streetProps(row))
    }
  }
  for (const [a, b, props] of streets) {
    tx.putStreet({
      ...props,
      id: createId(),
      a,
      b,
      control: null,
      crosswalkA: (degree.get(a) ?? 0) >= 3,
      crosswalkB: (degree.get(b) ?? 0) >= 3,
    })
  }
  // Points no street uses (inside the park) go again.
  for (const column of nodes) for (const id of column) if (!degree.has(id)) tx.deleteStreetNode(id)

  // Building heights: a downtown at the south end and a midtown below the park.
  const downtown = { x: 0, y: -length / 2 + length * 0.06 }
  const midtown = { x: 0, y: -length / 2 + length * 0.42 }
  const towerness = (p: Vec2) => {
    const d1 = Math.hypot(p.x - downtown.x, (p.y - downtown.y) * 0.6) / 1200
    const d2 = Math.hypot(p.x - midtown.x, (p.y - midtown.y) * 0.5) / 1500
    return Math.max(0, 1 - Math.min(d1, d2))
  }

  let count = 0
  /** One floor's four walls round a lot, returning each wall and its length (south, east, north, west). */
  const plan = (level: Id, x0: number, y0: number, x1: number, y1: number): [Id, number][] => {
    const corners = [
      { x: x0, y: y0 },
      { x: x1, y: y0 },
      { x: x1, y: y1 },
      { x: x0, y: y1 },
    ].map((p) => {
      const id = createId()
      tx.putNode({ id, levelId: level, x: p.x, y: p.y })
      return id
    })
    return corners.map((a, i) => {
      const id = createId()
      tx.putWall({ id, levelId: level, a, b: corners[(i + 1) % 4]!, thickness: null, height: null, heightEnd: null })
      return [id, i % 2 === 0 ? x1 - x0 : y1 - y0]
    })
  }
  /** A row of identical windows (or doors), centred between `from` and `to` along a wall, as one record. */
  const row = (wallId: Id, from: number, to: number, look: Glazing) => {
    const room = to - from - 2 * EDGE
    if (room < look.width) return
    const n = Math.floor((room - look.width) / look.spacing) + 1
    const { typeId, width, height, sill, spacing } = look
    const kind = typeId.startsWith('door') ? 'door' : 'window'
    tx.putOpening({
      id: createId(),
      wallId,
      kind,
      typeId,
      offset: (from + to) / 2,
      width,
      height,
      sill,
      ...(n > 1 ? { count: n, spacing } : {}),
    })
  }

  /**
   * A building on a lot: a ground floor of shopfronts round a door on the
   * street, a typical upper floor with rows of windows front and back (and
   * on the avenue at a corner), and a run of copies of it up to the top.
   */
  const building = (
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    floors: number,
    lot: { front: 0 | 2; corners: readonly number[]; tower: boolean },
  ) => {
    const buildingId = createId()
    tx.putBuilding({ id: buildingId, name: `Building ${++count}` })
    const back = lot.front === 0 ? 2 : 0
    const upper = lot.tower ? TOWER_WINDOWS : WINDOWS[Math.floor(random() * WINDOWS.length)]!

    const ground = createId()
    tx.putLevel({ id: ground, buildingId, name: 'Ground floor', elevation: 0, height: GROUND_HEIGHT, masterId: null })
    const walls = plan(ground, x0, y0, x1, y1)
    const [front, length] = walls[lot.front]!
    const door = lot.tower ? DOUBLE_DOOR : DOOR
    tx.putOpening({ id: createId(), wallId: front, kind: 'door', ...door, offset: length / 2 })
    row(front, 0, length / 2 - door.width / 2 - 0.4, SHOPFRONT)
    row(front, length / 2 + door.width / 2 + 0.4, length, SHOPFRONT)
    for (const side of [back, ...lot.corners]) row(walls[side]![0], 0, walls[side]![1], side === back ? upper : SHOPFRONT)
    if (floors < 2) return

    const first = createId()
    tx.putLevel({ id: first, buildingId, name: '1st floor', elevation: GROUND_HEIGHT, height: FLOOR_HEIGHT, masterId: null })
    const upperWalls = plan(first, x0, y0, x1, y1)
    for (const side of [lot.front, back, ...lot.corners]) row(upperWalls[side]![0], 0, upperWalls[side]![1], upper)
    if (floors > 2) {
      tx.putLevel({
        id: createId(),
        buildingId,
        name: '1st floor · copy',
        elevation: GROUND_HEIGHT + FLOOR_HEIGHT,
        height: FLOOR_HEIGHT,
        masterId: first,
        count: floors - 2,
      })
    }
  }

  // Lots along both long sides of every block.
  const avenueMargin = halfWidth(AVENUE) + 1.5
  for (let col = 0; col < avenues - 1; col++) {
    for (let row = 0; row < rows; row++) {
      if (inPark(col, row)) continue
      const x0 = col * AVENUE_SPACING - width / 2 + avenueMargin
      const x1 = (col + 1) * AVENUE_SPACING - width / 2 - avenueMargin
      const south = row * STREET_SPACING - length / 2 + halfWidth(streetProps(row)) + 1.5
      const north = (row + 1) * STREET_SPACING - length / 2 - halfWidth(streetProps(row + 1)) - 1.5
      const depth = (north - south) / 2 - 2
      for (const side of [0, 1]) {
        let x = x0
        while (x1 - x > 8) {
          const tall = towerness({ x: (x + x1) / 2, y: (south + north) / 2 })
          // Towers take wider lots.
          const wide = random() < tall * 0.6
          let frontage = wide ? 30 + random() * 30 : 12 + random() * 16
          if (x1 - x - frontage < 10) frontage = x1 - x
          const floors = wide
            ? Math.round(18 + tall * (40 + random() * 40))
            : Math.max(2, Math.round(4 + random() * 4 + tall * random() * 18))
          const lotDepth = wide ? depth : depth - random() * 6
          // The first and last lots of a block stand on the corner, with a side on the avenue.
          const corners = [...(x === x0 ? [3] : []), ...(x + frontage >= x1 - 0.01 ? [1] : [])]
          const lot = { front: side === 0 ? (0 as const) : (2 as const), corners, tower: wide && floors >= 25 }
          if (side === 0) building(x, south, x + frontage, south + lotDepth, floors, lot)
          else building(x, north - lotDepth, x + frontage, north, floors, lot)
          x += frontage + (random() < 0.15 ? 2 + random() * 4 : 0)
        }
      }
    }
  }
  return count
}
