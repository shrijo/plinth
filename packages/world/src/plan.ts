import ClipperLib from 'clipper-lib'
import type { MultiPolygon } from '@plinth/core'

/**
 * Plan shapes worked on as a whole: merged, cut from one another, grown and
 * shrunk (with Clipper, on whole millimetres, so nothing is lost to
 * rounding and no operation fails on a hair's breadth). A region here is
 * a set of rings that know their own way round: outlines anticlockwise,
 * holes clockwise, as every operation returns them.
 */
export type Region = ClipperLib.Paths

/** Millimetres. */
const SCALE = 1000
/** Arcs are drawn this close to round (metres). */
const ARC = 0.05

const point = (x: number, y: number): ClipperLib.IntPoint => ({ X: Math.round(x * SCALE), Y: Math.round(y * SCALE) })

/** A region from polygons with holes, whichever way their rings run. */
export function regionOf(polygons: MultiPolygon): Region {
  const paths: Region = []
  for (const polygon of polygons) {
    polygon.forEach((ring, r) => {
      if (ring.length < 3) return
      const path = ring.map(([x, y]) => point(x, y))
      // Outlines one way, holes the other, so they cut out of their own polygon.
      if (ClipperLib.Clipper.Orientation(path) !== (r === 0)) path.reverse()
      paths.push(path)
    })
  }
  return paths
}

/** A region from plain outlines (no holes), each filled whichever way it runs or crosses itself. */
export function regionOfOutlines(outlines: readonly (readonly { x: number; y: number }[])[]): Region {
  const paths: Region = []
  for (const outline of outlines) {
    if (outline.length < 3) continue
    const path = outline.map((p) => point(p.x, p.y))
    if (!ClipperLib.Clipper.Orientation(path)) path.reverse()
    paths.push(path)
  }
  return paths
}

export function rectangle(minX: number, minY: number, maxX: number, maxY: number): Region {
  return [[point(minX, minY), point(maxX, minY), point(maxX, maxY), point(minX, maxY)]]
}

/** A disc (as a polygon of 24 sides). */
export function disc(x: number, y: number, radius: number): Region {
  const path: ClipperLib.Path = []
  for (let k = 0; k < 24; k++) path.push(point(x + Math.cos((k * Math.PI) / 12) * radius, y + Math.sin((k * Math.PI) / 12) * radius))
  return [path]
}

function run(type: ClipperLib.ClipType, subject: Region, clip: Region): Region {
  const clipper = new ClipperLib.Clipper()
  clipper.AddPaths(subject, ClipperLib.PolyType.ptSubject, true)
  if (clip.length > 0) clipper.AddPaths(clip, ClipperLib.PolyType.ptClip, true)
  const out: Region = []
  clipper.Execute(type, out, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero)
  return out
}

/** Regions merged into one (overlaps, and outlines that cross themselves, resolved). */
export function merged(...regions: Region[]): Region {
  const all = regions.length === 1 ? regions[0]! : regions.flat()
  return all.length === 0 ? [] : run(ClipperLib.ClipType.ctUnion, all, [])
}

export function without(subject: Region, ...clips: Region[]): Region {
  if (subject.length === 0) return []
  const clip = clips.length === 1 ? clips[0]! : clips.flat()
  return clip.length === 0 ? subject : run(ClipperLib.ClipType.ctDifference, subject, clip)
}

export function common(a: Region, b: Region): Region {
  return a.length === 0 || b.length === 0 ? [] : run(ClipperLib.ClipType.ctIntersection, a, b)
}

/** A (merged) region grown by a distance (metres; shrunk if negative), its corners rounded. */
export function grown(region: Region, distance: number): Region {
  if (region.length === 0 || distance === 0) return region
  const offset = new ClipperLib.ClipperOffset(2, ARC * SCALE)
  offset.AddPaths(region, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon)
  const out: Region = []
  offset.Execute(out, distance * SCALE)
  return out
}

