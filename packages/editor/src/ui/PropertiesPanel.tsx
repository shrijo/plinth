import {
  rowCount,
  findStacks,
  floorsOf,
  formatArea,
  formatLength,
  openingType,
  openingTypesOfKind,
  roomName,
  rowReach,
  rowSpacing,
  sortedLevels,
  updateLevel,
  updateOpening,
  type BuildingAnalysis,
  type SiteAnalysis,
  type Id,
  type Level,
  type Opening,
  type OpeningKind,
  type OpeningPatch,
  type Snapshot,
  type Wall,
} from '@plinth/core'
import { useState, type ReactNode } from 'react'
import {
  detach,
  removeLevel,
  select,
  setActiveLevel,
  setRepeat,
} from '../actions.ts'
import { useAnalysis, useEditor, useEditorContext, useSnapshot } from '../context.ts'
import { selectionSize } from '../state.ts'
import { DeleteButton, LengthField, Readout, Stepper, TextField, type PanelFrame } from './fields.tsx'
import { ChevronIcon, LinkIcon, TrashIcon } from './icons.tsx'
import { stackFloors } from './selection.ts'
import { SitePanel } from './SitePanel.tsx'
import { MultiWallProperties, NodeProperties, NodeStackProperties, WallProperties } from './WallPanels.tsx'

/** The properties panel: of the site editor, or of the building editor. */
export function PropertiesPanel() {
  const mode = useEditor((s) => s.mode)
  // Starts folded on phones, where it would cover much of the view.
  const [open, setOpen] = useState(() => !window.matchMedia('(max-width: 700px)').matches)
  const frame: PanelFrame = (title, body) => (
    <section className="pe-panel" data-open={open || undefined} aria-label="Properties">
      <button type="button" className="pe-panel-header" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span>{title}</span>
        <ChevronIcon open={open} />
      </button>
      {open && <div className="pe-panel-body">{body}</div>}
    </section>
  )
  return mode === 'site' ? <SitePanel frame={frame} /> : <BuildingPanel frame={frame} />
}

/** Properties of the selection, or of the active level and the building when nothing is selected. */
function BuildingPanel({ frame }: { frame: PanelFrame }) {
  const snapshot = useSnapshot()
  const site = useAnalysis()
  const selection = useEditor((s) => s.selection)
  const levelId = useEditor((s) => s.activeLevelId)
  const buildingId = useEditor((s) => s.buildingId)
  const tool = useEditor((s) => s.tool)
  const whole = useEditor((s) => s.wholeBuilding)
  const analysis = site.buildings.get(buildingId ?? '')

  const walls = selection.walls.map((id) => snapshot.walls[id]).filter((w): w is Wall => !!w)
  const openings = selection.openings.map((id) => snapshot.openings[id]).filter((o): o is Opening => !!o)
  const count = selectionSize(selection)
  const level = snapshot.levels[levelId]

  let title: string
  let body: ReactNode
  if (count === 1 && openings.length === 1) {
    const opening = openings[0]!
    const row = rowCount(opening)
    title = row > 1 ? `${row} ${opening.kind === 'door' ? 'doors' : 'windows'}` : opening.kind === 'door' ? 'Door' : 'Window'
    body = <OpeningProperties opening={opening} />
  } else if (count === walls.length && walls.length === 1) {
    title = 'Wall'
    body = <WallProperties wall={walls[0]!} snapshot={snapshot} />
  } else if (count === walls.length && walls.length > 1) {
    const floors = stackFloors(walls.map((w) => w.id), findStacks(snapshot, buildingId ?? undefined).walls)
    title = floors ? `Wall on ${floors} floors` : `${walls.length} walls`
    body = <MultiWallProperties walls={walls} snapshot={snapshot} stacked={!!floors} />
  } else if (count === 1 && selection.nodes.length === 1) {
    title = 'Point'
    body = <NodeProperties nodeId={selection.nodes[0]!} snapshot={snapshot} />
  } else if (count === selection.nodes.length && stackFloors(selection.nodes, findStacks(snapshot, buildingId ?? undefined).nodes)) {
    title = `Point on ${selection.nodes.length} floors`
    body = <NodeStackProperties nodeIds={selection.nodes} snapshot={snapshot} />
  } else if (count === 1 && selection.rooms.length === 1) {
    title = 'Room'
    body = <RoomProperties roomId={selection.rooms[0]!} levelId={levelId} analysis={site} snapshot={snapshot} />
  } else if (count > 0) {
    title = `${count} items`
    body = <DeleteButton />
  } else if (whole && analysis) {
    title = snapshot.buildings[analysis.buildingId]?.name ?? 'Whole building'
    body = <BuildingProperties snapshot={snapshot} analysis={analysis} />
  } else if (tool === 'window' || tool === 'door') {
    title = tool === 'door' ? 'Door type' : 'Window type'
    body = <OpeningTypePicker kind={tool} />
  } else {
    title = level?.name ?? 'Level'
    body =
      level && analysis ? <LevelProperties level={level} snapshot={snapshot} site={site} analysis={analysis} /> : null
  }
  return frame(title, body)
}

