import { createId } from '../ids.ts'
import { DEFAULT_LEVEL_HEIGHT, floorsOf, stackHeight, type Id, type Level } from '../model.ts'
import type { Tx } from '../tx.ts'

/**
 * Each building's levels form a stack: each level starts where the one
 * below ends, and the lowest level's elevation anchors the stack. Every
 * change to heights or to the set of levels ends with `restackLevels`.
 */

/** A building's levels, from the ground up. */
export function stackOrder(tx: Tx, buildingId: Id): Level[] {
  return tx.levels(buildingId).sort((a, b) => a.elevation - b.elevation || a.id.localeCompare(b.id))
}

/**
 * Recomputes the elevations of a building's levels from the bottom, and
 * gives copies their master's height. The stack starts at `base`, or where
 * its lowest level is.
 */
export function restackLevels(tx: Tx, buildingId: Id, base?: number): void {
  const levels = stackOrder(tx, buildingId)
  let elevation = base ?? levels[0]?.elevation ?? 0
  for (const level of levels) {
    const master = level.masterId ? tx.level(level.masterId) : undefined
    const height = master ? master.height : level.height
    if (level.elevation !== elevation || level.height !== height) {
      tx.putLevel({ ...level, elevation, height })
    }
    elevation += height * floorsOf(level)
  }
}

export function levelName(index: number): string {
  return index === 0 ? 'Ground floor' : `Floor ${index}`
}

/** Adds an empty level to a building, directly above `belowId` or on top of its stack. */
export function addLevel(tx: Tx, buildingId: Id, belowId?: Id, name?: string): Level {
  const levels = stackOrder(tx, buildingId)
  const below = (belowId && tx.level(belowId)) || levels.at(-1)
  const height = below?.height ?? DEFAULT_LEVEL_HEIGHT
  const level = tx.putLevel({
    id: createId(),
    buildingId,
    name: name ?? levelName(levels.length),
    // Just under the next level, so it sorts between them until restacked.
    elevation: below ? below.elevation + stackHeight(below) - 1e-6 : 0,
    height,
    masterId: null,
  })
  restackLevels(tx, buildingId)
  return tx.level(level.id)!
}

export type LevelPatch = Partial<Pick<Level, 'name' | 'height' | 'elevation'>>

/** Renames or resizes a level. Changing the lowest level's elevation moves the whole stack. */
export function updateLevel(tx: Tx, id: Id, patch: LevelPatch): void {
  const level = tx.level(id)
  if (!level) return
  const lowest = stackOrder(tx, level.buildingId)[0]
  const next = { ...level, ...patch }
  // Only the lowest level's elevation is free; the others follow from the stack.
  if (patch.elevation !== undefined && lowest?.id !== id) next.elevation = level.elevation
  tx.putLevel(next)
  restackLevels(tx, level.buildingId)
}

/** Removes a level's walls, points and openings. */
function clearLevel(tx: Tx, id: Id): void {
  for (const wall of tx.walls(id)) {
    for (const opening of tx.openingsOnWall(wall.id)) tx.deleteOpening(opening.id)
    tx.deleteWall(wall.id)
  }
  for (const node of tx.nodes(id)) tx.deleteNode(node.id)
}

/**
 * Deletes a level with everything on it. Its copies become independent
 * levels first. A building's last level can't be deleted (delete the building).
 */
export function deleteLevel(tx: Tx, id: Id): boolean {
  const level = tx.level(id)
  if (!level || tx.levels(level.buildingId).length <= 1) return false
  // The stack keeps its base even if its lowest level goes.
  const base = stackOrder(tx, level.buildingId)[0]!.elevation
  // Every floor of every run of copies becomes an ordinary level.
  for (let copies = copiesOf(tx, id); copies.length > 0; copies = copiesOf(tx, id)) detachLevel(tx, copies[0]!.id)
  clearLevel(tx, id)
  tx.deleteLevel(id)
  restackLevels(tx, level.buildingId, base)
  return true
}

/** A master's copies, from the bottom up. */
export function copiesOf(tx: Tx, masterId: Id): Level[] {
  const master = tx.level(masterId)
  return master ? stackOrder(tx, master.buildingId).filter((l) => l.masterId === masterId) : []
}

/** How many floors of copies a master has. */
export function copyFloors(tx: Tx, masterId: Id): number {
  return copiesOf(tx, masterId).reduce((sum, copy) => sum + floorsOf(copy), 0)
}

/**
 * Makes `count` floors of copies stand above a level: the topmost run of
 * copies grows or shrinks (a run is one record however many floors it
 * has), and runs are removed from the top. A copy can't be repeated.
 */
export function setRepeatCount(tx: Tx, masterId: Id, count: number): void {
  const master = tx.level(masterId)
  if (!master || master.masterId) return
  const target = Math.max(0, Math.floor(count))
  let copies = copiesOf(tx, masterId)
  let floors = copies.reduce((sum, copy) => sum + floorsOf(copy), 0)
  while (floors > target) {
    const top = copies.at(-1)!
    const excess = floors - target
    if (floorsOf(top) > excess) {
      tx.putLevel({ ...top, count: floorsOf(top) - excess })
      floors = target
    } else {
      tx.deleteLevel(top.id)
      floors -= floorsOf(top)
      copies = copies.slice(0, -1)
    }
  }
  if (floors < target) {
    const top = copies.at(-1)
    if (top) tx.putLevel({ ...top, count: floorsOf(top) + target - floors })
    else {
      tx.putLevel({
        id: createId(),
        buildingId: master.buildingId,
        name: `${master.name} · copy`,
        elevation: master.elevation + master.height - 1e-6,
        height: master.height,
        masterId,
        count: target,
      })
    }
  }
  restackLevels(tx, master.buildingId)
}

/** Copies one level's walls, points and openings onto another. */
export function copyLevelContent(tx: Tx, fromId: Id, toId: Id): void {
  const nodeIds = new Map<Id, Id>()
  for (const node of tx.nodes(fromId)) {
    const id = createId()
    nodeIds.set(node.id, id)
    tx.putNode({ ...node, id, levelId: toId })
  }
  for (const wall of tx.walls(fromId)) {
    const id = createId()
    tx.putWall({ ...wall, id, levelId: toId, a: nodeIds.get(wall.a)!, b: nodeIds.get(wall.b)! })
    for (const opening of tx.openingsOnWall(wall.id)) {
      tx.putOpening({ ...opening, id: createId(), wallId: id })
    }
  }
}

/**
 * Turns a copy into an ordinary level with its own walls: a duplicate of
 * its master's. For a run of copies, its first floor becomes the ordinary
 * level and the rest stay a run above it.
 */
export function detachLevel(tx: Tx, copyId: Id): void {
  const copy = tx.level(copyId)
  if (!copy?.masterId) return
  const floors = floorsOf(copy)
  copyLevelContent(tx, copy.masterId, copyId)
  const { count: _count, ...rest } = copy
  tx.putLevel({ ...rest, masterId: null })
  if (floors > 1) {
    tx.putLevel({
      ...rest,
      id: createId(),
      elevation: copy.elevation + copy.height,
      masterId: copy.masterId,
      count: floors - 1,
    })
  }
  restackLevels(tx, copy.buildingId)
}
