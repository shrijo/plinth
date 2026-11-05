import {
  rowCount,
  dist,
  finishNodeMove,
  formatLength,
  moveNodes,
  resolveWall,
  setWallProps,
  type Id,
  type Opening,
  type Snapshot,
  type Wall,
  type WallProps,
} from '@plinth/core'
import { setNodePosition, setWallLength } from '../actions.ts'
import { useEditorContext } from '../context.ts'
import { DeleteButton, LengthField, Readout } from './fields.tsx'
import { wallLength } from './selection.ts'

/** Panels for walls and points, shared by the building and site editors. */

export function WallProperties({ wall, snapshot }: { wall: Wall; snapshot: Snapshot }) {
  const ctx = useEditorContext()
  const level = snapshot.levels[wall.levelId]
  const resolved = resolveWall(wall, level, snapshot.meta)
  const a = snapshot.nodes[wall.a]
  const b = snapshot.nodes[wall.b]
  const length = a && b ? dist(a, b) : 0
  const sloped = wall.heightEnd !== null
  const openings = Object.values(snapshot.openings).filter((o) => o.wallId === wall.id)
  const update = (props: WallProps) => ctx.doc.transact((tx) => setWallProps(tx, [wall.id], props))

  return (
    <>
      <LengthField label="Length" value={length} onCommit={(v) => setWallLength(ctx, wall.id, v)} />
      <LengthField
        label="Thickness"
        value={resolved.thickness}
        isDefault={wall.thickness === null}
        onCommit={(v) => update({ thickness: v })}
        onReset={() => update({ thickness: null })}
      />
      <LengthField
        label={sloped ? 'Height at start' : 'Height'}
        value={resolved.heightStart}
        isDefault={wall.height === null}
        onCommit={(v) => update({ height: v })}
        onReset={() => update({ height: null })}
      />
      {sloped && (
        <LengthField label="Height at end" value={resolved.heightEnd} onCommit={(v) => update({ heightEnd: v })} />
      )}
      <label className="pe-check">
        <input
          type="checkbox"
          checked={sloped}
          onChange={(e) => update({ heightEnd: e.target.checked ? resolved.heightStart : null })}
        />
        Different height at each end
      </label>
      {openings.length > 0 && (
        <Readout
          label="Openings"
          value={`${countOf(openings, 'window')} windows, ${countOf(openings, 'door')} doors`}
        />
      )}
      <DeleteButton />
    </>
  )
}

export function MultiWallProperties({ walls, snapshot, stacked = false }: { walls: Wall[]; snapshot: Snapshot; stacked?: boolean }) {
  const ctx = useEditorContext()
  const ids = walls.map((w) => w.id)
  const resolved = walls.map((w) => resolveWall(w, snapshot.levels[w.levelId], snapshot.meta))
  const same = (values: number[]) => (values.every((v) => v === values[0]) ? values[0]! : null)
  const total = walls.reduce((sum, w) => sum + wallLength(snapshot, w), 0)
  const update = (props: WallProps) => ctx.doc.transact((tx) => setWallProps(tx, ids, props))

  return (
    <>
      <Readout
        label={stacked ? 'Length' : 'Total length'}
        value={formatLength(stacked ? wallLength(snapshot, walls[0]!) : total)}
      />
      <LengthField
        label="Thickness"
        value={same(resolved.map((r) => r.thickness))}
        placeholder="Mixed"
        onCommit={(v) => update({ thickness: v })}
      />
      <LengthField
        label="Height"
        value={same(resolved.map((r) => r.heightStart))}
        placeholder="Mixed"
        onCommit={(v) => update({ height: v, heightEnd: null })}
      />
      <DeleteButton />
    </>
  )
}

export function NodeProperties({ nodeId, snapshot }: { nodeId: Id; snapshot: Snapshot }) {
  const ctx = useEditorContext()
  const node = snapshot.nodes[nodeId]
  if (!node) return null
  const wallCount = Object.values(snapshot.walls).filter((w) => w.a === nodeId || w.b === nodeId).length
  return (
    <>
      <LengthField label="X" value={node.x} allowNegative onCommit={(x) => setNodePosition(ctx, nodeId, { x, y: node.y })} />
      <LengthField label="Y" value={node.y} allowNegative onCommit={(y) => setNodePosition(ctx, nodeId, { x: node.x, y })} />
      <Readout label="Walls here" value={String(wallCount)} />
      <DeleteButton label={wallCount === 2 ? 'Delete point (joins its two walls)' : 'Delete point'} />
    </>
  )
}

/** The same point on several floors, edited together. */
export function NodeStackProperties({ nodeIds, snapshot }: { nodeIds: readonly Id[]; snapshot: Snapshot }) {
  const ctx = useEditorContext()
  const first = snapshot.nodes[nodeIds[0] ?? '']
  if (!first) return null
  const moveAll = (position: { x: number; y: number }) =>
    ctx.doc.transact((tx) => {
      moveNodes(tx, new Map(nodeIds.map((id) => [id, position])))
      finishNodeMove(tx, nodeIds)
    })
  return (
    <>
      <LengthField label="X" value={first.x} allowNegative onCommit={(x) => moveAll({ x, y: first.y })} />
      <LengthField label="Y" value={first.y} allowNegative onCommit={(y) => moveAll({ x: first.x, y })} />
      <p className="pe-note">The same point on every floor where it lines up. Changes apply to all of them.</p>
      <DeleteButton label="Delete point on all floors" />
    </>
  )
}

/** Windows or doors on a wall, each of a row counted. */
function countOf(openings: readonly Opening[], kind: Opening['kind']): number {
  return openings.reduce((sum, o) => sum + (o.kind === kind ? rowCount(o) : 0), 0)
}
