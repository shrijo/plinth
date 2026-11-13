import { DEFAULT_STREET, type Street, type StreetNode, type StreetProps, type Vec2 } from '@plinth/core'

/**
 * Turning map data's street lines into a tidy street network, the way a
 * person would draw it: streets that cross meet at a junction (map data
 * often leaves the shared point out where it simplifies a straight line),
 * a street ending at another joins it, one junction where a crossing was
 * mapped as a few points a metre or two apart, stray stubs left out, and a
 * road split into two one-way carriageways (as OpenStreetMap maps a
 * divided road) without sidewalks down the middle between them.
 */

export interface StreetLine {
  /** Plan metres (x east, y north). */
  points: Vec2[]
  /**
   * Its cross-section, and its level (`props.level`: 0 or missing on the ground, above it on a bridge). Lines
   * on different levels pass over one another: they meet only where one ends on the other.
   */
  props: StreetProps
}

export interface NetworkOptions {
  /** Junction points this close together become one (metres). */
  merge?: number
  /** Loose ends this close to another street join it (metres). */
  snap?: number
  /** Dead-end stubs shorter than this are left out (metres). */
  stub?: number
  /** The widest median between the two halves of a divided road (metres, kerb to kerb). */
  median?: number
  /** Loose ends to keep whatever their length: where the data was cut off (its edge), not where a street ends. */
  keepEnd?: (p: Vec2) => boolean
  /**
   * Points where streets go on as something drawn apart (a bridge, a tunnel): each street ends there on its
   * own, flat, for the bridge to carry on from. Nothing joins, snaps or merges there.
   */
  apart?: (p: Vec2) => boolean
  /**
   * Footways (plan metres): where a city maps its sidewalks as ways of their own, each runs down the middle of
   * a real sidewalk, so a street with one alongside gets its sidewalk there, and its road out to meet it.
   */
  footways?: readonly (readonly Vec2[])[]
  /**
   * Surveyed carriageway outlines (area:highway polygons of road classes, plan metres): kerb to kerb over the
   * traffic lanes. A street running inside one takes its measured width, kerbs on its edges.
   */
  roadAreas?: readonly (readonly Vec2[])[]
  /** Surveyed sidewalk outlines (area:highway=footway): a street alongside one gets a sidewalk spanning it. */
  sidewalkAreas?: readonly (readonly Vec2[])[]
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

interface Split {
  /** Where along the segment (0 at a, 1 at b). */
  t: number
  point: number
}

/**
 * Whether a line is a roundabout's ring: closed, small, and round. Map
 * tiles drop junction=roundabout (and the one-way running it implies), so
 * the ring's shape is what gives it away.
 */
export function looksLikeRoundabout(points: readonly Vec2[]): boolean {
  if (points.length < 5) return false
  const first = points[0]!
  const last = points[points.length - 1]!
  if (Math.hypot(first.x - last.x, first.y - last.y) > 0.5) return false
  let length = 0
  for (let i = 1; i < points.length; i++) length += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y)
  if (length < 15 || length > 110) return false
  const cx = points.reduce((sum, p) => sum + p.x, 0) / points.length
  const cy = points.reduce((sum, p) => sum + p.y, 0) / points.length
  const radii = points.map((p) => Math.hypot(p.x - cx, p.y - cy))
  const most = Math.max(...radii)
  return most <= 20 && Math.min(...radii) >= most * 0.45
}

/** A roundabout's ring shorter round than this (metres) collapses into one junction: too small to draw as a circle. */
const TINY_ROUNDABOUT = 52

/** Closer than this (metres) to a segment's end, a meeting is at that end. */
const NEAR = 0.6
/** Grid cells for finding segments near each other (metres). */
const CELL = 24
/** The farthest a loose end reaches to join a street it heads for (metres). */
const REACH = 12
/** A triangle of streets smaller round than this (metres) is one junction. */
const TRIANGLE = 45

