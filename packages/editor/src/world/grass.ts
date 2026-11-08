import {
  BufferAttribute,
  BufferGeometry,
  Color,
  FloatType,
  FrontSide,
  Group,
  InstancedMesh,
  MeshStandardMaterial,
  NearestFilter,
  OrthographicCamera,
  RGBAFormat,
  ShaderMaterial,
  Sphere,
  Vector3,
  Vector4,
  WebGLRenderTarget,
  type Object3D,
  type Plane,
  type Scene,
  type WebGLRenderer,
} from 'three'
import { ecefFromLonLat, fromFrame, lonLatFromEcef, tileFrame, tileKey, tileWidth, toFrame, type Frame, type TileId, type Vec3 } from '@plinth/world'

/**
 * Grass on the green spaces, close to the camera, the way games grow it
 * (after grass-shader-glsl's approach): instanced blades in square patches
 * round the camera, each blade a tapering strip bent by a vertex shader —
 * a lean of its own, a sway, and gusts drifting downwind as a noise field —
 * and shaded from a darker root to a pale tip. Blades grow only where the
 * world's grass mask says (lawns, and the raised green block fills), and
 * each one's root is set on whatever surface is really there — ground, fill
 * or bed — read off a height map of the ground round the camera, rendered
 * from above now and then (the way games blend grass into terrain). Blades
 * turn their faces to the camera, so none shows a dark back, and they shrink
 * away towards the edge of the range, so patches come and go unseen.
 * Further out, the green spaces are the flat colour they always were.
 */

export interface GrassSource {
  /** Where grass grows at a point: 0 none, 1 on the ground, 2 on a raised fill; null while not known yet. */
  grassAt(lon: number, lat: number): number | null
  /** The ground's height there, from tiles at least this fine; null while none is loaded. */
  groundHeight(lon: number, lat: number, minZoom?: number): number | null
  /** Puts a mesh made in a tile's frame where the scene has that frame. */
  place(mesh: Object3D, frame: Frame): void
}

const COARSE = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches
/** Patches are squares this wide (metres), laid out in each zoom-14 tile's frame. */
const PATCH = 8
/** Blades per square metre, near the camera. */
const DENSITY = COARSE ? 10 : 30
/** Grass reaches this far from the camera (metres), and grows only while the camera is this low. */
const RANGE = COARSE ? 26 : 40
const SHOW_BELOW = 140
/** Time spent growing new patches per frame (ms). */
const BUDGET = 2.5
/** A raised green fill's top over the ground (metres): the street's road height and a kerb. */
const FILL_LIFT = 0.06 + 0.15
/** Blades sit this much into the ground, so none floats where the ground's grid and the fill differ. */
const SINK = 0.04
/** The height map round the camera: this many texels a side over the range and a patch each way (about 20 cm each). */
const HEIGHTS = 512
/** It's rendered again once the camera has moved this far from where it was (metres), or after this long (ms). */
const RECAPTURE_MOVE = 4
const RECAPTURE_AFTER = 1500

interface Patch {
  key: string
  tile: TileId
  frame: Frame
  /** Its blades; none where nothing grows. */
  mesh: InstancedMesh | null
  /** Its middle in the tile's frame (x east, z south). */
  x: number
  z: number
  /** Blades placed; the mesh draws fewer of them further out. */
  blades: number
  /** Some of it wasn't known yet (mask or ground still loading): grown again once it is, from this time on (ms). */
  partial: boolean
  retryAt: number
}

const CAPACITY = Math.ceil(PATCH * PATCH * DENSITY)

/** A tapering blade, a unit high and wide at its root: four segments and a tip. */
function bladeGeometry(): BufferGeometry {
  const segments = 4
  const positions: number[] = []
  for (let s = 0; s < segments; s++) {
    const y = s / segments
    const half = 0.5 * (1 - y * 0.82)
    positions.push(-half, y, 0, half, y, 0)
  }
  positions.push(0, 1, 0)
  const indices: number[] = []
  for (let s = 0; s + 1 < segments; s++) {
    const a = s * 2
    indices.push(a, a + 1, a + 3, a, a + 3, a + 2)
  }
  const last = (segments - 1) * 2
  indices.push(last, last + 1, segments * 2)
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3))
  // Lit from above, like the ground they grow from (see the material).
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(positions.length).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3))
  geometry.setIndex(indices)
  return geometry
}

