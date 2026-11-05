import { CameraControls, CameraControlsImpl } from '@react-three/drei'
import { useThree } from '@react-three/fiber'
import { useEffect, useRef } from 'react'
import { Box3, PerspectiveCamera, Sphere, Vector3 } from 'three'
import { sortedLevels, stackHeight, type Snapshot } from '@plinth/core'
import { useEditor, useEditorContext, useSnapshot } from '../context.ts'
import { siteSphere } from './siteSphere.ts'
import { fieldOfView } from './lens.ts'

const MAX_POLAR = Math.PI / 2 - 0.05
const DEFAULT_AZIMUTH = Math.PI / 4
const DEFAULT_POLAR = Math.PI / 3.2
/** The top view looks straight down through a long lens from far away, so walls barely lean and it reads like a plan. */
const TOP_LENS = 200

/**
 * Camera controls. Left-drag moves over the ground (also middle-drag and a
 * two-finger trackpad drag, see InteractionController), right-drag orbits
 * (in the top view it turns the plan), the wheel or a pinch zooms. A
 * left-drag on something that can be moved moves it instead, and a click
 * still selects or places. On touch, drawing tools keep one finger for
 * drawing; two fingers pan and zoom, three orbit.
 * In the building editor the camera follows the active level up and down.
 * Opening a building flies in to it; going back to the site returns to
 * where the site view was.
 */