export function tidyNetwork(lines: readonly StreetLine[], options: NetworkOptions = {}): Network {
  const merge = options.merge ?? 5
  const snap = options.snap ?? 4
  const stub = options.stub ?? 7
  const median = options.median ?? 15

  // Points: the same place is the same point.
  const points: Vec2[] = []
  const byKey = new Map<string, number>()
  /** Points held where they are, on their own (see NetworkOptions.apart). */
  const fixed = new Set<number>()
  const pointAt = (p: Vec2) => {
    if (options.apart?.(p)) {
      const index = points.push({ x: p.x, y: p.y }) - 1
      fixed.add(index)
      return index
    }
    const key = `${Math.round(p.x * 100)}:${Math.round(p.y * 100)}`
    let index = byKey.get(key)
    if (index === undefined) {
      index = points.push({ x: p.x, y: p.y }) - 1
      byKey.set(key, index)
    }
    return index
  }
  let segments: Segment[] = []
  /** Pairs of points that are one point. */
  const joins: [number, number][] = []
  // Each level's points are its own: where a bridge's line happens to have a point right over a street's, they
  // don't meet. A bridge's ends do: they are where it lands, on whatever is there.
  const levels = [...new Set(lines.map((line) => line.props.level ?? 0))].sort((a, b) => a - b)
  const onLevel = new Map<number, Map<string, number>>()
  const levelPoint = (p: Vec2, level: number) => {
    if (level === 0 || options.apart?.(p)) return pointAt(p)
    let map = onLevel.get(level)
    if (!map) onLevel.set(level, (map = new Map()))
    const key = `${Math.round(p.x * 100)}:${Math.round(p.y * 100)}`
    let index = map.get(key)
    if (index === undefined) {
      index = points.push({ x: p.x, y: p.y }) - 1
      map.set(key, index)
    }
    return index
  }
  for (const line of lines) {
    const level = line.props.level ?? 0
    for (let i = 0; i + 1 < line.points.length; i++) {
      const a = levelPoint(line.points[i]!, level)
      const b = levelPoint(line.points[i + 1]!, level)
      if (a !== b) segments.push({ a, b, props: line.props })
    }
  }
  if (levels.some((level) => level !== 0)) {
    // Landings: a bridge's end, and the point of another level at the same place (the ground first).
    for (const line of lines) {
      const level = line.props.level ?? 0
      if (level === 0) continue
      for (const p of [line.points[0]!, line.points[line.points.length - 1]!]) {
        if (options.apart?.(p)) continue
        const key = `${Math.round(p.x * 100)}:${Math.round(p.y * 100)}`
        const own = onLevel.get(level)?.get(key)
        if (own === undefined) continue
        const other = byKey.get(key) ?? levels.map((l) => (l === level ? undefined : onLevel.get(l)?.get(key))).find((i) => i !== undefined)
        if (other !== undefined) joins.push([own, other])
      }
    }
  }
  const levelOf = (s: Segment) => s.props.level ?? 0

  const degrees = () => {
    const degree = new Int32Array(points.length)
    for (const s of segments) {
      degree[s.a]!++
      degree[s.b]!++
    }
    return degree
  }
  // Crossings: streets that cross on the level meet there. (A bridge passes over what it crosses; tunnels never get here.)
  {
    const splits = new Map<number, Split[]>()
    const grid = segmentGrid(points, segments, 0)
    const tried = new Set<number>()
    const count = segments.length
    for (const list of grid.values()) {
      for (let x = 0; x < list.length; x++) {
        for (let y = x + 1; y < list.length; y++) {
          const i = Math.min(list[x]!, list[y]!)
          const j = Math.max(list[x]!, list[y]!)
          const pair = i * count + j
          if (tried.has(pair)) continue
          tried.add(pair)
          const si = segments[i]!
          const sj = segments[j]!
          if (si.a === sj.a || si.a === sj.b || si.b === sj.a || si.b === sj.b) continue
          if (levelOf(si) !== levelOf(sj)) continue
          const hit = crossing(points[si.a]!, points[si.b]!, points[sj.a]!, points[sj.b]!)
          if (!hit) continue
          // Where they meet: an end of either if it's there, otherwise a new point on both.
          const endI = hit.t * hit.li < NEAR ? si.a : (1 - hit.t) * hit.li < NEAR ? si.b : -1
          const endJ = hit.u * hit.lj < NEAR ? sj.a : (1 - hit.u) * hit.lj < NEAR ? sj.b : -1
          if (fixed.has(endI) || fixed.has(endJ)) continue
          if (endI >= 0 && endJ >= 0) joins.push([endI, endJ])
          else if (endI >= 0) addSplit(splits, j, hit.u, endI)
          else if (endJ >= 0) addSplit(splits, i, hit.t, endJ)
          else {
            const point = pointAt(hit.point)
            addSplit(splits, i, hit.t, point)
            addSplit(splits, j, hit.u, point)
          }
        }
      }
    }
    segments = applySplits(segments, splits)
  }

  // Loose ends just short of another street (or a little to one side of it) join it, on its line. A street
  // heading straight at another may stop at its kerb (as map data often has it): it joins from across the
  // other's width.
  {
    const degree = degrees()
    const splits = new Map<number, Split[]>()
    const grid = segmentGrid(points, segments, REACH)
    const at = segmentsAt(segments)
    // A bridge's end that has landed isn't loose.
    const landed = new Set(joins.flat())
    points.forEach((p, i) => {
      if (degree[i] !== 1 || fixed.has(i) || landed.has(i)) return
      const own = segments[at.get(i)![0]!]!
      const from = points[own.a === i ? own.b : own.a]!
      const ownLength = Math.hypot(p.x - from.x, p.y - from.y) || 1
      const heading = { x: (p.x - from.x) / ownLength, y: (p.y - from.y) / ownLength }
      let best = -1
      let bestDistance = Infinity
      let bestT = 0
      for (const k of grid.get(cellKey(p.x, p.y)) ?? []) {
        const s = segments[k]!
        if (s.a === i || s.b === i) continue
        const a = points[s.a]!
        const b = points[s.b]!
        const { t, distance } = project(p, a, b)
        // Its own level's streets; a bridge's end also lands on the ground where it ends right on a street.
        if (levelOf(s) !== levelOf(own) && !(levelOf(own) !== 0 && levelOf(s) === 0 && distance < 1)) continue
        const q = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
        const towards = distance > 1e-6 && ((q.x - p.x) * heading.x + (q.y - p.y) * heading.y) / distance > 0.85
        const props = s.props
        const width = carriageway(props) + Math.max(props.bikeLeft + props.parkingLeft + props.sidewalkLeft, props.bikeRight + props.parkingRight + props.sidewalkRight)
        const reach = towards ? Math.min(Math.max(snap, width + 1.5), REACH) : snap
        if (distance < reach && distance < bestDistance) {
          best = k
          bestDistance = distance
          bestT = t
        }
      }
      if (best < 0) return
      const s = segments[best]!
      const a = points[s.a]!
      const b = points[s.b]!
      const length = Math.hypot(b.x - a.x, b.y - a.y)
      // At (or next to) one of the street's points: join that point, where it is.
      const end = bestT * length < 1 ? s.a : (1 - bestT) * length < 1 ? s.b : -1
      if (end >= 0) {
        points[i] = { ...points[end]! }
        joins.push([end, i])
      } else {
        points[i] = { x: a.x + (b.x - a.x) * bestT, y: a.y + (b.y - a.y) * bestT }
        addSplit(splits, best, bestT, i)
      }
    })
    segments = applySplits(segments, splits)
  }

  // Junction points (and ends) close together become one, at their middle.
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
  for (const [i, j] of joins) union(i, j)
  // A small triangle of streets is one junction mapped as three (turning lanes drawn as streets of their own):
  // its corners become one.
  {
    const neighbours = new Map<number, Set<number>>()
    for (const s of segments) {
      for (const [p, q] of [
        [s.a, s.b],
        [s.b, s.a],
      ] as const) {
        const set = neighbours.get(p)
        if (set) set.add(q)
        else neighbours.set(p, new Set([q]))
      }
    }
    const span = (i: number, j: number) => Math.hypot(points[i]!.x - points[j]!.x, points[i]!.y - points[j]!.y)
    for (const s of segments) {
      const [a, b] = [s.a, s.b]
      if (fixed.has(a) || fixed.has(b) || levelOf(s) !== 0) continue
      for (const c of neighbours.get(a) ?? []) {
        if (c === b || fixed.has(c) || !neighbours.get(b)?.has(c)) continue
        // Junctions all three (their streets go on beyond the triangle).
        if ([a, b, c].some((k) => (neighbours.get(k)?.size ?? 0) < 3)) continue
        if (span(a, b) + span(b, c) + span(c, a) < TRIANGLE) {
          union(a, b)
          union(a, c)
        }
      }
    }
  }
  // A tiny roundabout collapses into one junction (as osm2streets does): its ring is shorter round than a
  // junction is wide, so drawing the circle would leave no room for the arms. Its nodes become one point at
  // its centre; the ring's segments turn into loops there and drop out.
  {
    const leaving = new Map<number, number[]>()
    segments.forEach((s, k) => {
      if (!s.props.oneway) return
      const list = leaving.get(s.a)
      if (list) list.push(k)
      else leaving.set(s.a, [k])
    })
    const seglen = (k: number) => {
      const s = segments[k]!
      return Math.hypot(points[s.b]!.x - points[s.a]!.x, points[s.b]!.y - points[s.a]!.y)
    }
    const done = new Uint8Array(segments.length)
    segments.forEach((s, start) => {
      if (!s.props.oneway || done[start]) return
      const path = [start]
      let node = s.b
      let length = seglen(start)
      for (let guard = 0; guard < 24 && length <= TINY_ROUNDABOUT; guard++) {
        if (node === s.a) {
          // A cycle: one junction if it's small AND round. A short one-way pair out and back (the halves of
          // a divided road) is a cycle too, but encloses almost nothing; a ring encloses like a circle.
          const nodes = path.map((k) => segments[k]!.a)
          const cx = nodes.reduce((sum, i) => sum + points[i]!.x, 0) / nodes.length
          const cy = nodes.reduce((sum, i) => sum + points[i]!.y, 0) / nodes.length
          let area = 0
          for (let i = 0; i < nodes.length; i++) {
            const p = points[nodes[i]!]!
            const q = points[nodes[(i + 1) % nodes.length]!]!
            area += p.x * q.y - q.x * p.y
          }
          const round = Math.abs(area / 2) >= ((length * length) / (4 * Math.PI)) * 0.55
          if (round && nodes.length >= 4 && nodes.every((i) => Math.hypot(points[i]!.x - cx, points[i]!.y - cy) <= 10)) {
            for (const i of nodes) union(nodes[0]!, i)
            points[find(nodes[0]!)] = { x: cx, y: cy }
            for (const k of path) done[k] = 1
          }
          break
        }
        const nexts = (leaving.get(node) ?? []).filter((k) => !path.includes(k) && !done[k])
        if (nexts.length === 0) break
        // Carrying on round the ring: the straightest of the ways out.
        const before = segments[path[path.length - 1]!]!
        const dx = points[before.b]!.x - points[before.a]!.x
        const dy = points[before.b]!.y - points[before.a]!.y
        let next = nexts[0]!
        let best = -Infinity
        for (const k of nexts) {
          const o = segments[k]!
          const ox = points[o.b]!.x - points[o.a]!.x
          const oy = points[o.b]!.y - points[o.a]!.y
          const along = (dx * ox + dy * oy) / (Math.hypot(dx, dy) * Math.hypot(ox, oy) || 1)
          if (along > best) {
            best = along
            next = k
          }
        }
        path.push(next)
        length += seglen(next)
        node = segments[next]!.b
      }
    })
  }
  // How many streets meet at each point (points already joined counting as one), and on which levels.
  const degree = new Int32Array(points.length)
  const levelsAt = new Map<number, Set<number>>()
  for (const s of segments) {
    for (const end of [s.a, s.b]) {
      const root = find(end)
      degree[root]!++
      const set = levelsAt.get(root)
      if (set) set.add(levelOf(s))
      else levelsAt.set(root, new Set([levelOf(s)]))
    }
  }
  const degreeOf = (i: number) => degree[find(i)]!
  const sharesLevel = (i: number, j: number) => {
    const a = levelsAt.get(find(i))
    const b = levelsAt.get(find(j))
    if (!a || !b) return false
    for (const level of a) if (b.has(level)) return true
    return false
  }
  const grid = new Map<string, number[]>()
  points.forEach((p, i) => {
    if (degreeOf(i) === 0) return
    const key = `${Math.floor(p.x / merge)}:${Math.floor(p.y / merge)}`
    const list = grid.get(key)
    if (list) list.push(i)
    else grid.set(key, [i])
  })
  // Found first, joined after: joining as it goes would change what the next point sees.
  const near: [number, number][] = []
  points.forEach((p, i) => {
    if (degreeOf(i) === 2 || degreeOf(i) === 0 || fixed.has(i)) return
    const cx = Math.floor(p.x / merge)
    const cy = Math.floor(p.y / merge)
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        for (const j of grid.get(`${cx + dx}:${cy + dy}`) ?? []) {
          if (j === i || degreeOf(j) === 2 || fixed.has(j)) continue
          // A junction on a bridge and one on the street under it stay two.
          if (Math.hypot(points[j]!.x - p.x, points[j]!.y - p.y) < merge && sharesLevel(i, j)) near.push([i, j])
        }
      }
    }
  })
  for (const [i, j] of near) union(i, j)
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

  const keep = (i: number) => fixed.has(i) || !!options.keepEnd?.(points[i]!)
  segments = withoutStubs(points, segments, stub, keep)

  // The same street mapped twice (or a lane of it mapped as a street of its own) is drawn once.
  const before = segments.length
  segments = withoutDuplicates(points, segments)
  if (segments.length < before) {
    // What's left of a street on either side of a dropped one may end loose.
    segments = withoutStubs(points, segments, stub, keep)
  }
  // Surveyed surfaces first (they're measured); footways then fit only the streets the surfaces didn't.
  let measured = new Set<number>()
  if (options.roadAreas?.length || options.sidewalkAreas?.length) {
    const fit = fittedToAreas(points, segments, options.roadAreas ?? [], options.sidewalkAreas ?? [])
    segments = fit.segments
    measured = fit.measured
  }
  if (options.footways && options.footways.length > 0) segments = fittedToFootways(points, segments, options.footways, measured)
  segments = sidewalksBeside(points, segments, median)

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

