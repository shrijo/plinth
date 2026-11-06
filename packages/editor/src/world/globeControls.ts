import { Matrix4, PerspectiveCamera, Quaternion, Raycaster, Vector2, Vector3 } from 'three'
import { distanceBetween, ecefFromLonLat, enuFrame, fromFrame, lonLatFromEcef, type Vec3 } from '@plinth/world'
import type { WorldTiles } from './WorldTiles.ts'

/**
 * Moving over the globe. The view looks at a point on the ground (its
 * target) from a distance, turned by a heading (clockwise from north) and
 * tilted by a pitch (0 looks straight down). Dragging pulls the ground
 * along under the pointer, the wheel or a pinch moves closer to what's
 * under the pointer, and a right-drag (or two fingers twisting and
 * sliding) turns and tilts round the target. From far out the view looks
 * straight down; tilting opens up as it nears the ground.
 */

export interface GlobeView {
  lon: number
  lat: number
  /** Height of the target (the ground there), metres above sea level. */
  height: number
  /** From the camera to the target, in metres. */
  range: number
  heading: number
  pitch: number
}

/** Where the world opens: Europe, from far out. */
export const DEFAULT_VIEW: GlobeView = { lon: 8.5, lat: 47, height: 0, range: 1.6e7, heading: 0, pitch: 0 }

export const MIN_RANGE = 25
export const MAX_RANGE = 2.4e7
const STEEPEST = (80 * Math.PI) / 180
/** The camera keeps at least this far above the ground (metres). */
const CLEARANCE = 4

/** How far the view may tilt at a distance: fully near the ground, not at all from space. */
export function maxPitch(range: number): number {
  const near = 40e3
  const far = 4e6
  if (range <= near) return STEEPEST
  if (range >= far) return 0
  return STEEPEST * (1 - Math.log(range / near) / Math.log(far / near))
}

export interface Pose {
  position: Vec3
  right: Vec3
  up: Vec3
  back: Vec3
}

/** Where the camera is (ECEF) and which way its axes point, for a view. */
export function poseOf(view: GlobeView): Pose {
  const frame = enuFrame(view.lon, view.lat, view.height)
  const sp = Math.sin(view.pitch)
  const cp = Math.cos(view.pitch)
  const sh = Math.sin(view.heading)
  const ch = Math.cos(view.heading)
  const local = (e: number, n: number, u: number): Vec3 => [
    frame.east[0] * e + frame.north[0] * n + frame.up[0] * u,
    frame.east[1] * e + frame.north[1] * n + frame.up[1] * u,
    frame.east[2] * e + frame.north[2] * n + frame.up[2] * u,
  ]
  return {
    position: fromFrame(frame, [-view.range * sp * sh, -view.range * sp * ch, view.range * cp]),
    right: local(ch, -sh, 0),
    up: local(cp * sh, cp * ch, sp),
    back: local(-sp * sh, -sp * ch, cp),
  }
}

// Vector helpers on ECEF tuples.
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const length = (a: Vec3) => Math.hypot(a[0], a[1], a[2])
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s]
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]

/** Turns `p` about `axis` (a unit vector through the Earth's middle) by `angle`. */
function rotate(p: Vec3, axis: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  const k = cross(axis, p)
  const d = dot(axis, p) * (1 - c)
  return [p[0] * c + k[0] * s + axis[0] * d, p[1] * c + k[1] * s + axis[1] * d, p[2] * c + k[2] * s + axis[2] * d]
}

/** The turn about the Earth's middle that takes direction `from` to `to`: axis and angle. */
function turnBetween(from: Vec3, to: Vec3): { axis: Vec3; angle: number } | null {
  const axis = cross(from, to)
  const s = length(axis)
  if (s < 1e-15) return null
  // |a × b| and a · b are both scaled by |a||b|, so their angle comes out right.
  return { axis: scale(axis, 1 / s), angle: Math.atan2(s, dot(from, to)) }
}

interface Flight {
  from: GlobeView
  to: GlobeView
  start: number
  duration: number
  /** Extra height at the middle of the flight, as a factor of the range (log). */
  lift: number
}

