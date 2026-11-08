import { add, angleOf, intersectLines, normalize, perpLeft, pointInRing, polygonCentroid, scale, signedArea2, sub, type Vec2 } from '../math.ts'
import {
  contentLevelId,
  floorsOf,
  levelsByBuilding,
  roofOf,
  wallsByLevel,
  type Id,
  type Level,
  type Roof,
  type Snapshot,
  type Wall,
  type WallNode,
} from '../model.ts'
import { findIntersections, type Intersection } from '../ops/intersections.ts'
import { computeFootprints, type WallFootprint } from './footprint.ts'
import {
  difference,
  fromRing,
  labelPoint,
  pointInRegion,
  regionArea,
  regionPerimeter,
  ringArea,
  toRing,
  union,
  type MultiPolygon,
} from './regions.ts'

/**
 * Everything derived from the walls: rooms, areas and floor slabs. Nothing
 * here is stored; it is recomputed when the walls change, level by level:
 * a level whose walls and points are unchanged keeps its analysis, and a
 * building whose levels are unchanged keeps its, so editing one building in
 * a large city only recomputes that building.
 */

/** Faces smaller than this (m²) are slivers, not rooms. */
const MIN_ROOM_AREA = 0.05

export interface Room {
  /** Derived from the room's position and size, so it changes when the room does. */
  id: string
  /** The level the room's walls belong to (a copy's master). */
  levelId: Id
  /** The room's outline along the inner faces of its walls, counter-clockwise. */
  outline: Vec2[]
  /** The floor inside the walls. */
  floor: MultiPolygon
  /** Net floor area in m². */
  area: number
  /** Length of the floor's edges in metres. */
  perimeter: number
  labelPoint: Vec2 | null
}

export interface LevelAnalysis {
  level: Level
  /** Where the walls come from: the level itself, or its master for a copy. */
  contentLevelId: Id
  /**
   * How many floors this entry stands for: more than one for a run of
   * copies, which share everything but their height. Areas below are per floor.
   */
  floors: number
  /** Whether the walls are one simple closed loop (the shell is then the outline, extruded). */
  simple: boolean
  /** The walls drawn on the content level. */
  levelWalls: Wall[]
  rooms: Room[]
  footprints: Map<Id, WallFootprint>
  /** Area inside the outer faces of the walls around rooms, in m². */
  grossArea: number
  /** Sum of room floor areas, in m². */
  netArea: number
  /** All room floors together. */
  floor: MultiPolygon
  /** Everything inside the outer faces of the walls that enclose rooms. */
  outline: MultiPolygon
  /** All wall footprints together. */
  walls: MultiPolygon
  /** Walls with a face to the outside: the building's shell on this level. */
  exteriorWalls: Set<Id>
  /** For exterior walls, which faces are outside: 1 the left (seen from the wall's start), -1 the right, 0 both. */
  exteriorSides: Map<Id, 1 | -1 | 0>
  /** Where walls cross or touch without being joined, and joins that could be undone. */
  intersections: Intersection[]
  /**
   * Tiny height changes (fractions of a millimetre, downwards) for walls that
   * overlap other, separate walls, so their coplanar tops don't flicker.
   * Missing means 0.
   */
  topOffsets: Map<Id, number>
}

export interface Slab {
  id: string
  buildingId: Id
  /** The level this slab is the floor of, or null for the roof slab on top. */
  levelId: Id | null
  bottom: number
  top: number
  region: MultiPolygon
  /** The same slab this many times, each `step` metres above the last: the floors of a run of copies. */
  count: number
  step: number
}

/** One building's levels, slabs and areas. */
export interface BuildingAnalysis {
  buildingId: Id
  /** From the ground up. */
  levels: LevelAnalysis[]
  slabs: Slab[]
  /** The roof on its top floor. */
  roof: Roof
  grossArea: number
  netArea: number
}

/** Finds one floor's analysis by its level ID (or the ID of one floor of a run of copies). */
export interface LevelLookup {
  get(levelId: Id): LevelAnalysis | undefined
}

/**
 * The whole site: every building's analysis, and lookups across them. The
 * lists across all buildings are built on first use only: a large city has
 * hundreds of thousands of floors.
 */
export interface SiteAnalysis {
  buildings: Map<Id, BuildingAnalysis>
  /** Every floor of every building, each building from the ground up. */
  readonly levels: LevelAnalysis[]
  byLevel: LevelLookup
  readonly slabs: Slab[]
  grossArea: number
  netArea: number
}

