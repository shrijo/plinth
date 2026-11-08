import earcut from 'earcut'
import { add, dist, normalize, scale, sub, type Vec2 } from '../math.ts'
import { openingCopies, resolveWall, type Id, type Opening, type Snapshot } from '../model.ts'
import { openingType } from '../openingTypes.ts'
import { roomTagsOf, roomTitle } from '../areas.ts'
import { analyzeSite } from '../geometry/analysis.ts'
import { placeOpening } from '../geometry/mesh.ts'
import { flatten, fromRing, normalizePolygon, type MultiPolygon } from '../geometry/regions.ts'
import { streetGeometry } from '../geometry/streets.ts'
import { formatArea } from '../units.ts'
import { contours, terrainOf } from '../terrain.ts'

/**
 * Floor plans as a DXF file (AutoCAD R12, which every CAD program reads), in
 * metres. Floors are layers: "F00" is the ground floor of every building,
 * "F01" the next, and so on; a run of identical floors is drawn once, on its
 * first floor's layers, and its rooms say how many floors it stands for.
 * For each floor: walls (outline and fill), windows and doors (a door with
 * its leaf and swing), and rooms with their name and area. The site has
 * its own layers: building footprints and streets.
 */
export function exportDXF(snapshot: Snapshot): string {
  const analysis = analyzeSite(snapshot)
  const dxf = new DxfWriter()

  const openingsByWall = new Map<Id, Opening[]>()
  for (const opening of Object.values(snapshot.openings)) {
    const list = openingsByWall.get(opening.wallId)
    if (list) list.push(opening)
    else openingsByWall.set(opening.wallId, [opening])
  }

  for (const building of analysis.buildings.values()) {
    let floor = 0
    for (const level of building.levels) {
      const layer = `F${String(floor).padStart(2, '0')}`
      floor += level.floors
      // A copy shows its master's plan, drawn where the master is drawn.
      if (level.contentLevelId !== level.level.id) continue
      const master = snapshot.levels[level.contentLevelId]

      for (const [wallId, footprint] of level.footprints) {
        const wall = snapshot.walls[wallId]
        if (!wall) continue
        dxf.polyline(`${layer}-WALLS`, footprint.polygon, true)
        dxf.fill(`${layer}-WALLS-FILL`, [[footprint.polygon.map((p): [number, number] => [p.x, p.y])]])

        const { heightStart, heightEnd } = resolveWall(wall, master, snapshot.meta)
        const dir = normalize(sub(footprint.b, footprint.a))
        const right = { x: dir.y, y: -dir.x }
        const half = footprint.thickness / 2
        for (const opening of (openingsByWall.get(wallId) ?? []).flatMap(openingCopies)) {
          const cut = placeOpening(footprint, opening, heightStart, heightEnd)
          if (!cut) continue
          const at = (s: number, across: number) => add(add(footprint.a, scale(dir, s)), scale(right, across))
          const openings = `${layer}-OPENINGS`
          dxf.polyline(openings, [at(cut.start, -half), at(cut.end, -half), at(cut.end, half), at(cut.start, half)], true)
          if (opening.kind === 'window') {
            dxf.line(openings, at(cut.start, 0), at(cut.end, 0))
            continue
          }
          // A door: each leaf drawn open at right angles, with the arc it sweeps.
          const type = openingType(opening.typeId, opening.kind)
          const side = opening.flipSide ? -1 : 1
          const leaves = Math.max(1, type.leaves)
          const width = (cut.end - cut.start) / leaves
          const hinges = leaves === 2 ? [cut.start, cut.end] : [opening.flipHinge ? cut.end : cut.start]
          for (const hinge of hinges) {
            const towards = hinge === cut.start ? 1 : -1
            const pivot = at(hinge, side * half)
            const open = at(hinge, side * (half + width))
            const shut = at(hinge + towards * width, side * half)
            dxf.line(openings, pivot, open)
            dxf.arc(openings, pivot, width, angleTo(pivot, open), angleTo(pivot, shut))
          }
        }
      }

      const tags = roomTagsOf(snapshot, level)
      level.rooms.forEach((room, i) => {
        dxf.polyline(`${layer}-ROOMS`, room.outline, true)
        if (!room.labelPoint) return
        const runs = level.floors > 1 ? ` (x${level.floors} floors)` : ''
        dxf.text(`${layer}-TEXT`, add(room.labelPoint, { x: 0, y: 0.2 }), 0.3, roomTitle(i, tags[i]))
        dxf.text(`${layer}-TEXT`, add(room.labelPoint, { x: 0, y: -0.25 }), 0.25, `${formatArea(room.area)}${runs}`)
      })
    }
    const ground = building.levels[0]
    for (const polygon of ground?.outline ?? []) for (const ring of polygon) dxf.polyline('SITE-BUILDINGS', fromRing(ring), true)
  }

  for (const parcel of Object.values(snapshot.parcels)) {
    dxf.polyline('SITE-PARCELS', parcel.points, true)
    const middle = parcel.points.reduce((sum, p) => add(sum, scale(p, 1 / parcel.points.length)), { x: 0, y: 0 })
    dxf.text('SITE-PARCELS', middle, 1, parcel.name)
  }

  const terrain = terrainOf(snapshot)
  if (terrain) {
    for (const contour of contours(terrain)) {
      const layer = contour.major ? 'SITE-CONTOURS-MAJOR' : 'SITE-CONTOURS'
      for (const [a, b] of contour.segments) dxf.line(layer, a, b)
    }
    for (const spot of terrain.points) dxf.text('SITE-SPOT-HEIGHTS', spot, 0.5, spot.z.toFixed(2))
  }

  if (Object.keys(snapshot.streets).length > 0) {
    const streets = streetGeometry(snapshot)
    for (const piece of streets.pieces) {
      for (const region of [piece.road, piece.sidewalks]) {
        for (const polygon of region) for (const ring of polygon) dxf.polyline('SITE-STREETS', fromRing(ring), true)
      }
    }
  }
  return dxf.file()
}

