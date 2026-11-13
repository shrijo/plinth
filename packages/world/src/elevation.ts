import type { Street, StreetNode, Vec2 } from '@plinth/core'

/**
 * How high streets run where they leave the ground: a bridge's deck from
 * one landing to the other, clear of the water, the streets and the
 * railways it crosses, and the ramps that lift the streets leading up to
 * it. Worked out on the street network: every bridge is a structure (the
 * bridge streets joined end to end), level between its landings unless
 * something under it needs more room; what it needs is passed on along
 * the network at no more than a road's gradient, so the rise starts back
 * down the street, as a real approach does.
 */

/** A street's steepest ramp up to a bridge (rise over run). */
const GRADIENT = 0.07
/** A deck's top stands at least this far over water (metres); over land, it's never under the ground. */
const OVER_WATER = 2.2
/** A bridge's heights are worked out this often along it (metres). */
const STATION = 5

export interface ElevationInput {
  nodes: Record<string, StreetNode>
  streets: Record<string, Street>
  /** The street bed's height at a point of the plan (metres above sea level). */
  bed: (x: number, y: number) => number
  /** The water's surface at a point, or null on land. */
  water: (x: number, y: number) => number | null
  /** Half the width of a street's road (for what passes under it), by its id. */
  half: (street: Street) => number
  /** Lines on the ground that aren't streets of the network but need room under a bridge all the same (railways, paths). */
  under?: readonly Passing[]
  /** Bridges that aren't streets of the network (railways, footbridges): each gets a deck of its own. */
  spans?: readonly SpanInput[]
}

/** Something a bridge passes over. */
export interface Passing {
  points: readonly Vec2[]
  level: number
  half: number
  /** How far a deck's top must stand over it (metres). */
  clearance: number
}

export interface SpanInput {
  points: readonly Vec2[]
  level: number
  /** How steeply it may climb from its landings (rise over run): a footbridge has steps, a railway a viaduct behind it. */
  gradient: number
}

/** A bridge of the network: its streets, and its landings. */
export interface Structure {
  level: number
  streets: string[]
  /** The nodes where it meets streets on the ground. */
  landings: string[]
}

export interface Elevation {
  /** A street's height along it (metres from its first node): the bed and any rise for one on the ground, the deck for a bridge. */
  heightOf(id: string): (along: number) => number
  /** How far a street on the ground is lifted over its bed at its two ends (0 for nearly all). */
  riseOf(id: string): [number, number]
  /** The bridges, and which each bridge street belongs to (its index). */
  structures: Structure[]
  structureOf: Map<string, number>
  /** The heights along each span given (see ElevationInput.spans), a distance along it from its first point. */
  spans: ((along: number) => number)[]
}

/** How far a deck's top must stand over a street on the ground, a railway and a path (metres): headroom and the deck's own depth. */
export const CLEARANCE = { street: 5.6, rail: 7, path: 3.6 }

interface Edge {
  id: string
  a: string
  b: string
  length: number
  level: number
  ax: number
  ay: number
  bx: number
  by: number
}

/** Where two segments cross, as fractions along each, or null. */
function crossing(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): { t: number; u: number; sine: number } | null {
  const rx = bx - ax
  const ry = by - ay
  const sx = dx - cx
  const sy = dy - cy
  const den = rx * sy - ry * sx
  const lr = Math.hypot(rx, ry)
  const ls = Math.hypot(sx, sy)
  if (lr === 0 || ls === 0 || Math.abs(den) < 1e-9 * lr * ls) return null
  const t = ((cx - ax) * sy - (cy - ay) * sx) / den
  const u = ((cx - ax) * ry - (cy - ay) * rx) / den
  if (t < 0 || t > 1 || u < 0 || u > 1) return null
  return { t, u, sine: Math.abs(den) / (lr * ls) }
}

const CELL = 40
const cellKey = (x: number, y: number) => (Math.floor(y / CELL) + 65536) * 131072 + Math.floor(x / CELL) + 65536

/** Segments by the grid cells they pass through. */
class SegmentGrid<T extends { ax: number; ay: number; bx: number; by: number }> {
  private readonly cells = new Map<number, T[]>()