interface ContentAnalysis {
  simple: boolean
  levelWalls: Wall[]
  rooms: Room[]
  footprints: Map<Id, WallFootprint>
  grossArea: number
  netArea: number
  floor: MultiPolygon
  outline: MultiPolygon
  walls: MultiPolygon
  exteriorWalls: Set<Id>
  exteriorSides: Map<Id, 1 | -1 | 0>
  intersections: Intersection[]
  topOffsets: Map<Id, number>
}

const cache = new WeakMap<object, { snapshot: Snapshot; result: SiteAnalysis }>()

/** What a level's analysis depends on: its walls, their end points and the default wall thickness. */
interface ContentKey {
  walls: readonly Wall[]
  nodes: (WallNode | undefined)[]
  wallThickness: number
  /** The collection the end points were read from: if it's the same, so are they. */
  nodeCollection: object
}

/** Per content level, the last analysis and what it was made from. */
const contentCache = new Map<Id, { key: ContentKey; result: ContentAnalysis }>()
/** Per building, the last analysis, reused while its levels and their contents are the same. */
const buildingCache = new Map<
  Id,
  { levels: Level[]; contents: ContentAnalysis[]; slabThickness: number; roof: Roof; result: BuildingAnalysis }
>()

const sameRoof = (a: Roof, b: Roof) =>
  a === b ||
  (a.kind === b.kind &&
    a.pitch === b.pitch &&
    a.overhang === b.overhang &&
    a.direction === b.direction &&
    a.thickness === b.thickness &&
    a.parapet === b.parapet)

const sameItems = <T>(a: readonly T[], b: readonly T[]) => a.length === b.length && a.every((item, i) => item === b[i])

/** Whether a level's walls, their ends and the thickness are what they were, without allocating. */
function unchanged(key: ContentKey, walls: readonly Wall[], snapshot: Snapshot): boolean {
  if (key.wallThickness !== snapshot.meta.wallThickness) return false
  if (key.walls !== walls && !sameItems(key.walls, walls)) return false
  if (key.nodeCollection === snapshot.nodes) return true
  for (let i = 0; i < walls.length; i++) {
    const wall = walls[i]!
    if (key.nodes[2 * i] !== snapshot.nodes[wall.a] || key.nodes[2 * i + 1] !== snapshot.nodes[wall.b]) return false
  }
  return true
}

const NO_WALLS: readonly Wall[] = []

/** Analyses every building on the site. Cached until walls, nodes, levels or settings change. */
export function analyzeSite(snapshot: Snapshot): SiteAnalysis {
  const hit = cache.get(snapshot.walls)
  if (
    hit &&
    hit.snapshot.nodes === snapshot.nodes &&
    hit.snapshot.levels === snapshot.levels &&
    hit.snapshot.meta === snapshot.meta &&
    hit.snapshot.buildings === snapshot.buildings
  ) {
    return hit.result
  }
  const result = analyze(snapshot)
  cache.set(snapshot.walls, { snapshot, result })
  return result
}

function analyze(snapshot: Snapshot): SiteAnalysis {
  const byLevel = wallsByLevel(snapshot)
  const contents = new Map<Id, ContentAnalysis>()
  const contentOf = (levelId: Id): ContentAnalysis => {
    let content = contents.get(levelId)
    if (content) return content
    const walls = byLevel.get(levelId) ?? NO_WALLS
    const cached = contentCache.get(levelId)
    if (cached && unchanged(cached.key, walls, snapshot)) {
      // Same content; note where the points were read from, so the next check is quick too.
      cached.key.walls = walls
      cached.key.nodeCollection = snapshot.nodes
      content = cached.result
    } else {
      const key: ContentKey = {
        walls,
        nodes: walls.flatMap((w) => [snapshot.nodes[w.a], snapshot.nodes[w.b]]),
        wallThickness: snapshot.meta.wallThickness,
        nodeCollection: snapshot.nodes,
      }
      content = analyzeContent(snapshot, levelId, walls as Wall[])
      contentCache.set(levelId, { key, result: content })
    }
    contents.set(levelId, content)
    return content
  }

  const buildings = new Map<Id, BuildingAnalysis>()
  for (const building of Object.values(snapshot.buildings)) {
    buildings.set(building.id, analyzeOne(snapshot, building.id, contentOf))
  }
  // Forget levels and buildings that are gone.
  for (const id of contentCache.keys()) if (!snapshot.levels[id]) contentCache.delete(id)
  for (const id of buildingCache.keys()) if (!snapshot.buildings[id]) buildingCache.delete(id)

  let levels: LevelAnalysis[] | undefined
  let slabs: Slab[] | undefined
  let grossArea = 0
  let netArea = 0
  for (const b of buildings.values()) {
    grossArea += b.grossArea
    netArea += b.netArea
  }
  return {
    buildings,
    get levels() {
      return (levels ??= [...buildings.values()].flatMap((b) => b.levels))
    },
    byLevel: {
      get: (levelId: Id) => {
        const record = snapshot.levels[levelId]
        return record ? buildings.get(record.buildingId)?.levels.find((l) => l.level.id === levelId) : undefined
      },
    },
    get slabs() {
      return (slabs ??= [...buildings.values()].flatMap((b) => b.slabs))
    },
    grossArea,
    netArea,
  }
}

