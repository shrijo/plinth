import { intersection, offsetPolyline, slicePolyline, type MultiPolygon, type Street, type StreetPiece, type Vec2 } from '@plinth/core'
import type { Network } from './network.ts'

/**
 * Street bridges, as streets of the network: a bridge is the street it
 * carries, lifted. It joins the streets on the ground where it lands (a
 * junction there, or the street going straight on), so its carriageway,
 * lanes, sidewalks and markings are the street's, and its deck starts at
 * the street's own level where the ground stops, edge to edge. Between its
 * landings it rises clear of the water (or land) it crosses, on a deck with
 * a fascia, an underside and parapets.
 */

/** The deck's depth under the road (metres): its fascia shows this much below the surface. */
export const DECK = 0.9
/** Over water the deck's underside stays this far above the surface (metres). */
const WATER_CLEARANCE = 0.4
/** Over land, the road stays this far above the ground under it (metres). */
const LAND_CLEARANCE = 0.5
/** From a landing, the deck reaches its clearance over this far (metres): a ramp, not a step. */
const RAMP = 12
/** The deck's level is worked out this often along it (metres). */
const STATION = 2
/** Where the deck's underside is less than this above what's under it (metres), it lies on the ground: an abutment. */
const ABUTMENT = 1

export interface BridgedNetwork extends Network {
  /** Bridge ends cut off at the data's edge (node ids): the bridge goes on in the next tile. */
  cut: Set<string>
}

/**
 * The network on the ground with the street bridges' added (each tidied
 * as a network of its own, see streetMesh), their streets marked `bridge`.
 * Where a bridge ends at the place streets on the ground end (they ended
 * there apart, see NetworkOptions.apart), they all become one node: the
 * bridge lands there. Where one street meets it end to end, the bridge
 * takes that street's cross-section as far as it goes on unbranched, so
 * nothing changes where it lands.
 */
export function withBridges(network: Network, bridges: Network, isCut: (p: Vec2) => boolean): BridgedNetwork {
  const nodes = { ...network.nodes }
  const streets = { ...network.streets }
  const cut = new Set<string>()
  if (Object.keys(bridges.streets).length === 0) return { nodes, streets, cut }
  const place = (p: Vec2) => `${Math.round(p.x * 100)}:${Math.round(p.y * 100)}`
  // Every node by place, the ground's first: one node per place where a bridge lands.
  const atPlace = new Map<string, string>()
  const rename = new Map<string, string>()
  for (const node of Object.values(nodes)) {
    const key = place(node)
    const known = atPlace.get(key)
    if (known) rename.set(node.id, known)
    else atPlace.set(key, node.id)
  }
  for (const node of Object.values(bridges.nodes)) {
    const key = place(node)
    const known = atPlace.get(key)
    if (known) {
      rename.set(`b${node.id}`, known)
      continue
    }
    const id = `b${node.id}`
    nodes[id] = { ...node, id }
    atPlace.set(key, id)
    if (isCut(node)) cut.add(id)
  }
  for (const street of Object.values(bridges.streets)) {
    const id = `b${street.id}`
    streets[id] = { ...street, id, a: `b${street.a}`, b: `b${street.b}`, bridge: true }
  }
  // The streets that ended apart where a bridge lands now meet there.
  for (const street of Object.values(streets)) {
    const a = rename.get(street.a) ?? street.a
    const b = rename.get(street.b) ?? street.b
    if (a === street.a && b === street.b) continue
    if (a === b) delete streets[street.id]
    else streets[street.id] = { ...street, a, b }
  }
  for (const id of rename.keys()) delete nodes[id]

  // A bridge carrying on a street (one street on the ground meets it, end to end, the same way) takes its
  // cross-section, so nothing changes where it lands.
  const at = new Map<string, Street[]>()
  for (const street of Object.values(streets)) {
    for (const id of [street.a, street.b]) {
      const list = at.get(id)
      if (list) list.push(street)
      else at.set(id, [street])
    }
  }
  const taken = new Set<string>()
  for (const [node, meeting] of at) {
    const onGround = meeting.filter((s) => !s.bridge)
    if (onGround.length !== 1 || meeting.length !== 2) continue
    const street = onGround[0]!
    let bridge = meeting.find((s) => s.bridge)!
    if (taken.has(bridge.id) || (street.kind ?? 'residential') !== (bridge.kind ?? 'residential') || !!street.oneway !== !!bridge.oneway) continue
    // Going out along the bridge is going the ground street's way if it arrives here. A bridge street is turned
    // (its left the street's right) where going out runs against its own way.
    const forward = street.b === node
    if (street.oneway && forward !== (bridge.a === node)) continue
    // Along the bridge as far as it goes on unbranched.
    let from = node
    for (let guard = 0; guard < 1000 && !taken.has(bridge.id); guard++) {
      taken.add(bridge.id)
      const turned = forward !== (bridge.a === from)
      streets[bridge.id] = {
        ...streets[bridge.id]!,
        lanes: street.lanes,
        laneWidth: street.laneWidth,
        bikeLeft: turned ? street.bikeRight : street.bikeLeft,
        bikeRight: turned ? street.bikeLeft : street.bikeRight,
        parkingLeft: turned ? street.parkingRight : street.parkingLeft,
        parkingRight: turned ? street.parkingLeft : street.parkingRight,
        sidewalkLeft: turned ? street.sidewalkRight : street.sidewalkLeft,
        sidewalkRight: turned ? street.sidewalkLeft : street.sidewalkRight,
      }
      const next = bridge.a === from ? bridge.b : bridge.a
      const onward = at.get(next) ?? []
      if (onward.length !== 2 || onward.some((s) => !s.bridge)) break
      const following = onward.find((s) => s.id !== bridge.id)!
      from = next
      bridge = following
    }
  }
  return { nodes, streets, cut }
}