/**
 * A region closed over gaps narrower than twice `radius` and its inward
 * corners rounded to it (grown, then shrunk back), then opened: spikes and
 * necks narrower than twice `thin` taken away and its outward corners
 * rounded (shrunk, then grown back).
 */
export function rounded(region: Region, radius: number, thin: number): Region {
  if (region.length === 0) return region
  // Tidied between the steps: each leaves many points that add nothing, and the next would work on all of them.
  const closed = simplified(grown(simplified(grown(simplified(region), radius)), -(radius + thin)))
  return thin > 0 ? simplified(grown(closed, thin)) : closed
}

/** Lines given a width (metres), their ends cut square; rounded where they turn. */
export function stroked(lines: readonly (readonly { x: number; y: number }[])[], width: number): Region {
  const offset = new ClipperLib.ClipperOffset(2, ARC * SCALE)
  let any = false
  for (const line of lines) {
    if (line.length < 2) continue
    offset.AddPath(line.map((p) => point(p.x, p.y)), ClipperLib.JoinType.jtRound, ClipperLib.EndType.etOpenButt)
    any = true
  }
  if (!any) return []
  const out: Region = []
  offset.Execute(out, (width / 2) * SCALE)
  return out
}

/** Whether a point lies in a region (in one of its outlines, in none of its holes). */
export function inRegion(region: Region, x: number, y: number): boolean {
  const p = point(x, y)
  let winding = 0
  for (const path of region) {
    if (ClipperLib.Clipper.PointInPolygon(p, path) === 0) continue
    winding += ClipperLib.Clipper.Orientation(path) ? 1 : -1
  }
  return winding > 0
}

/** The area of a region (square metres). */
export function areaOf(region: Region): number {
  let sum = 0
  for (const path of region) sum += ClipperLib.Clipper.Area(path)
  return sum / (SCALE * SCALE)
}

/**
 * A region as polygons with their holes, in metres. (Each hole goes to the smallest outline round it: the
 * rings already know which they are by the way they run.)
 */
export function polygonsOf(region: Region): MultiPolygon {
  if (region.length === 0) return []
  interface Outline {
    path: ClipperLib.Path
    area: number
    bounds: ClipperLib.IntRect
    rings: [number, number][][]
  }
  const ring = (path: ClipperLib.Path): [number, number][] => path.map((p) => [p.X / SCALE, p.Y / SCALE])
  const boundsOf = (path: ClipperLib.Path): ClipperLib.IntRect => {
    const box = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity }
    for (const p of path) {
      if (p.X < box.left) box.left = p.X
      if (p.X > box.right) box.right = p.X
      if (p.Y < box.top) box.top = p.Y
      if (p.Y > box.bottom) box.bottom = p.Y
    }
    return box
  }
  const outlines: Outline[] = []
  const holes: ClipperLib.Path[] = []
  for (const path of region) {
    if (path.length < 3) continue
    const area = ClipperLib.Clipper.Area(path)
    if (area > 0) outlines.push({ path, area, bounds: boundsOf(path), rings: [ring(path)] })
    else if (area < 0) holes.push(path)
  }
  // Smallest first: the first outline found round a hole is its own.
  outlines.sort((a, b) => a.area - b.area)
  for (const hole of holes) {
    const p = hole[0]!
    const box = boundsOf(hole)
    for (const outline of outlines) {
      const b = outline.bounds
      if (box.left < b.left || box.right > b.right || box.top < b.top || box.bottom > b.bottom) continue
      if (ClipperLib.Clipper.PointInPolygon(p, outline.path) !== 0) {
        outline.rings.push(ring(hole))
        break
      }
    }
  }
  return outlines.map((outline) => outline.rings)
}

/** A region without the points that add nothing (within `tolerance` metres of the line through their neighbours). */
export function simplified(region: Region, tolerance = 0.03): Region {
  return ClipperLib.Clipper.CleanPolygons(region, tolerance * SCALE).filter((path) => path.length >= 3)
}
