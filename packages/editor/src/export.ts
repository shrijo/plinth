import {
  add,
  analyzeSite,
  buildSlabMesh,
  buildWallMesh,
  CURB_HEIGHT,
  fillLayout,
  normalize,
  openingCopies,
  openingType,
  placeOpening,
  resolveWall,
  scale,
  streetGeometry,
  sub,
  toRing,
  type FillPart,
  type MultiPolygon,
  type StreetPiece,
  type Opening,
  type Snapshot,
} from '@plinth/core'
import { BoxGeometry, Group, Mesh, Vector3, type BufferGeometry, type Object3D } from 'three'
import { toBufferGeometry } from './scene/geometry.ts'
import { buildingColours, fillMaterials, palette, shade, slabMaterials, streetMaterials, wallMaterials } from './scene/materials.ts'
import { paintSlab, paintWall } from './scene/paintParts.ts'
import { concatMeshes, roofParts } from './scene/shellMesh.ts'

/**
 * Builds the whole site as a three.js scene, straight from the model: each
 * building with every level (copies included), walls with their openings,
 * window and door fills and slabs; and the streets. Independent of what
 * the editor currently shows.
 */
export function buildExportScene(snapshot: Snapshot): { scene: Group; dispose: () => void } {
  const analysis = analyzeSite(snapshot)
  const geometries: BufferGeometry[] = []
  const box = new BoxGeometry(1, 1, 1)
  geometries.push(box)
  const track = (g: BufferGeometry) => {
    geometries.push(g)
    return g
  }

  const openingsByWall = new Map<string, Opening[]>()
  for (const opening of Object.values(snapshot.openings)) {
    openingsByWall.set(opening.wallId, [...(openingsByWall.get(opening.wallId) ?? []), opening])
  }

  const partMesh = (part: FillPart) => {
    const mesh = new Mesh(box, fillMaterials.normal[part.material])
    mesh.name = part.material
    mesh.position.set(part.center[0], part.center[1], part.center[2])
    mesh.scale.set(part.size[0], part.size[1], part.size[2])
    return mesh
  }

  // In the style the editor shows.
  const p = palette()
  const scene = new Group()
  scene.name = snapshot.meta.name

  for (const building of analysis.buildings.values()) {
    const buildingGroup = new Group()
    buildingGroup.name = snapshot.buildings[building.buildingId]?.name ?? 'Building'
    scene.add(buildingGroup)
    const colours = buildingColours(building.buildingId)
    for (const levelAnalysis of building.levels) {
      const master = snapshot.levels[levelAnalysis.contentLevelId]
      if (!master) continue
      const group = new Group()
      group.name = levelAnalysis.level.name
      group.position.y = levelAnalysis.level.elevation - master.elevation
      buildingGroup.add(group)

      for (const [wallId, footprint] of levelAnalysis.footprints) {
        const wall = snapshot.walls[wallId]
        if (!wall) continue
        const resolved = resolveWall(wall, master, snapshot.meta)
        const lift = levelAnalysis.topOffsets.get(wallId) ?? 0
        const heightStart = resolved.heightStart + lift
        const heightEnd = resolved.heightEnd + lift
        const placed = (openingsByWall.get(wallId) ?? []).flatMap(openingCopies).flatMap((opening) => {
          const cut = placeOpening(footprint, opening, heightStart, heightEnd)
          return cut ? [{ opening, cut }] : []
        })
        const mesh = new Mesh(
          track(
            toBufferGeometry(
              paintWall(buildWallMesh(footprint, master.elevation, heightStart, heightEnd, placed.map((p) => p.cut)), footprint, {
                facade: colours.facade,
                interior: p.interior,
                cap: shade(p.interior, -0.16),
                outside: levelAnalysis.exteriorSides.get(wallId) ?? null,
              }),
            ),
          ),
          wallMaterials.normal,
        )
        mesh.name = 'Wall'
        group.add(mesh)

        const dir = normalize(sub(footprint.b, footprint.a))
        for (const { opening, cut } of placed) {
          const type = openingType(opening.typeId, opening.kind)
          const layout = fillLayout(type, cut.end - cut.start, cut.head - cut.sill, footprint.thickness, {
            flipHinge: !!opening.flipHinge,
            flipSide: !!opening.flipSide,
          })
          if (layout.frame.length === 0 && layout.leaves.length === 0) continue
          const fill = new Group()
          fill.name = type.name
          const centre = add(footprint.a, scale(dir, (cut.start + cut.end) / 2))
          fill.position.set(centre.x, master.elevation + (cut.sill + cut.head) / 2, -centre.y)
          fill.rotation.y = Math.atan2(dir.y, dir.x)
          for (const part of layout.frame) fill.add(partMesh(part))
          for (const leaf of layout.leaves) {
            const hinged = new Group()
            hinged.name = type.kind === 'door' ? 'Leaf' : 'Sash'
            hinged.position.set(leaf.hinge[0], leaf.hinge[1], leaf.hinge[2])
            hinged.rotation.y = opening.open ? leaf.openAngle : 0
            for (const part of leaf.parts) hinged.add(partMesh(part))
            fill.add(hinged)
          }
          group.add(fill)
        }
      }
      // The other floors of a run of copies: the same walls and fills, higher up (geometry shared).
      for (let k = 1; k < levelAnalysis.floors; k++) {
        const copy = group.clone()
        copy.name = `${levelAnalysis.level.name} (${k + 1} of ${levelAnalysis.floors})`
        copy.position.y += k * levelAnalysis.level.height
        buildingGroup.add(copy)
      }
    }

    for (const slab of building.slabs) {
      const painted = paintSlab(buildSlabMesh(slab.region, slab.bottom, slab.top), slab.levelId ? p.floor : colours.roof, colours.band, p.ceiling)
      const geometry = track(toBufferGeometry(painted))
      // A run's slab stands for one per floor.
      for (let k = 0; k < slab.count; k++) {
        const mesh = new Mesh(geometry, slabMaterials.normal)
        mesh.name = slab.levelId ? `Floor slab · ${snapshot.levels[slab.levelId]?.name ?? ''}` : 'Roof slab'
        mesh.position.y = k * slab.step
        buildingGroup.add(mesh)
      }
    }

    const roofs = roofParts(building, snapshot.meta, p)
    if (roofs.length > 0) {
      const mesh = new Mesh(track(toBufferGeometry(concatMeshes(roofs))), slabMaterials.normal)
      mesh.name = 'Roof'
      buildingGroup.add(mesh)
    }
  }

  if (Object.keys(snapshot.streets).length > 0) {
    const streets = streetGeometry(snapshot)
    const group = new Group()
    group.name = 'Streets'
    scene.add(group)
    const surface = (name: string, region: MultiPolygon, bottom: number, top: number, material: Mesh['material']) => {
      if (region.length === 0) return
      const mesh = new Mesh(track(toBufferGeometry(buildSlabMesh(region, bottom, top))), material)
      mesh.name = name
      group.add(mesh)
    }
    const quads = (list: { x: number; y: number }[][]): MultiPolygon => list.map((q) => [toRing(q)])
    const all = (pick: (p: StreetPiece) => MultiPolygon) => streets.pieces.flatMap(pick)
    surface('Road', all((p) => p.road), -0.02, 0.02, streetMaterials.road)
    surface('Bike lanes', all((p) => p.bike), -0.02, 0.02, streetMaterials.bike)
    surface('Parking', all((p) => p.parking), -0.02, 0.02, streetMaterials.parking)
    surface('Markings', quads(streets.pieces.flatMap((p) => [...p.markings, ...p.crosswalks])), 0.02, 0.028, streetMaterials.marking)
    surface('Sidewalks', all((p) => p.sidewalks), 0, CURB_HEIGHT, streetMaterials.sidewalk)
  }

  return { scene, dispose: () => geometries.forEach((g) => g.dispose()) }
}

