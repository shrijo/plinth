import { createId } from '../ids.ts'
import { dist, dot, lerp, normalize, sub, type Vec2 } from '../math.ts'
import { rowCount, rowSpacing, type Id, type Opening, type OpeningKind } from '../model.ts'
import { openingType } from '../openingTypes.ts'
import type { Tx } from '../tx.ts'

export interface OpeningInput {
  kind: OpeningKind
  typeId: string
  offset: number
  width?: number
  height?: number
  sill?: number
}

/** Adds an opening to a wall. Size defaults come from its type. */
export function addOpening(tx: Tx, wallId: Id, input: OpeningInput): Opening {
  const type = openingType(input.typeId, input.kind)
  return tx.putOpening({
    id: createId(),
    wallId,
    kind: input.kind,
    typeId: type.id,
    offset: input.offset,
    width: input.width ?? type.defaults.width,
    height: input.height ?? type.defaults.height,
    sill: input.sill ?? type.defaults.sill,
  })
}

export type OpeningPatch = Partial<
  Pick<Opening, 'typeId' | 'offset' | 'width' | 'height' | 'sill' | 'open' | 'flipHinge' | 'flipSide' | 'count' | 'spacing'>
>

export function updateOpening(tx: Tx, id: Id, patch: OpeningPatch): void {
  const opening = tx.opening(id)
  if (!opening) return
  const next: Opening = { ...opening, ...patch }
  // A row of one is a single opening again.
  if (rowCount(next) === 1) {
    delete next.count
    delete next.spacing
  } else next.spacing = rowSpacing(next)
  tx.putOpening(next)
}

/**
 * The part of a row (or a single opening) whose windows lie before `at`
 * along the wall, and the part after it, each as a row, a single opening,
 * or null. The part before keeps the opening's id.
 */
export function splitRow(opening: Opening, at: number): { before: Opening | null; after: Opening | null } {
  const n = rowCount(opening)
  const step = rowSpacing(opening)
  const first = opening.offset - ((n - 1) * step) / 2
  // How many windows have their centre at or before `at`.
  const k = Math.min(n, Math.max(0, Math.floor((at - first) / step) + 1))
  const part = (from: number, count: number, id: Id): Opening | null => {
    if (count <= 0) return null
    const { count: _count, spacing: _spacing, ...single } = opening
    const offset = first + (from + (count - 1) / 2) * step
    return count === 1 ? { ...single, id, offset } : { ...single, id, offset, count, spacing: step }
  }
  return { before: part(0, k, opening.id), after: part(k, n - k, k === 0 ? opening.id : createId()) }
}

export function deleteOpenings(tx: Tx, ids: Iterable<Id>): void {
  for (const id of ids) tx.deleteOpening(id)
}

/**
 * Moves openings onto another wall, keeping each one's centre where it was
 * in plan. `from` is where their old wall ran before it changed.
 */
export function moveOpeningsToWall(
  tx: Tx,
  openings: readonly Opening[],
  from: { a: Vec2; b: Vec2 },
  toWallId: Id,
): void {
  const wall = tx.wall(toWallId)
  if (!wall || openings.length === 0) return
  const a = tx.requireNode(wall.a)
  const b = tx.requireNode(wall.b)
  const dir = normalize(sub(b, a))
  const fromLength = dist(from.a, from.b)
  for (const opening of openings) {
    const centre = fromLength === 0 ? from.a : lerp(from.a, from.b, opening.offset / fromLength)
    tx.putOpening({ ...opening, wallId: toWallId, offset: dot(sub(centre, a), dir) })
  }
}
