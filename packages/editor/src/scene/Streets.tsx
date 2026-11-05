import {
  buildSlabMesh,
  CURB_HEIGHT,
  streetGeometry,
  toRing,
  type Id,
  type MeshData,
  type StreetPiece,
  type Vec2,
} from '@plinth/core'
import { useFrame } from '@react-three/fiber'
import { memo, useMemo, useRef, useState } from 'react'
import { MeshStandardMaterial, type Mesh } from 'three'
import { useEditor, useSnapshot } from '../context.ts'
import { paint, useBufferGeometry, type PaintedMesh } from './geometry.ts'
import { COLORS, PALETTES, shade, streetHighlight, streetMaterials, type Palette } from './materials.ts'
import { Outline } from './Outline.tsx'
import { apparentDistance } from './lens.ts'
import { concatMeshes } from './shellMesh.ts'

/** Streets are drawn in square tiles of this size (metres): a base mesh and a paint mesh per tile. */
const TILE = 400
/** Road surfaces sit just above the ground; paint just above the road. */
const ROAD_TOP = 0.02
const PAINT_TOP = 0.03
/** Beyond this distance (metres) lane markings and crossings aren't drawn. */
const PAINT_DISTANCE = 600

/** Road, lanes and sidewalks in one mesh, coloured per vertex (they lie side by side, never on top of each other). */
const baseMaterial = new MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 })

/**
 * The street network: road, bike and parking lanes, raised sidewalks,
 * markings and zebra crossings. Built for very large networks: the pieces
 * (each street and each junction) are merged into a few meshes per tile of
 * the ground, and markings drop out with distance. Streets are picked
 * through a spatial index on the ground (see siteIndex), not by meshes; the
 * hovered and selected ones are drawn again on top.
 */
export function Streets() {
  const snapshot = useSnapshot()
  const geometry = streetGeometry(snapshot)
  const site = useEditor((s) => s.mode === 'site')
  const selected = useEditor((s) => s.selection.streets)
  const hover = useEditor((s) => s.hover)
  const outlines = useEditor((s) => s.showOutlines)
  const palette = PALETTES[useEditor((s) => s.style)]
  const [tiler] = useState(() => new StreetTiler())
  const tiles = useMemo(() => tiler.update(geometry.pieces, palette), [tiler, geometry.pieces, palette])

  const lit: [Id, 'hover' | 'selected'][] = []
  if (site) {
    for (const id of selected) lit.push([id, 'selected'])
    if (hover?.kind === 'street' && !selected.includes(hover.id)) lit.push([hover.id, 'hover'])
  }

  return (
    <group name="streets">
      {tiles.map((tile) => (
        <StreetTile key={tile.key} tile={tile} outlines={outlines} />
      ))}
      {lit.map(([id, look]) => {
        const outline = geometry.outlines.get(id)
        return outline ? <StreetHighlight key={id} outline={outline} look={look} /> : null
      })}
    </group>
  )
}

interface StreetTileData {
  key: string
  pieces: StreetPiece[]
  base: PaintedMesh
  paint: MeshData
  centre: [number, number]
}

/** Sorts street pieces into tiles and keeps each piece's meshes until it changes. */
class StreetTiler {
  private parts = new WeakMap<StreetPiece, { palette: Palette; base: PaintedMesh; paint: MeshData }>()
  private tiles = new Map<string, StreetTileData>()

  private partsOf(piece: StreetPiece, palette: Palette) {
    const hit = this.parts.get(piece)
    if (hit && hit.palette === palette) return hit
    const curb = shade(palette.sidewalk, -0.06)
    const base = concatMeshes([
      paint(buildSlabMesh(piece.road, -0.02, ROAD_TOP), () => palette.road),
      paint(buildSlabMesh(piece.bike, -0.02, ROAD_TOP), () => palette.bike),
      paint(buildSlabMesh(piece.parking, -0.02, ROAD_TOP), () => palette.parking),
      paint(buildSlabMesh(piece.sidewalks, 0, CURB_HEIGHT), (_x, ny) => (ny > 0.5 ? palette.sidewalk : curb)),
    ])
    const parts = { palette, base, paint: flatQuads([...piece.markings, ...piece.crosswalks], PAINT_TOP) }
    this.parts.set(piece, parts)
    return parts
  }

