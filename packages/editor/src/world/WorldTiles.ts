import {
  BufferAttribute,
  BufferGeometry,
  Color,
  LineBasicMaterial,
  LineSegments,
  Frustum,
  Group,
  LinearMipmapLinearFilter,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  SRGBColorSpace,
  Sphere,
  Texture,
  Vector3,
  type Object3D,
  type Plane,
  type WebGLRenderer,
} from 'three'
import {
  ancestorAt,
  ecefFromLonLat,
  enuFrame,
  frameToFrame,
  fromFrame,
  GROUND_STYLE,
  lonLatFromEcef,
  selectTiles,
  tileFrame,
  tileKey,
  toFrame,
  type Frame,
  type GroundStyle,
  type MeshBuffers,
  type StreetColours,
  type TileId,
  type Vec3,
} from '@plinth/world'
import type { GroundResult, WorkerRequest, WorkerResponse, WorldMask } from './protocol.ts'
import { WorldWater } from './water.ts'

/**
 * The real world, streamed in as tiles: the ground draped over its hills
 * with a picture of streets, water and greenery painted on, and buildings
 * standing on it. Tiles come and go with the view (finer up close), built
 * in workers. Everything is placed in the frame of an anchor point (x
 * east, y up, z south from it, in metres), which can move with the view
 * so coordinates near the camera stay small.
 */

export interface Anchor {
  lon: number
  lat: number
  /** The height (above sea level) that y = 0 stands for. */
  height: number
}

export interface WorldTilesOptions {
  anchor: Anchor
  /** Leaves out the buildings inside this area (a site's own model stands there). */
  mask?: WorldMask | null
  /** Ground inside all of these planes isn't drawn (clipIntersection). */
  clip?: Plane[]
  /** Tiles further than this from the camera (metres) are left out. */
  maxDistance?: number
  /** Colours of the walls and roofs. */
  wall?: string
  roof?: string
  style?: GroundStyle
  /** Dark lines along the buildings' edges. */
  outlines?: boolean
}

const COARSE = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches
const TEXTURE_SIZE = COARSE ? 256 : 512
const SEGMENTS = 40
/** Screen pixels a texel may cover before the tile is split. */
const MAX_ERROR = COARSE ? 1.6 : 1.15
const MAX_ZOOM = 17
/** Buildings come with tiles at this zoom (the finest of the map data). */
const BUILDING_ZOOM = 14
const MAX_GROUND = COARSE ? 120 : 300
const MAX_BUILDINGS = COARSE ? 24 : 64
const MAX_STREETS = COARSE ? 4 : 12
/** Streets are built in 3D where the view calls for ground tiles this fine (within a kilometre or two). */
const STREET_ZOOM = 16
const MAX_IN_FLIGHT = 14
/** Time spent adding new tiles to the scene per frame (ms), so arrivals never stall a frame; at least one goes in. */
const ADD_BUDGET = 4
/** A load the view hasn't asked for in this long (ms) gives way to others. */
const CANCEL_AFTER = 1500
/** Tiles this coarse are kept once loaded: they stand in wherever finer ones are still on their way. */
const KEEP_ZOOM = 5
/** The ground under the camera is loaded at this zoom (out of view, behind it), to keep the camera above it. */
const UNDER_ZOOM = 13

type State = 'loading' | 'ready' | 'failed'

interface GroundEntry {
  tile: TileId
  key: string
  state: State
  job: number
  mesh: Mesh | null
  low: number
  high: number
  /** Ground heights on the tile's grid, once loaded. */
  heights: Float32Array | null
  used: number
  /** When the view last asked for it (ms). */
  wanted: number
  retryAt: number
  frame: Frame
}

/** A tile's buildings, or its streets (built for a zoom 14 tile). */
interface BuildingEntry {
  kind: 'buildings' | 'streets'
  tile: TileId
  key: string
  state: State
  job: number
  mesh: Mesh | null
  used: number
  wanted: number
  retryAt: number
  frame: Frame
}