/** The default gap between neighbours when a window or door becomes a row, in metres. */
const ROW_GAP = 1.2

function OpeningProperties({ opening }: { opening: Opening }) {
  const ctx = useEditorContext()
  const snapshot = useSnapshot()
  const wall = snapshot.walls[opening.wallId]
  const footprint = useAnalysis().byLevel.get(wall?.levelId ?? '')?.footprints.get(opening.wallId)
  const update = (patch: OpeningPatch) => ctx.doc.transact((tx) => updateOpening(tx, opening.id, patch))
  const type = openingType(opening.typeId, opening.kind)
  const noun = opening.kind === 'door' ? 'door' : 'window'
  const count = rowCount(opening)
  const spacing = count > 1 ? rowSpacing(opening) : Math.round((opening.width + ROW_GAP) * 20) / 20
  const room = footprint ? footprint.clearEnd - footprint.clearStart : Infinity
  const most = Math.max(count, Math.floor((room - opening.width) / spacing) + 1)
  // Changes to a row keep all of it on the wall, moving its centre if need be.
  const updateRow = (patch: OpeningPatch) => {
    const next = { ...opening, ...patch }
    const reach = rowReach(next)
    const offset = footprint
      ? Math.min(Math.max(next.offset, footprint.clearStart + reach), Math.max(footprint.clearStart + reach, footprint.clearEnd - reach))
      : next.offset
    update({ ...patch, offset })
  }
  return (
    <>
      {type.operable && (
        <>
          <button type="button" className="pe-button pe-button-wide" onClick={() => update({ open: !opening.open })}>
            {opening.open ? `Close ${noun}` : `Open ${noun}`}
          </button>
          <div className="pe-row">
            {type.leaves === 1 && (
              <button type="button" className="pe-button" onClick={() => update({ flipHinge: !opening.flipHinge })}>
                Flip hinge
              </button>
            )}
            <button type="button" className="pe-button" onClick={() => update({ flipSide: !opening.flipSide })}>
              Open to other side
            </button>
          </div>
        </>
      )}
      <label className="pe-field">
        <span className="pe-field-label">Type</span>
        <select className="pe-input" value={type.id} onChange={(e) => update({ typeId: e.target.value })}>
          {openingTypesOfKind(opening.kind).map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </label>
      <LengthField label="Width" value={opening.width} onCommit={(width) => update({ width })} />
      <LengthField label="Height" value={opening.height} onCommit={(height) => update({ height })} />
      {opening.kind === 'window' && (
        <LengthField label="Sill height" value={opening.sill} allowZero onCommit={(sill) => update({ sill })} />
      )}
      <Stepper
        label="In a row"
        value={count}
        min={1}
        max={most}
        fewer={`One ${noun} fewer`}
        more={`One more ${noun}`}
        onChange={(n) => updateRow({ count: n, spacing })}
      />
      {count > 1 && (
        <LengthField
          label="Centre to centre"
          value={spacing}
          onCommit={(next) => updateRow({ spacing: Math.max(next, opening.width) })}
        />
      )}
      <LengthField
        label={count > 1 ? 'Row centre from wall start' : 'Centre from wall start'}
        value={opening.offset}
        onCommit={(offset) => updateRow({ offset })}
      />
      <DeleteButton />
    </>
  )
}

function OpeningTypePicker({ kind }: { kind: OpeningKind }) {
  const ctx = useEditorContext()
  const current = useEditor((s) => s.openingTypes[kind])
  return (
    <div className="pe-type-list" role="radiogroup" aria-label={`${kind} type`}>
      {openingTypesOfKind(kind).map((type) => (
        <button
          key={type.id}
          type="button"
          role="radio"
          aria-checked={type.id === current}
          className="pe-type"
          onClick={() =>
            ctx.store.setState({ openingTypes: { ...ctx.store.getState().openingTypes, [kind]: type.id } })
          }
        >
          <span>{type.name}</span>
          <span className="pe-type-size">
            {type.defaults.width.toFixed(2)} × {type.defaults.height.toFixed(2)} m
          </span>
        </button>
      ))}
    </div>
  )
}

function RoomProperties({
  roomId,
  levelId,
  analysis,
  snapshot,
}: {
  roomId: Id
  levelId: Id
  analysis: SiteAnalysis
  snapshot: Snapshot
}) {
  const rooms = analysis.byLevel.get(levelId)?.rooms ?? []
  const index = rooms.findIndex((r) => r.id === roomId)
  const room = rooms[index]
  const level = snapshot.levels[levelId]
  if (!room || !level) return null
  const clearHeight = Math.max(0, level.height - snapshot.meta.slabThickness)
  return (
    <>
      <Readout label="Name" value={roomName(index)} />
      <Readout label="Floor area" value={formatArea(room.area)} />
      <Readout label="Perimeter" value={formatLength(room.perimeter)} />
      <Readout label="Clear height" value={formatLength(clearHeight)} />
      <Readout label="Volume" value={`${(room.area * clearHeight).toFixed(2)} m³`} />
    </>
  )
}

function LevelProperties({
  level,
  snapshot,
  site,
  analysis,
}: {
  level: Level
  snapshot: Snapshot
  site: SiteAnalysis
  analysis: BuildingAnalysis
}) {
  const ctx = useEditorContext()
  const levels = sortedLevels(snapshot, level.buildingId)
  const lowest = levels[0]?.id === level.id
  const master = level.masterId ? snapshot.levels[level.masterId] : undefined
  const copies = levels.filter((l) => l.masterId === level.id).reduce((sum, l) => sum + floorsOf(l), 0)
  const levelAnalysis = site.byLevel.get(level.id)
  const rooms = levelAnalysis?.rooms ?? []
  const update = (patch: Partial<Level>) => ctx.doc.transact((tx) => updateLevel(tx, level.id, patch))

  return (
    <>
      <TextField label="Name" value={level.name} onCommit={(name) => update({ name })} />
      {master ? (
        <>
          <div className="pe-callout">
            <LinkIcon />
            <span>
              {floorsOf(level) > 1 ? `${floorsOf(level)} floors, copies` : 'A copy'} of <strong>{master.name}</strong>. It
              follows every change to it.
            </span>
          </div>
          <div className="pe-row">
            <button type="button" className="pe-button" onClick={() => setActiveLevel(ctx, master.id)}>
              Go to {master.name}
            </button>
            <button type="button" className="pe-button" onClick={() => detach(ctx, level.id)}>
              Detach
            </button>
          </div>
        </>
      ) : (
        <>
          <LengthField label="Floor height" value={level.height} onCommit={(height) => update({ height })} />
          <Stepper
            label="Copies above"
            value={copies}
            fewer="One copy fewer"
            more="One more copy"
            onChange={(n) => setRepeat(ctx, level.id, n)}
          />
        </>
      )}
      {lowest ? (
        <LengthField
          label="Elevation"
          value={level.elevation}
          allowNegative
          allowZero
          onCommit={(elevation) => update({ elevation })}
        />
      ) : (
        <Readout label="Elevation" value={formatLength(level.elevation)} />
      )}

      <h3 className="pe-section-title">Areas</h3>
      {rooms.length === 0 ? (
        <p className="pe-note">No rooms yet.</p>
      ) : (
        <ul className="pe-room-list">
          {rooms.map((room, i) => (
            <li key={room.id}>
              <button type="button" className="pe-room" onClick={() => select(ctx, { kind: 'room', id: room.id }, false)}>
                <span>{roomName(i)}</span>
                <span>{formatArea(room.area)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <Readout label="Net floor area" value={formatArea(levelAnalysis?.netArea ?? 0)} />
      <Readout label="Gross floor area" value={formatArea(levelAnalysis?.grossArea ?? 0)} />

      <h3 className="pe-section-title">{snapshot.buildings[level.buildingId]?.name ?? 'Building'}</h3>
      <Readout label="Floors" value={String(levels.reduce((sum, l) => sum + floorsOf(l), 0))} />
      <Readout label="Net floor area" value={formatArea(analysis.netArea)} />
      <Readout label="Gross floor area" value={formatArea(analysis.grossArea)} />
      <LengthField
        label="Default wall thickness"
        value={snapshot.meta.wallThickness}
        onCommit={(wallThickness) => ctx.doc.transact((tx) => tx.setMeta({ wallThickness }))}
      />
      <LengthField
        label="Slab thickness"
        value={snapshot.meta.slabThickness}
        onCommit={(slabThickness) => ctx.doc.transact((tx) => tx.setMeta({ slabThickness }))}
      />
      {levels.length > 1 && (
        <button type="button" className="pe-danger" onClick={() => removeLevel(ctx, level.id)}>
          <TrashIcon /> Delete {level.name}
        </button>
      )}
    </>
  )
}

function BuildingProperties({ snapshot, analysis }: { snapshot: Snapshot; analysis: BuildingAnalysis }) {
  const ctx = useEditorContext()
  return (
    <>
      <ul className="pe-room-list">
        {[...analysis.levels].reverse().map((level) => (
          <li key={level.level.id}>
            <button type="button" className="pe-room" onClick={() => setActiveLevel(ctx, level.level.id)}>
              <span>
                {level.level.name}
                {level.floors > 1 && ` ×${level.floors}`}
              </span>
              <span>{formatArea(level.grossArea)}</span>
            </button>
          </li>
        ))}
      </ul>
      <p className="pe-note">Gross floor area per floor.</p>
      <h3 className="pe-section-title">Totals</h3>
      <Readout label="Floors" value={String(analysis.levels.reduce((sum, l) => sum + l.floors, 0))} />
      <Readout label="Net floor area" value={formatArea(analysis.netArea)} />
      <Readout label="Gross floor area" value={formatArea(analysis.grossArea)} />
      <LengthField
        label="Default wall thickness"
        value={snapshot.meta.wallThickness}
        onCommit={(wallThickness) => ctx.doc.transact((tx) => tx.setMeta({ wallThickness }))}
      />
      <LengthField
        label="Slab thickness"
        value={snapshot.meta.slabThickness}
        onCommit={(slabThickness) => ctx.doc.transact((tx) => tx.setMeta({ slabThickness }))}
      />
    </>
  )
}
