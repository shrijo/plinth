/**
 * The site model: buildings (with their levels, walls and openings) and a
 * street network. Records are plain, immutable JSON objects stored flat by
 * ID; they refer to each other by ID only. All positions are site
 * coordinates in metres: moving a building moves its points.
 *
 * A `null` property means "use the default": a wall with `thickness: null`
 * follows the project's default thickness, and one with `height: null`
 * follows its level's height.
 */

import type { Vec2 } from './math.ts'

export type Id = string

export interface Meta {
  schemaVersion: 3
  name: string
  /** Default wall thickness in metres. */
  wallThickness: number
  /** Floor slab thickness in metres. */
  slabThickness: number
  /** The standard area figures follow. */
  areaStandard: AreaStandard
  /** Where the site's zero is in the coordinates of imported data (parcels, terrain), once something is imported. */
  origin?: GeoOrigin
  /**
   * The ground height the site's zero stands for, in the heights of its
   * spot heights (metres above sea level for imported terrain); 0 if unset.
   * Buildings and streets are measured from the site's zero.
   */
  ground?: number
  /**
   * The real-world area the site was made from (from map data, see the
   * world explorer), in site metres: around it the real world shows as
   * context; inside it the site's own model stands in for it.
   */
  worldArea?: Vec2[]
}

/**
 * The real-world point at the site's zero: in longitude and latitude
 * (degrees, WGS 84), or in the projected coordinates (metres, such as
 * Swiss LV95) the imported data came in.
 */
export type GeoOrigin = { kind: 'lonlat'; lon: number; lat: number } | { kind: 'projected'; x: number; y: number }

/** Area standards: SIA 416 (Switzerland) and DIN 277 (Germany). */
export type AreaStandard = 'sia416' | 'din277'
export const AREA_STANDARDS: readonly AreaStandard[] = ['sia416', 'din277']

/** A building on the site. Its floors are the levels that point to it. */
export interface Building {
  id: Id
  name: string
  /** The roof on its top floor; none is a flat roof. */
  roof?: Roof
}

export type RoofKind = 'flat' | 'shed' | 'gable' | 'hip'
export const ROOF_KINDS: readonly RoofKind[] = ['flat', 'shed', 'gable', 'hip']

/**
 * A building's roof, sitting on its top floor's outline: flat (with a
 * parapet if wanted), shed (one slope), gable (two slopes meeting at a
 * ridge, the end walls carried up to them) or hip (sloping on every side;
 * a ring of slopes on a courtyard block).
 */
export interface Roof {
  kind: RoofKind
  /** Slope of a pitched roof, in degrees from level. */
  pitch: number
  /** How far the roof reaches out past the walls, in metres. */
  overhang: number
  /**
   * Which way the ridge runs (gable, hip) or the roof falls (shed), in
   * degrees anticlockwise from east (+x); null runs it along the
   * building's longest side.
   */
  direction: number | null
  /** The roof's own thickness, in metres. */
  thickness: number
  /** Height of the low wall round a flat roof, in metres; 0 for none. */
  parapet: number
}

/** A building without a roof of its own has this one. */
export const FLAT_ROOF: Roof = { kind: 'flat', pitch: 35, overhang: 0, direction: null, thickness: 0.3, parapet: 0 }

export function roofOf(building: Pick<Building, 'roof'> | undefined): Roof {
  return building?.roof ?? FLAT_ROOF
}

export interface Level {
  id: Id
  /** The building this level is a floor of. */
  buildingId: Id
  name: string
  /**
   * Height of the level's floor above ground, in metres. Levels stack: each
   * starts where the one below ends (see `restackLevels`).
   */
  elevation: number
  /** Floor-to-floor height in metres; the default height of its walls. */
  height: number
  /**
   * Set on a copy of another level. A copy has no walls of its own: it shows
   * its master's, and follows every change to them until it is detached.
   * Missing in files from before copies existed.
   */
  masterId?: Id | null
  /**
   * For a copy: how many identical floors in a row it stands for (one when
   * missing). A tower's thirty typical floors are one record, not thirty.
   */
  count?: number
}

