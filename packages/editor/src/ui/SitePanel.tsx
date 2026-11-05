import {
  crossSection,
  finishStreetMove,
  formatArea,
  floorsOf,
  formatLength,
  moveBuilding,
  nodesOnLevel,
  moveStreetNodes,
  setStreetCurve,
  setStreetProps,
  sortedLevels,
  roofHeight,
  stackHeight,
  streetLength,
  updateLevel,
  type Id,
  type Snapshot,
  type Street,
  type StreetProps,
} from '@plinth/core'
import {
  enterBuilding,
  isolateBuildings,
  removeBuilding,
  rotateBuildingBy,
  setBuildingFloors,
  showAllBuildings,
} from '../actions.ts'
import { useAnalysis, useEditor, useEditorContext, useSnapshot } from '../context.ts'
import { selectionSize, type SiteDefaults } from '../state.ts'
import { CheckField, DeleteButton, LengthField, Readout, Stepper, TextField, type PanelFrame } from './fields.tsx'
import { TrashIcon } from './icons.tsx'
import { RoofFields } from './RoofFields.tsx'

const MAX_LANES = 12

/** The middle of the bounding box of a level's points. */
function groundCentre(snapshot: Snapshot, levelId: Id | undefined): { x: number; y: number } | null {
  if (!levelId) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const node of nodesOnLevel(snapshot, levelId)) {
    minX = Math.min(minX, node.x)
    maxX = Math.max(maxX, node.x)
    minY = Math.min(minY, node.y)
    maxY = Math.max(maxY, node.y)
  }
  return Number.isFinite(minX) ? { x: (minX + maxX) / 2, y: (minY + maxY) / 2 } : null
}
const MAX_FLOORS = 200

/** The site editor's panel: the selected building, street or street point, or the site itself. */
export function SitePanel({ frame }: { frame: PanelFrame }) {
  const snapshot = useSnapshot()
  const selection = useEditor((s) => s.selection)
  const tool = useEditor((s) => s.tool)
  const count = selectionSize(selection)
  const buildingId = selection.buildings.length === 1 ? selection.buildings[0] : undefined
  const streets = selection.streets.map((id) => snapshot.streets[id]).filter((s): s is Street => !!s)

  if (buildingId && count === 1) {
    return frame(snapshot.buildings[buildingId]?.name ?? 'Building', <BuildingShellProperties buildingId={buildingId} />)
  }
  if (streets.length > 0 && count === streets.length) {
    return frame(
      streets.length === 1 ? 'Street' : `${streets.length} streets`,
      <StreetProperties streets={streets} snapshot={snapshot} />,
    )
  }
  if (count === 1 && selection.streetNodes.length === 1) {
    return frame('Street point', <StreetNodeProperties nodeId={selection.streetNodes[0]!} snapshot={snapshot} />)
  }
  if (count > 0 && count === selection.buildings.length) {
    return frame(
      `${count} buildings`,
      <>
        <IsolateButton buildingIds={selection.buildings} />
        <DeleteButton />
      </>,
    )
  }
  if (count > 0) return frame(`${count} items`, <DeleteButton />)
  if (tool === 'street') return frame('New streets', <NewStreetDefaults />)
  if (tool === 'outline') return frame('New buildings', <NewBuildingDefaults />)
  return frame('Site', <SiteProperties snapshot={snapshot} />)
}

/** Hides every building but these (to focus on them), or shows the others again. */
function IsolateButton({ buildingIds }: { buildingIds: readonly Id[] }) {
  const ctx = useEditorContext()
  const isolated = useEditor((s) => s.isolated !== null)
  return (
    <button
      type="button"
      className="pe-button pe-button-wide"
      aria-pressed={isolated}
      title="H"
      onClick={() => (isolated ? showAllBuildings(ctx) : isolateBuildings(ctx, buildingIds))}
    >
      {isolated ? 'Show all buildings' : buildingIds.length === 1 ? 'Hide other buildings' : 'Hide the rest'}
    </button>
  )
}