/**
 * Stubs: short dead ends (bits of street cut off by the data's edges, a
 * street overshooting the one it meets, or a few metres of a driveway).
 */
function withoutStubs(points: readonly Vec2[], given: readonly Segment[], stub: number, keep: (point: number) => boolean): Segment[] {
  let segments = given.slice()
  const degreesOf = () => {
    const degree = new Int32Array(points.length)
    for (const s of segments) {
      degree[s.a]!++
      degree[s.b]!++
    }
    return degree
  }
  for (let pass = 0; pass < 3; pass++) {
    const degree = degreesOf()
    const at = segmentsAt(segments)
    const gone = new Set<number>()
    points.forEach((_, start) => {
      if (degree[start] !== 1 || keep(start)) return
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
  return segments
}

const cellKey = (x: number, y: number) => `${Math.floor(x / CELL)}:${Math.floor(y / CELL)}`

/** Segments by the grid cells their bounds (grown by `pad`) cover. */
function segmentGrid(points: readonly Vec2[], segments: readonly Segment[], pad: number): Map<string, number[]> {
  const grid = new Map<string, number[]>()
  segments.forEach((s, k) => {
    const a = points[s.a]!
    const b = points[s.b]!
    const x0 = Math.floor((Math.min(a.x, b.x) - pad - NEAR) / CELL)
    const x1 = Math.floor((Math.max(a.x, b.x) + pad + NEAR) / CELL)
    const y0 = Math.floor((Math.min(a.y, b.y) - pad - NEAR) / CELL)
    const y1 = Math.floor((Math.max(a.y, b.y) + pad + NEAR) / CELL)
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const key = `${x}:${y}`
        const list = grid.get(key)
        if (list) list.push(k)
        else grid.set(key, [k])
      }
    }
  })
  return grid
}

function segmentsAt(segments: readonly Segment[]): Map<number, number[]> {
  const at = new Map<number, number[]>()
  segments.forEach((s, k) => {
    for (const end of [s.a, s.b]) {
      const list = at.get(end)
      if (list) list.push(k)
      else at.set(end, [k])
    }
  })
  return at
}

/** Where two segments cross (or come within NEAR of it at an end), as fractions along each. */
function crossing(p: Vec2, q: Vec2, r: Vec2, s: Vec2): { t: number; u: number; li: number; lj: number; point: Vec2 } | null {
  const d1x = q.x - p.x
  const d1y = q.y - p.y
  const d2x = s.x - r.x
  const d2y = s.y - r.y
  const li = Math.hypot(d1x, d1y)
  const lj = Math.hypot(d2x, d2y)
  if (li === 0 || lj === 0) return null
  const den = d1x * d2y - d1y * d2x
  // (Nearly) parallel: no single crossing.
  if (Math.abs(den) < 0.02 * li * lj) return null
  const ex = r.x - p.x
  const ey = r.y - p.y
  const t = (ex * d2y - ey * d2x) / den
  const u = (ex * d1y - ey * d1x) / den
  if (t < -NEAR / li || t > 1 + NEAR / li || u < -NEAR / lj || u > 1 + NEAR / lj) return null
  return { t, u, li, lj, point: { x: p.x + d1x * t, y: p.y + d1y * t } }
}

function project(p: Vec2, a: Vec2, b: Vec2): { t: number; distance: number } {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const l = dx * dx + dy * dy
  const t = l === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l))
  return { t, distance: Math.hypot(p.x - a.x - dx * t, p.y - a.y - dy * t) }
}

