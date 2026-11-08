import { Color, Vector3 } from 'three'
import type { Palette } from './materials.ts'

/**
 * The light at a time of day: where the sun is, how strong and how warm it
 * is, and the colours of the sky. The sun follows a real path for a
 * mid-latitude city in early summer, highest at noon in the south. North
 * is up the plan (+y).
 */

/**
 * The earliest and latest times the view offers, in hours. The sun is about
 * 14 degrees up at both: lower, and a dense city is all in shadow.
 */
export const FIRST_HOUR = 6
export const LAST_HOUR = 18
export const DEFAULT_HOUR = 14

const LATITUDE = (45 * Math.PI) / 180
const DECLINATION = (20 * Math.PI) / 180

export interface Daylight {
  /** Towards the sun, in the scene (x east, y up, z south). */
  direction: Vector3
  sun: Color
  sunIntensity: number
  ambientIntensity: number
  skyTop: Color
  skyHorizon: Color
}

/** Low sun: a little warmer and dimmer, with a hazier sky. Kept subtle; the scene stays near monochrome. */
const LOW_SUN = new Color('#ffd9b8')
const DUSK_TOP = new Color('#aeb6bf')
const DUSK_HORIZON = new Color('#eadfd3')

/** The sun's direction at an hour of the day (local solar time). */
export function sunDirection(hour: number, out = new Vector3()): Vector3 {
  const h = ((hour - 12) * 15 * Math.PI) / 180
  const up = Math.sin(LATITUDE) * Math.sin(DECLINATION) + Math.cos(LATITUDE) * Math.cos(DECLINATION) * Math.cos(h)
  const east = -Math.cos(DECLINATION) * Math.sin(h)
  const north = Math.cos(LATITUDE) * Math.sin(DECLINATION) - Math.sin(LATITUDE) * Math.cos(DECLINATION) * Math.cos(h)
  // Never quite at the horizon, so shadows stay finite.
  return out.set(east, Math.max(up, 0.06), -north).normalize()
}

export function daylight(hour: number, palette: Palette): Daylight {
  const direction = sunDirection(hour)
  // 0 with the sun on the horizon, 1 from about 30 degrees up.
  const t = Math.min(Math.max(direction.y / 0.5, 0), 1)
  const high = t * t * (3 - 2 * t)
  const low = 1 - high
  return {
    direction,
    sun: new Color(palette.sun).lerp(LOW_SUN, low * 0.7),
    // The sky still lights the shaded streets of a low sun well; only the sun itself weakens.
    sunIntensity: palette.sunIntensity * (0.7 + 0.3 * high),
    ambientIntensity: palette.ambientIntensity * (0.92 + 0.08 * high),
    skyTop: new Color(palette.skyTop).lerp(DUSK_TOP, low * 0.5),
    skyHorizon: new Color(palette.skyHorizon).lerp(DUSK_HORIZON, low * 0.5),
  }
}

/** "14:30" for 14.5. */
export function formatHour(hour: number): string {
  const minutes = Math.round(hour * 60)
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`
}
