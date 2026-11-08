import { AREA_STANDARD_DEFINITIONS, AREA_STANDARDS, areaFigures, formatArea, type AreaStandard, type Id } from '@plinth/core'
import { useMemo } from 'react'
import { useEditorContext, useSnapshot } from '../context.ts'

/**
 * Area figures by the project's area standard (SIA 416 or DIN 277), for a
 * building or the whole site: gross area, construction area, net area and
 * its split by use, and volume.
 */
export function AreaFigures({ buildingId, chooser = false }: { buildingId?: Id; chooser?: boolean }) {
  const ctx = useEditorContext()
  const snapshot = useSnapshot()
  const figures = useMemo(() => areaFigures(snapshot, buildingId), [snapshot, buildingId])
  const setStandard = (areaStandard: AreaStandard) => ctx.doc.transact((tx) => tx.setMeta({ areaStandard }))
  return (
    <>
      <h3 className="pe-section-title">Areas · {figures.standardName}</h3>
      {chooser && (
        <div className="pe-segmented pe-segmented-wide" role="radiogroup" aria-label="Area standard">
          {AREA_STANDARDS.map((standard) => (
            <button
              key={standard}
              type="button"
              role="radio"
              aria-checked={figures.standard === standard}
              onClick={() => setStandard(standard)}
            >
              {AREA_STANDARD_DEFINITIONS[standard].name}
            </button>
          ))}
        </div>
      )}
      <dl className="pe-figures">
        {figures.lines.map((line) => (
          <div key={line.code} className="pe-figure" data-depth={line.depth}>
            <dt>
              <abbr>{line.code}</abbr> {line.name}
            </dt>
            <dd>{line.unit === 'm²' ? formatArea(line.value) : `${Math.round(line.value).toLocaleString()} m³`}</dd>
          </div>
        ))}
      </dl>
      {figures.unset > 0.005 && (
        <p className="pe-note">
          {formatArea(figures.unset)} of rooms have no use set and count as {AREA_STANDARD_DEFINITIONS[figures.standard].unset}. Set a
          room's use in the building editor.
        </p>
      )}
    </>
  )
}