function BuildingShellProperties({ buildingId }: { buildingId: Id }) {
  const ctx = useEditorContext()
  const snapshot = useSnapshot()
  const analysis = useAnalysis().buildings.get(buildingId)
  const building = snapshot.buildings[buildingId]
  if (!building) return null
  const levels = sortedLevels(snapshot, buildingId)
  const masters = levels.filter((l) => !l.masterId)
  const heights = masters.map((l) => l.height)
  const sameHeight = heights.every((h) => h === heights[0]) ? (heights[0] ?? null) : null
  const top = levels.at(-1)
  const topSlab = analysis?.slabs.find((s) => s.levelId === null)
  // To the top of the roof.
  const roofRise = analysis && topSlab ? roofHeight(topSlab.region, analysis.roof) : 0
  const totalHeight = top ? top.elevation + stackHeight(top) - (levels[0]?.elevation ?? 0) + roofRise : 0
  const floors = levels.reduce((sum, l) => sum + floorsOf(l), 0)
  // The middle of the building's ground floor; moving it moves the whole building.
  const centre = groundCentre(snapshot, levels[0]?.id)
  const moveTo = (to: { x: number; y: number }) => {
    if (!centre) return
    ctx.doc.transact((tx) => moveBuilding(tx, buildingId, { x: to.x - centre.x, y: to.y - centre.y }))
  }

  return (
    <>
      <button type="button" className="pe-button pe-button-wide pe-button-primary" onClick={() => enterBuilding(ctx, buildingId)}>
        Edit building
      </button>
      <IsolateButton buildingIds={[buildingId]} />
      <TextField
        label="Name"
        value={building.name}
        onCommit={(name) => ctx.doc.transact((tx) => void tx.putBuilding({ ...building, name }))}
      />
      <Stepper
        label="Floors"
        value={floors}
        min={1}
        max={MAX_FLOORS}
        fewer="One floor fewer"
        more="One more floor"
        onChange={(n) => setBuildingFloors(ctx, buildingId, n)}
      />
      <LengthField
        label="Floor height"
        value={sameHeight}
        placeholder="Mixed"
        onCommit={(height) =>
          ctx.doc.transact((tx) => {
            for (const level of masters) updateLevel(tx, level.id, { height })
          })
        }
      />
      <Readout label="Total height" value={formatLength(totalHeight)} />
      <div className="pe-row">
        <LengthField label="X" value={centre?.x ?? 0} allowNegative allowZero onCommit={(x) => moveTo({ x, y: centre?.y ?? 0 })} />
        <LengthField label="Y" value={centre?.y ?? 0} allowNegative allowZero onCommit={(y) => moveTo({ x: centre?.x ?? 0, y })} />
      </div>
      <div className="pe-field">
        <span className="pe-field-label">Rotate</span>
        <div className="pe-row">
          <button type="button" className="pe-button" onClick={() => rotateBuildingBy(ctx, buildingId, 90)}>
            ↺ 90°
          </button>
          <button type="button" className="pe-button" onClick={() => rotateBuildingBy(ctx, buildingId, 15)}>
            ↺ 15°
          </button>
          <button type="button" className="pe-button" onClick={() => rotateBuildingBy(ctx, buildingId, -15)}>
            ↻ 15°
          </button>
          <button type="button" className="pe-button" onClick={() => rotateBuildingBy(ctx, buildingId, -90)}>
            ↻ 90°
          </button>
        </div>
      </div>
      <RoofFields buildingId={buildingId} />
      <h3 className="pe-section-title">Areas</h3>
      <Readout label="Net floor area" value={formatArea(analysis?.netArea ?? 0)} />
      <Readout label="Gross floor area" value={formatArea(analysis?.grossArea ?? 0)} />
      <button type="button" className="pe-danger" onClick={() => removeBuilding(ctx, buildingId)}>
        <TrashIcon /> Delete building
      </button>
    </>
  )
}

/** Lanes, widths and extras of one or more streets; values shown are the first street's. */
function StreetProperties({ streets, snapshot }: { streets: Street[]; snapshot: Snapshot }) {
  const ctx = useEditorContext()
  const street = streets[0]!
  const ids = streets.map((s) => s.id)
  const update = (props: Partial<StreetProps>) => ctx.doc.transact((tx) => setStreetProps(tx, ids, props))
  const section = crossSection(street)
  const single = streets.length === 1

  return (
    <>
      <StreetFields props={street} onChange={update} />
      <h3 className="pe-section-title">Crossings</h3>
      <CheckField label="Zebra crossing at the start" checked={street.crosswalkA} onChange={(crosswalkA) => update({ crosswalkA })} />
      <CheckField label="Zebra crossing at the end" checked={street.crosswalkB} onChange={(crosswalkB) => update({ crosswalkB })} />
      <h3 className="pe-section-title">Size</h3>
      {single && <Readout label="Length" value={formatLength(streetLength(snapshot, street))} />}
      <Readout label="Road width" value={formatLength(section.roadLeft + section.roadRight)} />
      <Readout label="Total width" value={formatLength(section.outerLeft + section.outerRight)} />
      {single &&
        (street.control ? (
          <button
            type="button"
            className="pe-button pe-button-wide"
            onClick={() => ctx.doc.transact((tx) => setStreetCurve(tx, street.id, null))}
          >
            Straighten
          </button>
        ) : null)}
      <button
        type="button"
        className="pe-button pe-button-wide"
        onClick={() => {
          const { id: _id, a: _a, b: _b, control: _c, ...props } = street
          const defaults = ctx.store.getState().siteDefaults
          ctx.store.setState({ siteDefaults: { ...defaults, street: props } })
        }}
      >
        Use for new streets
      </button>
      <DeleteButton label={single ? 'Delete street' : 'Delete streets'} />
    </>
  )
}

