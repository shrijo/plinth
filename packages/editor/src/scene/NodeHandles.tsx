import { findStacks, nodesOnLevel } from '@plinth/core'
import { useMemo } from 'react'
import { useEditor, useSnapshot } from '../context.ts'
import { HandlePoints } from './HandlePoints.tsx'
import { COLORS } from './materials.ts'

/**
 * Dots on the active level's points (every floor's in the whole-building
 * view), shown through walls in the Select tool.
 */
export function NodeHandles() {
  const snapshot = useSnapshot()
  const tool = useEditor((s) => s.tool)
  const levelId = useEditor((s) => s.activeLevelId)
  const selectedNodes = useEditor((s) => s.selection.nodes)
  const hover = useEditor((s) => s.hover)
  const whole = useEditor((s) => s.wholeBuilding)
  const buildingId = useEditor((s) => s.buildingId)

  const { normal, highlighted } = useMemo(() => {
    // The active floor's points; in the whole-building view, every real floor's.
    // Only the open building's: never handles of the buildings around it.
    const nodes = whole
      ? Object.values(snapshot.nodes).filter((n) => {
          const level = snapshot.levels[n.levelId]
          return level && !level.masterId && level.buildingId === buildingId
        })
      : nodesOnLevel(snapshot, levelId)
    const hovered = new Set(
      hover?.kind === 'node' ? (whole ? (findStacks(snapshot, buildingId ?? undefined).nodes.get(hover.id) ?? [hover.id]) : [hover.id]) : [],
    )
    const normalPoints: number[] = []
    const highlightedPoints: number[] = []
    for (const node of nodes) {
      const elevation = (snapshot.levels[node.levelId]?.elevation ?? 0) + 0.01
      const isHighlighted = selectedNodes.includes(node.id) || hovered.has(node.id)
      ;(isHighlighted ? highlightedPoints : normalPoints).push(node.x, elevation, -node.y)
    }
    return { normal: new Float32Array(normalPoints), highlighted: new Float32Array(highlightedPoints) }
  }, [snapshot, levelId, buildingId, selectedNodes, hover, whole])

  if (tool !== 'select') return null
  return (
    <>
      <HandlePoints positions={normal} fill={COLORS.node} ring={COLORS.nodeRing} size={10} />
      <HandlePoints positions={highlighted} fill={COLORS.accent} ring="#ffffff" size={15} renderOrder={16} />
    </>
  )
}
