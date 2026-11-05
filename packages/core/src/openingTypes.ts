import type { OpeningKind } from './model.ts'

/**
 * The library of window and door types that fill openings. A type sets the
 * default size of a new opening and how its fill is built; the opening
 * itself can then be resized freely.
 */
export interface OpeningType {
  id: string
  name: string
  kind: OpeningKind
  defaults: { width: number; height: number; sill: number }
  /** 'none' leaves the hole empty. */
  fill: 'none' | 'window' | 'door'
  /** Width of frame members, in metres. */
  frame: number
  /** Glazing bars dividing each pane, across and up. */
  divisionsX: number
  divisionsY: number
  /** Door leaves or window sashes (1, or 2 meeting in the middle). */
  leaves: 1 | 2
  /** Whether a door leaf is glass. */
  glazedLeaf: boolean
  /** Whether it opens at all (fixed glazing doesn't). */
  operable: boolean
  /** How far it swings open, in degrees. */
  openDegrees: number
}

const base = {
  frame: 0.06,
  divisionsX: 0,
  divisionsY: 0,
  leaves: 1 as const,
  glazedLeaf: false,
  operable: true,
  openDegrees: 60,
}
const door = { ...base, kind: 'door' as const, fill: 'door' as const, frame: 0.05, openDegrees: 90 }

export const OPENING_TYPES: readonly OpeningType[] = [
  { ...base, id: 'window', name: 'Window', kind: 'window', fill: 'window', defaults: { width: 1.2, height: 1.4, sill: 0.9 } },
  {
    ...base,
    id: 'window-casement',
    name: 'Double casement',
    kind: 'window',
    fill: 'window',
    leaves: 2,
    defaults: { width: 1.4, height: 1.4, sill: 0.9 },
  },
  {
    ...base,
    id: 'window-grid',
    name: 'Divided lights',
    kind: 'window',
    fill: 'window',
    divisionsX: 2,
    divisionsY: 1,
    defaults: { width: 1.5, height: 1.5, sill: 0.8 },
  },
  {
    ...base,
    id: 'window-tall',
    name: 'Floor-to-ceiling (fixed)',
    kind: 'window',
    fill: 'window',
    frame: 0.05,
    operable: false,
    defaults: { width: 1.2, height: 2.3, sill: 0.1 },
  },
  { ...base, id: 'window-empty', name: 'Empty opening', kind: 'window', fill: 'none', operable: false, defaults: { width: 1.2, height: 1.4, sill: 0.9 } },
  { ...door, id: 'door', name: 'Door', defaults: { width: 0.9, height: 2.1, sill: 0 } },
  { ...door, id: 'door-double', name: 'Double door', leaves: 2, defaults: { width: 1.6, height: 2.1, sill: 0 } },
  { ...door, id: 'door-glass', name: 'Glass door', glazedLeaf: true, defaults: { width: 0.9, height: 2.2, sill: 0 } },
  { ...door, id: 'door-empty', name: 'Doorway', fill: 'none', operable: false, defaults: { width: 0.9, height: 2.1, sill: 0 } },
]

export const DEFAULT_OPENING_TYPE: Record<OpeningKind, string> = { window: 'window', door: 'door' }

export function openingType(id: string, kind: OpeningKind = 'window'): OpeningType {
  return (
    OPENING_TYPES.find((t) => t.id === id) ??
    OPENING_TYPES.find((t) => t.id === DEFAULT_OPENING_TYPE[kind])!
  )
}

export function openingTypesOfKind(kind: OpeningKind): OpeningType[] {
  return OPENING_TYPES.filter((t) => t.kind === kind)
}

/**
 * A box in an opening's fill, in metres. Coordinates are opening-local
 * (x along the wall from its start towards its end, y up, z across the
 * wall towards its right face, origin at the opening's centre), or for
 * leaf parts, relative to the leaf's hinge.
 */
export interface FillPart {
  material: 'frame' | 'glass' | 'leaf'
  center: [number, number, number]
  size: [number, number, number]
}

/** A door leaf or window sash that swings about a vertical hinge. */
export interface FillLeaf {
  /** Where its hinge line passes, in opening-local coordinates (y is 0). */
  hinge: [number, number, number]
  /** Its parts when closed, relative to the hinge. */
  parts: FillPart[]
  /** Rotation about the vertical axis when fully open, in radians. */
  openAngle: number
}

export interface FillLayout {
  /** Parts that never move: the frame, and fixed glazing. */
  frame: FillPart[]
  leaves: FillLeaf[]
}

export interface FillOptions {
  /** Hinge on the wall-end jamb instead of the wall-start jamb. */
  flipHinge?: boolean
  /** Swing towards the wall's left face (−z) instead of its right face (+z). */
  flipSide?: boolean
}

type Box = (
  material: FillPart['material'],
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  z: number,
  depth: number,
) => void

