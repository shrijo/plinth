import {
  add,
  dist,
  dot,
  fromAngle,
  intersectLines,
  midpoint,
  projectOnSegment,
  scale,
  sub,
  type Vec2,
} from './math.ts'
import type { Id } from './model.ts'

/**
 * Snapping turns a raw cursor position into a precise point. Targets, from
 * strongest to weakest: existing nodes, wall midpoints, crossings of two
 * guide lines, a single guide line (a wall, an angle from the last point,
 * or an alignment with an existing node), and finally the grid.
 */

export interface SnapSettings {
  enabled: boolean
  grid: boolean
  /** Grid spacing in metres. */
  gridSize: number
  /** Angle step for lines from the last point, in degrees. */
  angleStep: number
  /** Alignment guides through existing nodes. */
  guides: boolean
  /** Lengths along an angle guide round to this many metres. */
  lengthStep: number
}

export const DEFAULT_SNAP_SETTINGS: SnapSettings = {
  enabled: true,
  grid: true,
  gridSize: 0.25,
  angleStep: 15,
  guides: true,
  lengthStep: 0.05,
}

export interface SnapSegment {
  wallId: Id
  a: Vec2
  b: Vec2
}

export interface SnapContext {
  /** Points that can be snapped to, such as the active level's nodes. */
  points: readonly { id: Id; x: number; y: number }[]
  /** Wall centre lines that can be snapped to. */
  segments: readonly SnapSegment[]
  /** The last placed point while drawing; angle guides start here. */
  anchor?: Vec2 | null
  /** Extra points that create alignment guides, such as the start of the current chain. */
  guidePoints?: readonly Vec2[]
  settings: SnapSettings
  /** Snap distance in metres (usually a fixed number of screen pixels). */
  tolerance: number
}

export type SnapKind =
  | 'node'
  | 'midpoint'
  | 'intersection'
  | 'wall'
  | 'angle'
  | 'guide'
  | 'grid'
  | 'free'

export type GuideKind = 'x' | 'y' | 'angle' | 'extension'

export interface SnapGuide {
  kind: GuideKind
  from: Vec2
  to: Vec2
}

export interface SnapResult {
  point: Vec2
  kind: SnapKind
  /** Set when the point is an existing node. */
  nodeId?: Id
  /** Set when the point lies on a wall (including its midpoint). */
  wallId?: Id
  /** Lines to draw so the user sees why the point snapped. */
  guides: SnapGuide[]
}

type Line =
  | { kind: 'wall'; origin: Vec2; dir: Vec2; segment: SnapSegment }
  | { kind: 'angle'; origin: Vec2; dir: Vec2; ray: true }
  | { kind: 'guide'; origin: Vec2; dir: Vec2; guide: GuideKind }

const X_AXIS: Vec2 = { x: 1, y: 0 }
const Y_AXIS: Vec2 = { x: 0, y: 1 }

export function snap(cursor: Vec2, ctx: SnapContext): SnapResult {
  const { settings, tolerance } = ctx
  if (!settings.enabled) return { point: cursor, kind: 'free', guides: [] }

  // 1. Existing nodes.
  let bestNode: { id: Id; x: number; y: number } | undefined
  let bestNodeDistance = tolerance
  for (const p of ctx.points) {
    const d = dist(p, cursor)
    if (d < bestNodeDistance) {
      bestNode = p
      bestNodeDistance = d
    }
  }
  if (bestNode) {
    const point = { x: bestNode.x, y: bestNode.y }
    return { point, kind: 'node', nodeId: bestNode.id, guides: anchorGuide(ctx.anchor, point) }
  }

  // 2. Wall midpoints.
  for (const segment of ctx.segments) {
    const m = midpoint(segment.a, segment.b)
    if (dist(m, cursor) < tolerance * 0.75) {
      return { point: m, kind: 'midpoint', wallId: segment.wallId, guides: anchorGuide(ctx.anchor, m) }
    }
  }

  // 3. Lines near the cursor.
  const lineTolerance = tolerance * 0.75
  const near = nearLines(cursor, ctx, lineTolerance)

  if (near.length >= 2) {
    let best: { point: Vec2; lines: [Line, Line] } | undefined
    let bestDistance = tolerance
    for (let i = 0; i < near.length; i++) {
      for (let j = i + 1; j < near.length; j++) {
        const l1 = near[i]!
        const l2 = near[j]!
        const hit = intersectLines(l1.origin, l1.dir, l2.origin, l2.dir)
        if (!hit || !withinLine(l1, hit.t) || !withinLine(l2, hit.u)) continue
        const d = dist(hit.point, cursor)
        if (d < bestDistance) {
          best = { point: hit.point, lines: [l1, l2] }
          bestDistance = d
        }
      }
    }
    if (best) {
      const wallLine = best.lines.find((l) => l.kind === 'wall')
      return {
        point: best.point,
        kind: 'intersection',
        wallId: wallLine?.kind === 'wall' ? wallLine.segment.wallId : undefined,
        guides: best.lines.flatMap((l) => guideFor(l, best.point)),
      }
    }
  }

  const first = near[0]
  if (first) {
    const s = dot(sub(cursor, first.origin), first.dir)
    if (first.kind === 'wall') {
      const point = add(first.origin, scale(first.dir, s))
      return {
        point,
        kind: 'wall',
        wallId: first.segment.wallId,
        guides: anchorGuide(ctx.anchor, point),
      }
    }
    if (first.kind === 'angle') {
      const stepped = settings.grid && settings.lengthStep > 0
        ? Math.round(s / settings.lengthStep) * settings.lengthStep
        : s
      const point = add(first.origin, scale(first.dir, stepped))
      return { point, kind: 'angle', guides: guideFor(first, point) }
    }
    const point = add(first.origin, scale(first.dir, s))
    return { point, kind: 'guide', guides: guideFor(first, point) }
  }

  // 4. Grid.
  if (settings.grid && settings.gridSize > 0) {
    const g = settings.gridSize
    const point = { x: Math.round(cursor.x / g) * g, y: Math.round(cursor.y / g) * g }
    return { point, kind: 'grid', guides: [] }
  }

  return { point: cursor, kind: 'free', guides: [] }
}