/** A bridge that carries no street of its own: a footway, a path, a railway or tram line (plan metres). */
export interface OtherBridge {
  points: Vec2[]
  width: number
  /** Walked on (a footway, a path): paved as a sidewalk; otherwise (tracks) at road level. */
  walk: boolean
}

/** A bridge beside a street's deck by no more than this (metres, past its edge) is part of the same bridge. */
const ALONGSIDE = 6

/**
 * The other bridges, with the street bridges' pieces: one mapped alongside
 * a street's deck (its sidewalks, mapped as footways of their own; tram
 * tracks down its middle) is part of that bridge, widening its deck out
 * to it at the deck's level, so the bridge is one structure; one on its
 * own (a footbridge, a railway bridge) is a span of its own, its deck laid
 * out the same way (see decksOf).
 */
export function withOtherBridges(pieces: readonly StreetPiece[], others: readonly OtherBridge[]): StreetPiece[] {
  const out = pieces.slice()
  const hosts = out
    .map((piece, index) => ({ piece, index, line: piece.line, sides: piece.line ? sidesOf(piece.line, piece) : null }))
    .filter((h): h is { piece: StreetPiece; index: number; line: Vec2[]; sides: { left: number; right: number; length: number } } => !!h.line && !!h.sides)
  others.forEach((other, i) => {
    const own = lengthOf(other.points)
    let best: { host: (typeof hosts)[number]; from: number; to: number; offset: number } | null = null
    for (const host of hosts) {
      const at = other.points.map((p) => projectSigned(host.line, p.x, p.y))
      const offset = at.reduce((sum, a) => sum + a.offset, 0) / at.length
      const from = Math.min(...at.map((a) => a.along))
      const to = Math.max(...at.map((a) => a.along))
      const edge = offset >= 0 ? host.sides.left : host.sides.right
      // Running along it (not across), beside it or on it, over its length.
      if (Math.abs(offset) - other.width / 2 > edge + ALONGSIDE) continue
      if (to - from < 0.5 * own || from > host.sides.length + 10 || to < -10) continue
      if (at.some((a) => Math.abs(a.offset - offset) > ALONGSIDE)) continue
      if (!best || Math.abs(offset) < Math.abs(best.offset)) best = { host, from, to, offset }
    }
    if (best) {
      const { host, offset } = best
      const side = offset >= 0 ? 1 : -1
      const edge = side > 0 ? host.sides.left : host.sides.right
      const reach = Math.abs(offset) + other.width / 2
      // On the deck already (tram tracks down the middle): nothing to add.
      if (reach <= edge + 0.3) return
      const from = Math.max(0, best.from)
      const to = Math.min(host.sides.length, best.to)
      const stretch = slicePolyline(host.line, from, to)
      if (stretch.length < 2 || to - from < 1) return
      const band = [...offsetPolyline(stretch, side * (edge - 0.05)), ...offsetPolyline(stretch, side * reach).reverse()].map(
        (p) => [p.x, p.y] as [number, number],
      )
      const piece = out[host.index]!
      out[host.index] = other.walk ? { ...piece, sidewalks: [...piece.sidewalks, [band]] } : { ...piece, road: [...piece.road, [band]] }
      return
    }
    // A span of its own.
    const half = other.width / 2
    const ring = bandOf(other.points, half)
    if (!ring) return
    const middle = pointAt(other.points, own / 2)
    out.push({
      key: `span:${i}`,
      road: other.walk ? [] : [[ring]],
      bike: [],
      parking: [],
      sidewalks: other.walk ? [[ring]] : [],
      markings: [],
      crosswalks: [],
      centre: middle,
      shared: false,
      bridge: true,
      line: other.points,
    })
  })
  return out
}