const frustum = new Frustum()
const projection = new Matrix4()
const sphere = new Sphere()
const scratch = new Vector3()
const plane = new Vector3()

export class WorldTiles {
  readonly group = new Group()
  private anchor: Anchor
  private frame: Frame
  private readonly options: WorldTilesOptions
  private readonly ground = new Map<string, GroundEntry>()
  private readonly buildings = new Map<string, BuildingEntry>()
  private readonly streets = new Map<string, BuildingEntry>()
  private readonly streetMaterial: MeshStandardMaterial
  private readonly workers: Worker[] = []
  private readonly pending = new Map<number, { worker: Worker; entry: GroundEntry | BuildingEntry }>()
  private readonly asked = new Map<number, (image: ImageBitmap | null) => void>()
  private readonly arrived: (() => void)[] = []
  private readonly buildingMaterial: MeshStandardMaterial
  private readonly edgeMaterial = new LineBasicMaterial({ color: '#3a3d41' })
  private readonly colours: { wall: [number, number, number]; roof: [number, number, number]; road: [number, number, number] }
  /** Lakes, rivers and the sea, and their reflection. */
  readonly water = new WorldWater()
  private outlines: boolean
  private readonly streetColours: StreetColours
  private readonly caps: { mesh: Mesh; frame: Frame }[] = []
  private nextJob = 1
  private clock = 0
  private drawn: Mesh[] = []
  private disposed = false
  /** Called when tiles arrive or change, for views that draw on demand. */
  onChange: (() => void) | null = null

