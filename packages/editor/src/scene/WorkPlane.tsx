import { sortedLevels } from '@plinth/core'
import { Grid, Line } from '@react-three/drei'
import { useMemo } from 'react'
import { useEditor, useSnapshot } from '../context.ts'
import { COLORS, workPlaneMaterial } from './materials.ts'

const MARGIN = 4
const MIN_SIZE = 16

/**
 * The plane of the floor being worked on: a translucent sheet with its own
 * grid and an outlined edge, covering the building with some room around
 * it. On the ground floor only its edge is drawn, over the ground grid.
 */
export function WorkPlane() {
  const snapshot = useSnapshot()
  const levelId = useEditor((s) => s.activeLevelId)
  const gridSize = useEditor((s) => s.snap.gridSize)
  const whole = useEditor((s) => s.wholeBuilding)
  const drawing = useEditor((s) => s.tool !== 'select')
  const buildingId = useEditor((s) => s.buildingId)
  const level = snapshot.levels[levelId]
  const ground = sortedLevels(snapshot, buildingId ?? undefined)[0]?.elevation ?? 0

  const bounds = useMemo(() => {
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const node of Object.values(snapshot.nodes)) {
      if (snapshot.levels[node.levelId]?.buildingId !== buildingId) continue
      minX = Math.min(minX, node.x)
      minY = Math.min(minY, node.y)
      maxX = Math.max(maxX, node.x)
      maxY = Math.max(maxY, node.y)
    }
    if (!Number.isFinite(minX)) return { cx: 0, cy: 0, width: MIN_SIZE * 1.5, depth: MIN_SIZE * 1.5 }
    // Snap to whole metres so the sheet doesn't jitter as walls move.
    const width = Math.ceil(Math.max(MIN_SIZE, maxX - minX + 2 * MARGIN))
    const depth = Math.ceil(Math.max(MIN_SIZE, maxY - minY + 2 * MARGIN))
    return { cx: Math.round((minX + maxX) / 2), cy: Math.round((minY + maxY) / 2), width, depth }
  }, [snapshot.nodes, snapshot.levels, buildingId])

  if (!level || whole) return null
  const raised = level.elevation > ground + 1e-6
  const { cx, cy, width, depth } = bounds
  const w2 = width / 2
  const d2 = depth / 2
  const outline: [number, number, number][] = [
    [-w2, 0, -d2],
    [w2, 0, -d2],
    [w2, 0, d2],
    [-w2, 0, d2],
    [-w2, 0, -d2],
  ]
  return (
    <group position={[cx, level.elevation + 0.004, -cy]}>
      {raised && (
        <>
          <mesh rotation-x={-Math.PI / 2} material={workPlaneMaterial} renderOrder={1}>
            <planeGeometry args={[width, depth]} />
          </mesh>
          {drawing && (
            <Grid
              args={[width, depth]}
              position-y={0.001}
              cellSize={gridSize}
              cellThickness={0.6}
              cellColor={COLORS.gridOnSheet}
              sectionSize={gridSize < 1 ? 1 : gridSize * 4}
              sectionThickness={1}
              sectionColor={COLORS.gridSectionOnSheet}
              fadeDistance={400}
              fadeStrength={0}
            />
          )}
        </>
      )}
      <Line points={outline} color={COLORS.workPlaneEdge} lineWidth={1.5} transparent opacity={0.8} />
    </group>
  )
}
