import { add, cross, dist, dot, normalize, perpLeft, scale, signedArea2, sub, type Vec2 } from '../math.ts'
import { fromRing, type PolygonRings } from './regions.ts'

/**
 * The straight skeleton of a polygon (with holes): what is left of it as
 * its edges move inwards at the same speed, each staying parallel to
 * itself. Seen as a landscape whose height is the time each point is
 * reached, it is a hip roof with the same pitch on every side; each edge
 * sweeps out one face of it.
 *
 * The wavefront shrinks by two kinds of events (Felkel and Obdržálek): an
 * edge shrinks to nothing and its neighbours meet (edge event), or a
 * reflex corner runs into an edge on the far side and splits the
 * wavefront in two (split event). Events are handled in order of time;
 * corners created by an event get their own events.
 */

/** A point of a face: where it is in plan, and when the wavefront got there (its distance in from the outline). */
export interface SkeletonPoint {
  x: number
  y: number
  t: number
}

/** The face swept by one edge of the polygon: the edge itself, then the skeleton back to its start. */
export interface SkeletonFace {
  /** The edge's ends. */
  a: Vec2
  b: Vec2
  /** The face's outline, counter-clockwise from the edge's start. */
  points: SkeletonPoint[]
}

interface Edge {
  a: Vec2
  b: Vec2
  dir: Vec2
  /** Towards the inside of the polygon. */
  normal: Vec2
}

interface Node {
  p: Vec2
  t: number
}

interface Vertex {
  /** Where it was at time t0. */
  p: Vec2
  t0: number
  /** The edge coming in, and the one going out. */
  left: Edge
  right: Edge
  /** How fast it moves (null when its edges face each other and it can't). */
  bisector: Vec2 | null
  reflex: boolean
  prev: Vertex
  next: Vertex
  active: boolean
  node: Node
}

interface Arc {
  from: Node
  to: Node
  edges: [Edge, Edge]
}

type Event =
  | { kind: 'edge'; t: number; a: Vertex; b: Vertex }
  | { kind: 'split'; t: number; v: Vertex; edge: Edge; at: Vec2 }

