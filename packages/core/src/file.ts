import {
  DEFAULT_META,
  AREA_STANDARDS,
  DEFAULT_STREET,
  ROOF_KINDS,
  ROOM_USES,
  type AreaStandard,
  type Parcel,
  type RoomTag,
  type SpotHeight,
  type Building,
  type Level,
  type Meta,
  type Opening,
  type Roof,
  type Snapshot,
  type Street,
  type StreetNode,
  type Wall,
  type WallNode,
} from './model.ts'
import { isGeoOrigin } from './tx.ts'

/** The on-disk project format: a `.plinth` file is this as JSON. */
export interface ProjectFile {
  format: 'plinth'
  version: 3
  meta: Meta
  buildings: Building[]
  levels: Level[]
  nodes: WallNode[]
  walls: Wall[]
  openings: Opening[]
  streetNodes: StreetNode[]
  streets: Street[]
  roomTags: RoomTag[]
  parcels: Parcel[]
  spotHeights: SpotHeight[]
}

export const PROJECT_FILE_EXTENSION = 'plinth'

/** Versions this app can read. Versions 1 and 2 held a single building and aren't carried over. */
const READABLE_VERSIONS = [3]

export function snapshotToProject(snapshot: Snapshot): ProjectFile {
  return {
    format: 'plinth',
    version: 3,
    meta: snapshot.meta,
    buildings: Object.values(snapshot.buildings),
    levels: Object.values(snapshot.levels),
    nodes: Object.values(snapshot.nodes),
    walls: Object.values(snapshot.walls),
    openings: Object.values(snapshot.openings),
    streetNodes: Object.values(snapshot.streetNodes),
    streets: Object.values(snapshot.streets),
    roomTags: Object.values(snapshot.roomTags),
    parcels: Object.values(snapshot.parcels),
    spotHeights: Object.values(snapshot.spotHeights),
  }
}

export function serializeProject(snapshot: Snapshot): string {
  return `${JSON.stringify(snapshotToProject(snapshot), null, 2)}\n`
}

export function emptyProject(name = DEFAULT_META.name): ProjectFile {
  return {
    format: 'plinth',
    version: 3,
    meta: { ...DEFAULT_META, name },
    buildings: [],
    levels: [],
    nodes: [],
    walls: [],
    openings: [],
    streetNodes: [],
    streets: [],
    roomTags: [],
    parcels: [],
    spotHeights: [],
  }
}

export class ProjectFileError extends Error {}

/** Parses and checks a `.plinth` file. Throws `ProjectFileError` if it isn't one. */
export function parseProject(text: string): ProjectFile {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new ProjectFileError('This file is not valid JSON.')
  }
  if (!isObject(data) || data.format !== 'plinth') {
    throw new ProjectFileError('This is not a Plinth project file.')
  }
  if (!READABLE_VERSIONS.includes(data.version as number)) {
    throw new ProjectFileError(
      (data.version as number) < 3
        ? 'This file is from before sites with several buildings, and can no longer be opened.'
        : `This file uses format version ${String(data.version)}, which this app can't read.`,
    )
  }
  const meta = isObject(data.meta) ? data.meta : {}
  // A roof that doesn't make sense is dropped (the building gets a flat one), not the building.
  const buildings = arrayOf(data.buildings, isBuilding).map(({ roof, ...building }): Building =>
    isRoof(roof) ? { ...building, roof } : building,
  )
  const buildingIds = new Set(buildings.map((b) => b.id))
  const levels = arrayOf(data.levels, isLevel)
    .filter((l) => buildingIds.has(l.buildingId))
    .map((l) => ({ ...l, masterId: l.masterId ?? null }))
  const levelIds = new Set(levels.map((l) => l.id))
  const masterIds = new Set(levels.filter((l) => !l.masterId).map((l) => l.id))
  // A copy must point at a level that exists and isn't itself a copy.
  for (const level of levels) {
    if (level.masterId && !masterIds.has(level.masterId)) level.masterId = null
  }
  const nodes = arrayOf(data.nodes, isNode).filter((n) => levelIds.has(n.levelId))
  const nodeIds = new Set(nodes.map((n) => n.id))
  const walls = arrayOf(data.walls, isWall).filter(
    (w) => levelIds.has(w.levelId) && nodeIds.has(w.a) && nodeIds.has(w.b) && w.a !== w.b,
  )
  const wallIds = new Set(walls.map((w) => w.id))
  const openings = arrayOf(data.openings, isOpening).filter((o) => wallIds.has(o.wallId))
  const streetNodes = arrayOf(data.streetNodes, isStreetNode)
  const streetNodeIds = new Set(streetNodes.map((n) => n.id))
  const streets = arrayOf(data.streets, isStreetRecord)
    .filter((s) => streetNodeIds.has(s.a) && streetNodeIds.has(s.b) && s.a !== s.b)
    .map((s): Street => ({ ...DEFAULT_STREET, ...s, control: s.control ?? null }))
  return {
    format: 'plinth',
    version: 3,
    meta: {
      schemaVersion: 3,
      name: typeof meta.name === 'string' ? meta.name : DEFAULT_META.name,
      wallThickness: isPositive(meta.wallThickness) ? meta.wallThickness : DEFAULT_META.wallThickness,
      slabThickness: isPositive(meta.slabThickness) ? meta.slabThickness : DEFAULT_META.slabThickness,
      areaStandard: (AREA_STANDARDS as readonly unknown[]).includes(meta.areaStandard)
        ? (meta.areaStandard as AreaStandard)
        : DEFAULT_META.areaStandard,
      ...(isGeoOrigin(meta.origin) ? { origin: meta.origin } : {}),
      ...(isFiniteNumber(meta.ground) ? { ground: meta.ground } : {}),
    },
    buildings,
    levels,
    nodes,
    walls,
    openings,
    streetNodes,
    streets,
    // Added later: older files have none.
    roomTags: arrayOf(data.roomTags, isRoomTag).filter((t) => levelIds.has(t.levelId)),
    parcels: arrayOf(data.parcels, isParcel),
    spotHeights: arrayOf(data.spotHeights, isSpotHeight),
  }
}