export function CameraRig() {
  const ref = useRef<CameraControlsImpl>(null)
  const { controlsRef } = useEditorContext()
  const getThree = useThree((s) => s.get)
  const tool = useEditor((s) => s.tool)
  const view = useEditor((s) => s.view)
  const lens = useEditor((s) => s.lens)
  const width = useThree((s) => s.size.width)
  const height = useThree((s) => s.size.height)
  const levelId = useEditor((s) => s.activeLevelId)
  const mode = useEditor((s) => s.mode)
  const buildingId = useEditor((s) => s.buildingId)
  const snapshot = useSnapshot()
  const elevation = mode === 'building' ? (snapshot.levels[levelId]?.elevation ?? 0) : 0
  const lastView = useRef(view)
  const viewRef = useRef(view)
  useEffect(() => {
    viewRef.current = view
  }, [view])
  const followed = useRef<{ place: string; elevation: number } | null>(null)
  const siteCamera = useRef<{ position: Vector3; target: Vector3; view: string } | null>(null)
  const snapshotRef = useRef(snapshot)
  useEffect(() => {
    snapshotRef.current = snapshot
  }, [snapshot])

  useEffect(() => {
    controlsRef.current = ref.current
    return () => {
      controlsRef.current = null
    }
  }, [controlsRef])

  useEffect(() => {
    const controls = ref.current
    if (!controls) return
    const A = CameraControlsImpl.ACTION
    const top = view === 'top'
    const drawing = tool !== 'select'
    // Screen pan: sideways and forwards over the ground, not up into the sky.
    controls.mouseButtons.left = A.SCREEN_PAN
    controls.mouseButtons.middle = A.SCREEN_PAN
    controls.mouseButtons.right = A.ROTATE
    // The wheel and pinch zoom towards what's under the pointer: handled by the interaction controller.
    controls.mouseButtons.wheel = A.NONE
    controls.touches.one = drawing ? A.NONE : top ? A.TOUCH_SCREEN_PAN : A.TOUCH_ROTATE
    // Implemented by camera-controls but missing from its type for two-finger actions.
    controls.touches.two = A.TOUCH_DOLLY_SCREEN_PAN as typeof A.TOUCH_DOLLY_TRUCK
    controls.touches.three = A.TOUCH_ROTATE
  }, [tool, view])

  // The lens: on a view change keep the same area in sight; a new lens or
  // window size just changes the field of view, like on a real camera.
  useEffect(() => {
    const controls = ref.current
    const camera = getThree().camera
    if (!controls || !(camera instanceof PerspectiveCamera)) return
    const top = view === 'top'
    const viewChanged = lastView.current !== view
    lastView.current = view
    controls.minDistance = top ? 5 : 0.5
    controls.maxDistance = top ? 20000 : 3000
    const fov = fieldOfView(top ? TOP_LENS : lens, width / Math.max(height, 1))
    // The focal length is the lens setting alone, never scaled by a zoom factor.
    if (camera.zoom !== 1) {
      camera.zoom = 1
      camera.updateProjectionMatrix()
    }
    if (Math.abs(camera.fov - fov) > 1e-6) {
      if (viewChanged) {
        // Distance scales with 1 / tan(fov / 2) for the same area.
        const ratio = Math.tan(((camera.fov / 2) * Math.PI) / 180) / Math.tan(((fov / 2) * Math.PI) / 180)
        void controls.dollyTo(controls.distance * ratio, false)
      }
      camera.fov = fov
      camera.updateProjectionMatrix()
    }
    if (!viewChanged) return
    if (top) {
      controls.minPolarAngle = 0
      controls.maxPolarAngle = 0
      void controls.rotateTo(0, 0, true)
    } else {
      controls.maxPolarAngle = MAX_POLAR
      void controls.rotateTo(DEFAULT_AZIMUTH, DEFAULT_POLAR, true)
    }
  }, [view, lens, width, height, getThree])

  // Start on the whole site: framed round what's on it, or looking across an empty one.
  useEffect(() => {
    const controls = ref.current
    if (!controls) return
    const sphere = siteSphere(snapshotRef.current)
    if (sphere) void controls.fitToSphere(sphere, false)
    else void controls.setLookAt(60, 50, 60, 0, 0, 0, false)
  }, [])

  // Fly in to a building when it's opened, and back to the site view when it's left.
  useEffect(() => {
    const controls = ref.current
    if (!controls) return
    if (mode === 'building' && buildingId) {
      siteCamera.current = {
        position: controls.getPosition(new Vector3()),
        target: controls.getTarget(new Vector3()),
        view: viewRef.current,
      }
      const sphere = buildingSphere(snapshotRef.current, buildingId)
      // From a pleasant height, whatever angle the site was seen from.
      if (viewRef.current === 'perspective') void controls.rotatePolarTo(DEFAULT_POLAR, true)
      if (sphere) void controls.fitToSphere(sphere, true)
    } else if (mode === 'site' && siteCamera.current) {
      const { position, target, view: savedView } = siteCamera.current
      siteCamera.current = null
      if (savedView === viewRef.current) {
        void controls.setLookAt(position.x, position.y, position.z, target.x, target.y, target.z, true)
      } else {
        void controls.moveTo(target.x, target.y, target.z, true)
      }
    }
  }, [mode, buildingId])

  // The orbit centre stays at or above the ground (the lowest floor inside a building), so
  // zooming towards the horizon can't take the camera underground.
  const floorLevel =
    mode === 'building' && buildingId ? Math.min(0, sortedLevels(snapshot, buildingId)[0]?.elevation ?? 0) : 0
  useEffect(() => {
    const controls = ref.current
    if (!controls) return
    controls.setBoundary(new Box3(new Vector3(-1e6, floorLevel, -1e6), new Vector3(1e6, 5000, 1e6)))
    controls.boundaryFriction = 0
  }, [floorLevel])

  // Follow the active level up and down; not when the place itself changed (that flies instead).
  const place = mode === 'building' ? `building:${buildingId}` : 'site'
  useEffect(() => {
    const controls = ref.current
    const last = followed.current
    followed.current = { place, elevation }
    if (!controls || !last || last.place !== place || last.elevation === elevation) return
    const target = controls.getTarget(new Vector3())
    void controls.moveTo(target.x, elevation, target.z, true)
  }, [place, elevation])

  return (
    <>
      <CameraControls
        ref={ref}
        makeDefault
        minDistance={0.5}
        maxDistance={3000}
        maxPolarAngle={MAX_POLAR}
        smoothTime={0.12}
        draggingSmoothTime={0.06}
      />
    </>
  )
}

/** A sphere around a building, from the ground to its top, to frame it. */
function buildingSphere(snapshot: Snapshot, buildingId: string): Sphere | null {
  const levels = sortedLevels(snapshot, buildingId)
  const ids = new Set(levels.map((l) => l.id))
  const points = Object.values(snapshot.nodes).filter((n) => ids.has(n.levelId))
  const bottom = levels[0]
  const top = levels.at(-1)
  if (points.length === 0 || !bottom || !top) return null
  const xs = points.map((p) => p.x)
  const ys = points.map((p) => p.y)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  const height = top.elevation + stackHeight(top) - bottom.elevation
  const centre = new Vector3((minX + maxX) / 2, bottom.elevation, -(minY + maxY) / 2)
  const radius = Math.hypot((maxX - minX) / 2, (maxY - minY) / 2, height * 0.6)
  return new Sphere(centre, Math.max(radius * 1.15, 4))
}

