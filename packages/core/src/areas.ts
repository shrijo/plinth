import { createId } from './ids.ts'
import type { Vec2 } from './math.ts'
import type { AreaStandard, Id, RoomTag, RoomUse, Snapshot } from './model.ts'
import type { Tx } from './tx.ts'
import { analyzeSite, type BuildingAnalysis, type LevelAnalysis, type Room } from './geometry/analysis.ts'
import { pointInRegion } from './geometry/regions.ts'

/**
 * Rooms' names and uses, and the area figures of the area standards:
 * SIA 416 (Switzerland) and DIN 277 (Germany). Both split a building's
 * gross floor area into the area its walls take (construction) and the net
 * floor area of its rooms, and the net area by what the rooms are used
 * for. Rooms get their use from their tag (see RoomTag); a room without
 * one is counted as main usable area and reported as "use not set".
 */

export const ROOM_USE_NAMES: Record<RoomUse, string> = {
  living: 'Living',
  office: 'Office',
  production: 'Workshop or lab',
  retail: 'Shop',
  storage: 'Storage',
  education: 'Education or culture',
  care: 'Health or care',
  sanitary: 'WC or bathroom',
  parking: 'Parking',
  circulation: 'Corridor or stairs',
  technical: 'Plant room',
  other: 'Other',
}

/** A category of an area standard, with the room uses that count towards it. */
interface Category {
  code: string
  name: string
  uses: readonly RoomUse[]
}

interface StandardDefinition {
  name: string
  gross: { code: string; name: string }
  construction: { code: string; name: string }
  net: { code: string; name: string }
  /** The usable area's subtotal (SIA's NF), when the standard has one. */
  usable: { code: string; name: string; categories: string[] } | null
  categories: Category[]
  volume: { code: string; name: string }
  /** Where rooms without a use are counted. */
  unset: string
}

export const AREA_STANDARD_DEFINITIONS: Record<AreaStandard, StandardDefinition> = {
  sia416: {
    name: 'SIA 416',
    gross: { code: 'GF', name: 'Floor area' },
    construction: { code: 'KF', name: 'Construction' },
    net: { code: 'NGF', name: 'Net floor area' },
    usable: { code: 'NF', name: 'Usable', categories: ['HNF', 'NNF'] },
    categories: [
      { code: 'HNF', name: 'Main use', uses: ['living', 'office', 'production', 'retail', 'education', 'care', 'other'] },
      { code: 'NNF', name: 'Secondary use', uses: ['storage', 'sanitary', 'parking'] },
      { code: 'VF', name: 'Circulation', uses: ['circulation'] },
      { code: 'FF', name: 'Services', uses: ['technical'] },
    ],
    volume: { code: 'GV', name: 'Building volume' },
    unset: 'HNF',
  },
  din277: {
    name: 'DIN 277',
    gross: { code: 'BGF', name: 'Gross floor area' },
    construction: { code: 'KGF', name: 'Construction' },
    net: { code: 'NRF', name: 'Net room area' },
    usable: { code: 'NUF', name: 'Usable', categories: ['NUF 1', 'NUF 2', 'NUF 3', 'NUF 4', 'NUF 5', 'NUF 6', 'NUF 7'] },
    categories: [
      { code: 'NUF 1', name: 'Living', uses: ['living'] },
      { code: 'NUF 2', name: 'Office', uses: ['office'] },
      { code: 'NUF 3', name: 'Production', uses: ['production'] },
      { code: 'NUF 4', name: 'Storage, sales', uses: ['retail', 'storage'] },
      { code: 'NUF 5', name: 'Education', uses: ['education'] },
      { code: 'NUF 6', name: 'Health, care', uses: ['care'] },
      { code: 'NUF 7', name: 'Other', uses: ['sanitary', 'parking', 'other'] },
      { code: 'TF', name: 'Technical', uses: ['technical'] },
      { code: 'VF', name: 'Circulation', uses: ['circulation'] },
    ],
    volume: { code: 'BRI', name: 'Gross volume' },
    unset: 'NUF 1',
  },
}

/** One line of the figures: a code, what it is, and the area (or volume) it adds up to. */
export interface AreaFigure {
  code: string
  name: string
  value: number
  /** m² or m³. */
  unit: 'm²' | 'm³'
  /** How far it's indented under the line it's part of. */
  depth: number
}

