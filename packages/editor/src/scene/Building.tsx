import {
  add,
  buildSlabMesh,
  buildWallMesh,
  fillLayout,
  findStacks,
  normalize,
  openingCopies,
  openingType,
  placeOpening,
  resolveWall,
  scale,
  sub,
  type FillLeaf,
  type FillPart,
  type Id,
  type Opening,
  type OpeningCut,
  type BuildingAnalysis,
  type Slab,
  type Wall,
  type WallFootprint,
} from '@plinth/core'
import { Line } from '@react-three/drei'
import { useFrame } from '@react-three/fiber'
import { memo, useMemo, useRef, useState, type ReactNode } from 'react'
import { BoxGeometry, type BufferGeometry, type Group, type Mesh } from 'three'
import { useAnalysis, useEditor, useSnapshot } from '../context.ts'
import type { Pick } from '../state.ts'
import { useBufferGeometry } from './geometry.ts'
import { paintSlab, paintWall } from './paintParts.ts'
import { Outline as EdgeLines } from './Outline.tsx'
import { usePickable } from './pickable.ts'
import {
  buildingColours,
  COLORS,
  fillMaterials,
  PALETTES,
  shade,
  openingHighlight,
  paneMaterial,
  paneMaterialFaded,
  previewMaterial,
  slabMaterials,
  wallMaterials,
  type Look,
} from './materials.ts'
import { concatMeshes, cutPanes, roofParts, stackUp } from './shellMesh.ts'
import { pointsKey, StableValues } from './stable.ts'

interface PlacedOpening {
  /** One window or door: of a row, one of its copies. */
  opening: Opening
  cut: OpeningCut
  /** Unique per window or door drawn: the opening's id, and which copy in its row. */
  key: string
}

interface WallView {
  wall: Wall
  footprint: WallFootprint
  heightStart: number
  heightEnd: number
  cuts: OpeningCut[]
  openings: PlacedOpening[]
}

const PREVIEW_ID = '__preview'
const unitBox = new BoxGeometry(1, 1, 1)

/**
 * The open building in full detail: walls, windows, doors and slabs of
 * every visible level. A copy shows its master's walls, moved up to its own
 * elevation, reusing the same geometry. Floors other than the active one
 * can be faded.
 */
