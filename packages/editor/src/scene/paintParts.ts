import type { MeshData, WallFootprint } from '@plinth/core'
import { paint, type PaintedMesh } from './geometry.ts'

/** Colours for a wall: its outside face, inside faces and top. */
export interface WallColours {
  facade: string
  interior: string
  cap: string
  /** Which face is outside (see LevelAnalysis.exteriorSides), or null for an inside wall. */
  outside: 1 | -1 | 0 | null
}

/** Paints a wall mesh: the facade colour on outside faces, the interior colour inside and in reveals, the cap on top. */
export function paintWall(mesh: MeshData, footprint: WallFootprint, { facade, interior, cap, outside }: WallColours): PaintedMesh {
  // The wall's left in world terms: plan (x, y) is world (x, -y).
  const length = Math.hypot(footprint.b.x - footprint.a.x, footprint.b.y - footprint.a.y) || 1
  const lx = -(footprint.b.y - footprint.a.y) / length
  const ly = (footprint.b.x - footprint.a.x) / length
  return paint(mesh, (nx, ny, nz) => {
    if (ny > 0.5) return cap
    const side = nx * lx - nz * ly
    if (side > 0.5) return outside === 1 || outside === 0 ? facade : interior
    if (side < -0.5) return outside === -1 || outside === 0 ? facade : interior
    return interior
  })
}

/** Paints a slab: its top (floor or roof), edges and underside. */
export function paintSlab(mesh: MeshData, top: string, side: string, bottom: string): PaintedMesh {
  return paint(mesh, (_x, ny) => (ny > 0.5 ? top : ny < -0.5 ? bottom : side))
}