/** The site as a binary glTF (.glb) file: Y up, metres. */
export async function exportGLB(snapshot: Snapshot): Promise<ArrayBuffer> {
  const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js')
  const { scene, dispose } = buildExportScene(snapshot)
  try {
    const result = await new GLTFExporter().parseAsync(scene, { binary: true })
    if (!(result instanceof ArrayBuffer)) throw new Error('The exporter did not produce a binary file.')
    return result
  } finally {
    dispose()
  }
}

/** A file to hand to the user: its contents and what kind of file it is. */
export interface ExportedFile {
  data: string | ArrayBuffer
  extension: string
  mime: string
  description: string
}

export type ModelFormat = 'glb' | 'obj' | 'stl' | 'usdz'

/**
 * The site as a 3D model file. glTF and USDZ keep colours; OBJ and STL are
 * shape only. All in metres; glTF, OBJ and USDZ with Y up, STL with Z up as
 * 3D printers expect.
 */
export async function exportModel(snapshot: Snapshot, format: ModelFormat): Promise<ExportedFile> {
  if (format === 'glb') {
    return { data: await exportGLB(snapshot), extension: 'glb', mime: 'model/gltf-binary', description: '3D model (glTF binary)' }
  }
  const { scene, dispose } = buildExportScene(snapshot)
  try {
    scene.updateMatrixWorld(true)
    if (format === 'obj') return { data: objFile(scene), extension: 'obj', mime: 'model/obj', description: '3D model (OBJ)' }
    if (format === 'stl') {
      const { STLExporter } = await import('three/examples/jsm/exporters/STLExporter.js')
      // Z up.
      scene.rotation.x = Math.PI / 2
      scene.updateMatrixWorld(true)
      const view = new STLExporter().parse(scene, { binary: true }) as DataView
      const data = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer
      return { data, extension: 'stl', mime: 'model/stl', description: '3D model (STL)' }
    }
    const { USDZExporter } = await import('three/examples/jsm/exporters/USDZExporter.js')
    const bytes = await new USDZExporter().parseAsync(scene)
    const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    return { data, extension: 'usdz', mime: 'model/vnd.usdz+zip', description: '3D model for AR (USDZ)' }
  } finally {
    dispose()
  }
}