function analyzeOne(snapshot: Snapshot, buildingId: Id, contentOf: (levelId: Id) => ContentAnalysis): BuildingAnalysis {
  const sorted = (levelsByBuilding(snapshot).get(buildingId) ?? []) as Level[]
  const contents = sorted.map((level) => contentOf(contentLevelId(level)))
  const thickness = snapshot.meta.slabThickness
  const roof = roofOf(snapshot.buildings[buildingId])
  const cached = buildingCache.get(buildingId)
  if (
    cached &&
    cached.slabThickness === thickness &&
    sameRoof(cached.roof, roof) &&
    sameItems(cached.levels, sorted) &&
    sameItems(cached.contents, contents)
  ) {
    return cached.result
  }

  // One entry per level record; a run of copies is one entry for all its floors.
  const levels: LevelAnalysis[] = sorted.map(
    (level, i) => new FloorAnalysis(level, contentLevelId(level), floorsOf(level), contents[i]!),
  )
  const slabs: Slab[] = []
  levels.forEach((current, i) => {
    const below = levels[i - 1]
    // A floor slab runs out to the outer faces of the walls, both of this
    // level and of the one below, so it also covers overhangs and terraces.
    // Walls stop under it and start on top of it.
    const region = below ? (below.outline === current.outline ? current.outline : union(current.outline, below.outline)) : current.outline
    const { elevation, height, id } = current.level
    if (region.length > 0) {
      slabs.push({ id: `floor:${id}`, buildingId, levelId: id, top: elevation, bottom: elevation - thickness, region, count: 1, step: height })
    }
    // The floors further up a run of copies.
    if (current.floors > 1 && current.outline.length > 0) {
      const top = elevation + height
      slabs.push({
        id: `floors:${id}`,
        buildingId,
        levelId: id,
        top,
        bottom: top - thickness,
        region: current.outline,
        count: current.floors - 1,
        step: height,
      })
    }
  })
  const topLevel = levels.at(-1)
  if (topLevel && topLevel.outline.length > 0) {
    const top = topLevel.level.elevation + topLevel.level.height * topLevel.floors
    slabs.push({
      id: `roof:${topLevel.level.id}`,
      buildingId,
      levelId: null,
      top,
      bottom: top - thickness,
      region: topLevel.outline,
      count: 1,
      step: 0,
    })
  }

  const result: BuildingAnalysis = {
    buildingId,
    levels,
    slabs,
    roof,
    grossArea: levels.reduce((sum, l) => sum + l.grossArea * l.floors, 0),
    netArea: levels.reduce((sum, l) => sum + l.netArea * l.floors, 0),
  }
  buildingCache.set(buildingId, { levels: sorted, contents, slabThickness: thickness, roof, result })
  return result
}