  constructor(options: WorldTilesOptions) {
    this.options = options
    this.anchor = options.anchor
    this.frame = enuFrame(options.anchor.lon, options.anchor.lat, options.anchor.height)
    this.group.name = 'world'
    this.buildingMaterial = new MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 })
    this.buildingMaterial.userData.shared = true
    // Streets win against the ground they lie on where they're within a hair of it.
    this.streetMaterial = new MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 })
    this.streetMaterial.userData.shared = true
    const linear = (css: string): [number, number, number] => {
      const c = new Color(css)
      return [c.r, c.g, c.b]
    }
    this.colours = { wall: linear(options.wall ?? '#f3f2ef'), roof: linear(options.roof ?? '#e2e0db'), road: linear('#d0cec9') }
    // As the editor's streets (see scene/materials.ts).
    this.streetColours = {
      road: linear('#d0cec9'),
      bike: linear('#c5c3be'),
      parking: linear('#d8d6d1'),
      sidewalk: linear('#eeede8'),
      curb: linear('#dfded9'),
      marking: linear('#fdfdfc'),
    }
    this.outlines = options.outlines ?? false
    // The map stops short of the poles (at 85°): caps close the globe there, sea in the north, ice in the south.
    const style = options.style ?? GROUND_STYLE
    for (const north of [true, false]) {
      const cap = polarCap(north)
      const mesh = new Mesh(geometryOf(cap.mesh, 'uv'), new MeshStandardMaterial({ color: north ? style.areas.water : style.areas.ice, roughness: 1 }))
      mesh.matrixAutoUpdate = false
      mesh.receiveShadow = false
      this.place(mesh, cap.frame)
      this.caps.push({ mesh, frame: cap.frame })
      this.group.add(mesh)
    }
    const count = Math.max(2, Math.min(4, Math.floor((navigator.hardwareConcurrency || 4) / 2)))
    for (let i = 0; i < count; i++) {
      const worker = new Worker(new URL('./tileWorker.ts', import.meta.url), { type: 'module', name: `world-${i}` })
      worker.onmessage = (event: MessageEvent<WorkerResponse>) => this.receive(event.data)
      this.workers.push(worker)
    }
  }

  // Frames and coordinates

  getAnchor(): Anchor {
    return this.anchor
  }

  /** Moves the anchor; everything already placed moves with it, so the world stays where it is. */
  setAnchor(anchor: Anchor): void {
    this.anchor = anchor
    this.frame = enuFrame(anchor.lon, anchor.lat, anchor.height)
    for (const entry of this.ground.values()) if (entry.mesh) this.place(entry.mesh, entry.frame)
    for (const entry of this.buildings.values()) if (entry.mesh) this.place(entry.mesh, entry.frame)
    for (const entry of this.streets.values()) if (entry.mesh) this.place(entry.mesh, entry.frame)
    for (const cap of this.caps) this.place(cap.mesh, cap.frame)
  }

  /** A point on the globe (ECEF) in the scene. */
  toScene(ecef: Vec3, out = new Vector3()): Vector3 {
    const [e, n, u] = toFrame(this.frame, ecef)
    return out.set(e, u, -n)
  }

  /** A point in the scene on the globe (ECEF). */
  toEcef(v: Vector3): Vec3 {
    return fromFrame(this.frame, [v.x, -v.z, v.y])
  }

  /** A direction in ECEF for one in the scene. */
  directionToEcef(v: Vector3): Vec3 {
    const f = this.frame
    const e = v.x
    const n = -v.z
    const u = v.y
    return [f.east[0] * e + f.north[0] * n + f.up[0] * u, f.east[1] * e + f.north[1] * n + f.up[1] * u, f.east[2] * e + f.north[2] * n + f.up[2] * u]
  }

  /** A direction in the scene for one in ECEF. */
  directionToScene(d: Vec3, out = new Vector3()): Vector3 {
    const f = this.frame
    const e = f.east[0] * d[0] + f.east[1] * d[1] + f.east[2] * d[2]
    const n = f.north[0] * d[0] + f.north[1] * d[1] + f.north[2] * d[2]
    const u = f.up[0] * d[0] + f.up[1] * d[1] + f.up[2] * d[2]
    return out.set(e, u, -n)
  }

  private place(mesh: Mesh, from: Frame): void {
    const { rotation: r, translation: t } = frameToFrame(from, this.frame)
    // r maps the tile's east, north, up into the anchor's; both sides in three's axes (x east, y up, z south).
    mesh.matrix.set(
      r[0]!, r[2]!, -r[1]!, t[0],
      r[6]!, r[8]!, -r[7]!, t[2],
      -r[3]!, -r[5]!, r[4]!, -t[1],
      0, 0, 0, 1,
    )
    mesh.matrixWorldNeedsUpdate = true
  }

  // Each frame

  /** Chooses, loads and shows the tiles for the camera's view. `height` is the view's height in CSS pixels. */
  update(camera: PerspectiveCamera, height: number): void {
    if (this.disposed) return
    this.clock++
    camera.updateMatrixWorld()
    projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    frustum.setFromProjectionMatrix(projection)
    const cameraEcef = this.toEcef(camera.getWorldPosition(scratch))
    const pixelsPerMetre = height / (2 * Math.tan((camera.fov * Math.PI) / 360))
    const selection = selectTiles(
      {
        camera: cameraEcef,
        inView: (centre, radius) => {
          this.toScene(centre, sphere.center)
          sphere.radius = radius
          return frustum.intersectsSphere(sphere)
        },
        pixelsPerMetre,
        textureSize: TEXTURE_SIZE,
        maxError: MAX_ERROR,
        maxZoom: MAX_ZOOM,
        maxDistance: this.options.maxDistance,
      },
      {
        isReady: (key) => this.ground.get(key)?.state === 'ready',
        heightRange: (tile) => this.heightRange(tile),
      },
    )

    const now = performance.now()
    this.lastSelection = { want: selection.want.length, draw: selection.draw.length, ideal: selection.ideal.length }

    // Arrivals first, as many as fit in a few milliseconds.
    const until = now + ADD_BUDGET
    do this.arrived.shift()?.()
    while (this.arrived.length > 0 && performance.now() < until)

    // What to show.
    for (const mesh of this.drawn) mesh.visible = false
    this.drawn = []
    for (const tile of selection.draw) {
      const entry = this.ground.get(tileKey(tile))
      if (!entry?.mesh) continue
      entry.used = this.clock
      entry.mesh.visible = true
      this.drawn.push(entry.mesh)
    }
    // Buildings wherever the view calls for that detail, even while the ground there is still coarse.
    const buildingKeys = new Set<string>()
    for (const tile of [...selection.ideal, ...selection.draw]) {
      if (tile.z >= BUILDING_ZOOM) buildingKeys.add(tileKey(ancestorAt(tile, BUILDING_ZOOM)))
    }
    for (const key of buildingKeys) {
      let entry = this.buildings.get(key)
      if (!entry) {
        const [z, x, y] = key.split('/').map(Number) as [number, number, number]
        const tile = { z, x, y }
        entry = { kind: 'buildings', tile, key, state: 'failed', job: 0, mesh: null, used: this.clock, wanted: now, retryAt: 0, frame: tileFrame(tile) }
        this.buildings.set(key, entry)
      }
      entry.used = this.clock
      entry.wanted = now
      if (entry.mesh) {
        entry.mesh.visible = true
        this.drawn.push(entry.mesh)
      }
    }

    // Streets in 3D close by (further out they're in the ground's picture).
    const streetKeys = new Set<string>()
    for (const tile of selection.ideal) if (tile.z >= STREET_ZOOM) streetKeys.add(tileKey(ancestorAt(tile, BUILDING_ZOOM)))
    for (const key of streetKeys) {
      let entry = this.streets.get(key)
      if (!entry) {
        const [z, x, y] = key.split('/').map(Number) as [number, number, number]
        const tile = { z, x, y }
        entry = { kind: 'streets', tile, key, state: 'failed', job: 0, mesh: null, used: this.clock, wanted: now, retryAt: 0, frame: tileFrame(tile) }
        this.streets.set(key, entry)
      }
      entry.used = this.clock
      entry.wanted = now
      if (entry.mesh) {
        entry.mesh.visible = true
        this.drawn.push(entry.mesh)
      }
    }

    // What to load: the ground, the coarsest first, and the ground under the camera (to keep above it); then buildings and streets.
    const under = lonLatFromEcef(cameraEcef)
    const want = [...selection.want]
    if (under.height - this.anchor.height < 30000) {
      const n = 2 ** UNDER_ZOOM
      const lat = Math.max(-85, Math.min(85, under.lat)) * (Math.PI / 180)
      want.push({
        z: UNDER_ZOOM,
        x: Math.floor(((under.lon + 180) / 360) * n),
        y: Math.floor(((1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2) * n),
      })
    }
    for (const tile of want) {
      const key = tileKey(tile)
      let entry = this.ground.get(key)
      if (!entry) {
        entry = { tile, key, state: 'failed', job: 0, mesh: null, low: 0, high: 0, heights: null, used: this.clock, wanted: now, retryAt: 0, frame: tileFrame(tile) }
        this.ground.set(key, entry)
      }
      entry.used = this.clock
      entry.wanted = now
      if (entry.state === 'failed' && this.clock >= entry.retryAt && this.pending.size < MAX_IN_FLIGHT) this.requestGround(entry)
    }
    for (const key of buildingKeys) {
      const entry = this.buildings.get(key)!
      if (entry.state === 'failed' && this.clock >= entry.retryAt && this.pending.size < MAX_IN_FLIGHT) this.requestBuildings(entry)
    }
    for (const key of streetKeys) {
      const entry = this.streets.get(key)!
      if (entry.state === 'failed' && this.clock >= entry.retryAt && this.pending.size < MAX_IN_FLIGHT) this.requestStreets(entry)
    }
    // Loads the view has long moved away from give way (not at once: a turn back shouldn't start them again).
    for (const [job, { worker, entry }] of this.pending) {
      if (now - entry.wanted > CANCEL_AFTER) {
        worker.postMessage({ id: job, type: 'cancel' } satisfies WorkerRequest)
        this.pending.delete(job)
        entry.state = 'failed'
        entry.retryAt = 0
      }
    }
    this.evict(selection.draw)
  }

  /** How many tiles are in each state, and what's drawn: for looking into it while developing. */
  stats(): Record<string, unknown> {
    const count = (map: Map<string, GroundEntry | BuildingEntry>) => {
      const out: Record<string, number> = {}
      for (const e of map.values()) out[e.state] = (out[e.state] ?? 0) + 1
      return out
    }
    return { ground: count(this.ground), buildings: count(this.buildings), pending: this.pending.size, drawn: this.drawn.length, arrived: this.arrived.length, anchor: this.anchor, lastError: this.lastError, selection: this.lastSelection }
  }

  private lastError: string | null = null
  private lastSelection: Record<string, number> = {}

  /** Whether tiles are still on their way. */
  get loading(): boolean {
    return this.pending.size > 0 || this.arrived.length > 0
  }

  private heightRange(tile: TileId): [number, number] {
    for (let z = tile.z; z >= 0; z--) {
      const entry = this.ground.get(tileKey(ancestorAt(tile, z)))
      if (entry?.state === 'ready') return [entry.low - 30, entry.high + (tile.z >= 12 ? 250 : 30)]
    }
    return [-100, 9000]
  }

  private workerFor(tile: TileId): Worker {
    // The same source tile always goes to the same worker, which keeps its data.
    const source = ancestorAt(tile, Math.min(tile.z, BUILDING_ZOOM))
    const hash = (source.x * 73856093) ^ (source.y * 19349663) ^ (source.z * 83492791)
    return this.workers[Math.abs(hash) % this.workers.length]!
  }

  private requestGround(entry: GroundEntry): void {
    const id = this.nextJob++
    entry.state = 'loading'
    entry.job = id
    const worker = this.workerFor(entry.tile)
    this.pending.set(id, { worker, entry })
    worker.postMessage({
      id,
      type: 'ground',
      tile: entry.tile,
      size: TEXTURE_SIZE,
      segments: SEGMENTS,
      style: this.options.style ?? GROUND_STYLE,
    } satisfies WorkerRequest)
  }

  private requestBuildings(entry: BuildingEntry): void {
    const id = this.nextJob++
    entry.state = 'loading'
    entry.job = id
    const worker = this.workerFor(entry.tile)
    this.pending.set(id, { worker, entry })
    worker.postMessage({ id, type: 'buildings', tile: entry.tile, colours: this.colours, mask: this.options.mask ?? null } satisfies WorkerRequest)
  }

  private requestStreets(entry: BuildingEntry): void {
    const id = this.nextJob++
    entry.state = 'loading'
    entry.job = id
    const worker = this.workerFor(entry.tile)
    this.pending.set(id, { worker, entry })
    worker.postMessage({ id, type: 'streets', tile: entry.tile, colours: this.streetColours, mask: this.options.mask ?? null } satisfies WorkerRequest)
  }

  /** A picture of the water and green in the mask's area (north up, over its bounding box), or null if it can't be had. */
  areaImage(size = 1024): Promise<ImageBitmap | null> {
    const mask = this.options.mask
    if (!mask || this.disposed) return Promise.resolve(null)
    const id = this.nextJob++
    return new Promise((resolve) => {
      this.asked.set(id, resolve)
      this.workers[0]!.postMessage({ id, type: 'area', mask, size, style: this.options.style ?? GROUND_STYLE } satisfies WorkerRequest)
    })
  }

  private receive(response: WorkerResponse): void {
    const asked = this.asked.get(response.id)
    if (asked) {
      this.asked.delete(response.id)
      if (response.ok && response.type === 'area' && !this.disposed) asked(response.result)
      else {
        if (response.ok && response.type === 'area') response.result.close()
        asked(null)
      }
      return
    }
    const job = this.pending.get(response.id)
    if (!job) {
      if (response.ok && response.type === 'ground') response.result.image.close()
      return
    }
    if (response.ok && response.type === 'area') return
    this.pending.delete(response.id)
    const entry = job.entry
    if (this.disposed || entry.job !== response.id) return
    if (!response.ok) {
      this.lastError = response.error
      entry.state = 'failed'
      // Try again in a while (frames, about a few seconds).
      entry.retryAt = this.clock + (response.aborted ? 0 : 240)
      return
    }
    this.arrived.push(() => {
      if (this.disposed) return
      if (response.type === 'ground') this.addGround(entry as GroundEntry, response.result)
      else if (response.type === 'streets') this.addStreets(entry as BuildingEntry, response.result)
      else this.addBuildings(entry as BuildingEntry, response.result)
      this.onChange?.()
    })
    this.onChange?.()
  }

  /** Shows or hides the buildings' outlines. */
  setOutlines(on: boolean): void {
    this.outlines = on
    for (const entry of this.buildings.values()) {
      const lines = entry.mesh?.children[0]
      if (lines) lines.visible = on
    }
  }

  /**
   * Draws the reflection in the water near the camera (call each frame,
   * before the scene is drawn): the water closest to the camera sets the
   * mirror's level.
   */
  reflect(renderer: WebGLRenderer, scene: Object3D, camera: PerspectiveCamera): void {
    camera.getWorldPosition(scratch)
    let nearest: Mesh | null = null
    let best = Infinity
    for (const mesh of this.drawn) {
      const water = mesh.children.find((c) => c.userData.water) as Mesh | undefined
      if (!water) continue
      const geometry = water.geometry
      if (!geometry.boundingSphere) geometry.computeBoundingSphere()
      sphere.copy(geometry.boundingSphere!).applyMatrix4(water.matrixWorld)
      const d = Math.max(0, sphere.center.distanceTo(scratch) - sphere.radius)
      if (d < best) {
        best = d
        nearest = water
      }
    }
    // Too far off to see a reflection in: none.
    let level: number | null = null
    if (nearest && best < 6000) {
      const ecef = this.toEcef(scratch)
      const under = lonLatFromEcef(ecef)
      level = this.toScene(ecefFromLonLat(under.lon, under.lat, nearest.userData.level as number), plane).y
    }
    // Waves stay put on the water when the anchor moves: the anchor's place in metres, folded to a few kilometres.
    const offset: [number, number] = [(this.anchor.lon * 111320 * Math.cos((this.anchor.lat * Math.PI) / 180)) % 4096, (-this.anchor.lat * 110540) % 4096]
    this.water.reflect(renderer, scene, camera, level, offset)
  }

  private addGround(entry: GroundEntry, result: GroundResult): void {
    const texture = new Texture(result.image)
    texture.flipY = false
    texture.colorSpace = SRGBColorSpace
    texture.anisotropy = 8
    texture.minFilter = LinearMipmapLinearFilter
    texture.generateMipmaps = true
    texture.needsUpdate = true
    const material = new MeshStandardMaterial({
      map: texture,
      roughness: 1,
      metalness: 0,
      clippingPlanes: this.options.clip ?? null,
      clipIntersection: true,
    })
    const mesh = new Mesh(geometryOf(result.mesh, 'uv'), material)
    mesh.matrixAutoUpdate = false
    mesh.receiveShadow = true
    mesh.visible = false
    mesh.userData.worldGround = true
    if (result.water) {
      const water = new Mesh(geometryOf(result.water, 'none'), this.water.material)
      water.userData.water = true
      water.userData.level = result.water.level
      water.raycast = () => {}
      mesh.add(water)
    }
    this.place(mesh, entry.frame)
    this.group.add(mesh)
    entry.mesh = mesh
    entry.low = result.low
    entry.high = result.high
    entry.heights = result.heights
    entry.state = 'ready'
  }

  private addStreets(entry: BuildingEntry, result: MeshBuffers | null): void {
    entry.state = 'ready'
    if (!result) return
    const mesh = new Mesh(geometryOf(result, 'color'), this.streetMaterial)
    mesh.matrixAutoUpdate = false
    mesh.receiveShadow = true
    mesh.visible = false
    mesh.raycast = () => {}
    this.place(mesh, entry.frame)
    this.group.add(mesh)
    entry.mesh = mesh
  }

  private addBuildings(entry: BuildingEntry, result: MeshBuffers | null): void {
    entry.state = 'ready'
    if (!result) return
    const mesh = new Mesh(geometryOf(result, 'color'), this.buildingMaterial)
    if (result.edges && result.edges.length > 0) {
      const geometry = new BufferGeometry()
      geometry.setAttribute('position', new BufferAttribute(result.edges, 3))
      const lines = new LineSegments(geometry, this.edgeMaterial)
      lines.visible = this.outlines
      lines.raycast = () => {}
      mesh.add(lines)
    }
    mesh.matrixAutoUpdate = false
    mesh.castShadow = true
    mesh.receiveShadow = true
    mesh.visible = false
    this.place(mesh, entry.frame)
    this.group.add(mesh)
    entry.mesh = mesh
  }

  /**
   * Lets go of the least recently used tiles beyond the cache's size, but
   * never what's drawn, the tiles under what's drawn (they stand in when
   * the view moves and finer tiles aren't ready), or the coarsest few.
   */
  private evict(drawn: readonly TileId[]): void {
    const keep = new Set<string>()
    for (const tile of drawn) for (let z = tile.z - 1; z >= 0; z--) keep.add(tileKey(ancestorAt(tile, z)))
    const drop = <E extends GroundEntry | BuildingEntry>(map: Map<string, E>, limit: number) => {
      const loaded = [...map.values()].filter((e) => e.mesh && e.used < this.clock && !keep.has(e.key) && e.tile.z > KEEP_ZOOM)
      if (map.size <= limit && loaded.length <= limit) return
      loaded.sort((a, b) => a.used - b.used)
      for (const entry of loaded.slice(0, Math.max(0, loaded.length - limit))) {
        disposeMesh(entry.mesh!)
        this.group.remove(entry.mesh!)
        map.delete(entry.key)
      }
      // Entries never loaded and long out of view.
      for (const [key, entry] of map) if (!entry.mesh && entry.state !== 'loading' && entry.used < this.clock - 60) map.delete(key)
    }
    drop(this.ground, MAX_GROUND)
    drop(this.buildings, MAX_BUILDINGS)
    drop(this.streets, MAX_STREETS)
  }

  // Questions about what's shown

  /**
   * The height of the ground at a point on the globe (above sea level), from
   * the finest tile loaded there (drawn or not: behind the camera too), read
   * off its grid of heights; null where none is loaded yet. `minZoom` leaves
   * out coarser tiles (their hills are too rough to keep a camera off the
   * ground by). Cheap: no rays, no triangles.
   */
  groundHeight(lon: number, lat: number, minZoom = 0): number | null {
    const φ = Math.max(-85.05, Math.min(85.05, lat)) * (Math.PI / 180)
    const fx = (lon + 180) / 360
    const fy = (1 - Math.log(Math.tan(φ) + 1 / Math.cos(φ)) / Math.PI) / 2
    for (let z = MAX_ZOOM; z >= minZoom; z--) {
      const n = 2 ** z
      const x = Math.floor(fx * n)
      const y = Math.floor(fy * n)
      const entry = this.ground.get(`${z}/${x}/${y}`)
      if (entry?.state !== 'ready' || !entry.heights) continue
      const heights = entry.heights
      const side = Math.round(Math.sqrt(heights.length))
      const segments = side - 1
      const gx = Math.min(Math.max((fx * n - x) * segments, 0), segments - 1e-9)
      const gy = Math.min(Math.max((fy * n - y) * segments, 0), segments - 1e-9)
      const i = Math.floor(gx)
      const j = Math.floor(gy)
      const tx = gx - i
      const ty = gy - j
      const h = (a: number, b: number) => heights[b * side + a]!
      return (h(i, j) * (1 - tx) + h(i + 1, j) * tx) * (1 - ty) + (h(i, j + 1) * (1 - tx) + h(i + 1, j + 1) * tx) * ty
    }
    return null
  }

  dispose(): void {
    this.disposed = true
    for (const worker of this.workers) worker.terminate()
    for (const resolve of this.asked.values()) resolve(null)
    this.asked.clear()
    for (const entry of this.ground.values()) if (entry.mesh) disposeMesh(entry.mesh)
    for (const entry of this.buildings.values()) if (entry.mesh) disposeMesh(entry.mesh)
    for (const entry of this.streets.values()) if (entry.mesh) disposeMesh(entry.mesh)
    this.streetMaterial.dispose()
    this.buildingMaterial.dispose()
    this.edgeMaterial.dispose()
    this.water.dispose()
    for (const cap of this.caps) disposeMesh(cap.mesh)
    this.group.clear()
    this.ground.clear()
    this.buildings.clear()
    this.streets.clear()
  }
}


