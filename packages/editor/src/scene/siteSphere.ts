import type { Snapshot } from '@plinth/core'
import { Sphere, Vector3 } from 'three'

/** A sphere round everything on the site (street points and building corners), to frame it. */
export function siteSphere(snapshot: Snapshot): Sphere | null {
  const points = [
    ...Object.values(snapshot.streetNodes),
    ...Object.values(snapshot.nodes),
    ...Object.values(snapshot.parcels).flatMap((p) => p.points),
    ...Object.values(snapshot.spotHeights),
  ]
  if (points.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of points) {
    minX = Math.min(minX, p.x)
    maxX = Math.max(maxX, p.x)
    minY = Math.min(minY, p.y)
    maxY = Math.max(maxY, p.y)
  }
  const radius = Math.hypot(maxX - minX, maxY - minY) / 2
  return new Sphere(new Vector3((minX + maxX) / 2, 0, -(minY + maxY) / 2), Math.max(radius * 0.85, 20))
}
