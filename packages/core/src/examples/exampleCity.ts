import { createId } from '../ids.ts'
import { normalize, type Vec2 } from '../math.ts'
import { FLAT_ROOF, type Id, type OpeningKind, type Roof, type RoofKind, type RoomUse, type StreetProps, type Wall } from '../model.ts'
import { openingType } from '../openingTypes.ts'
import { levelName, restackLevels } from '../ops/levels.ts'
import { insertStreet } from '../ops/streets.ts'
import type { Tx } from '../tx.ts'

/**
 * "Harbour City": a large example site, built from code. A grid of streets
 * around a central boulevard, a curved harbour drive along the water, a
 * diagonal road through a park, and about 150 buildings: towers on podiums
 * downtown, courtyard blocks, terraced houses, villas, warehouses, a
 * waterfront row, and a town hall and library with their interiors drawn.
 * Random choices come from a fixed seed, so it's the same every time.
 *
 * The walls are written directly (not through insertWall, which tidies the
 * whole level each time): every outline is a simple closed loop, so there
 * is nothing to tidy, and a city this size is built in a moment.
 */

export const EXAMPLE_CITY_NAME = 'Harbour City'

/** Random numbers from a seed (mulberry32). */
function seeded(seed: number) {
  let state = seed >>> 0
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    between: (lo: number, hi: number) => lo + (hi - lo) * next(),
    int: (lo: number, hi: number) => Math.floor(lo + (hi - lo + 1) * next()),
  }
}
type Random = ReturnType<typeof seeded>

const v = (x: number, y: number): Vec2 => ({ x, y })

/** An axis-aligned rectangle, anticlockwise from its south-west corner: walls 0 south, 1 east, 2 north, 3 west. */
function rect(x0: number, y0: number, x1: number, y1: number): Vec2[] {
  return [v(x0, y0), v(x1, y0), v(x1, y1), v(x0, y1)]
}

/** A rectangle `w` wide and `d` deep round `c`, turned by `angle`. Wall 0 is its back (−y side), wall 2 its front. */
function centredRect(c: Vec2, w: number, d: number, angle = 0): Vec2[] {
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  return [
    [-w / 2, -d / 2],
    [w / 2, -d / 2],
    [w / 2, d / 2],
    [-w / 2, d / 2],
  ].map(([x, y]) => v(c.x + x! * cos - y! * sin, c.y + x! * sin + y! * cos))
}

/** A regular polygon round `c`, anticlockwise. */
function regular(c: Vec2, radius: number, sides: number, phase = 0): Vec2[] {
  return Array.from({ length: sides }, (_, i) => {
    const a = phase + (i / sides) * 2 * Math.PI
    return v(c.x + Math.cos(a) * radius, c.y + Math.sin(a) * radius)
  })
}

interface Segment {
  wall: Wall
  length: number
  /** Openings already placed, as [centre, half width], so windows keep clear of doors. */
  taken: [number, number][]
}

interface WindowOptions {
  typeId: string
  spacing: number
  /** Outline walls (by index) that get no windows, such as walls against a neighbour. */
  skip?: readonly number[]
}

/** Writes one level's walls and openings. */
class FloorWriter {
  readonly segments: Segment[] = []
  private readonly nodes = new Map<string, Id>()
  private readonly tx: Tx
  readonly levelId: Id

  /** Names the room around a point and says what it's for. */
  room(at: Vec2, name: string, use: RoomUse): this {
    this.tx.putRoomTag({ id: createId(), levelId: this.levelId, x: at.x, y: at.y, name, use })
    return this
  }

  constructor(tx: Tx, levelId: Id, outline: readonly Vec2[]) {
    this.tx = tx
    this.levelId = levelId
    outline.forEach((p, i) => {
      const q = outline[(i + 1) % outline.length]!
      this.segments.push({ wall: this.wall(p, q), length: Math.hypot(q.x - p.x, q.y - p.y), taken: [] })
    })
  }

  private node(p: Vec2): Id {
    const key = `${p.x.toFixed(3)},${p.y.toFixed(3)}`
    let id = this.nodes.get(key)
    if (!id) {
      id = createId()
      this.tx.putNode({ id, levelId: this.levelId, x: p.x, y: p.y })
      this.nodes.set(key, id)
    }
    return id
  }