/** Lines within `tolerance` of the cursor, nearest first. */
function nearLines(cursor: Vec2, ctx: SnapContext, tolerance: number): Line[] {
  const found: { line: Line; distance: number }[] = []

  for (const segment of ctx.segments) {
    const { distance, t } = projectOnSegment(cursor, segment.a, segment.b)
    if (distance < tolerance && t > 0 && t < 1) {
      const length = dist(segment.a, segment.b)
      const dir = scale(sub(segment.b, segment.a), 1 / length)
      // Walls win ties against guides: they are what users aim at most.
      found.push({ line: { kind: 'wall', origin: segment.a, dir, segment }, distance: distance * 0.8 })
    }
  }

  const anchor = ctx.anchor
  if (anchor && ctx.settings.angleStep > 0) {
    const offset = sub(cursor, anchor)
    const length = Math.hypot(offset.x, offset.y)
    if (length > tolerance) {
      const step = (ctx.settings.angleStep * Math.PI) / 180
      const angle = Math.round(Math.atan2(offset.y, offset.x) / step) * step
      const dir = fromAngle(angle)
      const along = dot(offset, dir)
      const distance = Math.abs(offset.x * dir.y - offset.y * dir.x)
      if (along > 0 && distance < tolerance) {
        found.push({ line: { kind: 'angle', origin: anchor, dir, ray: true }, distance })
      }
    }
  }

  if (ctx.settings.guides) {
    const sources: Vec2[] = [...ctx.points, ...(ctx.guidePoints ?? [])]
    for (const p of sources) {
      if (anchor && dist(p, anchor) < 1e-9) continue // covered by the angle guide
      const dx = Math.abs(cursor.x - p.x)
      const dy = Math.abs(cursor.y - p.y)
      // Horizontal line through p (y fixed) and vertical line (x fixed).
      if (dy < tolerance && dx > tolerance) {
        found.push({ line: { kind: 'guide', origin: p, dir: X_AXIS, guide: 'x' }, distance: dy })
      }
      if (dx < tolerance && dy > tolerance) {
        found.push({ line: { kind: 'guide', origin: p, dir: Y_AXIS, guide: 'y' }, distance: dx })
      }
    }
    // Extensions of walls beyond their ends.
    for (const segment of ctx.segments) {
      const length = dist(segment.a, segment.b)
      if (length === 0) continue
      const dir = scale(sub(segment.b, segment.a), 1 / length)
      const s = dot(sub(cursor, segment.a), dir)
      if (s >= 0 && s <= length) continue
      const origin = s < 0 ? segment.a : segment.b
      const foot = add(segment.a, scale(dir, s))
      const distance = dist(foot, cursor)
      if (distance < tolerance) {
        found.push({ line: { kind: 'guide', origin, dir, guide: 'extension' }, distance })
      }
    }
  }

  found.sort((p, q) => p.distance - q.distance)
  return found.map((f) => f.line)
}

/** Whether position `t` along a line lies on its usable part. */
function withinLine(line: Line, t: number): boolean {
  if (line.kind === 'wall') {
    const length = dist(line.segment.a, line.segment.b)
    return t >= 0 && t <= length
  }
  if (line.kind === 'angle') return t > 0
  return true
}

function guideFor(line: Line, point: Vec2): SnapGuide[] {
  if (line.kind === 'wall') return []
  if (line.kind === 'angle') {
    const kind: GuideKind =
      Math.abs(line.dir.y) < 1e-9 ? 'x' : Math.abs(line.dir.x) < 1e-9 ? 'y' : 'angle'
    return [{ kind, from: line.origin, to: point }]
  }
  return [{ kind: line.guide, from: line.origin, to: point }]
}

function anchorGuide(anchor: Vec2 | null | undefined, point: Vec2): SnapGuide[] {
  if (!anchor) return []
  const d = sub(point, anchor)
  if (Math.abs(d.y) < 1e-6 && Math.abs(d.x) > 1e-6) return [{ kind: 'x', from: anchor, to: point }]
  if (Math.abs(d.x) < 1e-6 && Math.abs(d.y) > 1e-6) return [{ kind: 'y', from: anchor, to: point }]
  return []
}