/** A small, fast generator seeded by a patch's place: the same blades every time it grows. */
function seeded(seed: number): () => number {
  let state = seed | 0
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export class WorldGrass {
  readonly group = new Group()
  private readonly source: GrassSource
  private readonly geometry = bladeGeometry()
  private readonly material: MeshStandardMaterial
  private readonly uniforms = {
    grassTime: { value: 0 },
    /** x, z: the wind's way in the scene; y: its strength (0 to 1). */
    grassWind: { value: new Vector3(0.9, 0.3, -0.2) },
    grassCamera: { value: new Vector3() },
    grassRange: { value: RANGE },
    grassRoot: { value: new Color('#4f6a35') },
    grassTip: { value: new Color('#a7bd78') },
    /** The height map round the camera (see capture): its middle (x, z in the scene), half its width, and 1 once taken. */
    grassHeights: { value: null as unknown as WebGLRenderTarget['texture'] },
    grassHeightsArea: { value: new Vector4(0, 0, 1, 0) },
  }
  private readonly heights = new WebGLRenderTarget(HEIGHTS, HEIGHTS, {
    type: FloatType,
    format: RGBAFormat,
    minFilter: NearestFilter,
    magFilter: NearestFilter,
    depthBuffer: true,
    generateMipmaps: false,
  })
  private readonly above = new OrthographicCamera(-1, 1, 1, -1, 0.1, 1000)
  private readonly heightMaterial = new ShaderMaterial({
    vertexShader: `varying float vHeight;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vHeight = world.y;
  gl_Position = projectionMatrix * viewMatrix * world;
}`,
    fragmentShader: `varying float vHeight;
void main() { gl_FragColor = vec4(vHeight, 0.0, 0.0, 1.0); }`,
  })
  private captured = { x: Infinity, z: Infinity, at: -Infinity }
  private readonly patches = new Map<string, Patch>()
  private readonly pool: InstancedMesh[] = []
  private readonly frames = new Map<string, Frame>()

  constructor(source: GrassSource, clip: Plane[] | null) {
    this.source = source
    this.uniforms.grassHeights.value = this.heights.texture
    this.material = new MeshStandardMaterial({
      color: '#ffffff',
      roughness: 0.92,
      metalness: 0,
      // Blades face the camera (see the shader): only their fronts are ever seen.
      side: FrontSide,
      clippingPlanes: clip,
      clipIntersection: true,
    })
    this.material.customProgramCacheKey = () => 'world-grass'
    this.material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms)
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
uniform float grassTime;
uniform vec3 grassWind;
uniform vec3 grassCamera;
uniform float grassRange;
uniform sampler2D grassHeights;
uniform vec4 grassHeightsArea;
varying float vGrassUp;
varying float vGrassSeed;
float grassHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float grassNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(grassHash(i), grassHash(i + vec2(1.0, 0.0)), u.x), mix(grassHash(i + vec2(0.0, 1.0)), grassHash(i + vec2(1.0, 1.0)), u.x), u.y);
}`,
        )
        .replace(
          '#include <project_vertex>',
          `vec4 grassRoot = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