export function Building({ buildingId }: { buildingId: Id }) {
  const snapshot = useSnapshot()
  const analysis = useAnalysis()
  const activeLevelId = useEditor((s) => s.activeLevelId)
  const showAbove = useEditor((s) => s.showLevelsAbove)
  const outlines = useEditor((s) => s.showOutlines)
  const fade = useEditor((s) => s.fadeOtherLevels)
  const whole = useEditor((s) => s.wholeBuilding)
  const selection = useEditor((s) => s.selection)
  const hover = useEditor((s) => s.hover)
  const tool = useEditor((s) => s.tool)
  const preview = useEditor((s) => s.openingPreview)
  const openingTypes = useEditor((s) => s.openingTypes)
  const style = useEditor((s) => s.style)
  const palette = PALETTES[style]
  const colours = buildingColours(buildingId, palette)
  const cap = shade(palette.interior, -0.16)
  const [footprints] = useState(() => new StableValues<WallFootprint>())
  const [cutLists] = useState(() => new StableValues<OpeningCut[]>())

  const views = useMemo(() => {
    const openingsByWall = new Map<Id, Opening[]>()
    const add = (o: Opening) => openingsByWall.set(o.wallId, [...(openingsByWall.get(o.wallId) ?? []), o])
    for (const opening of Object.values(snapshot.openings)) add(opening)
    if (preview && (tool === 'window' || tool === 'door')) {
      const type = openingType(openingTypes[tool], tool)
      add({ id: PREVIEW_ID, wallId: preview.wallId, kind: tool, typeId: type.id, offset: preview.offset, ...type.defaults })
    }

    const byContentLevel = new Map<Id, WallView[]>()
    for (const levelAnalysis of analysis.buildings.get(buildingId)?.levels ?? []) {
      const levelId = levelAnalysis.contentLevelId
      if (byContentLevel.has(levelId)) continue
      const level = snapshot.levels[levelId]
      const list: WallView[] = []
      for (const [wallId, computed] of levelAnalysis.footprints) {
        const wall = snapshot.walls[wallId]
        if (!wall) continue
        const footprint = footprints.get(
          wallId,
          `${pointsKey([...computed.polygon, computed.a, computed.b])}|${computed.thickness}`,
          () => computed,
        )
        const resolved = resolveWall(wall, level, snapshot.meta)
        // Separate walls that overlap get slightly different tops, so they don't flicker.
        const lift = levelAnalysis.topOffsets.get(wallId) ?? 0
        const heightStart = resolved.heightStart + lift
        const heightEnd = resolved.heightEnd + lift
        const placed: PlacedOpening[] = []
        for (const record of openingsByWall.get(wallId) ?? []) {
          openingCopies(record).forEach((opening, k) => {
            const cut = placeOpening(footprint, opening, heightStart, heightEnd)
            if (cut) placed.push({ opening, cut, key: `${opening.id}:${k}` })
          })
        }
        const cuts = cutLists.get(wallId, JSON.stringify(placed.map((p) => p.cut)), () => placed.map((p) => p.cut))
        list.push({ wall, footprint, heightStart, heightEnd, cuts, openings: placed })
      }
      byContentLevel.set(levelId, list)
    }
    footprints.commit()
    cutLists.commit()
    return byContentLevel
  }, [analysis, snapshot, buildingId, preview, tool, openingTypes, footprints, cutLists])

  const active = snapshot.levels[activeLevelId]
  const own = analysis.buildings.get(buildingId)
  // The whole building shows every floor in full; otherwise floors above can be hidden and others faded.
  const visibleLevels = (own?.levels ?? []).filter(
    (l) => whole || showAbove || !active || l.level.elevation <= active.elevation + 1e-6,
  )
  const visibleIds = new Set(visibleLevels.map((l) => l.level.id))
  const topLevel = own?.levels.at(-1)
  const slabs = (own?.slabs ?? []).filter((slab) =>
    slab.levelId
      ? visibleIds.has(slab.levelId)
      : !!topLevel && (whole || (visibleIds.has(topLevel.level.id) && (showAbove || topLevel.level.id === activeLevelId))),
  )
  const faded = (levelId: Id | null) => !whole && fade && levelId !== activeLevelId

  // In the whole-building view, hovering a wall lights up the same wall on every floor.
  const hoverIds = new Set(
    hover?.kind === 'wall' && whole ? (findStacks(snapshot, buildingId).walls.get(hover.id) ?? [hover.id]) : hover ? [hover.id] : [],
  )
  const lookOf = (kind: 'wall' | 'opening', id: Id): Look =>
    (kind === 'wall' ? selection.walls : selection.openings).includes(id)
      ? 'selected'
      : hover?.kind === kind && hoverIds.has(id)
        ? 'hover'
        : 'normal'

  return (
    <group name="building">
      {visibleLevels.map((levelAnalysis) => {
        const master = snapshot.levels[levelAnalysis.contentLevelId]
        if (!master) return null
        const editable = levelAnalysis.contentLevelId === levelAnalysis.level.id
        const dim = faded(levelAnalysis.level.id)
        return (
          <group
            key={levelAnalysis.level.id}
            name={levelAnalysis.level.name}
            position-y={levelAnalysis.level.elevation - master.elevation}
          >
            {(views.get(levelAnalysis.contentLevelId) ?? []).map((view) => (
              <group key={view.wall.id}>
                <WallMesh
                  wallId={view.wall.id}
                  footprint={view.footprint}
                  base={master.elevation}
                  heightStart={view.heightStart}
                  heightEnd={view.heightEnd}
                  cuts={view.cuts}
                  look={dim ? 'faded' : editable ? lookOf('wall', view.wall.id) : 'normal'}
                  pick={editable && !dim ? { kind: 'wall', id: view.wall.id } : null}
                  outlines={outlines}
                  facade={colours.facade}
                  interior={palette.interior}
                  cap={cap}
                  outside={levelAnalysis.exteriorSides.get(view.wall.id) ?? null}
                />
                {view.openings.map(({ opening, cut, key }) => (
                  <OpeningFill
                    key={key}
                    pickKey={key}
                    opening={opening}
                    cut={cut}
                    footprint={view.footprint}
                    base={master.elevation}
                    look={dim ? 'faded' : editable ? lookOf('opening', opening.id) : 'normal'}
                    pickable={editable && !dim && opening.id !== PREVIEW_ID}
                    ghost={opening.id === PREVIEW_ID}
                    outlines={outlines}
                  />
                ))}
              </group>
            ))}
            {levelAnalysis.floors > 1 && (
              <RunFloors
                views={views.get(levelAnalysis.contentLevelId) ?? NO_VIEWS}
                base={master.elevation}
                floors={levelAnalysis.floors}
                step={levelAnalysis.level.height}
                dim={dim}
                outlines={outlines}
                facade={colours.facade}
                interior={palette.interior}
                cap={cap}
                sides={levelAnalysis.exteriorSides}
              />
            )}
          </group>
        )
      })}
      {slabs.map((slab) => (
        <SlabMesh
          key={slab.id}
          slab={slab}
          faded={faded(slab.levelId ?? (topLevel?.level.id === activeLevelId ? activeLevelId : null))}
          outlines={outlines}
          top={slab.levelId ? palette.floor : colours.roof}
          side={colours.band}
          bottom={palette.ceiling}
        />
      ))}
      {own && slabs.some((slab) => slab.levelId === null) && (
        <RoofMesh
          building={own}
          faded={faded(topLevel?.level.id === activeLevelId ? activeLevelId : null)}
          outlines={outlines}
        />
      )}
    </group>
  )
}