  /** A wall from p to q; points already used on this level are shared. */
  wall(p: Vec2, q: Vec2, thickness: number | null = null): Wall {
    return this.tx.putWall({
      id: createId(),
      levelId: this.levelId,
      a: this.node(p),
      b: this.node(q),
      thickness,
      height: null,
      heightEnd: null,
    })
  }

  opening(wall: Wall, kind: OpeningKind, typeId: string, offset: number): void {
    const type = openingType(typeId, kind)
    this.tx.putOpening({ id: createId(), wallId: wall.id, kind, typeId: type.id, offset, ...type.defaults })
  }

  /** A door on outline wall `index`, `at` of the way along it. */
  door(index: number, typeId = 'door', at = 0.5): this {
    const segment = this.segments[index % this.segments.length]!
    const offset = segment.length * at
    this.opening(segment.wall, 'door', typeId, offset)
    segment.taken.push([offset, openingType(typeId, 'door').defaults.width / 2])
    return this
  }

  /** Windows evenly along every outline wall. */
  windows({ typeId, spacing, skip = [] }: WindowOptions): this {
    const half = openingType(typeId, 'window').defaults.width / 2
    this.segments.forEach((segment, index) => {
      if (skip.includes(index)) return
      const count = Math.floor((segment.length - 1) / spacing)
      if (count < 1) return
      const first = (segment.length - (count - 1) * spacing) / 2
      for (let k = 0; k < count; k++) {
        const offset = first + k * spacing
        if (segment.taken.some(([at, w]) => Math.abs(at - offset) < w + half + 0.3)) continue
        this.opening(segment.wall, 'window', typeId, offset)
      }
    })
    return this
  }
}

/** Writes a building, floor by floor from the ground up. */
class BuildingWriter {
  readonly id: Id = createId()
  private top = 0
  private count = 0
  private readonly tx: Tx

  constructor(tx: Tx, name: string) {
    this.tx = tx
    tx.putBuilding({ id: this.id, name })
  }

  /** A level with its own walls along `outline`, and `repeat` copies of it above. */
  floor(outline: readonly Vec2[], height: number, repeat = 0): FloorWriter {
    const name = levelName(this.count)
    const level = this.tx.putLevel({
      id: createId(),
      buildingId: this.id,
      name,
      elevation: this.top,
      height,
      masterId: null,
    })
    this.top += height
    this.count++
    for (let i = 1; i <= repeat; i++) {
      this.tx.putLevel({
        id: createId(),
        buildingId: this.id,
        name: `${name} · copy ${i}`,
        elevation: this.top,
        height,
        masterId: level.id,
      })
      this.top += height
      this.count++
    }
    return new FloorWriter(this.tx, level.id, outline)
  }

  /** Puts a roof on top: pitched ones get eaves. */
  roof(kind: RoofKind, settings: Partial<Roof> = {}): this {
    const building = this.tx.building(this.id)
    const roof: Roof = { ...FLAT_ROOF, kind, overhang: kind === 'flat' ? 0 : 0.35, ...settings }
    if (building) this.tx.putBuilding({ ...building, roof })
    return this
  }

  done(): void {
    restackLevels(this.tx, this.id, 0)
  }
}

// Streets. Margins keep buildings 2 m behind the back of the sidewalk.

const BOULEVARD: Partial<StreetProps> = {
  lanes: 4,
  laneWidth: 3.25,
  bikeLeft: 1.8,
  bikeRight: 1.8,
  parkingLeft: 2.4,
  parkingRight: 2.4,
  sidewalkLeft: 4.5,
  sidewalkRight: 4.5,
}
const CENTRAL: Partial<StreetProps> = {
  lanes: 4,
  laneWidth: 3.25,
  bikeLeft: 1.8,
  bikeRight: 1.8,
  sidewalkLeft: 4,
  sidewalkRight: 4,
}
const AVENUE: Partial<StreetProps> = { lanes: 2, laneWidth: 3.25, parkingRight: 2.2, sidewalkLeft: 3, sidewalkRight: 3 }
const STREET: Partial<StreetProps> = {
  lanes: 2,
  laneWidth: 3,
  parkingLeft: 2.2,
  parkingRight: 2.2,
  sidewalkLeft: 2.5,
  sidewalkRight: 2.5,
}
/** Along the water: a promenade on the harbour side. */
const DRIVE: Partial<StreetProps> = {
  lanes: 2,
  laneWidth: 3.25,
  bikeLeft: 1.8,
  bikeRight: 1.8,
  sidewalkLeft: 6,
  sidewalkRight: 3,
}
const PARK_ROAD: Partial<StreetProps> = { lanes: 1, laneWidth: 3.5, sidewalkLeft: 2, sidewalkRight: 2 }