function addSplit(splits: Map<number, Split[]>, k: number, t: number, point: number): void {
  const list = splits.get(k)
  const split = { t: Math.min(Math.max(t, 0), 1), point }
  if (list) list.push(split)
  else splits.set(k, [split])
}

function applySplits(segments: readonly Segment[], splits: Map<number, Split[]>): Segment[] {
  const out: Segment[] = []
  segments.forEach((s, k) => {
    const list = splits.get(k)
    if (!list) {
      out.push(s)
      return
    }
    list.sort((x, y) => x.t - y.t)
    let from = s.a
    for (const { point } of list) {
      if (point === from || point === s.b) continue
      out.push({ a: from, b: point, props: s.props })
      from = point
    }
    if (from !== s.b) out.push({ a: from, b: s.b, props: s.props })
  })
  return out
}

/** A street between junctions (or ends): segments through plain points (two segments), walked one way. */
interface Chain {
  run: { k: number; forward: boolean }[]
  length: number
}

function chainsOf(points: readonly Vec2[], segments: readonly Segment[]): Chain[] {
  const at = segmentsAt(segments)
  const plain = (point: number) => (at.get(point)?.length ?? 0) === 2
  const done = new Uint8Array(segments.length)
  const chains: Chain[] = []
  segments.forEach((_, start) => {
    if (done[start]) return
    // Back to the start of the street, then along it.
    let k = start
    let from = segments[k]!.a
    for (let guard = 0; guard < 100000; guard++) {
      if (!plain(from)) break
      const previous = at.get(from)!.find((x) => x !== k)!
      if (previous === start) break
      k = previous
      const s = segments[k]!
      from = s.a === from ? s.b : s.a
    }
    const run: Chain['run'] = []
    let length = 0
    let point = from
    for (let guard = 0; guard < 100000 && !done[k]; guard++) {
      done[k] = 1
      const s = segments[k]!
      const forward = s.a === point
      run.push({ k, forward })
      length += Math.hypot(points[s.b]!.x - points[s.a]!.x, points[s.b]!.y - points[s.a]!.y)
      point = forward ? s.b : s.a
      if (!plain(point)) break
      k = at.get(point)!.find((x) => x !== k)!
    }
    chains.push({ run, length })
  })
  return chains
}

const RANK: Record<string, number> = {
  motorway: 9,
  trunk: 8,
  primary: 7,
  secondary: 6,
  tertiary: 5,
  unclassified: 4,
  residential: 3,
  living_street: 2,
  service: 1,
  pedestrian: 0,
}
const carriageway = (props: StreetProps) => (props.lanes * props.laneWidth) / 2

/** A footway this far beyond a street's road (metres, at most) may be its sidewalk. */
const FOOTWAY_REACH = 9
/** A road widens at most this much on a side (metres) to meet a footway: further, the footway is something else's. */
const MOST_WIDER = 6
/** Lanes fitted to footways stay this wide (metres). */
const LANE_WIDTHS = [2.5, 4.5] as const

/**
 * Streets fitted to the footways mapped alongside them (see
 * NetworkOptions.footways): per street between junctions and per side, the
 * footway that runs along most of it (the middle of its distances), if
 * any, is where the sidewalk's middle goes, and the road reaches out to
 * the sidewalk's kerb: lanes a little wider or narrower, any more as a
 * strip at road level beside them (parking, a tram track). Streets without
 * one stay as they are.
 */