/** The building's roof, shown with its top slab. */
const RoofMesh = memo(function RoofMesh({ building, faded, outlines }: { building: BuildingAnalysis; faded: boolean; outlines: boolean }) {
  const snapshot = useSnapshot()
  const palette = PALETTES[useEditor((s) => s.style)]
  const { wallThickness, slabThickness } = snapshot.meta
  const data = useMemo(() => {
    const meta = { schemaVersion: 3 as const, name: '', wallThickness, slabThickness }
    const parts = roofParts(building, meta, palette)
    return parts.length > 0 ? concatMeshes(parts) : null
  }, [building, palette, wallThickness, slabThickness])
  const geometry = useBufferGeometry(data ?? NO_MESH)
  if (!data) return null
  const look: Look = faded ? 'faded' : 'normal'
  return (
    <mesh name="Roof" geometry={geometry} material={slabMaterials[look]} castShadow receiveShadow>
      {outlines && <Outline geometry={geometry} look={look} threshold={30} />}
    </mesh>
  )
})

const NO_MESH = { positions: new Float32Array(), normals: new Float32Array(), indices: new Uint32Array(), colors: new Float32Array() }

const NO_VIEWS: WallView[] = []

/**
 * The floors of a run above its first, which can only be looked at: all of
 * their walls as one mesh and all of their glass as another, however many
 * floors and windows there are.
 */
const RunFloors = memo(function RunFloors({
  views,
  base,
  floors,
  step,
  dim,
  outlines,
  facade,
  interior,
  cap,
  sides,
}: {
  views: readonly WallView[]
  base: number
  floors: number
  step: number
  dim: boolean
  outlines: boolean
  facade: string
  interior: string
  cap: string
  sides: ReadonlyMap<Id, 1 | -1 | 0>
}) {
  const walls = useMemo(() => {
    const one = concatMeshes(
      views.map((v) =>
        paintWall(buildWallMesh(v.footprint, base, v.heightStart, v.heightEnd, v.cuts), v.footprint, {
          facade,
          interior,
          cap,
          outside: sides.get(v.wall.id) ?? null,
        }),
      ),
    )
    return stackUp(one, 1, floors - 1, step)
  }, [views, base, floors, step, facade, interior, cap, sides])
  const glass = useMemo(
    () => stackUp(concatMeshes(views.map((v) => cutPanes(v.footprint, v.cuts, base))), 1, floors - 1, step),
    [views, base, floors, step],
  )
  const wallGeometry = useBufferGeometry(walls)
  const glassGeometry = useBufferGeometry(glass)
  const look: Look = dim ? 'faded' : 'normal'
  return (
    <>
      <mesh name="Copied floors" geometry={wallGeometry} material={wallMaterials[look]} castShadow receiveShadow>
        {outlines && <Outline geometry={wallGeometry} look={look} />}
      </mesh>
      {glass.indices.length > 0 && <mesh geometry={glassGeometry} material={dim ? paneMaterialFaded : paneMaterial} />}
    </>
  )
})

function Outline({ geometry, look, threshold = 20 }: { geometry: BufferGeometry; look: Look; threshold?: number }) {
  const color = look === 'faded' ? COLORS.edgeFaded : look === 'selected' ? COLORS.edgeSelected : COLORS.edge
  return <EdgeLines geometry={geometry} color={color} threshold={threshold} />
}

