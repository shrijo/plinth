import { floorsOf, sortedLevels } from '@plinth/core'
import { useState } from 'react'
import {
  addLevelAbove,
  exitToSite,
  isolateBuildings,
  showAllBuildings,
  showWholeBuilding,
  toggleLevelFocus,
  toggleSnapping,
  toggleView,
} from '../actions.ts'
import { useEditor, useEditorContext, useSnapshot } from '../context.ts'
import { FIRST_HOUR, formatHour, LAST_HOUR } from '../scene/daylight.ts'
import { LENSES } from '../state.ts'
import { BackIcon, ChevronIcon, LevelsIcon, LinkIcon, PlusIcon } from './icons.tsx'

/** The panel at the top left: the levels of the open building (the view options live in the dock). */
export function LevelBar() {
  const site = useEditor((s) => s.mode === 'site')
  return site ? null : <BuildingLevels />
}

/** How the view looks, unfolding from View in the dock: in both editors, with the building's own options inside one. */
export function ViewOptions({ site }: { site: boolean }) {
  const ctx = useEditorContext()
  const showAbove = useEditor((s) => s.showLevelsAbove)
  const outlines = useEditor((s) => s.showOutlines)
  const fade = useEditor((s) => s.fadeOtherLevels)
  const lens = useEditor((s) => s.lens)
  const hour = useEditor((s) => s.timeOfDay)
  const openId = useEditor((s) => s.buildingId)
  const isolated = useEditor((s) => s.isolated !== null)
  const occlusion = useEditor((s) => s.ambientOcclusion)
  const world = useEditor((s) => s.showWorld)
  const top = useEditor((s) => s.view === 'top')
  const snapping = useEditor((s) => s.snap.enabled)
  const placed = useSnapshot().meta.origin?.kind === 'lonlat'
  return (
    <div className="pe-view-options">
      <label className="pe-field">
        <span className="pe-field-label">Sun</span>
        <span className="pe-option-value">
          <input
            type="range"
            min={FIRST_HOUR}
            max={LAST_HOUR}
            step={0.25}
            value={hour}
            aria-valuetext={formatHour(hour)}
            onChange={(e) => ctx.store.setState({ timeOfDay: Number(e.target.value) })}
          />
          <output>{formatHour(hour)}</output>
        </span>
      </label>
      <div className="pe-field">
        <span className="pe-field-label">Lens</span>
        <div className="pe-option-value">
          <div className="pe-segmented" role="radiogroup" aria-label="Lens">
            {LENSES.map((mm) => (
              <button
                key={mm}
                type="button"
                role="radio"
                aria-checked={lens === mm}
                title={`${mm} mm${mm === 35 ? ' (natural)' : mm < 35 ? ' (wide)' : ''}`}
                onClick={() => ctx.store.setState({ lens: mm })}
              >
                {mm}
              </button>
            ))}
          </div>
          <span className="pe-lens-unit">mm</span>
        </div>
      </div>
      {/* On the narrowest screens the dock hands these two over. */}
      <label className="pe-check pe-narrow-only">
        <input type="checkbox" checked={top} onChange={() => toggleView(ctx)} />
        Top view
      </label>
      <label className="pe-check pe-narrow-only">
        <input type="checkbox" checked={snapping} onChange={() => toggleSnapping(ctx)} />
        Snapping
      </label>
      {!site && (
        <>
          <label className="pe-check">
            <input
              type="checkbox"
              checked={showAbove}
              onChange={(e) => ctx.store.setState({ showLevelsAbove: e.target.checked })}
            />
            Show floors above
          </label>
          <label className="pe-check">
            <input type="checkbox" checked={fade} onChange={(e) => ctx.store.setState({ fadeOtherLevels: e.target.checked })} />
            Fade other floors
          </label>
          <label className="pe-check">
            <input
              type="checkbox"
              checked={isolated}
              onChange={(e) => (e.target.checked && openId ? isolateBuildings(ctx, [openId]) : showAllBuildings(ctx))}
            />
            Hide other buildings
          </label>
        </>
      )}
      <label className="pe-check" title="Soft shading in corners, at the foot of walls and down streets">
        <input
          type="checkbox"
          checked={occlusion}
          onChange={(e) => ctx.store.setState({ ambientOcclusion: e.target.checked })}
        />
        Soft shading
      </label>
      <label className="pe-check">
        <input type="checkbox" checked={outlines} onChange={(e) => ctx.store.setState({ showOutlines: e.target.checked })} />
        Outlines
      </label>
      {placed && (
        <label className="pe-check" title="The streets, buildings and land around the site, from open map data">
          <input type="checkbox" checked={world} onChange={(e) => ctx.store.setState({ showWorld: e.target.checked })} />
          Real world around
        </label>
      )}
    </div>
  )
}

