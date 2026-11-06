import { PerspectiveCamera, Raycaster, Vector2, Vector3 } from 'three'
import { distanceBetween, ecefFromLonLat, enuFrame, fromFrame, lonLatFromEcef, type Vec3 } from '@plinth/world'
import type { WorldTiles } from './WorldTiles.ts'

/**
 * Moving over the globe. The view looks at a point on the ground (its
 * target) from a distance, turned by a heading (clockwise from north) and
 * tilted by a pitch (0 looks straight down).
 *
 * - Drag: the ground follows the pointer (from space, the globe turns), and
 *   carries on a little when let go.
 * - Wheel, pinch, double-click: closer to (or away from) what's under the
 *   pointer, which stays under it. The wheel glides; a pinch follows the
 *   fingers.
 * - Right-drag (or Ctrl, Shift or Cmd and drag; two fingers twisting, or
 *   sliding up and down together): turns round and tilts about the middle
 *   of the view.
 * - Keys: arrows move, Shift and arrows turn and tilt, + and - zoom.
 *
 * The camera follows every input at once (not a frame later), picks the
 * ground by marching along the pointer's ray over the ground's heights (no
 * meshes, so it's cheap enough for every event), and is lifted over hills
 * rather than having its tilt taken away.
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

export const MIN_RANGE = 20
export const MAX_RANGE = 2.4e7
const STEEPEST = (82 * Math.PI) / 180
/** The camera keeps at least this far above the ground (metres). */
const CLEARANCE = 3
/** How quickly a let-go drag slows down, and a let-go turn (time constants, ms). */
const COAST = 220
const COAST_TURN = 140
/** The fastest a throw carries on (pixels per ms). */
const FASTEST_THROW = 2.5
/** How quickly the wheel's zoom glides to where it's going (time constant, ms). */
const GLIDE = 75
/** How quickly the target settles onto the ground under it (time constant, ms). */
const SETTLE = 120

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
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
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
  if (s < 1e-9) return null
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

interface Point {
  x: number
  y: number
}

/** Where the pointer was and when, kept for a moment to carry on with when let go. */
interface Trace {
  x: number
  y: number
  t: number
}