/** How far a piece's surfaces reach to either side of its centre line, and the line's length. */
function sidesOf(line: readonly Vec2[], piece: StreetPiece): { left: number; right: number; length: number } {
  let left = 0
  let right = 0
  for (const region of [piece.road, piece.bike, piece.parking, piece.sidewalks]) {
    for (const polygon of region) {
      for (const [x, y] of polygon[0] ?? []) {
        const { offset } = projectSigned(line, x, y)
        if (offset > 0) left = Math.max(left, offset)
        else right = Math.max(right, -offset)
      }
    }
  }
  return { left, right, length: lengthOf(line) }
}

/** Where a point lies against a line: how far along it, and how far to its left (negative: right). */
function projectSigned(line: readonly Vec2[], x: number, y: number): { along: number; offset: number } {
  let best = Infinity
  let along = 0
  let offset = 0
  let walked = 0
  for (let i = 1; i < line.length; i++) {
    const p = line[i - 1]!
    const q = line[i]!
    const dx = q.x - p.x
    const dy = q.y - p.y
    const l2 = dx * dx + dy * dy
    const l = Math.sqrt(l2)
    const raw = l2 === 0 ? 0 : ((x - p.x) * dx + (y - p.y) * dy) / l2
    // Past the line's ends, along it as it goes on straight.
    const t = i === 1 && raw < 0 ? raw : i === line.length - 1 && raw > 1 ? raw : Math.min(Math.max(raw, 0), 1)
    const d = Math.hypot(x - p.x - dx * t, y - p.y - dy * t)
    if (d < best) {
      best = d
      along = walked + l * t
      offset = dx * (y - p.y) - dy * (x - p.x) >= 0 ? d : -d
    }
    walked += l
  }
  return { along, offset }
}

/** The ground as a bridge sees it, at plan points (metres). */
export interface PlanGround {
  /** The street bed: where a bridge lands, the street's level. */
  bed(x: number, y: number): number
  /** The land (a basin under water). */
  land(x: number, y: number): number
  /** The water's surface, or null on land. */
  water(x: number, y: number): number | null
}

