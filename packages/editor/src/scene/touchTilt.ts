/**
 * Two fingers sliding up or down together on a touchscreen tilt the camera,
 * as in maps: up tilts towards the horizon, down back towards looking
 * straight down. Anything else two fingers do (spreading, pinching,
 * turning, sliding sideways) is left to the camera controls, which zoom
 * and pan with it.
 *
 * The fingers' first few pixels tell which it is. Until then their moves
 * are held back from everything else listening (the camera controls catch
 * up afterwards if it isn't a tilt), and once it's a tilt they never see
 * them, until the last finger is lifted.
 */

/** How far a finger moves before a two-finger gesture is told apart (CSS pixels). */
export const TELL_APART_PX = 12
/** Moving up the whole height of the view tilts by about this much (radians). */
export const TILT_PER_VIEW = Math.PI * 0.7

export interface Point {
  x: number
  y: number
}

/**
 * What two fingers are doing, from where they touched down to where they
 * are now: a tilt when their middle slides up or down while they keep
 * their distance and their angle; something else (a pinch, a turn, a pan)
 * when that moves as much; not yet known (null) until either has moved far
 * enough to tell. Taken from the pair as a whole, not finger by finger:
 * each finger's moves come on their own, so one has often gone a step
 * further than the other at any moment.
 */
export function twoFingerGesture(start: readonly [Point, Point], now: readonly [Point, Point]): 'tilt' | 'other' | null {
  const dx = (now[0].x + now[1].x - start[0].x - start[1].x) / 2
  const dy = (now[0].y + now[1].y - start[0].y - start[1].y) / 2
  const before = Math.hypot(start[1].x - start[0].x, start[1].y - start[0].y)
  const after = Math.hypot(now[1].x - now[0].x, now[1].y - now[0].y)
  const spread = Math.abs(after - before)
  let turn = Math.atan2(now[1].y - now[0].y, now[1].x - now[0].x) - Math.atan2(start[1].y - start[0].y, start[1].x - start[0].x)
  turn = Math.atan2(Math.sin(turn), Math.cos(turn))
  // How far each finger has gone round the middle (pixels).
  const twist = (Math.abs(turn) * before) / 2
  if (Math.max(Math.hypot(dx, dy), spread, twist) < TELL_APART_PX) return null
  const vertical = Math.abs(dy) > Math.abs(dx) * 2
  return vertical && spread < Math.abs(dy) * 0.5 && twist < Math.abs(dy) * 0.5 ? 'tilt' : 'other'
}

export interface TouchTilt {
  /** Whether the view can tilt now (not in a plan view, say). */
  enabled: () => boolean
  /** Tilts the camera by an angle (radians): positive towards the horizon. */
  tilt: (radians: number) => void
}

/** Listens for two-finger tilts on an element (the canvas); returns what stops listening. */
export function attachTouchTilt(element: HTMLElement, tilt: TouchTilt): () => void {
  const touches = new Map<number, Point>()
  /** Where the two fingers touched down, in the order `touches` holds them. */
  let start: [Point, Point] | null = null
  let kind: 'tilt' | 'other' | null = null
  /** The fingers' middle, up the screen, as last tilted by. */
  let lastMiddle = 0
  /** A tilt's fingers are down: their moves stay held back until the last is lifted. */
  let tilting = false

  const down = (e: PointerEvent) => {
    if (e.pointerType !== 'touch' || !(e.target instanceof Node) || !element.contains(e.target)) return
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (touches.size === 2) {
      const [p, q] = [...touches.values()] as [Point, Point]
      start = [{ ...p }, { ...q }]
      lastMiddle = (p.y + q.y) / 2
      // Back to two fingers during a tilt: it carries on.
      kind = tilting ? 'tilt' : tilt.enabled() ? null : 'other'
    } else if (touches.size > 2 && !tilting) kind = 'other'
  }

  const move = (e: PointerEvent) => {
    const touch = touches.get(e.pointerId)
    if (!touch) return
    touch.x = e.clientX
    touch.y = e.clientY
    if (tilting && touches.size !== 2) {
      // A finger lifted, or a third came, after a tilt: nothing else takes over until all are lifted.
      e.stopImmediatePropagation()
      return
    }
    if (touches.size !== 2 || !start || kind === 'other') return
    const [p, q] = [...touches.values()] as [Point, Point]
    if (kind === null) {
      kind = twoFingerGesture(start, [p, q])
      if (kind === null) {
        e.stopImmediatePropagation()
        return
      }
      // Not a tilt: the controls get this move, and catch up from where the fingers touched down.
      if (kind === 'other') return
      tilting = true
    }
    e.stopImmediatePropagation()
    const middle = (p.y + q.y) / 2
    const height = Math.max(element.getBoundingClientRect().height, 1)
    // Up the screen (the middle's y falling) tilts towards the horizon; the first tilt takes in the way so far.
    tilt.tilt(((lastMiddle - middle) / height) * TILT_PER_VIEW)
    lastMiddle = middle
  }

  const up = (e: PointerEvent) => {
    if (!touches.delete(e.pointerId)) return
    if (touches.size < 2) {
      start = null
      kind = null
    }
    if (touches.size === 0) tilting = false
  }

  // On the window, as the event goes down to the element: ahead of the camera controls, which listen on the document.
  const options = { capture: true }
  window.addEventListener('pointerdown', down, options)
  window.addEventListener('pointermove', move, options)
  window.addEventListener('pointerup', up, options)
  window.addEventListener('pointercancel', up, options)
  return () => {
    window.removeEventListener('pointerdown', down, options)
    window.removeEventListener('pointermove', move, options)
    window.removeEventListener('pointerup', up, options)
    window.removeEventListener('pointercancel', up, options)
  }
}