function fittedToFootways(
  points: readonly Vec2[],
  segments: readonly Segment[],
  footways: readonly (readonly Vec2[])[],
  /** Segments already fitted to surveyed surfaces: their chains are left as they are. */
  measured?: ReadonlySet<number>,
): Segment[] {
  // Footway segments by grid cell.
  const pieces: { ax: number; ay: number; bx: number; by: number }[] = []
  const grid = new Map<string, number[]>()
  for (const line of footways) {
    for (let i = 0; i + 1 < line.length; i++) {
      const a = line[i]!
      const b = line[i + 1]!
      const k = pieces.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y }) - 1
      const pad = FOOTWAY_REACH + 8
      for (let y = Math.floor((Math.min(a.y, b.y) - pad) / CELL); y <= Math.floor((Math.max(a.y, b.y) + pad) / CELL); y++) {
        for (let x = Math.floor((Math.min(a.x, b.x) - pad) / CELL); x <= Math.floor((Math.max(a.x, b.x) + pad) / CELL); x++) {
          const key = `${x}:${y}`
          const list = grid.get(key)
          if (list) list.push(k)
          else grid.set(key, [k])
        }
      }
    }
  }
  const roadSide = (props: StreetProps, left: boolean) => carriageway(props) + (left ? props.bikeLeft + props.parkingLeft : props.bikeRight + props.parkingRight)
  // The streets too: a footway beyond another street is that street's.
  const streetGrid = new Map<string, number[]>()
  segments.forEach((s, k) => {
    const a = points[s.a]!
    const b = points[s.b]!
    for (let y = Math.floor(Math.min(a.y, b.y) / CELL); y <= Math.floor(Math.max(a.y, b.y) / CELL); y++) {
      for (let x = Math.floor(Math.min(a.x, b.x) / CELL); x <= Math.floor(Math.max(a.x, b.x) / CELL); x++) {
        const key = `${x}:${y}`
        const list = streetGrid.get(key)
        if (list) list.push(k)
        else streetGrid.set(key, [k])
      }
    }
  })

  const out = segments.slice()
  for (const { run, length } of chainsOf(points, segments)) {
    const own = new Set(run.map(({ k }) => k))
    if (length < 8 || run.some(({ k }) => measured?.has(k))) continue
    // Per side (as the street is walked): the nearest footway running alongside each segment, by length.
    const found: { left: { d: number; w: number }[]; right: { d: number; w: number }[] } = { left: [], right: [] }
    for (const { k, forward } of run) {
      const s = segments[k]!
      const a = points[forward ? s.a : s.b]!
      const b = points[forward ? s.b : s.a]!
      const l = Math.hypot(b.x - a.x, b.y - a.y)
      if (l < 1e-6) continue
      const dx = (b.x - a.x) / l
      const dy = (b.y - a.y) / l
      // The grid cells along the segment, and one beyond.
      const cells: string[] = []
      for (let gy = Math.floor(Math.min(a.y, b.y) / CELL) - 1; gy <= Math.floor(Math.max(a.y, b.y) / CELL) + 1; gy++) {
        for (let gx = Math.floor(Math.min(a.x, b.x) / CELL) - 1; gx <= Math.floor(Math.max(a.x, b.x) / CELL) + 1; gx++) cells.push(`${gx}:${gy}`)
      }
      // The nearest other street alongside, each side: footways beyond it are its own.
      const other = { left: Infinity, right: Infinity }
      const others = new Set<number>()
      for (const key of cells) for (const j of streetGrid.get(key) ?? []) others.add(j)
      for (const j of others) {
        if (own.has(j)) continue
        const o = segments[j]!
        const p = points[o.a]!
        const q = points[o.b]!
        const ol = Math.hypot(q.x - p.x, q.y - p.y)
        if (ol < 1e-6 || Math.abs(((q.x - p.x) * dx + (q.y - p.y) * dy) / ol) < 0.8) continue
        const t0 = (p.x - a.x) * dx + (p.y - a.y) * dy
        const t1 = (q.x - a.x) * dx + (q.y - a.y) * dy
        if (Math.min(l, Math.max(t0, t1)) - Math.max(0, Math.min(t0, t1)) <= 0) continue
        const tm = (Math.max(0, Math.min(t0, t1)) + Math.min(l, Math.max(t0, t1))) / 2
        const u = Math.abs(t1 - t0) < 1e-9 ? 0 : (tm - t0) / (t1 - t0)
        const across = -(p.x + (q.x - p.x) * u - a.x) * dy + (p.y + (q.y - p.y) * u - a.y) * dx
        const side = across > 0 ? 'left' : 'right'
        other[side] = Math.min(other[side], Math.abs(across) - carriageway(o.props))
      }
      // Per side: the nearest footway's distance, and how far along the segment footways run alongside.
      const near = { left: Infinity, right: Infinity }
      const along = { left: 0, right: 0 }
      const seen = new Set<number>()
      for (const j of cells.flatMap((key) => grid.get(key) ?? [])) {
        if (seen.has(j)) continue
        seen.add(j)
        const f = pieces[j]!
        const fl = Math.hypot(f.bx - f.ax, f.by - f.ay)
        if (fl < 1) continue
        // Alongside: parallel either way, overlapping along.
        if (Math.abs(((f.bx - f.ax) * dx + (f.by - f.ay) * dy) / fl) < 0.94) continue
        const t0 = (f.ax - a.x) * dx + (f.ay - a.y) * dy
        const t1 = (f.bx - a.x) * dx + (f.by - a.y) * dy
        const overlap = Math.min(l, Math.max(t0, t1)) - Math.max(0, Math.min(t0, t1))
        if (overlap < Math.min(l, fl) * 0.5) continue
        // How far to the side, at the overlap's middle.
        const tm = (Math.max(0, Math.min(t0, t1)) + Math.min(l, Math.max(t0, t1))) / 2
        const u = Math.abs(t1 - t0) < 1e-9 ? 0 : (tm - t0) / (t1 - t0)
        const px = f.ax + (f.bx - f.ax) * u
        const py = f.ay + (f.by - f.ay) * u
        const across = -(px - a.x) * dy + (py - a.y) * dx
        const side = across > 0 ? 'left' : 'right'
        const road = roadSide(s.props, forward ? side === 'left' : side === 'right')
        const d = Math.abs(across)
        // Beyond the middle of where the road could end, and not much further than the road could reach.
        if (d < Math.max(road - 1.5, 2.5) || d > road + FOOTWAY_REACH || d > other[side]) continue
        near[side] = Math.min(near[side], d)
        along[side] += overlap
      }
      if (Number.isFinite(near.left)) found.left.push({ d: near.left, w: Math.min(along.left, l) })
      if (Number.isFinite(near.right)) found.right.push({ d: near.right, w: Math.min(along.right, l) })
    }
    // Along most of the street: the middle of its distances.
    const middle = (list: { d: number; w: number }[]) => {
      const total = list.reduce((sum, e) => sum + e.w, 0)
      if (total < length * 0.5) return null
      const sorted = [...list].sort((p, q) => p.d - q.d)
      let walked = 0
      for (const e of sorted) {
        walked += e.w
        if (walked >= total / 2) return e.d
      }
      return null
    }
    const sideways = { left: middle(found.left), right: middle(found.right) }
    if (sideways.left === null && sideways.right === null) continue
    for (const { k, forward } of run) {
      const s = segments[k]!
      // The footways as the segment is drawn.
      const left = forward ? sideways.left : sideways.right
      const right = forward ? sideways.right : sideways.left
      out[k] = { ...s, props: fitted(s.props, left, right) }
    }
  }
  return out
}

