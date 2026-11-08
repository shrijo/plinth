import {
  add,
  analyzeSite,
  controlThrough,
  CURB_HEIGHT,
  contentLevelId,
  dist,
  dot,
  findStacks,
  finishNodeMove,
  finishStreetMove,
  midpoint,
  moveBuilding,
  moveStreetNodes,
  pointOnCurve,
  isCopy,
  moveNodes,
  nodesOnLevel,
  normalize,
  openingCopies,
  openingsOnWall,
  openingType,
  rowReach,
  moveParcelCorner,
  moveSpotHeight,
  parcelAt,
  perpLeft,
  pointInRegion,
  resolveWall,
  scale,
  setStreetCurve,
  snap,
  sortedLevels,
  sub,
  updateOpening,
  wallsOnLevel,
  type Id,
  type OpeningKind,
  type PlinthDocument,
  type SnapContext,
  type Snapshot,
  type Vec2,
} from '@plinth/core'
import type { CameraControlsImpl } from '@react-three/drei'
import { Box3, Matrix4, PerspectiveCamera, Plane, Ray, Raycaster, Vector2, Vector3, type Camera, type Intersection, type Object3D } from 'three'
import { dropMissingSelection, enterBuilding, finishDrawing, placeOpening, placePoint, select } from './actions.ts'
import { buildingEdgesNear, streetAt, streetNodesNear, streetSegmentsNear } from './siteIndex.ts'
import {
  isSelected,
  parcelCornerId,
  parseParcelCorner,
  samePick,
  type EditorState,
  type EditorStore,
  type OpeningPreview,
  type Pick,
  type PointerKind,
} from './state.ts'

/** On touch, the point being placed sits this far above the finger so it stays visible. */
export const TOUCH_AIM_OFFSET_PX = 72
const SNAP_PX: Record<PointerKind, number> = { mouse: 12, pen: 12, touch: 26 }
const DRAG_START_PX: Record<PointerKind, number> = { mouse: 4, pen: 4, touch: 10 }
const OPENING_EDGE_MARGIN = 0.03
/** The nearest the camera comes to the surface it zooms towards, in metres. */
const ZOOM_CLOSEST = 1.5
/** The camera stays at least this high above the ground (metres): standing in the street. */
const EYE_HEIGHT = 1.7
/** Below this height (metres), zooming in levels the view out towards the horizon... */
const LEVEL_OUT_HEIGHT = 30
/** ...down to this angle below it (radians), so the horizon stays in view. */
const LOWEST_PITCH = 0.08

export interface InteractionDeps {
  doc: PlinthDocument
  store: EditorStore
  /** Receives pointer-down in the capture phase, before the camera controls see it. */
  root: HTMLElement
  canvas: HTMLCanvasElement
  getCamera: () => Camera
  getControls: () => CameraControlsImpl | null
  pickables: Map<string, Object3D>
}

interface Press {
  pointerId: number
  kind: PointerKind
  button: number
  startX: number
  startY: number
  moved: boolean
  pick: Pick | null
  shiftKey: boolean
}

interface WallAxis {
  a: Vec2
  dir: Vec2
  normal: Vec2
  elevation: number
  /** Where openings fit along the wall (see WallFootprint). */
  clearStart: number
  clearEnd: number
  /** The wall's lowest top, above its base. */
  top: number
}

/** Resize handles: corners and edge middles, named from the wall's start (left) and its base (bottom). */
export type OpeningHandle = 'tl' | 't' | 'tr' | 'r' | 'br' | 'b' | 'bl' | 'l'

const MIN_OPENING_SIZE = 0.2
const MIN_LINTEL = 0.05

interface WallPoint {
  along: number
  height: number
}

type Drag =
  | {
      kind: 'node'
      nodeId: Id
      levelId: Id
      /** Every point that moves with it: itself, plus the same point on other floors in the whole-building view. */
      stack: Id[]
      attachedWalls: Set<Id>
      /** The far end of the node's only wall, for angle snapping. */
      anchor: Vec2 | null
      moved: boolean
    }
  | {
      kind: 'wall'
      levelId: Id
      /** Where each moving point started: the wall's ends, on every floor of its stack. */
      starts: Map<Id, Vec2>
      normal: Vec2
      startPoint: Vec2
      moved: boolean
    }
  | {
      kind: 'opening'
      openingId: Id
      axis: WallAxis
      /** Where the opening was grabbed, relative to its centre and sill. */
      grabAlong: number
      grabHeight: number
      /** From its centre to its outer edge along the wall: half the width, or more for a row. */
      reach: number
      height: number
      isDoor: boolean
      moved: boolean
    }
  | { kind: 'building'; buildingId: Id; start: Vec2; applied: Vec2; moved: boolean }
  | { kind: 'streetNode'; nodeId: Id; moved: boolean }
  | { kind: 'parcelCorner'; parcelId: Id; index: number; moved: boolean }
  | { kind: 'spotHeight'; spotId: Id; moved: boolean }
  | { kind: 'streetCurve'; streetId: Id; moved: boolean }
  | { kind: 'street'; starts: Map<Id, Vec2>; startPoint: Vec2; moved: boolean }
  | {
      kind: 'resize'
      openingId: Id
      axis: WallAxis
      handle: OpeningHandle
      start: WallPoint
      /** The opening's edges when the drag started: along the wall and above its base. */
      initial: { s0: number; s1: number; z0: number; z1: number }
      isDoor: boolean
      moved: boolean
    }

const isOpeningTool = (tool: EditorState['tool']): tool is OpeningKind => tool === 'window' || tool === 'door'

/**
 * Turns pointer input on the canvas into editor actions: drawing with the
 * wall and rectangle tools, placing windows and doors, and picking and
 * dragging with the select tool. Camera gestures are left to the camera controls.
 */
export class InteractionController {
  private readonly deps: InteractionDeps
  private readonly raycaster = new Raycaster()
  private readonly plane = new Plane(new Vector3(0, 1, 0), 0)
  private readonly ndc = new Vector2()
  private readonly hit = new Vector3()
  private readonly activePointers = new Set<number>()
  private press: Press | null = null
  private drag: Drag | null = null
  // Scratch objects for testing walls as solid boxes.
  private readonly basis = new Matrix4()
  private readonly inverse = new Matrix4()
  private readonly localRay = new Ray()
  private readonly box = new Box3()
  private readonly local = new Vector3()
  private readonly axes = [new Vector3(), new Vector3(0, 1, 0), new Vector3()] as const

  constructor(deps: InteractionDeps) {
    this.deps = deps
  }

  attach(): () => void {
    const { root } = this.deps
    root.addEventListener('pointerdown', this.onPointerDown, { capture: true })
    window.addEventListener('pointermove', this.onPointerMove)
    window.addEventListener('pointerup', this.onPointerUp)
    window.addEventListener('pointercancel', this.onPointerCancel)
    root.addEventListener('pointerleave', this.onPointerLeave)
    root.addEventListener('contextmenu', this.onContextMenu)
    root.addEventListener('dblclick', this.onDoubleClick)
    // Capture phase, so a trackpad scroll can pan before the camera controls turn it into a zoom.
    root.addEventListener('wheel', this.onWheel, { capture: true, passive: false })
    root.addEventListener('gesturestart', this.onGestureStart)
    root.addEventListener('gesturechange', this.onGestureChange)
    root.addEventListener('gestureend', this.onGestureEnd)
    return () => {
      root.removeEventListener('gesturestart', this.onGestureStart)
      root.removeEventListener('gesturechange', this.onGestureChange)
      root.removeEventListener('gestureend', this.onGestureEnd)
      root.removeEventListener('pointerdown', this.onPointerDown, { capture: true })
      window.removeEventListener('pointermove', this.onPointerMove)
      window.removeEventListener('pointerup', this.onPointerUp)
      window.removeEventListener('pointercancel', this.onPointerCancel)
      root.removeEventListener('pointerleave', this.onPointerLeave)
      root.removeEventListener('contextmenu', this.onContextMenu)
      root.removeEventListener('dblclick', this.onDoubleClick)
      root.removeEventListener('wheel', this.onWheel, { capture: true })
      this.setControlsEnabled(true)
    }
  }

