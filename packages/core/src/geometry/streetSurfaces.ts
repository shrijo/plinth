import { difference, ringArea, type MultiPolygon, type PolygonRings, type Ring } from './regions.ts'
import type { StreetPiece } from './streets.ts'

/**
 * The street pieces' surfaces layered the way road tools in games lay
 * theirs: where surfaces of different kinds overlap (as they do where map
 * data runs streets close together, or many meet at once), the one higher
 * in the order wins. The carriageway comes first, so a sidewalk never lies
 * on a road; then bike lanes, parking, paved zones (living streets,
 * pedestrian zones), and the sidewalks last: they keep what's left of
 * their strips. Surfaces of one kind may overlap each other (they look
 * the same, so two sidewalks that meet read as one paved island); only
 * what a higher surface covers is cut away, so a network of thousands of
 * pieces is layered in about the time it takes to find its overlaps.
 */
export interface StreetSurfaces {
  road: MultiPolygon
  bike: MultiPolygon
  parking: MultiPolygon
  /** Living streets and pedestrian zones: paving at road level. */
  paved: MultiPolygon
  sidewalks: MultiPolygon
}

/** Bits of surface smaller than this (square metres) are left out. */
const CRUMB = 0.5
/** And strips thinner than about twice this (area over perimeter, metres): slivers between two surfaces. */
const SLIVER = 0.12
/** Surfaces that only touch, or overlap by less than this (metres), don't count as overlapping. */
const TOUCH = 0.03
/** Grid cells for finding surfaces near each other (metres). */
const CELL = 40

const LAYERS = ['road', 'bike', 'parking', 'paved', 'sidewalks'] as const
type Layer = (typeof LAYERS)[number]

interface Surface {
  layer: number
  ring: Ring
  /** Holes in it (a square around a fountain). */
  holes: Ring[]
  minX: number
  minY: number
  maxX: number
  maxY: number
}

function surfaceOf(layer: number, ring: Ring, holes: Ring[] = []): Surface {
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity]
  for (const [x, y] of ring) {
    minX = Math.min(minX, x)
    maxX = Math.max(maxX, x)
    minY = Math.min(minY, y)
    maxY = Math.max(maxY, y)
  }
  return { layer, ring, holes, minX, minY, maxX, maxY }
}

/** How far a point is from a ring's edges. */
function edgeDistance(x: number, y: number, ring: Ring): number {
  let best = Infinity
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, ay] = ring[j]!
    const [bx, by] = ring[i]!
    const dx = bx - ax
    const dy = by - ay
    const l = dx * dx + dy * dy
    const t = l === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l))
    best = Math.min(best, Math.hypot(x - ax - dx * t, y - ay - dy * t))
  }
  return best
}

function inside(x: number, y: number, ring: Ring): boolean {
  let hit = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!
    const [xj, yj] = ring[j]!
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit
  }
  return hit
}

/** Whether two rings overlap by more than a touch: a corner of one well inside the other, or edges crossing. */
function overlap(a: Surface, b: Surface): boolean {
  if (a.maxX <= b.minX + TOUCH || b.maxX <= a.minX + TOUCH || a.maxY <= b.minY + TOUCH || b.maxY <= a.minY + TOUCH) return false
  // Only what lies where the two's bounds overlap can matter (a large square against a small road: most of its
  // edges are far away).
  const x0 = Math.max(a.minX, b.minX) - TOUCH
  const x1 = Math.min(a.maxX, b.maxX) + TOUCH
  const y0 = Math.max(a.minY, b.minY) - TOUCH
  const y1 = Math.min(a.maxY, b.maxY) + TOUCH
  const within = (x: number, y: number) => x >= x0 && x <= x1 && y >= y0 && y <= y1
  for (const [x, y] of a.ring) if (within(x, y) && inside(x, y, b.ring) && edgeDistance(x, y, b.ring) > TOUCH) return true
  for (const [x, y] of b.ring) if (within(x, y) && inside(x, y, a.ring) && edgeDistance(x, y, a.ring) > TOUCH) return true
  // Edges crossing well inside both (two strips crossing each other have no corner inside the other).
  const edges = (ring: Ring) => {
    const list: [number, number, number, number][] = []
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [px, py] = ring[j]!
      const [qx, qy] = ring[i]!
      if (Math.max(px, qx) < x0 || Math.min(px, qx) > x1 || Math.max(py, qy) < y0 || Math.min(py, qy) > y1) continue
      list.push([px, py, qx, qy])
    }
    return list
  }
  const eb = edges(b.ring)
  if (eb.length === 0) return false
  for (const [px, py, qx, qy] of edges(a.ring)) {
    const dx = qx - px
    const dy = qy - py
    const la = Math.hypot(dx, dy)
    for (const [rx, ry, sx, sy] of eb) {
      const ex = sx - rx
      const ey = sy - ry
      const den = dx * ey - dy * ex
      if (Math.abs(den) < 1e-12) continue
      const t = ((rx - px) * ey - (ry - py) * ex) / den
      const u = ((rx - px) * dy - (ry - py) * dx) / den
      const lb = Math.hypot(ex, ey)
      // Clear of the ends, and not at a grazing angle (strips running along each other only touch).
      if (t * la > TOUCH && (1 - t) * la > TOUCH && u * lb > TOUCH && (1 - u) * lb > TOUCH && Math.abs(den) / (la * lb) > 0.05) return true
    }
  }
  return false
}

