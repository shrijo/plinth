import Constrainautor from './vendor/constrainautor.js'
import Delaunator from 'delaunator'
import earcut from 'earcut'

/**
 * A polygon with holes as triangles: a constrained Delaunay triangulation,
 * whose triangles join points near one another (cutting ears off a street
 * plan instead leaves thousands of slivers running from every point of a
 * kerb's curve to the far end of the street). Returns the points (x, y
 * interleaved) and the triangles' corners as indices into them.
 */
export function triangulate(rings: readonly (readonly [number, number][])[]): { points: number[]; triangles: number[] } {
  // The same place is the same point (rings may touch at a corner).
  const points: number[] = []
  const byPlace = new Map<number, number>()
  const edges: [number, number][] = []
  for (const ring of rings) {
    const count = ring.length > 1 && ring[0]![0] === ring[ring.length - 1]![0] && ring[0]![1] === ring[ring.length - 1]![1] ? ring.length - 1 : ring.length
    if (count < 3) continue
    const indices: number[] = []
    for (let i = 0; i < count; i++) {
      const [x, y] = ring[i]!
      const key = (Math.round(x * 1000) + 67108864) * 134217728 + Math.round(y * 1000) + 67108864
      let index = byPlace.get(key)
      if (index === undefined) {
        index = points.length / 2
        points.push(x, y)
        byPlace.set(key, index)
      }
      if (indices[indices.length - 1] !== index) indices.push(index)
    }
    if (indices.length > 1 && indices[0] === indices[indices.length - 1]) indices.pop()
    if (indices.length < 3) continue
    for (let i = 0; i < indices.length; i++) edges.push([indices[i]!, indices[(i + 1) % indices.length]!])
  }
  if (points.length < 6) return { points, triangles: [] }
  try {
    const delaunay = new Delaunator(Float64Array.from(points))
    const constrained = new Constrainautor(delaunay)
    constrained.constrainAll(edges)
    const { triangles, halfedges } = delaunay
    const count = triangles.length / 3
    // Inside or out, flooding in from the hull: each constrained edge crossed is the polygon's edge.
    const inside = new Int8Array(count).fill(-1)
    const queue: number[] = []
    for (let e = 0; e < halfedges.length; e++) {
      if (halfedges[e] !== -1) continue
      const t = Math.floor(e / 3)
      if (inside[t] !== -1) continue
      inside[t] = constrained.isConstrained(e) ? 1 : 0
      queue.push(t)
    }
    while (queue.length > 0) {
      const t = queue.pop()!
      for (let k = 0; k < 3; k++) {
        const e = t * 3 + k
        const other = halfedges[e]!
        if (other === -1) continue
        const u = Math.floor(other / 3)
        if (inside[u] !== -1) continue
        inside[u] = constrained.isConstrained(e) ? 1 - inside[t]! : inside[t]!
        queue.push(u)
      }
    }
    const out: number[] = []
    for (let t = 0; t < count; t++) if (inside[t] === 1) out.push(triangles[t * 3]!, triangles[t * 3 + 1]!, triangles[t * 3 + 2]!)
    return { points, triangles: out }
  } catch {
    // A shape it can't take (edges through points, say): ears instead.
    const flat: number[] = []
    const holes: number[] = []
    rings.forEach((ring, r) => {
      if (r > 0) holes.push(flat.length / 2)
      for (const [x, y] of ring) flat.push(x, y)
    })
    return { points: flat, triangles: earcut(flat, holes, 2) }
  }
}
