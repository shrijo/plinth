import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useState } from 'react'
import { BufferAttribute, MeshStandardMaterial, PerspectiveCamera, Plane, SRGBColorSpace, Texture, Vector3 } from 'three'
import { fetchHeights, sampleHeight, tilesCovering, type TileId } from '@plinth/world'
import { terrainMesh, terrainOf, type Vec2 } from '@plinth/core'
import { useEditor, useSnapshot } from '../context.ts'
import { WorldTiles } from '../world/WorldTiles.ts'
import { useBufferGeometry } from './geometry.ts'
import { daylight } from './daylight.ts'
import { PALETTES } from './materials.ts'

/** How far round the site the world is drawn (metres): beyond, the haze has it. */
const REACH = 20000

/**
 * The real world round a site placed on the map: the ground with its
 * streets and water, and the buildings, from open map data, as they are.
 * Where the site was made from the map (its world area), the site's own
 * model stands in for the world: the world's buildings and ground there
 * are left out.
 */
export function WorldContext() {
  const snapshot = useSnapshot()
  const show = useEditor((s) => s.showWorld)
  const origin = snapshot.meta.origin
  const ground = snapshot.meta.ground
  const area = snapshot.meta.worldArea
  const lon = origin?.kind === 'lonlat' ? origin.lon : null
  const lat = origin?.kind === 'lonlat' ? origin.lat : null
  // Without a ground height of its own, the site's zero is the ground at its origin.
  const [found, setFound] = useState<{ key: string; height: number } | null>(null)
  const key = lon !== null && lat !== null ? `${lon},${lat}` : null
  useEffect(() => {
    if (ground !== undefined || lon === null || lat === null) return
    let cancelled = false
    const tile: TileId = tilesCovering({ west: lon, east: lon, south: lat, north: lat }, 15)[0] ?? { z: 15, x: 0, y: 0 }
    fetchHeights(tile)
      .then((heights) => {
        if (!cancelled) setFound({ key: `${lon},${lat}`, height: (heights && sampleHeight(heights, lon, lat)) ?? 0 })
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [ground, lon, lat])
  const height = ground ?? (found?.key === key ? found.height : null)
  if (!show || lon === null || lat === null || height === null) return null
  return <World lon={lon} lat={lat} height={height} area={area ?? null} />
}

function World({ lon, lat, height, area }: { lon: number; lat: number; height: number; area: Vec2[] | null }) {
  const get = useThree((s) => s.get)
  const areaKey = area ? area.map((p) => `${p.x},${p.y}`).join(';') : ''
  const world = useMemo(() => {
    // Ground inside the area's box isn't drawn (clipped where it's inside all four planes).
    let clip: Plane[] | undefined
    if (area) {
      const xs = area.map((p) => p.x)
      const ys = area.map((p) => p.y)
      const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
      clip = [
        new Plane(new Vector3(-1, 0, 0), x0),
        new Plane(new Vector3(1, 0, 0), -x1),
        new Plane(new Vector3(0, 0, -1), -y1),
        new Plane(new Vector3(0, 0, 1), y0),
      ]
    }
    return new WorldTiles({
      anchor: { lon, lat, height },
      mask: area ? { lon, lat, points: area.map((p) => [p.x, p.y]) } : null,
      clip,
      maxDistance: REACH,
    })
    // The area by its points, so a new snapshot with the same area keeps the world.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lon, lat, height, areaKey])

  useEffect(() => {
    const { gl, scene } = get()
    const before = gl.localClippingEnabled
    gl.localClippingEnabled = true
    scene.add(world.group)
    return () => {
      scene.remove(world.group)
      world.dispose()
      gl.localClippingEnabled = before
    }
  }, [world, get])

  // The editor's look: outlines, and the sun on the water.
  const outlines = useEditor((s) => s.showOutlines)
  const hour = useEditor((s) => s.timeOfDay)
  const style = useEditor((s) => s.style)
  useEffect(() => world.setOutlines(outlines), [world, outlines])
  useEffect(() => {
    const light = daylight(hour, PALETTES[style])
    world.water.setSun(light.direction, light.sun)
    world.water.setSky(light.skyHorizon)
  }, [world, hour, style])

  useFrame(({ camera, size, gl, scene }) => {
    if (!(camera instanceof PerspectiveCamera)) return
    world.update(camera, size.height)
    world.reflect(gl, scene, camera)
  })
  return area ? <AreaWater world={world} area={area} /> : null
}

const areaMaterial = new MeshStandardMaterial({
  roughness: 1,
  metalness: 0,
  alphaTest: 0.5,
  // In front of the terrain (pushed back by 2, 4), behind streets.
  polygonOffset: true,
  polygonOffsetFactor: 1,
  polygonOffsetUnits: 2,
})

/**
 * The water and green of the real world over the site's own terrain, in
 * its world area: the site's terrain stays editable, and a lake on the
 * site still looks like one.
 */
function AreaWater({ world, area }: { world: WorldTiles; area: Vec2[] }) {
  const snapshot = useSnapshot()
  const terrain = terrainOf(snapshot)
  const base = snapshot.meta.ground ?? 0
  const [texture, setTexture] = useState<Texture | null>(null)
  useEffect(() => {
    let made: Texture | null = null
    let cancelled = false
    void world.areaImage().then((image) => {
      if (!image) return
      if (cancelled) {
        image.close()
        return
      }
      made = new Texture(image)
      made.flipY = false
      made.colorSpace = SRGBColorSpace
      made.anisotropy = 8
      made.needsUpdate = true
      setTexture(made)
    })
    return () => {
      cancelled = true
      made?.dispose()
    }
  }, [world])
  const xs = area.map((p) => p.x)
  const ys = area.map((p) => p.y)
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
  const mesh = useMemo(() => {
    const data = terrain ? terrainMesh(terrain) : { positions: new Float32Array(), normals: new Float32Array(), indices: new Uint32Array() }
    const uvs = new Float32Array((data.positions.length / 3) * 2)
    for (let k = 0; k < data.positions.length / 3; k++) {
      data.positions[k * 3 + 1] = data.positions[k * 3 + 1]! - base
      uvs[k * 2] = (data.positions[k * 3]! - x0) / (x1 - x0)
      uvs[k * 2 + 1] = (y1 + data.positions[k * 3 + 2]!) / (y1 - y0)
    }
    return { ...data, uvs }
  }, [terrain, base, x0, x1, y0, y1])
  const geometry = useBufferGeometry(mesh)
  useEffect(() => {
    geometry.setAttribute('uv', new BufferAttribute(mesh.uvs, 2))
  }, [geometry, mesh])
  useEffect(() => {
    areaMaterial.map = texture
    areaMaterial.needsUpdate = true
  }, [texture])
  if (!texture || !terrain) return null
  return <mesh geometry={geometry} material={areaMaterial} receiveShadow raycast={() => null} />
}