/** A cross-section fitted to footways at these distances from its middle (null: none on that side). */
function fitted(given: StreetProps, left: number | null, right: number | null): StreetProps {
  const props = { ...given }
  // A sidewalk as wide as the street's own (or a usual one), its middle on the footway.
  const width = (own: number) => Math.min(Math.max(own || 2, 2), 4)
  const kerb = (d: number, own: number) => Math.max(d - width(own) / 2, 1.5)
  const target = {
    left: left === null ? null : kerb(left, given.sidewalkLeft),
    right: right === null ? null : kerb(right, given.sidewalkRight),
  }
  const side = (isLeft: boolean) => carriageway(props) + (isLeft ? props.bikeLeft + props.parkingLeft : props.bikeRight + props.parkingRight)
  // Both sides: the lanes take what they share (within reason).
  if (target.left !== null && target.right !== null) {
    const common = Math.min(target.left - side(true), target.right - side(false))
    const laneWidth = Math.min(Math.max(props.laneWidth + (2 * common) / props.lanes, LANE_WIDTHS[0]), LANE_WIDTHS[1])
    props.laneWidth = Math.round(laneWidth * 100) / 100
  }
  // The rest on each side: a strip at road level (parking), or less of one.
  for (const isLeft of [true, false]) {
    const goal = isLeft ? target.left : target.right
    if (goal === null) continue
    const key = isLeft ? 'parkingLeft' : 'parkingRight'
    const delta = Math.min(goal - side(isLeft), MOST_WIDER)
    props[key] = Math.round(Math.max(0, Math.min(props[key] + delta, MOST_WIDER)) * 100) / 100
    // The sidewalk from the kerb as it now is out past the footway.
    const d = (isLeft ? left : right)!
    const own = isLeft ? given.sidewalkLeft : given.sidewalkRight
    const sidewalk = Math.min(Math.max(d + width(own) / 2 - side(isLeft), 1.5), 6)
    if (isLeft) props.sidewalkLeft = Math.round(sidewalk * 100) / 100
    else props.sidewalkRight = Math.round(sidewalk * 100) / 100
  }
  return props
}

/** How often a street is probed along its length when fitting it to surveyed surfaces (metres). */
const PROBE_ALONG = 4
/** Sideways probing resolution (metres). */
const PROBE_STEP = 0.25
/** The farthest a kerb or sidewalk edge is probed for, from the centre line (metres). */
const PROBE_REACH = 16

/** Closed rings in a grid, for asking what surface lies at a point. */
class RingIndex {
  private readonly rings: (readonly Vec2[])[]
  private readonly boxes: { minX: number; minY: number; maxX: number; maxY: number }[]
  private readonly grid = new Map<string, number[]>()
  readonly any: boolean

  constructor(rings: readonly (readonly Vec2[])[]) {
    this.rings = rings.filter((r) => r.length >= 3)
    this.any = this.rings.length > 0
    this.boxes = this.rings.map((ring) => {
      const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
      for (const p of ring) {
        box.minX = Math.min(box.minX, p.x)
        box.maxX = Math.max(box.maxX, p.x)
        box.minY = Math.min(box.minY, p.y)
        box.maxY = Math.max(box.maxY, p.y)
      }
      return box
    })
    this.boxes.forEach((box, k) => {
      for (let y = Math.floor(box.minY / CELL); y <= Math.floor(box.maxY / CELL); y++) {
        for (let x = Math.floor(box.minX / CELL); x <= Math.floor(box.maxX / CELL); x++) {
          const key = `${x}:${y}`
          const list = this.grid.get(key)
          if (list) list.push(k)
          else this.grid.set(key, [k])
        }
      }
    })
  }

  inside(x: number, y: number): boolean {
    for (const k of this.grid.get(`${Math.floor(x / CELL)}:${Math.floor(y / CELL)}`) ?? []) {
      const box = this.boxes[k]!
      if (x < box.minX || x > box.maxX || y < box.minY || y > box.maxY) continue
      const ring = this.rings[k]!
      let hit = false
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[i]!
        const b = ring[j]!
        if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) hit = !hit
      }
      if (hit) return true
    }
    return false
  }
}

/** The middle of a list of weighted samples, if they cover enough of `length`; null otherwise. */
function weightedMiddle(samples: { value: number; weight: number }[], length: number, share: number): number | null {
  const total = samples.reduce((sum, e) => sum + e.weight, 0)
  if (total < length * share) return null
  const sorted = [...samples].sort((p, q) => p.value - q.value)
  let walked = 0
  for (const e of sorted) {
    walked += e.weight
    if (walked >= total / 2) return e.value
  }
  return null
}

/**
 * Streets fitted to surveyed surfaces (see NetworkOptions.roadAreas): per
 * street between junctions, where it runs inside a carriageway outline
 * along most of its length, its kerbs go where the outline's edges are
 * (the middle of the measured distances); a sidewalk outline alongside
 * sets the sidewalk's width, kerb to outer edge. Measured kerbs replace
 * the guessed cross-section: lanes share the measured width, any rest is
 * a strip at road level.
 */