  add(segment: T): void {
    const x0 = Math.floor(Math.min(segment.ax, segment.bx) / CELL)
    const x1 = Math.floor(Math.max(segment.ax, segment.bx) / CELL)
    const y0 = Math.floor(Math.min(segment.ay, segment.by) / CELL)
    const y1 = Math.floor(Math.max(segment.ay, segment.by) / CELL)
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const key = (y + 65536) * 131072 + x + 65536
        const list = this.cells.get(key)
        if (list) list.push(segment)
        else this.cells.set(key, [segment])
      }
    }
  }

  /** The segments whose cells a segment passes through (each once). */
  near(ax: number, ay: number, bx: number, by: number): Set<T> {
    const found = new Set<T>()
    const x0 = Math.floor(Math.min(ax, bx) / CELL)
    const x1 = Math.floor(Math.max(ax, bx) / CELL)
    const y0 = Math.floor(Math.min(ay, by) / CELL)
    const y1 = Math.floor(Math.max(ay, by) / CELL)
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) for (const s of this.cells.get(cellKey(x * CELL, y * CELL)) ?? []) found.add(s)
    }
    return found
  }
}

/** Heights at points a fixed step apart along a line, taken straight between. */
function sampled(values: Float64Array, length: number): (along: number) => number {
  const count = values.length - 1
  return (along) => {
    if (count <= 0) return values[0] ?? 0
    const f = Math.min(Math.max((along / length) * count, 0), count)
    const k = Math.min(Math.floor(f), count - 1)
    return values[k]! + (values[k + 1]! - values[k]!) * (f - k)
  }
}

