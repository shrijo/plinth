import { formatLength, parseLength } from '@plinth/core'
import { useEffect, useRef } from 'react'
import { commitTypedLength, completeDrawing, detach, setActiveLevel, showAllBuildings } from '../actions.ts'
import { useEditor, useEditorContext, useSnapshot } from '../context.ts'
import { CheckIcon, RulerIcon } from './icons.tsx'
import { isOutlineTool } from '../state.ts'

/**
 * The bar at the bottom of the canvas: on the site, the name of the
 * building under the pointer (or the one selected), always in this one
 * place; the exact-length box; touch buttons while drawing; and a way back
 * when other buildings are hidden or a copied floor can't be drawn on.
 */
export function StatusBar() {
  const ctx = useEditorContext()
  const tool = useEditor((s) => s.tool)
  const drawing = useEditor((s) => s.anchor !== null)
  const pointerKind = useEditor((s) => s.pointerKind)
  const lengthInput = useEditor((s) => s.lengthInput)
  const site = useEditor((s) => s.mode === 'site')
  const isolated = useEditor((s) => s.isolated !== null)
  const hover = useEditor((s) => s.hover)
  const selected = useEditor((s) => s.selection.buildings)
  const selectedParcels = useEditor((s) => s.selection.parcels)
  const snapshot = useSnapshot()
  const activeLevelId = useEditor((s) => s.activeLevelId)
  const level = snapshot.levels[activeLevelId]
  const master = !site && level?.masterId ? snapshot.levels[level.masterId] : undefined
  const touch = pointerKind === 'touch'

  if (lengthInput !== null) return <LengthInput value={lengthInput} />

  // A copied floor can't be drawn on: offer the ways out.
  if (master && level && tool !== 'select') {
    return (
      <div className="pe-status">
        <span className="pe-hint">Copy of {master.name}</span>
        <button type="button" className="pe-chip" onClick={() => setActiveLevel(ctx, master.id)}>
          Go to {master.name}
        </button>
        <button type="button" className="pe-chip pe-chip-primary" onClick={() => detach(ctx, level.id)}>
          Detach
        </button>
      </div>
    )
  }

  // Touch has no Enter key or double-click: buttons to finish a drawing.
  if (drawing && touch) {
    return (
      <div className="pe-status">
        {(tool === 'wall' || tool === 'street' || isOutlineTool(tool)) && (
          <button type="button" className="pe-chip" onClick={() => ctx.store.setState({ lengthInput: '' })}>
            <RulerIcon /> Length
          </button>
        )}
        <button type="button" className="pe-chip pe-chip-primary" onClick={() => completeDrawing(ctx)}>
          <CheckIcon /> {isOutlineTool(tool) ? 'Close' : 'Done'}
        </button>
      </div>
    )
  }

  // The building (or parcel) under the pointer, or else the one selected.
  const shownId = site ? (hover?.kind === 'building' ? hover.id : selected.length === 1 ? selected[0] : undefined) : undefined
  const shown = shownId ? snapshot.buildings[shownId] : undefined
  const parcelId = site ? (hover?.kind === 'parcel' ? hover.id : selectedParcels.length === 1 ? selectedParcels[0] : undefined) : undefined
  const parcel = parcelId ? snapshot.parcels[parcelId] : undefined
  const spot = hover?.kind === 'spotHeight' ? snapshot.spotHeights[hover.id] : undefined
  const name =
    (spot ? `Spot height ${formatLength(spot.z)}` : undefined) ??
    (hover?.kind === 'parcel' ? parcel?.name : undefined) ??
    shown?.name ??
    parcel?.name ??
    (site && selected.length > 1 ? `${selected.length} buildings` : null)
  if (!name && !isolated) return null
  return (
    <div className="pe-status" data-quiet={!isolated || undefined}>
      {name && <span className="pe-hint pe-name">{name}</span>}
      {isolated && (
        <button type="button" className="pe-chip pe-chip-primary" onClick={() => showAllBuildings(ctx)}>
          Show all buildings <kbd>H</kbd>
        </button>
      )}
    </div>
  )
}

function LengthInput({ value }: { value: string }) {
  const ctx = useEditorContext()
  const ref = useRef<HTMLInputElement>(null)
  const valid = value.trim() === '' || parseLength(value) !== null

  useEffect(() => {
    const input = ref.current
    if (!input) return
    input.focus()
    // Put the caret after the character that opened the box.
    input.setSelectionRange(input.value.length, input.value.length)
  }, [])

  return (
    <form
      className="pe-status"
      onSubmit={(e) => {
        e.preventDefault()
        if (commitTypedLength(ctx, value)) ref.current?.blur()
      }}
    >
      <label className="pe-length">
        <span>Length</span>
        <input
          ref={ref}
          value={value}
          inputMode="decimal"
          autoComplete="off"
          aria-invalid={!valid}
          placeholder="3.5 or 350cm"
          onChange={(e) => ctx.store.setState({ lengthInput: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              ctx.store.setState({ lengthInput: null })
            }
          }}
        />
      </label>
      <button type="submit" className="pe-chip pe-chip-primary" disabled={!valid || value.trim() === ''}>
        <CheckIcon /> Place
      </button>
      <button type="button" className="pe-chip" onClick={() => ctx.store.setState({ lengthInput: null })}>
        Cancel
      </button>
    </form>
  )
}
