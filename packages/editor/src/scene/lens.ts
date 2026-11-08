import { PerspectiveCamera, type Camera } from 'three'

/**
 * The camera is a full-frame camera with a real lens: the lens's focal
 * length (24 to 50 mm, 35 mm by default) is measured against the longer
 * side of the view, so a tall phone screen sees as naturally as a wide one.
 */
const FILM_GAUGE = 36
/** The lens detail is judged against: things look as big through it as to the eye. */
const REFERENCE_LENS = 35

/** Vertical field of view, in degrees, of a lens on a view of the given aspect ratio. */
export function fieldOfView(focalLength: number, aspect: number): number {
  const filmHeight = FILM_GAUGE / Math.max(aspect, 1)
  return (2 * Math.atan(filmHeight / 2 / focalLength) * 180) / Math.PI
}

/**
 * How far away something `distance` metres from the camera looks: the
 * distance at which a 35 mm lens would show it as big. A long lens (the top
 * view's) brings far things close, so detail that depends on how big things
 * look on screen goes by this, not by the distance itself.
 */
export function apparentDistance(camera: Camera, distance: number): number {
  if (!(camera instanceof PerspectiveCamera)) return distance
  const reference = FILM_GAUGE / Math.max(camera.aspect, 1) / 2 / REFERENCE_LENS
  return (distance * Math.tan((camera.fov * Math.PI) / 360)) / reference
}
