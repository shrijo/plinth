import { DEFAULT_STREET, type Street, type StreetNode, type StreetProps, type Vec2 } from '@plinth/core'

/**
 * Turning map data's street lines into a tidy street network, the way a
 * person would draw it: one junction where a crossing was mapped as a few
 * points a metre or two apart, loose ends that stop just short of a street
 * joined to it, stray stubs left out, and a road split into two one-way
 * carriageways (as OpenStreetMap maps a divided road) without sidewalks
 * down the middle between them.
 */

export interface StreetLine {
  /** Plan metres (x east, y north). */
  points: Vec2[]
  props: StreetProps
}

export interface NetworkOptions {
  /** Junction points this close together become one (metres). */
  merge?: number
  /** Loose ends this close to a point of another street join it (metres). */
  snap?: number
  /** Dead-end stubs shorter than this are left out (metres). */
  stub?: number
  /** The two halves of a divided road lie at most this far apart (metres). */
  divided?: number
  /** Loose ends to keep whatever their length: where the data was cut off (its edge), not where a street ends. */
  keepEnd?: (p: Vec2) => boolean
}

export interface Network {
  nodes: Record<string, StreetNode>
  streets: Record<string, Street>
}

interface Segment {
  a: number
  b: number
  props: StreetProps
}

export function tidyNetwork(lines: readonly StreetLine[], options: NetworkOptions = {}): Network {
  const merge = options.merge ?? 5
  const snap = options.snap ?? 3
  const stub = options.stub ?? 7
  const divided = options.divided ?? 28

  // Points: the same place is the same point.
  const points: Vec2[] = []
  const byKey = new Map<string, number>()
  const pointAt = (p: Vec2) => {
    const key = `${Math.round(p.x * 100)}:${Math.round(p.y * 100)}`
    let index = byKey.get(key)
    if (index === undefined) {
      index = points.push({ x: p.x, y: p.y }) - 1
      byKey.set(key, index)
    }
    return index
  }
  let segments: Segment[] = []
  for (const line of lines) {
    for (let i = 0; i + 1 < line.points.length; i++) {
      const a = pointAt(line.points[i]!)
      const b = pointAt(line.points[i + 1]!)
      if (a !== b) segments.push({ a, b, props: line.props })
    }
  }

  const degrees = () => {
    const degree = new Int32Array(points.length)
    for (const s of segments) {
      degree[s.a]!++
      degree[s.b]!++
    }
    return degree
  }

  // Junction points (and ends) close together become one, at their middle; loose ends snap to a point nearby.
  const parent = Int32Array.from({ length: points.length }, (_, i) => i)
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!
      i = parent[i]!
    }
    return i
  }
  const union = (i: number, j: number) => {
    const a = find(i)
    const b = find(j)
    if (a !== b) parent[b] = a
  }
  let degree = degrees()
  const cell = Math.max(merge, snap)
  const grid = new Map<string, number[]>()
  points.forEach((p, i) => {
    if (degree[i] === 0) return
    const key = `${Math.floor(p.x / cell)}:${Math.floor(p.y / cell)}`
    const list = grid.get(key)
    if (list) list.push(i)
    else grid.set(key, [i])
  })
  const nearby = (p: Vec2, f: (j: number) => void) => {
    const cx = Math.floor(p.x / cell)
    const cy = Math.floor(p.y / cell)
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) for (const j of grid.get(`${cx + dx}:${cy + dy}`) ?? []) f(j)
  }
  const ownSegment = (i: number, j: number) => segments.some((s) => (s.a === i && s.b === j) || (s.a === j && s.b === i))
  points.forEach((p, i) => {
    if (degree[i] === 2 || degree[i] === 0) return
    nearby(p, (j) => {
      if (j === i) return
      const d = Math.hypot(points[j]!.x - p.x, points[j]!.y - p.y)
      // Two junction points (or ends) close together; or a loose end next to any point of another street.
      if ((degree[j] !== 2 && d < merge) || (degree[i] === 1 && d < snap && !ownSegment(i, j))) union(i, j)
    })
  })
  const members = new Map<number, number[]>()
  points.forEach((_, i) => {
    const root = find(i)
    const list = members.get(root)
    if (list) list.push(i)
    else members.set(root, [i])
  })
  for (const [root, list] of members) {
    if (list.length < 2) continue
    // A junction stays where most of its streets meet: the middle of its points.
    const x = list.reduce((s, i) => s + points[i]!.x, 0) / list.length
    const y = list.reduce((s, i) => s + points[i]!.y, 0) / list.length
    points[root] = { x, y }
  }
  const seen = new Set<string>()
  segments = segments
    .map((s) => ({ ...s, a: find(s.a), b: find(s.b) }))
    .filter((s) => {
      if (s.a === s.b) return false
      const key = s.a < s.b ? `${s.a}:${s.b}` : `${s.b}:${s.a}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

  // Stubs: short dead ends (bits of street cut off by the data's edges, or a few metres of a driveway).
  for (let pass = 0; pass < 3; pass++) {
    degree = degrees()
    const at = new Map<number, number[]>()
    segments.forEach((s, k) => {
      for (const end of [s.a, s.b]) {
        const list = at.get(end)
        if (list) list.push(k)
        else at.set(end, [k])
      }
    })
    const gone = new Set<number>()
    points.forEach((_, start) => {
      if (degree[start] !== 1 || options.keepEnd?.(points[start]!)) return
      // Walk from the loose end through plain points (two streets) to wherever the stub joins on.
      let node = start
      let length = 0
      const path: number[] = []
      let previous = -1
      for (let guard = 0; guard < 1000; guard++) {
        const next = (at.get(node) ?? []).find((k) => k !== previous && !gone.has(k))
        if (next === undefined) break
        const s = segments[next]!
        const other = s.a === node ? s.b : s.a
        length += Math.hypot(points[other]!.x - points[node]!.x, points[other]!.y - points[node]!.y)
        path.push(next)
        previous = next
        node = other
        if (degree[node] !== 2 || length > stub) break
      }
      // Only stubs that join something (a lone short bit goes too).
      if (length < stub && (degree[node]! >= 3 || degree[node] === 1)) for (const k of path) gone.add(k)
    })
    if (gone.size === 0) break
    segments = segments.filter((_, k) => !gone.has(k))
  }

  // Divided roads: a one-way carriageway with another running the other way close beside it has no sidewalk
  // (nor parking) on that side.
  const middles = segments.map((s) => {
    const a = points[s.a]!
    const b = points[s.b]!
    const length = Math.hypot(b.x - a.x, b.y - a.y) || 1
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, dx: (b.x - a.x) / length, dy: (b.y - a.y) / length, length }
  })
  const lanes = new Map<string, number[]>()
  middles.forEach((m, k) => {
    if (!segments[k]!.props.oneway) return
    const key = `${Math.floor(m.x / divided)}:${Math.floor(m.y / divided)}`
    const list = lanes.get(key)
    if (list) list.push(k)
    else lanes.set(key, [k])
  })
  segments = segments.map((s, k) => {
    if (!s.props.oneway) return s
    const m = middles[k]!
    let left = false
    let right = false
    const cx = Math.floor(m.x / divided)
    const cy = Math.floor(m.y / divided)
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        for (const j of lanes.get(`${cx + dx}:${cy + dy}`) ?? []) {
          if (j === k) continue
          const o = middles[j]!
          // Running the other way, alongside.
          if (m.dx * o.dx + m.dy * o.dy > -0.8) continue
          const ox = o.x - m.x
          const oy = o.y - m.y
          const along = ox * m.dx + oy * m.dy
          const across = -ox * m.dy + oy * m.dx
          if (Math.abs(along) > m.length / 2 + o.length / 2 || Math.abs(across) > divided || Math.abs(across) < 2) continue
          if (across > 0) left = true
          else right = true
        }
      }
    }
    if (!left && !right) return s
    return {
      ...s,
      props: {
        ...s.props,
        ...(left ? { sidewalkLeft: 0, parkingLeft: 0 } : {}),
        ...(right ? { sidewalkRight: 0, parkingRight: 0 } : {}),
      },
    }
  })

  const nodes: Record<string, StreetNode> = {}
  const streets: Record<string, Street> = {}
  const nodeId = (i: number) => {
    const id = `n${i}`
    nodes[id] ??= { id, x: points[i]!.x, y: points[i]!.y }
    return id
  }
  segments.forEach((s, k) => {
    const id = `s${k}`
    streets[id] = { ...DEFAULT_STREET, ...s.props, id, a: nodeId(s.a), b: nodeId(s.b), control: null }
  })
  return { nodes, streets }
}