function analyzeContent(snapshot: Snapshot, levelId: Id, walls: Wall[]): ContentAnalysis {
  const simple = simpleLoop(snapshot, levelId, walls)
  if (simple) return simple
  const footprints = computeFootprints(snapshot.nodes, walls, (w) => w.thickness ?? snapshot.meta.wallThickness)
  const wallRegion = union(...[...footprints.values()].map((fp) => [[toRing(fp.polygon)]] as MultiPolygon))

  // Rooms are the spaces the walls enclose: the holes in all walls taken
  // together. That works whether walls are joined at nodes or just overlap.
  const rooms: Room[] = []
  let grossArea = 0
  for (const polygon of wallRegion) {
    const [outer, ...holes] = polygon
    if (!outer || holes.length === 0) continue
    grossArea += ringArea(outer)
    for (const hole of holes) {
      const outline = counterClockwise(fromRing(hole))
      // Wall groups standing inside this room (with any rooms of their own) are cut out.
      const islands = wallRegion.filter(
        (other) => other !== polygon && !!other[0]?.[0] && pointInRing(toPoint(other[0][0]), outline),
      )
      const floor = difference([[toRing(outline)]], ...islands.map((island) => [[island[0]!]] as MultiPolygon))
      const area = regionArea(floor)
      if (area < MIN_ROOM_AREA) continue
      rooms.push({
        id: roomId(outline, area),
        levelId,
        outline,
        floor,
        area,
        perimeter: regionPerimeter(floor),
        labelPoint: labelPoint(floor),
      })
    }
  }

  // A wall is part of the shell when the ground just beside one of its faces
  // lies outside the outline (the building with its rooms filled in).
  const outline = union(...wallRegion.filter((p) => p.length > 1 && p[0]).map((p) => [[p[0]!]] as MultiPolygon))
  const exteriorWalls = new Set<Id>()
  const exteriorSides = new Map<Id, 1 | -1 | 0>()
  for (const [wallId, fp] of footprints) {
    const mid = { x: (fp.a.x + fp.b.x) / 2, y: (fp.a.y + fp.b.y) / 2 }
    const normal = perpLeft(normalize(sub(fp.b, fp.a)))
    const reach = fp.thickness / 2 + 0.05
    const left = !pointInRegion(add(mid, scale(normal, reach)), outline)
    const right = !pointInRegion(add(mid, scale(normal, -reach)), outline)
    if (left || right) {
      exteriorWalls.add(wallId)
      exteriorSides.set(wallId, left && right ? 0 : left ? 1 : -1)
    }
  }

  const intersections = findIntersections(snapshot, levelId, walls)
  return {
    simple: false,
    levelWalls: walls,
    rooms: sortRooms(rooms),
    footprints,
    grossArea,
    netArea: rooms.reduce((sum, r) => sum + r.area, 0),
    floor: union(...rooms.map((r) => r.floor)),
    // Wall groups that enclose rooms, with their rooms filled in.
    outline,
    walls: wallRegion,
    exteriorWalls,
    exteriorSides,
    intersections,
    topOffsets: topOffsets(intersections),
  }
}

/**
 * Gives walls that overlap at unjoined crossings or touches different tiny
 * height offsets (a greedy colouring, so overlapping walls always differ).
 */
function topOffsets(intersections: readonly Intersection[]): Map<Id, number> {
  const neighbours = new Map<Id, Set<Id>>()
  for (const intersection of intersections) {
    if (intersection.kind === 'junction') continue
    // The first wall overlaps each of the others (the crossing one, or every wall ending on it).
    const [first, ...others] = intersection.wallIds
    if (!first) continue
    for (const other of others) {
      neighbours.set(first, (neighbours.get(first) ?? new Set()).add(other))
      neighbours.set(other, (neighbours.get(other) ?? new Set()).add(first))
    }
  }
  const colours = new Map<Id, number>()
  for (const id of [...neighbours.keys()].sort()) {
    const taken = new Set([...neighbours.get(id)!].map((n) => colours.get(n)))
    let colour = 0
    while (taken.has(colour)) colour++
    colours.set(id, colour)
  }
  // Downwards, so no wall pokes into the slab above it.
  return new Map([...colours].map(([id, colour]) => [id, -colour * 0.0008]))
}

const toPoint = ([x, y]: [number, number]): Vec2 => ({ x, y })

function counterClockwise(points: Vec2[]): Vec2[] {
  return signedArea2(points) >= 0 ? points : [...points].reverse()
}

function roomId(outline: Vec2[], area: number): string {
  const c = polygonCentroid(outline)
  return `room:${c.x.toFixed(2)}:${c.y.toFixed(2)}:${area.toFixed(2)}`
}

/** Reading order: top to bottom, then left to right, as on a plan. */
function sortRooms(rooms: Room[]): Room[] {
  return [...rooms].sort((p, q) => {
    const a = p.labelPoint ?? p.outline[0]!
    const b = q.labelPoint ?? q.outline[0]!
    return Math.abs(a.y - b.y) > 0.5 ? b.y - a.y : a.x - b.x
  })
}

/** The fast path takes no corner sharper than this (the general one handles mitre limits). */
const SIMPLE_MIN_ANGLE = (35 * Math.PI) / 180

/**
 * A level whose walls form one simple closed loop, such as the outline of
 * most buildings: its outer and inner rings follow from the wall centre
 * lines offset by half their thickness, mitred like the footprints, with
 * no general polygon operations. Null when the walls are anything else.
 */