  update(pieces: readonly StreetPiece[], palette: Palette): StreetTileData[] {
    const groups = new Map<string, StreetPiece[]>()
    for (const piece of pieces) {
      const key = `${Math.floor(piece.centre.x / TILE)},${Math.floor(piece.centre.y / TILE)}`
      const list = groups.get(key)
      if (list) list.push(piece)
      else groups.set(key, [piece])
    }
    const next = new Map<string, StreetTileData>()
    for (const [key, list] of groups) {
      const before = this.tiles.get(key)
      if (before && before.pieces.length === list.length && before.pieces.every((p, i) => p === list[i])) {
        next.set(key, before)
        continue
      }
      const parts = list.map((p) => this.partsOf(p, palette))
      const [ix, iy] = key.split(',').map(Number) as [number, number]
      next.set(key, {
        key,
        pieces: list,
        base: concatMeshes(parts.map((p) => p.base)),
        paint: concatMeshes(parts.map((p) => p.paint)),
        centre: [(ix + 0.5) * TILE, -(iy + 0.5) * TILE],
      })
    }
    this.tiles = next
    return [...next.values()]
  }
}

/** Flat quads (four plan points each), facing up, at a height: just their tops. */
function flatQuads(quads: readonly Vec2[][], height: number): MeshData {
  const usable = quads.filter((q) => q.length === 4)
  const positions = new Float32Array(usable.length * 12)
  const normals = new Float32Array(usable.length * 12)
  const indices = new Uint32Array(usable.length * 6)
  usable.forEach((quad, i) => {
    quad.forEach((p, k) => {
      positions.set([p.x, height, -p.y], i * 12 + k * 3)
      normals.set([0, 1, 0], i * 12 + k * 3)
    })
    // Facing up whichever way round the quad was given.
    const [a, b, c] = quad as [Vec2, Vec2, Vec2]
    const up = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x) > 0
    const v = i * 4
    indices.set(up ? [v, v + 1, v + 2, v, v + 2, v + 3] : [v, v + 2, v + 1, v, v + 3, v + 2], i * 6)
  })
  return { positions, normals, indices }
}

const StreetTile = memo(function StreetTile({ tile, outlines }: { tile: StreetTileData; outlines: boolean }) {
  const base = useBufferGeometry(tile.base)
  const paintGeometry = useBufferGeometry(tile.paint)
  const paintRef = useRef<Mesh>(null)
  // Markings are too fine to see from far away.
  useFrame(({ camera }) => {
    const mesh = paintRef.current
    if (!mesh) return
    const [x, z] = tile.centre
    // How far the nearest part of the tile looks (through a long lens, closer than it is).
    const across = Math.max(0, Math.hypot(camera.position.x - x, camera.position.z - z) - TILE * 0.71)
    mesh.visible = apparentDistance(camera, Math.hypot(across, camera.position.y)) < PAINT_DISTANCE
  })
  return (
    <group>
      <mesh geometry={base} material={baseMaterial} receiveShadow raycast={noRaycast}>
        {outlines && <Outline geometry={base} color={COLORS.edge} threshold={30} />}
      </mesh>
      {tile.paint.indices.length > 0 && (
        <mesh ref={paintRef} geometry={paintGeometry} material={streetMaterials.marking} raycast={noRaycast} />
      )}
    </group>
  )
})

/** A hovered or selected street, tinted over its whole width. */
const StreetHighlight = memo(function StreetHighlight({ outline, look }: { outline: Vec2[]; look: 'hover' | 'selected' }) {
  const data = useMemo(() => buildSlabMesh([[toRing(outline)]], 0, CURB_HEIGHT + 0.01), [outline])
  const geometry = useBufferGeometry(data)
  return <mesh geometry={geometry} material={streetHighlight[look]} renderOrder={3} raycast={noRaycast} />
})

const noRaycast = () => {}
