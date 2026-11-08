import {
  BufferAttribute,
  BufferGeometry,
  Color,
  FloatType,
  FrontSide,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
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
import { GRASS_MASK } from './protocol.ts'

/**
 * Grass on the green spaces round the camera, the way games grow it (after
 * grass-shader-glsl's approach): instanced blades in square patches, each
 * blade a tapering strip bent by a vertex shader — a lean of its own, a
 * sway, and gusts drifting downwind as a noise field — and shaded from a
 * darker root to a pale tip. Blades grow only where the world's grass mask
 * says (lawns, and the raised green block fills), each one's root set on
 * whatever surface is really there — ground, fill or bed — read off a
 * height map of the ground round the camera, rendered from above now and
 * then (the way games blend grass into terrain). Blades turn their faces
 * to the camera, so none shows a dark back.
 *
 * Close in, every blade grows; further out, a share of them as the square
 * of the distance falls (each blade has a rank, and those ranked past the
 * share shrink away), each drawn the wider for it — so the screen holds as
 * much green with ever fewer blades, out to the edge of the range, where
 * the last ones shrink away. Under them, the ground and the green fills
 * turn grass-green (the carpet), so the gaps between blades read as more
 * grass, not as the pale map; it fades out with the blades.
 */

export interface GrassSource {
  /**
   * Where grass grows over a zoom-14 tile (GRASS_MASK square, rows from the
   * north): 0 none, 1 on the ground, 2 on a raised green fill. Null where
   * nothing grows there; undefined while it isn't known yet.
   */
  grassMask(tile: TileId): Uint8Array | null | undefined
  /** The ground's height there, from tiles at least this fine; null while none is loaded. */
  groundHeight(lon: number, lat: number, minZoom?: number): number | null
  /** Puts a mesh made in a tile's frame where the scene has that frame. */
  place(mesh: Object3D, frame: Frame): void
}

const COARSE = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches
/** Patches are squares this wide (metres), laid out in each zoom-14 tile's frame. */
const PATCH = 16
/** Blades per square metre close to the camera. */
const DENSITY = COARSE ? 22 : 56
/** Out to here from the camera (metres) every blade grows; beyond, a share of them as (NEAR / distance)². */
const NEAR = COARSE ? 8 : 12
/** Grass reaches this far from the camera (metres, as the crow flies: so it thins out as the camera rises too). */
const RANGE = COARSE ? 45 : 80
/** The last blades shrink away from this share of the range on. */
const SHRINK_FROM = 0.72
/**
 * The carpet lies fully out to here from the camera (metres), and is gone by there: close in, the ground
 * shows between the blades; further out, seen low, they hide it themselves. Seen from higher up, it would
 * show as a green disc round the camera: it fades as the camera rises through these heights (metres).
 */
const CARPET_FULL = NEAR * 1.25
const CARPET_GONE = RANGE * 0.56
const CARPET_HEIGHTS = [10, 34] as const
/** Patches further than this (metres) draw their blades as single triangles: a few pixels tall, they need no curve. */
const SIMPLE_BEYOND = COARSE ? 18 : 28
/** Time spent growing new blades per frame (ms). */
const BUDGET = 2.5
/** A raised green fill's top over the ground (metres): the street's road height and a kerb. */
const FILL_LIFT = 0.06 + 0.15
/** Blades sit this much into the ground, so none floats where the ground's grid and the fill differ. */
const SINK = 0.04
/**
 * A blade's root goes onto the surface the height map holds when that's within this much of where it was
 * planted (metres): more than a planting between the points read under a patch can be out by, less than a
 * bridge's clearance.
 */
const SNAP_WITHIN = 2.5
/** The height map round the camera: this many texels a side over the range and a patch each way (about 20 cm each). */
const HEIGHTS = COARSE ? 512 : 1024
/** It's rendered again once the camera has moved this far from where it was (metres), or after this long (ms). */
const RECAPTURE_MOVE = 6
const RECAPTURE_AFTER = 1500
/** A patch's candidate blades at full density; each blade's rank is its candidate's number over this. */
const CAPACITY = Math.ceil(PATCH * PATCH * DENSITY)
/** A patch keeps its blades in buffers of these sizes (the smallest that fits), handed on from patch to patch. */
const TIERS: number[] = []
for (let size = 256; TIERS[TIERS.length - 1] === undefined || TIERS[TIERS.length - 1]! < CAPACITY; size *= 4) TIERS.push(size)
/** The share of the blades that grows at a distance from the camera (the shader's rule too). */
const shareAt = (distance: number) => Math.min(1, (NEAR * NEAR) / Math.max(distance * distance, 1e-6))

/** The ground under a patch is read at this many points a side (corners included); blades' roots are set between them. */
const GROUND_POINTS = 5

/** A point under a patch: where it is on the zoom-14 grid, and the ground's height there in the patch's (flat) frame. */
interface GroundPoint {
  fx: number
  fy: number
  level: number
}

/** Buffers for a patch's blades, and the mesh drawing them. */
interface Blades {
  mesh: Mesh
  geometry: InstancedBufferGeometry
  /** x, y, z of each root in the patch's frame, and the blade's rank (0 to 1). */
  roots: InstancedBufferAttribute
  /** Each blade's height and width (metres). */
  shapes: InstancedBufferAttribute
  size: number
  simple: boolean
}

interface Patch {
  key: string
  tile: TileId
  frame: Frame
  /** Its middle in the tile's frame (x east, z south). */
  x: number
  z: number
  /** The ground under it, GROUND_POINTS a side, row by row from the north-west (as the blades' s and t run); null until known. */
  ground: GroundPoint[] | null
  /** The tile's grass mask; null where nothing grows in the tile, undefined while it isn't known yet. */
  mask: Uint8Array | null | undefined
  /** Its blades; none while nothing grows (yet). */
  blades: Blades | null
  count: number
  /** Candidates drawn so far (each blade's rank is its candidate's number over CAPACITY), and the generator's state after them. */
  tried: number
  state: number
  /** The lowest and highest roots. */
  low: number
  high: number
  /** Waiting on data (the mask, the ground's heights): looked at again from then (ms). */
  retryAt: number
}

/** A tapering blade, a unit high and wide at its root: four segments and a tip; or a single triangle. */
function bladeGeometry(segments: number): BufferGeometry {
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

/** The next number from a patch's generator (mulberry32), seeded by its place: the same blades every time it grows. */
function next(patch: Patch): number {
  patch.state = (patch.state + 0x6d2b79f5) | 0
  let t = Math.imul(patch.state ^ (patch.state >>> 15), 1 | patch.state)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

export class WorldGrass {
  readonly group = new Group()
  /**
   * The carpet under the blades, for the ground's and the fills' shaders (see WorldTiles): its colour, and
   * x: out to where it lies fully, y: where it's gone (metres from the camera), z: how strongly (0 to 1).
   */
  readonly carpet = {
    carpetColour: { value: new Color('#728d4c') },
    carpetReach: { value: new Vector3(CARPET_FULL, CARPET_GONE, 0) },
  }
  private readonly source: GrassSource
  private readonly curved = bladeGeometry(4)
  private readonly simple = bladeGeometry(1)
  private readonly material: MeshStandardMaterial
  private readonly uniforms = {
    grassTime: { value: 0 },
    /** x, z: the wind's way in the scene; y: its strength (0 to 1). */
    grassWind: { value: new Vector3(0.9, 0.3, -0.2) },
    grassCamera: { value: new Vector3() },
    /** x: every blade grows out to here; y: the last start to shrink away here; z: and are gone here (metres). */
    grassReach: { value: new Vector3(NEAR, RANGE * SHRINK_FROM, RANGE) },
    grassBase: { value: new Color('#4c6a33') },
    grassTip: { value: new Color('#a9c078') },
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
  /** Blades no patch holds, by size, to be handed on. */
  private readonly pool = new Map<number, Blades[]>()
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
attribute vec4 bladeRoot;
attribute vec2 bladeShape;
uniform float grassTime;
uniform vec3 grassWind;
uniform vec3 grassCamera;
uniform vec3 grassReach;
uniform sampler2D grassHeights;
uniform vec4 grassHeightsArea;
varying float vGrassUp;
varying float vGrassSeed;
varying float vGrassShade;
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
          `vec4 grassRoot = modelMatrix * vec4(bladeRoot.xyz, 1.0);
// The root on the surface really there, from the height map round the camera (where it has one): the
// surface it was planted on, not a bridge deck high over it (the map holds the highest surface).
if (grassHeightsArea.w > 0.5) {
  vec2 grassUv = vec2(
    (grassRoot.x - grassHeightsArea.x) / (2.0 * grassHeightsArea.z) + 0.5,
    (grassHeightsArea.y - grassRoot.z) / (2.0 * grassHeightsArea.z) + 0.5
  );
  if (grassUv.x > 0.0 && grassUv.x < 1.0 && grassUv.y > 0.0 && grassUv.y < 1.0) {
    vec4 grassSurface = texture2D(grassHeights, grassUv);
    if (grassSurface.a > 0.5 && abs(grassSurface.r - grassRoot.y) < ${SNAP_WITHIN.toFixed(1)}) grassRoot.y = grassSurface.r - ${SINK.toFixed(3)};
  }
}
// Further out, a share of the blades as (near / distance)², each the wider for it; those ranked past the
// share shrink away (so none pops), and the last ones towards the edge of the range.
float grassDistance = distance(grassRoot.xyz, grassCamera);
float grassShare = min(1.0, grassReach.x * grassReach.x / max(grassDistance * grassDistance, 1e-4));
float grassGrow = clamp((grassShare - bladeRoot.w) / (0.3 * grassShare), 0.0, 1.0) * (1.0 - smoothstep(grassReach.y, grassReach.z, grassDistance));
float grassHeight = bladeShape.x * grassGrow;
float grassWidth = bladeShape.y * min(inversesqrt(grassShare), 5.0) * mix(0.5, 1.0, grassGrow);
float grassSeed = grassHash(mod(bladeRoot.xz, 256.0));
float grassUp = position.y;
// Facing the camera (turned a little each, so they don't all line up).
vec2 grassToCamera = grassCamera.xz - grassRoot.xz;
float grassTurn = (grassSeed - 0.5) * 0.9;
vec2 grassFacing = length(grassToCamera) > 1e-3 ? normalize(grassToCamera) : vec2(0.0, 1.0);
grassFacing = vec2(grassFacing.x * cos(grassTurn) - grassFacing.y * sin(grassTurn), grassFacing.x * sin(grassTurn) + grassFacing.y * cos(grassTurn));
vec3 grassAcross = vec3(grassFacing.y, 0.0, -grassFacing.x);
vec4 grassWorld = vec4(grassRoot.xyz + grassAcross * position.x * grassWidth + vec3(0.0, grassUp * grassHeight, 0.0), 1.0);
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
vGrassSeed = grassSeed;
// Lighter and darker drifts across a lawn.
vGrassShade = 0.84 + 0.32 * grassNoise(bladeRoot.xz * 0.08);`,
        )
        // Shadows and the like are looked up where the blade really is, not at its frame's origin.
        .replace(
          '#include <worldpos_vertex>',
          `#if defined( USE_ENVMAP ) || defined( DISTANCE ) || defined ( USE_SHADOWMAP ) || defined ( USE_TRANSMISSION ) || NUM_SPOT_LIGHT_COORDS > 0
  vec4 worldPosition = grassWorld;
#endif`,
        )
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
uniform vec3 grassBase;
uniform vec3 grassTip;
varying float vGrassUp;
varying float vGrassSeed;
varying float vGrassShade;`,
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
diffuseColor.rgb *= mix(grassBase, grassTip, smoothstep(0.0, 1.0, vGrassUp)) * (0.9 + 0.2 * vGrassSeed) * vGrassShade;`,
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
    // The carpet lies only while the camera is low (see CARPET_HEIGHTS).
    this.carpet.carpetReach.value.z = 0.92 * (1 - smoothstep(CARPET_HEIGHTS[0], CARPET_HEIGHTS[1], altitude))
    if (altitude > RANGE) {
      if (this.patches.size > 0) for (const key of [...this.patches.keys()]) this.release(key)
      return
    }
    // How far the range reaches over the ground, the camera being this high.
    const reach = Math.sqrt(Math.max(RANGE * RANGE - altitude * altitude, 0))
    const below = lonLatFromEcef(camera)
    // The zoom-14 tiles the range reaches into.
    const n = 2 ** 14
    const φ = Math.max(-85, Math.min(85, below.lat)) * (Math.PI / 180)
    const fx = ((below.lon + 180) / 360) * n
    const fy = ((1 - Math.log(Math.tan(φ) + 1 / Math.cos(φ)) / Math.PI) / 2) * n
    const wanted: { key: string; tile: TileId; frame: Frame; x: number; z: number; distance: number }[] = []
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const tile: TileId = { z: 14, x: Math.floor(fx) + dx, y: Math.floor(fy) + dy }
        const frame = this.frameOf(tile)
        const [e, north] = toFrame(frame, camera)
        const cx = e!
        const cz = -north!
        // Only the tiles the range reaches into; each grows the blades on its own ground (see grow).
        const half = tileWidth(tile) / 2
        if (Math.abs(cx) > half + reach + PATCH || Math.abs(cz) > half + reach + PATCH) continue
        for (let i = Math.floor((cx - reach) / PATCH); i <= Math.floor((cx + reach) / PATCH); i++) {
          for (let j = Math.floor((cz - reach) / PATCH); j <= Math.floor((cz + reach) / PATCH); j++) {
            const x = (i + 0.5) * PATCH
            const z = (j + 0.5) * PATCH
            if (Math.abs(x) > half + PATCH || Math.abs(z) > half + PATCH) continue
            // From the camera to the patch's nearest point.
            const across = Math.hypot(Math.max(Math.abs(x - cx) - PATCH / 2, 0), Math.max(Math.abs(z - cz) - PATCH / 2, 0))
            if (across > reach) continue
            wanted.push({ key: `${tileKey(tile)}:${i}:${j}`, tile, frame, x, z, distance: Math.hypot(across, altitude) })
          }
        }
      }
    }
    const keep = new Set(wanted.map((w) => w.key))
    for (const key of [...this.patches.keys()]) if (!keep.has(key)) this.release(key)

    // Grow the nearest first, within the frame's budget, as many blades as their nearest point wants.
    wanted.sort((a, b) => a.distance - b.distance)
    const until = performance.now() + BUDGET
    for (const w of wanted) {
      let patch = this.patches.get(w.key)
      if (!patch) {
        patch = {
          key: w.key,
          tile: w.tile,
          frame: w.frame,
          x: w.x,
          z: w.z,
          ground: null,
          mask: undefined,
          blades: null,
          count: 0,
          tried: 0,
          state: (w.tile.x * 73856093) ^ (w.tile.y * 19349663) ^ (Math.round(w.x) * 83492791) ^ (Math.round(w.z) * 2654435761),
          low: Infinity,
          high: -Infinity,
          retryAt: 0,
        }
        this.patches.set(w.key, patch)
      }
      const share = shareAt(w.distance)
      if (performance.now() < until) this.grow(patch, Math.min(CAPACITY, Math.ceil(CAPACITY * share)), now, until)
      this.show(patch, share, w.distance)
    }
  }

  /** Draws the blades of a patch ranked within the share its nearest point wants: none further on would grow. */
  private show(patch: Patch, share: number, distance: number): void {
    const blades = patch.blades
    if (!blades) return
    const ranks = blades.roots.array as Float32Array
    let lo = 0
    let hi = patch.count
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (ranks[mid * 4 + 3]! < share) lo = mid + 1
      else hi = mid
    }
    blades.geometry.instanceCount = lo
    blades.mesh.visible = lo > 0
    // Far enough out, single triangles.
    const simple = distance > SIMPLE_BEYOND
    if (simple !== blades.simple) {
      blades.simple = simple
      const base = simple ? this.simple : this.curved
      blades.geometry.setIndex(base.index)
      blades.geometry.setAttribute('position', base.getAttribute('position'))
      blades.geometry.setAttribute('normal', base.getAttribute('normal'))
    }
  }

  /** Draws candidates for a patch's blades until `want` have been tried: where the mask says grass grows, on the ground or the fill there. */
  private grow(patch: Patch, want: number, now: number, until: number): void {
    if (patch.tried >= want || now < patch.retryAt) return
    if (patch.mask === undefined) patch.mask = this.source.grassMask(patch.tile)
    if (patch.mask === undefined) {
      patch.retryAt = now + 1000
      return
    }
    // Nothing grows anywhere in the tile.
    if (patch.mask === null) {
      patch.tried = CAPACITY
      return
    }
    patch.ground ??= this.groundOf(patch)
    if (!patch.ground) {
      patch.retryAt = now + 1000
      return
    }
    const ground = patch.ground
    const cells = GROUND_POINTS - 1
    const [a, b, c, d] = [ground[0]!, ground[cells]!, ground[cells * GROUND_POINTS]!, ground[GROUND_POINTS * GROUND_POINTS - 1]!]
    const mask = patch.mask
    const { x: tx, y: ty } = patch.tile
    const from = patch.count
    let room = patch.blades?.size ?? 0
    let roots = patch.blades?.roots.array as Float32Array | undefined
    let shapes = patch.blades?.shapes.array as Float32Array | undefined
    while (patch.tried < want) {
      if ((patch.tried & 63) === 0 && performance.now() > until) break
      const rank = patch.tried / CAPACITY
      patch.tried++
      const s = next(patch)
      const t = next(patch)
      const tall = next(patch)
      const wide = next(patch)
      // On the zoom-14 grid, between the corners (straight enough over a patch).
      const gx = (a.fx * (1 - s) + b.fx * s) * (1 - t) + (c.fx * (1 - s) + d.fx * s) * t
      const gy = (a.fy * (1 - s) + b.fy * s) * (1 - t) + (c.fy * (1 - s) + d.fy * s) * t
      // A blade belongs to the tile its root is on: the neighbour grows the rest.
      if (Math.floor(gx) !== tx || Math.floor(gy) !== ty) continue
      const px = Math.min(GRASS_MASK - 1, Math.floor((gx - tx) * GRASS_MASK))
      const py = Math.min(GRASS_MASK - 1, Math.floor((gy - ty) * GRASS_MASK))
      const grass = mask[py * GRASS_MASK + px]!
      if (grass === 0) continue
      // The ground's height, between the points read round it.
      const u = s * cells
      const v = t * cells
      const i = Math.min(Math.floor(u), cells - 1)
      const j = Math.min(Math.floor(v), cells - 1)
      const fu = u - i
      const fv = v - j
      const k = j * GROUND_POINTS + i
      const level =
        (ground[k]!.level * (1 - fu) + ground[k + 1]!.level * fu) * (1 - fv) +
        (ground[k + GROUND_POINTS]!.level * (1 - fu) + ground[k + GROUND_POINTS + 1]!.level * fu) * fv
      const y = level + (grass === 2 ? FILL_LIFT : 0) - SINK
      if (patch.count >= room) {
        this.enlarge(patch, patch.count + 1)
        room = patch.blades!.size
        roots = patch.blades!.roots.array as Float32Array
        shapes = patch.blades!.shapes.array as Float32Array
      }
      const o = patch.count
      roots![o * 4] = patch.x + (s - 0.5) * PATCH
      roots![o * 4 + 1] = y
      roots![o * 4 + 2] = patch.z + (t - 0.5) * PATCH
      roots![o * 4 + 3] = rank
      shapes![o * 2] = 0.16 + tall * 0.22
      shapes![o * 2 + 1] = 0.045 + wide * 0.035
      patch.count++
      patch.low = Math.min(patch.low, y)
      patch.high = Math.max(patch.high, y)
    }
    const blades = patch.blades
    if (!blades || patch.count === from) return
    // Up to the GPU: what's new, and whatever is still waiting to go up (all of it, for buffers just handed
    // over: see enlarge). Three clears the ranges once it has sent them.
    const waiting = blades.roots.updateRanges[0]
    const start = waiting ? Math.min(waiting.start / 4, from) : from
    blades.roots.clearUpdateRanges()
    blades.shapes.clearUpdateRanges()
    blades.roots.addUpdateRange(start * 4, (patch.count - start) * 4)
    blades.shapes.addUpdateRange(start * 2, (patch.count - start) * 2)
    blades.roots.needsUpdate = true
    blades.shapes.needsUpdate = true
    const sphere = blades.geometry.boundingSphere!
    sphere.center.set(patch.x, (patch.low + patch.high) / 2, patch.z)
    // Roots move onto the surface really there (see the shader), and far blades are drawn wider.
    sphere.radius = PATCH * 0.75 + (patch.high - patch.low) + 2
  }

  /** Moves a patch's blades into buffers with room for `needed`. */
  private enlarge(patch: Patch, needed: number): void {
    const size = TIERS.find((s) => s >= needed) ?? TIERS[TIERS.length - 1]!
    const blades = this.pool.get(size)?.pop() ?? this.newBlades(size)
    const old = patch.blades
    if (old) {
      ;(blades.roots.array as Float32Array).set((old.roots.array as Float32Array).subarray(0, patch.count * 4))
      ;(blades.shapes.array as Float32Array).set((old.shapes.array as Float32Array).subarray(0, patch.count * 2))
      this.giveBack(old)
    }
    // Everything in them is to go up to the GPU (see grow).
    blades.roots.clearUpdateRanges()
    blades.roots.addUpdateRange(0, 0)
    blades.geometry.instanceCount = 0
    patch.blades = blades
    this.group.add(blades.mesh)
    this.source.place(blades.mesh, patch.frame)
  }

  private newBlades(size: number): Blades {
    const geometry = new InstancedBufferGeometry()
    geometry.setIndex(this.curved.index)
    geometry.setAttribute('position', this.curved.getAttribute('position'))
    geometry.setAttribute('normal', this.curved.getAttribute('normal'))
    const roots = new InstancedBufferAttribute(new Float32Array(size * 4), 4)
    const shapes = new InstancedBufferAttribute(new Float32Array(size * 2), 2)
    geometry.setAttribute('bladeRoot', roots)
    geometry.setAttribute('bladeShape', shapes)
    geometry.instanceCount = 0
    geometry.boundingSphere = new Sphere(new Vector3(), 1)
    const mesh = new Mesh(geometry, this.material)
    mesh.matrixAutoUpdate = false
    mesh.receiveShadow = true
    mesh.castShadow = false
    mesh.raycast = () => {}
    mesh.visible = false
    return { mesh, geometry, roots, shapes, size, simple: false }
  }

  private giveBack(blades: Blades): void {
    this.group.remove(blades.mesh)
    blades.mesh.visible = false
    blades.geometry.instanceCount = 0
    const list = this.pool.get(blades.size) ?? []
    list.push(blades)
    this.pool.set(blades.size, list)
  }

  /** The ground under a patch, once its heights there are known (null till then). */
  private groundOf(patch: Patch): GroundPoint[] | null {
    const n = 2 ** patch.tile.z
    const points: GroundPoint[] = []
    for (let j = 0; j < GROUND_POINTS; j++) {
      for (let i = 0; i < GROUND_POINTS; i++) {
        const dx = i / (GROUND_POINTS - 1) - 0.5
        const dz = j / (GROUND_POINTS - 1) - 0.5
        const place = lonLatFromEcef(fromFrame(patch.frame, [patch.x + dx * PATCH, -(patch.z + dz * PATCH), 0]))
        const ground = this.source.groundHeight(place.lon, place.lat, 15)
        if (ground === null) return null
        const φ = Math.max(-85.05, Math.min(85.05, place.lat)) * (Math.PI / 180)
        points.push({
          fx: ((place.lon + 180) / 360) * n,
          fy: ((1 - Math.log(Math.tan(φ) + 1 / Math.cos(φ)) / Math.PI) / 2) * n,
          // The frame is flat: the ellipsoid drops away from it, and the ground stands on the ellipsoid.
          level: toFrame(patch.frame, ecefFromLonLat(place.lon, place.lat, 0))[2]! + ground,
        })
      }
    }
    return points
  }

  private release(key: string): void {
    const patch = this.patches.get(key)
    if (!patch) return
    this.patches.delete(key)
    if (patch.blades) this.giveBack(patch.blades)
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
    for (const patch of this.patches.values()) if (patch.blades) this.source.place(patch.blades.mesh, patch.frame)
    // The height map was taken where the scene was: taken again, and not read till then.
    this.captured = { x: Infinity, z: Infinity, at: -Infinity }
    this.uniforms.grassHeightsArea.value.w = 0
  }

  dispose(): void {
    this.heights.dispose()
    this.heightMaterial.dispose()
    const all = [...[...this.patches.values()].map((p) => p.blades), ...[...this.pool.values()].flat()]
    for (const blades of all) {
      if (!blades) continue
      // The blade shapes are shared: only each patch's own buffers go.
      blades.geometry.deleteAttribute('position')
      blades.geometry.deleteAttribute('normal')
      blades.geometry.setIndex(null)
      blades.geometry.dispose()
    }
    this.curved.dispose()
    this.simple.dispose()
    this.material.dispose()
  }
}

function smoothstep(from: number, to: number, x: number): number {
  const t = Math.min(Math.max((x - from) / (to - from), 0), 1)
  return t * t * (3 - 2 * t)
}