function simpleLoop(snapshot: Snapshot, levelId: Id, walls: Wall[]): ContentAnalysis | null {
  if (walls.length < 3) return null
  const atNode = new Map<Id, Wall[]>()
  for (const wall of walls) {
    if (wall.a === wall.b) return null
    for (const id of [wall.a, wall.b]) {
      const list = atNode.get(id)
      if (list) list.push(wall)
      else atNode.set(id, [wall])
    }
  }
  if (atNode.size !== walls.length) return null
  for (const list of atNode.values()) if (list.length !== 2) return null

  // Walk the loop.
  const order: Id[] = []
  const edges: Wall[] = []
  let wall = walls[0]!
  let node = wall.a
  for (let i = 0; i < walls.length; i++) {
    order.push(node)
    edges.push(wall)
    node = wall.a === node ? wall.b : wall.a
    const [first, second] = atNode.get(node)!
    wall = first === wall ? second! : first!
  }
  if (node !== order[0] || new Set(edges).size !== walls.length) return null

  const intersections = findIntersections(snapshot, levelId, walls)
  if (intersections.some((i) => i.kind !== 'junction')) return null

  const points = order.map((id) => snapshot.nodes[id])
  if (points.some((p) => !p)) return null
  const pts = points as Vec2[]
  const n = pts.length
  const area2 = signedArea2(pts)
  if (Math.abs(area2) < 1e-6) return null
  const ccw = area2 > 0
  for (let i = 0; i < n; i++) {
    const prev = pts[(i + n - 1) % n]!
    const here = pts[i]!
    const next = pts[(i + 1) % n]!
    let turn = Math.abs(angleOf(sub(prev, here)) - angleOf(sub(next, here)))
    if (turn > Math.PI) turn = 2 * Math.PI - turn
    if (turn < SIMPLE_MIN_ANGLE) return null
  }

  const half = edges.map((w) => (w.thickness ?? snapshot.meta.wallThickness) / 2)
  // Left of the walking direction is inside for an anticlockwise loop.
  const inner = offsetRing(pts, half.map((h) => (ccw ? h : -h)))
  const outer = offsetRing(pts, half.map((h) => (ccw ? -h : h)))
  if (!inner || !outer) return null
  const innerCcw = ccw ? inner : [...inner].reverse()
  const outerCcw = ccw ? outer : [...outer].reverse()
  const innerArea = signedArea2(innerCcw) / 2
  const outerArea = signedArea2(outerCcw) / 2
  // An inner ring turned inside out means walls thicker than the room: let the general path decide.
  if (innerArea <= 0 || outerArea <= innerArea) return null

  // Walked from a to b, the outside of an anticlockwise loop is on the right.
  const outsideLeft = edges.map((w, i) => (w.a === order[i]) !== ccw)
  const nodes: Record<Id, WallNode> = {}
  for (const id of order) nodes[id] = snapshot.nodes[id]!
  return new LoopContent(levelId, walls, edges, outsideLeft, nodes, snapshot.meta.wallThickness, innerCcw, outerCcw, innerArea, outerArea, intersections)
}

const NO_INTERSECTIONS: Intersection[] = []
const NO_OFFSETS = new Map<Id, number>()

/**
 * The analysis of a simple loop of walls. Rooms and regions are made only
 * when asked for: across a city, nothing but the outline and the areas is
 * needed until a building is opened.
 */
class LoopContent implements ContentAnalysis {
  readonly simple = true
  readonly levelWalls: Wall[]
  readonly grossArea: number
  readonly netArea: number
  readonly outline: MultiPolygon
  readonly intersections: Intersection[]
  readonly topOffsets: Map<Id, number>
  private readonly levelId: Id
  private readonly edges: Wall[]
  private readonly outsideLeft: boolean[]
  private readonly nodes: Record<Id, WallNode>
  private readonly wallThickness: number
  private readonly inner: Vec2[]
  private readonly outer: Vec2[]
  private madeRooms: { rooms: Room[]; floor: MultiPolygon; walls: MultiPolygon } | null = null
  private madeWalls: { footprints: Map<Id, WallFootprint>; exteriorWalls: Set<Id>; exteriorSides: Map<Id, 1 | -1 | 0> } | null =
    null