function fittedToAreas(
  points: readonly Vec2[],
  segments: readonly Segment[],
  roadAreas: readonly (readonly Vec2[])[],
  sidewalkAreas: readonly (readonly Vec2[])[],
): { segments: Segment[]; measured: Set<number> } {
  const roads = new RingIndex(roadAreas)
  const walks = new RingIndex(sidewalkAreas)
  const out = segments.slice()
  const measured = new Set<number>()
  if (!roads.any && !walks.any) return { segments: out, measured }

  for (const { run, length } of chainsOf(points, segments)) {
    if (length < 6) continue
    const kerbs = { left: [] as { value: number; weight: number }[], right: [] as { value: number; weight: number }[] }
    const walkSpans = { left: [] as { value: number; weight: number }[], right: [] as { value: number; weight: number }[] }
    const roadHalf = carriageway(segments[run[0]!.k]!.props)
    for (const { k, forward } of run) {
      const s = segments[k]!
      const a = points[forward ? s.a : s.b]!
      const b = points[forward ? s.b : s.a]!
      const l = Math.hypot(b.x - a.x, b.y - a.y)
      if (l < 1e-6) continue
      const dx = (b.x - a.x) / l
      const dy = (b.y - a.y) / l
      const count = Math.max(1, Math.round(l / PROBE_ALONG))
      const weight = l / count
      for (let i = 0; i < count; i++) {
        const t = ((i + 0.5) / count) * l
        const px = a.x + dx * t
        const py = a.y + dy * t
        // The street must itself lie on the surveyed road here.
        const onRoad = roads.any && roads.inside(px, py)
        for (const side of [1, -1] as const) {
          // Left of the walking direction.
          const nx = -dy * side
          const ny = dx * side
          const into = side > 0 ? 'left' : 'right'
          if (onRoad) {
            let kerb = 0
            for (let x = PROBE_STEP; x <= PROBE_REACH; x += PROBE_STEP) {
              if (!roads.inside(px + nx * x, py + ny * x)) break
              kerb = x
            }
            if (kerb > 0) kerbs[into].push({ value: kerb + PROBE_STEP / 2, weight })
            if (walks.any) {
              // The sidewalk's outer edge, from the measured kerb on.
              let outer = 0
              for (let x = kerb + PROBE_STEP; x <= kerb + 8; x += PROBE_STEP) {
                if (walks.inside(px + nx * x, py + ny * x)) outer = x
                else if (outer > 0) break
              }
              if (outer > 0) walkSpans[into].push({ value: outer + PROBE_STEP / 2 - (kerb + PROBE_STEP / 2), weight })
            }
          } else if (walks.any && !roads.any) {
            // Only sidewalks surveyed: measure their span beyond the guessed kerb.
            let first = 0
            let outer = 0
            for (let x = Math.max(roadHalf - 1, PROBE_STEP); x <= roadHalf + 8; x += PROBE_STEP) {
              if (walks.inside(px + nx * x, py + ny * x)) {
                if (first === 0) first = x
                outer = x
              } else if (outer > 0) break
            }
            if (outer > first && first > 0) walkSpans[into].push({ value: outer - first + PROBE_STEP, weight })
          }
        }
      }
    }
    const kerbLeft = weightedMiddle(kerbs.left, length, 0.5)
    const kerbRight = weightedMiddle(kerbs.right, length, 0.5)
    const walkLeft = weightedMiddle(walkSpans.left, length, 0.4)
    const walkRight = weightedMiddle(walkSpans.right, length, 0.4)
    if (kerbLeft === null && kerbRight === null && walkLeft === null && walkRight === null) continue
    for (const { k, forward } of run) {
      const s = segments[k]!
      out[k] = {
        ...s,
        props: fitKerbs(
          s.props,
          forward ? kerbLeft : kerbRight,
          forward ? kerbRight : kerbLeft,
          forward ? walkLeft : walkRight,
          forward ? walkRight : walkLeft,
        ),
      }
      if (kerbLeft !== null || kerbRight !== null) measured.add(k)
    }
  }
  return { segments: out, measured }
}

/**
 * A cross-section with its kerbs at measured distances from the centre
 * line (null: unmeasured, keep the guess), and sidewalk widths where
 * measured: lanes share the measured width (within reason), any rest is a
 * strip at road level beside them.
 */
function fitKerbs(
  given: StreetProps,
  kerbLeft: number | null,
  kerbRight: number | null,
  walkLeft: number | null,
  walkRight: number | null,
): StreetProps {
  const props = { ...given }
  const target = {
    left: kerbLeft === null ? null : Math.max(kerbLeft, 1.25),
    right: kerbRight === null ? null : Math.max(kerbRight, 1.25),
  }
  const side = (isLeft: boolean) => carriageway(props) + (isLeft ? props.bikeLeft + props.parkingLeft : props.bikeRight + props.parkingRight)
  // Both kerbs measured: the lanes take what they share (within reason).
  if (target.left !== null && target.right !== null) {
    const common = Math.min(target.left - side(true), target.right - side(false))
    const laneWidth = Math.min(Math.max(props.laneWidth + (2 * common) / props.lanes, LANE_WIDTHS[0]), LANE_WIDTHS[1])
    props.laneWidth = Math.round(laneWidth * 100) / 100
  }
  for (const isLeft of [true, false]) {
    const goal = isLeft ? target.left : target.right
    if (goal !== null) {
      // The rest on this side: a strip at road level (parking), or less of one.
      const key = isLeft ? 'parkingLeft' : 'parkingRight'
      const delta = Math.min(goal - side(isLeft), MOST_WIDER)
      props[key] = Math.round(Math.max(0, Math.min(props[key] + delta, MOST_WIDER)) * 100) / 100
    }
    const walk = isLeft ? walkLeft : walkRight
    if (walk !== null) {
      const width = Math.round(Math.min(Math.max(walk, 1), 6) * 100) / 100
      if (isLeft) props.sidewalkLeft = width
      else props.sidewalkRight = width
    }
  }
  return props
}

/**
 * Streets that lie on another all along (closer than their carriageways
 * are wide, so their roads overlap): the same street mapped twice, or one
 * of its lanes mapped as a street of its own. The lesser of the two goes;
 * if the two were the halves of a divided road, the one left takes both
 * directions.
 */