function collector(parts: FillPart[]): Box {
  return (material, x0, y0, x1, y1, z, depth) =>
    parts.push({
      material,
      center: [(x0 + x1) / 2, (y0 + y1) / 2, z],
      size: [Math.abs(x1 - x0), Math.abs(y1 - y0), depth],
    })
}

/**
 * The parts of an opening's fill, for an opening of the given size in a
 * wall of the given thickness, in the closed position.
 */
export function fillLayout(
  type: OpeningType,
  width: number,
  height: number,
  wallThickness: number,
  options: FillOptions = {},
): FillLayout {
  const layout: FillLayout = { frame: [], leaves: [] }
  if (type.fill === 'none') return layout
  const frameBox = collector(layout.frame)
  const f = Math.min(type.frame, width / 4, height / 4)
  const depth = Math.min(0.08, wallThickness * 0.8)
  const w2 = width / 2
  const h2 = height / 2
  const isWindow = type.fill === 'window'

  // Frame: jambs and head, plus a sill for windows.
  frameBox('frame', -w2, -h2, -w2 + f, h2, 0, depth)
  frameBox('frame', w2 - f, -h2, w2, h2, 0, depth)
  frameBox('frame', -w2 + f, h2 - f, w2 - f, h2, 0, depth)
  if (isWindow) frameBox('frame', -w2 + f, -h2, w2 - f, -h2 + f, 0, depth)

  const x0 = -w2 + f
  const x1 = w2 - f
  const y0 = isWindow ? -h2 + f : -h2
  const y1 = h2 - f

  if (!type.operable) {
    glazing(frameBox, type, 0, x1 - x0, y0, y1, 0, (x) => x0 + x)
    return layout
  }

  const side = options.flipSide ? -1 : 1
  const leafDepth = isWindow ? Math.min(0.06, depth) : Math.min(0.045, depth)
  const angle = (type.openDegrees * Math.PI) / 180
  const leafWidth = (x1 - x0) / type.leaves
  const gap = 0.004
  for (let i = 0; i < type.leaves; i++) {
    // A single leaf hangs on the start jamb (or the end jamb if flipped);
    // a pair hangs one on each jamb.
    const fromEnd = type.leaves === 2 ? i === 1 : !!options.flipHinge
    const along = fromEnd ? -1 : 1
    const hingeX = fromEnd ? x1 : x0
    const parts: FillPart[] = []
    const box = collector(parts)
    // Leaf-local x runs from the hinge (0) out to the leaf's free edge.
    const lx = (x: number) => along * x
    const z = -side * (leafDepth / 2)
    const length = leafWidth - gap
    if (isWindow) {
      const s = Math.min(0.05, length / 5, (y1 - y0) / 5)
      box('frame', lx(0), y0, lx(s), y1, z, leafDepth)
      box('frame', lx(length - s), y0, lx(length), y1, z, leafDepth)
      box('frame', lx(s), y1 - s, lx(length - s), y1, z, leafDepth)
      box('frame', lx(s), y0, lx(length - s), y0 + s, z, leafDepth)
      glazing(box, type, s, length - s, y0 + s, y1 - s, z, lx)
    } else if (type.glazedLeaf) {
      const s = 0.06
      box('leaf', lx(0), y0, lx(s), y1, z, leafDepth)
      box('leaf', lx(length - s), y0, lx(length), y1, z, leafDepth)
      box('leaf', lx(s), y1 - s, lx(length - s), y1, z, leafDepth)
      box('leaf', lx(s), y0, lx(length - s), y0 + s * 1.5, z, leafDepth)
      box('glass', lx(s), y0 + s * 1.5, lx(length - s), y1 - s, z, 0.02)
    } else {
      box('leaf', lx(0), y0, lx(length), y1 - gap, z, leafDepth)
    }
    layout.leaves.push({
      hinge: [hingeX, 0, side * (leafDepth / 2)],
      parts,
      // Turning about +y moves +x towards −z, so the sign follows hinge and side.
      openAngle: -side * along * angle,
    })
  }
  return layout
}

/** Glass between x0 and x1 (mapped through `mapX`), with the type's glazing bars. */
function glazing(
  box: Box,
  type: OpeningType,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  z: number,
  mapX: (x: number) => number,
): void {
  box('glass', mapX(x0), y0, mapX(x1), y1, z, 0.02)
  const bar = Math.min(0.03, type.frame * 0.6)
  for (let i = 1; i <= type.divisionsX; i++) {
    const x = x0 + ((x1 - x0) * i) / (type.divisionsX + 1)
    box('frame', mapX(x - bar / 2), y0, mapX(x + bar / 2), y1, z, 0.035)
  }
  for (let i = 1; i <= type.divisionsY; i++) {
    const y = y0 + ((y1 - y0) * i) / (type.divisionsY + 1)
    box('frame', mapX(x0), y - bar / 2, mapX(x1), y + bar / 2, z, 0.035)
  }
}
