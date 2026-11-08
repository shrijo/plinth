import { buildSlabMesh, type Room } from '@plinth/core'
import { memo, useMemo } from 'react'
import { useAnalysis, useEditor } from '../context.ts'
import { useBufferGeometry } from './geometry.ts'
import { roomHighlight } from './materials.ts'

/** Highlights the hovered or selected room on the active level. (Room labels are in ui/Labels.) */
export function Rooms() {
  const analysis = useAnalysis()
  const levelId = useEditor((s) => s.activeLevelId)
  const selected = useEditor((s) => s.selection.rooms)
  const hover = useEditor((s) => s.hover)
  const whole = useEditor((s) => s.wholeBuilding)
  const level = analysis.byLevel.get(levelId)
  if (!level || whole) return null
  const elevation = level.level.elevation
  return (
    <group>
      {level.rooms.map((room) => {
        const look = selected.includes(room.id)
          ? 'selected'
          : hover?.kind === 'room' && hover.id === room.id
            ? 'hover'
            : null
        return (
          <group key={room.id}>
            {look && <RoomHighlight room={room} elevation={elevation} look={look} />}
          </group>
        )
      })}
    </group>
  )
}

const RoomHighlight = memo(function RoomHighlight({
  room,
  elevation,
  look,
}: {
  room: Room
  elevation: number
  look: 'hover' | 'selected'
}) {
  const data = useMemo(() => buildSlabMesh(room.floor, elevation + 0.004, elevation + 0.008), [room, elevation])
  const geometry = useBufferGeometry(data)
  return <mesh geometry={geometry} material={roomHighlight[look]} renderOrder={4} />
})