interface WallMeshProps {
  wallId: Id
  footprint: WallFootprint
  base: number
  heightStart: number
  heightEnd: number
  cuts: OpeningCut[]
  look: Look
  /** What clicking the wall picks: the wall, or on the site its building. Null for none. */
  pick: Pick | null
  outlines: boolean
  /** Colours: the outside face, inside faces, and the top of the wall. */
  facade: string
  interior: string
  cap: string
  /** Which face is outside (see LevelAnalysis.exteriorSides), or null for an inside wall. */
  outside: 1 | -1 | 0 | null
}

export const WallMesh = memo(function WallMesh({
  wallId,
  footprint,
  base,
  heightStart,
  heightEnd,
  cuts,
  look,
  pick,
  outlines,
  facade,
  interior,
  cap,
  outside,
}: WallMeshProps) {
  const ref = usePickable(`${pick?.kind ?? 'wall'}:${wallId}`, pick !== null)
  const data = useMemo(
    () => paintWall(buildWallMesh(footprint, base, heightStart, heightEnd, cuts), footprint, { facade, interior, cap, outside }),
    [footprint, base, heightStart, heightEnd, cuts, facade, interior, cap, outside],
  )
  const geometry = useBufferGeometry(data)
  return (
    <mesh
      ref={ref}
      name="Wall"
      geometry={geometry}
      material={wallMaterials[look]}
      userData={pick ? { pick } : {}}
      castShadow
      receiveShadow
    >
      {outlines && <Outline geometry={geometry} look={look} />}
    </mesh>
  )
})

interface OpeningFillProps {
  opening: Opening
  /** Unique among the windows and doors drawn, for picking. */
  pickKey: string
  cut: OpeningCut
  footprint: WallFootprint
  base: number
  look: Look
  pickable: boolean
  ghost: boolean
  outlines: boolean
}

const OpeningFill = memo(function OpeningFill({
  opening,
  pickKey,
  cut,
  footprint,
  base,
  look,
  pickable,
  ghost,
  outlines,
}: OpeningFillProps) {
  const ref = usePickable(`opening:${pickKey}`, pickable)
  const type = openingType(opening.typeId, opening.kind)
  const width = cut.end - cut.start
  const height = cut.head - cut.sill
  const thickness = footprint.thickness
  const flipHinge = !!opening.flipHinge
  const flipSide = !!opening.flipSide
  const layout = useMemo(
    () => fillLayout(type, width, height, thickness, { flipHinge, flipSide }),
    [type, width, height, thickness, flipHinge, flipSide],
  )
  const faded = look === 'faded'
  const materials = faded ? fillMaterials.faded : fillMaterials.normal
  const material = (part: FillPart) => (ghost ? previewMaterial : materials[part.material])
  const partLook: Look = faded ? 'faded' : 'normal'

  const dir = normalize(sub(footprint.b, footprint.a))
  const centre = add(footprint.a, scale(dir, (cut.start + cut.end) / 2))
  // The floor, in the fill's local coordinates (its origin is the opening's centre).
  const floorY = -(cut.sill + cut.head) / 2 + 0.012
  return (
    <group
      name={type.name}
      position={[centre.x, base + (cut.sill + cut.head) / 2, -centre.y]}
      rotation-y={Math.atan2(dir.y, dir.x)}
    >
      {layout.frame.map((part, i) => (
        <PartMesh key={i} part={part} material={material(part)} outline={outlines && !ghost} look={partLook} />
      ))}
      {layout.leaves.map((leaf, i) => (
        <Leaf
          key={i}
          leaf={leaf}
          open={!!opening.open && !ghost}
          pickKey={pickable ? `opening:${pickKey}:leaf${i}` : null}
          openingId={opening.id}
        >
          {leaf.parts.map((part, j) => (
            <PartMesh key={j} part={part} material={material(part)} outline={outlines && !ghost} look={partLook} />
          ))}
        </Leaf>
      ))}
      {type.fill === 'door' && outlines && !ghost &&
        layout.leaves.map((leaf, i) => <SwingArc key={`arc${i}`} leaf={leaf} y={floorY} faded={faded} />)}
      {ghost && type.fill === 'none' && (
        <mesh geometry={unitBox} material={previewMaterial} scale={[width, height, thickness + 0.02]} />
      )}
      {pickable && (
        // Invisible unless highlighted, but always hit by the picking ray.
        <mesh
          ref={ref}
          geometry={unitBox}
          material={look === 'selected' ? openingHighlight.selected : openingHighlight.hover}
          visible={look === 'hover' || look === 'selected'}
          scale={[width, height, thickness + 0.02]}
          userData={{ pick: { kind: 'opening', id: opening.id }, helper: true }}
        />
      )}
    </group>
  )
})

