import type { Terrain } from '@plinth/core'
import type { PaintedMesh } from './geometry.ts'

/** A corner while cutting: plan position, height over the ground, colour. */
type Corner = [x: number, y: number, lift: number, r: number, g: number, b: number]

const lerpCorner = (p: Corner, q: Corner, t: number): Corner => p.map((v, i) => v + (q[i]! - v) * t) as Corner

/** The part of a polygon on the inside of a line (where `side` is positive), keeping its order. */
function clipBy(polygon: Corner[], side: (c: Corner) => number): Corner[] {
  const out: Corner[] = []
  for (let i = 0; i < polygon.length; i++) {
    const p = polygon[i]!
    const q = polygon[(i + 1) % polygon.length]!
    const dp = side(p)
    const dq = side(q)
    if (dp >= 0) out.push(p)
    if (dp >= 0 !== dq >= 0) out.push(lerpCorner(p, q, dp / (dp - dq)))
  }
  return out
}

/**
 * Laying flat meshes (streets) exactly on the site's terrain: every
 * triangle is cut along the terrain's own triangles, so each piece lies in
 * one of them and follows it exactly (sampling the ground only at points
 * leaves the terrain poking through wherever its slope changes between
 * them). Upright faces (kerbs) are cut where they cross the terrain's
 * edges the same way. Heights are drawn from `zero`.
 */