function isRoomTag(v: unknown): v is RoomTag {
  return (
    isObject(v) &&
    isString(v.id) &&
    isString(v.levelId) &&
    isFiniteNumber(v.x) &&
    isFiniteNumber(v.y) &&
    typeof v.name === 'string' &&
    (ROOM_USES as readonly unknown[]).includes(v.use)
  )
}

function isParcel(v: unknown): v is Parcel {
  return (
    isObject(v) &&
    isString(v.id) &&
    typeof v.name === 'string' &&
    Array.isArray(v.points) &&
    v.points.length >= 3 &&
    v.points.every((p) => isObject(p) && isFiniteNumber(p.x) && isFiniteNumber(p.y))
  )
}

function isSpotHeight(v: unknown): v is SpotHeight {
  return isObject(v) && isString(v.id) && isFiniteNumber(v.x) && isFiniteNumber(v.y) && isFiniteNumber(v.z)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function arrayOf<T>(value: unknown, guard: (item: unknown) => item is T): T[] {
  return Array.isArray(value) ? value.filter(guard) : []
}

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isPositive = (v: unknown): v is number => isFiniteNumber(v) && v > 0
const isNonNegative = (v: unknown): v is number => isFiniteNumber(v) && v >= 0
const isNullablePositive = (v: unknown): v is number | null => v === null || isPositive(v)
const isString = (v: unknown): v is string => typeof v === 'string' && v.length > 0

function isBuilding(v: unknown): v is Building {
  return isObject(v) && isString(v.id) && typeof v.name === 'string'
}

function isRoof(v: unknown): v is Roof {
  return (
    isObject(v) &&
    (ROOF_KINDS as readonly unknown[]).includes(v.kind) &&
    isFiniteNumber(v.pitch) &&
    (v.pitch as number) >= 0 &&
    (v.pitch as number) < 89 &&
    isNonNegative(v.overhang) &&
    (v.direction === null || isFiniteNumber(v.direction)) &&
    isPositive(v.thickness) &&
    isNonNegative(v.parapet)
  )
}

function isStreetNode(v: unknown): v is StreetNode {
  return isObject(v) && isString(v.id) && isFiniteNumber(v.x) && isFiniteNumber(v.y)
}

/** A street with valid ends; missing widths fall back to the defaults. */
function isStreetRecord(v: unknown): v is Street {
  if (!isObject(v) || !isString(v.id) || !isString(v.a) || !isString(v.b)) return false
  const control = v.control
  const validControl = control === null || control === undefined || (isObject(control) && isFiniteNumber(control.x) && isFiniteNumber(control.y))
  const widths = ['laneWidth', 'bikeLeft', 'bikeRight', 'parkingLeft', 'parkingRight', 'sidewalkLeft', 'sidewalkRight']
  return validControl && widths.every((k) => v[k] === undefined || isNonNegative(v[k])) && (v.lanes === undefined || isNonNegative(v.lanes))
}

function isLevel(v: unknown): v is Level {
  return (
    isObject(v) &&
    isString(v.id) &&
    isString(v.buildingId) &&
    typeof v.name === 'string' &&
    isFiniteNumber(v.elevation) &&
    isPositive(v.height) &&
    (v.masterId === undefined || v.masterId === null || isString(v.masterId)) &&
    (v.count === undefined || isPositive(v.count))
  )
}

function isNode(v: unknown): v is WallNode {
  return isObject(v) && isString(v.id) && isString(v.levelId) && isFiniteNumber(v.x) && isFiniteNumber(v.y)
}

function isWall(v: unknown): v is Wall {
  return (
    isObject(v) &&
    isString(v.id) &&
    isString(v.levelId) &&
    isString(v.a) &&
    isString(v.b) &&
    isNullablePositive(v.thickness) &&
    isNullablePositive(v.height) &&
    isNullablePositive(v.heightEnd)
  )
}

function isOpening(v: unknown): v is Opening {
  return (
    isObject(v) &&
    isString(v.id) &&
    isString(v.wallId) &&
    (v.kind === 'window' || v.kind === 'door') &&
    isString(v.typeId) &&
    isFiniteNumber(v.offset) &&
    isPositive(v.width) &&
    isPositive(v.height) &&
    isNonNegative(v.sill) &&
    [v.open, v.flipHinge, v.flipSide].every((flag) => flag === undefined || typeof flag === 'boolean') &&
    (v.count === undefined || (Number.isInteger(v.count) && (v.count as number) >= 1)) &&
    (v.spacing === undefined || isPositive(v.spacing))
  )
}
