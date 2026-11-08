import { parseLength } from '@plinth/core'
import { useRef, useState, type ReactNode } from 'react'
import { deleteSelection } from '../actions.ts'
import { useEditorContext } from '../context.ts'
import { MinusIcon, PlusIcon, TrashIcon } from './icons.tsx'

/** Form fields shared by the properties panels. */

/** Draws the panel around a title and its contents. */
export type PanelFrame = (title: string, body: ReactNode) => ReactNode

export function Readout({ label, value }: { label: string; value: string }) {
  return (
    <div className="pe-field pe-field-row">
      <span className="pe-field-label">{label}</span>
      <span className="pe-readout">{value}</span>
    </div>
  )
}

export function DeleteButton({ label = 'Delete' }: { label?: string }) {
  const ctx = useEditorContext()
  return (
    <button type="button" className="pe-danger" onClick={() => deleteSelection(ctx)}>
      <TrashIcon /> {label}
    </button>
  )
}

/** Text that commits on Enter or when it loses focus. */
export function TextField({ label, value, onCommit }: { label: string; value: string; onCommit: (value: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  const cancelled = useRef(false)
  const commit = () => {
    const next = draft?.trim()
    if (!cancelled.current && next && next !== value) onCommit(next)
    cancelled.current = false
    setDraft(null)
  }
  return (
    <label className="pe-field">
      <span className="pe-field-label">{label}</span>
      <input
        className="pe-input pe-input-text"
        value={draft ?? value}
        onFocus={() => setDraft(value)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') {
            cancelled.current = true
            e.currentTarget.blur()
          }
        }}
      />
    </label>
  )
}

/** A length in metres that commits on Enter or when it loses focus. Accepts "350cm" and similar. */
export function LengthField({
  label,
  value,
  onCommit,
  isDefault = false,
  onReset,
  placeholder,
  allowNegative = false,
  allowZero = false,
}: {
  label: string
  value: number | null
  onCommit: (value: number) => void
  isDefault?: boolean
  onReset?: () => void
  placeholder?: string
  allowNegative?: boolean
  allowZero?: boolean
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const cancelled = useRef(false)
  const shown = draft ?? (value === null ? '' : value.toFixed(2))
  const parsed = draft === null ? null : parseLength(draft)
  const acceptable = (v: number) => (allowNegative || v >= 0) && (allowZero || allowNegative || v > 0)
  const invalid = draft !== null && draft.trim() !== '' && (parsed === null || !acceptable(parsed))

  const commit = () => {
    if (!cancelled.current && parsed !== null && acceptable(parsed) && parsed !== value) onCommit(parsed)
    cancelled.current = false
    setDraft(null)
  }

  return (
    <label className="pe-field">
      <span className="pe-field-label">
        {label}
        {isDefault && <span className="pe-badge">default</span>}
        {!isDefault && onReset && (
          <button type="button" className="pe-link" onClick={onReset}>
            use default
          </button>
        )}
      </span>
      <span className="pe-input-wrap">
        <input
          className="pe-input"
          inputMode="decimal"
          autoComplete="off"
          value={shown}
          placeholder={placeholder}
          aria-invalid={invalid}
          onFocus={(e) => {
            setDraft(shown)
            e.target.select()
          }}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
            if (e.key === 'Escape') {
              cancelled.current = true
              e.currentTarget.blur()
            }
          }}
        />
        <span className="pe-unit">m</span>
      </span>
    </label>
  )
}

/** A plain number with a unit (degrees, say), kept within limits; commits on Enter or when it loses focus. */
export function NumberField({
  label,
  value,
  unit,
  min,
  max,
  decimals = 0,
  onCommit,
}: {
  label: string
  value: number
  unit: string
  min: number
  max: number
  decimals?: number
  onCommit: (value: number) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const cancelled = useRef(false)
  const shown = draft ?? value.toFixed(decimals)
  const parsed = draft === null ? null : Number(draft.replace(',', '.').replace(unit, '').trim())
  const valid = parsed !== null && draft?.trim() !== '' && Number.isFinite(parsed) && parsed >= min && parsed <= max
  const commit = () => {
    if (!cancelled.current && valid && parsed !== value) onCommit(parsed)
    cancelled.current = false
    setDraft(null)
  }
  return (
    <label className="pe-field">
      <span className="pe-field-label">{label}</span>
      <span className="pe-input-wrap">
        <input
          className="pe-input"
          inputMode="decimal"
          autoComplete="off"
          value={shown}
          aria-invalid={draft !== null && draft.trim() !== '' && !valid}
          onFocus={(e) => {
            setDraft(shown)
            e.target.select()
          }}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
            if (e.key === 'Escape') {
              cancelled.current = true
              e.currentTarget.blur()
            }
          }}
        />
        <span className="pe-unit">{unit}</span>
      </span>
    </label>
  )
}

/** A whole number with minus and plus buttons. */
export function Stepper({
  label,
  value,
  min = 0,
  max = Infinity,
  onChange,
  fewer = 'One fewer',
  more = 'One more',
}: {
  label: ReactNode
  value: number
  min?: number
  max?: number
  onChange: (value: number) => void
  fewer?: string
  more?: string
}) {
  return (
    <div className="pe-field">
      <span className="pe-field-label">{label}</span>
      <div className="pe-stepper">
        <button
          type="button"
          className="pe-icon-button"
          aria-label={fewer}
          disabled={value <= min}
          onClick={() => onChange(value - 1)}
        >
          <MinusIcon />
        </button>
        <span className="pe-stepper-value">{value}</span>
        <button
          type="button"
          className="pe-icon-button"
          aria-label={more}
          disabled={value >= max}
          onClick={() => onChange(value + 1)}
        >
          <PlusIcon />
        </button>
      </div>
    </div>
  )
}

export function CheckField({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="pe-check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  )
}
