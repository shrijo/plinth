import {
  buildSlabMesh,
  buildWallMesh,
  clearHeight,
  computeFootprints,
  CURB_HEIGHT,
  dist,
  streetGeometry,
  toRing,
  type Level,
  type Snapshot,
  type StreetProps,
  type SnapGuide,
  type SnapResult,
  type Vec2,
  type Wall,
  type WallNode,
} from '@plinth/core'
import { Line } from '@react-three/drei'
import { useEditor, useSnapshot } from '../context.ts'
import { useMemo } from 'react'
import { useBufferGeometry, worldPoint } from './geometry.ts'
import { ScreenSized } from './ScreenSized.tsx'
import { COLORS, previewMaterial } from './materials.ts'
import { isOutlineTool } from '../state.ts'

/** The snapped cursor, its guide lines and a preview of what the click will create. */
export function DrawingOverlay() {
  const snapshot = useSnapshot()
  const tool = useEditor((s) => s.tool)
  const cursor = useEditor((s) => s.cursor)
  const anchor = useEditor((s) => s.anchor)
  const dragging = useEditor((s) => s.dragging)
  const levelId = useEditor((s) => s.activeLevelId)
  const site = useEditor((s) => s.mode === 'site')
  const draft = useEditor((s) => s.draft)
  const defaults = useEditor((s) => s.siteDefaults)
  const level = snapshot.levels[levelId]
  if (!cursor) return null
  if (tool === 'select' && !dragging) return null

  if (site) {
    const lift = 0.03
    // A new building's shell, as tall as its floors will be.
    const shellLevel: Level = {
      id: 'preview',
      buildingId: 'preview',
      name: '',
      elevation: 0,
      height: defaults.floors * defaults.floorHeight,
    }
    const thickness = snapshot.meta.wallThickness
    const first = draft[0]
    return (
      <group>
        {cursor.guides.map((guide, i) => (
          <GuideLine key={i} guide={guide} elevation={lift} />
        ))}
        <SnapMarker result={cursor} elevation={lift} />
        {tool === 'street' && anchor && dist(anchor, cursor.point) > 0.05 && (
          <StreetPreview snapshot={snapshot} from={anchor} to={cursor.point} props={defaults.street} />
        )}
        {isOutlineTool(tool) && draft.length > 0 && (
          <>
            <OutlinePreview points={draft} cursor={cursor.point} level={shellLevel} thickness={thickness} />
            {first && draft.length >= 2 && (
              <Line
                points={[worldPoint(cursor.point, lift), worldPoint(first, lift)]}
                color={COLORS.guideOther}
                lineWidth={1.5}
                dashed
                dashSize={0.3}
                gapSize={0.2}
                depthTest={false}
                renderOrder={18}
              />
            )}
          </>
        )}
      </group>
    )
  }

  if (!level) return null
  const thickness = snapshot.meta.wallThickness
  // New walls stand as high as the level's clear height, under the slab above.
  const wallLevel = { ...level, height: clearHeight(level, snapshot.meta) }
  const lift = level.elevation + 0.005
  return (
    <group>
      {cursor.guides.map((guide, i) => (
        <GuideLine key={i} guide={guide} elevation={lift} />
      ))}
      <SnapMarker result={cursor} elevation={lift} />
      {tool === 'wall' && anchor && dist(anchor, cursor.point) > 0.005 && (
        <WallPreview from={anchor} to={cursor.point} level={wallLevel} thickness={thickness} />
      )}
    </group>
  )
}

function guideColor(guide: SnapGuide): string {
  if (guide.kind === 'x') return COLORS.guideX
  if (guide.kind === 'y') return COLORS.guideY
  return COLORS.guideOther
}

function GuideLine({ guide, elevation }: { guide: SnapGuide; elevation: number }) {
  if (dist(guide.from, guide.to) < 1e-6) return null
  return (
    <Line
      points={[worldPoint(guide.from, elevation), worldPoint(guide.to, elevation)]}
      color={guideColor(guide)}
      lineWidth={1.5}
      dashed
      dashSize={0.12}
      gapSize={0.08}
      depthTest={false}
      renderOrder={18}
    />
  )
}