/** Direction from a point to another, in degrees anticlockwise from east. */
const angleTo = (from: Vec2, to: Vec2) => (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI

/** Layer colours (AutoCAD colour numbers) by the end of the layer's name. */
const LAYER_COLOURS: [string, number][] = [
  ['-WALLS-FILL', 8],
  ['-WALLS', 7],
  ['-OPENINGS', 4],
  ['-ROOMS', 3],
  ['-TEXT', 7],
  ['SITE-BUILDINGS', 9],
  ['SITE-STREETS', 9],
  ['SITE-PARCELS', 1],
  ['SITE-CONTOURS-MAJOR', 8],
  ['SITE-CONTOURS', 9],
  ['SITE-SPOT-HEIGHTS', 8],
]

class DxfWriter {
  private entities: string[] = []
  private layers = new Set<string>()
  private min = { x: Infinity, y: Infinity }
  private max = { x: -Infinity, y: -Infinity }

  private use(layer: string, points: readonly Vec2[]): void {
    this.layers.add(layer)
    for (const p of points) {
      this.min = { x: Math.min(this.min.x, p.x), y: Math.min(this.min.y, p.y) }
      this.max = { x: Math.max(this.max.x, p.x), y: Math.max(this.max.y, p.y) }
    }
  }

  private emit(...pairs: (string | number)[]): void {
    for (let i = 0; i < pairs.length; i += 2) this.entities.push(String(pairs[i]), formatValue(pairs[i + 1]!))
  }

  line(layer: string, a: Vec2, b: Vec2): void {
    if (dist(a, b) < 1e-9) return
    this.use(layer, [a, b])
    this.emit(0, 'LINE', 8, layer, 10, a.x, 20, a.y, 30, 0, 11, b.x, 21, b.y, 31, 0)
  }

  polyline(layer: string, points: readonly Vec2[], closed: boolean): void {
    if (points.length < 2) return
    this.use(layer, points)
    this.emit(0, 'POLYLINE', 8, layer, 66, 1, 70, closed ? 1 : 0, 10, 0, 20, 0, 30, 0)
    for (const p of points) this.emit(0, 'VERTEX', 8, layer, 10, p.x, 20, p.y, 30, 0)
    this.emit(0, 'SEQEND', 8, layer)
  }

  /** An arc round a centre from one angle to another (degrees, anticlockwise, the shorter way). */
  arc(layer: string, centre: Vec2, radius: number, from: number, to: number): void {
    let start = from
    let end = to
    // DXF arcs run anticlockwise from start to end: swap to take the short way round.
    if ((((end - start) % 360) + 360) % 360 > 180) [start, end] = [end, start]
    this.use(layer, [add(centre, { x: -radius, y: -radius }), add(centre, { x: radius, y: radius })])
    this.emit(0, 'ARC', 8, layer, 10, centre.x, 20, centre.y, 30, 0, 40, radius, 50, norm(start), 51, norm(end))
  }

  /** A region filled solid, as triangles (R12 has no hatches). */
  fill(layer: string, region: MultiPolygon): void {
    for (const raw of region) {
      const { coords, holes } = flatten(normalizePolygon(raw))
      const triangles = earcut(coords, holes)
      const p = (i: number): Vec2 => ({ x: coords[i * 2]!, y: coords[i * 2 + 1]! })
      for (let i = 0; i < triangles.length; i += 3) {
        const [a, b, c] = [p(triangles[i]!), p(triangles[i + 1]!), p(triangles[i + 2]!)]
        this.use(layer, [a, b, c])
        // A SOLID's fourth corner repeats the third for a triangle.
        this.emit(0, 'SOLID', 8, layer, 10, a.x, 20, a.y, 30, 0, 11, b.x, 21, b.y, 31, 0, 12, c.x, 22, c.y, 32, 0, 13, c.x, 23, c.y, 33, 0)
      }
    }
  }

  text(layer: string, at: Vec2, height: number, words: string): void {
    this.use(layer, [at])
    this.emit(0, 'TEXT', 8, layer, 10, at.x, 20, at.y, 30, 0, 40, height, 1, ascii(words), 72, 1, 11, at.x, 21, at.y, 31, 0)
  }

  file(): string {
    const lines: string[] = []
    const pair = (code: number, value: string | number) => lines.push(String(code), formatValue(value))
    const empty = !Number.isFinite(this.min.x)
    const min = empty ? { x: 0, y: 0 } : this.min
    const max = empty ? { x: 0, y: 0 } : this.max
    pair(0, 'SECTION')
    pair(2, 'HEADER')
    pair(9, '$ACADVER')
    pair(1, 'AC1009')
    pair(9, '$INSBASE')
    pair(10, 0)
    pair(20, 0)
    pair(30, 0)
    pair(9, '$EXTMIN')
    pair(10, min.x)
    pair(20, min.y)
    pair(30, 0)
    pair(9, '$EXTMAX')
    pair(10, max.x)
    pair(20, max.y)
    pair(30, 0)
    pair(0, 'ENDSEC')

    pair(0, 'SECTION')
    pair(2, 'TABLES')
    pair(0, 'TABLE')
    pair(2, 'LTYPE')
    pair(70, 1)
    pair(0, 'LTYPE')
    pair(2, 'CONTINUOUS')
    pair(70, 0)
    pair(3, 'Solid line')
    pair(72, 65)
    pair(73, 0)
    pair(40, 0)
    pair(0, 'ENDTAB')
    const layers = [...this.layers].sort()
    pair(0, 'TABLE')
    pair(2, 'LAYER')
    pair(70, layers.length + 1)
    for (const name of ['0', ...layers]) {
      const colour = LAYER_COLOURS.find(([end]) => name.endsWith(end))?.[1] ?? 7
      pair(0, 'LAYER')
      pair(2, name)
      pair(70, 0)
      pair(62, colour)
      pair(6, 'CONTINUOUS')
    }
    pair(0, 'ENDTAB')
    pair(0, 'TABLE')
    pair(2, 'STYLE')
    pair(70, 1)
    pair(0, 'STYLE')
    pair(2, 'STANDARD')
    pair(70, 0)
    pair(40, 0)
    pair(41, 1)
    pair(50, 0)
    pair(71, 0)
    pair(42, 0.25)
    pair(3, 'txt')
    pair(4, '')
    pair(0, 'ENDTAB')
    pair(0, 'ENDSEC')

    pair(0, 'SECTION')
    pair(2, 'BLOCKS')
    pair(0, 'ENDSEC')

    pair(0, 'SECTION')
    pair(2, 'ENTITIES')
    const head = lines.join('\n')
    // The entities can run to millions of lines: joined on their own, not spread into another list.
    return `${head}\n${this.entities.join('\n')}${this.entities.length > 0 ? '\n' : ''}0\nENDSEC\n0\nEOF\n`
  }
}

const norm = (degrees: number) => ((degrees % 360) + 360) % 360

function formatValue(value: string | number): string {
  if (typeof value === 'string') return value
  const rounded = Math.round(value * 1e6) / 1e6
  return Object.is(rounded, -0) ? '0' : String(rounded)
}

/** R12 text is plain ASCII: accents are dropped, anything else becomes a question mark. */
function ascii(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/m²/g, 'm2')
    .replace(/[^\x20-\x7e]/g, '?')
}
