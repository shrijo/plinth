import type { BuildingAnalysis, Id, Meta, Opening } from '@plinth/core'
import { useFrame } from '@react-three/fiber'
import { memo, useMemo, useState } from 'react'
import type { MeshStandardMaterial } from 'three'
import { useAnalysis, useEditor, useSnapshot } from '../context.ts'
import type { Pick } from '../state.ts'
import { useBufferGeometry, type PaintedMesh } from './geometry.ts'
import { COLORS, PALETTES, slabMaterials, surroundMaterial, type Palette } from './materials.ts'
import { Outline } from './Outline.tsx'
import { apparentDistance } from './lens.ts'
import { usePickable } from './pickable.ts'
import { buildingCentre, concatMeshes, paneMesh, shellMesh } from './shellMesh.ts'

/** Buildings are drawn in square tiles of this size (metres), one mesh per tile. */
const TILE = 250
/** Window surrounds are made for tiles nearer the camera than this (metres)... */
const PANE_DISTANCE = 180
/** ...and dropped again beyond this, so a camera on the edge doesn't keep making them. */
const PANE_DROP_DISTANCE = 260
/** How many tiles' windows are kept ready after the camera moves away. */
const PANE_CACHE = 24

type Openings = Readonly<Record<Id, Opening>>

/**
 * Buildings as shells (outer walls, slabs and roof, with the surrounds of
 * windows and doors up close): every building on the site, or in the building
 * editor the others, faded, for context.
 *
 * Built for cities of tens of thousands of buildings: buildings are merged
 * into one mesh per tile of the ground, so the whole city is a few hundred
 * draw calls. Each building's own mesh is kept, so a change rebuilds only
 * that building and its tile. Windows are made only for the tiles near the
 * camera, when it comes near. Picking finds the building from the triangle
 * hit; the selected and hovered buildings are drawn again on top, tinted.
 */
export function ShellBuildings() {
  const snapshot = useSnapshot()
  const analysis = useAnalysis()
  const mode = useEditor((s) => s.mode)
  const openId = useEditor((s) => s.buildingId)
  const selected = useEditor((s) => s.selection.buildings)
  const hover = useEditor((s) => s.hover)
  const outlines = useEditor((s) => s.showOutlines)
  const isolated = useEditor((s) => s.isolated)
  const palette = PALETTES[useEditor((s) => s.style)]
  const site = mode === 'site'
  const { wallThickness, slabThickness } = snapshot.meta
  // Only the thicknesses matter for the shells, not a rename of the project.
  const meta = useMemo<Meta>(() => ({ schemaVersion: 3, name: '', wallThickness, slabThickness }), [wallThickness, slabThickness])
  const openings = snapshot.openings
  const [tiler] = useState(() => new Tiler())
  const tiles = useMemo(
    () => tiler.update(analysis.buildings, site ? null : openId, meta, palette),
    [tiler, analysis.buildings, site, openId, meta, palette],
  )

  // Focusing on a few buildings hides the tiles (kept, so showing them again is instant) and draws those alone.
  const solo = useMemo(() => {
    if (!isolated) return null
    const shown = isolated.filter((id) => analysis.buildings.has(id))
    if (shown.length === 0) return null
    return shown.flatMap((id) => {
      const building = analysis.buildings.get(id)
      return building && (site || id !== openId) ? [building] : []
    })
  }, [isolated, analysis.buildings, site, openId])

  const lit = useMemo(() => {
    const list: [Id, 'selected' | 'hover'][] = []
    if (!site) return list
    for (const id of selected) list.push([id, 'selected'])
    if (hover?.kind === 'building' && !selected.includes(hover.id)) list.push([hover.id, 'hover'])
    return list
  }, [site, selected, hover])

  return (
    <group name="site">
      {tiles.map((tile) => (
        <ShellTile
          key={tile.key}
          tile={tile}
          tiler={tiler}
          meta={meta}
          openings={openings}
          faded={!site}
          pickable={site && !solo}
          outlines={outlines}
          hidden={!!solo}
        />
      ))}
      {solo?.map((building) => (
        <SoloBuilding
          key={building.buildingId}
          building={building}
          tiler={tiler}
          meta={meta}
          palette={palette}
          openings={openings}
          faded={!site}
          pickable={site}
          outlines={outlines}
        />
      ))}
      {lit.map(([id, look]) => {
        const building = analysis.buildings.get(id)
        return building ? <Highlight key={id} mesh={tiler.meshOf(building, meta, palette)} look={look} /> : null
      })}
    </group>
  )
}

interface Tile {
  key: string
  /** The buildings in the tile, in a stable order. */
  buildings: BuildingAnalysis[]
  mesh: PaintedMesh
  /** Where each building's triangles start in the mesh, in order, for finding a building from a triangle. */
  starts: Int32Array
  ids: Id[]
  centre: [number, number, number]
  /** The parts it was merged from, to tell whether it changed. */
  meshes: PaintedMesh[]
}

