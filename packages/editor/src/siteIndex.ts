import { pointInRing, streetGeometry, type BuildingAnalysis, type Id, type Snapshot, type Vec2 } from '@plinth/core'

/**
 * Spatial lookups on the site, for cities too large to search item by item
 * on every pointer move: a grid of cells, each listing what lies in it.
 */

const CELL = 60

export class Grid<T> {
  private readonly cells = new Map<string, T[]>()

  add(item: T, minX: number, minY: number, maxX: number, maxY: number): void {
    for (let ix = Math.floor(minX / CELL); ix <= Math.floor(maxX / CELL); ix++) {
      for (let iy = Math.floor(minY / CELL); iy <= Math.floor(maxY / CELL); iy++) {
        const key = `${ix},${iy}`
        const list = this.cells.get(key)
        if (list) list.push(item)
        else this.cells.set(key, [item])
      }
    }
  }

  /** Items in the cells within `radius` of a point (each once). */
  near(p: Vec2, radius: number): T[] {
    const found = new Set<T>()
    for (let ix = Math.floor((p.x - radius) / CELL); ix <= Math.floor((p.x + radius) / CELL); ix++) {
      for (let iy = Math.floor((p.y - radius) / CELL); iy <= Math.floor((p.y + radius) / CELL); iy++) {
        for (const item of this.cells.get(`${ix},${iy}`) ?? []) found.add(item)
      }
    }
    return [...found]
  }
}

function bounds(points: readonly Vec2[]): [number, number, number, number] {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of points) {
    minX = Math.min(minX, p.x)
    maxX = Math.max(maxX, p.x)
    minY = Math.min(minY, p.y)
    maxY = Math.max(maxY, p.y)
  }
  return [minX, minY, maxX, maxY]
}

const streetGrids = new WeakMap<object, Grid<{ id: Id; outline: Vec2[] }>>()

/** The street whose outline (road and sidewalks) contains a point on the ground. */
export function streetAt(snapshot: Snapshot, p: Vec2): Id | null {
  const geometry = streetGeometry(snapshot)
  let grid = streetGrids.get(geometry)
  if (!grid) {
    grid = new Grid()
    for (const [id, outline] of geometry.outlines) {
      const [minX, minY, maxX, maxY] = bounds(outline)
      grid.add({ id, outline }, minX, minY, maxX, maxY)
    }
    streetGrids.set(geometry, grid)
  }
  for (const street of grid.near(p, 0)) if (pointInRing(p, street.outline)) return street.id
  return null
}

const nodeGrids = new WeakMap<object, Grid<Id>>()

/** Street points within `radius` of a point. */
export function streetNodesNear(snapshot: Snapshot, p: Vec2, radius: number): Id[] {
  let grid = nodeGrids.get(snapshot.streetNodes)
  if (!grid) {
    grid = new Grid()
    for (const node of Object.values(snapshot.streetNodes)) grid.add(node.id, node.x, node.y, node.x, node.y)
    nodeGrids.set(snapshot.streetNodes, grid)
  }
  return grid.near(p, radius)
}

interface Segment {
  id: Id
  a: Vec2
  b: Vec2
}

const segmentGrids = new WeakMap<object, Grid<Segment>>()

function segmentGrid(key: object, make: () => Segment[]): Grid<Segment> {
  let grid = segmentGrids.get(key)
  if (!grid) {
    grid = new Grid()
    for (const s of make()) {
      grid.add(s, Math.min(s.a.x, s.b.x), Math.min(s.a.y, s.b.y), Math.max(s.a.x, s.b.x), Math.max(s.a.y, s.b.y))
    }
    segmentGrids.set(key, grid)
  }
  return grid
}

/** Street centre lines (sampled along curves) within `radius` of a point. */
export function streetSegmentsNear(snapshot: Snapshot, p: Vec2, radius: number): Segment[] {
  const geometry = streetGeometry(snapshot)
  return segmentGrid(geometry.centreLines, () =>
    [...geometry.centreLines].flatMap(([id, line]) => line.slice(1).map((b, i) => ({ id, a: line[i]!, b }))),
  ).near(p, radius)
}

/** The edges of buildings' ground-floor outlines within `radius` of a point. */
export function buildingEdgesNear(buildings: ReadonlyMap<Id, BuildingAnalysis>, p: Vec2, radius: number): Segment[] {
  return segmentGrid(buildings, () =>
    [...buildings.values()].flatMap((building) => {
      const ground = building.levels[0]
      if (!ground) return []
      return ground.outline.flatMap((polygon) =>
        polygon.flatMap((ring) =>
          ring.map(([x, y], i) => {
            const [x2, y2] = ring[(i + 1) % ring.length]!
            return { id: building.buildingId, a: { x, y }, b: { x: x2, y: y2 } }
          }),
        ),
      )
    }),
  ).near(p, radius)
}
