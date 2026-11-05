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
import { BoxGeometry, Group, Mesh, type BufferGeometry } from 'three'
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
    }

    for (const slab of building.slabs) {
      const painted = paintSlab(buildSlabMesh(slab.region, slab.bottom, slab.top), slab.levelId ? p.floor : colours.roof, colours.band, p.ceiling)
      const mesh = new Mesh(track(toBufferGeometry(painted)), slabMaterials.normal)
      mesh.name = slab.levelId ? `Floor slab · ${snapshot.levels[slab.levelId]?.name ?? ''}` : 'Roof slab'
      buildingGroup.add(mesh)
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