function SnapMarker({ result, elevation }: { result: SnapResult; elevation: number }) {
  const position = worldPoint(result.point, elevation)
  const common = { depthTest: false, transparent: true, toneMapped: false } as const
  let shape
  switch (result.kind) {
    case 'node':
      shape = (
        <mesh renderOrder={20}>
          <ringGeometry args={[0.3, 0.5, 32]} />
          <meshBasicMaterial color={COLORS.snapNode} {...common} />
        </mesh>
      )
      break
    case 'midpoint':
      shape = (
        <mesh renderOrder={20}>
          <ringGeometry args={[0.3, 0.55, 4]} />
          <meshBasicMaterial color={COLORS.snapMidpoint} {...common} />
        </mesh>
      )
      break
    case 'wall':
    case 'intersection':
      shape = (
        <mesh renderOrder={20}>
          <ringGeometry args={[0.28, 0.48, 4, 1, Math.PI / 4]} />
          <meshBasicMaterial color={COLORS.snapWall} {...common} />
        </mesh>
      )
      break
    default:
      shape = (
        <mesh renderOrder={20}>
          <circleGeometry args={[0.2, 24]} />
          <meshBasicMaterial color={COLORS.snapFree} {...common} />
        </mesh>
      )
  }
  return (
    <ScreenSized position={position} size={22}>
      {shape}
    </ScreenSized>
  )
}

interface PreviewProps {
  from: Vec2
  to: Vec2
  level: Level
  thickness: number
}

function previewNodes(points: Vec2[]): Record<string, WallNode> {
  return Object.fromEntries(
    points.map((p, i) => [`p${i}`, { id: `p${i}`, levelId: 'preview', x: p.x, y: p.y }]),
  )
}

function previewWall(i: number, a: number, b: number): Wall {
  return { id: `w${i}`, levelId: 'preview', a: `p${a}`, b: `p${b}`, thickness: null, height: null, heightEnd: null }
}

function GhostWalls({ points, closed, level, thickness }: { points: Vec2[]; closed: boolean } & Omit<PreviewProps, 'from' | 'to'>) {
  const { elevation, height } = level
  const data = useMemo(() => {
    const count = closed ? points.length : points.length - 1
    const walls = Array.from({ length: count }, (_, i) => previewWall(i, i, (i + 1) % points.length))
    const footprints = computeFootprints(previewNodes(points), walls, () => thickness)
    return mergeMeshes([...footprints.values()].map((fp) => buildWallMesh(fp, elevation, height, height)))
  }, [points, closed, thickness, elevation, height])
  const geometry = useBufferGeometry(data)
  return <mesh geometry={geometry} material={previewMaterial} renderOrder={5} />
}

function mergeMeshes(meshes: ReturnType<typeof buildWallMesh>[]) {
  const positions: number[] = []
  const normals: number[] = []
  const indices: number[] = []
  for (const mesh of meshes) {
    const base = positions.length / 3
    positions.push(...mesh.positions)
    normals.push(...mesh.normals)
    for (const index of mesh.indices) indices.push(base + index)
  }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint32Array(indices),
  }
}

function WallPreview({ from, to, level, thickness }: PreviewProps) {
  const points = useMemo(() => [from, to], [from, to])
  return <GhostWalls points={points} closed={false} level={level} thickness={thickness} />
}



function OutlinePreview({ points, cursor, level, thickness }: { points: readonly Vec2[]; cursor: Vec2 } & Omit<PreviewProps, 'from' | 'to'>) {
  const chain = useMemo(() => {
    const last = points.at(-1)
    return last && dist(last, cursor) > 0.01 ? [...points, cursor] : [...points]
  }, [points, cursor])
  if (chain.length < 2) return null
  return <GhostWalls points={chain} closed={false} level={level} thickness={thickness} />
}

/** The street the next click would add, on its own, as a see-through band at curb height. */
function StreetPreview({ snapshot, from, to, props }: { snapshot: Snapshot; from: Vec2; to: Vec2; props: StreetProps }) {
  const data = useMemo(() => {
    const preview: Snapshot = {
      ...snapshot,
      streetNodes: {
        pa: { id: 'pa', x: from.x, y: from.y },
        pb: { id: 'pb', x: to.x, y: to.y },
      },
      streets: { preview: { ...props, id: 'preview', a: 'pa', b: 'pb', control: null } },
    }
    const outline = streetGeometry(preview).outlines.get('preview')
    return buildSlabMesh(outline ? [[toRing(outline)]] : [], 0, CURB_HEIGHT)
  }, [snapshot, from, to, props])
  const geometry = useBufferGeometry(data)
  return <mesh geometry={geometry} material={previewMaterial} renderOrder={5} />
}