  private get state(): EditorState {
    return this.deps.store.getState()
  }

  private onPointerDown = (e: PointerEvent): void => {
    const handle = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-opening-handle]') : null
    if (handle) {
      this.startResize(e, handle)
      return
    }
    if (e.target !== this.deps.canvas) return
    const kind = pointerKind(e)
    this.activePointers.add(e.pointerId)
    if (this.state.pointerKind !== kind) this.deps.store.setState({ pointerKind: kind })

    // A second finger means a camera gesture: drop whatever the first one started.
    if (this.activePointers.size > 1) {
      this.cancelPress()
      return
    }

    this.press = {
      pointerId: e.pointerId,
      kind,
      button: e.button,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
      pick: null,
      shiftKey: e.shiftKey,
    }

    const tool = this.state.tool
    if (tool === 'select') {
      if (e.button !== 0) return
      const pick = this.pickAt(e.clientX, e.clientY, kind)
      this.press.pick = pick
      // Pressing on something that can be dragged drags it instead of moving the view.
      if (pick && this.canDrag(pick)) this.setControlsEnabled(false)
    } else if (e.button === 0) {
      // The Street tool also moves street points and bends streets, from their handles.
      if (tool === 'street' && !this.state.anchor) {
        const handle = this.streetHandleAt(e.clientX, e.clientY, kind, this.deps.doc.getSnapshot())
        if (handle) {
          this.press.pick = handle
          this.setControlsEnabled(false)
          return
        }
      }
      // The Parcel tool moves parcel corners from their handles (when not drawing one), the Terrain tool spot heights.
      if ((tool === 'parcel' && this.state.draft.length === 0) || tool === 'terrain') {
        const snapshot = this.deps.doc.getSnapshot()
        const corner =
          tool === 'parcel'
            ? this.parcelCornerAt(e.clientX, e.clientY, kind, snapshot)
            : this.spotHeightAt(e.clientX, e.clientY, kind, snapshot)
        if (corner) {
          this.press.pick = corner
          this.setControlsEnabled(false)
          return
        }
      }
      if (isOpeningTool(tool)) this.updateOpeningPreview(e, tool)
      else this.updateCursor(e)
    }
  }

  private onPointerMove = (e: PointerEvent): void => {
    const press = this.press
    const tool = this.state.tool
    if (press && e.pointerId === press.pointerId) {
      if (
        !press.moved &&
        Math.hypot(e.clientX - press.startX, e.clientY - press.startY) > DRAG_START_PX[press.kind]
      ) {
        press.moved = true
      }
      if (press.pick && this.canDrag(press.pick)) {
        if (press.moved) {
          if (!this.drag) this.startDrag(press)
          this.updateDrag(e)
        }
      } else if (tool !== 'select' && press.button === 0) {
        if (isOpeningTool(tool)) this.updateOpeningPreview(e, tool)
        else this.updateCursor(e)
      }
      return
    }

    if (this.activePointers.size > 0 || e.target !== this.deps.canvas) return
    const kind = pointerKind(e)
    if (kind === 'touch') return
    if (tool === 'select') {
      const pick = this.pickAt(e.clientX, e.clientY, kind)
      if (!samePick(pick, this.state.hover)) this.deps.store.setState({ hover: pick })
    } else if (tool === 'street' && !this.state.anchor) {
      // Handles under the pointer light up; otherwise the street under it shows its bend handle.
      const snapshot = this.deps.doc.getSnapshot()
      const hover = this.streetHandleAt(e.clientX, e.clientY, kind, snapshot) ?? this.streetUnder(e.clientX, e.clientY)
      if (!samePick(hover, this.state.hover)) this.deps.store.setState({ hover })
      this.updateCursor(e)
    } else if ((tool === 'parcel' && this.state.draft.length === 0) || tool === 'terrain') {
      const snapshot = this.deps.doc.getSnapshot()
      const hover =
        tool === 'parcel'
          ? this.parcelCornerAt(e.clientX, e.clientY, kind, snapshot)
          : this.spotHeightAt(e.clientX, e.clientY, kind, snapshot)
      if (!samePick(hover, this.state.hover)) this.deps.store.setState({ hover })
      this.updateCursor(e)
    } else if (isOpeningTool(tool)) {
      this.updateOpeningPreview(e, tool)
    } else {
      this.updateCursor(e)
    }
  }

  private onPointerUp = (e: PointerEvent): void => {
    this.activePointers.delete(e.pointerId)
    const press = this.press
    if (!press || press.pointerId !== e.pointerId) return
    this.press = null
    const ctx = this.deps
    const tool = this.state.tool

    if (this.drag) {
      this.endDrag()
      this.setControlsEnabled(true)
      return
    }
    this.setControlsEnabled(true)
    if (tool === 'select') {
      if (press.button === 0 && !press.moved) select(ctx, press.pick, press.shiftKey)
      return
    }
    // A click on a handle (not a drag) selects what it belongs to.
    if (press.button === 0 && !press.moved && (press.pick?.kind === 'parcelCorner' || press.pick?.kind === 'spotHeight')) {
      const pick = press.pick.kind === 'parcelCorner' ? { kind: 'parcel' as const, id: parseParcelCorner(press.pick.id).parcelId } : press.pick
      select(ctx, pick, press.shiftKey)
      return
    }

    // A right click without dragging ends the chain; right-drag orbits.
    if (press.button === 2) {
      if (!press.moved) finishDrawing(ctx)
      return
    }
    if (press.button !== 0) return
    // A mouse drag is not a click. On touch, moving is how you aim.
    if (press.kind !== 'touch' && press.moved) return

    if (isOpeningTool(tool)) {
      const preview = this.state.openingPreview
      if (preview) placeOpening(ctx, preview, tool)
      if (press.kind === 'touch') this.deps.store.setState({ openingPreview: null })
      return
    }
    // While typing a length on touch, the finger only aims the direction.
    if (press.kind === 'touch' && this.state.lengthInput !== null) return
    const cursor = this.state.cursor
    if (cursor) placePoint(ctx, cursor.point)
  }

  /**
   * Double-clicking a door or window opens or closes it, whatever the tool.
   * (The two clicks themselves are harmless: drawing tools end a chain when
   * the same point is placed twice, and the opening tools show no preview
   * over an existing opening.)
   */
  private onDoubleClick = (e: MouseEvent): void => {
    if (e.target !== this.deps.canvas) return
    const pick = this.pickAt(e.clientX, e.clientY, 'mouse')
    // On the site, double-clicking a building (or one of its shell handles) goes inside.
    if (this.state.mode === 'site') {
      const snapshot = this.deps.doc.getSnapshot()
      const buildingId =
        pick?.kind === 'building'
          ? pick.id
          : pick?.kind === 'node'
            ? snapshot.levels[snapshot.nodes[pick.id]?.levelId ?? '']?.buildingId
            : undefined
      if (buildingId) enterBuilding(this.deps, buildingId)
      return
    }
    if (pick?.kind !== 'opening') return
    const opening = this.deps.doc.getSnapshot().openings[pick.id]
    if (opening) this.deps.doc.transact((tx) => updateOpening(tx, pick.id, { open: !opening.open }))
  }

  /**
   * A two-finger drag on a trackpad pans the view, following the fingers. A
   * mouse wheel or a pinch (which arrives as a wheel event with Ctrl held)
   * moves the camera closer or further (see zoomAt).
   */
  private onWheel = (e: WheelEvent): void => {
    if (e.target !== this.deps.canvas) return
    if (e.ctrlKey) {
      // The camera controls would turn a pinch into a lens zoom, changing the focal length. Not here.
      e.preventDefault()
      e.stopPropagation()
      // Safari reports pinches as gesture events too; those are handled there.
      if (this.gestureScale !== null) return
      const delta = Math.max(-50, Math.min(50, e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY))
      this.zoomAt(Math.exp(delta * 0.01), e.clientX, e.clientY)
      return
    }
    if (!isTrackpadScroll(e)) {
      e.preventDefault()
      e.stopPropagation()
      // A notch is about 100 pixels: about a sixth of the way per notch.
      const delta = Math.max(-150, Math.min(150, e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY))
      this.zoomAt(Math.exp(delta * 0.0018), e.clientX, e.clientY)
      return
    }
    const controls = this.deps.getControls()
    const camera = this.deps.getCamera()
    if (!controls || !controls.enabled) return
    e.preventDefault()
    e.stopPropagation()
    const fov = camera instanceof PerspectiveCamera ? camera.fov : 40
    const height = this.deps.canvas.getBoundingClientRect().height || 1
    // Metres per screen pixel at the orbit centre, so the view keeps pace with the fingers.
    const perPixel = (2 * controls.distance * Math.tan((fov * Math.PI) / 360)) / height
    // Like a left-drag: sideways and forwards over the ground.
    void controls.truck(e.deltaX * perPixel, 0, false)
    void controls.forward(-e.deltaY * perPixel, false)
  }

  /** Safari's pinch: the scale since the gesture started, or null when there's none. */
  private gestureScale: number | null = null

  private onGestureStart = (e: Event): void => {
    e.preventDefault()
    this.gestureScale = 1
  }

  private onGestureChange = (e: Event): void => {
    e.preventDefault()
    const gesture = e as Event & { scale: number; clientX: number; clientY: number }
    if (this.gestureScale === null || !gesture.scale) return
    // Fingers apart (scale up) brings the camera closer.
    this.zoomAt(this.gestureScale / gesture.scale, gesture.clientX, gesture.clientY)
    this.gestureScale = gesture.scale
  }

  private onGestureEnd = (e: Event): void => {
    e.preventDefault()
    this.gestureScale = null
  }

  /**
   * Moves the camera towards (factor < 1) or away from (factor > 1) what is
   * under the pointer: the building, street or ground the pointer is on,
   * which stays under the pointer. The camera keeps its direction and lens,
   * slows as it nears that surface and stops short of it, so it never
   * flies into a building. The orbit centre moves to the depth of what was
   * zoomed to, on the line of sight, so orbiting afterwards turns round it.
   */
  private zoomAt(factor: number, clientX: number, clientY: number): void {
    const controls = this.deps.getControls()
    if (!controls || !controls.enabled || !Number.isFinite(factor) || factor <= 0) return
    const position = controls.getPosition(new Vector3())
    const target = controls.getTarget(new Vector3())
    const axis = target.clone().sub(position)
    const distance = axis.length()
    if (distance === 0) return
    axis.divideScalar(distance)
    // No nearer than the controls allow either (the top view keeps further off), or they'd push the camera back.
    const closest = Math.max(ZOOM_CLOSEST, controls.minDistance)
    const floor = this.floorLevel()
    const focus = this.zoomFocus(clientX, clientY, floor)

    if (!focus) {
      // Nothing under the pointer (the sky): straight along the line of sight.
      const next = Math.min(Math.max(distance * factor, closest), controls.maxDistance)
      position.addScaledVector(axis, distance - next)
    } else {
      const toFocus = focus.clone().sub(position)
      const away = toFocus.length()
      if (factor < 1 && away <= closest) return
      const next = Math.min(Math.max(away * factor, closest), controls.maxDistance)
      position.copy(focus).addScaledVector(toFocus.normalize(), -next)
    }
    // Never below eye height. Low down, look out across the ground rather than down at it, more so
    // the lower the camera gets, so zooming towards the street ends up in it, looking along it.
    position.y = Math.max(position.y, floor + EYE_HEIGHT)
    const height = position.y - floor
    if (factor < 1 && this.state.view !== 'top' && height < LEVEL_OUT_HEIGHT) {
      const pitch = Math.asin(Math.min(Math.max(-axis.y, -1), 1))
      const level = Math.min(pitch, Math.max(LOWEST_PITCH, pitch * (height / LEVEL_OUT_HEIGHT)))
      const flat = Math.hypot(axis.x, axis.z)
      if (level < pitch && flat > 1e-6) {
        axis.set((axis.x / flat) * Math.cos(level), -Math.sin(level), (axis.z / flat) * Math.cos(level))
      }
    }
    // The orbit centre: on the line of sight at the depth of the focus, but not below the floor.
    let depth = focus ? focus.clone().sub(position).dot(axis) : position.distanceTo(target)
    if (axis.y < -1e-6) depth = Math.min(depth, (floor - position.y) / axis.y)
    depth = Math.max(depth, closest)
    target.copy(position).addScaledVector(axis, depth)
    void controls.setLookAt(position.x, position.y, position.z, target.x, target.y, target.z, true)
  }

  /** The last point zoomed to, kept for a moment so a run of wheel events doesn't search the city each time. */
  private lastFocus: { x: number; y: number; time: number; point: Vector3 | null } | null = null

  /** What is under the pointer to zoom towards: the nearest building or street surface, or the ground. */
  private zoomFocus(clientX: number, clientY: number, floor: number): Vector3 | null {
    const now = performance.now()
    const last = this.lastFocus
    if (last && now - last.time < 250 && Math.hypot(clientX - last.x, clientY - last.y) < 4) {
      last.time = now
      return last.point?.clone() ?? null
    }
    this.setRay(clientX, clientY)
    const ray = this.raycaster.ray
    let point: Vector3 | null = null
    const hit = this.raycaster.intersectObjects([...this.deps.pickables.values()], false)[0]
    if (hit) point = hit.point.clone()
    const ground = ray.intersectPlane(this.plane.set(new Vector3(0, 1, 0), -this.workElevation(floor)), new Vector3())
    if (ground && (!point || ground.distanceTo(ray.origin) < point.distanceTo(ray.origin))) point = ground
    // Too far to be useful (near the horizon): no focus, so the zoom goes along the line of sight.
    const controls = this.deps.getControls()
    if (point && controls && point.distanceTo(ray.origin) > controls.maxDistance * 2) point = null
    this.lastFocus = { x: clientX, y: clientY, time: now, point }
    return point?.clone() ?? null
  }

  /** The lowest the orbit centre goes: the ground, or a building's lowest floor when it has a basement. */
  private floorLevel(): number {
    const { mode, buildingId } = this.state
    if (mode !== 'building' || !buildingId) return 0
    return Math.min(0, sortedLevels(this.deps.doc.getSnapshot(), buildingId)[0]?.elevation ?? 0)
  }

  /** The level the ground plane is taken at for zooming: the active floor in the building editor. */
  private workElevation(floor: number): number {
    if (this.state.mode !== 'building') return floor
    return this.deps.doc.getSnapshot().levels[this.state.activeLevelId]?.elevation ?? floor
  }

  private onPointerCancel = (e: PointerEvent): void => {
    this.activePointers.delete(e.pointerId)
    if (this.press?.pointerId === e.pointerId) this.cancelPress()
  }

  private onPointerLeave = (): void => {
    if (this.press) return
    const { hover, cursor, openingPreview } = this.state
    if (hover || cursor || openingPreview) {
      this.deps.store.setState({ hover: null, cursor: null, openingPreview: null })
    }
  }

  private onContextMenu = (e: Event): void => {
    e.preventDefault()
  }

  private cancelPress(): void {
    if (this.drag) this.endDrag()
    this.press = null
    this.setControlsEnabled(true)
  }

  private setControlsEnabled(enabled: boolean): void {
    const controls = this.deps.getControls()
    if (controls) controls.enabled = enabled
  }

  // Projection

  /** The point on the horizontal plane at `elevation` under a screen position. */
  private planPoint(clientX: number, clientY: number, elevation: number): Vec2 | null {
    this.setRay(clientX, clientY)
    this.plane.set(new Vector3(0, 1, 0), -elevation)
    const hit = this.raycaster.ray.intersectPlane(this.plane, this.hit)
    return hit ? { x: hit.x, y: -hit.z } : null
  }

  /** The point on a wall's own vertical plane under a screen position: along the wall, and above its base. */
  private onWall(clientX: number, clientY: number, axis: WallAxis): WallPoint | null {
    this.setRay(clientX, clientY)
    const normal = new Vector3(axis.normal.x, 0, -axis.normal.y)
    this.plane.setFromNormalAndCoplanarPoint(normal, new Vector3(axis.a.x, axis.elevation, -axis.a.y))
    const hit = this.raycaster.ray.intersectPlane(this.plane, this.hit)
    if (!hit) return null
    return { along: dot(sub({ x: hit.x, y: -hit.z }, axis.a), axis.dir), height: hit.y - axis.elevation }
  }

  private setRay(clientX: number, clientY: number): void {
    const rect = this.deps.canvas.getBoundingClientRect()
    this.ndc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    )
    this.raycaster.setFromCamera(this.ndc, this.deps.getCamera())
  }

  /** Snap distance in metres for a screen position. */
  private tolerance(clientX: number, clientY: number, elevation: number, kind: PointerKind): number {
    const a = this.planPoint(clientX, clientY, elevation)
    const b = this.planPoint(clientX + 10, clientY, elevation)
    if (!a || !b) return 0.1
    return Math.min((dist(a, b) / 10) * SNAP_PX[kind], 5)
  }

  // Drawing tools

  private updateCursor(e: PointerEvent): void {
    const snapshot = this.deps.doc.getSnapshot()
    const state = this.state
    const site = state.mode === 'site'
    const level = snapshot.levels[state.activeLevelId]
    if (!site && !level) return
    const elevation = site ? 0 : level!.elevation
    const kind = pointerKind(e)
    const y = kind === 'touch' ? e.clientY - TOUCH_AIM_OFFSET_PX : e.clientY
    const raw = this.planPoint(e.clientX, y, elevation)
    if (!raw) return
    const tolerance = this.tolerance(e.clientX, y, elevation, kind)
    const ctx = site
      ? this.siteSnapContext(snapshot, state, tolerance, e.altKey, raw)
      : this.snapContext(snapshot, state, state.activeLevelId, tolerance, e.altKey)
    ctx.anchor = state.anchor
    ctx.guidePoints = [...(state.chainStart ? [state.chainStart] : []), ...state.draft]
    this.deps.store.setState({ cursor: snap(raw, ctx) })
  }

  /**
   * What drawing on the site snaps to: street points and centre lines, and
   * the ground-floor corners and outer walls of the buildings.
   */
  private siteSnapContext(
    snapshot: Snapshot,
    state: EditorState,
    tolerance: number,
    suspended: boolean,
    near: Vec2,
    excludeStreetNodes: ReadonlySet<Id> = new Set(),
    excludeStreets: ReadonlySet<Id> = new Set(),
  ): SnapContext {
    // Only what lies around the pointer, from spatial indexes: a city is too big to test it all.
    const radius = Math.max(tolerance * 8, 40)
    const points: SnapContext['points'][number][] = streetNodesNear(snapshot, near, radius)
      .filter((id) => !excludeStreetNodes.has(id))
      .flatMap((id) => snapshot.streetNodes[id] ?? [])
    // The corners of a building outline being drawn, so it can be closed on its first corner.
    state.draft.forEach((p, i) => points.push({ id: `draft:${i}`, x: p.x, y: p.y }))
    const segments: SnapContext['segments'][number][] = []
    for (const s of streetSegmentsNear(snapshot, near, radius)) {
      if (!excludeStreets.has(s.id)) segments.push({ wallId: s.id, a: s.a, b: s.b })
    }
    buildingEdgesNear(analyzeSite(snapshot).buildings, near, radius).forEach((s, i) => {
      segments.push({ wallId: `${s.id}:${i}`, a: s.a, b: s.b })
      points.push({ id: `${s.id}:${i}`, x: s.a.x, y: s.a.y })
    })
    return {
      points,
      segments,
      settings: { ...state.snap, enabled: state.snap.enabled && !suspended && !state.snapSuspended },
      tolerance,
    }
  }


  /**
   * What drawing snaps to: the active level's walls and points, plus those of
   * the level below so walls can be stacked on walls.
   */
  private snapContext(
    snapshot: Snapshot,
    state: EditorState,
    levelId: Id,
    tolerance: number,
    suspended: boolean,
    excludeNodes: ReadonlySet<Id> = new Set(),
    excludeWalls: ReadonlySet<Id> = new Set(),
  ): SnapContext {
    const levels = sortedLevels(snapshot, snapshot.levels[levelId]?.buildingId)
    const index = levels.findIndex((l) => l.id === levelId)
    const active = levels[index]
    const below = levels[index - 1]
    const sources = [active, below].filter((l) => !!l).map(contentLevelId)

    const points: SnapContext['points'][number][] = []
    const segments: SnapContext['segments'][number][] = []
    for (const levelId of new Set(sources)) {
      for (const node of nodesOnLevel(snapshot, levelId)) {
        if (!excludeNodes.has(node.id)) points.push(node)
      }
      for (const wall of wallsOnLevel(snapshot, levelId)) {
        if (excludeWalls.has(wall.id)) continue
        const a = snapshot.nodes[wall.a]
        const b = snapshot.nodes[wall.b]
        if (a && b) segments.push({ wallId: wall.id, a, b })
      }
    }
    return {
      points,
      segments,
      settings: {
        ...state.snap,
        enabled: state.snap.enabled && !suspended && !state.snapSuspended,
      },
      tolerance,
    }
  }

  // Window and door tools

  private updateOpeningPreview(e: PointerEvent, kind: OpeningKind): void {
    const { store, doc } = this.deps
    const pointer = pointerKind(e)
    const y = pointer === 'touch' ? e.clientY - TOUCH_AIM_OFFSET_PX : e.clientY
    const preview = this.openingAt(e.clientX, y, kind, doc.getSnapshot(), e.altKey)
    const current = this.state.openingPreview
    if (preview?.wallId !== current?.wallId || preview?.offset !== current?.offset) {
      store.setState({ openingPreview: preview })
    }
  }

  /** Where a new opening would go under the pointer: on a wall of the active level. */
  private openingAt(
    clientX: number,
    clientY: number,
    kind: OpeningKind,
    snapshot: Snapshot,
    suspended: boolean,
  ): OpeningPreview | null {
    const state = this.state
    if (isCopy(snapshot.levels[state.activeLevelId])) return null
    const hit = this.wallUnder(clientX, clientY, snapshot, state.activeLevelId)
    if (!hit) return null
    const footprint = analyzeSite(snapshot).byLevel.get(state.activeLevelId)?.footprints.get(hit.wallId)
    if (!footprint) return null

    let offset = hit.along
    const width = openingType(state.openingTypes[kind], kind).defaults.width
    const min = footprint.clearStart + width / 2 + OPENING_EDGE_MARGIN
    const max = footprint.clearEnd - width / 2 - OPENING_EDGE_MARGIN
    if (min > max) return null
    if (state.snap.enabled && !suspended && !state.snapSuspended) {
      const middle = (footprint.clearStart + footprint.clearEnd) / 2
      const elevation = snapshot.levels[state.activeLevelId]?.elevation ?? 0
      const tolerance = this.tolerance(clientX, clientY, elevation, state.pointerKind)
      offset =
        Math.abs(offset - middle) < tolerance
          ? middle
          : Math.round(offset / state.snap.lengthStep) * state.snap.lengthStep
    }
    offset = Math.min(Math.max(offset, min), max)
    // Not over an existing opening: there a click selects it and a double-click opens it.
    const overlaps = openingsOnWall(snapshot, hit.wallId)
      .flatMap(openingCopies)
      .some((o) => Math.abs(o.offset - offset) < (o.width + width) / 2)
    return overlaps ? null : { wallId: hit.wallId, offset }
  }

  /**
   * The nearest wall of a level under a screen position, testing each wall
   * as a solid box. Holes are ignored on purpose: the preview of a new
   * opening cuts a hole right under the pointer, and the wall must not
   * disappear from under it.
   */
  private wallUnder(
    clientX: number,
    clientY: number,
    snapshot: Snapshot,
    levelId: Id,
  ): { wallId: Id; along: number } | null {
    const level = snapshot.levels[levelId]
    const footprints = analyzeSite(snapshot).byLevel.get(levelId)?.footprints
    if (!level || !footprints) return null
    this.setRay(clientX, clientY)
    const [xAxis, yAxis, zAxis] = this.axes
    let best: { wallId: Id; along: number } | null = null
    let bestDistance = Infinity
    for (const [wallId, footprint] of footprints) {
      const wall = snapshot.walls[wallId]
      const length = dist(footprint.a, footprint.b)
      if (!wall || length === 0) continue
      const { heightStart, heightEnd } = resolveWall(wall, level, snapshot.meta)
      const dir = normalize(sub(footprint.b, footprint.a))
      // Wall-local frame: x along the wall, y up, z across it.
      xAxis.set(dir.x, 0, -dir.y)
      zAxis.set(dir.y, 0, dir.x)
      this.basis.makeBasis(xAxis, yAxis, zAxis).setPosition(footprint.a.x, level.elevation, -footprint.a.y)
      this.inverse.copy(this.basis).invert()
      this.localRay.copy(this.raycaster.ray).applyMatrix4(this.inverse)
      const half = footprint.thickness / 2
      this.box.min.set(0, 0, -half)
      this.box.max.set(length, Math.max(heightStart, heightEnd), half)
      const hit = this.localRay.intersectBox(this.box, this.local)
      if (!hit) continue
      const distance = hit.distanceTo(this.localRay.origin)
      if (distance < bestDistance) {
        bestDistance = distance
        best = { wallId, along: hit.x }
      }
    }
    return best
  }

  // Select tool

  private pickAt(clientX: number, clientY: number, kind: PointerKind): Pick | null {
    const snapshot = this.deps.doc.getSnapshot()
    if (this.state.mode === 'site') return this.pickSite(clientX, clientY, kind, snapshot)
    // With the whole building shown there's no floor in focus: only walls and openings can be picked.
    const level = this.state.wholeBuilding ? undefined : snapshot.levels[this.state.activeLevelId]
    const planHit = level ? this.planPoint(clientX, clientY, level.elevation) : null

    // Points of the active level first: they're small and sit under walls.
    if (level && planHit && !isCopy(level)) {
      const tolerance = this.tolerance(clientX, clientY, level.elevation, kind) * 0.8
      let best: Pick | null = null
      let bestDistance = tolerance
      for (const node of nodesOnLevel(snapshot, level.id)) {
        const d = dist(node, planHit)
        if (d < bestDistance) {
          best = { kind: 'node', id: node.id }
          bestDistance = d
        }
      }
      if (best) return best
    }

    // In the whole-building view, points of every floor, by where they are on screen.
    if (this.state.wholeBuilding) {
      const node = this.nodeOnScreen(clientX, clientY, kind, snapshot)
      if (node) return { kind: 'node', id: node }
    }

    this.setRay(clientX, clientY)
    const hits = this.raycaster.intersectObjects([...this.deps.pickables.values()], false)
    const first = hits.find((h) => pickOfHit(h))
    if (first) {
      const pick = pickOfHit(first)!
      // Openings sit inside their wall: from above, the ray meets the wall's top
      // first. Prefer an opening of that wall the ray reaches just after.
      if (pick.kind === 'wall') {
        const inside = hits.find((h) => {
          const p = h.object.userData.pick as Pick | undefined
          return (
            p?.kind === 'opening' &&
            snapshot.openings[p.id]?.wallId === pick.id &&
            h.distance - first.distance < 1.5
          )
        })
        if (inside) return inside.object.userData.pick as Pick
      }
      return pick
    }

    // Then the floor of a room on the active level.
    if (level && planHit) {
      const rooms = analyzeSite(snapshot).byLevel.get(level.id)?.rooms ?? []
      const room = rooms.find((r) => pointInRegion(planHit, r.floor))
      if (room) return { kind: 'room', id: room.id }
    }
    return null
  }

  /** Where a world point is on screen, or null behind the camera. */
  private screenOf(x: number, y: number, z: number): { x: number; y: number } | null {
    const rect = this.deps.canvas.getBoundingClientRect()
    this.local.set(x, y, z).project(this.deps.getCamera())
    if (this.local.z > 1) return null
    return { x: rect.left + ((this.local.x + 1) / 2) * rect.width, y: rect.top + ((1 - this.local.y) / 2) * rect.height }
  }

  /**
   * Picking on the site. Handles first (the selected building's shell
   * corners and wall middles, the selected street's bend handle, street
   * points), then buildings and streets under the pointer.
   */
  /**
   * What a click on the site picks: a point of a selected street (they show
   * as handles), otherwise the building or street under the pointer.
   */
  private pickSite(clientX: number, clientY: number, kind: PointerKind, snapshot: Snapshot): Pick | null {
    let best: Pick | null = null
    let bestDistance = SNAP_PX[kind] * 0.8
    for (const id of this.state.selection.streets) {
      const street = snapshot.streets[id]
      for (const nodeId of street ? [street.a, street.b] : []) {
        const node = snapshot.streetNodes[nodeId]
        const p = node && this.screenOf(node.x, CURB_HEIGHT, -node.y)
        if (!p) continue
        const d = Math.hypot(p.x - clientX, p.y - clientY)
        if (d < bestDistance) {
          best = { kind: 'streetNode', id: nodeId }
          bestDistance = d
        }
      }
    }
    if (best) return best
    const under = this.streetUnder(clientX, clientY, true)
    if (under) return under
    // Nothing else there: the parcel the ground under the pointer is on.
    const ground = this.planPoint(clientX, clientY, 0)
    const parcel = ground && parcelAt(snapshot, ground)
    return parcel ? { kind: 'parcel', id: parcel.id } : null
  }

  /** In the Terrain tool: the spot height within a few pixels of a screen position. */
  private spotHeightAt(clientX: number, clientY: number, kind: PointerKind, snapshot: Snapshot): Pick | null {
    let best: Pick | null = null
    let bestDistance = SNAP_PX[kind] * 0.8
    const base = snapshot.meta.ground ?? 0
    for (const spot of Object.values(snapshot.spotHeights)) {
      const screen = this.screenOf(spot.x, spot.z - base, -spot.y)
      if (!screen) continue
      const d = Math.hypot(screen.x - clientX, screen.y - clientY)
      if (d < bestDistance) {
        best = { kind: 'spotHeight', id: spot.id }
        bestDistance = d
      }
    }
    return best
  }

  /** In the Parcel tool: the parcel corner within a few pixels of a screen position. */
  private parcelCornerAt(clientX: number, clientY: number, kind: PointerKind, snapshot: Snapshot): Pick | null {
    let best: Pick | null = null
    let bestDistance = SNAP_PX[kind] * 0.8
    for (const parcel of Object.values(snapshot.parcels)) {
      parcel.points.forEach((p, i) => {
        const screen = this.screenOf(p.x, 0.05, -p.y)
        if (!screen) return
        const d = Math.hypot(screen.x - clientX, screen.y - clientY)
        if (d < bestDistance) {
          best = { kind: 'parcelCorner', id: parcelCornerId(parcel.id, i) }
          bestDistance = d
        }
      })
    }
    return best
  }

  /**
   * In the Street tool: the street point, or the bend handle of the street
   * under the pointer (or selected), within a few pixels of a screen position.
   */
  private streetHandleAt(clientX: number, clientY: number, kind: PointerKind, snapshot: Snapshot): Pick | null {
    let best: Pick | null = null
    let bestDistance = SNAP_PX[kind] * 0.8
    const consider = (pick: Pick, x: number, y: number, z: number) => {
      const p = this.screenOf(x, y, z)
      if (!p) return
      const d = Math.hypot(p.x - clientX, p.y - clientY)
      if (d < bestDistance) {
        best = pick
        bestDistance = d
      }
    }
    const hover = this.state.hover
    const curved = new Set(this.state.selection.streets)
    if (hover?.kind === 'street' || hover?.kind === 'streetCurve') curved.add(hover.id)
    for (const id of curved) {
      const street = snapshot.streets[id]
      const a = street && snapshot.streetNodes[street.a]
      const b = street && snapshot.streetNodes[street.b]
      if (!street || !a || !b) continue
      const middle = pointOnCurve({ a, b, control: street.control }, 0.5)
      consider({ kind: 'streetCurve', id }, middle.x, CURB_HEIGHT, -middle.y)
    }
    for (const node of this.streetNodesNear(snapshot, clientX, clientY)) {
      consider({ kind: 'streetNode', id: node.id }, node.x, CURB_HEIGHT, -node.y)
    }
    return best
  }

  /** Street points near a screen position, looked up in a spatial index. */
  private streetNodesNear(snapshot: Snapshot, clientX: number, clientY: number) {
    const ground = this.planPoint(clientX, clientY, CURB_HEIGHT)
    if (!ground) return []
    const radius = this.tolerance(clientX, clientY, CURB_HEIGHT, 'touch') * 2 + 1
    return streetNodesNear(snapshot, ground, radius).flatMap((id) => snapshot.streetNodes[id] ?? [])
  }

  /**
   * The street (or with `anything`, the building or street) under the
   * pointer. Buildings are found by their meshes, streets on the ground
   * through a spatial index; whichever is nearer along the ray wins.
   */
  private streetUnder(clientX: number, clientY: number, anything = false): Pick | null {
    this.setRay(clientX, clientY)
    const ground = this.raycaster.ray.intersectPlane(this.plane.set(new Vector3(0, 1, 0), 0), new Vector3())
    const groundDistance = ground ? ground.distanceTo(this.raycaster.ray.origin) : Infinity
    if (anything) {
      const hit = this.raycaster.intersectObjects([...this.deps.pickables.values()], false).find((h) => pickOfHit(h))
      if (hit && hit.distance < groundDistance + 0.5) return pickOfHit(hit)
    }
    if (!ground) return null
    const id = streetAt(this.deps.doc.getSnapshot(), { x: ground.x, y: -ground.z })
    return id ? { kind: 'street', id } : null
  }

  /** What can be dragged: in the building editor its parts; on the site, street handles in the Street tool. */
  private canDrag(pick: Pick): boolean {
    const { mode, tool } = this.state
    if (mode === 'building') return tool === 'select' && pick.kind !== 'room'
    if (tool === 'parcel') return pick.kind === 'parcelCorner'
    if (tool === 'terrain') return pick.kind === 'spotHeight'
    return tool === 'street' && (pick.kind === 'streetNode' || pick.kind === 'streetCurve')
  }

  /** The point (of any real floor) drawn nearest a screen position, within a few pixels. */
  private nodeOnScreen(clientX: number, clientY: number, kind: PointerKind, snapshot: Snapshot): Id | null {
    const rect = this.deps.canvas.getBoundingClientRect()
    const camera = this.deps.getCamera()
    let best: Id | null = null
    let bestDistance = SNAP_PX[kind] * 0.8
    const levels = this.state.buildingId ? sortedLevels(snapshot, this.state.buildingId) : []
    for (const node of levels.filter((l) => !l.masterId).flatMap((l) => nodesOnLevel(snapshot, l.id))) {
      const level = snapshot.levels[node.levelId]
      if (!level) continue
      this.local.set(node.x, level.elevation, -node.y).project(camera)
      if (this.local.z > 1) continue
      const x = rect.left + ((this.local.x + 1) / 2) * rect.width
      const y = rect.top + ((1 - this.local.y) / 2) * rect.height
      const d = Math.hypot(x - clientX, y - clientY)
      if (d < bestDistance) {
        best = node.id
        bestDistance = d
      }
    }
    return best
  }

  private wallAxis(snapshot: Snapshot, wallId: Id): WallAxis | null {
    const wall = snapshot.walls[wallId]
    const a = wall && snapshot.nodes[wall.a]
    const b = wall && snapshot.nodes[wall.b]
    const level = wall && snapshot.levels[wall.levelId]
    if (!wall || !a || !b || !level) return null
    const dir = normalize(sub(b, a))
    const footprint = analyzeSite(snapshot).byLevel.get(wall.levelId)?.footprints.get(wallId)
    const { heightStart, heightEnd } = resolveWall(wall, level, snapshot.meta)
    return {
      a,
      dir,
      normal: perpLeft(dir),
      elevation: level.elevation,
      clearStart: footprint?.clearStart ?? 0,
      clearEnd: footprint?.clearEnd ?? dist(a, b),
      top: Math.min(heightStart, heightEnd),
    }
  }

  /** Starts resizing the selected opening from one of its handles. */
  private startResize(e: PointerEvent, element: HTMLElement): void {
    const openingId = element.dataset.openingId
    const handle = element.dataset.handle as OpeningHandle | undefined
    const snapshot = this.deps.doc.getSnapshot()
    const opening = openingId ? snapshot.openings[openingId] : undefined
    const axis = opening && this.wallAxis(snapshot, opening.wallId)
    const start = axis && this.onWall(e.clientX, e.clientY, axis)
    if (!opening || !axis || !start || !handle) return
    e.preventDefault()
    const kind = pointerKind(e)
    this.activePointers.add(e.pointerId)
    this.press = {
      pointerId: e.pointerId,
      kind,
      button: e.button,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
      pick: { kind: 'opening', id: opening.id },
      shiftKey: false,
    }
    // Start from where the opening is drawn, which may be nudged to fit the wall.
    const s0 = Math.max(opening.offset - opening.width / 2, axis.clearStart)
    const s1 = Math.min(opening.offset + opening.width / 2, axis.clearEnd)
    const z0 = opening.sill
    const z1 = Math.min(opening.sill + opening.height, axis.top - MIN_LINTEL)
    this.drag = {
      kind: 'resize',
      openingId: opening.id,
      axis,
      handle,
      start,
      initial: { s0, s1, z0, z1 },
      isDoor: opening.kind === 'door',
      moved: false,
    }
    this.setControlsEnabled(false)
    this.deps.store.setState({ dragging: true, hover: null })
  }

  private startDrag(press: Press): void {
    const pick = press.pick
    if (!pick) return
    const snapshot = this.deps.doc.getSnapshot()
    if (!isSelected(this.state.selection, pick)) select(this.deps, pick, false)

    // In the whole-building view (or a shell edited on all floors), the same
    // point or wall on other floors moves along.
    const stacked = this.state.mode === 'building' && this.state.wholeBuilding
    const stacks = stacked ? findStacks(snapshot, this.state.buildingId ?? undefined) : null

    if (pick.kind === 'node') {
      const node = snapshot.nodes[pick.id]
      if (!node) return
      const stack = stacks?.nodes.get(node.id) ?? [node.id]
      const attachedTo = (id: Id) => Object.values(snapshot.walls).filter((w) => w.a === id || w.b === id)
      const own = attachedTo(node.id)
      const only = own.length === 1 ? own[0]! : null
      const farEnd = only ? snapshot.nodes[only.a === node.id ? only.b : only.a] : undefined
      this.drag = {
        kind: 'node',
        nodeId: node.id,
        levelId: node.levelId,
        stack,
        attachedWalls: new Set(stack.flatMap(attachedTo).map((w) => w.id)),
        anchor: farEnd ? { x: farEnd.x, y: farEnd.y } : null,
        moved: false,
      }
    } else if (pick.kind === 'building') {
      const start = this.planPoint(press.startX, press.startY, 0)
      if (!start) return
      this.drag = { kind: 'building', buildingId: pick.id, start, applied: { x: 0, y: 0 }, moved: false }
    } else if (pick.kind === 'spotHeight') {
      this.drag = { kind: 'spotHeight', spotId: pick.id, moved: false }
    } else if (pick.kind === 'parcelCorner') {
      const { parcelId, index } = parseParcelCorner(pick.id)
      this.drag = { kind: 'parcelCorner', parcelId, index, moved: false }
    } else if (pick.kind === 'streetNode') {
      this.drag = { kind: 'streetNode', nodeId: pick.id, moved: false }
    } else if (pick.kind === 'streetCurve') {
      this.drag = { kind: 'streetCurve', streetId: pick.id, moved: false }
    } else if (pick.kind === 'street') {
      const street = snapshot.streets[pick.id]
      const startPoint = this.planPoint(press.startX, press.startY, 0)
      if (!street || !startPoint) return
      const starts = new Map<Id, Vec2>()
      for (const id of [street.a, street.b]) {
        const n = snapshot.streetNodes[id]
        if (n) starts.set(id, { x: n.x, y: n.y })
      }
      this.drag = { kind: 'street', starts, startPoint, moved: false }
    } else if (pick.kind === 'wall') {
      const wall = snapshot.walls[pick.id]
      const a = wall && snapshot.nodes[wall.a]
      const b = wall && snapshot.nodes[wall.b]
      const level = wall && snapshot.levels[wall.levelId]
      if (!wall || !a || !b || !level) return
      const startPoint = this.planPoint(press.startX, press.startY, level.elevation)
      if (!startPoint) return
      const starts = new Map<Id, Vec2>()
      for (const id of stacks?.walls.get(wall.id) ?? [wall.id]) {
        const w = snapshot.walls[id]
        for (const nodeId of w ? [w.a, w.b] : []) {
          const n = snapshot.nodes[nodeId]
          if (n) starts.set(nodeId, { x: n.x, y: n.y })
        }
      }
      this.drag = {
        kind: 'wall',
        levelId: wall.levelId,
        starts,
        normal: perpLeft(normalize(sub(b, a))),
        startPoint,
        moved: false,
      }
    } else if (pick.kind === 'opening') {
      const opening = snapshot.openings[pick.id]
      const axis = opening && this.wallAxis(snapshot, opening.wallId)
      const start = axis && this.onWall(press.startX, press.startY, axis)
      if (!opening || !axis || !start) return
      this.drag = {
        kind: 'opening',
        openingId: opening.id,
        axis,
        grabAlong: opening.offset - start.along,
        grabHeight: opening.sill - start.height,
        // A row moves as one: all of it stays on the wall.
        reach: rowReach(opening),
        height: opening.height,
        isDoor: opening.kind === 'door',
        moved: false,
      }
    }
    this.deps.store.setState({ dragging: true, hover: null })
  }

  private updateDrag(e: PointerEvent): void {
    const drag = this.drag
    if (!drag) return
    const { doc, store } = this.deps
    const snapshot = doc.getSnapshot()
    const state = this.state
    const snapping = state.snap.enabled && !e.altKey && !state.snapSuspended

    const step = state.snap.lengthStep
    const round = (v: number) => (snapping ? Math.round(v / step) * step : v)
    const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), Math.max(min, max))

    if (drag.kind === 'opening') {
      // Along the wall, and up and down for windows (doors stay on the floor).
      const point = this.onWall(e.clientX, e.clientY, drag.axis)
      if (!point) return
      const { axis } = drag
      const offset = clamp(round(point.along + drag.grabAlong), axis.clearStart + drag.reach, axis.clearEnd - drag.reach)
      const sill = drag.isDoor ? 0 : clamp(round(point.height + drag.grabHeight), 0, axis.top - MIN_LINTEL - drag.height)
      doc.transact((tx) => updateOpening(tx, drag.openingId, { offset, sill }), { merge: drag.moved })
      drag.moved = true
      return
    }

    if (drag.kind === 'resize') {
      // Move the dragged edges; the opposite edges stay put.
      const point = this.onWall(e.clientX, e.clientY, drag.axis)
      if (!point) return
      const { axis, handle } = drag
      const ds = point.along - drag.start.along
      const dz = point.height - drag.start.height
      let { s0, s1, z0, z1 } = drag.initial
      if (handle.includes('l')) s0 = clamp(round(s0 + ds), axis.clearStart, s1 - MIN_OPENING_SIZE)
      if (handle.includes('r')) s1 = clamp(round(s1 + ds), s0 + MIN_OPENING_SIZE, axis.clearEnd)
      if (handle.includes('t')) z1 = clamp(round(z1 + dz), z0 + MIN_OPENING_SIZE, axis.top - MIN_LINTEL)
      if (handle.includes('b') && !drag.isDoor) z0 = clamp(round(z0 + dz), 0, z1 - MIN_OPENING_SIZE)
      doc.transact(
        (tx) => updateOpening(tx, drag.openingId, { offset: (s0 + s1) / 2, width: s1 - s0, sill: z0, height: z1 - z0 }),
        { merge: drag.moved },
      )
      drag.moved = true
      return
    }

    if (drag.kind === 'parcelCorner' || drag.kind === 'spotHeight') {
      const spot = drag.kind === 'spotHeight' ? snapshot.spotHeights[drag.spotId] : undefined
      // A spot height moves over the plane of its own height, so it stays under the pointer.
      const level = spot ? spot.z - (snapshot.meta.ground ?? 0) : 0
      const ground = this.planPoint(e.clientX, e.clientY, level)
      if (!ground) return
      const tolerance = this.tolerance(e.clientX, e.clientY, level, pointerKind(e))
      const result = snap(ground, this.siteSnapContext(snapshot, state, tolerance, e.altKey, ground, new Set(), new Set()))
      store.setState({ cursor: result })
      if (drag.kind === 'parcelCorner') {
        doc.transact((tx) => moveParcelCorner(tx, drag.parcelId, drag.index, result.point), { merge: drag.moved })
      } else {
        doc.transact((tx) => moveSpotHeight(tx, drag.spotId, result.point), { merge: drag.moved })
      }
      drag.moved = true
      return
    }

    if (drag.kind === 'building' || drag.kind === 'streetNode' || drag.kind === 'streetCurve' || drag.kind === 'street') {
      const ground = this.planPoint(e.clientX, e.clientY, 0)
      if (!ground) return
      if (drag.kind === 'building') {
        const total = { x: round(ground.x - drag.start.x), y: round(ground.y - drag.start.y) }
        const step = sub(total, drag.applied)
        if (step.x === 0 && step.y === 0) return
        doc.transact((tx) => moveBuilding(tx, drag.buildingId, step), { merge: drag.moved })
        drag.applied = total
      } else if (drag.kind === 'streetNode') {
        const attached = Object.values(snapshot.streets).filter((st) => st.a === drag.nodeId || st.b === drag.nodeId)
        const tolerance = this.tolerance(e.clientX, e.clientY, 0, pointerKind(e))
        const ctx = this.siteSnapContext(
          snapshot,
          state,
          tolerance,
          e.altKey,
          ground,
          new Set([drag.nodeId]),
          new Set(attached.map((st) => st.id)),
        )
        const result = snap(ground, ctx)
        store.setState({ cursor: result })
        doc.transact((tx) => moveStreetNodes(tx, new Map([[drag.nodeId, result.point]])), { merge: drag.moved })
      } else if (drag.kind === 'streetCurve') {
        const street = snapshot.streets[drag.streetId]
        const a = street && snapshot.streetNodes[street.a]
        const b = street && snapshot.streetNodes[street.b]
        if (!a || !b) return
        // Close to the straight line straightens it again.
        const straight = Math.abs(dot(sub(ground, midpoint(a, b)), perpLeft(normalize(sub(b, a))))) < 0.4
        doc.transact((tx) => setStreetCurve(tx, drag.streetId, straight ? null : controlThrough(a, b, ground)), {
          merge: drag.moved,
        })
      } else {
        const delta = { x: round(ground.x - drag.startPoint.x), y: round(ground.y - drag.startPoint.y) }
        doc.transact((tx) => moveStreetNodes(tx, new Map([...drag.starts].map(([id, p]) => [id, add(p, delta)]))), {
          merge: drag.moved,
        })
      }
      drag.moved = true
      return
    }

    const level = snapshot.levels[drag.levelId]
    if (!level) return
    const raw = this.planPoint(e.clientX, e.clientY, level.elevation)
    if (!raw) return

    if (drag.kind === 'node') {
      const tolerance = this.tolerance(e.clientX, e.clientY, level.elevation, pointerKind(e))
      const ctx = this.snapContext(
        snapshot,
        state,
        drag.levelId,
        tolerance,
        e.altKey,
        new Set(drag.stack),
        drag.attachedWalls,
      )
      ctx.anchor = drag.anchor
      const result = snap(raw, ctx)
      store.setState({ cursor: result })
      doc.transact((tx) => moveNodes(tx, new Map(drag.stack.map((id) => [id, result.point]))), {
        merge: drag.moved,
      })
    } else {
      let offset = dot(sub(raw, drag.startPoint), drag.normal)
      if (snapping && state.snap.grid) offset = Math.round(offset / state.snap.lengthStep) * state.snap.lengthStep
      const delta = scale(drag.normal, offset)
      doc.transact(
        (tx) => moveNodes(tx, new Map([...drag.starts].map(([id, start]) => [id, add(start, delta)]))),
        { merge: drag.moved },
      )
    }
    drag.moved = true
  }

  private endDrag(): void {
    const drag = this.drag
    this.drag = null
    if (drag?.moved && (drag.kind === 'node' || drag.kind === 'wall')) {
      const nodeIds = drag.kind === 'node' ? drag.stack : [...drag.starts.keys()]
      this.deps.doc.transact((tx) => finishNodeMove(tx, nodeIds), { merge: true })
    }
    // Street points join whatever they were dropped on.
    if (drag?.moved && (drag.kind === 'streetNode' || drag.kind === 'street')) {
      const nodeIds = drag.kind === 'streetNode' ? [drag.nodeId] : [...drag.starts.keys()]
      this.deps.doc.transact((tx) => finishStreetMove(tx, nodeIds), { merge: true })
    }
    this.deps.store.setState({ dragging: false, cursor: null })
    dropMissingSelection(this.deps)
  }
}