/** A region without crumbs and slivers. */
function withoutSlivers(region: MultiPolygon): MultiPolygon {
  return region.filter((polygon: PolygonRings) => {
    const outer = polygon[0]
    if (!outer) return false
    const area = Math.abs(ringArea(outer)) - polygon.slice(1).reduce((sum, hole) => sum + Math.abs(ringArea(hole)), 0)
    if (area < CRUMB) return false
    let perimeter = 0
    for (let i = 0; i < outer.length; i++) {
      const [x0, y0] = outer[i]!
      const [x1, y1] = outer[(i + 1) % outer.length]!
      perimeter += Math.hypot(x1 - x0, y1 - y0)
    }
    return area / perimeter >= SLIVER
  })
}

/** Islands smaller than this (square metres) of one surface in another are crumbs: they become what's round them. */
const ISLAND = 15

/** The share of an island's edge that must border road for it to count as surrounded. */
const SURROUNDED = 0.85

/**
 * The pieces with their surfaces layered (see StreetSurfaces): each piece's
 * bike and parking lanes, paving and sidewalks lose what a surface higher
 * in the order covers, and crumbs of sidewalk stranded in a junction
 * become road. Pieces nothing covers are returned as they were.
 */
export function layerStreetPieces(pieces: readonly StreetPiece[]): StreetPiece[] {
  const surfaces: (Surface & { piece: number })[] = []
  pieces.forEach((piece, index) => {
    const regions: Record<Layer, MultiPolygon> = {
      road: piece.shared ? [] : piece.road,
      bike: piece.bike,
      parking: piece.parking,
      paved: piece.shared ? piece.road : [],
      sidewalks: piece.sidewalks,
    }
    LAYERS.forEach((layer, l) => {
      for (const polygon of regions[layer]) {
        if (polygon[0] && polygon[0].length >= 3) surfaces.push({ ...surfaceOf(l, polygon[0], polygon.slice(1)), piece: index })
      }
    })
  })
  // Surfaces that win over others (all but sidewalks), by grid cell.
  const grid = new Map<string, number[]>()
  const cellsOf = (s: Surface, visit: (key: string) => void) => {
    for (let y = Math.floor(s.minY / CELL); y <= Math.floor(s.maxY / CELL); y++) {
      for (let x = Math.floor(s.minX / CELL); x <= Math.floor(s.maxX / CELL); x++) visit(`${x}:${y}`)
    }
  }
  surfaces.forEach((s, k) => {
    if (s.layer === LAYERS.length - 1) return
    cellsOf(s, (key) => {
      const list = grid.get(key)
      if (list) list.push(k)
      else grid.set(key, [k])
    })
  })

  const out: Record<Layer, MultiPolygon>[] = pieces.map(() => ({ road: [], bike: [], parking: [], paved: [], sidewalks: [] }))
  const changed = new Set<number>()
  surfaces.forEach((s, k) => {
    const layer = LAYERS[s.layer]!
    const polygon: PolygonRings = [s.ring, ...s.holes]
    const own = out[s.piece]!
    if (s.layer === 0) {
      own.road.push(polygon)
      return
    }
    // What covers it: surfaces higher in the order that overlap it.
    const covering = new Set<number>()
    cellsOf(s, (key) => {
      for (const j of grid.get(key) ?? []) {
        if (j === k || covering.has(j)) continue
        const other = surfaces[j]!
        if (other.layer < s.layer && overlap(s, other)) covering.add(j)
      }
    })
    if (covering.size === 0) {
      own[layer].push(polygon)
      return
    }
    changed.add(s.piece)
    const left = difference([polygon], ...[...covering].map((j) => [[surfaces[j]!.ring]] as MultiPolygon))
    own[layer].push(...withoutSlivers(left))
  })

  // Crumbs: small islands of one surface stranded in another. A bit of sidewalk with road all round it (the
  // corners of a cluster of junctions leave them) is road; a scrap of road with paving all round it (the end of
  // a stub) is paving.
  interface Crumb {
    piece: number
    road: boolean
    polygon: PolygonRings
    area: number
    box: Surface
  }
  const crumbs: Crumb[] = []
  const found = new Map<string, number[]>()
  out.forEach((own, index) => {
    for (const [road, list] of [
      [true, [...own.road, ...own.bike, ...own.parking, ...own.paved]],
      [false, own.sidewalks],
    ] as const) {
      for (const polygon of list) {
        const crumb: Crumb = { piece: index, road, polygon, area: Math.abs(ringArea(polygon[0]!)), box: surfaceOf(0, polygon[0]!) }
        const k = crumbs.push(crumb) - 1
        cellsOf(crumb.box, (key) => {
          const cell = found.get(key)
          if (cell) cell.push(k)
          else found.set(key, [k])
        })
      }
    }
  })
  /** What lies at a point, other than the crumb itself: road, paving, or nothing. */
  const at = (x: number, y: number, self: number): Crumb | null => {
    for (const j of found.get(`${Math.floor(x / CELL)}:${Math.floor(y / CELL)}`) ?? []) {
      if (j === self) continue
      const c = crumbs[j]!
      if (x >= c.box.minX && x <= c.box.maxX && y >= c.box.minY && y <= c.box.maxY && inside(x, y, c.polygon[0]!)) return c
    }
    return null
  }
  /** The share of points just outside a ring's edges that `counts`. */
  const surroundedBy = (k: number, counts: (c: Crumb | null) => boolean) => {
    const outer = crumbs[k]!.polygon[0]!
    const turn = ringArea(outer) > 0 ? 1 : -1
    let samples = 0
    let hits = 0
    for (let i = 0; i < outer.length; i++) {
      const [ax, ay] = outer[i]!
      const [bx, by] = outer[(i + 1) % outer.length]!
      const length = Math.hypot(bx - ax, by - ay)
      if (length < 1e-6) continue
      // Outwards: to the right of an anticlockwise ring.
      const nx = (turn * (by - ay)) / length
      const ny = (-turn * (bx - ax)) / length
      const steps = Math.max(1, Math.ceil(length / 1.5))
      for (let t = 0; t < steps; t++) {
        const f = (t + 0.5) / steps
        samples++
        if (counts(at(ax + (bx - ax) * f + nx * 0.15, ay + (by - ay) * f + ny * 0.15, k))) hits++
      }
    }
    return samples > 0 ? hits / samples : 0
  }
  const small = (c: Crumb) => c.area < ISLAND && c.polygon.length === 1
  const moves: { k: number; toRoad: boolean }[] = []
  crumbs.forEach((c, k) => {
    if (!small(c) || pieces[c.piece]!.shared) return
    if (c.road) {
      // A scrap of road (only carriageway: bike and parking lanes belong to a road) with paving all round.
      if (!out[c.piece]!.road.includes(c.polygon)) return
      if (surroundedBy(k, (o) => !!o && !o.road) >= SURROUNDED) moves.push({ k, toRoad: false })
    } else if (surroundedBy(k, (o) => !!o && (o.road || small(o))) >= SURROUNDED) {
      // Road all round, or another crumb of sidewalk (an island can be the corners of two pieces).
      moves.push({ k, toRoad: true })
    }
  })
  for (const { k, toRoad } of moves) {
    const c = crumbs[k]!
    const own = out[c.piece]!
    if (toRoad) {
      own.sidewalks = own.sidewalks.filter((p) => p !== c.polygon)
      own.road.push(c.polygon)
    } else {
      own.road = own.road.filter((p) => p !== c.polygon)
      own.sidewalks.push(c.polygon)
    }
    changed.add(c.piece)
  }

  return pieces.map((piece, index) => {
    if (!changed.has(index)) return piece
    const own = out[index]!
    return {
      ...piece,
      road: piece.shared ? own.paved : own.road,
      bike: own.bike,
      parking: own.parking,
      sidewalks: own.sidewalks,
    }
  })
}

/** Layers the surfaces of the given pieces into one plan (see StreetSurfaces). */
export function layerStreetSurfaces(pieces: readonly StreetPiece[]): StreetSurfaces {
  const result: StreetSurfaces = { road: [], bike: [], parking: [], paved: [], sidewalks: [] }
  for (const piece of layerStreetPieces(pieces)) {
    if (piece.shared) result.paved.push(...piece.road)
    else result.road.push(...piece.road)
    result.bike.push(...piece.bike)
    result.parking.push(...piece.parking)
    result.sidewalks.push(...piece.sidewalks)
  }
  return result
}
