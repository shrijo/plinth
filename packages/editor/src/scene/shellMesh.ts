import type { Palette } from './materials.ts'
import { buildingColours } from './materials.ts'
import { paint, type PaintedMesh } from './geometry.ts'
import {
  buildSlabMesh,
  buildWallMesh,
  openingCopies,
  placeOpening,
  resolveWall,
  type BuildingAnalysis,
  type Id,
  type MeshData,
  type Meta,
  type Opening,
  type OpeningCut,
  type WallFootprint,
} from '@plinth/core'

/**
 * Buildings as the site shows them, each as a single mesh: one draw call
 * for its walls and slabs and one for its windows and doors, however many
 * floors it has. That keeps a city of hundreds of buildings quick to draw.
 */

/** Joins meshes into one (with their colours, if every part has them). */
export function concatMeshes(parts: readonly PaintedMesh[]): PaintedMesh {
  let vertices = 0
  let indices = 0
  for (const part of parts) {
    vertices += part.positions.length
    indices += part.indices.length
  }
  const positions = new Float32Array(vertices)
  const normals = new Float32Array(vertices)
  const coloured = parts.length > 0 && parts.every((p) => p.colors)
  const colors = coloured ? new Float32Array(vertices) : undefined
  const index = new Uint32Array(indices)
  let v = 0
  let i = 0
  for (const part of parts) {
    positions.set(part.positions, v)
    normals.set(part.normals, v)
    if (colors && part.colors) colors.set(part.colors, v)
    const base = v / 3
    for (let k = 0; k < part.indices.length; k++) index[i + k] = part.indices[k]! + base
    v += part.positions.length
    i += part.indices.length
  }
  return colors ? { positions, normals, indices: index, colors } : { positions, normals, indices: index }
}

/**
 * A building as the site shows it, painted (facade on the sides, roof
 * colour on top). A level whose walls are one simple loop is its outline
 * extruded through all its floors, roof included: one block for a whole
 * run of copies. Other levels show their outer walls and slabs.
 */
export function shellMesh(building: BuildingAnalysis, meta: Meta, palette: Palette): PaintedMesh {
  const { facade, roof, band } = buildingColours(building.buildingId, palette)
  const block = (ny: number) => (ny > 0.5 ? roof : facade)
  const slabColour = (ny: number) => (ny > 0.5 ? roof : band)
  const parts: PaintedMesh[] = []
  let detailed = false
  for (const level of building.levels) {
    const { elevation, height } = level.level
    if (level.simple && level.outline.length > 0) {
      parts.push(paint(buildSlabMesh(level.outline, elevation, elevation + height * level.floors), (_x, ny) => block(ny)))
      continue
    }
    detailed = true
    const walls = new Map(level.levelWalls.map((w) => [w.id, w]))
    for (let k = 0; k < level.floors; k++) {
      for (const wallId of level.exteriorWalls) {
        const wall = walls.get(wallId)
        const footprint = level.footprints.get(wallId)
        if (!wall || !footprint) continue
        const { heightStart, heightEnd } = resolveWall(wall, level.level, meta)
        const lift = level.topOffsets.get(wallId) ?? 0
        const base = elevation + k * height
        parts.push(paint(buildWallMesh(footprint, base, heightStart + lift, heightEnd + lift), (_x, ny) => block(ny)))
      }
    }
  }
  // Slabs only where walls were drawn one by one; blocks have their own tops and bottoms.
  if (detailed) {
    for (const slab of building.slabs) {
      const level = slab.levelId ? building.levels.find((l) => l.level.id === slab.levelId) : building.levels.at(-1)
      if (level?.simple) continue
      for (let k = 0; k < slab.count; k++) {
        const lift = k * slab.step
        parts.push(paint(buildSlabMesh(slab.region, slab.bottom + lift, slab.top + lift), (_x, ny) => slabColour(ny)))
      }
    }
  }
  return concatMeshes(parts)
}

/** How far window surrounds stand out from the facade, in metres. */
const SURROUND_DEPTH = 0.18

/**
 * The windows and doors in the outer walls, on every floor, as surrounds
 * standing out from the facade: a head, a sill and two jambs. The shells
 * have no holes; the surrounds cast the shadows a recessed window shows on
 * a white model (see surroundMaterial). Eight triangles each, so a tower's
 * thousands of windows stay light.
 */