function pointerKind(e: PointerEvent): PointerKind {
  return e.pointerType === 'touch' || e.pointerType === 'pen' ? e.pointerType : 'mouse'
}

/**
 * Whether a wheel event comes from a trackpad scroll rather than a mouse
 * wheel. Browsers don't say, so this reads the signs: scrolling by lines,
 * or the legacy wheelDelta in whole 120-unit notches, means a mouse wheel;
 * sideways movement, the legacy delta at exactly −3 × the pixel delta (as
 * macOS browsers report trackpads), or small or fractional pixel steps mean
 * a trackpad.
 */
function isTrackpadScroll(e: WheelEvent): boolean {
  if (e.deltaMode !== WheelEvent.DOM_DELTA_PIXEL) return false
  if (e.deltaX !== 0) return true
  const legacy = (e as WheelEvent & { wheelDeltaY?: number }).wheelDeltaY
  if (legacy && legacy % 120 === 0) return false
  if (legacy && legacy === -3 * e.deltaY) return true
  return Math.abs(e.deltaY) < 50 || !Number.isInteger(e.deltaY)
}

/** What a raycast hit picks: an object's own pick, or for a merged mesh the part the triangle belongs to. */
function pickOfHit(hit: Intersection): Pick | null {
  const data = hit.object.userData as { pick?: Pick; pickFace?: (face: number) => Pick | null }
  if (data.pick) return data.pick
  return data.pickFace && hit.faceIndex !== undefined && hit.faceIndex !== null ? data.pickFace(hit.faceIndex) : null
}