const raycaster = new Raycaster()
const pointer = new Vector2()
const position = new Vector3()
const lookAt = new Vector3()
const upHint = new Vector3()

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
  private last = performance.now()

  // Input in progress.
  private readonly touches = new Map<number, Point>()
  private mode: 'pan' | 'orbit' | null = null
  /** The point on the globe (ECEF) being dragged; it stays under the pointer. */
  private grab: Vec3 | null = null
  private previous: Point | null = null
  private trail: Trace[] = []
  private gestureScale: number | null = null
  private pinch: { distance: number; angle: number; mid: Point } | null = null
  /** What a two-finger gesture turned out to be, once it has moved far enough to tell. */
  private gesture: { kind: 'tilt' | 'pinch' | null; start: Point[] } | null = null

  // Carrying on after input: a pointer that keeps going (pixels per ms), the ground following it, or the turn.
  private spin: { grab: Vec3; x: number; y: number; vx: number; vy: number } | null = null
  private turn: { vx: number; vy: number } | null = null
  private zoom: { remaining: number; anchor: Vec3 | null; at: Point } | null = null

  constructor(element: HTMLElement, world: WorldTiles, getCamera: () => PerspectiveCamera, view: GlobeView) {
    this.element = element
    this.world = world
    this.getCamera = getCamera
    this.view = { ...view }
  }

  attach(): () => void {
    const el = this.element
    const on = <K extends keyof HTMLElementEventMap>(type: K, fn: (e: HTMLElementEventMap[K]) => void, options?: AddEventListenerOptions) =>
      el.addEventListener(type, fn as EventListener, options)
    on('pointerdown', this.onDown)
    on('pointermove', this.onMove)
    on('pointerup', this.onUp)
    on('pointercancel', this.onUp)
    on('wheel', this.onWheel, { passive: false })
    on('dblclick', this.onDoubleClick)
    on('contextmenu', this.onContextMenu)
    el.addEventListener('gesturestart', this.onGestureStart as EventListener)
    el.addEventListener('gesturechange', this.onGestureChange as EventListener)
    el.addEventListener('gestureend', this.onGestureEnd as EventListener)
    window.addEventListener('keydown', this.onKey)
    return () => {
      el.removeEventListener('pointerdown', this.onDown)
      el.removeEventListener('pointermove', this.onMove)
      el.removeEventListener('pointerup', this.onUp)
      el.removeEventListener('pointercancel', this.onUp)
      el.removeEventListener('wheel', this.onWheel)
      el.removeEventListener('dblclick', this.onDoubleClick)
      el.removeEventListener('contextmenu', this.onContextMenu)
      el.removeEventListener('gesturestart', this.onGestureStart as EventListener)
      el.removeEventListener('gesturechange', this.onGestureChange as EventListener)
      el.removeEventListener('gestureend', this.onGestureEnd as EventListener)
      window.removeEventListener('keydown', this.onKey)
    }
  }

  // Each frame

  /**
   * Moves the view on (a flight, a glide, a let-go drag), keeps the target on
   * the ground and the world's anchor near, and places the camera. Call
   * every frame.
   */
  update(now: number): void {
    const dt = Math.min(Math.max(now - this.last, 0), 100)
    this.last = now
    if (this.flight) this.fly(now)
    else {
      this.coast(dt)
      this.glide(dt)
    }
    const view = this.view
    const ground = this.world.groundHeight(view.lon, view.lat)
    if (ground !== null) view.height += (ground - view.height) * (this.flight ? 1 : 1 - Math.exp(-dt / SETTLE))
    this.clamp()

    // Keep the scene's anchor close, so what's near the camera is precise.
    const anchor = this.world.getAnchor()
    const away = distanceBetween(anchor.lon, anchor.lat, view.lon, view.lat)
    if (away > Math.max(800, view.range * 0.5) || Math.abs(anchor.height - view.height) > Math.max(200, view.range * 0.5)) {
      this.world.setAnchor({ lon: view.lon, lat: view.lat, height: Math.round(view.height) })
    }
    this.apply()
  }

  private clamp(): void {
    const view = this.view
    view.range = Math.min(Math.max(view.range, MIN_RANGE), MAX_RANGE)
    view.pitch = Math.min(Math.max(view.pitch, 0), maxPitch(view.range))
    view.heading = Math.atan2(Math.sin(view.heading), Math.cos(view.heading))
  }

  /** Puts the camera where the view says, lifted clear of the ground if it would be in it. */
  private apply(): void {
    const camera = this.getCamera()
    const pose = poseOf(this.view)
    let at = pose.position
    const place = lonLatFromEcef(at)
    const below = this.world.groundHeight(place.lon, place.lat, 10)
    if (below !== null && place.height < below + CLEARANCE) {
      // Straight up over the hill, still looking at the target.
      const up = enuFrame(place.lon, place.lat, 0).up
      at = add(at, scale(up, below + CLEARANCE - place.height))
    }
    this.world.toScene(at, position)
    this.world.toScene(ecefFromLonLat(this.view.lon, this.view.lat, this.view.height), lookAt)
    this.world.directionToScene(pose.up, upHint).normalize()
    camera.position.copy(position)
    camera.up.copy(upHint)
    camera.lookAt(lookAt)
    camera.updateMatrixWorld()
  }

  /** The camera's height above the ground under it, in metres. */
  altitude(): number {
    const camera = lonLatFromEcef(poseOf(this.view).position)
    const ground = this.world.groundHeight(camera.lon, camera.lat) ?? this.view.height
    return Math.max(1, camera.height - ground)
  }

  /** The distance at which, looking straight down, `size` metres take up `share` of the view's narrower side. */
  rangeToFit(size: number, share = 0.6): number {
    const camera = this.getCamera()
    const tall = 2 * Math.tan((camera.fov * Math.PI) / 360)
    return size / (share * tall * Math.min(camera.aspect, 1))
  }

  // Flying

  /** Flies to a view, rising on the way if it's far. */
  flyTo(to: Partial<GlobeView>, duration?: number): void {
    this.stopCoasting()
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
    this.stopCoasting()
  }

  private stopCoasting(): void {
    this.spin = null
    this.turn = null
    this.zoom = null
  }

  private fly(now: number): void {
    const flight = this.flight!
    const t = Math.min(1, (now - flight.start) / flight.duration)
    const s = t * t * (3 - 2 * t)
    const { from, to } = flight
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

  /** A let-go drag or turn carrying on, slowing down: as if the pointer kept going. */
  private coast(dt: number): void {
    const fade = Math.exp(-dt / COAST)
    const spin = this.spin
    if (spin) {
      spin.x += spin.vx * dt
      spin.y += spin.vy * dt
      spin.vx *= fade
      spin.vy *= fade
      const grab = this.grab
      this.grab = spin.grab
      this.dragTo(spin.x, spin.y)
      this.grab = grab
      if (Math.hypot(spin.vx, spin.vy) < 0.01) this.spin = null
    }
    const turn = this.turn
    if (turn) {
      // Turning round carries on; tilting stops where it's let go.
      this.orbit(turn.vx * dt, 0)
      turn.vx *= Math.exp(-dt / COAST_TURN)
      if (Math.abs(turn.vx) < 0.005) this.turn = null
    }
  }

  /** The wheel's zoom, gliding to where it's going. */
  private glide(dt: number): void {
    const zoom = this.zoom
    if (!zoom) return
    const step = zoom.remaining * (1 - Math.exp(-dt / GLIDE))
    this.scaleAbout(zoom.anchor, Math.exp(step))
    zoom.remaining -= step
    if (Math.abs(zoom.remaining) < 1e-3) this.zoom = null
  }

  // Picking

  private rect(): DOMRect {
    return this.element.getBoundingClientRect()
  }

  private ray(x: number, y: number): { origin: Vec3; direction: Vec3 } {
    const rect = this.rect()
    pointer.set(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1)
    raycaster.setFromCamera(pointer, this.getCamera())
    const direction = this.world.directionToEcef(raycaster.ray.direction)
    const l = length(direction)
    return { origin: this.world.toEcef(raycaster.ray.origin), direction: scale(direction, 1 / l) }
  }

  /**
   * The ground under a screen point: found by stepping along the pointer's
   * ray over the ground's heights (sea level where none are loaded) and
   * narrowing in where it goes under. Null for a point in the sky.
   */
  surfaceAt(x: number, y: number): Vec3 | null {
    const { origin, direction } = this.ray(x, y)
    const start = lonLatFromEcef(origin)
    const r = length(origin)
    // Nothing is closer than the camera's height above the highest ground, and nothing seen beyond the horizon (and a mountain behind it).
    let t = Math.max(0.5, start.height - 9000)
    const horizon = Math.sqrt(Math.max(r * r - 6.35e6 * 6.35e6, 0)) + 4e5
    const under = (d: number): boolean => {
      const p = add(origin, scale(direction, d))
      const place = lonLatFromEcef(p)
      return place.height <= (this.world.groundHeight(place.lon, place.lat) ?? 0)
    }
    if (under(t)) return null
    let before = t
    for (let k = 0; k < 700 && t < horizon; k++) {
      t += Math.max(0.5, t * 0.015)
      if (!under(t)) {
        before = t
        continue
      }
      let low = before
      let high = t
      for (let i = 0; i < 24; i++) {
        const mid = (low + high) / 2
        if (under(mid)) high = mid
        else low = mid
      }
      return add(origin, scale(direction, high))
    }
    return null
  }

  /** Where a screen point's ray meets a sphere round the Earth's middle (the near side). */
  private sphereAt(x: number, y: number, radius: number): Vec3 | null {
    const { origin, direction } = this.ray(x, y)
    const b = dot(origin, direction)
    const c = dot(origin, origin) - radius * radius
    const disc = b * b - c
    if (disc < 0) return null
    const t = -b - Math.sqrt(disc)
    if (t < 0) return null
    return add(origin, scale(direction, t))
  }

  /**
   * What to hold on to under a screen point: the ground there, but never
   * further than a few times the camera's height (near the horizon a pixel is
   * kilometres; holding a point in the air above the far ground keeps a drag
   * from racing away), or, pointing at the sky, the same.
   */
  private holdAt(x: number, y: number): Vec3 {
    const { origin, direction } = this.ray(x, y)
    const camera = poseOf(this.view).position
    const most = Math.max(this.altitude() * 12, this.view.range * 1.5)
    const ground = this.surfaceAt(x, y)
    if (ground && length(sub(ground, camera)) <= most) return ground
    return add(origin, scale(direction, ground ? Math.min(most, length(sub(ground, origin))) : most))
  }

  /** The view's target as a point on the globe. */
  private targetEcef(): Vec3 {
    return ecefFromLonLat(this.view.lon, this.view.lat, this.view.height)
  }

  // Moving

  private moveTarget(axis: Vec3, angle: number): void {
    const place = lonLatFromEcef(rotate(this.targetEcef(), axis, angle))
    this.view.lon = place.lon
    this.view.lat = place.lat
  }

  /** Turns the globe so the held point comes under a screen point. */
  private dragTo(x: number, y: number): void {
    if (!this.grab) return
    const under = this.sphereAt(x, y, length(this.grab))
    if (!under) return
    const turn = turnBetween(under, this.grab)
    if (!turn) return
    this.moveTarget(turn.axis, turn.angle)
    this.apply()
    this.onChange?.()
  }

  /**
   * Moves the camera towards (factor below 1) or away from a point, keeping
   * it where it is on the screen: camera and target both close in on it.
   */
  private scaleAbout(anchor: Vec3 | null, factor: number): void {
    const before = this.view.range
    const range = Math.min(Math.max(before * factor, MIN_RANGE), MAX_RANGE)
    const f = range / before
    if (anchor && f !== 1) {
      const target = this.targetEcef()
      const moved = add(anchor, scale(sub(target, anchor), f))
      const place = lonLatFromEcef(moved)
      this.view.lon = place.lon
      this.view.lat = place.lat
      this.view.height = place.height
    }
    this.view.range = range
    this.view.pitch = Math.min(this.view.pitch, maxPitch(range))
    this.apply()
    this.onChange?.()
  }

  /** Closer (factor below 1) or further, towards what's under a screen point, at once. */
  zoomAt(factor: number, x: number, y: number): void {
    this.flight = null
    this.zoom = null
    this.scaleAbout(this.surfaceAt(x, y), factor)
  }

  /** Starts (or adds to) a gliding zoom towards what's under a screen point. */
  private glideAt(logFactor: number, x: number, y: number): void {
    this.flight = null
    this.spin = null
    const zoom = this.zoom
    // The same point while the pointer stays; a new one when it moves.
    if (zoom && Math.hypot(zoom.at.x - x, zoom.at.y - y) < 4) zoom.remaining += logFactor
    else this.zoom = { remaining: (zoom?.remaining ?? 0) + logFactor, anchor: this.surfaceAt(x, y), at: { x, y } }
  }

  private orbit(dx: number, dy: number): void {
    const rect = this.rect()
    // Across the whole view turns half way round; up the whole view tilts about a right angle.
    const heading = (-dx / Math.max(rect.width, 1)) * Math.PI
    const pitch = (-dy / Math.max(rect.height, 1)) * Math.PI * 0.7
    this.view.heading += heading
    this.view.pitch = Math.min(Math.max(this.view.pitch + pitch, 0), maxPitch(this.view.range))
    this.apply()
    this.onChange?.()
  }

  /** Notes where the pointer is (and was, between frames), for carrying on when let go. */
  private trace(e: PointerEvent): void {
    const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : []
    for (const c of events.length > 0 ? events : [e]) this.trail.push({ x: c.clientX, y: c.clientY, t: c.timeStamp })
    const cut = e.timeStamp - 150
    while (this.trail.length > 2 && this.trail[0]!.t < cut) this.trail.shift()
  }

  /** On letting go: carry on as the last moment of the drag went, if it was still moving. */
  private letGo(now: number): void {
    const recent = this.trail.filter((p) => now - p.t < 100)
    this.trail = []
    if (recent.length < 2) return
    const first = recent[0]!
    const last = recent[recent.length - 1]!
    // Held still before letting go: no throw.
    if (now - last.t > 60) return
    const span = Math.max(last.t - first.t, 8)
    let vx = (last.x - first.x) / span
    let vy = (last.y - first.y) / span
    const speed = Math.hypot(vx, vy)
    if (speed < 0.05) return
    if (speed > FASTEST_THROW) {
      vx *= FASTEST_THROW / speed
      vy *= FASTEST_THROW / speed
    }
    if (this.mode === 'pan' && this.grab) this.spin = { grab: this.grab, x: last.x, y: last.y, vx, vy }
    else if (this.mode === 'orbit') this.turn = { vx, vy }
  }

  // Input

  private onContextMenu = (e: Event) => e.preventDefault()

  private onDown = (e: PointerEvent) => {
    if (!this.enabled) return
    this.flight = null
    this.stopCoasting()
    this.trail = [{ x: e.clientX, y: e.clientY, t: e.timeStamp }]
    try {
      this.element.setPointerCapture(e.pointerId)
    } catch {
      // A pointer the browser no longer tracks; the drag works without capture.
    }
    this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (this.touches.size === 1) {
      this.mode = e.button === 2 || e.button === 1 || e.ctrlKey || e.metaKey || e.shiftKey ? 'orbit' : 'pan'
      this.grab = this.mode === 'pan' ? this.holdAt(e.clientX, e.clientY) : null
      this.previous = { x: e.clientX, y: e.clientY }
    } else if (this.touches.size === 2) {
      this.mode = null
      this.pinch = this.pinchState()
      this.grab = this.holdAt(this.pinch.mid.x, this.pinch.mid.y)
      this.gesture = { kind: null, start: [...this.touches.values()].map((t) => ({ ...t })) }
    }
  }

  private pinchState(): { distance: number; angle: number; mid: Point } {
    const [a, b] = [...this.touches.values()] as [Point, Point]
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
    if (this.touches.size === 1 && this.previous) {
      this.trace(e)
      if (this.mode === 'pan') this.dragTo(e.clientX, e.clientY)
      else if (this.mode === 'orbit') this.orbit(e.clientX - this.previous.x, e.clientY - this.previous.y)
      this.previous = { x: e.clientX, y: e.clientY }
    } else if (this.touches.size === 2 && this.pinch && this.gesture) {
      const next = this.pinchState()
      const before = this.pinch
      const gesture = this.gesture
      if (!gesture.kind) {
        // Both fingers sliding up or down together, without spreading or turning, is a tilt; anything else a pinch.
        const moved = [...this.touches.values()].map((t, i) => ({ dx: t.x - gesture.start[i]!.x, dy: t.y - gesture.start[i]!.y }))
        const [a, b] = moved as [{ dx: number; dy: number }, { dx: number; dy: number }]
        const travel = Math.max(Math.hypot(a.dx, a.dy), Math.hypot(b.dx, b.dy))
        if (travel > 12) {
          const together = Math.sign(a.dy) === Math.sign(b.dy) && Math.abs(a.dy) > Math.abs(a.dx) * 1.5 && Math.abs(b.dy) > Math.abs(b.dx) * 1.5
          const spread = Math.abs(Math.abs(a.dy) - Math.abs(b.dy))
          gesture.kind = together && spread < Math.max(Math.abs(a.dy), Math.abs(b.dy)) * 0.5 ? 'tilt' : 'pinch'
        }
      }
      if (gesture.kind === 'tilt') this.orbit(0, next.mid.y - before.mid.y)
      else if (gesture.kind === 'pinch') {
        const spread = next.distance / Math.max(before.distance, 1)
        if (Math.abs(spread - 1) > 1e-4) this.scaleAbout(this.grab, 1 / spread)
        let twist = next.angle - before.angle
        twist = Math.atan2(Math.sin(twist), Math.cos(twist))
        this.view.heading -= twist
        this.apply()
        this.dragTo(next.mid.x, next.mid.y)
      }
      this.pinch = next
    }
  }

  private onUp = (e: PointerEvent) => {
    const now = e.timeStamp
    this.touches.delete(e.pointerId)
    if (this.element.hasPointerCapture(e.pointerId)) this.element.releasePointerCapture(e.pointerId)
    this.gesture = null
    if (this.touches.size === 1) {
      // From two fingers back to one: carry on dragging from where it is.
      const [rest] = [...this.touches.values()] as [Point]
      this.mode = 'pan'
      this.grab = this.holdAt(rest.x, rest.y)
      this.previous = { ...rest }
      this.trail = []
    } else if (this.touches.size === 0) {
      // Where the pointer let go counts too.
      this.trail.push({ x: e.clientX, y: e.clientY, t: now })
      this.letGo(now)
      this.mode = null
      this.grab = null
      this.previous = null
    }
    this.pinch = null
  }

  private onDoubleClick = (e: MouseEvent) => {
    if (!this.enabled) return
    e.preventDefault()
    this.glideAt(Math.log(e.shiftKey || e.altKey ? 2.5 : 0.4), e.clientX, e.clientY)
  }

  private onWheel = (e: WheelEvent) => {
    if (!this.enabled) return
    e.preventDefault()
    this.flight = null
    this.spin = null
    this.turn = null
    if (e.ctrlKey) {
      // A trackpad pinch: follows the fingers at once.
      if (this.gestureScale !== null) return
      const delta = Math.max(-50, Math.min(50, e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY))
      this.zoomAt(Math.exp(delta * 0.012), e.clientX, e.clientY)
      return
    }
    if (!isTrackpadScroll(e)) {
      // A mouse wheel: glides, a notch about a fifth of the way.
      const delta = Math.max(-240, Math.min(240, e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY))
      this.glideAt(delta * 0.0022, e.clientX, e.clientY)
      return
    }
    // Two fingers on a trackpad: the ground follows them.
    this.zoom = null
    const x = e.clientX
    const y = e.clientY
    this.grab = this.holdAt(x, y)
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
    const scaleNow = e.scale ?? 1
    const rect = this.rect()
    this.zoomAt(this.gestureScale / scaleNow, e.clientX ?? rect.left + rect.width / 2, e.clientY ?? rect.top + rect.height / 2)
    this.gestureScale = scaleNow
  }

  private onGestureEnd = (e: Event) => {
    e.preventDefault()
    this.gestureScale = null
  }

  /** Arrows move a quarter of the view; with Shift they turn and tilt; + and - zoom. */
  private onKey = (e: KeyboardEvent) => {
    if (!this.enabled || e.metaKey || e.ctrlKey || e.altKey) return
    const target = e.target as HTMLElement | null
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
    const view = this.view
    const rect = this.rect()
    if (e.key === '+' || e.key === '=') this.glideAt(Math.log(0.6), rect.left + rect.width / 2, rect.top + rect.height / 2)
    else if (e.key === '-' || e.key === '_') this.glideAt(Math.log(1 / 0.6), rect.left + rect.width / 2, rect.top + rect.height / 2)
    else if (e.key.startsWith('Arrow')) {
      const key = e.key.slice(5)
      if (e.shiftKey) {
        const turn = Math.PI / 12
        if (key === 'Left') this.flyTo({ heading: view.heading + turn }, 0.3)
        if (key === 'Right') this.flyTo({ heading: view.heading - turn }, 0.3)
        if (key === 'Up') this.flyTo({ pitch: Math.min(view.pitch + turn, maxPitch(view.range)) }, 0.3)
        if (key === 'Down') this.flyTo({ pitch: Math.max(view.pitch - turn, 0) }, 0.3)
      } else {
        // A quarter of what's in view, the way the view faces.
        const step = Math.min(view.range, this.altitude() * 3) * 0.5
        const [fe, fn] = [Math.sin(view.heading), Math.cos(view.heading)]
        const [de, dn] = key === 'Up' ? [fe, fn] : key === 'Down' ? [-fe, -fn] : key === 'Left' ? [-fn, fe] : [fn, -fe]
        const frame = enuFrame(view.lon, view.lat, view.height)
        const to = lonLatFromEcef(fromFrame(frame, [de * step, dn * step, 0]))
        this.flyTo({ lon: to.lon, lat: to.lat }, 0.3)
      }
    } else return
    e.preventDefault()
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