/** How many windows or doors an opening stands for: each of a row counts. */
export function rowCount(opening: Pick<Opening, 'count'>): number {
  return Math.max(1, Math.floor(opening.count ?? 1))
}

/** Centre-to-centre distance in a row: never less than the width, so neighbours don't overlap. */
export function rowSpacing(opening: Pick<Opening, 'spacing' | 'width'>): number {
  return Math.max(opening.spacing ?? opening.width, opening.width)
}

/** How far a row reaches from its centre to its outer edges, along the wall (half the width for one). */
export function rowReach(opening: Pick<Opening, 'count' | 'spacing' | 'width'>): number {
  return ((rowCount(opening) - 1) * rowSpacing(opening)) / 2 + opening.width / 2
}

/**
 * Each window or door an opening stands for, as single openings (the same
 * id, moved along the wall): just the opening itself unless it's a row.
 */
export function openingCopies(opening: Opening): Opening[] {
  const n = rowCount(opening)
  if (n === 1) return [opening]
  const step = rowSpacing(opening)
  const first = opening.offset - ((n - 1) * step) / 2
  const { count: _count, spacing: _spacing, ...single } = opening
  const copies: Opening[] = []
  for (let k = 0; k < n; k++) copies.push({ ...single, offset: first + k * step })
  return copies
}

/** How many floors a level stands for: a run of copies counts each. */
export function floorsOf(level: Pick<Level, 'masterId' | 'count'>): number {
  return level.masterId ? Math.max(1, Math.floor(level.count ?? 1)) : 1
}

/** How much of the stack a level takes up: its height times its floors. */
export function stackHeight(level: Pick<Level, 'masterId' | 'count' | 'height'>): number {
  return level.height * floorsOf(level)
}

/** A junction point in a level's wall graph. Coordinates are plan metres. */
export interface WallNode {
  id: Id
  levelId: Id
  x: number
  y: number
}

/** A straight wall between two nodes. The drawn line is its centre line. */
export interface Wall {
  id: Id
  levelId: Id
  a: Id
  b: Id
  /** Thickness in metres, or null for the project default. */
  thickness: number | null
  /**
   * Height at node `a` in metres, or null for the level's clear height: its
   * floor height minus the slab above, so the wall stops under the next floor.
   */
  height: number | null
  /** Height at node `b`, or null for "same as the height at `a`". */
  heightEnd: number | null
}

export type OpeningKind = 'window' | 'door'

/** A hole in a wall, filled with a window or door type (or left empty). */
export interface Opening {
  id: Id
  wallId: Id
  kind: OpeningKind
  /** The fill, from `OPENING_TYPES`. */
  typeId: string
  /** Distance along the wall from its start (node `a`) to the opening's centre, in metres. */
  offset: number
  width: number
  height: number
  /** Height of the opening's bottom above the level's floor. 0 for doors. */
  sill: number
  /** Whether the door or window is shown open. */
  open?: boolean
  /** Hinges on the other jamb (the wall's end side instead of its start side). */
  flipHinge?: boolean
  /** Opens towards the wall's left face instead of its right face (seen from its start). */
  flipSide?: boolean
  /**
   * A row of identical windows or doors along the wall: how many (2 or
   * more), centred on `offset`, `spacing` apart. One record for a whole
   * facade's worth, the way a run of floors is one level.
   */
  count?: number
  /** Distance between the centres of neighbours in a row, in metres. At least the width. */
  spacing?: number
}

/** A point in the street network: an intersection, an end, or a bend between straight streets. */
export interface StreetNode {
  id: Id
  x: number
  y: number
}

/**
 * A street between two street nodes. Its cross-section is measured from the
 * centre line outwards, per side ("left" and "right" seen from `a` to `b`):
 * half the carriageway, then a bike lane, a parking lane and a sidewalk.
 */