  constructor(
    levelId: Id,
    walls: Wall[],
    edges: Wall[],
    outsideLeft: boolean[],
    nodes: Record<Id, WallNode>,
    wallThickness: number,
    inner: Vec2[],
    outer: Vec2[],
    innerArea: number,
    outerArea: number,
    intersections: Intersection[],
  ) {
    const room = innerArea >= MIN_ROOM_AREA
    this.levelId = levelId
    this.levelWalls = walls
    this.edges = edges
    this.outsideLeft = outsideLeft
    this.nodes = nodes
    this.wallThickness = wallThickness
    this.inner = inner
    this.outer = outer
    this.grossArea = room ? outerArea : 0
    this.netArea = room ? innerArea : 0
    this.outline = room ? [[toRing(outer)]] : []
    this.intersections = intersections.length > 0 ? intersections : NO_INTERSECTIONS
    this.topOffsets = intersections.length > 0 ? topOffsets(intersections) : NO_OFFSETS
  }

  private rooms_() {
    if (this.madeRooms) return this.madeRooms
    const floor: MultiPolygon = [[toRing(this.inner)]]
    const rooms: Room[] =
      this.netArea > 0
        ? [
            {
              id: roomId(this.inner, this.netArea),
              levelId: this.levelId,
              outline: this.inner,
              floor,
              area: this.netArea,
              perimeter: regionPerimeter(floor),
              labelPoint: labelPoint(floor),
            },
          ]
        : []
    this.madeRooms = {
      rooms,
      floor: rooms.length > 0 ? floor : [],
      walls: [[toRing(this.outer), toRing([...this.inner].reverse())]],
    }
    return this.madeRooms
  }

  private walls_() {
    if (this.madeWalls) return this.madeWalls
    const footprints = computeFootprints(this.nodes, this.levelWalls, (w) => w.thickness ?? this.wallThickness)
    const exteriorSides = new Map<Id, 1 | -1 | 0>()
    this.edges.forEach((w, i) => exteriorSides.set(w.id, this.outsideLeft[i] ? 1 : -1))
    this.madeWalls = { footprints, exteriorWalls: new Set(this.levelWalls.map((w) => w.id)), exteriorSides }
    return this.madeWalls
  }

  get rooms() {
    return this.rooms_().rooms
  }
  get floor() {
    return this.rooms_().floor
  }
  get walls() {
    return this.rooms_().walls
  }
  get footprints() {
    return this.walls_().footprints
  }
  get exteriorWalls() {
    return this.walls_().exteriorWalls
  }
  get exteriorSides() {
    return this.walls_().exteriorSides
  }
}

/** A level's analysis: its own record, its floors, and its content's (shared with its copies). */
class FloorAnalysis implements LevelAnalysis {
  readonly level: Level
  readonly contentLevelId: Id
  readonly floors: number
  private readonly content: ContentAnalysis

  constructor(level: Level, contentLevelId: Id, floors: number, content: ContentAnalysis) {
    this.level = level
    this.contentLevelId = contentLevelId
    this.floors = floors
    this.content = content
  }

  get simple() {
    return this.content.simple
  }
  get levelWalls() {
    return this.content.levelWalls
  }
  get rooms() {
    return this.content.rooms
  }
  get footprints() {
    return this.content.footprints
  }
  get grossArea() {
    return this.content.grossArea
  }
  get netArea() {
    return this.content.netArea
  }
  get floor() {
    return this.content.floor
  }
  get outline() {
    return this.content.outline
  }
  get walls() {
    return this.content.walls
  }
  get exteriorWalls() {
    return this.content.exteriorWalls
  }
  get exteriorSides() {
    return this.content.exteriorSides
  }
  get intersections() {
    return this.content.intersections
  }
  get topOffsets() {
    return this.content.topOffsets
  }
}

/**
 * A closed ring offset edge by edge (positive to the left of each edge),
 * mitred at the corners. Null if two neighbouring edges are parallel and
 * offset differently.
 */
function offsetRing(points: readonly Vec2[], offsets: readonly number[]): Vec2[] | null {
  const n = points.length
  const result: Vec2[] = []
  for (let i = 0; i < n; i++) {
    const prev = points[(i + n - 1) % n]!
    const here = points[i]!
    const next = points[(i + 1) % n]!
    const d1 = normalize(sub(here, prev))
    const d2 = normalize(sub(next, here))
    const o1 = offsets[(i + n - 1) % n]!
    const o2 = offsets[i]!
    const hit = intersectLines(add(prev, scale(perpLeft(d1), o1)), d1, add(here, scale(perpLeft(d2), o2)), d2)
    if (hit) result.push(hit.point)
    else if (Math.abs(o1 - o2) < 1e-9) result.push(add(here, scale(perpLeft(d2), o2)))
    else return null
  }
  return result
}