export function solveElevation(input: ElevationInput): Elevation {
  const { nodes, streets, bed, water } = input
  const edges: Edge[] = []
  const at = new Map<string, Edge[]>()
  for (const street of Object.values(streets)) {
    const a = nodes[street.a]
    const b = nodes[street.b]
    if (!a || !b) continue
    const length = Math.hypot(b.x - a.x, b.y - a.y)
    if (length < 1e-6) continue
    const edge: Edge = { id: street.id, a: street.a, b: street.b, length, level: street.level ?? 0, ax: a.x, ay: a.y, bx: b.x, by: b.y }
    edges.push(edge)
    for (const end of [street.a, street.b]) {
      const list = at.get(end)
      if (list) list.push(edge)
      else at.set(end, [edge])
    }
  }
  const edgeOf = new Map(edges.map((edge) => [edge.id, edge]))
  const bridges = edges.filter((e) => e.level !== 0)
  const spansGiven = input.spans ?? []
  const groundBed = (edge: Edge) => {
    const count = Math.max(1, Math.ceil(edge.length / 4))
    const known = new Float64Array(count + 1).fill(NaN)
    return (along: number): number => {
      const f = Math.min(Math.max((along / edge.length) * count, 0), count)
      const k = Math.min(Math.floor(f), count - 1)
      const station = (i: number) => {
        let h = known[i]!
        if (h !== h) {
          const t = i / count
          h = bed(edge.ax + (edge.bx - edge.ax) * t, edge.ay + (edge.by - edge.ay) * t)
          known[i] = h
        }
        return h
      }
      const h0 = station(k)
      return h0 + (station(k + 1) - h0) * (f - k)
    }
  }
  // Nothing leaves the ground: every street is on its bed.
  if (bridges.length === 0 && spansGiven.length === 0) {
    const beds = new Map<string, (along: number) => number>()
    for (const edge of edges) beds.set(edge.id, groundBed(edge))
    return { heightOf: (id) => beds.get(id) ?? (() => 0), riseOf: () => [0, 0], structures: [], structureOf: new Map(), spans: [] }
  }

  // Structures: bridge streets of one level joined at their nodes.
  const structureOf = new Map<string, number>()
  const structures: Structure[] = []
  for (const start of bridges) {
    if (structureOf.has(start.id)) continue
    const index = structures.length
    const structure: Structure = { level: start.level, streets: [], landings: [] }
    structures.push(structure)
    const queue = [start]
    structureOf.set(start.id, index)
    const landings = new Set<string>()
    while (queue.length > 0) {
      const edge = queue.pop()!
      structure.streets.push(edge.id)
      for (const end of [edge.a, edge.b]) {
        const meeting = at.get(end) ?? []
        if (meeting.some((o) => o.level === 0)) landings.add(end)
        for (const other of meeting) {
          if (other.level !== start.level || structureOf.has(other.id)) continue
          structureOf.set(other.id, index)
          queue.push(other)
        }
      }
    }
    structure.landings = [...landings]
  }

  // What lies under: the network's streets and the lines given, by level, to find what each bridge crosses.
  interface Below {
    ax: number
    ay: number
    bx: number
    by: number
    level: number
    half: number
    clearance: number
    /** The height of its surface a fraction of the way along. */
    top: (t: number) => number
  }
  const below = new SegmentGrid<Below>()
  const addBelow = (points: readonly Vec2[], level: number, half: number, clearance: number, top?: (index: number, t: number) => number) => {
    for (let i = 0; i + 1 < points.length; i++) {
      const p = points[i]!
      const q = points[i + 1]!
      below.add({ ax: p.x, ay: p.y, bx: q.x, by: q.y, level, half, clearance, top: top ? (t) => top(i, t) : (t) => bed(p.x + (q.x - p.x) * t, p.y + (q.y - p.y) * t) })
    }
  }
  for (const edge of edges) {
    if (edge.level !== 0) continue
    addBelow([{ x: edge.ax, y: edge.ay }, { x: edge.bx, y: edge.by }], 0, input.half(streets[edge.id]!), CLEARANCE.street)
  }
  for (const line of input.under ?? []) addBelow(line.points, line.level, line.half, line.clearance)

  /** What a deck's top needs at a point of a line on a level, from what lies under it there: water, the land, what it crosses. */
  const needsAlong = (points: readonly Vec2[], level: number, lengths: number[], stationAt: (along: number) => { x: number; y: number }, count: number, total: number): Float64Array => {
    const need = new Float64Array(count + 1)
    for (let k = 0; k <= count; k++) {
      const p = stationAt((k / count) * total)
      const surface = water(p.x, p.y)
      need[k] = surface !== null ? surface + OVER_WATER : bed(p.x, p.y)
    }
    let walked = 0
    for (let i = 0; i + 1 < points.length; i++) {
      const p = points[i]!
      const q = points[i + 1]!
      for (const other of below.near(p.x, p.y, q.x, q.y)) {
        if (other.level >= level) continue
        const hit = crossing(p.x, p.y, q.x, q.y, other.ax, other.ay, other.bx, other.by)
        if (!hit) continue
        const where = walked + hit.t * lengths[i]!
        // Not what meets it at its own ends (the street it lands on isn't under it).
        if (where < 0.75 || total - where < 0.75) continue
        // Over the whole width of what it crosses (wider seen at a slant), and a little more.
        const reach = (other.half + 1.5) / Math.max(hit.sine, 0.35)
        const height = other.top(hit.u) + other.clearance
        const from = Math.max(0, Math.floor(((where - reach) / total) * count))
        const to = Math.min(count, Math.ceil(((where + reach) / total) * count))
        for (let k = from; k <= to; k++) if (height > need[k]!) need[k] = height
      }
      walked += lengths[i]!
    }
    return need
  }

  // The bridges' own heights, the lowest level first (a higher bridge clears the lower one's deck).
  const nodeBed = new Map<string, number>()
  const bedOf = (id: string) => {
    let h = nodeBed.get(id)
    if (h === undefined) {
      const node = nodes[id]!
      h = bed(node.x, node.y)
      nodeBed.set(id, h)
    }
    return h
  }
  /** How far each node is lifted over its base, and each bridge street's stations. */
  const rise = new Map<string, number>()
  const decks = new Map<string, { base: Float64Array; need: Float64Array; rise: Float64Array }>()
  const baseAt = new Map<string, number>()
  const byLevel = [...structures.keys()].sort((a, b) => structures[a]!.level - structures[b]!.level)
  for (const index of byLevel) {
    const structure = structures[index]!
    const own = structure.streets.map((id) => edgeOf.get(id)!)
    const ownNodes = new Set<string>()
    for (const edge of own) {
      ownNodes.add(edge.a)
      ownNodes.add(edge.b)
    }
    // Level between its landings: each node between them takes the mean of its neighbours by nearness, the
    // landings held at the ground (so a bridge of one street runs straight from bank to bank).
    const landing = new Set(structure.landings)
    for (const id of ownNodes) baseAt.set(id, bedOf(id))
    if (landing.size > 0) {
      for (let pass = 0; pass < 400; pass++) {
        let moved = 0
        for (const id of ownNodes) {
          if (landing.has(id)) continue
          let sum = 0
          let weight = 0
          for (const edge of at.get(id) ?? []) {
            if (structureOf.get(edge.id) !== index) continue
            const other = edge.a === id ? edge.b : edge.a
            sum += baseAt.get(other)! / edge.length
            weight += 1 / edge.length
          }
          if (weight === 0) continue
          const next = sum / weight
          moved = Math.max(moved, Math.abs(next - baseAt.get(id)!))
          baseAt.set(id, next)
        }
        if (moved < 0.002) break
      }
    }
    for (const edge of own) {
      const count = Math.max(1, Math.ceil(edge.length / STATION))
      const base = new Float64Array(count + 1)
      const from = baseAt.get(edge.a)!
      const to = baseAt.get(edge.b)!
      for (let k = 0; k <= count; k++) base[k] = from + ((to - from) * k) / count
      const need = needsAlong(
        [{ x: edge.ax, y: edge.ay }, { x: edge.bx, y: edge.by }],
        edge.level,
        [edge.length],
        (along) => ({ x: edge.ax + ((edge.bx - edge.ax) * along) / edge.length, y: edge.ay + ((edge.by - edge.ay) * along) / edge.length }),
        count,
        edge.length,
      )
      // At a landing the deck is the street, on the ground.
      for (const [end, k] of [[edge.a, 0], [edge.b, count]] as const) if (landing.has(end)) need[k] = base[k]!
      decks.set(edge.id, { base, need, rise: new Float64Array(count + 1) })
    }
    // What's needed over the base, passed along the network at a road's gradient (see below), for this
    // structure and the streets round it; then the deck is known, for whatever crosses over it.
    spread(own)
    for (const edge of own) {
      const deck = decks.get(edge.id)!
      const count = deck.base.length - 1
      addBelow(
        [{ x: edge.ax, y: edge.ay }, { x: edge.bx, y: edge.by }],
        edge.level,
        input.half(streets[edge.id]!),
        CLEARANCE.street,
        (_, t) => {
          const f = Math.min(Math.max(t * count, 0), count)
          const k = Math.min(Math.floor(f), count - 1)
          const h = (i: number) => deck.base[i]! + deck.rise[i]!
          return count === 0 ? h(0) : h(k) + (h(k + 1) - h(k)) * (f - k)
        },
      )
    }
  }

  /**
   * Lifts decks to what they need, and passes the lift on: along each deck and out along the streets at its
   * landings, falling off at a road's gradient, so nothing is steeper than a street can be. A node's rise is
   * the most that reaches it.
   */
  function spread(own: Edge[]): void {
    let any = false
    for (const edge of own) {
      const deck = decks.get(edge.id)!
      for (let k = 0; k < deck.base.length; k++) {
        const excess = deck.need[k]! - deck.base[k]!
        if (excess > deck.rise[k]!) {
          deck.rise[k] = excess
          any = true
        }
      }
    }
    if (!any) return
    // Along the decks, back and forth, and through the nodes they share, until nothing changes.
    const touched = new Set<string>()
    for (let pass = 0; pass < 200; pass++) {
      let moved = false
      for (const edge of own) {
        const deck = decks.get(edge.id)!
        const count = deck.rise.length - 1
        const step = edge.length / count
        const ra = rise.get(edge.a) ?? 0
        const rb = rise.get(edge.b) ?? 0
        if (ra > deck.rise[0]!) deck.rise[0] = ra
        if (rb > deck.rise[count]!) deck.rise[count] = rb
        for (let k = 1; k <= count; k++) deck.rise[k] = Math.max(deck.rise[k]!, deck.rise[k - 1]! - GRADIENT * step)
        for (let k = count - 1; k >= 0; k--) deck.rise[k] = Math.max(deck.rise[k]!, deck.rise[k + 1]! - GRADIENT * step)
        if (deck.rise[0]! > ra + 1e-6) {
          rise.set(edge.a, deck.rise[0]!)
          touched.add(edge.a)
          moved = true
        }
        if (deck.rise[count]! > rb + 1e-6) {
          rise.set(edge.b, deck.rise[count]!)
          touched.add(edge.b)
          moved = true
        }
      }
      if (!moved) break
    }
    // Out along the streets on the ground, from every node lifted.
    const queue = [...touched]
    while (queue.length > 0) {
      const id = queue.pop()!
      const here = rise.get(id) ?? 0
      for (const edge of at.get(id) ?? []) {
        if (edge.level !== 0) continue
        const other = edge.a === id ? edge.b : edge.a
        const passed = here - GRADIENT * edge.length
        if (passed > (rise.get(other) ?? 0) + 1e-6) {
          rise.set(other, passed)
          queue.push(other)
        }
      }
    }
    // The crest and the foot of each rise rounded off, as a road's vertical curves are (never below what's needed).
    for (const edge of own) {
      const deck = decks.get(edge.id)!
      const count = deck.rise.length - 1
      for (let pass = 0; pass < 3 && count >= 2; pass++) {
        let before = deck.rise[0]!
        for (let k = 1; k < count; k++) {
          const smooth = (before + 2 * deck.rise[k]! + deck.rise[k + 1]!) / 4
          before = deck.rise[k]!
          deck.rise[k] = Math.max(smooth, deck.need[k]! - deck.base[k]!, 0)
        }
      }
    }
  }

  // Each street's height along it.
  const heights = new Map<string, (along: number) => number>()
  const rises = new Map<string, [number, number]>()
  for (const edge of edges) {
    const deck = decks.get(edge.id)
    if (deck) {
      const values = new Float64Array(deck.base.length)
      for (let k = 0; k < values.length; k++) values[k] = deck.base[k]! + deck.rise[k]!
      heights.set(edge.id, sampled(values, edge.length))
      continue
    }
    const onBed = groundBed(edge)
    const ra = rise.get(edge.a) ?? 0
    const rb = rise.get(edge.b) ?? 0
    if (ra <= 0 && rb <= 0) {
      heights.set(edge.id, onBed)
      continue
    }
    rises.set(edge.id, [ra, rb])
    heights.set(edge.id, (along) => onBed(along) + Math.max(0, ra - GRADIENT * along, rb - GRADIENT * (edge.length - along)))
  }

  // Spans: each from its landings on the ground, lifted where it must clear something, as steeply as it may.
  const spans = spansGiven.map((span) => {
    const lengths: number[] = []
    let total = 0
    for (let i = 0; i + 1 < span.points.length; i++) {
      const l = Math.hypot(span.points[i + 1]!.x - span.points[i]!.x, span.points[i + 1]!.y - span.points[i]!.y)
      lengths.push(l)
      total += l
    }
    if (total < 1e-6) return () => 0
    const pointAt = (along: number) => {
      let left = along
      for (let i = 0; i < lengths.length; i++) {
        if (left <= lengths[i]! || i === lengths.length - 1) {
          const t = lengths[i]! > 0 ? Math.min(Math.max(left / lengths[i]!, 0), 1) : 0
          const p = span.points[i]!
          const q = span.points[i + 1]!
          return { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t }
        }
        left -= lengths[i]!
      }
      return span.points[0]!
    }
    const count = Math.max(1, Math.ceil(total / STATION))
    const first = span.points[0]!
    const last = span.points[span.points.length - 1]!
    const from = bed(first.x, first.y)
    const to = bed(last.x, last.y)
    const need = needsAlong(span.points, span.level, lengths, pointAt, count, total)
    // Its ends rest on the ground, unless something passes right under them.
    if (need[0]! - from <= OVER_WATER + 0.5) need[0] = from
    if (need[count]! - to <= OVER_WATER + 0.5) need[count] = to
    const values = new Float64Array(count + 1)
    for (let k = 0; k <= count; k++) values[k] = Math.max(from + ((to - from) * k) / count, need[k]!)
    const step = total / count
    for (let k = 1; k <= count; k++) values[k] = Math.max(values[k]!, values[k - 1]! - span.gradient * step)
    for (let k = count - 1; k >= 0; k--) values[k] = Math.max(values[k]!, values[k + 1]! - span.gradient * step)
    return sampled(values, total)
  })

  return {
    heightOf: (id) => heights.get(id) ?? (() => 0),
    riseOf: (id) => rises.get(id) ?? [0, 0],
    structures,
    structureOf,
    spans,
  }
}
