import { useEffect, useMemo } from 'react'
import { EdgesGeometry, LineBasicMaterial, type BufferGeometry } from 'three'

const materials = new Map<string, LineBasicMaterial>()
function lineMaterial(color: string): LineBasicMaterial {
  let material = materials.get(color)
  if (!material) {
    material = new LineBasicMaterial({ color })
    materials.set(color, material)
  }
  return material
}

const noRaycast = () => {}

/**
 * Dark lines along a mesh's sharp edges. Put it inside the mesh, passing
 * the mesh's geometry. The lines are rebuilt as a new geometry whenever the
 * shape changes: drei's Edges reuses one instanced geometry, and three.js
 * caps how many instances it draws at the count of the first draw, so
 * edges added later went missing.
 */
export function Outline({ geometry, color, threshold = 20 }: { geometry: BufferGeometry; color: string; threshold?: number }) {
  const edges = useMemo(() => new EdgesGeometry(geometry, threshold), [geometry, threshold])
  useEffect(() => () => edges.dispose(), [edges])
  return <lineSegments geometry={edges} material={lineMaterial(color)} raycast={noRaycast} userData={{ helper: true }} />
}