const AVENUES_X = [-240, -120, 0, 120, 240]
const STREETS_Y = [-200, -120, 0, 120, 200]
const marginX = (x: number) => (x === 0 ? 14.3 : 10.45)
const marginY = (y: number) => (y === 0 ? 17.2 : 9.7)
/** The harbour drive: a quadratic curve. */
const DRIVE_CURVE = { a: v(-300, 250), b: v(300, 250), control: v(0, 330) }
/** The point of the harbour drive above `x` (x runs evenly along it), and its direction there. */
function onDrive(x: number): { at: Vec2; dir: Vec2 } {
  const t = (x + 300) / 600
  const { a, b, control } = DRIVE_CURVE
  const at = v(
    (1 - t) ** 2 * a.x + 2 * (1 - t) * t * control.x + t * t * b.x,
    (1 - t) ** 2 * a.y + 2 * (1 - t) * t * control.y + t * t * b.y,
  )
  const dir = normalize(
    v(2 * (1 - t) * (control.x - a.x) + 2 * t * (b.x - control.x), 2 * (1 - t) * (control.y - a.y) + 2 * t * (b.y - control.y)),
  )
  return { at, dir }
}

interface Block {
  x0: number
  y0: number
  x1: number
  y1: number
}

/** The buildable part of the block between avenues `col`, `col + 1` and streets `row`, `row + 1`. */
function block(col: number, row: number): Block {
  const xa = AVENUES_X[col]!
  const xb = AVENUES_X[col + 1]!
  const ya = STREETS_Y[row]!
  const yb = STREETS_Y[row + 1]!
  return { x0: xa + marginX(xa), x1: xb - marginX(xb), y0: ya + marginY(ya), y1: yb - marginY(yb) }
}

function streets(tx: Tx): void {
  insertStreet(tx, DRIVE_CURVE.a, DRIVE_CURVE.b, DRIVE, DRIVE_CURVE.control)
  insertStreet(tx, v(-300, 0), v(300, 0), BOULEVARD)
  for (const y of [-200, -120, 120, 200]) insertStreet(tx, v(-300, y), v(300, y), STREET)
  for (const x of [-240, 240]) insertStreet(tx, v(x, -200), v(x, 200), AVENUE)
  for (const x of [-120, 120]) insertStreet(tx, v(x, -200), onDrive(x).at, AVENUE)
  insertStreet(tx, v(0, -200), onDrive(0).at, CENTRAL)
  insertStreet(tx, v(-240, -200), v(-120, -120), PARK_ROAD)

  // Zebra crossings where three or more streets meet.
  const degree = (nodeId: Id) => tx.streetsAtNode(nodeId).length
  for (const street of tx.streets()) {
    tx.putStreet({ ...street, crosswalkA: degree(street.a) >= 3, crosswalkB: degree(street.b) >= 3 })
  }
}

// Districts.

/** House numbers run on along a street from block to block: odd on one side, even on the other. */
const houseNumbers = new Map<string, number>()
function nextNumber(street: string, even: boolean): number {
  const key = `${street}:${even}`
  const n = houseNumbers.get(key) ?? (even ? 2 : 1)
  houseNumbers.set(key, n + 2)
  return n
}

const TOWERS = [
  { name: 'Central Tower', outline: (c: Vec2) => centredRect(c, 26, 32) },
  { name: 'Diamond Tower', outline: (c: Vec2) => centredRect(c, 26, 26, Math.PI / 4) },
  { name: 'Octagon', outline: (c: Vec2) => regular(c, 16, 8, Math.PI / 8) },
  { name: 'Slab Tower', outline: (c: Vec2) => centredRect(c, 22, 40) },
]

