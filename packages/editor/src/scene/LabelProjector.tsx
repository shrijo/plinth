import { useFrame } from '@react-three/fiber'
import { useState } from 'react'
import { Vector3 } from 'three'
import { useEditorContext } from '../context.ts'

/** Moves the DOM labels (see ui/Labels) to their points on screen, every frame. */
export function LabelProjector() {
  const { rootRef } = useEditorContext()
  const [point] = useState(() => new Vector3())

  useFrame(({ camera, size }) => {
    const layer = rootRef.current?.querySelector<HTMLElement>('.pe-labels')
    if (!layer) return
    for (const element of layer.children) {
      const label = element as HTMLElement
      point.set(Number(label.dataset.x), Number(label.dataset.y), Number(label.dataset.z))
      const max = label.dataset.max ? Number(label.dataset.max) : Infinity
      const far = camera.position.distanceTo(point) > max
      point.project(camera)
      // Behind the camera, beyond the far plane, or further than the label shows.
      if (far || point.z < -1 || point.z > 1) {
        label.style.visibility = 'hidden'
        continue
      }
      const x = ((point.x + 1) / 2) * size.width
      const y = ((1 - point.y) / 2) * size.height
      label.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -50%)`
      label.style.visibility = 'visible'
    }
  })

  return null
}