export function drapeOnTerrain<M extends PaintedMesh>(mesh: M, terrain: Terrain, zero: number): M {
  const { points, triangles } = terrain
  const count = triangles.length / 3
  // The terrain's triangles as planes (z = a·x + b·y + c), found through a grid.
  const planes = new Float64Array(count * 3)
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of points) {
    minX = Math.min(minX, p.x)
    minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x)
    maxY = Math.max(maxY, p.y)
  }
  const side = Math.max(1, Math.ceil(Math.sqrt(count / 2)))
  const cellW = Math.max((maxX - minX) / side, 1e-6)
  const cellH = Math.max((maxY - minY) / side, 1e-6)
  const cells: number[][] = Array.from({ length: side * side }, () => [])
  const cellOf = (v: number, min: number, size: number) => Math.min(side - 1, Math.max(0, Math.floor((v - min) / size)))
  for (let t = 0; t < count; t++) {
    const a = points[triangles[t * 3]!]!
    const b = points[triangles[t * 3 + 1]!]!
    const c = points[triangles[t * 3 + 2]!]!
    const det = (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)
    if (Math.abs(det) < 1e-9) continue
    const pa = ((b.z - a.z) * (c.y - a.y) - (c.z - a.z) * (b.y - a.y)) / det
    const pb = ((c.z - a.z) * (b.x - a.x) - (b.z - a.z) * (c.x - a.x)) / det
    planes[t * 3] = pa
    planes[t * 3 + 1] = pb
    planes[t * 3 + 2] = a.z - pa * a.x - pb * a.y
    for (let y = cellOf(Math.min(a.y, b.y, c.y), minY, cellH); y <= cellOf(Math.max(a.y, b.y, c.y), minY, cellH); y++) {
      for (let x = cellOf(Math.min(a.x, b.x, c.x), minX, cellW); x <= cellOf(Math.max(a.x, b.x, c.x), minX, cellW); x++) cells[y * side + x]!.push(t)
    }
  }
  const near = (x0: number, y0: number, x1: number, y1: number): Set<number> => {
    const found = new Set<number>()
    if (x1 < minX || x0 > maxX || y1 < minY || y0 > maxY) return found
    for (let y = cellOf(y0, minY, cellH); y <= cellOf(y1, minY, cellH); y++) {
      for (let x = cellOf(x0, minX, cellW); x <= cellOf(x1, minX, cellW); x++) for (const t of cells[y * side + x]!) found.add(t)
    }
    return found
  }
  const corner = (t: number, k: number): Corner => {
    const p = points[triangles[t * 3 + k]!]!
    return [p.x, p.y, 0, 0, 0, 0]
  }
  const heightIn = (t: number, x: number, y: number) => planes[t * 3]! * x + planes[t * 3 + 1]! * y + planes[t * 3 + 2]!
  /** Which terrain triangle a point lies in (for upright faces), or -1. */
  const under = (x: number, y: number, candidates: Iterable<number>) => {
    for (const t of candidates) {
      const [a, b, c] = [corner(t, 0), corner(t, 1), corner(t, 2)]
      const d1 = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0])
      const d2 = (c[0] - b[0]) * (y - b[1]) - (c[1] - b[1]) * (x - b[0])
      const d3 = (a[0] - c[0]) * (y - c[1]) - (a[1] - c[1]) * (x - c[0])
      const eps = -1e-9
      if ((d1 >= eps && d2 >= eps && d3 >= eps) || (d1 <= -eps && d2 <= -eps && d3 <= -eps)) return t
    }
    return -1
  }

  const { positions: p, indices } = mesh
  const colours = mesh.colors
  const outP: number[] = []
  const outC: number[] = []
  const emit = (polygon: Corner[], height: (c: Corner) => number) => {
    for (let i = 1; i + 1 < polygon.length; i++) {
      for (const c of [polygon[0]!, polygon[i]!, polygon[i + 1]!]) {
        outP.push(c[0], height(c) - zero + c[2], -c[1])
        if (colours) outC.push(c[3], c[4], c[5])
      }
    }
  }
  const area = (polygon: Corner[]) => {
    let sum = 0
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i]!
      const b = polygon[(i + 1) % polygon.length]!
      sum += a[0] * b[1] - b[0] * a[1]
    }
    return sum / 2
  }
  const fallback = (polygon: Corner[]) => {
    // Off the terrain: at the nearest triangle's height, or left as it is.
    emit(polygon, (c) => {
      const t = under(c[0], c[1], near(c[0] - 1, c[1] - 1, c[0] + 1, c[1] + 1))
      return t >= 0 ? heightIn(t, c[0], c[1]) : zero
    })
  }

  for (let i = 0; i < indices.length; i += 3) {
    const tri = [indices[i]!, indices[i + 1]!, indices[i + 2]!].map(
      (k): Corner => [p[k * 3]!, -p[k * 3 + 2]!, p[k * 3 + 1]!, colours?.[k * 3] ?? 0, colours?.[k * 3 + 1] ?? 0, colours?.[k * 3 + 2] ?? 0],
    )
    const [a, b, c] = tri as [Corner, Corner, Corner]
    const x0 = Math.min(a[0], b[0], c[0])
    const x1 = Math.max(a[0], b[0], c[0])
    const y0 = Math.min(a[1], b[1], c[1])
    const y1 = Math.max(a[1], b[1], c[1])
    const candidates = near(x0, y0, x1, y1)
    const whole = area(tri)
    if (Math.abs(whole) > 1e-6) {
      // Lying flat: cut along each terrain triangle under it.
      let covered = 0
      for (const t of candidates) {
        const [ta, tb, tc] = [corner(t, 0), corner(t, 1), corner(t, 2)]
        const turn = (tb[0] - ta[0]) * (tc[1] - ta[1]) - (tb[1] - ta[1]) * (tc[0] - ta[0]) > 0 ? 1 : -1
        let piece: Corner[] = tri
        for (const [e0, e1] of [
          [ta, tb],
          [tb, tc],
          [tc, ta],
        ] as const) {
          piece = clipBy(piece, (q) => turn * ((e1[0] - e0[0]) * (q[1] - e0[1]) - (e1[1] - e0[1]) * (q[0] - e0[0])))
          if (piece.length < 3) break
        }
        if (piece.length < 3) continue
        const size = Math.abs(area(piece))
        if (size < 1e-9) continue
        covered += size
        emit(piece, (q) => heightIn(t, q[0], q[1]))
      }
      // Anything the terrain doesn't reach.
      if (covered < Math.abs(whole) * 0.999) fallback(tri)
      continue
    }
    // Upright (a kerb): along its line in plan, cut where it crosses the terrain's edges.
    const pairs: [Corner, Corner][] = [
      [a, b],
      [b, c],
      [c, a],
    ]
    const [s0, s1] = pairs.reduce((best, pair) =>
      Math.hypot(pair[0][0] - pair[1][0], pair[0][1] - pair[1][1]) > Math.hypot(best[0][0] - best[1][0], best[0][1] - best[1][1]) ? pair : best,
    )
    const dx = s1[0] - s0[0]
    const dy = s1[1] - s0[1]
    const length2 = dx * dx + dy * dy
    if (length2 < 1e-12) {
      fallback(tri)
      continue
    }
    const along = (q: Corner) => ((q[0] - s0[0]) * dx + (q[1] - s0[1]) * dy) / length2
    const cuts = new Set<number>([0, 1])
    for (const t of candidates) {
      const corners = [corner(t, 0), corner(t, 1), corner(t, 2)]
      for (let e = 0; e < 3; e++) {
        const e0 = corners[e]!
        const e1 = corners[(e + 1) % 3]!
        const ex = e1[0] - e0[0]
        const ey = e1[1] - e0[1]
        const den = dx * ey - dy * ex
        if (Math.abs(den) < 1e-12) continue
        const u = ((e0[0] - s0[0]) * ey - (e0[1] - s0[1]) * ex) / den
        const v = ((e0[0] - s0[0]) * dy - (e0[1] - s0[1]) * dx) / den
        if (u > 1e-6 && u < 1 - 1e-6 && v >= 0 && v <= 1) cuts.add(u)
      }
    }
    const stops = [...cuts].sort((m, n) => m - n)
    for (let k = 0; k + 1 < stops.length; k++) {
      const from = stops[k]!
      const to = stops[k + 1]!
      let piece = clipBy(tri, (q) => along(q) - from)
      piece = clipBy(piece, (q) => to - along(q))
      if (piece.length < 3) continue
      // The stretch lies in one terrain triangle: the one under its middle.
      const middle = (from + to) / 2
      const t = under(s0[0] + dx * middle, s0[1] + dy * middle, candidates)
      if (t < 0) fallback(piece)
      else emit(piece, (q) => heightIn(t, q[0], q[1]))
    }
  }

  const vertexCount = outP.length / 3
  const positions = new Float32Array(outP)
  const normals = new Float32Array(vertexCount * 3)
  for (let k = 0; k < vertexCount; k += 3) {
    const ux = positions[k * 3 + 3]! - positions[k * 3]!
    const uy = positions[k * 3 + 4]! - positions[k * 3 + 1]!
    const uz = positions[k * 3 + 5]! - positions[k * 3 + 2]!
    const vx = positions[k * 3 + 6]! - positions[k * 3]!
    const vy = positions[k * 3 + 7]! - positions[k * 3 + 1]!
    const vz = positions[k * 3 + 8]! - positions[k * 3 + 2]!
    let nx = uy * vz - uz * vy
    let ny = uz * vx - ux * vz
    let nz = ux * vy - uy * vx
    const l = Math.hypot(nx, ny, nz) || 1
    nx /= l
    ny /= l
    nz /= l
    for (let j = 0; j < 3; j++) normals.set([nx, ny, nz], (k + j) * 3)
  }
  const out: PaintedMesh = { positions, normals, indices: Uint32Array.from({ length: vertexCount }, (_, i) => i) }
  if (colours) out.colors = new Float32Array(outC)
  return out as M
}