function withoutDuplicates(points: readonly Vec2[], segments: readonly Segment[]): Segment[] {
  const chains = chainsOf(points, segments)
  const chainOf = new Int32Array(segments.length)
  chains.forEach((c, i) => c.run.forEach(({ k }) => (chainOf[k] = i)))
  const grid = segmentGrid(points, segments, 8)
  const dropped = new Uint8Array(chains.length)
  const twoWay = new Set<number>()
  const rank = (c: Chain) => RANK[segments[c.run[0]!.k]!.props.kind ?? 'residential'] ?? 3
  const order = chains.map((_, i) => i).sort((x, y) => rank(chains[x]!) - rank(chains[y]!) || chains[x]!.length - chains[y]!.length)
  for (const c of order) {
    const chain = chains[c]!
    // Points along it, about every 3 m (each on its segment's level: a bridge over a street isn't that street twice).
    const samples: (Vec2 & { level: number })[] = []
    for (const { k } of chain.run) {
      const s = segments[k]!
      const a = points[s.a]!
      const b = points[s.b]!
      const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 3))
      for (let i = 0; i <= n; i++) samples.push({ x: a.x + ((b.x - a.x) * i) / n, y: a.y + ((b.y - a.y) * i) / n, level: s.props.level ?? 0 })
    }
    const nearest = (p: Vec2 & { level: number }, only: number) => {
      let best = Infinity
      let bestChain = -1
      for (const k of grid.get(cellKey(p.x, p.y)) ?? []) {
        const other = chainOf[k]!
        if (other === c || dropped[other] || (only >= 0 && other !== only)) continue
        const s = segments[k]!
        if ((s.props.level ?? 0) !== p.level) continue
        const d = project(p, points[s.a]!, points[s.b]!).distance
        if (d < best) {
          best = d
          bestChain = other
        }
      }
      return { distance: best, chain: bestChain }
    }
    // The street it lies along: the one nearest its middle.
    const beside = nearest(samples[Math.floor(samples.length / 2)]!, -1).chain
    if (beside < 0) continue
    const own = segments[chain.run[0]!.k]!.props
    const other = segments[chains[beside]!.run[0]!.k]!.props
    const reach = Math.max(1.5, carriageway(own) + carriageway(other))
    if (!samples.every((p) => nearest(p, beside).distance <= reach)) continue
    // The lesser of the two goes (this one, unless the other is of a lower kind).
    const lesser = rank(chains[beside]!) < rank(chain) ? beside : c
    const kept = lesser === c ? beside : c
    dropped[lesser] = 1
    twoWay.delete(lesser)
    if (own.oneway && other.oneway && !twoWay.has(kept)) {
      // Running the other way? Compare the directions at the middle.
      const mid = chain.run[Math.floor(chain.run.length / 2)]!
      const s = segments[mid.k]!
      const p = points[s.a]!
      const q = points[s.b]!
      let best = Infinity
      let along = 0
      for (const { k } of chains[beside]!.run) {
        const o = segments[k]!
        const d = project({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }, points[o.a]!, points[o.b]!).distance
        if (d < best) {
          best = d
          along = (q.x - p.x) * (points[o.b]!.x - points[o.a]!.x) + (q.y - p.y) * (points[o.b]!.y - points[o.a]!.y)
        }
      }
      if (along < 0) twoWay.add(kept)
    }
  }
  const out: Segment[] = []
  segments.forEach((s, k) => {
    const c = chainOf[k]!
    if (dropped[c]) return
    if (twoWay.has(c)) {
      const props = s.props
      out.push({ ...s, props: { ...props, oneway: false, lanes: Math.max(2, props.lanes * 2) } })
    } else out.push(s)
  })
  return out
}

/**
 * No sidewalks down the middle of a divided road (a one-way carriageway
 * with another of the same kind running the other way close beside it),
 * where the median is wider than the two sidewalks would be: it's planted,
 * or carries the tram. (A narrower one keeps them: they meet as one paved
 * island, see layerStreetSurfaces.) Parking goes on that side too. Judged
 * for a whole street at a time (between junctions), so a sidewalk doesn't
 * come and go along it. Other streets close together keep their sidewalks:
 * layered, what lies on a road is cut away, and the rest paves the space
 * between them.
 */
function sidewalksBeside(points: readonly Vec2[], segments: readonly Segment[], median: number): Segment[] {
  const lines = segments.map((s) => {
    const a = points[s.a]!
    const b = points[s.b]!
    const length = Math.hypot(b.x - a.x, b.y - a.y) || 1
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, dx: (b.x - a.x) / length, dy: (b.y - a.y) / length, length }
  })
  const reach = Math.max(2 * median, 24)
  const grid = new Map<string, number[]>()
  lines.forEach((m, k) => {
    const key = `${Math.floor(m.x / reach)}:${Math.floor(m.y / reach)}`
    const list = grid.get(key)
    if (list) list.push(k)
    else grid.set(key, [k])
  })
  /** How far a street's road reaches to one side, and its sidewalk there. */
  const road = (props: StreetProps, left: boolean) =>
    carriageway(props) + (left ? props.bikeLeft + props.parkingLeft : props.bikeRight + props.parkingRight)
  const sidewalk = (props: StreetProps, left: boolean) => (left ? props.sidewalkLeft : props.sidewalkRight)
  // Per segment, which of its sides (as drawn) has another street close beside it, by length.
  const beside = segments.map((s, k) => {
    const flags = { left: 0, right: 0 }
    const m = lines[k]!
    const cx = Math.floor(m.x / reach)
    const cy = Math.floor(m.y / reach)
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        for (const j of grid.get(`${cx + dx}:${cy + dy}`) ?? []) {
          if (j === k) continue
          const other = segments[j]!
          if ((other.props.level ?? 0) !== (s.props.level ?? 0)) continue
          const o = lines[j]!
          const facing = m.dx * o.dx + m.dy * o.dy
          // Sharing a point, two segments are side by side only if they leave it the same way (a V), not where
          // a street carries on or turns.
          const shared = other.a === s.a || other.b === s.b ? 1 : other.a === s.b || other.b === s.a ? -1 : 0
          if (shared !== 0 && facing * shared < 0.85) continue
          // Alongside: parallel either way, side by side.
          if (Math.abs(facing) < 0.85) continue
          const ox = o.x - m.x
          const oy = o.y - m.y
          const along = ox * m.dx + oy * m.dy
          const across = -ox * m.dy + oy * m.dx
          if (Math.abs(along) > m.length / 2 + o.length / 2 || Math.abs(across) < 0.5) continue
          const left = across > 0
          // This street seen from the other: on its left if it's to the left of the other's direction.
          const otherLeft = -(m.x - o.x) * o.dy + (m.y - o.y) * o.dx > 0
          // The median: from one road's edge to the other's.
          const gap = Math.abs(across) - road(s.props, left) - road(other.props, otherLeft)
          const divided =
            facing < 0 &&
            !!s.props.oneway &&
            !!other.props.oneway &&
            (other.props.kind ?? 'residential') === (s.props.kind ?? 'residential') &&
            gap <= median &&
            gap > sidewalk(s.props, left) + sidewalk(other.props, otherLeft)
          if (!divided) continue
          if (left) flags.left = m.length
          else flags.right = m.length
        }
      }
    }
    return flags
  })

  const out = segments.slice()
  for (const { run, length } of chainsOf(points, segments)) {
    let left = 0
    let right = 0
    for (const { k, forward } of run) {
      left += forward ? beside[k]!.left : beside[k]!.right
      right += forward ? beside[k]!.right : beside[k]!.left
    }
    const noLeft = left >= length / 2
    const noRight = right >= length / 2
    if (!noLeft && !noRight) continue
    for (const { k, forward } of run) {
      const s = segments[k]!
      const l = forward ? noLeft : noRight
      const r = forward ? noRight : noLeft
      out[k] = {
        ...s,
        props: {
          ...s.props,
          ...(l ? { sidewalkLeft: 0, parkingLeft: 0 } : {}),
          ...(r ? { sidewalkRight: 0, parkingRight: 0 } : {}),
        },
      }
    }
  }
  return out
}