/** A bridge piece's deck. */
export interface Deck {
  id: number
  /** The deck's level at a plan point: its surfaces lie over it as a street's over its bed. */
  level(x: number, y: number): number
  /** How far down its fascia reaches there: the underside, or into the ground where it lies on it. */
  foot(x: number, y: number): number
  /** Of the piece's surfaces, where the deck lies on the ground (near its landings): the ground leaves itself out there. */
  low: MultiPolygon
}

/** What lies just beyond a point: a street on the ground, a bridge's deck, or nothing. */
export type Beyond = (x: number, y: number) => 'ground' | 'deck' | null

/**
 * The decks of the bridge pieces (see StreetPiece.bridge): each one's level
 * along its centre line, from the street's level where it lands (exactly
 * the bed there, so the deck and the street meet without a step), rising
 * clear of what it crosses (water by a clearance under the deck, land just
 * so), and back down where it lands again. An end cut
 * off by the tile's data takes the level of its other end; a junction on a
 * bridge, the level its landings average.
 */
export function decksOf(pieces: readonly StreetPiece[], network: BridgedNetwork, ground: PlanGround, beyond: Beyond): Map<StreetPiece, Deck> {
  const decks = new Map<StreetPiece, Deck>()
  const bridges = pieces.filter((p) => p.bridge)
  if (bridges.length === 0) return decks
  // Bridges joined to one another are one structure (a bridge mapped as several ways, a junction on a deck).
  const parent = new Map<string, string>()
  const find = (id: string): string => {
    let root = id
    while (parent.has(root)) root = parent.get(root)!
    if (root !== id) parent.set(id, root)
    return root
  }
  for (const street of Object.values(network.streets)) {
    if (!street.bridge) continue
    const a = find(street.a)
    const b = find(street.b)
    if (a !== b) parent.set(b, a)
  }
  const structureOf = (piece: StreetPiece): string | null => {
    const [kind, id] = piece.key.split(':') as [string, string]
    if (kind === 'junction') return network.nodes[id] ? find(id) : null
    const street = network.streets[id]
    return street ? find(street.a) : null
  }
  const cutEnds = [...network.cut].map((id) => network.nodes[id]!).filter(Boolean)
  const groundTop = (x: number, y: number) => {
    const water = ground.water(x, y)
    return water ?? ground.land(x, y)
  }
  const floor = (x: number, y: number) => {
    const water = ground.water(x, y)
    return water !== null ? water + DECK + WATER_CLEARANCE : ground.land(x, y) + LAND_CLEARANCE
  }

  // Each street piece's ends: where it lands (on the street's level there), where it's cut, or where it meets
  // another bridge's (the structure's level).
  type End = { kind: 'land' | 'cut' | 'deck'; level: number }
  const ends = new Map<StreetPiece, [End, End]>()
  const landed = new Map<string, number[]>()
  for (const piece of bridges) {
    const line = piece.line
    if (!line || line.length < 2) continue
    const endOf = (p: Vec2, q: Vec2): End => {
      // Just beyond the end, away from the piece.
      const d = Math.hypot(p.x - q.x, p.y - q.y) || 1
      const x = p.x + ((p.x - q.x) / d) * 0.05
      const y = p.y + ((p.y - q.y) / d) * 0.05
      const there = beyond(x, y)
      if (there === 'ground') return { kind: 'land', level: ground.bed(p.x, p.y) }
      if (there === 'deck') return { kind: 'deck', level: NaN }
      if (cutEnds.some((c) => Math.hypot(c.x - p.x, c.y - p.y) < 25)) return { kind: 'cut', level: NaN }
      // A bridge ending over water (the map stops it short of the deck it joins): at the bridge's level.
      if (ground.water(p.x, p.y) !== null) return { kind: 'deck', level: NaN }
      // One ending on land: it comes down where it ends.
      return { kind: 'land', level: ground.bed(p.x, p.y) }
    }
    const pair: [End, End] = [endOf(line[0]!, line[1]!), endOf(line[line.length - 1]!, line[line.length - 2]!)]
    ends.set(piece, pair)
    const structure = structureOf(piece)
    if (structure) {
      for (const end of pair) {
        if (end.kind !== 'land') continue
        const list = landed.get(structure)
        if (list) list.push(end.level)
        else landed.set(structure, [end.level])
      }
    }
  }
  const structureLevel = (piece: StreetPiece, x: number, y: number): number => {
    const list = landed.get(structureOf(piece) ?? '') ?? []
    const mean = list.length > 0 ? list.reduce((s, h) => s + h, 0) / list.length : -Infinity
    return Math.max(mean, floor(x, y))
  }

  let id = 0
  for (const piece of bridges) {
    const line = piece.line
    const surfaces: MultiPolygon = [...piece.road, ...piece.bike, ...piece.parking, ...piece.sidewalks]
    if (!line || line.length < 2) {
      // A junction where only bridges meet: level, at the structure's level.
      const c = piece.centre
      const level = structureLevel(piece, c.x, c.y)
      const lying = level - DECK - groundTop(c.x, c.y) < ABUTMENT
      decks.set(piece, {
        id: id++,
        level: () => level,
        foot: (x, y) => footAt(level, groundTop(x, y)),
        low: lying ? surfaces : [],
      })
      continue
    }
    const [start, end] = ends.get(piece)!
    const length = lengthOf(line)
    const head = line[0]!
    const tail = line[line.length - 1]!
    let h0 = start.kind === 'land' ? start.level : start.kind === 'deck' ? structureLevel(piece, head.x, head.y) : NaN
    let h1 = end.kind === 'land' ? end.level : end.kind === 'deck' ? structureLevel(piece, tail.x, tail.y) : NaN
    if (Number.isNaN(h0)) h0 = Number.isNaN(h1) ? structureLevel(piece, head.x, head.y) : h1
    if (Number.isNaN(h1)) h1 = h0
    const count = Math.max(1, Math.ceil(length / STATION))
    const stations = new Float64Array(count + 1)
    const points: Vec2[] = []
    for (let k = 0; k <= count; k++) {
      const s = (k / count) * length
      const p = pointAt(line, s)
      points.push(p)
      // Straight from one end to the other, and clear of what it crosses (the same clearance, wherever the
      // bridge, so decks side by side are level with each other), eased in from a landing, where it must
      // meet the street exactly.
      const base = h0 + (h1 - h0) * (s / length)
      const ease = Math.min(start.kind === 'land' ? smoothstep(s / RAMP) : 1, end.kind === 'land' ? smoothstep((length - s) / RAMP) : 1)
      stations[k] = base + Math.max(0, floor(p.x, p.y) - base) * ease
    }
    // Smoothed, the landings held where they are.
    for (let pass = 0; pass < 6; pass++) {
      const before = stations.slice()
      for (let k = 1; k < count; k++) stations[k] = (before[k - 1]! + 2 * before[k]! + before[k + 1]!) / 4
    }
    const levelAt = (s: number) => {
      const at = Math.min(Math.max(s / length, 0), 1) * count
      const k = Math.min(Math.floor(at), count - 1)
      return stations[k]! + (stations[k + 1]! - stations[k]!) * (at - k)
    }
    const level = (x: number, y: number) => levelAt(project(line, x, y))
    // Where it lies on the ground: runs of stations whose underside is near (or under) what's beneath.
    const lying = points.map((p, k) => stations[k]! - DECK - groundTop(p.x, p.y) < ABUTMENT)
    const low: MultiPolygon = []
    let k = 0
    while (k <= count) {
      if (!lying[k]) {
        k++
        continue
      }
      let j = k
      while (j < count && lying[j + 1]) j++
      const from = Math.max(0, ((k - 0.5) / count) * length)
      const to = Math.min(length, ((j + 0.5) / count) * length)
      const band = bandOf(slicePolyline(line, from, to), reach(line, surfaces) + 1)
      if (band) low.push(...intersection(surfaces, [[band]]))
      k = j + 1
    }
    decks.set(piece, { id: id++, level, foot: (x, y) => footAt(level(x, y), groundTop(x, y)), low })
  }
  return decks
}