/** A cap over a pole, from the map's last latitude to the pole, in a frame at the pole. */
function polarCap(north: boolean): { mesh: MeshBuffers; frame: Frame } {
  const frame = enuFrame(0, north ? 90 : -90, 0)
  const rings = 8
  const segments = 96
  const positions: number[] = []
  const normals: number[] = []
  const indices: number[] = []
  const edge = 85.0511287798
  for (let r = 0; r <= rings; r++) {
    const lat = (north ? 1 : -1) * (edge + ((90 - edge) * r) / rings)
    for (let s = 0; s <= segments; s++) {
      const lon = -180 + (360 * s) / segments
      const p = ecefFromLonLat(lon, lat, -50)
      const [e, n, u] = toFrame(frame, p)
      positions.push(e, u, -n)
      const up = enuFrame(lon, lat, 0).up
      const [ne, nn, nu] = [
        frame.east[0] * up[0] + frame.east[1] * up[1] + frame.east[2] * up[2],
        frame.north[0] * up[0] + frame.north[1] * up[1] + frame.north[2] * up[2],
        frame.up[0] * up[0] + frame.up[1] * up[1] + frame.up[2] * up[2],
      ]
      normals.push(ne, nu, -nn)
    }
  }
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < segments; s++) {
      const a = r * (segments + 1) + s
      const b = a + 1
      const c = a + segments + 1
      const d = c + 1
      if (north) indices.push(a, b, c, b, d, c)
      else indices.push(a, c, b, b, c, d)
    }
  }
  return {
    frame,
    mesh: { positions: Float32Array.from(positions), normals: Float32Array.from(normals), indices: Uint32Array.from(indices) },
  }
}

function geometryOf(mesh: MeshBuffers, extra: 'uv' | 'color' | 'none'): BufferGeometry {
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(mesh.positions, 3))
  geometry.setAttribute('normal', new BufferAttribute(mesh.normals, 3))
  if (extra === 'uv' && mesh.uvs) geometry.setAttribute('uv', new BufferAttribute(mesh.uvs, 2))
  if (extra === 'color' && mesh.colors) geometry.setAttribute('color', new BufferAttribute(mesh.colors, 3))
  geometry.setIndex(new BufferAttribute(mesh.indices, 1))
  geometry.computeBoundingSphere()
  return geometry
}

function disposeMesh(mesh: Mesh): void {
  mesh.geometry.dispose()
  for (const child of mesh.children) (child as Mesh).geometry?.dispose()
  const material = mesh.material as MeshStandardMaterial
  if (material.userData.shared) return
  material.map?.dispose()
  material.dispose()
}
