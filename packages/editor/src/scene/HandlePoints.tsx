import { useEffect, useMemo } from 'react'
import { BufferAttribute, BufferGeometry } from 'three'
import { handleMaterial } from './handleMaterial.ts'

/** Round point handles at `positions` (x, y, z triples), drawn over everything. */
export function HandlePoints({
  positions,
  fill,
  ring,
  size,
  renderOrder = 15,
}: {
  positions: Float32Array
  fill: string
  ring: string
  size: number
  renderOrder?: number
}) {
  const geometry = useMemo(() => {
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(positions, 3))
    g.computeBoundingSphere()
    return g
  }, [positions])
  useEffect(() => () => geometry.dispose(), [geometry])
  if (positions.length === 0) return null
  return (
    <points geometry={geometry} material={handleMaterial(fill, ring, size)} renderOrder={renderOrder} frustumCulled={false} raycast={() => null} />
  )
}