/** How far down a deck's fascia reaches: its underside where it stands clear, into the ground where it lies on it, eased between. */
function footAt(level: number, under: number): number {
  const underside = level - DECK
  const gap = underside - under
  if (gap >= ABUTMENT) return underside
  const into = under - 0.5
  if (gap <= 0) return Math.min(into, underside)
  return into + (underside - into) * (gap / ABUTMENT)
}

function smoothstep(t: number): number {
  const x = Math.min(Math.max(t, 0), 1)
  return x * x * (3 - 2 * x)
}

function lengthOf(line: readonly Vec2[]): number {
  let length = 0
  for (let i = 1; i < line.length; i++) length += Math.hypot(line[i]!.x - line[i - 1]!.x, line[i]!.y - line[i - 1]!.y)
  return length
}

function pointAt(line: readonly Vec2[], s: number): Vec2 {
  let walked = 0
  for (let i = 1; i < line.length; i++) {
    const p = line[i - 1]!
    const q = line[i]!
    const l = Math.hypot(q.x - p.x, q.y - p.y)
    if (walked + l >= s || i === line.length - 1) {
      const t = l === 0 ? 0 : Math.min(Math.max((s - walked) / l, 0), 1)
      return { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t }
    }
    walked += l
  }
  return line[line.length - 1]!
}

