import { contours, terrainMesh, terrainOf } from '@plinth/core'
import { useEffect, useMemo } from 'react'
import { BufferAttribute, BufferGeometry, LineBasicMaterial, MeshStandardMaterial } from 'three'
import { useEditor, useSnapshot } from '../context.ts'
import { useBufferGeometry } from './geometry.ts'
import { HandlePoints } from './HandlePoints.tsx'
import { COLORS, PALETTES } from './materials.ts'
import { HIDE_IN_PICTURES } from './pictures.ts'

/** The terrain is drawn a little behind what stands on it, so streets and floors at its height win. */
const terrainMaterial = new MeshStandardMaterial({
  roughness: 1,
  metalness: 0,
  polygonOffset: true,
  polygonOffsetFactor: 2,
  polygonOffsetUnits: 4,
})
const minorLines = new LineBasicMaterial({ color: COLORS.accent, transparent: true, opacity: 0.18, depthWrite: false })
const majorLines = new LineBasicMaterial({ color: COLORS.accent, transparent: true, opacity: 0.42, depthWrite: false })

/** Contours sit this far above the ground. */
const LIFT = 0.03

/**
 * The terrain through the site's spot heights: the ground's surface,
 * contour lines (every fifth stronger), and with the Terrain tool its spot
 * heights as handles. Heights are drawn from the site's zero (see
 * Meta.ground).
 */
export function Terrain() {
  const snapshot = useSnapshot()
  const tool = useEditor((s) => s.tool)
  const selected = useEditor((s) => s.selection.spotHeights)
  const hover = useEditor((s) => s.hover)
  const palette = PALETTES[useEditor((s) => s.style)]
  const terrain = terrainOf(snapshot)
  const base = snapshot.meta.ground ?? 0

  const surface = useMemo(() => {
    if (!terrain) return null
    const mesh = terrainMesh(terrain)
    for (let i = 1; i < mesh.positions.length; i += 3) mesh.positions[i] = mesh.positions[i]! - base
    return mesh
  }, [terrain, base])
  const geometry = useBufferGeometry(surface ?? EMPTY)
  useEffect(() => {
    terrainMaterial.color.set(palette.ground)
  }, [palette])

  const lines = useMemo(() => {
    if (!terrain) return null
    const minor: number[] = []
    const major: number[] = []
    for (const contour of contours(terrain)) {
      const list = contour.major ? major : minor
      const y = contour.z - base + LIFT
      for (const [a, b] of contour.segments) list.push(a.x, y, -a.y, b.x, y, -b.y)
    }
    const geometryOf = (values: number[]) => {
      const g = new BufferGeometry()
      g.setAttribute('position', new BufferAttribute(new Float32Array(values), 3))
      return g
    }
    return { minor: geometryOf(minor), major: geometryOf(major) }
  }, [terrain, base])

  const handles = useMemo(() => {
    if (tool !== 'terrain') return null
    const normal: number[] = []
    const lit: number[] = []
    for (const spot of Object.values(snapshot.spotHeights)) {
      const on = selected.includes(spot.id) || (hover?.kind === 'spotHeight' && hover.id === spot.id)
      ;(on ? lit : normal).push(spot.x, spot.z - base + LIFT, -spot.y)
    }
    return { normal: new Float32Array(normal), lit: new Float32Array(lit) }
  }, [tool, snapshot.spotHeights, selected, hover, base])

  return (
    <group name="terrain">
      {surface && <mesh geometry={geometry} material={terrainMaterial} receiveShadow raycast={() => null} />}
      {lines && (
        <>
          <lineSegments geometry={lines.minor} material={minorLines} raycast={() => null} />
          <lineSegments geometry={lines.major} material={majorLines} raycast={() => null} />
        </>
      )}
      {handles && (
        <group userData={HIDE_IN_PICTURES}>
          <HandlePoints positions={handles.normal} fill={COLORS.node} ring={COLORS.nodeRing} size={10} />
          <HandlePoints positions={handles.lit} fill={COLORS.accent} ring="#ffffff" size={14} renderOrder={16} />
        </group>
      )}
    </group>
  )
}

const EMPTY = { positions: new Float32Array(), normals: new Float32Array(), indices: new Uint32Array() }
