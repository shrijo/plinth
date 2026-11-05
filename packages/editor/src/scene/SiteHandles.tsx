import { CURB_HEIGHT, pointOnCurve } from '@plinth/core'
import { useMemo } from 'react'
import { useEditor, useSnapshot } from '../context.ts'
import { HandlePoints } from './HandlePoints.tsx'
import { COLORS } from './materials.ts'

/**
 * Street handles on the site. In the Street tool every street point shows
 * (they can be dragged), with the bend handle of the street under the
 * pointer or selected. In the Select tool only the points of the selected
 * street show, for picking one.
 */
export function SiteHandles() {
  const snapshot = useSnapshot()
  const tool = useEditor((s) => s.tool)
  const selectedStreets = useEditor((s) => s.selection.streets)
  const selectedNodes = useEditor((s) => s.selection.streetNodes)
  const hover = useEditor((s) => s.hover)

  const { normal, highlighted } = useMemo(() => {
    const normal: number[] = []
    const highlighted: number[] = []
    const lit = (id: string) => selectedNodes.includes(id) || (hover?.kind === 'streetNode' && hover.id === id)
    const shown = new Set<string>(selectedNodes)
    if (tool === 'street') for (const id of Object.keys(snapshot.streetNodes)) shown.add(id)
    for (const id of selectedStreets) {
      const street = snapshot.streets[id]
      if (street) shown.add(street.a).add(street.b)
    }
    for (const id of shown) {
      const node = snapshot.streetNodes[id]
      if (node) (lit(id) ? highlighted : normal).push(node.x, CURB_HEIGHT + 0.05, -node.y)
    }
    if (tool === 'street') {
      const bent = new Set(selectedStreets)
      if (hover?.kind === 'street' || hover?.kind === 'streetCurve') bent.add(hover.id)
      for (const id of bent) {
        const street = snapshot.streets[id]
        const a = street && snapshot.streetNodes[street.a]
        const b = street && snapshot.streetNodes[street.b]
        if (!street || !a || !b) continue
        const middle = pointOnCurve({ a, b, control: street.control }, 0.5)
        highlighted.push(middle.x, CURB_HEIGHT + 0.05, -middle.y)
      }
    }
    return { normal: new Float32Array(normal), highlighted: new Float32Array(highlighted) }
  }, [snapshot, tool, selectedStreets, selectedNodes, hover])

  if (tool !== 'select' && tool !== 'street') return null
  return (
    <>
      <HandlePoints positions={normal} fill={COLORS.node} ring={COLORS.nodeRing} size={10} />
      <HandlePoints positions={highlighted} fill={COLORS.accent} ring="#ffffff" size={14} renderOrder={16} />
    </>
  )
}
