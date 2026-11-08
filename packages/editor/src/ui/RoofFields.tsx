import { longestSideAngle, roofOf, ROOF_KINDS, type Id, type Roof, type RoofKind } from '@plinth/core'
import { setBuildingRoof } from '../actions.ts'
import { useAnalysis, useEditorContext, useSnapshot } from '../context.ts'
import { LengthField, NumberField } from './fields.tsx'

const KIND_NAMES: Record<RoofKind, string> = { flat: 'Flat', shed: 'Shed', gable: 'Gable', hip: 'Hip' }

/** Overhang a pitched roof starts with, in metres. */
const PITCHED_OVERHANG = 0.4

/** A building's roof: its type, then the settings that type has. */
export function RoofFields({ buildingId }: { buildingId: Id }) {
  const ctx = useEditorContext()
  const snapshot = useSnapshot()
  const building = snapshot.buildings[buildingId]
  const region = useAnalysis().buildings.get(buildingId)?.slabs.find((s) => s.levelId === null)?.region
  if (!building) return null
  const roof = roofOf(building)
  const update = (patch: Partial<Roof>) => setBuildingRoof(ctx, buildingId, { ...roof, ...patch })
  const pitched = roof.kind !== 'flat'

  const pick = (kind: RoofKind) => {
    if (kind === roof.kind) return
    // A flat roof with nothing on it is the plain one; a first pitched roof gets eaves.
    if (kind === 'flat') {
      const flat = { ...roof, kind, overhang: 0 }
      setBuildingRoof(ctx, buildingId, flat.parapet > 0 ? flat : null)
    } else update({ kind, overhang: roof.kind === 'flat' && !building.roof ? PITCHED_OVERHANG : roof.overhang })
  }

  // Turns the ridge (or the fall) a quarter turn from where it runs now.
  const turn = () => {
    const now = roof.direction ?? (region ? longestSideAngle(region) : 0)
    update({ direction: now + 90 })
  }

  return (
    <>
      <h3 className="pe-section-title">Roof</h3>
      <div className="pe-segmented pe-segmented-wide" role="radiogroup" aria-label="Roof type">
        {ROOF_KINDS.map((kind) => (
          <button key={kind} type="button" role="radio" aria-checked={roof.kind === kind} onClick={() => pick(kind)}>
            {KIND_NAMES[kind]}
          </button>
        ))}
      </div>
      {pitched ? (
        <>
          <NumberField label="Pitch" value={roof.pitch} unit="°" min={1} max={75} onCommit={(pitch) => update({ pitch })} />
          <div className="pe-row">
            <LengthField label="Overhang" value={roof.overhang} allowZero onCommit={(overhang) => update({ overhang })} />
            <LengthField label="Thickness" value={roof.thickness} onCommit={(thickness) => update({ thickness })} />
          </div>
          <button type="button" className="pe-button pe-button-wide" onClick={turn}>
            {roof.kind === 'shed' ? 'Turn the slope' : 'Turn the ridge'} 90°
          </button>
          {roof.direction !== null && (
            <button type="button" className="pe-link" onClick={() => update({ direction: null })}>
              Along the longest side
            </button>
          )}
        </>
      ) : (
        <div className="pe-row">
          <LengthField label="Parapet" value={roof.parapet} allowZero onCommit={(parapet) => update({ parapet })} />
          <LengthField
            label="Overhang"
            value={roof.overhang}
            allowZero
            onCommit={(overhang) => {
              const next = { ...roof, overhang }
              setBuildingRoof(ctx, buildingId, next.parapet > 0 || overhang > 0 ? next : null)
            }}
          />
        </div>
      )}
    </>
  )
}