const EMPTY_MESH: PaintedMesh = { positions: new Float32Array(), normals: new Float32Array(), indices: new Uint32Array() }

/**
 * Sorts buildings into tiles and keeps each building's mesh and each
 * tile's merged mesh until they change; makes the windows of tiles near
 * the camera and keeps the most recent few.
 */
class Tiler {
  private meshes = new WeakMap<BuildingAnalysis, { meta: Meta; palette: Palette; mesh: PaintedMesh }>()
  private tiles = new Map<string, Tile>()
  /** Windows by tile, most recently used last. */
  private panes = new Map<string, { tile: Tile; meta: Meta; records: Opening[]; mesh: PaintedMesh }>()

  meshOf(building: BuildingAnalysis, meta: Meta, palette: Palette): PaintedMesh {
    const hit = this.meshes.get(building)
    if (hit && hit.meta === meta && hit.palette === palette) return hit.mesh
    const mesh = shellMesh(building, meta, palette)
    this.meshes.set(building, { meta, palette, mesh })
    return mesh
  }

  /** The windows and doors of a tile's buildings, made again only when one of them changed. */
  panesOf(tile: Tile, meta: Meta, openings: Openings): PaintedMesh {
    const byWall = openingsByWall(openings)
    const records: Opening[] = []
    const perBuilding = tile.buildings.map((building) => ownOpenings(building, byWall, records))
    const hit = this.panes.get(tile.key)
    if (hit && hit.tile === tile && hit.meta === meta && sameList(hit.records, records)) {
      this.panes.delete(tile.key)
      this.panes.set(tile.key, hit)
      return hit.mesh
    }
    const parts = tile.buildings.flatMap((building, i) => {
      const mine = perBuilding[i]!
      return mine.size > 0 ? [paneMesh(building, meta, mine)] : []
    })
    const mesh = parts.length > 0 ? concatMeshes(parts) : EMPTY_MESH
    this.panes.delete(tile.key)
    this.panes.set(tile.key, { tile, meta, records, mesh })
    for (const key of this.panes.keys()) {
      if (this.panes.size <= PANE_CACHE) break
      this.panes.delete(key)
    }
    return mesh
  }

  update(buildings: ReadonlyMap<Id, BuildingAnalysis>, exclude: Id | null, meta: Meta, palette: Palette): Tile[] {
    const groups = new Map<string, BuildingAnalysis[]>()
    for (const building of buildings.values()) {
      if (building.buildingId === exclude) continue
      const centre = buildingCentre(building)
      if (!centre) continue
      const key = `${Math.floor(centre.x / TILE)},${Math.floor(centre.y / TILE)}`
      const list = groups.get(key)
      if (list) list.push(building)
      else groups.set(key, [building])
    }
    const next = new Map<string, Tile>()
    for (const [key, list] of groups) {
      const before = this.tiles.get(key)
      const meshes = list.map((b) => this.meshOf(b, meta, palette))
      // Nothing in the tile changed: keep it, and React keeps its geometry.
      if (
        before &&
        before.buildings.length === list.length &&
        before.buildings.every((b, i) => b === list[i]) &&
        before.meshes.every((m, i) => m === meshes[i])
      ) {
        next.set(key, before)
        continue
      }
      const starts = new Int32Array(list.length)
      let triangles = 0
      meshes.forEach((m, i) => {
        starts[i] = triangles
        triangles += m.indices.length / 3
      })
      const [ix, iy] = key.split(',').map(Number) as [number, number]
      next.set(key, {
        key,
        buildings: list,
        mesh: concatMeshes(meshes),
        starts,
        ids: list.map((b) => b.buildingId),
        centre: [(ix + 0.5) * TILE, 0, -(iy + 0.5) * TILE],
        meshes,
      })
    }
    this.tiles = next
    return [...next.values()]
  }
}

/** A building's openings by wall (its own floors' walls; copies show their master's), adding each to `records`. */
function ownOpenings(building: BuildingAnalysis, byWall: Map<Id, Opening[]>, records: Opening[]): Map<Id, Opening[]> {
  const mine = new Map<Id, Opening[]>()
  for (const level of building.levels) {
    if (level.contentLevelId !== level.level.id) continue
    for (const wall of level.levelWalls) {
      const here = byWall.get(wall.id)
      if (!here) continue
      mine.set(wall.id, here)
      for (const opening of here) records.push(opening)
    }
  }
  return mine
}

function sameList<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i])
}

/** Openings by wall, made once per version of the collection. */
const openingIndexes = new WeakMap<object, Map<Id, Opening[]>>()
function openingsByWall(openings: Openings): Map<Id, Opening[]> {
  let index = openingIndexes.get(openings)
  if (!index) {
    index = new Map()
    for (const opening of Object.values(openings)) {
      const list = index.get(opening.wallId)
      if (list) list.push(opening)
      else index.set(opening.wallId, [opening])
    }
    openingIndexes.set(openings, index)
  }
  return index
}