/** Downtown: a tower on a podium beside the central crossing, a mid-rise and a stepped office block. */
function downtown(tx: Tx, random: Random, b: Block, variant: number): void {
  const west = b.x1 <= 0
  const podium = west ? rect(b.x1 - 46, b.y0, b.x1, b.y1) : rect(b.x0, b.y0, b.x0 + 46, b.y1)
  const rest = west ? { x0: b.x0, x1: b.x1 - 52 } : { x0: b.x0 + 52, x1: b.x1 }
  const centre = v(west ? b.x1 - 23 : b.x0 + 23, (b.y0 + b.y1) / 2)
  const tower = TOWERS[variant]!

  const t = new BuildingWriter(tx, tower.name)
  t.floor(podium, 5)
    .door(west ? 1 : 3, 'door-double')
    .windows({ typeId: 'window-tall', spacing: 3 })
  t.floor(podium, 4.5).windows({ typeId: 'window', spacing: 3 })
  t.floor(tower.outline(centre), 3.6, random.int(12, 26)).windows({ typeId: 'window-tall', spacing: 2.8 })
  t.roof('flat', { parapet: 1.2 })
  t.done()

  const north = new BuildingWriter(tx, `${tower.name} North`)
  const northOutline = rect(rest.x0, b.y1 - 36, rest.x1, b.y1)
  north.floor(northOutline, 4.5).door(2, 'door-glass').windows({ typeId: 'window-tall', spacing: 3 })
  north.floor(northOutline, 3.4, random.int(5, 9)).windows({ typeId: 'window-casement', spacing: 3 })
  north.roof('flat', { parapet: 1 })
  north.done()

  const south = new BuildingWriter(tx, `${tower.name} Offices`)
  const southOutline = rect(rest.x0, b.y0, rest.x1, b.y0 + 40)
  south.floor(southOutline, 4.5).door(0, 'door-double').windows({ typeId: 'window-tall', spacing: 3 })
  south.floor(southOutline, 3.4, 5).windows({ typeId: 'window', spacing: 2.6 })
  // A setback with terraces round it.
  south.floor(rect(rest.x0 + 4, b.y0 + 4, rest.x1 - 4, b.y0 + 36), 3.4, 2).windows({ typeId: 'window-tall', spacing: 3 })
  south.done()
}

/** A ring of buildings round a courtyard. */
function courtyardBlock(tx: Tx, random: Random, b: Block, name: string): void {
  const D = 13
  let n = 1
  const bar = (outline: Vec2[], door: number, skip: number[]) => {
    const floors = random.int(4, 7)
    const w = new BuildingWriter(tx, `${name} ${n++}`)
    w.floor(outline, 4).door(door).windows({ typeId: 'window-casement', spacing: 3.2, skip })
    w.floor(outline, 3.2, floors - 2).windows({ typeId: 'window-casement', spacing: 3.2, skip })
    w.roof('gable', { pitch: 38 })
    w.done()
  }
  const splitN = random.between(b.x0 + 35, b.x1 - 35)
  bar(rect(b.x0, b.y1 - D, splitN, b.y1), 2, [1])
  bar(rect(splitN, b.y1 - D, b.x1, b.y1), 2, [3])
  const splitS = random.between(b.x0 + 35, b.x1 - 35)
  bar(rect(b.x0, b.y0, splitS, b.y0 + D), 0, [1])
  bar(rect(splitS, b.y0, b.x1, b.y0 + D), 0, [3])
  bar(rect(b.x0, b.y0 + D, b.x0 + D, b.y1 - D), 3, [0, 2])
  bar(rect(b.x1 - D, b.y0 + D, b.x1, b.y1 - D), 1, [0, 2])
}