/** Faces of a polygon's straight skeleton, or null for a polygon it can't do (or that is degenerate). */
export function straightSkeleton(polygon: PolygonRings): SkeletonFace[] | null {
  const rings = polygon.map((ring, i) => tidy(fromRing(ring), i === 0)).filter((ring) => ring.length >= 3)
  if (rings.length === 0 || rings[0]!.length < 3) return null
  const size = Math.max(...rings[0]!.map((p) => Math.hypot(p.x - rings[0]![0]!.x, p.y - rings[0]![0]!.y)), 1)
  const eps = size * 1e-9

  const edges: Edge[] = []
  const vertices: Vertex[] = []
  const arcs: Arc[] = []
  const heap = new EventHeap()

  // One loop of vertices per ring; every ring runs with the inside on its left.
  for (const ring of rings) {
    const ringEdges = ring.map((a, i) => {
      const b = ring[(i + 1) % ring.length]!
      const dir = normalize(sub(b, a))
      return { a, b, dir, normal: perpLeft(dir) }
    })
    edges.push(...ringEdges)
    const loop = ring.map((p, i) => makeVertex(p, 0, ringEdges[(i - 1 + ring.length) % ring.length]!, ringEdges[i]!, { p, t: 0 }))
    loop.forEach((v, i) => {
      v.prev = loop[(i - 1 + loop.length) % loop.length]!
      v.next = loop[(i + 1) % loop.length]!
    })
    vertices.push(...loop)
  }
  const corners = [...vertices]

  const position = (v: Vertex, t: number): Vec2 => (v.bisector ? add(v.p, scale(v.bisector, t - v.t0)) : v.p)

  const edgeEvent = (a: Vertex, b: Vertex) => {
    if (!a.bisector || !b.bisector) return
    const dir = a.right.dir
    const along = dot(sub(sub(b.p, scale(b.bisector, b.t0)), sub(a.p, scale(a.bisector, a.t0))), dir)
    const closing = dot(sub(b.bisector, a.bisector), dir)
    if (closing > -1e-12) {
      // Not closing in: only an event if the edge is already gone.
      if (Math.abs(dot(sub(position(b, Math.max(a.t0, b.t0)), position(a, Math.max(a.t0, b.t0))), dir)) < eps) {
        heap.push({ kind: 'edge', t: Math.max(a.t0, b.t0), a, b })
      }
      return
    }
    const t = -along / closing
    if (!Number.isFinite(t) || t < Math.max(a.t0, b.t0) - eps) return
    heap.push({ kind: 'edge', t: Math.max(t, a.t0, b.t0), a, b })
  }

  const splitEvents = (v: Vertex) => {
    if (!v.reflex || !v.bisector) return
    for (const edge of edges) {
      if (edge === v.left || edge === v.right) continue
      const approach = 1 - dot(v.bisector, edge.normal)
      if (approach < 1e-12) continue
      const t = (dot(sub(v.p, edge.a), edge.normal) - dot(v.bisector, edge.normal) * v.t0) / approach
      if (!Number.isFinite(t) || t < v.t0 + eps) continue
      heap.push({ kind: 'split', t, v, edge, at: position(v, t) })
    }
  }

  const eventsOf = (v: Vertex) => {
    edgeEvent(v.prev, v)
    edgeEvent(v, v.next)
    splitEvents(v)
  }

  for (const v of vertices) {
    edgeEvent(v, v.next)
    splitEvents(v)
  }

  // A loop down to two corners closes up into a line between them.
  const closeIfDone = (v: Vertex): boolean => {
    if (!v.active) return true
    if (v.next === v) {
      v.active = false
      return true
    }
    if (v.next.next === v) {
      const other = v.next
      arcs.push({ from: other.node, to: v.node, edges: [other.left, other.right] })
      v.active = false
      other.active = false
      return true
    }
    return false
  }

  let guard = 0
  const limit = 50 * (edges.length + 4) ** 2
  for (let event = heap.pop(); event; event = heap.pop()) {
    if (++guard > limit) return null
    if (event.kind === 'edge') {
      const { a, b, t } = event
      if (!a.active || !b.active || a.next !== b) continue
      const at = scale(add(position(a, t), position(b, t)), 0.5)
      const node: Node = { p: at, t }
      arcs.push({ from: a.node, to: node, edges: [a.left, a.right] })
      arcs.push({ from: b.node, to: node, edges: [b.left, b.right] })
      a.active = false
      b.active = false
      if (b.next === a) continue
      if (a.prev === b.next) {
        // The last three corners meet at one point.
        const c = a.prev
        arcs.push({ from: c.node, to: node, edges: [c.left, c.right] })
        c.active = false
        continue
      }
      const w = makeVertex(at, t, a.left, b.right, node)
      w.prev = a.prev
      w.next = b.next
      a.prev.next = w
      b.next.prev = w
      vertices.push(w)
      if (!closeIfDone(w)) eventsOf(w)
    } else {
      const { v, edge, t, at } = event
      if (!v.active) continue
      // The piece of the edge's wavefront the corner runs into, if it's still there.
      const x = vertices.find((x) => {
        if (!x.active || x.right !== edge || x === v || x.next === v) return false
        const from = dot(position(x, t), edge.dir)
        const to = dot(position(x.next, t), edge.dir)
        const s = dot(at, edge.dir)
        return s >= Math.min(from, to) - eps && s <= Math.max(from, to) + eps
      })
      if (!x) continue
      const node: Node = { p: at, t }
      arcs.push({ from: v.node, to: node, edges: [v.left, v.right] })
      const after = x.next
      const w1 = makeVertex(at, t, v.left, edge, node)
      const w2 = makeVertex(at, t, edge, v.right, node)
      w1.prev = v.prev
      w1.next = after
      v.prev.next = w1
      after.prev = w1
      w2.prev = x
      w2.next = v.next
      x.next = w2
      v.next.prev = w2
      v.active = false
      vertices.push(w1, w2)
      for (const w of [w1, w2]) if (!closeIfDone(w)) eventsOf(w)
    }
  }

  // Loops left over have collapsed to lines (their corners can't move, their edges face each
  // other): join their corners in order. If one hadn't really collapsed, the check below fails.
  for (const v of vertices) {
    if (!v.active) continue
    for (let u = v; u.active; u = u.next) {
      arcs.push({ from: u.node, to: u.next.node, edges: [u.right, u.right] })
      u.active = false
    }
  }

  const result = faces(edges, corners, arcs, eps)
  return result && checked(result, polygon, size) ? result : null
}

/**
 * Whether the faces are right: each lies on its edge's slope (every point's
 * time is its distance in from the edge's line) and together they cover
 * the polygon exactly once.
 */
function checked(faces: SkeletonFace[], polygon: PolygonRings, size: number): boolean {
  const tolerance = size * 1e-6
  let area = 0
  for (const face of faces) {
    const normal = perpLeft(normalize(sub(face.b, face.a)))
    for (const p of face.points) {
      if (Math.abs(dot(sub(p, face.a), normal) - p.t) > tolerance) return false
      if (p.t < -tolerance) return false
    }
    area += signedArea2(face.points) / 2
  }
  const expected = polygon.reduce((sum, ring, i) => {
    const a = Math.abs(signedArea2(fromRing(ring))) / 2
    return sum + (i === 0 ? a : -a)
  }, 0)
  return Math.abs(area - expected) <= Math.max(expected * 1e-6, tolerance)
}

