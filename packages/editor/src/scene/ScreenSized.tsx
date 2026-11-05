import { Billboard } from '@react-three/drei'
import { useFrame } from '@react-three/fiber'
import { useRef, type ReactNode } from 'react'
import { PerspectiveCamera, type Group } from 'three'

/**
 * Keeps its children the same size on screen (`size` pixels per unit),
 * facing the camera.
 */
export function ScreenSized({
  position,
  size,
  children,
}: {
  position: [number, number, number]
  size: number
  children: ReactNode
}) {
  const ref = useRef<Group>(null)
  useFrame(({ camera, size: viewport }) => {
    const group = ref.current
    if (!group) return
    const fov = camera instanceof PerspectiveCamera ? camera.fov : 50
    const distance = camera.position.distanceTo(group.position)
    const worldHeight = 2 * distance * Math.tan((fov * Math.PI) / 360)
    group.scale.setScalar((worldHeight / viewport.height) * size)
  })
  return (
    <group ref={ref} position={position}>
      <Billboard>{children}</Billboard>
    </group>
  )
}
