import { Line } from '@react-three/drei'
import earcut from 'earcut'
import { useMemo } from 'react'
import { BufferAttribute, BufferGeometry, MeshBasicMaterial } from 'three'
import { heightAt, terrainOf, type Parcel, type Terrain } from '@plinth/core'
import { useEditor, useSnapshot } from '../context.ts'
import { parcelCornerId } from '../state.ts'
import { HandlePoints } from './HandlePoints.tsx'
import { COLORS } from './materials.ts'
import { HIDE_IN_PICTURES } from './pictures.ts'

/** Height of parcel lines above the ground, so they sit on it without flickering. */
const LIFT = 0.05
/** On terrain, outlines get a point this often (metres), to follow the ground. */
const DRAPE_STEP = 2

/** Height above the site's zero to draw a plan point at: on the terrain where there is one. */
function drape(terrain: Terrain | null, base: number, x: number, y: number): number {
  return (terrain ? (heightAt(terrain, { x, y }) ?? base) - base : 0) + LIFT
}

const fills = {
  hover: new MeshBasicMaterial({ color: COLORS.accent, transparent: true, opacity: 0.06, depthWrite: false }),
  selected: new MeshBasicMaterial({ color: COLORS.accent, transparent: true, opacity: 0.12, depthWrite: false }),
}

/**
 * Parcels on the site: their outlines as dashed lines on the ground, the
 * hovered or selected one tinted, and with the Parcel tool their corners
 * as handles to drag.
 */
export function Parcels() {
  const snapshot = useSnapshot()
  const site = useEditor((s) => s.mode === 'site')
  const tool = useEditor((s) => s.tool)
  const selected = useEditor((s) => s.selection.parcels)
  const hover = useEditor((s) => s.hover)
  const parcels = Object.values(snapshot.parcels)
  const terrain = terrainOf(snapshot)
  const base = snapshot.meta.ground ?? 0

  const handles = useMemo(() => {
    if (tool !== 'parcel') return null
    const normal: number[] = []
    const lit: number[] = []
    for (const parcel of parcels) {
      parcel.points.forEach((p, i) => {
        const on = hover?.kind === 'parcelCorner' && hover.id === parcelCornerId(parcel.id, i)
        ;(on ? lit : normal).push(p.x, drape(terrain, base, p.x, p.y), -p.y)
      })
    }
    return { normal: new Float32Array(normal), lit: new Float32Array(lit) }
  }, [tool, parcels, hover, terrain, base])

  if (parcels.length === 0) return null
  const hovered = hover?.kind === 'parcel' ? hover.id : null
  return (
    <group name="parcels">
      {parcels.map((parcel) => (
        <ParcelOutline
          key={parcel.id}
          parcel={parcel}
          look={selected.includes(parcel.id) ? 'selected' : hovered === parcel.id ? 'hover' : 'normal'}
          faded={!site}
          terrain={terrain}
          base={base}
        />
      ))}
      {handles && (
        <group userData={HIDE_IN_PICTURES}>
          <HandlePoints positions={handles.normal} fill={COLORS.node} ring={COLORS.nodeRing} size={10} />
          <HandlePoints positions={handles.lit} fill={COLORS.accent} ring="#ffffff" size={14} renderOrder={16} />
        </group>
      )}
    </group>
  )
}

function ParcelOutline({
  parcel,
  look,
  faded,
  terrain,
  base,
}: {
  parcel: Parcel
  look: 'normal' | 'hover' | 'selected'
  faded: boolean
  terrain: Terrain | null
  base: number
}) {
  // On terrain, the outline follows the ground: a point every couple of metres along each side.
  const points = useMemo(() => {
    const loop: [number, number, number][] = []
    parcel.points.forEach((p, i) => {
      const q = parcel.points[(i + 1) % parcel.points.length]!
      const steps = terrain ? Math.max(1, Math.ceil(Math.hypot(q.x - p.x, q.y - p.y) / DRAPE_STEP)) : 1
      for (let k = 0; k < steps; k++) {
        const x = p.x + ((q.x - p.x) * k) / steps
        const y = p.y + ((q.y - p.y) * k) / steps
        loop.push([x, drape(terrain, base, x, y), -y])
      }
    })
    return loop.length > 0 ? [...loop, loop[0]!] : loop
  }, [parcel, terrain, base])
  const fill = useMemo(() => {
    const flat = parcel.points.flatMap((p) => [p.x, p.y])
    const triangles = earcut(flat)
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(parcel.points.flatMap((p) => [p.x, drape(terrain, base, p.x, p.y), -p.y])), 3))
    geometry.setIndex(triangles)
    return geometry
  }, [parcel, terrain, base])
  return (
    <group>
      <Line
        points={points}
        color={COLORS.accent}
        lineWidth={look === 'selected' ? 2.5 : 1.5}
        dashed
        dashSize={1.2}
        gapSize={0.8}
        transparent
        opacity={faded ? 0.25 : look === 'normal' ? 0.55 : 0.9}
        raycast={() => null}
      />
      {look !== 'normal' && (
        <mesh geometry={fill} material={fills[look]} raycast={() => null} renderOrder={1} userData={HIDE_IN_PICTURES} />
      )}
    </group>
  )
}
