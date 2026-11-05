import { createId } from '../ids.ts'
import { signedArea2, type Vec2 } from '../math.ts'
import type { Id, Parcel } from '../model.ts'
import type { Tx } from '../tx.ts'

/** A new parcel from its corners (at least three, not all in a line); null if they make no area. */
export function createParcel(tx: Tx, points: readonly Vec2[], name?: string): Parcel | null {
  if (points.length < 3 || Math.abs(signedArea2(points)) < 1e-3) return null
  return tx.putParcel({
    id: createId(),
    name: name ?? `Parcel ${tx.parcels().length + 1}`,
    points: points.map((p) => ({ x: p.x, y: p.y })),
  })
}

export function renameParcel(tx: Tx, id: Id, name: string): void {
  const parcel = tx.parcel(id)
  if (parcel) tx.putParcel({ ...parcel, name })
}

/** Moves one corner of a parcel. */
export function moveParcelCorner(tx: Tx, id: Id, index: number, to: Vec2): void {
  const parcel = tx.parcel(id)
  if (!parcel || index < 0 || index >= parcel.points.length) return
  tx.putParcel({ ...parcel, points: parcel.points.map((p, i) => (i === index ? { x: to.x, y: to.y } : p)) })
}

export function deleteParcels(tx: Tx, ids: Iterable<Id>): void {
  for (const id of ids) tx.deleteParcel(id)
}