interface Touch {
  x: number
  y: number
}

const raycaster = new Raycaster()
const pointer = new Vector2()
const basis = new Matrix4()
const position = new Vector3()
const quaternion = new Quaternion()
const axisX = new Vector3()
const axisY = new Vector3()
const axisZ = new Vector3()

export class GlobeControls {
  view: GlobeView
  /** Called when the view changes, for drawing on demand and keeping the address. */
  onChange: (() => void) | null = null
  /** When false, input is ignored (the view can still fly). */
  enabled = true
  private flight: Flight | null = null
  private readonly element: HTMLElement
  private readonly world: WorldTiles
  private readonly getCamera: () => PerspectiveCamera
  private readonly touches = new Map<number, Touch>()
  private mode: 'pan' | 'orbit' | null = null
  /** The point on the globe (ECEF) being dragged, and the radius of the sphere it's dragged on. */
  private grab: Vec3 | null = null
  private last: Touch | null = null
  private gestureScale: number | null = null
  private pinch: { distance: number; angle: number; mid: Touch } | null = null

  constructor(element: HTMLElement, world: WorldTiles, getCamera: () => PerspectiveCamera, view: GlobeView) {
    this.element = element
    this.world = world
    this.getCamera = getCamera
    this.view = { ...view }
  }

  attach(): () => void {
    const el = this.element
    el.addEventListener('pointerdown', this.onDown)
    el.addEventListener('pointermove', this.onMove)
    el.addEventListener('pointerup', this.onUp)
    el.addEventListener('pointercancel', this.onUp)
    el.addEventListener('wheel', this.onWheel, { passive: false })
    el.addEventListener('contextmenu', this.onContextMenu)
    el.addEventListener('gesturestart', this.onGestureStart as EventListener)
    el.addEventListener('gesturechange', this.onGestureChange as EventListener)
    el.addEventListener('gestureend', this.onGestureEnd as EventListener)
    return () => {
      el.removeEventListener('pointerdown', this.onDown)
      el.removeEventListener('pointermove', this.onMove)
      el.removeEventListener('pointerup', this.onUp)
      el.removeEventListener('pointercancel', this.onUp)
      el.removeEventListener('wheel', this.onWheel)
      el.removeEventListener('contextmenu', this.onContextMenu)
      el.removeEventListener('gesturestart', this.onGestureStart as EventListener)
      el.removeEventListener('gesturechange', this.onGestureChange as EventListener)
      el.removeEventListener('gestureend', this.onGestureEnd as EventListener)
    }
  }

  // The camera

  /**
   * Places the camera for the view (after any flight), keeps it above the
   * ground and the world's anchor near it. Call every frame.
   */
  update(now: number): void {
    if (this.flight) this.fly(now)
    const view = this.view
    // The target sits on the ground, as far as it's known.
    const ground = this.world.groundHeight(view.lon, view.lat)
    if (ground !== null && !this.flight) view.height += (ground - view.height) * 0.25
    else if (ground !== null && this.flight) view.height = ground
    view.range = Math.min(Math.max(view.range, MIN_RANGE), MAX_RANGE)
    view.pitch = Math.min(Math.max(view.pitch, 0), maxPitch(view.range))

    // Never below the ground: tilt up until the camera is clear of it.
    for (let i = 0; i < 12; i++) {
      const camera = lonLatFromEcef(poseOf(view).position)
      const below = this.world.groundHeight(camera.lon, camera.lat)
      if (below === null || camera.height > below + CLEARANCE || view.pitch <= 0) break
      view.pitch = Math.max(0, view.pitch - 0.05)
    }

    // Keep the scene's anchor close, so what's near the camera is precise.
    const anchor = this.world.getAnchor()
    const away = distanceBetween(anchor.lon, anchor.lat, view.lon, view.lat)
    if (away > Math.max(800, view.range * 0.5) || Math.abs(anchor.height - view.height) > Math.max(200, view.range * 0.5)) {
      this.world.setAnchor({ lon: view.lon, lat: view.lat, height: Math.round(view.height) })
    }
    this.apply()
  }

