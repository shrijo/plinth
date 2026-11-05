import { useThree } from '@react-three/fiber'
import { useEffect } from 'react'
import { useEditor, useEditorContext } from '../context.ts'
import { InteractionController } from '../interaction.ts'
import { LabelProjector } from './LabelProjector.tsx'
import { withoutEditorMarks } from './pictures.ts'
import { Building } from './Building.tsx'
import { CameraRig } from './CameraRig.tsx'
import { DrawingOverlay } from './DrawingOverlay.tsx'
import { Effects } from './Effects.tsx'
import { Environment } from './Environment.tsx'
import { Ground } from './Ground.tsx'
import { NodeHandles } from './NodeHandles.tsx'
import { Rooms } from './Rooms.tsx'
import { ShellBuildings } from './ShellBuildings.tsx'
import { SiteHandles } from './SiteHandles.tsx'
import { Streets } from './Streets.tsx'
import { WorkPlane } from './WorkPlane.tsx'

export function Scene() {
  const mode = useEditor((s) => s.mode)
  const buildingId = useEditor((s) => s.buildingId)
  const inside = mode === 'building' && buildingId !== null
  return (
    <>
      <Environment />
      <CameraRig />
      <Ground />
      <Streets />
      <ShellBuildings />
      {inside ? (
        <>
          <Building buildingId={buildingId} />
          <WorkPlane />
          <Rooms />
          <NodeHandles />
        </>
      ) : (
        <SiteHandles />
      )}
      <DrawingOverlay />
      <LabelProjector />
      <InteractionLayer />
      <CaptureBridge />
      <Effects />
    </>
  )
}

/** Lets the app take a picture of the view (see PlinthEditorApi.captureImage). */
function CaptureBridge() {
  const { captureRef, renderRef, store } = useEditorContext()
  const get = useThree((s) => s.get)
  useEffect(() => {
    captureRef.current = async (width, height) => {
      // A picture of the city, so only from the site view (not from inside a building).
      if (store.getState().mode !== 'site') return null
      return snapshotView(width, height)
    }
    const snapshotView = (width: number, height: number): Promise<Blob | null> => {
      const { gl, scene, camera } = get()
      const source = gl.domElement
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext('2d')
      if (!context || source.width === 0 || source.height === 0) return Promise.resolve(null)
      const scale = Math.max(width / source.width, height / source.height)
      const w = width / scale
      const h = height / scale
      // Draw a frame without selection and handles (through the effects, if they're on) and copy
      // it before the browser clears it, all at once: the view on screen never changes.
      withoutEditorMarks(scene, () => {
        if (renderRef.current) renderRef.current()
        else gl.render(scene, camera)
        context.drawImage(source, (source.width - w) / 2, (source.height - h) / 2, w, h, 0, 0, width, height)
      })
      return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85))
    }
    return () => {
      captureRef.current = null
    }
  }, [captureRef, renderRef, store, get])
  return null
}

/** Connects pointer input on the canvas to the editor. */
function InteractionLayer() {
  const { doc, store, rootRef, pickables, controlsRef } = useEditorContext()
  const canvas = useThree((s) => s.gl.domElement)
  const get = useThree((s) => s.get)

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const controller = new InteractionController({
      doc,
      store,
      root,
      canvas,
      getCamera: () => get().camera,
      getControls: () => controlsRef.current,
      pickables,
    })
    return controller.attach()
  }, [doc, store, rootRef, canvas, get, controlsRef, pickables])

  return null
}