export interface AreaFigures {
  standard: AreaStandard
  standardName: string
  lines: AreaFigure[]
  /** Net area of rooms without a use (counted in `unset`'s category). */
  unset: number
}

// Room tags

const tagCache = new WeakMap<readonly Room[], { tags: object; result: (RoomTag | undefined)[] }>()

/** The tag of each room of a level (by the room's position in the list), if it has one. */
export function roomTagsOf(snapshot: Snapshot, level: LevelAnalysis): (RoomTag | undefined)[] {
  const hit = tagCache.get(level.rooms)
  if (hit && hit.tags === snapshot.roomTags) return hit.result
  const tags = Object.values(snapshot.roomTags).filter((t) => t.levelId === level.contentLevelId)
  const result = level.rooms.map((room) => tags.find((tag) => pointInRegion(tag, room.floor)))
  tagCache.set(level.rooms, { tags: snapshot.roomTags, result })
  return result
}

/** A room's name: its tag's, or "Room 3" by its place in the level's list. */
export function roomTitle(index: number, tag: RoomTag | undefined): string {
  return tag?.name.trim() || `Room ${index + 1}`
}

/**
 * Names a room or sets its use: changes its tag, or puts a new one at the
 * point the room is labelled at (on the level its walls belong to).
 */
export function tagRoom(
  tx: Tx,
  room: { levelId: Id; labelPoint: Vec2 | null },
  tag: RoomTag | undefined,
  patch: Partial<Pick<RoomTag, 'name' | 'use'>>,
): void {
  if (tag) {
    tx.putRoomTag({ ...tag, ...patch })
    return
  }
  if (!room.labelPoint) return
  tx.putRoomTag({ id: createId(), levelId: room.levelId, x: room.labelPoint.x, y: room.labelPoint.y, name: '', use: 'living', ...patch })
}

// Figures

/** A building's area figures (or the whole site's, with no building given) by the project's standard. */
export function areaFigures(snapshot: Snapshot, buildingId?: Id, standard: AreaStandard = snapshot.meta.areaStandard): AreaFigures {
  const analysis = analyzeSite(snapshot)
  const buildings: BuildingAnalysis[] = buildingId
    ? [analysis.buildings.get(buildingId)].filter((b): b is BuildingAnalysis => !!b)
    : [...analysis.buildings.values()]
  const definition = AREA_STANDARD_DEFINITIONS[standard]
  const byCategory = new Map<string, number>(definition.categories.map((c) => [c.code, 0]))
  let gross = 0
  let net = 0
  let volume = 0
  let unset = 0
  for (const building of buildings) {
    for (const level of building.levels) {
      gross += level.grossArea * level.floors
      volume += level.grossArea * level.level.height * level.floors
      const tags = roomTagsOf(snapshot, level)
      level.rooms.forEach((room, i) => {
        const area = room.area * level.floors
        net += area
        const use = tags[i]?.use
        if (!use) unset += area
        const code = use ? definition.categories.find((c) => c.uses.includes(use))!.code : definition.unset
        byCategory.set(code, (byCategory.get(code) ?? 0) + area)
      })
    }
  }
  const lines: AreaFigure[] = []
  const line = (code: string, name: string, value: number, depth: number, unit: 'm²' | 'm³' = 'm²') =>
    lines.push({ code, name, value, depth, unit })
  line(definition.gross.code, definition.gross.name, gross, 0)
  line(definition.construction.code, definition.construction.name, Math.max(0, gross - net), 1)
  line(definition.net.code, definition.net.name, net, 1)
  const usable = definition.usable
  if (usable) {
    line(usable.code, usable.name, usable.categories.reduce((sum, code) => sum + (byCategory.get(code) ?? 0), 0), 2)
  }
  for (const category of definition.categories) {
    const inUsable = usable?.categories.includes(category.code) ?? false
    line(category.code, category.name, byCategory.get(category.code) ?? 0, inUsable ? 3 : 2)
  }
  line(definition.volume.code, definition.volume.name, volume, 0, 'm³')
  return { standard, standardName: definition.name, lines, unset }
}

/** The category a room of a given use counts towards in a standard. */
export function categoryOf(standard: AreaStandard, use: RoomUse | undefined): string {
  const definition = AREA_STANDARD_DEFINITIONS[standard]
  return use ? definition.categories.find((c) => c.uses.includes(use))!.code : definition.unset
}
