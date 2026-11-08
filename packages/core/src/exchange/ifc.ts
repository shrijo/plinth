import { add, normalize, scale, sub, type Vec2 } from '../math.ts'
import { openingCopies, resolveWall, type Id, type Opening, type Snapshot } from '../model.ts'
import { fillLayout, openingType, type FillPart } from '../openingTypes.ts'
import { ROOM_USE_NAMES, roomTagsOf, roomTitle } from '../areas.ts'
import { analyzeSite, type BuildingAnalysis, type LevelAnalysis } from '../geometry/analysis.ts'
import { buildSlabMesh, buildWallMesh, placeOpening, type MeshData } from '../geometry/mesh.ts'
import { roofGeometry } from '../geometry/roofs.ts'
import {
  DERIVED,
  NONE,
  StepWriter,
  enumeration,
  guid,
  int,
  list,
  real,
  str,
  type StepValue,
} from './step.ts'

/**
 * The site as an IFC 4 file, for architecture and BIM software: a project
 * with a site, its buildings, a storey per floor (each floor of a run of
 * copies too), and in each storey its walls (with openings filled by
 * windows and doors), its floor slab and its rooms as spaces with their
 * areas; a roof on top. Geometry is triangulated, made by the same code
 * the editor draws with, so the file shows exactly what the editor does.
 * The floors of a run share their shapes, which keeps the file small.
 *
 * Coordinates are metres with Z up: plan x and y as in the editor.
 */
export function exportIFC(snapshot: Snapshot, options: { time?: Date } = {}): string {
  const analysis = analyzeSite(snapshot)
  const w = new StepWriter()
  const meta = snapshot.meta
  const projectKey = `project:${meta.name}`

  // Units, the world coordinate system and the representation contexts.
  const units = w.add('IFCUNITASSIGNMENT', list([
    w.add('IFCSIUNIT', DERIVED, enumeration('LENGTHUNIT'), NONE, enumeration('METRE')),
    w.add('IFCSIUNIT', DERIVED, enumeration('AREAUNIT'), NONE, enumeration('SQUARE_METRE')),
    w.add('IFCSIUNIT', DERIVED, enumeration('VOLUMEUNIT'), NONE, enumeration('CUBIC_METRE')),
    w.add('IFCSIUNIT', DERIVED, enumeration('PLANEANGLEUNIT'), NONE, enumeration('RADIAN')),
  ]))
  const origin = w.add('IFCCARTESIANPOINT', list([real(0), real(0), real(0)]))
  const up = w.add('IFCDIRECTION', list([real(0), real(0), real(1)]))
  const east = w.add('IFCDIRECTION', list([real(1), real(0), real(0)]))
  const world = w.add('IFCAXIS2PLACEMENT3D', origin, up, east)
  const context = w.add('IFCGEOMETRICREPRESENTATIONCONTEXT', NONE, str('Model'), int(3), real(1e-5), world, NONE)
  const body = w.add(
    'IFCGEOMETRICREPRESENTATIONSUBCONTEXT',
    str('Body'),
    str('Model'),
    DERIVED,
    DERIVED,
    DERIVED,
    DERIVED,
    context,
    NONE,
    enumeration('MODEL_VIEW'),
    NONE,
  )
  const project = w.add('IFCPROJECT', guid(projectKey), NONE, str(meta.name), NONE, NONE, NONE, NONE, list([context]), units)

  const identity = w.add('IFCAXIS2PLACEMENT3D', origin, NONE, NONE)
  const sitePlacement = w.add('IFCLOCALPLACEMENT', NONE, identity)
  const site = w.add('IFCSITE', guid(`${projectKey}/site`), NONE, str('Site'), NONE, NONE, sitePlacement, NONE, NONE, enumeration('ELEMENT'), NONE, NONE, NONE, NONE, NONE)
  w.add('IFCRELAGGREGATES', guid(`${projectKey}/site/rel`), NONE, NONE, NONE, project, list([site]))

  /** A placement relative to a parent, raised by `z`. */
  const placementAt = (parent: StepValue, z: number): StepValue => {
    const location = z === 0 ? origin : w.add('IFCCARTESIANPOINT', list([real(0), real(0), real(z)]))
    return w.add('IFCLOCALPLACEMENT', parent, w.add('IFCAXIS2PLACEMENT3D', location, NONE, NONE))
  }

  /** A shape from triangles; null for an empty mesh. */
  const shape = (mesh: MeshData): StepValue | null => {
    const set = faceSet(w, mesh)
    if (!set) return null
    const representation = w.add('IFCSHAPEREPRESENTATION', body, str('Body'), str('Tessellation'), list([set]))
    return w.add('IFCPRODUCTDEFINITIONSHAPE', NONE, NONE, list([representation]))
  }

  const openingsByWall = new Map<Id, Opening[]>()
  for (const opening of Object.values(snapshot.openings)) {
    const list = openingsByWall.get(opening.wallId)
    if (list) list.push(opening)
    else openingsByWall.set(opening.wallId, [opening])
  }

  const buildings: StepValue[] = []
  for (const building of analysis.buildings.values()) {
    const record = snapshot.buildings[building.buildingId]
    if (!record) continue
    const key = `building:${building.buildingId}`
    const placement = placementAt(sitePlacement, 0)
    const ifcBuilding = w.add('IFCBUILDING', guid(key), NONE, str(record.name), NONE, NONE, placement, NONE, NONE, enumeration('ELEMENT'), NONE, NONE, NONE)
    buildings.push(ifcBuilding)
    const storeys = writeBuilding(snapshot, building, key, placement, openingsByWall, { w, shape, placementAt })
    if (storeys.length > 0) w.add('IFCRELAGGREGATES', guid(`${key}/storeys`), NONE, NONE, NONE, ifcBuilding, list(storeys))
  }
  if (buildings.length > 0) w.add('IFCRELAGGREGATES', guid(`${projectKey}/buildings`), NONE, NONE, NONE, site, list(buildings))

  const time = (options.time ?? new Date()).toISOString().slice(0, 19)
  return w.file({
    description: 'ViewDefinition [ReferenceView_V1.2]',
    name: `${meta.name}.ifc`,
    time,
    system: 'Plinth',
    schema: 'IFC4',
  })
}