/** Terraced houses along both long sides of a block. */
function terraces(tx: Tx, random: Random, b: Block, southStreet: string, northStreet: string): void {
  const depth = 11
  const row = (y0: number, y1: number, street: string, door: number) => {
    let x = b.x0
    while (b.x1 - x >= 6) {
      let width = Math.round(random.between(6.5, 9) * 2) / 2
      if (b.x1 - x - width < 6) width = b.x1 - x
      const outline = rect(x, y0, x + width, y1)
      const house = new BuildingWriter(tx, `${street} ${nextNumber(street, door === 2)}`)
      house.floor(outline, 3).door(door).windows({ typeId: 'window', spacing: 2.6, skip: [1, 3] })
      const upper = random.int(1, 3)
      house.floor(outline, 3, upper - 1).windows({ typeId: 'window', spacing: 2.6, skip: [1, 3] })
      // Ridges along the street, so a row's roofs run on from house to house.
      house.roof('gable', { pitch: 42, direction: 0, overhang: 0 })
      house.done()
      x += width
    }
  }
  row(b.y0, b.y0 + depth, southStreet, 0)
  row(b.y1 - depth, b.y1, northStreet, 2)
}

/** Detached villas in two rows, each turned a little. */
function villas(tx: Tx, random: Random, b: Block, southStreet: string, northStreet: string): void {
  const row = (y: number, street: string, door: number) => {
    for (let x = b.x0 + 10; x + 6 <= b.x1; x += 18) {
      const outline = centredRect(v(x, y), 11, 13, random.between(-0.08, 0.08))
      const villa = new BuildingWriter(tx, `${street} ${nextNumber(street, door === 2)}`)
      villa.floor(outline, 3.2).door(door, 'door-glass').windows({ typeId: 'window-grid', spacing: 2.8 })
      villa.floor(outline, 3).windows({ typeId: 'window-grid', spacing: 2.8 })
      villa.roof('hip', { pitch: 30, overhang: 0.6 })
      villa.done()
    }
  }
  row(b.y0 + 9, southStreet, 0)
  row(b.y1 - 9, northStreet, 2)
}

function industry(tx: Tx, b: Block): void {
  const one = new BuildingWriter(tx, 'Warehouse 1')
  one.floor(rect(b.x0, b.y0, b.x0 + 45, b.y0 + 35), 7.5).door(0, 'door-double', 0.25).door(0, 'door-double', 0.75)
  one.roof('gable', { pitch: 15 })
  one.done()

  const two = new BuildingWriter(tx, 'Warehouse 2')
  const lShape = [
    v(b.x0 + 50, b.y0),
    v(b.x1, b.y0),
    v(b.x1, b.y1),
    v(b.x1 - 25, b.y1),
    v(b.x1 - 25, b.y0 + 25),
    v(b.x0 + 50, b.y0 + 25),
  ]
  two.floor(lShape, 5).door(0, 'door-double').windows({ typeId: 'window-empty', spacing: 6 })
  two.floor(lShape, 5).windows({ typeId: 'window-empty', spacing: 6 })
  two.roof('hip', { pitch: 18 })
  two.done()

  const three = new BuildingWriter(tx, 'Workshop')
  three.floor(rect(b.x0, b.y0 + 42, b.x0 + 40, b.y1), 6).door(3, 'door-double').windows({ typeId: 'window-grid', spacing: 4 })
  three.roof('shed', { pitch: 10, direction: 270 })
  three.done()
}

function park(tx: Tx): void {
  const museum = new BuildingWriter(tx, 'Museum')
  const hexagon = regular(v(-200, -150), 11, 6, Math.PI / 6)
  museum.floor(hexagon, 6).door(4, 'door-glass').windows({ typeId: 'window-tall', spacing: 3 })
  museum.floor(hexagon, 5).windows({ typeId: 'window-tall', spacing: 3 })
  museum.roof('hip', { pitch: 25, overhang: 0.8 })
  museum.done()

  const pavilion = new BuildingWriter(tx, 'Pavilion')
  pavilion.floor(regular(v(-150, -175), 7, 8, Math.PI / 8), 4.5).door(2, 'door-glass').windows({ typeId: 'window-tall', spacing: 2 })
  pavilion.roof('hip', { pitch: 32, overhang: 1 })
  pavilion.done()
}