  private apply(): void {
    const camera = this.getCamera()
    const pose = poseOf(this.view)
    this.world.toScene(pose.position, position)
    this.world.directionToScene(pose.right, axisX).normalize()
    this.world.directionToScene(pose.up, axisY).normalize()
    this.world.directionToScene(pose.back, axisZ).normalize()
    basis.makeBasis(axisX, axisY, axisZ)
    quaternion.setFromRotationMatrix(basis)
    camera.position.copy(position)
    camera.quaternion.copy(quaternion)
    camera.updateMatrixWorld()
  }

  /** The distance at which, looking straight down, `size` metres take up `share` of the view's narrower side. */
  rangeToFit(size: number, share = 0.6): number {
    const camera = this.getCamera()
    const tall = 2 * Math.tan((camera.fov * Math.PI) / 360)
    return size / (share * tall * Math.min(camera.aspect, 1))
  }

  /** The camera's height above the ground under it, in metres. */
  altitude(): number {
    const camera = lonLatFromEcef(poseOf(this.view).position)
    const ground = this.world.groundHeight(camera.lon, camera.lat) ?? this.view.height
    return Math.max(1, camera.height - ground)
  }

  // Flying

  /** Flies to a view, rising on the way if it's far. */
  flyTo(to: Partial<GlobeView>, duration?: number): void {
    const from = { ...this.view }
    const target: GlobeView = { ...from, ...to }
    target.pitch = Math.min(target.pitch, maxPitch(target.range))
    const distance = distanceBetween(from.lon, from.lat, target.lon, target.lat)
    // Up high enough to see both ends at the middle, if that's higher than either end.
    const peak = Math.min(distance * 1.4, MAX_RANGE)
    const lift = Math.max(0, Math.log(peak) - Math.max(Math.log(from.range), Math.log(target.range)))
    const seconds = duration ?? Math.min(4, Math.max(1.2, 1 + 0.5 * Math.log10(Math.max(distance, 10) / 100)))
    this.flight = { from, to: target, start: performance.now(), duration: seconds * 1000, lift }
    this.onChange?.()
  }

  get flying(): boolean {
    return this.flight !== null
  }

  stop(): void {
    this.flight = null
  }

  private fly(now: number): void {
    const flight = this.flight!
    const t = Math.min(1, (now - flight.start) / flight.duration)
    const s = t * t * (3 - 2 * t)
    const { from, to } = flight
    // Along the great circle.
    const a = ecefFromLonLat(from.lon, from.lat, 0)
    const b = ecefFromLonLat(to.lon, to.lat, 0)
    const turn = turnBetween(a, b)
    const p = turn ? rotate(a, turn.axis, turn.angle * s) : a
    const place = lonLatFromEcef(p)
    const logRange = Math.log(from.range) + (Math.log(to.range) - Math.log(from.range)) * s + flight.lift * 4 * t * (1 - t)
    let dh = to.heading - from.heading
    dh = Math.atan2(Math.sin(dh), Math.cos(dh))
    const range = Math.exp(logRange)
    this.view = {
      lon: place.lon,
      lat: place.lat,
      height: from.height + (to.height - from.height) * s,
      range,
      heading: from.heading + dh * s,
      pitch: Math.min(from.pitch + (to.pitch - from.pitch) * s, maxPitch(range)),
    }
    if (t >= 1) this.flight = null
    this.onChange?.()
  }

  // Picking

  private ray(x: number, y: number): { origin: Vec3; direction: Vec3 } {
    const rect = this.element.getBoundingClientRect()
    pointer.set(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1)
    raycaster.setFromCamera(pointer, this.getCamera())
    return {
      origin: this.world.toEcef(raycaster.ray.origin),
      direction: this.world.directionToEcef(raycaster.ray.direction),
    }
  }