function makeVertex(p: Vec2, t0: number, left: Edge, right: Edge, node: Node): Vertex {
  const denominator = 1 + dot(left.normal, right.normal)
  const bisector = denominator < 1e-9 ? null : scale(add(left.normal, right.normal), 1 / denominator)
  const v = { p, t0, left, right, bisector, reflex: cross(left.dir, right.dir) < -1e-12, active: true, node } as Vertex
  v.prev = v
  v.next = v
  return v
}

/** The ring without repeated points or straight-through corners, running counter-clockwise (outer) or clockwise (hole). */
function tidy(points: Vec2[], outer: boolean): Vec2[] {
  const ccw = signedArea2(points) > 0
  let ring = ccw === outer ? [...points] : [...points].reverse()
  for (let changed = true; changed && ring.length >= 3; ) {
    changed = false
    for (let i = 0; i < ring.length; i++) {
      const prev = ring[(i - 1 + ring.length) % ring.length]!
      const p = ring[i]!
      const next = ring[(i + 1) % ring.length]!
      const span = Math.max(dist(prev, next), 1e-9)
      if (dist(prev, p) < 1e-9 || Math.abs(cross(sub(p, prev), sub(next, p))) / span < 1e-7) {
        ring = ring.filter((_, k) => k !== i)
        changed = true
        break
      }
    }
  }
  return ring
}

/** Each edge's face: the edge, then the skeleton arcs that border it, back to the edge's start. */
function faces(edges: Edge[], corners: Vertex[], arcs: Arc[], eps: number): SkeletonFace[] | null {
  const startNode = new Map<Edge, Node>()
  const endNode = new Map<Edge, Node>()
  for (const v of corners) {
    startNode.set(v.right, v.node)
    endNode.set(v.left, v.node)
  }
  const result: SkeletonFace[] = []
  for (const edge of edges) {
    const start = startNode.get(edge)
    const end = endNode.get(edge)
    if (!start || !end) return null
    // The arcs bordering this face, as an undirected graph.
    const links = new Map<Node, Node[]>()
    const link = (a: Node, b: Node) => {
      const list = links.get(a)
      if (list) list.push(b)
      else links.set(a, [b])
    }
    for (const arc of arcs) {
      if (arc.edges[0] !== edge && arc.edges[1] !== edge) continue
      link(arc.from, arc.to)
      link(arc.to, arc.from)
    }
    // The path from the edge's end back to its start.
    const cameFrom = new Map<Node, Node | null>([[end, null]])
    const queue = [end]
    while (queue.length > 0 && !cameFrom.has(start)) {
      const node = queue.shift()!
      for (const next of links.get(node) ?? []) {
        if (cameFrom.has(next)) continue
        cameFrom.set(next, node)
        queue.push(next)
      }
    }
    if (!cameFrom.has(start)) return null
    const path: Node[] = []
    for (let node: Node | null = start; node; node = cameFrom.get(node) ?? null) path.push(node)
    // path runs start → … → end; the face runs start → end → (skeleton) → back.
    const points: SkeletonPoint[] = [{ x: start.p.x, y: start.p.y, t: 0 }]
    for (const node of [...path].reverse()) {
      const last = points.at(-1)!
      if (Math.hypot(node.p.x - last.x, node.p.y - last.y) < eps && Math.abs(node.t - last.t) < eps) continue
      points.push({ x: node.p.x, y: node.p.y, t: node.t })
    }
    if (points.length > 1) {
      const first = points[0]!
      const last = points.at(-1)!
      if (Math.hypot(first.x - last.x, first.y - last.y) < eps) points.pop()
    }
    result.push({ a: edge.a, b: edge.b, points })
  }
  return result
}

/** A binary min-heap of events by time; at the same time, edge events first. */
class EventHeap {
  private items: Event[] = []

  push(event: Event): void {
    const items = this.items
    items.push(event)
    for (let i = items.length - 1; i > 0; ) {
      const parent = (i - 1) >> 1
      if (!before(items[i]!, items[parent]!)) break
      ;[items[i], items[parent]] = [items[parent]!, items[i]!]
      i = parent
    }
  }

  pop(): Event | undefined {
    const items = this.items
    const top = items[0]
    const last = items.pop()
    if (items.length > 0 && last) {
      items[0] = last
      for (let i = 0; ; ) {
        const l = 2 * i + 1
        const r = l + 1
        let m = i
        if (l < items.length && before(items[l]!, items[m]!)) m = l
        if (r < items.length && before(items[r]!, items[m]!)) m = r
        if (m === i) break
        ;[items[i], items[m]] = [items[m]!, items[i]!]
        i = m
      }
    }
    return top
  }
}

function before(a: Event, b: Event): boolean {
  if (Math.abs(a.t - b.t) > 1e-9) return a.t < b.t
  return a.kind === 'edge' && b.kind === 'split'
}