/**
 * A scene as an OBJ file: one object per mesh, each point once (flat
 * faces share their corners), to the millimetre. Written in pieces
 * straight to bytes: a city's OBJ is too big for one JavaScript string.
 */
function objFile(scene: Object3D): ArrayBuffer {
  const encoder = new TextEncoder()
  const chunks: Uint8Array[] = []
  let text: string[] = []
  let size = 0
  const write = (line: string) => {
    text.push(line)
    size += line.length
    if (size > 1 << 20) flush()
  }
  const flush = () => {
    chunks.push(encoder.encode(text.join('')))
    text = []
    size = 0
  }
  const point = new Vector3()
  const round = (v: number) => String(Math.round(v * 1000) / 1000)
  let offset = 0
  write('# Plinth\n# Metres, Y up\n')
  scene.updateMatrixWorld(true)
  scene.traverse((object) => {
    if (!(object instanceof Mesh)) return
    const geometry = object.geometry as BufferGeometry
    const positions = geometry.getAttribute('position')
    if (!positions) return
    write(`o ${(object.name || 'Mesh').replace(/\s+/g, '_')}\n`)
    const indexOf = new Map<string, number>()
    const remap = new Int32Array(positions.count)
    for (let i = 0; i < positions.count; i++) {
      point.fromBufferAttribute(positions, i).applyMatrix4(object.matrixWorld)
      const key = `${round(point.x)} ${round(point.y)} ${round(point.z)}`
      let index = indexOf.get(key)
      if (index === undefined) {
        index = offset + indexOf.size + 1
        indexOf.set(key, index)
        write(`v ${key}\n`)
      }
      remap[i] = index
    }
    const index = geometry.getIndex()
    const corner = (i: number) => remap[index ? index.getX(i) : i]!
    const count = index ? index.count : positions.count
    for (let i = 0; i + 2 < count; i += 3) {
      const a = corner(i)
      const b = corner(i + 1)
      const c = corner(i + 2)
      if (a !== b && b !== c && a !== c) write(`f ${a} ${b} ${c}\n`)
    }
    offset += indexOf.size
  })
  flush()
  const total = chunks.reduce((sum, c) => sum + c.length, 0)
  const bytes = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    bytes.set(chunk, at)
    at += chunk.length
  }
  return bytes.buffer
}