/** How far along a line the point nearest to (x, y) lies. */
function project(line: readonly Vec2[], x: number, y: number): number {
  let best = Infinity
  let at = 0
  let walked = 0
  for (let i = 1; i < line.length; i++) {
    const p = line[i - 1]!
    const q = line[i]!
    const dx = q.x - p.x
    const dy = q.y - p.y
    const l2 = dx * dx + dy * dy
    const l = Math.sqrt(l2)
    const t = l2 === 0 ? 0 : Math.min(Math.max(((x - p.x) * dx + (y - p.y) * dy) / l2, 0), 1)
    const d = Math.hypot(x - p.x - dx * t, y - p.y - dy * t)
    if (d < best) {
      best = d
      at = walked + l * t
    }
    walked += l
  }
  return at
}

/** How far a piece's surfaces reach from its centre line. */
function reach(line: readonly Vec2[], surfaces: MultiPolygon): number {
  let most = 0
  for (const polygon of surfaces) {
    for (const [x, y] of polygon[0] ?? []) {
      let best = Infinity
      for (let i = 1; i < line.length; i++) {
        const p = line[i - 1]!
        const q = line[i]!
        const dx = q.x - p.x
        const dy = q.y - p.y
        const l2 = dx * dx + dy * dy
        const t = l2 === 0 ? 0 : Math.min(Math.max(((x - p.x) * dx + (y - p.y) * dy) / l2, 0), 1)
        best = Math.min(best, Math.hypot(x - p.x - dx * t, y - p.y - dy * t))
      }
      most = Math.max(most, best)
    }
  }
  return most
}

/** The strip `half` either side of a line, as a ring (square ends). */
function bandOf(line: readonly Vec2[], half: number): [number, number][] | null {
  if (line.length < 2) return null
  const left: [number, number][] = []
  const right: [number, number][] = []
  for (let i = 0; i < line.length; i++) {
    const p = line[i]!
    const a = line[Math.max(0, i - 1)]!
    const b = line[Math.min(line.length - 1, i + 1)]!
    const dx = b.x - a.x
    const dy = b.y - a.y
    const l = Math.hypot(dx, dy) || 1
    const nx = -dy / l
    const ny = dx / l
    left.push([p.x + nx * half, p.y + ny * half])
    right.push([p.x - nx * half, p.y - ny * half])
  }
  return [...left, ...right.reverse()]
}