const ShellTile = memo(function ShellTile({
  tile,
  tiler,
  meta,
  openings,
  faded,
  pickable,
  outlines,
  hidden,
}: {
  tile: Tile
  tiler: Tiler
  meta: Meta
  openings: Openings
  faded: boolean
  pickable: boolean
  outlines: boolean
  hidden: boolean
}) {
  const geometry = useBufferGeometry(tile.mesh)
  const ref = usePickable(`tile:${tile.key}`, pickable)
  // Windows and doors come in as the camera nears the tile and go again as it leaves.
  const [near, setNear] = useState(false)
  useFrame(({ camera }) => {
    if (hidden) return
    const [x, , z] = tile.centre
    const distance = Math.max(0, Math.hypot(camera.position.x - x, camera.position.z - z) - TILE * 0.71)
    const height = Math.max(0, camera.position.y - 150)
    // Through a long lens (the top view's), far things look close.
    const away = apparentDistance(camera, Math.hypot(distance, height))
    if (!near && away < PANE_DISTANCE) setNear(true)
    else if (near && away > PANE_DROP_DISTANCE) setNear(false)
  })
  // Window surrounds only cast shadows and shading creases, which faded buildings don't have.
  const panes = useMemo(
    () => (near && !hidden && !faded ? tiler.panesOf(tile, meta, openings) : EMPTY_MESH),
    [near, hidden, faded, tiler, tile, meta, openings],
  )
  const paneGeometry = useBufferGeometry(panes)
  const userData = useMemo(
    () => ({
      // The building a triangle belongs to: the last whose triangles start at or before it.
      pickFace: (face: number): Pick | null => {
        let lo = 0
        let hi = tile.starts.length - 1
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1
          if (tile.starts[mid]! <= face) lo = mid
          else hi = mid - 1
        }
        const id = tile.ids[lo]
        return id ? { kind: 'building', id } : null
      },
    }),
    [tile],
  )
  return (
    <group visible={!hidden}>
      <mesh
        ref={ref}
        geometry={geometry}
        material={faded ? slabMaterials.faded : slabMaterials.normal}
        userData={pickable ? userData : {}}
        castShadow={!faded}
        receiveShadow
      >
        {outlines && <Outline geometry={geometry} color={faded ? COLORS.edgeFaded : COLORS.edge} threshold={30} />}
      </mesh>
      {panes.indices.length > 0 && (
        <mesh geometry={paneGeometry} material={surroundMaterial} raycast={noRaycast} castShadow renderOrder={1} />
      )}
    </group>
  )
})

/** A building drawn on its own, while the others are hidden. */
function SoloBuilding({
  building,
  tiler,
  meta,
  palette,
  openings,
  faded,
  pickable,
  outlines,
}: {
  building: BuildingAnalysis
  tiler: Tiler
  meta: Meta
  palette: Palette
  openings: Openings
  faded: boolean
  pickable: boolean
  outlines: boolean
}) {
  const id = building.buildingId
  const mesh = useMemo(() => tiler.meshOf(building, meta, palette), [tiler, building, meta, palette])
  const panes = useMemo(() => {
    const mine = faded ? new Map<Id, Opening[]>() : ownOpenings(building, openingsByWall(openings), [])
    return mine.size > 0 ? paneMesh(building, meta, mine) : EMPTY_MESH
  }, [building, meta, openings, faded])
  const geometry = useBufferGeometry(mesh)
  const paneGeometry = useBufferGeometry(panes)
  const ref = usePickable(`building:${id}`, pickable)
  const userData = useMemo(() => ({ pick: { kind: 'building', id } satisfies Pick }), [id])
  return (
    <group>
      <mesh
        ref={ref}
        geometry={geometry}
        material={faded ? slabMaterials.faded : slabMaterials.normal}
        userData={pickable ? userData : {}}
        castShadow={!faded}
        receiveShadow
      >
        {outlines && <Outline geometry={geometry} color={faded ? COLORS.edgeFaded : COLORS.edge} threshold={30} />}
      </mesh>
      {panes.indices.length > 0 && (
        <mesh geometry={paneGeometry} material={surroundMaterial} raycast={noRaycast} castShadow renderOrder={1} />
      )}
    </group>
  )
}

/** Drawn over a building's own triangles in its tile, so they win. */
function inFront(material: MeshStandardMaterial): MeshStandardMaterial {
  const m = material.clone()
  m.polygonOffsetFactor = -2
  m.polygonOffsetUnits = -4
  return m
}
const highlightMaterials = { hover: inFront(slabMaterials.hover), selected: inFront(slabMaterials.selected) }

/** The selected or hovered building, tinted, and outlined when selected. */
function Highlight({ mesh, look }: { mesh: PaintedMesh; look: 'hover' | 'selected' }) {
  const geometry = useBufferGeometry(mesh)
  return (
    <mesh geometry={geometry} material={highlightMaterials[look]} raycast={noRaycast} renderOrder={2}>
      {look === 'selected' && <Outline geometry={geometry} color={COLORS.edgeSelected} threshold={30} />}
    </mesh>
  )
}

const noRaycast = () => {}