export function paneMesh(building: BuildingAnalysis, meta: Meta, openings: ReadonlyMap<Id, readonly Opening[]>): MeshData {
  const fins: number[] = []
  for (const level of building.levels) {
    if (level.levelWalls.every((w) => !openings.has(w.id))) continue
    const walls = new Map(level.levelWalls.map((w) => [w.id, w]))
    for (const wallId of level.exteriorWalls) {
      const list = openings.get(wallId)
      const wall = walls.get(wallId)
      const footprint = level.footprints.get(wallId)
      if (!list || !wall || !footprint) continue
      const { heightStart, heightEnd } = resolveWall(wall, level.level, meta)
      const length = Math.hypot(footprint.b.x - footprint.a.x, footprint.b.y - footprint.a.y) || 1
      const dx = (footprint.b.x - footprint.a.x) / length
      const dy = (footprint.b.y - footprint.a.y) / length
      // Outside is to the wall's left (1), its right (-1), or both for a wall on its own (0).
      const side = level.exteriorSides.get(wallId) ?? 0
      const faces = side === 0 ? [1, -1] : [side]
      const out = footprint.thickness / 2
      for (const opening of list.flatMap(openingCopies)) {
        const cut = placeOpening(footprint, opening, heightStart, heightEnd)
        if (!cut) continue
        for (const face of faces) {
          // The wall's left normal is (-dy, dx).
          const nx = -dy * face
          const ny = dx * face
          // The corners of the opening on the facade.
          const x0 = footprint.a.x + dx * cut.start + nx * out
          const y0 = footprint.a.y + dy * cut.start + ny * out
          const x1 = footprint.a.x + dx * cut.end + nx * out
          const y1 = footprint.a.y + dy * cut.end + ny * out
          for (let k = 0; k < level.floors; k++) {
            const base = level.level.elevation + k * level.level.height
            surround(fins, [x0, y0], [x1, y1], [nx * SURROUND_DEPTH, ny * SURROUND_DEPTH], base + cut.sill, base + cut.head)
          }
        }
      }
    }
  }
  return finMesh(fins)
}

/**
 * The four sides of a window surround as upright or level strips, twelve
 * numbers each (four corners in world coordinates): from the facade corners
 * `a` and `b` (plan), standing out by `out` (plan), from `bottom` to `top`.
 */
function surround(fins: number[], a: [number, number], b: [number, number], out: [number, number], bottom: number, top: number) {
  // Plan (x, y) is world (x, -y).
  const corner = (p: [number, number], lift: boolean, z: number) => [p[0] + (lift ? out[0] : 0), z, -(p[1] + (lift ? out[1] : 0))]
  for (const z of [bottom, top]) fins.push(...corner(a, false, z), ...corner(b, false, z), ...corner(b, true, z), ...corner(a, true, z))
  for (const p of [a, b]) fins.push(...corner(p, false, bottom), ...corner(p, true, bottom), ...corner(p, true, top), ...corner(p, false, top))
}

/** Strips (four corners each) as one flat-shaded mesh, each facing along its own normal (the material shows both sides). */
function finMesh(fins: readonly number[]): MeshData {
  const count = fins.length / 12
  const positions = new Float32Array(fins)
  const normals = new Float32Array(count * 12)
  const indices = new Uint32Array(count * 6)
  for (let q = 0; q < count; q++) {
    const o = q * 12
    const ux = fins[o + 3]! - fins[o]!
    const uy = fins[o + 4]! - fins[o + 1]!
    const uz = fins[o + 5]! - fins[o + 2]!
    const vx = fins[o + 9]! - fins[o]!
    const vy = fins[o + 10]! - fins[o + 1]!
    const vz = fins[o + 11]! - fins[o + 2]!
    let nx = uy * vz - uz * vy
    let ny = uz * vx - ux * vz
    let nz = ux * vy - uy * vx
    const length = Math.hypot(nx, ny, nz) || 1
    nx /= length
    ny /= length
    nz /= length
    for (let c = 0; c < 4; c++) {
      normals[o + c * 3] = nx
      normals[o + c * 3 + 1] = ny
      normals[o + c * 3 + 2] = nz
    }
    const base = q * 4
    indices.set([base, base + 1, base + 2, base, base + 2, base + 3], q * 6)
  }
  return { positions, normals, indices }
}