interface Tools {
  w: StepWriter
  shape: (mesh: MeshData) => StepValue | null
  placementAt: (parent: StepValue, z: number) => StepValue
}

/** The shapes of one level's contents, made once and shared by every floor that shows them. */
interface LevelShapes {
  walls: { id: Id; shape: StepValue; openings: { opening: Opening; index: number; void: StepValue | null; fill: StepValue | null; width: number; height: number }[] }[]
  spaces: { id: string; name: string; use: string | null; shape: StepValue | null; area: number; height: number }[]
}

/** Writes a building's storeys and everything in them; returns the storeys. */
function writeBuilding(
  snapshot: Snapshot,
  building: BuildingAnalysis,
  key: string,
  buildingPlacement: StepValue,
  openingsByWall: Map<Id, Opening[]>,
  { w, shape, placementAt }: Tools,
): StepValue[] {
  const storeys: StepValue[] = []
  const shapesByContent = new Map<Id, LevelShapes>()
  const ground = building.levels[0]?.level.elevation ?? 0

  for (const levelAnalysis of building.levels) {
    const master = snapshot.levels[levelAnalysis.contentLevelId]
    if (!master) continue
    let shapes = shapesByContent.get(levelAnalysis.contentLevelId)
    if (!shapes) {
      shapes = levelShapes(snapshot, levelAnalysis, openingsByWall, shape)
      shapesByContent.set(levelAnalysis.contentLevelId, shapes)
    }
    const { level } = levelAnalysis
    for (let k = 0; k < levelAnalysis.floors; k++) {
      const elevation = level.elevation + k * level.height
      const floorKey = `${key}/level:${level.id}/${k}`
      const name = levelAnalysis.floors > 1 ? `${level.name} (${k + 1} of ${levelAnalysis.floors})` : level.name
      const storeyPlacement = placementAt(buildingPlacement, 0)
      const storey = w.add('IFCBUILDINGSTOREY', guid(floorKey), NONE, str(name), NONE, NONE, storeyPlacement, NONE, NONE, enumeration('ELEMENT'), real(elevation - ground))
      storeys.push(storey)
      // Shapes are made at the level's own height; this floor's are raised by the difference.
      const at = placementAt(storeyPlacement, elevation - master.elevation)
      const elements: StepValue[] = []

      for (const wall of shapes.walls) {
        const wallKey = `${floorKey}/wall:${wall.id}`
        const ifcWall = w.add('IFCWALL', guid(wallKey), NONE, str('Wall'), NONE, NONE, at, wall.shape, NONE, enumeration('STANDARD'))
        elements.push(ifcWall)
        for (const opening of wall.openings) {
          const openingKey = `${wallKey}/opening:${opening.opening.id}:${opening.index}`
          if (!opening.void) continue
          const hole = w.add('IFCOPENINGELEMENT', guid(openingKey), NONE, str('Opening'), NONE, NONE, at, opening.void, NONE, enumeration('OPENING'))
          w.add('IFCRELVOIDSELEMENT', guid(`${openingKey}/voids`), NONE, NONE, NONE, ifcWall, hole)
          const type = openingType(opening.opening.typeId, opening.opening.kind)
          const fill =
            opening.opening.kind === 'door'
              ? w.add('IFCDOOR', guid(`${openingKey}/fill`), NONE, str(type.name), NONE, NONE, at, opening.fill ?? NONE, NONE, real(opening.height), real(opening.width), enumeration('DOOR'), enumeration('NOTDEFINED'), NONE)
              : w.add('IFCWINDOW', guid(`${openingKey}/fill`), NONE, str(type.name), NONE, NONE, at, opening.fill ?? NONE, NONE, real(opening.height), real(opening.width), enumeration('WINDOW'), enumeration('NOTDEFINED'), NONE)
          w.add('IFCRELFILLSELEMENT', guid(`${openingKey}/fills`), NONE, NONE, NONE, hole, fill)
          elements.push(fill)
        }
      }

      // The floor slab this floor stands on (the lowest floor's too).
      for (const slab of building.slabs) {
        if (slab.levelId !== level.id) continue
        const step = slab.id.startsWith('floors:') ? k - 1 : k === 0 ? 0 : -1
        if (step < 0 || step >= slab.count) continue
        const mesh = buildSlabMesh(slab.region, slab.bottom + step * slab.step - elevation, slab.top + step * slab.step - elevation)
        const slabShape = shape(fromWorld(mesh))
        if (!slabShape) continue
        elements.push(w.add('IFCSLAB', guid(`${floorKey}/slab`), NONE, str('Floor slab'), NONE, NONE, placementAt(storeyPlacement, elevation), slabShape, NONE, enumeration('FLOOR')))
      }

      if (elements.length > 0) w.add('IFCRELCONTAINEDINSPATIALSTRUCTURE', guid(`${floorKey}/contains`), NONE, NONE, NONE, list(elements), storey)

      // Rooms, with their areas.
      const spaces: StepValue[] = []
      shapes.spaces.forEach((space) => {
        const spaceKey = `${floorKey}/space:${space.id}`
        const ifcSpace = w.add('IFCSPACE', guid(spaceKey), NONE, str(space.name), NONE, space.use ? str(space.use) : NONE, at, space.shape ?? NONE, space.use ? str(space.use) : NONE, enumeration('ELEMENT'), enumeration('INTERNAL'), NONE)
        spaces.push(ifcSpace)
        const quantities = w.add(
          'IFCELEMENTQUANTITY',
          guid(`${spaceKey}/qto`),
          NONE,
          str('Qto_SpaceBaseQuantities'),
          NONE,
          NONE,
          list([
            w.add('IFCQUANTITYAREA', str('NetFloorArea'), NONE, NONE, real(space.area), NONE),
            w.add('IFCQUANTITYLENGTH', str('Height'), NONE, NONE, real(space.height), NONE),
            w.add('IFCQUANTITYVOLUME', str('NetVolume'), NONE, NONE, real(space.area * space.height), NONE),
          ]),
        )
        w.add('IFCRELDEFINESBYPROPERTIES', guid(`${spaceKey}/qto/rel`), NONE, NONE, NONE, list([ifcSpace]), quantities)
      })
      if (spaces.length > 0) w.add('IFCRELAGGREGATES', guid(`${floorKey}/spaces`), NONE, NONE, NONE, storey, list(spaces))
    }
  }

  // The roof, in the top storey.
  const top = building.slabs.find((slab) => slab.levelId === null)
  const topStorey = storeys.at(-1)
  if (top && topStorey) {
    const roofKey = `${key}/roof`
    const elements: StepValue[] = []
    const roof = building.roof
    const flatTop = shape(fromWorld(buildSlabMesh(top.region, top.bottom, top.top)))
    if (flatTop) elements.push(w.add('IFCSLAB', guid(`${roofKey}/slab`), NONE, str('Roof slab'), NONE, NONE, placementAt(buildingPlacement, 0), flatTop, NONE, enumeration('ROOF')))
    const geometry = roofGeometry(top.region, top.top, roof, snapshot.meta.wallThickness)
    const roofShape = shape(fromWorld(geometry.roof))
    if (roofShape) {
      const kind = { flat: 'FLAT_ROOF', shed: 'SHED_ROOF', gable: 'GABLE_ROOF', hip: 'HIP_ROOF' }[roof.kind]
      elements.push(w.add('IFCROOF', guid(roofKey), NONE, str('Roof'), NONE, NONE, placementAt(buildingPlacement, 0), roofShape, NONE, enumeration(kind)))
    }
    const wallsShape = shape(fromWorld(geometry.walls))
    if (wallsShape) {
      const parapet = roof.kind === 'flat'
      elements.push(
        w.add('IFCWALL', guid(`${roofKey}/walls`), NONE, str(parapet ? 'Parapet' : 'Gable wall'), NONE, NONE, placementAt(buildingPlacement, 0), wallsShape, NONE, enumeration(parapet ? 'PARAPET' : 'STANDARD')),
      )
    }
    if (elements.length > 0) w.add('IFCRELCONTAINEDINSPATIALSTRUCTURE', guid(`${roofKey}/contains`), NONE, NONE, NONE, list(elements), topStorey)
  }
  return storeys
}