function PartMesh({
  part,
  material,
  outline,
  look,
}: {
  part: FillPart
  material: Mesh['material']
  outline: boolean
  look: Look
}) {
  return (
    <mesh geometry={unitBox} material={material} position={part.center} scale={part.size}>
      {outline && part.material !== 'glass' && <Outline geometry={unitBox} look={look} threshold={30} />}
    </mesh>
  )
}

/**
 * A door leaf or window sash that swings smoothly to open or closed. It has
 * its own invisible hit box, so it can be clicked when it stands open.
 */
function Leaf({
  leaf,
  open,
  pickKey,
  openingId,
  children,
}: {
  leaf: FillLeaf
  open: boolean
  pickKey: string | null
  openingId: Id
  children: ReactNode
}) {
  const ref = useRef<Group>(null)
  const hitRef = usePickable(pickKey ?? '', pickKey !== null)
  const target = open ? leaf.openAngle : 0
  const hitBox = useMemo(() => {
    const min = [Infinity, Infinity, Infinity]
    const max = [-Infinity, -Infinity, -Infinity]
    for (const part of leaf.parts) {
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k]!, part.center[k]! - part.size[k]! / 2)
        max[k] = Math.max(max[k]!, part.center[k]! + part.size[k]! / 2)
      }
    }
    return {
      position: [0, 1, 2].map((k) => (min[k]! + max[k]!) / 2) as [number, number, number],
      scale: [0, 1, 2].map((k) => Math.max(max[k]! - min[k]!, 0.02)) as [number, number, number],
    }
  }, [leaf])
  useFrame((_, delta) => {
    const group = ref.current
    if (!group) return
    const current = group.rotation.y
    if (Math.abs(current - target) < 1e-4) {
      group.rotation.y = target
      return
    }
    group.rotation.y = current + (target - current) * Math.min(1, delta * 9)
  })
  return (
    <group ref={ref} position={leaf.hinge}>
      {children}
      {pickKey && (
        <mesh
          ref={hitRef}
          geometry={unitBox}
          material={openingHighlight.hover}
          visible={false}
          position={hitBox.position}
          scale={hitBox.scale}
          userData={{ pick: { kind: 'opening', id: openingId }, helper: true }}
        />
      )}
    </group>
  )
}

/** The arc a door leaf sweeps on the floor, as on a plan. */
function SwingArc({ leaf, y, faded }: { leaf: FillLeaf; y: number; faded: boolean }) {
  const points = useMemo(() => {
    const reach = Math.max(...leaf.parts.map((p) => Math.abs(p.center[0]) + p.size[0] / 2))
    const along = Math.sign(leaf.parts[0]?.center[0] ?? 1) || 1
    const steps = 24
    const result: [number, number, number][] = [[leaf.hinge[0], y, leaf.hinge[2]]]
    for (let i = 0; i <= steps; i++) {
      const angle = (leaf.openAngle * i) / steps
      const x = along * reach
      result.push([leaf.hinge[0] + x * Math.cos(angle), y, leaf.hinge[2] - x * Math.sin(angle)])
    }
    return result
  }, [leaf, y])
  return <Line points={points} color={faded ? COLORS.edgeFaded : COLORS.edge} lineWidth={1} transparent opacity={0.6} />
}

export const SlabMesh = memo(function SlabMesh({
  slab,
  faded,
  outlines,
  top,
  side,
  bottom,
}: {
  slab: Slab
  faded: boolean
  outlines: boolean
  /** Colours of the slab's top (floor or roof), its edges and its underside. */
  top: string
  side: string
  bottom: string
}) {
  // A run's slab stands for one per floor.
  const data = useMemo(
    () => stackUp(paintSlab(buildSlabMesh(slab.region, slab.bottom, slab.top), top, side, bottom), 0, slab.count, slab.step),
    [slab, top, side, bottom],
  )
  const geometry = useBufferGeometry(data)
  const look: Look = faded ? 'faded' : 'normal'
  return (
    <mesh
      name={slab.levelId ? 'Floor slab' : 'Roof slab'}
      geometry={geometry}
      material={slabMaterials[look]}
      castShadow
      receiveShadow
    >
      {outlines && <Outline geometry={geometry} look={look} threshold={30} />}
    </mesh>
  )
})