/**
 * The open building's stack of levels, top floor first, under a way back
 * to the site. Click a level to work on it; click it again (or "Whole
 * building") to take the focus off and see every floor.
 */
function BuildingLevels() {
  const ctx = useEditorContext()
  const snapshot = useSnapshot()
  const activeLevelId = useEditor((s) => s.activeLevelId)
  const buildingId = useEditor((s) => s.buildingId)
  const whole = useEditor((s) => s.wholeBuilding)
  // Folded on phones, where it shows just the active level.
  const [open, setOpen] = useState(() => !window.matchMedia('(max-width: 700px)').matches)
  const levels = sortedLevels(snapshot, buildingId ?? undefined).reverse()
  const active = snapshot.levels[activeLevelId]
  const building = buildingId ? snapshot.buildings[buildingId] : undefined

  return (
    <section className="pe-levels" data-open={open || undefined} aria-label="Levels">
      <nav className="pe-crumbs" aria-label="Breadcrumb">
        <button type="button" className="pe-crumb" onClick={() => exitToSite(ctx)} title="Back to the site (Esc)">
          <BackIcon />
          Site
        </button>
        <span className="pe-crumb-current">{building?.name ?? 'Building'}</span>
      </nav>
      <div className="pe-levels-header">
        <button
          type="button"
          className="pe-levels-toggle"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          title={open ? 'Hide levels' : 'Show levels'}
        >
          <span className="pe-levels-title">
            {open ? 'Levels' : whole ? 'Whole building' : (active?.name ?? 'Levels')}
          </span>
          <ChevronIcon open={open} />
        </button>
        <button
          type="button"
          className="pe-icon-button"
          title="Add a floor above"
          aria-label="Add a floor above"
          onClick={() => addLevelAbove(ctx)}
        >
          <PlusIcon />
        </button>
      </div>
      {open && (
        <ol className="pe-levels-list">
          <li>
            <button
              type="button"
              className="pe-level pe-level-whole"
              data-active={whole || undefined}
              aria-current={whole || undefined}
              onClick={() => showWholeBuilding(ctx)}
            >
              <span className="pe-level-name">
                <LevelsIcon />
                Whole building
              </span>
            </button>
          </li>
          {levels.map((level) => {
            const current = !whole && level.id === activeLevelId
            return (
              <li key={level.id}>
                <button
                  type="button"
                  className="pe-level"
                  data-active={current || undefined}
                  data-copy={level.masterId ? true : undefined}
                  aria-current={current || undefined}
                  title={current ? 'Click again to see the whole building' : undefined}
                  onClick={() => toggleLevelFocus(ctx, level.id)}
                >
                  <span className="pe-level-name">
                    {level.masterId && <LinkIcon />}
                    {level.name}
                    {floorsOf(level) > 1 && <span className="pe-level-count">×{floorsOf(level)}</span>}
                  </span>
                  <span className="pe-level-elevation">{level.elevation.toFixed(2)} m</span>
                </button>
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}
