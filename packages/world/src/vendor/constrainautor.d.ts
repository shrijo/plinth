/** A Delaunay triangulation (as Delaunator's) made to keep given edges: see @kninnug/constrainautor. */
export default class Constrainautor {
  constructor(delaunay: { coords: ArrayLike<number>; triangles: Uint32Array; halfedges: Int32Array; hull: Uint32Array })
  /** Makes each pair of points an edge of the triangulation, and restores the Delaunay condition round them. */
  constrainAll(edges: readonly [number, number][]): this
  /** Whether a half-edge is one of the edges kept. */
  isConstrained(edge: number): boolean
}