export interface Street {
  id: Id
  a: Id
  b: Id
  /** Control point of a curved street (a quadratic curve), or null for a straight one. */
  control: Vec2Like | null
  /** Driving lanes in total, both directions together. */
  lanes: number
  laneWidth: number
  bikeLeft: number
  bikeRight: number
  parkingLeft: number
  parkingRight: number
  sidewalkLeft: number
  sidewalkRight: number
  /** Zebra crossings near each end. */
  crosswalkA: boolean
  crosswalkB: boolean
  /**
   * What kind of street it is, as OpenStreetMap's highway types: it sets the
   * cross-section's defaults, and living streets and pedestrian zones are
   * one paved surface, without curbs or lane lines. Residential when missing.
   */
  kind?: StreetKind
  /** Traffic one way (from a to b): no line down the middle. */
  oneway?: boolean
}

/** Street types, as OpenStreetMap's `highway=*` values. */
export type StreetKind =
  | 'motorway'
  | 'trunk'
  | 'primary'
  | 'secondary'
  | 'tertiary'
  | 'unclassified'
  | 'residential'
  | 'living_street'
  | 'pedestrian'
  | 'service'

export const STREET_KINDS: readonly StreetKind[] = [
  'motorway',
  'trunk',
  'primary',
  'secondary',
  'tertiary',
  'unclassified',
  'residential',
  'living_street',
  'pedestrian',
  'service',
]

/** Whether a street is one shared surface (a living street or pedestrian zone): paved, no curbs, no lane lines. */
export function isSharedStreet(street: Pick<Street, 'kind'>): boolean {
  return street.kind === 'living_street' || street.kind === 'pedestrian'
}

export interface Vec2Like {
  x: number
  y: number
}

export interface Snapshot {
  readonly meta: Meta
  readonly buildings: Readonly<Record<Id, Building>>
  readonly levels: Readonly<Record<Id, Level>>
  readonly nodes: Readonly<Record<Id, WallNode>>
  readonly walls: Readonly<Record<Id, Wall>>
  readonly openings: Readonly<Record<Id, Opening>>
  readonly streetNodes: Readonly<Record<Id, StreetNode>>
  readonly streets: Readonly<Record<Id, Street>>
  readonly roomTags: Readonly<Record<Id, RoomTag>>
  readonly parcels: Readonly<Record<Id, Parcel>>
  readonly spotHeights: Readonly<Record<Id, SpotHeight>>
}

export type StreetProps = Omit<Street, 'id' | 'a' | 'b' | 'control'>

export const DEFAULT_STREET: StreetProps = {
  lanes: 2,
  laneWidth: 3.25,
  bikeLeft: 0,
  bikeRight: 0,
  parkingLeft: 0,
  parkingRight: 0,
  sidewalkLeft: 2,
  sidewalkRight: 2,
  crosswalkA: false,
  crosswalkB: false,
}

/** Height of the curb: sidewalks stand this much above the road. */
export const CURB_HEIGHT = 0.15

export const DEFAULT_META: Meta = {
  schemaVersion: 3,
  name: 'Untitled',
  wallThickness: 0.2,
  slabThickness: 0.25,
  areaStandard: 'sia416',
}

/** What a room is for, as area standards group rooms. */
export type RoomUse =
  | 'living'
  | 'office'
  | 'production'
  | 'retail'
  | 'storage'
  | 'education'
  | 'care'
  | 'sanitary'
  | 'parking'
  | 'circulation'
  | 'technical'
  | 'other'

export const ROOM_USES: readonly RoomUse[] = [
  'living',
  'office',
  'production',
  'retail',
  'storage',
  'education',
  'care',
  'sanitary',
  'parking',
  'circulation',
  'technical',
  'other',
]

/**
 * A room's name and use, kept at a point inside it. Rooms are worked out
 * from the walls, so they have no record of their own; the room that
 * contains the tag's point has its name and use, however its walls change.
 */
export interface RoomTag {
  id: Id
  /** The level whose walls make the room (a copy shows its master's tags). */
  levelId: Id
  x: number
  y: number
  name: string
  use: RoomUse
}

/** A plot of land on the site, by its outline. */
export interface Parcel {
  id: Id
  name: string
  /** Its corners, in order. */
  points: Vec2[]
}