// The root on the surface really there, from the height map round the camera (where it has one).
if (grassHeightsArea.w > 0.5) {
  vec2 grassUv = vec2(
    (grassRoot.x - grassHeightsArea.x) / (2.0 * grassHeightsArea.z) + 0.5,
    (grassHeightsArea.y - grassRoot.z) / (2.0 * grassHeightsArea.z) + 0.5
  );
  if (grassUv.x > 0.0 && grassUv.x < 1.0 && grassUv.y > 0.0 && grassUv.y < 1.0) {
    vec4 grassSurface = texture2D(grassHeights, grassUv);
    if (grassSurface.a > 0.5) grassRoot.y = grassSurface.r - ${SINK.toFixed(3)};
  }
}
// Shrinking away towards the edge of the range, so patches come and go unseen.
float grassGrow = 1.0 - smoothstep(grassRange * 0.62, grassRange, distance(grassRoot.xz, grassCamera.xz));
float grassWidth = length((modelMatrix * instanceMatrix * vec4(1.0, 0.0, 0.0, 0.0)).xyz);
float grassHeight = length((modelMatrix * instanceMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz) * grassGrow;
float grassSeed = grassHash(grassRoot.xz);
float grassUp = position.y;
// Facing the camera (turned a little each, so they don't all line up).
vec2 grassToCamera = grassCamera.xz - grassRoot.xz;
float grassTurn = (grassSeed - 0.5) * 0.9;
vec2 grassFacing = length(grassToCamera) > 1e-3 ? normalize(grassToCamera) : vec2(0.0, 1.0);
grassFacing = vec2(grassFacing.x * cos(grassTurn) - grassFacing.y * sin(grassTurn), grassFacing.x * sin(grassTurn) + grassFacing.y * cos(grassTurn));
vec3 grassAcross = vec3(grassFacing.y, 0.0, -grassFacing.x);
vec4 grassWorld = vec4(grassRoot.xyz + grassAcross * transformed.x * grassWidth + vec3(0.0, transformed.y * grassHeight, 0.0), 1.0);
// A lean of its own, gusts drifting downwind (a noise field), and a sway.
float grassGust = grassNoise(grassRoot.xz * 0.11 - grassWind.xz * grassTime * 0.8);
float grassLean = 0.06 + 0.14 * grassSeed + grassWind.y * 0.6 * (0.2 + 0.8 * grassGust) + 0.05 * sin(grassTime * (1.8 + grassSeed) + grassSeed * 6.2831);
vec2 grassAway = normalize(grassWind.xz + vec2(1e-4, 0.0));
float grassBend = grassLean * grassUp * grassUp;
grassWorld.xz += grassAway * grassBend * grassHeight;
grassWorld.y -= 0.45 * grassBend * grassBend * grassHeight;
vec4 mvPosition = viewMatrix * grassWorld;
gl_Position = projectionMatrix * mvPosition;
vGrassUp = grassUp;
vGrassSeed = grassSeed;`,
        )
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
uniform vec3 grassRoot;
uniform vec3 grassTip;
varying float vGrassUp;
varying float vGrassSeed;`,
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
diffuseColor.rgb *= mix(grassRoot, grassTip, smoothstep(0.0, 1.0, vGrassUp)) * (0.9 + 0.2 * vGrassSeed);`,
        )
    }
    this.group.name = 'grass'
  }

  /** The wind over the ground (metres per second, east and north): its way and strength. */
  setWind(east: number, north: number): void {
    const speed = Math.hypot(east, north)
    const wind = this.uniforms.grassWind.value
    if (speed < 1e-3) {
      wind.set(1, 0.1, 0)
      return
    }
    // The scene's x is east, its z south.
    wind.set(east / speed, Math.min(Math.max(speed / 12, 0.08), 1), -north / speed)
  }

  /**
   * Grows and lets go of patches round the camera (`camera`: ECEF; `scene`:
   * its place in the scene; `altitude`: over the ground), a few per frame.
   */
  update(camera: Vec3, scene: Vector3, altitude: number, now: number): void {
    this.uniforms.grassTime.value = now / 1000
    this.uniforms.grassCamera.value.copy(scene)
    if (altitude > SHOW_BELOW) {
      if (this.patches.size > 0) for (const key of [...this.patches.keys()]) this.release(key)
      return
    }
    const below = lonLatFromEcef(camera)
    // The zoom-14 tiles the range reaches into.
    const n = 2 ** 14
    const φ = Math.max(-85, Math.min(85, below.lat)) * (Math.PI / 180)
    const fx = ((below.lon + 180) / 360) * n
    const fy = ((1 - Math.log(Math.tan(φ) + 1 / Math.cos(φ)) / Math.PI) / 2) * n
    const tiles: TileId[] = []
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) tiles.push({ z: 14, x: Math.floor(fx) + dx, y: Math.floor(fy) + dy })
    }
    const wanted: { key: string; tile: TileId; frame: Frame; x: number; z: number; distance: number }[] = []
    for (const tile of tiles) {
      const frame = this.frameOf(tile)
      const [e, north] = toFrame(frame, camera)
      const cx = e!
      const cz = -north!
      // Only the tiles the range reaches into; each grows the blades on its own ground (see grow).
      const half = tileWidth(tile) / 2
      if (Math.abs(cx) > half + RANGE + PATCH || Math.abs(cz) > half + RANGE + PATCH) continue
      for (let i = Math.floor((cx - RANGE) / PATCH); i <= Math.floor((cx + RANGE) / PATCH); i++) {
        for (let j = Math.floor((cz - RANGE) / PATCH); j <= Math.floor((cz + RANGE) / PATCH); j++) {
          const x = (i + 0.5) * PATCH
          const z = (j + 0.5) * PATCH
          const distance = Math.hypot(x - cx, z - cz)
          if (distance > RANGE + PATCH * 0.72) continue
          if (Math.abs(x) > half + PATCH || Math.abs(z) > half + PATCH) continue
          wanted.push({ key: `${tileKey(tile)}:${i}:${j}`, tile, frame, x, z, distance })
        }
      }
    }
    const keep = new Set(wanted.map((w) => w.key))
    for (const key of [...this.patches.keys()]) if (!keep.has(key)) this.release(key)

    // Grow the nearest first, within the frame's budget; grow again those that were missing data.
    wanted.sort((a, b) => a.distance - b.distance)
    const until = performance.now() + BUDGET
    for (const w of wanted) {
      const patch = this.patches.get(w.key)
      if (patch && (!patch.partial || now < patch.retryAt)) {
        this.thin(patch, w.distance)
        continue
      }
      if (performance.now() > until) continue
      this.thin(this.grow(w.key, w.tile, w.frame, w.x, w.z, patch, now), w.distance)
    }
  }

  /** Further out, a patch draws fewer of its blades (they're in random order, so any first share is even). */
  private thin(patch: Patch, distance: number): void {
    if (!patch.mesh) return
    const share = distance < RANGE * 0.45 ? 1 : distance < RANGE * 0.75 ? 0.55 : 0.3
    patch.mesh.count = Math.max(0, Math.floor(patch.blades * share))
    patch.mesh.visible = patch.mesh.count > 0
  }

  /** Places a patch's blades: where the mask says grass grows, on the ground or the fill there. */
  private grow(key: string, tile: TileId, frame: Frame, x: number, z: number, existing: Patch | undefined, now: number): Patch {
    // The patch's corners on the globe, and where the ellipsoid lies in the frame there (the frame is flat).
    const corners: { lon: number; lat: number; up: number }[] = []
    for (const [dx, dz] of [
      [-0.5, -0.5],
      [0.5, -0.5],
      [-0.5, 0.5],
      [0.5, 0.5],
    ] as const) {
      const place = lonLatFromEcef(fromFrame(frame, [x + dx * PATCH, -(z + dz * PATCH), 0]))
      corners.push({ lon: place.lon, lat: place.lat, up: toFrame(frame, ecefFromLonLat(place.lon, place.lat, 0))[2]! })
    }
    const at = (s: number, t: number, pick: (c: { lon: number; lat: number; up: number }) => number) => {
      const [a, b, c, d] = corners.map(pick) as [number, number, number, number]
      return (a * (1 - s) + b * s) * (1 - t) + (c * (1 - s) + d * s) * t
    }
    const mesh = existing?.mesh ?? this.pool.pop() ?? this.newMesh()
    const retryAt = now + 1000
    const matrices = mesh.instanceMatrix.array as Float32Array
    const random = seeded((tile.x * 73856093) ^ (tile.y * 19349663) ^ (Math.round(x) * 83492791) ^ (Math.round(z) * 2654435761))
    const n = 2 ** tile.z
    let blades = 0
    let partial = false
    let low = Infinity
    let high = -Infinity
    for (let k = 0; k < CAPACITY; k++) {
      const s = random()
      const t = random()
      const angle = random() * Math.PI * 2
      const height = 0.14 + random() * 0.2
      const width = 0.035 + random() * 0.03
      const lon = at(s, t, (c) => c.lon)
      const lat = at(s, t, (c) => c.lat)
      // A blade belongs to the tile its root is on: the neighbour grows the rest.
      if (Math.floor(((lon + 180) / 360) * n) !== tile.x) continue
      const φ = (lat * Math.PI) / 180
      if (Math.floor(((1 - Math.log(Math.tan(φ) + 1 / Math.cos(φ)) / Math.PI) / 2) * n) !== tile.y) continue
      const grass = this.source.grassAt(lon, lat)
      if (grass === null) {
        partial = true
        continue
      }
      if (grass === 0) continue
      const ground = this.source.groundHeight(lon, lat, 15)
      if (ground === null) {
        partial = true
        continue
      }
      const y = at(s, t, (c) => c.up) + ground + (grass === 2 ? FILL_LIFT : 0) - SINK
      low = Math.min(low, y)
      high = Math.max(high, y)
      // Turned about the up axis, a blade's width and height: columns of the instance's matrix.
      const cos = Math.cos(angle)
      const sin = Math.sin(angle)
      const o = blades * 16
      matrices[o] = cos * width
      matrices[o + 1] = 0
      matrices[o + 2] = -sin * width
      matrices[o + 3] = 0
      matrices[o + 4] = 0
      matrices[o + 5] = height
      matrices[o + 6] = 0
      matrices[o + 7] = 0
      matrices[o + 8] = sin
      matrices[o + 9] = 0
      matrices[o + 10] = cos
      matrices[o + 11] = 0
      matrices[o + 12] = x + (s - 0.5) * PATCH
      matrices[o + 13] = y
      matrices[o + 14] = z + (t - 0.5) * PATCH
      matrices[o + 15] = 1
      blades++
    }
    mesh.instanceMatrix.clearUpdateRanges()
    mesh.instanceMatrix.addUpdateRange(0, blades * 16)
    mesh.instanceMatrix.needsUpdate = true
    mesh.count = blades
    mesh.boundingSphere = new Sphere(new Vector3(x, Number.isFinite(low) ? (low + high) / 2 : 0, z), PATCH * 0.75 + (Number.isFinite(low) ? high - low : 0) + 1)
    if (blades === 0) {
      // Nothing grows here (yet): it holds no mesh.
      if (mesh.parent === this.group) this.group.remove(mesh)
      mesh.visible = false
      mesh.count = 0
      this.pool.push(mesh)
      const empty: Patch = { key, tile, frame, mesh: null, x, z, blades: 0, partial, retryAt }
      this.patches.set(key, empty)
      return empty
    }
    if (mesh.parent !== this.group) this.group.add(mesh)
    this.source.place(mesh, frame)
    const patch: Patch = { key, tile, frame, mesh, x, z, blades, partial, retryAt }
    this.patches.set(key, patch)
    return patch
  }

  private newMesh(): InstancedMesh {
    const mesh = new InstancedMesh(this.geometry, this.material, CAPACITY)
    mesh.matrixAutoUpdate = false
    mesh.receiveShadow = true
    mesh.castShadow = false
    mesh.raycast = () => {}
    mesh.count = 0
    return mesh
  }

  private release(key: string): void {
    const patch = this.patches.get(key)
    if (!patch) return
    this.patches.delete(key)
    if (!patch.mesh) return
    this.group.remove(patch.mesh)
    patch.mesh.visible = false
    this.pool.push(patch.mesh)
  }

  private frameOf(tile: TileId): Frame {
    const key = tileKey(tile)
    let frame = this.frames.get(key)
    if (!frame) {
      frame = tileFrame(tile)
      if (this.frames.size > 64) this.frames.clear()
      this.frames.set(key, frame)
    }
    return frame
  }

  /**
   * Renders the height map round the camera: the scene seen from straight
   * above, each texel the height of the highest surface there (`hide`: what
   * isn't ground — buildings — and the grass itself, left out). Again once
   * the camera has moved a few metres, or now and then for tiles that came
   * in since.
   */
  capture(renderer: WebGLRenderer, scene: Scene, camera: Vector3, hide: readonly Object3D[], now: number): void {
    if (this.patches.size === 0) return
    const moved = Math.hypot(camera.x - this.captured.x, camera.z - this.captured.z)
    if (moved < RECAPTURE_MOVE && now - this.captured.at < RECAPTURE_AFTER) return
    const half = RANGE + PATCH
    const above = this.above
    above.left = -half
    above.right = half
    above.top = half
    above.bottom = -half
    above.near = 1
    above.far = 2000
    // North (the scene's -z) up the picture, so its u runs east and its v north.
    above.position.set(camera.x, camera.y + 1000, camera.z)
    above.up.set(0, 0, -1)
    above.lookAt(camera.x, camera.y, camera.z)
    above.updateProjectionMatrix()
    above.updateMatrixWorld()

    const shown: [Object3D, boolean][] = hide.map((o) => [o, o.visible])
    for (const o of hide) o.visible = false
    const override = scene.overrideMaterial
    const target = renderer.getRenderTarget()
    const autoShadows = renderer.shadowMap.autoUpdate
    const planes = renderer.clippingPlanes
    const clear = renderer.getClearColor(new Color())
    const alpha = renderer.getClearAlpha()
    scene.overrideMaterial = this.heightMaterial
    renderer.shadowMap.autoUpdate = false
    renderer.clippingPlanes = []
    renderer.setRenderTarget(this.heights)
    renderer.setClearColor(0x000000, 0)
    renderer.clear()
    renderer.render(scene, above)
    renderer.setRenderTarget(target)
    renderer.setClearColor(clear, alpha)
    renderer.clippingPlanes = planes
    renderer.shadowMap.autoUpdate = autoShadows
    scene.overrideMaterial = override
    for (const [o, visible] of shown) o.visible = visible

    this.uniforms.grassHeightsArea.value.set(camera.x, camera.z, half, 1)
    this.captured = { x: camera.x, z: camera.z, at: now }
  }

  /** Puts every patch where the scene has its frame (after the scene's anchor moved). */
  replace(): void {
    for (const patch of this.patches.values()) if (patch.mesh) this.source.place(patch.mesh, patch.frame)
  }

  dispose(): void {
    this.heights.dispose()
    this.heightMaterial.dispose()
    for (const patch of this.patches.values()) patch.mesh?.dispose()
    for (const mesh of this.pool) mesh.dispose()
    this.geometry.dispose()
    this.material.dispose()
  }
}