/** The lane count, lane width and both sides of a street. Left and right are as drawn, looking from the start. */
function StreetFields({ props, onChange }: { props: StreetProps; onChange: (props: Partial<StreetProps>) => void }) {
  return (
    <>
      <Stepper
        label="Driving lanes"
        value={props.lanes}
        min={1}
        max={MAX_LANES}
        fewer="One lane fewer"
        more="One more lane"
        onChange={(lanes) => onChange({ lanes })}
      />
      <LengthField label="Lane width" value={props.laneWidth} onCommit={(laneWidth) => onChange({ laneWidth })} />
      <div className="pe-sides">
        <span />
        <span className="pe-sides-head">Left</span>
        <span className="pe-sides-head">Right</span>
        <SideRow label="Sidewalk" left={props.sidewalkLeft} right={props.sidewalkRight} onLeft={(sidewalkLeft) => onChange({ sidewalkLeft })} onRight={(sidewalkRight) => onChange({ sidewalkRight })} />
        <SideRow label="Bike lane" left={props.bikeLeft} right={props.bikeRight} onLeft={(bikeLeft) => onChange({ bikeLeft })} onRight={(bikeRight) => onChange({ bikeRight })} />
        <SideRow label="Parking" left={props.parkingLeft} right={props.parkingRight} onLeft={(parkingLeft) => onChange({ parkingLeft })} onRight={(parkingRight) => onChange({ parkingRight })} />
      </div>
      <p className="pe-note">Widths in metres; 0 leaves it out. Left and right as drawn, looking from the start.</p>
    </>
  )
}

function SideRow({
  label,
  left,
  right,
  onLeft,
  onRight,
}: {
  label: string
  left: number
  right: number
  onLeft: (v: number) => void
  onRight: (v: number) => void
}) {
  return (
    <>
      <span className="pe-field-label">{label}</span>
      <LengthField label="" value={left} allowZero onCommit={onLeft} />
      <LengthField label="" value={right} allowZero onCommit={onRight} />
    </>
  )
}

function StreetNodeProperties({ nodeId, snapshot }: { nodeId: Id; snapshot: Snapshot }) {
  const ctx = useEditorContext()
  const node = snapshot.streetNodes[nodeId]
  if (!node) return null
  const meeting = Object.values(snapshot.streets).filter((s) => s.a === nodeId || s.b === nodeId).length
  const move = (x: number, y: number) =>
    ctx.doc.transact((tx) => {
      moveStreetNodes(tx, new Map([[nodeId, { x, y }]]))
      finishStreetMove(tx, [nodeId])
    })
  return (
    <>
      <LengthField label="X" value={node.x} allowNegative onCommit={(x) => move(x, node.y)} />
      <LengthField label="Y" value={node.y} allowNegative onCommit={(y) => move(node.x, y)} />
      <Readout label="Streets here" value={String(meeting)} />
      <DeleteButton label={meeting === 2 ? 'Delete point (joins the two streets)' : 'Delete point'} />
    </>
  )
}

function useDefaults(): [SiteDefaults, (patch: Partial<SiteDefaults>) => void] {
  const { store } = useEditorContext()
  const defaults = useEditor((s) => s.siteDefaults)
  return [defaults, (patch) => store.setState({ siteDefaults: { ...store.getState().siteDefaults, ...patch } })]
}

function NewStreetDefaults() {
  const [defaults, set] = useDefaults()
  return (
    <>
      <StreetFields props={defaults.street} onChange={(props) => set({ street: { ...defaults.street, ...props } })} />
    </>
  )
}

function NewBuildingDefaults() {
  const [defaults, set] = useDefaults()
  return (
    <>
      <Stepper label="Floors" value={defaults.floors} min={1} max={MAX_FLOORS} onChange={(floors) => set({ floors })} />
      <LengthField label="Floor height" value={defaults.floorHeight} onCommit={(floorHeight) => set({ floorHeight })} />
    </>
  )
}

function SiteProperties({ snapshot }: { snapshot: Snapshot }) {
  const ctx = useEditorContext()
  const analysis = useAnalysis()
  const buildings = Object.keys(snapshot.buildings).length
  const streets = Object.values(snapshot.streets)
  const length = streets.reduce((sum, s) => sum + streetLength(snapshot, s), 0)
  return (
    <>
      <h3 className="pe-section-title">Totals</h3>
      <Readout label="Buildings" value={String(buildings)} />
      <Readout label="Gross floor area" value={formatArea(analysis.grossArea)} />
      <Readout label="Net floor area" value={formatArea(analysis.netArea)} />
      <Readout label="Streets" value={streets.length === 0 ? 'None' : formatLength(length)} />
      <h3 className="pe-section-title">Defaults</h3>
      <LengthField
        label="Wall thickness"
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