/** A point of known ground height; the terrain is drawn through them. */
export interface SpotHeight {
  id: Id
  x: number
  y: number
  /**
   * Its height in metres, in the same terms as Meta.ground (above sea level
   * for imported terrain); the site draws it from its zero (z − ground).
   */
  z: number
}

export const DEFAULT_LEVEL_HEIGHT = 3

/** Walls shorter than this (metres) are not created. */
export const MIN_WALL_LENGTH = 0.01

export interface ResolvedWall {
  thickness: number
  heightStart: number
  heightEnd: number
}

/** A level's clear height: from its floor to the underside of the slab above. */
export function clearHeight(level: Level | undefined, meta: Meta): number {
  return Math.max(0.1, (level?.height ?? DEFAULT_LEVEL_HEIGHT) - meta.slabThickness)
}

/** Fills in a wall's defaults from its level and the project. */
export function resolveWall(wall: Wall, level: Level | undefined, meta: Meta): ResolvedWall {
  const heightStart = wall.height ?? clearHeight(level, meta)
  return {
    thickness: wall.thickness ?? meta.wallThickness,
    heightStart,
    heightEnd: wall.heightEnd ?? heightStart,
  }
}

/** Each level's walls (shared lists: don't change them). */
export function wallsByLevel(snapshot: Snapshot): ReadonlyMap<Id, readonly Wall[]> {
  return groupBy(snapshot.walls, (w) => w.levelId)
}

export function wallsOnLevel(snapshot: Snapshot, levelId: Id): Wall[] {
  return [...(groupBy(snapshot.walls, (w) => w.levelId).get(levelId) ?? [])]
}

export function nodesOnLevel(snapshot: Snapshot, levelId: Id): WallNode[] {
  return [...(groupBy(snapshot.nodes, (n) => n.levelId).get(levelId) ?? [])]
}

export function openingsOnWall(snapshot: Snapshot, wallId: Id): Opening[] {
  return [...(groupBy(snapshot.openings, (o) => o.wallId).get(wallId) ?? [])]
}

/** Levels sorted from the ground up: of one building, or of all of them. */
/**
 * Lookups by owner, built once per version of the collection (snapshots
 * share unchanged collections), so asking for one building's levels or one
 * level's walls doesn't scan a whole city.
 */
const indexes = new WeakMap<object, Map<Id, unknown[]>>()
function groupBy<T>(collection: Readonly<Record<Id, T>>, key: (item: T) => Id, sort?: (a: T, b: T) => number): Map<Id, T[]> {
  let index = indexes.get(collection) as Map<Id, T[]> | undefined
  if (!index) {
    index = new Map()
    for (const item of Object.values(collection)) {
      const k = key(item)
      const list = index.get(k)
      if (list) list.push(item)
      else index.set(k, [item])
    }
    if (sort) for (const list of index.values()) list.sort(sort)
    indexes.set(collection, index as Map<Id, unknown[]>)
  }
  return index
}

const byElevation = (a: Level, b: Level) => a.elevation - b.elevation

/** Each building's levels, from the ground up. */
export function levelsByBuilding(snapshot: Snapshot): ReadonlyMap<Id, readonly Level[]> {
  return groupBy(snapshot.levels, (l) => l.buildingId, byElevation)
}

/** A building's levels from the ground up (a new array), or every level on the site. */
export function sortedLevels(snapshot: Snapshot, buildingId?: Id): Level[] {
  if (buildingId === undefined) return Object.values(snapshot.levels).sort(byElevation)
  return [...(levelsByBuilding(snapshot).get(buildingId) ?? [])]
}

/** The building a level, wall or point belongs to. */
export function buildingOfLevel(snapshot: Snapshot, levelId: Id): Id | undefined {
  return snapshot.levels[levelId]?.buildingId
}

/** The level whose walls a level shows: its master for a copy, otherwise itself. */
export function contentLevelId(level: Level): Id {
  return level.masterId ?? level.id
}

export function isCopy(level: Level | undefined): boolean {
  return !!level?.masterId
}