/**
 * Glass in the holes cut through a wall: a pane at the middle of the wall,
 * facing both ways. For floors that are only shown, not edited.
 */
export function cutPanes(footprint: WallFootprint, cuts: readonly OpeningCut[], base: number): MeshData {
  const length = Math.hypot(footprint.b.x - footprint.a.x, footprint.b.y - footprint.a.y) || 1
  const dx = (footprint.b.x - footprint.a.x) / length
  const dy = (footprint.b.y - footprint.a.y) / length
  const quads: number[] = []
  for (const cut of cuts) {
    const along = (cut.start + cut.end) / 2
    const px = footprint.a.x + dx * along
    const py = footprint.a.y + dy * along
    const z = base + (cut.sill + cut.head) / 2
    for (const face of [1, -1]) quads.push(px, py, z, dx, dy, -dy * face, dx * face, cut.end - cut.start, cut.head - cut.sill)
  }
  return quadMesh(quads)
}

/** `count` copies of a mesh stacked upwards, `step` apart, the first `from` steps up. */
export function stackUp(mesh: PaintedMesh, from: number, count: number, step: number): PaintedMesh {
  if (count <= 0) return { positions: new Float32Array(), normals: new Float32Array(), indices: new Uint32Array() }
  if (count === 1 && from === 0) return mesh
  const copies: PaintedMesh[] = []
  for (let k = from; k < from + count; k++) {
    const positions = mesh.positions.slice()
    for (let i = 1; i < positions.length; i += 3) positions[i]! += k * step
    copies.push({ ...mesh, positions })
  }
  return concatMeshes(copies)
}

/** Where a building stands: the middle of its lowest level's outline, or of its walls. */
export function buildingCentre(building: BuildingAnalysis): { x: number; y: number } | null {
  const ground = building.levels[0]
  if (!ground) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  const take = (x: number, y: number) => {
    minX = Math.min(minX, x)
    maxX = Math.max(maxX, x)
    minY = Math.min(minY, y)
    maxY = Math.max(maxY, y)
  }
  if (ground.outline.length > 0) for (const [x, y] of ground.outline[0]?.[0] ?? []) take(x, y)
  else for (const fp of ground.footprints.values()) for (const p of fp.polygon) take(p.x, p.y)
  return Number.isFinite(minX) ? { x: (minX + maxX) / 2, y: (minY + maxY) / 2 } : null
}

/**
 * Upright rectangles, nine numbers each: centre (plan x, plan y, height),
 * direction along (plan), outward normal (plan), width and height. One
 * flat-shaded mesh in world coordinates (plan (x, y) is world (x, -y)).
 */
function quadMesh(quads: readonly number[]): MeshData {
  const count = quads.length / 9
  const positions = new Float32Array(count * 12)
  const normals = new Float32Array(count * 12)
  const indices = new Uint32Array(count * 6)
  for (let q = 0; q < count; q++) {
    const at = (i: number) => quads[q * 9 + i]!
    const px = at(0)
    const py = at(1)
    const pz = at(2)
    const dx = at(3)
    const dy = at(4)
    const nx = at(5)
    const ny = at(6)
    const hw = at(7) / 2
    const hh = at(8) / 2
    // Corners counter-clockwise seen from outside: along × up points out when the normal is to the wall's right.
    const flip = dx * ny - dy * nx > 0
    const s = flip ? -1 : 1
    const corners: [number, number][] = [
      [-hw * s, -hh],
      [hw * s, -hh],
      [hw * s, hh],
      [-hw * s, hh],
    ]
    for (let c = 0; c < 4; c++) {
      const [u, v] = corners[c]!
      const o = (q * 4 + c) * 3
      positions[o] = px + dx * u
      positions[o + 1] = pz + v
      positions[o + 2] = -(py + dy * u)
      normals[o] = nx
      normals[o + 1] = 0
      normals[o + 2] = -ny
    }
    const base = q * 4
    indices.set([base, base + 1, base + 2, base, base + 2, base + 3], q * 6)
  }
  return { positions, normals, indices }
}