/** One level's walls (with their openings and fills) and rooms, at heights above the level's floor. */
function levelShapes(
  snapshot: Snapshot,
  levelAnalysis: LevelAnalysis,
  openingsByWall: Map<Id, Opening[]>,
  shape: (mesh: MeshData) => StepValue | null,
): LevelShapes {
  const master = snapshot.levels[levelAnalysis.contentLevelId]
  const walls: LevelShapes['walls'] = []
  for (const [wallId, footprint] of levelAnalysis.footprints) {
    const wall = snapshot.walls[wallId]
    if (!wall) continue
    const resolved = resolveWall(wall, master, snapshot.meta)
    const lift = levelAnalysis.topOffsets.get(wallId) ?? 0
    const heightStart = resolved.heightStart + lift
    const heightEnd = resolved.heightEnd + lift
    const placed = (openingsByWall.get(wallId) ?? []).flatMap(openingCopies).flatMap((opening, index) => {
      const cut = placeOpening(footprint, opening, heightStart, heightEnd)
      return cut ? [{ opening, cut, index }] : []
    })
    const wallShape = shape(fromWorld(buildWallMesh(footprint, 0, heightStart, heightEnd, placed.map((p) => p.cut))))
    if (!wallShape) continue
    const dir = normalize(sub(footprint.b, footprint.a))
    const right = { x: dir.y, y: -dir.x }
    const openings = placed.map(({ opening, cut, index }) => {
      const width = cut.end - cut.start
      const height = cut.head - cut.sill
      const centre = add(footprint.a, scale(dir, (cut.start + cut.end) / 2))
      const middle = (cut.sill + cut.head) / 2
      // The hole: a box through the wall, a little thicker than it.
      const hole = boxes([{ centre, middle, along: 0, up: 0, across: 0, size: [width, height, footprint.thickness + 0.02] }], dir, right)
      const type = openingType(opening.typeId, opening.kind)
      const layout = fillLayout(type, width, height, footprint.thickness, { flipHinge: !!opening.flipHinge, flipSide: !!opening.flipSide })
      const parts: FillPart[] = [
        ...layout.frame,
        ...layout.leaves.flatMap((leaf) =>
          leaf.parts.map((part) => ({
            ...part,
            center: [part.center[0] + leaf.hinge[0], part.center[1] + leaf.hinge[1], part.center[2] + leaf.hinge[2]] as [number, number, number],
          })),
        ),
      ]
      const fill = boxes(
        parts.map((part) => ({ centre, middle, along: part.center[0], up: part.center[1], across: part.center[2], size: part.size })),
        dir,
        right,
      )
      return { opening, index, width, height, void: shape(hole), fill: parts.length > 0 ? shape(fill) : null }
    })
    walls.push({ id: wallId, shape: wallShape, openings })
  }

  const clear = Math.max(0.1, levelAnalysis.level.height - snapshot.meta.slabThickness)
  const tags = roomTagsOf(snapshot, levelAnalysis)
  const spaces = levelAnalysis.rooms.map((room, i) => ({
    id: room.id,
    name: roomTitle(i, tags[i]),
    use: tags[i] ? ROOM_USE_NAMES[tags[i].use] : null,
    shape: shape(fromWorld(buildSlabMesh(room.floor, 0, clear))),
    area: room.area,
    height: clear,
  }))
  return { walls, spaces }
}

