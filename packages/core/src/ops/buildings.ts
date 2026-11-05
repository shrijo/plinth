import { createId } from '../ids.ts'
import { add, signedArea2, sub, type Vec2 } from '../math.ts'
import { DEFAULT_LEVEL_HEIGHT, floorsOf, stackHeight, type Building, type Id, type Roof } from '../model.ts'
import type { Tx } from '../tx.ts'
import { copyLevelContent, levelName, restackLevels, stackOrder } from './levels.ts'
import { insertPolyline } from './walls.ts'

/**
 * Buildings on the site. A building is its levels; its shell is the outer
 * walls of each level. Everything is in site coordinates, so moving or
 * rotating a building moves its points.
 */

export interface NewBuilding {
  name?: string
  floors?: number
  floorHeight?: number
}

/**
 * Creates a building from an outline: `floors` levels, each with a closed
 * loop of walls along the outline. Returns the building.
 */
export function createBuilding(tx: Tx, outline: readonly Vec2[], options: NewBuilding = {}): Building | null {
  if (outline.length < 3 || Math.abs(signedArea2(outline)) < 1) return null
  const building = tx.putBuilding({
    id: createId(),
    name: options.name ?? `Building ${tx.buildings().length + 1}`,
  })
  const floors = Math.max(1, Math.floor(options.floors ?? 3))
  const height = options.floorHeight ?? DEFAULT_LEVEL_HEIGHT
  for (let i = 0; i < floors; i++) {
    const level = tx.putLevel({
      id: createId(),
      buildingId: building.id,
      name: levelName(i),
      elevation: i * height,
      height,
      masterId: null,
    })
    insertPolyline(tx, level.id, outline, true)
  }
  restackLevels(tx, building.id, 0)
  return building
}

/** Every point of every level of a building. */
function buildingNodes(tx: Tx, buildingId: Id) {
  return tx.levels(buildingId).flatMap((level) => tx.nodes(level.id))
}

/** Every room tag of every level of a building. */
function buildingTags(tx: Tx, buildingId: Id) {
  return tx.levels(buildingId).flatMap((level) => tx.roomTags(level.id))
}

export function moveBuilding(tx: Tx, buildingId: Id, delta: Vec2): void {
  for (const node of buildingNodes(tx, buildingId)) tx.putNode({ ...node, ...add(node, delta) })
  for (const tag of buildingTags(tx, buildingId)) tx.putRoomTag({ ...tag, ...add(tag, delta) })
}

/** Rotates a building by `angle` radians (counter-clockwise) about `pivot`. */
export function rotateBuilding(tx: Tx, buildingId: Id, angle: number, pivot: Vec2): void {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  for (const node of buildingNodes(tx, buildingId)) {
    const d = sub(node, pivot)
    tx.putNode({ ...node, x: pivot.x + d.x * c - d.y * s, y: pivot.y + d.x * s + d.y * c })
  }
  for (const tag of buildingTags(tx, buildingId)) {
    const d = sub(tag, pivot)
    tx.putRoomTag({ ...tag, x: pivot.x + d.x * c - d.y * s, y: pivot.y + d.x * s + d.y * c })
  }
  // A roof set to run a given way turns with the building.
  const building = tx.building(buildingId)
  if (building?.roof && building.roof.direction !== null) {
    const direction = normalizeAngle(building.roof.direction + (angle * 180) / Math.PI)
    tx.putBuilding({ ...building, roof: { ...building.roof, direction } })
  }
}

/** Sets a building's roof; null gives it the plain flat roof. */
export function setRoof(tx: Tx, buildingId: Id, roof: Roof | null): void {
  const building = tx.building(buildingId)
  if (!building) return
  const { roof: _old, ...rest } = building
  tx.putBuilding(roof ? { ...rest, roof: { ...roof, direction: roof.direction === null ? null : normalizeAngle(roof.direction) } } : rest)
}

/** An angle in degrees, in [0, 360). */
const normalizeAngle = (degrees: number) => Math.round((((degrees % 360) + 360) % 360) * 1e6) / 1e6

/** The middle of a building's bounding box on the plan. */
export function buildingCentre(tx: Tx, buildingId: Id): Vec2 {
  const nodes = buildingNodes(tx, buildingId)
  if (nodes.length === 0) return { x: 0, y: 0 }
  const xs = nodes.map((n) => n.x)
  const ys = nodes.map((n) => n.y)
  return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 }
}

/**
 * Sets how many floors a building has. New floors on top copy the top
 * floor's walls; floors are removed from the top. At least one remains.
 */
export function setFloorCount(tx: Tx, buildingId: Id, count: number): void {
  const target = Math.max(1, Math.floor(count))
  let levels = stackOrder(tx, buildingId)
  const floors = () => levels.reduce((sum, l) => sum + floorsOf(l), 0)
  while (floors() > target) {
    const top = levels.at(-1)!
    // A run of copies on top just gets shorter.
    if (floorsOf(top) > 1) {
      tx.putLevel({ ...top, count: Math.max(1, floorsOf(top) - (floors() - target)) })
      levels = stackOrder(tx, buildingId)
      continue
    }
    for (const wall of tx.walls(top.id)) {
      for (const opening of tx.openingsOnWall(wall.id)) tx.deleteOpening(opening.id)
      tx.deleteWall(wall.id)
    }
    for (const node of tx.nodes(top.id)) tx.deleteNode(node.id)
    // Copies of the removed floor become... nothing: they go with it.
    for (const copy of levels.filter((l) => l.masterId === top.id)) tx.deleteLevel(copy.id)
    tx.deleteLevel(top.id)
    levels = stackOrder(tx, buildingId)
  }
  while (floors() < target) {
    const top = levels.at(-1)!
    // A run of copies on top just gets taller.
    if (top.masterId) {
      tx.putLevel({ ...top, count: floorsOf(top) + target - floors() })
      levels = stackOrder(tx, buildingId)
      continue
    }
    const level = tx.putLevel({
      id: createId(),
      buildingId,
      name: levelName(floors()),
      elevation: top.elevation + stackHeight(top),
      height: top.height,
      masterId: null,
    })
    copyLevelContent(tx, top.masterId ?? top.id, level.id)
    levels = stackOrder(tx, buildingId)
  }
  restackLevels(tx, buildingId)
}

/** Deletes a building with all its levels. */
export function deleteBuilding(tx: Tx, buildingId: Id): void {
  for (const level of tx.levels(buildingId)) {
    for (const wall of tx.walls(level.id)) {
      for (const opening of tx.openingsOnWall(wall.id)) tx.deleteOpening(opening.id)
      tx.deleteWall(wall.id)
    }
    for (const node of tx.nodes(level.id)) tx.deleteNode(node.id)
    for (const tag of tx.roomTags(level.id)) tx.deleteRoomTag(tag.id)
    tx.deleteLevel(level.id)
  }
  tx.deleteBuilding(buildingId)
}