  /** What's under a screen point: the ground or a building shown there, or else the globe. */
  surfaceAt(x: number, y: number): Vec3 | null {
    const rect = this.element.getBoundingClientRect()
    pointer.set(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1)
    raycaster.setFromCamera(pointer, this.getCamera())
    const hit = this.world.raycast(raycaster)
    if (hit) return this.world.toEcef(hit.point)
    return this.sphereAt(x, y, length(ecefFromLonLat(this.view.lon, this.view.lat, this.view.height)))
  }

  /** Where a screen point's ray meets a sphere round the Earth's middle. */
  private sphereAt(x: number, y: number, radius: number): Vec3 | null {
    const { origin, direction } = this.ray(x, y)
    const b = dot(origin, direction)
    const c = dot(origin, origin) - radius * radius
    const disc = b * b - c
    if (disc < 0) return null
    const t = -b - Math.sqrt(disc)
    if (t < 0) return null
    return [origin[0] + direction[0] * t, origin[1] + direction[1] * t, origin[2] + direction[2] * t]
  }

  /** The view's target as a point on the globe. */
  private targetEcef(): Vec3 {
    return ecefFromLonLat(this.view.lon, this.view.lat, this.view.height)
  }

  private setTarget(p: Vec3): void {
    const place = lonLatFromEcef(p)
    this.view.lon = place.lon
    this.view.lat = place.lat
  }

  // Moving

  /** Turns the globe so the grabbed point comes under a screen point. */
  private dragTo(x: number, y: number): void {
    if (!this.grab) return
    const under = this.sphereAt(x, y, length(this.grab))
    if (!under) return
    const turn = turnBetween(under, this.grab)
    if (!turn) return
    // Near the horizon a pixel is a long way: never more than a few views' worth at once.
    const most = Math.max((this.view.range * 3) / 6.371e6, 1e-7)
    this.setTarget(rotate(this.targetEcef(), turn.axis, Math.min(turn.angle, most)))
    this.onChange?.()
  }

  /** Moves closer (factor below 1) or further, towards or away from what's under a screen point. */
  zoomAt(factor: number, x: number, y: number): void {
    this.flight = null
    const range = Math.min(Math.max(this.view.range * factor, MIN_RANGE), MAX_RANGE)
    const share = 1 - range / this.view.range
    const hit = this.surfaceAt(x, y)
    if (hit && share !== 0) {
      const target = this.targetEcef()
      const turn = turnBetween(target, hit)
      if (turn) this.setTarget(rotate(target, turn.axis, turn.angle * Math.max(share, -1)))
    }
    this.view.range = range
    this.view.pitch = Math.min(this.view.pitch, maxPitch(range))
    this.onChange?.()
  }

  orbit(dx: number, dy: number): void {
    this.flight = null
    this.view.heading -= dx * 0.005
    this.view.pitch = Math.min(Math.max(this.view.pitch - dy * 0.005, 0), maxPitch(this.view.range))
    this.onChange?.()
  }

  // Input

  private onContextMenu = (e: Event) => e.preventDefault()

  private onDown = (e: PointerEvent) => {
    if (!this.enabled) return
    this.flight = null
    this.element.setPointerCapture(e.pointerId)
    this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (this.touches.size === 1) {
      this.mode = e.button === 2 || e.button === 1 || e.ctrlKey || e.metaKey || e.shiftKey ? 'orbit' : 'pan'
      this.grab = this.mode === 'pan' ? this.surfaceAt(e.clientX, e.clientY) : null
      this.last = { x: e.clientX, y: e.clientY }
    } else if (this.touches.size === 2) {
      this.mode = null
      this.pinch = this.pinchState()
      this.grab = this.surfaceAt(this.pinch.mid.x, this.pinch.mid.y)
    }
  }

  private pinchState(): { distance: number; angle: number; mid: Touch } {
    const [a, b] = [...this.touches.values()] as [Touch, Touch]
    return {
      distance: Math.hypot(b.x - a.x, b.y - a.y),
      angle: Math.atan2(b.y - a.y, b.x - a.x),
      mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    }
  }