interface Box {
  centre: Vec2
  middle: number
  /** Offsets from the opening's centre: along the wall, up, and across it (towards its right face). */
  along: number
  up: number
  across: number
  size: [number, number, number]
}

/** Boxes lined up with a wall, as one mesh in IFC coordinates (x, y in plan, z up). */
function boxes(list: Box[], dir: Vec2, right: Vec2): MeshData {
  const positions: number[] = []
  const indices: number[] = []
  for (const box of list) {
    const c = add(box.centre, add(scale(dir, box.along), scale(right, box.across)))
    const z = box.middle + box.up
    const [sx, sy, sz] = box.size
    const base = positions.length / 3
    for (const [u, v, h] of [
      [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
      [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
    ] as const) {
      const p = add(c, add(scale(dir, (u * sx) / 2), scale(right, (v * sz) / 2)))
      positions.push(p.x, p.y, z + (h * sy) / 2)
    }
    for (const [a, b, d] of [
      [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
      [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5],
      [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
    ] as const) indices.push(base + a, base + b, base + d)
  }
  return { positions: new Float32Array(positions), normals: new Float32Array(positions.length), indices: new Uint32Array(indices) }
}

/** A mesh in the editor's world coordinates (Y up, plan y as -z) in IFC's (plan x, plan y, Z up). */
function fromWorld(mesh: MeshData): MeshData {
  const positions = new Float32Array(mesh.positions.length)
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] = mesh.positions[i]!
    positions[i + 1] = -mesh.positions[i + 2]!
    positions[i + 2] = mesh.positions[i + 1]!
  }
  return { positions, normals: mesh.normals, indices: mesh.indices }
}

/** A triangulated face set, with repeated points merged; null for no triangles. */
function faceSet(w: StepWriter, mesh: MeshData): StepValue | null {
  if (mesh.indices.length < 3) return null
  const points: StepValue[] = []
  const indexOf = new Map<string, number>()
  const remap = new Int32Array(mesh.positions.length / 3)
  for (let i = 0; i < remap.length; i++) {
    const x = real(mesh.positions[i * 3]!)
    const y = real(mesh.positions[i * 3 + 1]!)
    const z = real(mesh.positions[i * 3 + 2]!)
    const key = `${x},${y},${z}`
    let index = indexOf.get(key)
    if (index === undefined) {
      index = points.length + 1
      indexOf.set(key, index)
      points.push(list([x, y, z]))
    }
    remap[i] = index
  }
  const triangles: StepValue[] = []
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const a = remap[mesh.indices[i]!]!
    const b = remap[mesh.indices[i + 1]!]!
    const c = remap[mesh.indices[i + 2]!]!
    if (a === b || b === c || a === c) continue
    triangles.push(list([int(a), int(b), int(c)]))
  }
  if (triangles.length === 0) return null
  const coordinates = w.add('IFCCARTESIANPOINTLIST3D', list(points))
  return w.add('IFCTRIANGULATEDFACESET', coordinates, NONE, NONE, list(triangles), NONE)
}