/** The town hall, with its rooms, and the library: the two buildings drawn inside. */
function civicCentre(tx: Tx): void {
  const hall = new BuildingWriter(tx, 'Town Hall')
  const outline = rect(22, 146, 62, 170)
  const interior = (floor: FloorWriter, ground: boolean) => {
    // A corridor east to west, rooms either side, a door from the corridor into each.
    const southCorridor = floor.wall(v(22, 156.5), v(62, 156.5), 0.15)
    const northCorridor = floor.wall(v(22, 159.5), v(62, 159.5), 0.15)
    for (const x of [30, 38, 46, 54]) floor.wall(v(x, 146), v(x, 156.5), 0.12)
    for (const x of [32, 42, 52]) floor.wall(v(x, 159.5), v(x, 170), 0.12)
    for (const at of [4, 12, 28, 36]) floor.opening(southCorridor, 'door', 'door', at)
    // On the ground floor the entrance hall opens wide onto the corridor.
    floor.opening(southCorridor, 'door', ground ? 'door-empty' : 'door', 20)
    for (const at of [5, 15, 25, 35]) floor.opening(northCorridor, 'door', 'door', at)
    floor.room(v(42, 158), 'Corridor', 'circulation')
    if (ground) {
      floor.room(v(26, 151), 'Reception', 'office').room(v(34, 151), 'Registry', 'office').room(v(42, 151), 'Entrance hall', 'circulation')
      floor.room(v(50, 151), 'Cloakroom', 'sanitary').room(v(58, 151), 'Plant room', 'technical')
      floor.room(v(27, 165), 'Archive', 'storage').room(v(37, 165), 'Office', 'office').room(v(47, 165), 'Office', 'office').room(v(57, 165), 'Meeting room', 'office')
    } else {
      floor.room(v(26, 151), 'Mayor', 'office').room(v(34, 151), 'Office', 'office').room(v(42, 151), 'Office', 'office')
      floor.room(v(50, 151), 'WC', 'sanitary').room(v(58, 151), 'Office', 'office')
      floor.room(v(37, 165), 'Council chamber', 'office').room(v(47, 165), 'Meeting room', 'office').room(v(57, 165), 'Kitchen', 'other')
    }
  }
  const ground = hall.floor(outline, 4.5).door(0, 'door-double').door(3, 'door', 0.5)
  interior(ground, true)
  ground.windows({ typeId: 'window-tall', spacing: 3.4 })
  const upper = hall.floor(outline, 3.8, 1)
  interior(upper, false)
  upper.windows({ typeId: 'window', spacing: 2.8 })
  hall.roof('hip', { pitch: 28, overhang: 0.6 })
  hall.done()

  const library = new BuildingWriter(tx, 'Library')
  const lShape = [v(72, 136), v(104, 136), v(104, 184), v(90, 184), v(90, 152), v(72, 152)]
  for (let i = 0; i < 2; i++) {
    const floor = library.floor(lShape, 4.2)
    if (i === 0) floor.door(0, 'door-glass', 0.5)
    const partition = floor.wall(v(90, 152), v(104, 152), 0.12)
    floor.opening(partition, 'door', 'door-empty', 7)
    floor.windows({ typeId: 'window-grid', spacing: 3 })
    floor.room(v(84, 144), i === 0 ? 'Lending desk' : 'Reading room', 'education').room(v(97, 168), i === 0 ? 'Stacks' : 'Study rooms', i === 0 ? 'storage' : 'education')
  }
  library.roof('flat', { parapet: 0.9 })
  library.done()
}

/** A row of buildings along the harbour drive, turned to follow it. */
function waterfront(tx: Tx, random: Random): void {
  const xs = [-275, -232, -190, -150, -85, -45, 45, 85, 150, 190, 232, 275]
  xs.forEach((x, i) => {
    const { at, dir } = onDrive(x)
    // To the city side (right of the drive, which runs west to east).
    const inward = v(dir.y, -dir.x)
    const depth = random.between(14, 18)
    const width = random.between(22, 30)
    const reach = 3.25 + 1.8 + 3 + 2 + depth / 2
    const centre = v(at.x + inward.x * reach, at.y + inward.y * reach)
    const outline = centredRect(centre, width, depth, Math.atan2(dir.y, dir.x))
    const tall = x === -45
    const w = new BuildingWriter(tx, tall ? 'Harbour Tower' : `Quay ${i + 1}`)
    w.floor(outline, 4.5).door(2, 'door-glass').windows({ typeId: 'window-tall', spacing: 3 })
    w.floor(outline, 3.3, tall ? 14 : random.int(3, 7)).windows({ typeId: 'window-casement', spacing: 3 })
    w.roof('flat', { parapet: tall ? 1.2 : 0.9 })
    w.done()
  })
}