  private onMove = (e: PointerEvent) => {
    const touch = this.touches.get(e.pointerId)
    if (!touch || !this.enabled) return
    touch.x = e.clientX
    touch.y = e.clientY
    if (this.touches.size === 1 && this.last) {
      if (this.mode === 'pan') this.dragTo(e.clientX, e.clientY)
      else if (this.mode === 'orbit') this.orbit(e.clientX - this.last.x, e.clientY - this.last.y)
      this.last = { x: e.clientX, y: e.clientY }
    } else if (this.touches.size === 2 && this.pinch) {
      const now = this.pinchState()
      const before = this.pinch
      const spread = now.distance / Math.max(before.distance, 1)
      const dy = now.mid.y - before.mid.y
      // Both fingers sliding up or down together, without spreading: tilt.
      if (Math.abs(spread - 1) < 0.01 && Math.abs(dy) > Math.abs(now.mid.x - before.mid.x) * 1.5 && Math.abs(dy) > 1) {
        this.orbit(0, dy)
      } else {
        if (Math.abs(spread - 1) > 1e-4) this.zoomAt(1 / spread, now.mid.x, now.mid.y)
        let turn = now.angle - before.angle
        turn = Math.atan2(Math.sin(turn), Math.cos(turn))
        this.view.heading -= turn
        this.dragTo(now.mid.x, now.mid.y)
      }
      this.pinch = now
    }
  }

  private onUp = (e: PointerEvent) => {
    this.touches.delete(e.pointerId)
    if (this.element.hasPointerCapture(e.pointerId)) this.element.releasePointerCapture(e.pointerId)
    if (this.touches.size === 1) {
      // From two fingers back to one: carry on dragging from where it is.
      const [rest] = [...this.touches.values()] as [Touch]
      this.mode = 'pan'
      this.grab = this.surfaceAt(rest.x, rest.y)
      this.last = { ...rest }
    } else if (this.touches.size === 0) {
      this.mode = null
      this.grab = null
      this.last = null
    }
    this.pinch = null
  }

  private onWheel = (e: WheelEvent) => {
    if (!this.enabled) return
    e.preventDefault()
    if (e.ctrlKey) {
      if (this.gestureScale !== null) return
      const delta = Math.max(-50, Math.min(50, e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY))
      this.zoomAt(Math.exp(delta * 0.012), e.clientX, e.clientY)
      return
    }
    if (!isTrackpadScroll(e)) {
      const delta = Math.max(-150, Math.min(150, e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY))
      this.zoomAt(Math.exp(delta * 0.002), e.clientX, e.clientY)
      return
    }
    // Two fingers on a trackpad: the ground follows them.
    this.flight = null
    const x = e.clientX
    const y = e.clientY
    this.grab = this.surfaceAt(x, y)
    this.dragTo(x - e.deltaX, y - e.deltaY)
    this.grab = null
  }

  private onGestureStart = (e: Event & { scale?: number }) => {
    e.preventDefault()
    this.gestureScale = e.scale ?? 1
  }

  private onGestureChange = (e: Event & { scale?: number; clientX?: number; clientY?: number }) => {
    e.preventDefault()
    if (this.gestureScale === null) return
    const scale = e.scale ?? 1
    const rect = this.element.getBoundingClientRect()
    this.zoomAt(this.gestureScale / scale, e.clientX ?? rect.left + rect.width / 2, e.clientY ?? rect.top + rect.height / 2)
    this.gestureScale = scale
  }

  private onGestureEnd = (e: Event) => {
    e.preventDefault()
    this.gestureScale = null
  }
}

/** As the editor reads it: a trackpad scroll (pan) rather than a mouse wheel (zoom). */
function isTrackpadScroll(e: WheelEvent): boolean {
  if (e.deltaMode !== WheelEvent.DOM_DELTA_PIXEL) return false
  if (e.deltaX !== 0) return true
  const legacy = (e as WheelEvent & { wheelDeltaY?: number }).wheelDeltaY
  if (legacy && legacy % 120 === 0) return false
  if (legacy && legacy === -3 * e.deltaY) return true
  return Math.abs(e.deltaY) < 50 || !Number.isInteger(e.deltaY)
}