/** The strips west and east of the outer avenues. */
function edges(tx: Tx, random: Random): void {
  const simple = (
    name: string,
    outline: Vec2[],
    heights: number[],
    windowType: string,
    door: number,
    doorType = 'door',
    roof?: [RoofKind, Partial<Roof>],
  ) => {
    const w = new BuildingWriter(tx, name)
    heights.forEach((height, i) => {
      const floor = w.floor(outline, height)
      if (i === 0) floor.door(door, doorType)
      floor.windows({ typeId: windowType, spacing: 3.2 })
    })
    if (roof) w.roof(...roof)
    w.done()
  }
  simple('Sports Hall', rect(-292, -100, -256, -30), [9], 'window-tall', 1, 'door-double', ['gable', { pitch: 12, overhang: 0.5 }])
  const school = [v(-292, 30), v(-256, 30), v(-256, 45), v(-276, 45), v(-276, 85), v(-256, 85), v(-256, 100), v(-292, 100)]
  simple('School', school, [3.6, 3.6, 3.6], 'window', 1, 'door-double', ['hip', { pitch: 25, overhang: 0.5 }])
  simple('Cottage 1', centredRect(v(-275, 150), 10, 12, 0.35), [3, 3], 'window-grid', 0, 'door', ['gable', { pitch: 45, overhang: 0.5 }])
  simple('Cottage 2', centredRect(v(-268, 176), 9, 11, -0.2), [3, 2.8], 'window-grid', 0, 'door', ['gable', { pitch: 45, overhang: 0.5 }])
  simple('Garden Centre', rect(-292, -185, -260, -140), [5], 'window-tall', 1, 'door-glass', ['gable', { pitch: 20 }])
  simple('Market Hall', centredRect(v(273, -64), 30, 70, 0.12), [5.5, 5.5], 'window-grid', 3, 'door-double', ['gable', { pitch: 25, overhang: 0.8 }])
  simple('Clinic', regular(v(273, 160), 18, 6), [3.6, 3.4, 3.4], 'window', 3, 'door-double', ['flat', { parapet: 0.9 }])
  simple('Depot', rect(254, -186, 294, -134), [8], 'window-empty', 3, 'door-double', ['shed', { pitch: 8, direction: 0 }])

  const hotel = new BuildingWriter(tx, 'Hotel')
  hotel.floor(rect(254, 25, 294, 100), 5).door(3, 'door-double').windows({ typeId: 'window-tall', spacing: 3 })
  hotel.floor(centredRect(v(274, 62), 22, 34), 3.4, random.int(10, 16)).windows({ typeId: 'window', spacing: 2.6 })
  hotel.done()
}

/** Fills an empty document with Harbour City. */
export function buildExampleCity(tx: Tx, seed = 11): void {
  const random = seeded(seed)
  houseNumbers.clear()
  tx.setMeta({ name: EXAMPLE_CITY_NAME })
  streets(tx)

  // Columns 0..3 run west to east between the avenues, rows 0..3 south to north between the streets.
  downtown(tx, random, block(1, 1), 0)
  downtown(tx, random, block(2, 1), 1)
  downtown(tx, random, block(1, 2), 2)
  downtown(tx, random, block(2, 2), 3)
  courtyardBlock(tx, random, block(0, 1), 'Linden Court')
  courtyardBlock(tx, random, block(0, 2), 'Maple Court')
  courtyardBlock(tx, random, block(3, 1), 'Cedar Court')
  courtyardBlock(tx, random, block(3, 2), 'Birch Court')
  terraces(tx, random, block(0, 3), 'Park Street', 'Quay Street')
  terraces(tx, random, block(1, 3), 'Park Street', 'Quay Street')
  terraces(tx, random, block(3, 3), 'Park Street', 'Quay Street')
  villas(tx, random, block(2, 0), 'Garden Lane', 'Orchard Street')
  villas(tx, random, block(3, 0), 'Garden Lane', 'Orchard Street')
  industry(tx, block(1, 0))
  park(tx)
  civicCentre(tx)
  waterfront(tx, random)
  edges(tx, random)
}
