/// <reference lib="webworker" />
import {
  ancestorAt,
  buildingMesh,
  enuFrame,
  fetchFeatures,
  fetchHeights,
  groundMesh,
  makeGround,
  streetMesh,
  waterMesh,
  insideRing,
  lonLatToFrame,
  Lru,
  paintAreas,
  paintGround,
  tilesCovering,
  tileBounds,
  frameToLonLat,
  tileKey,
  TERRAIN_MAX_ZOOM,
  VECTOR_MAX_ZOOM,
  type CoarseHeights,
  type Ground,
  type HeightTile,
  type TileFeatures,
  tileWidth,
  type TileId,
} from '@plinth/world'
import type { WorkerRequest, WorkerResponse, WorldMask } from './protocol.ts'

/**
 * Builds the world's tiles off the main thread: fetches map data and
 * heights (each tile once, kept for its neighbours and children), paints
 * the ground's picture and makes the meshes, and hands them back without
 * copying.
 */

declare const self: DedicatedWorkerGlobalScope

const features = new Lru<Promise<TileFeatures | null>>(48)
const heights = new Lru<Promise<HeightTile | null>>(96)
const jobs = new Map<number, AbortController>()

function featuresOf(tile: TileId, signal: AbortSignal): Promise<TileFeatures | null> {
  const source = ancestorAt(tile, VECTOR_MAX_ZOOM)
  const key = tileKey(source)
  let hit = features.get(key)
  if (!hit) {
    // Not tied to this job: a cancelled job leaves the download to whoever wants the tile next.
    hit = fetchFeatures(source).catch((error: unknown) => {
      features.delete(key)
      throw error
    })
    features.set(key, hit)
  }
  return abortable(hit, signal)
}

function heightsOf(tile: TileId, signal: AbortSignal): Promise<HeightTile | null> {
  const source = ancestorAt(tile, TERRAIN_MAX_ZOOM)
  const key = tileKey(source)
  let hit = heights.get(key)
  if (!hit) {
    hit = fetchHeights(source).catch((error: unknown) => {
      heights.delete(key)
      throw error
    })
    heights.set(key, hit)
  }
  return abortable(hit, signal)
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'))
  return new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
    promise.then(resolve, reject)
  })
}

/**
 * Ground squares per tile side. The same from one level to the next (from zoom 10 on, where the ground is
 * near), so every other point of a tile is one of its parent's and it can slide into its parent's shape (see
 * GroundMesh.morph).
 */
const segmentsFor = (tile: TileId, wanted: number) => (tile.z < 4 ? 48 : tile.z < 10 ? 24 : wanted)

/** Water gets a surface of its own from this zoom; further out it's painted. */
const WATER_ZOOM = 10
/**
 * The ground is shaped (street beds, fine elevation) from this zoom on.
 * Low enough that the shaped levels cover every view where streets and
 * buildings are visible: a tile and its parent then describe the same
 * surface, and the slide between them (GroundMesh.morph) moves nothing
 * that shows. Below it, tiles are far enough away that beds (under a
 * metre) are smaller than a pixel.
 */
const SHAPE_ZOOM = 12
/** From this zoom the ground's features come from the finest map data, so parent and child share them exactly. */
const ROAD_ZOOM = 14

/**
 * The heights for a tile: its own, or from zoom 14 on the finest there are,
 * reaching a little past its edges (the smoothing does), so the ground is
 * the same function on both sides of every seam.
 */
async function heightsFor(tile: TileId, signal: AbortSignal): Promise<HeightTile[]> {
  if (tile.z < SHAPE_ZOOM) return [await heightsOf(tile, signal)].filter((h): h is HeightTile => h !== null)
  // Fine elevation: two zooms deeper than the tile (up to the data's finest), so a tile and its parent read
  // almost the same heights and the slide between them moves nothing that shows.
  const zoom = Math.min(TERRAIN_MAX_ZOOM, tile.z + 2)
  const b = tileBounds(tile)
  const margin = 70 / 111320
  const wide = margin / Math.max(Math.cos((((b.north + b.south) / 2) * Math.PI) / 180), 0.05)
  // The tile itself first: most points are on it.
  const own = ancestorAt(tile, zoom)
  const around = tilesCovering({ west: b.west - wide, east: b.east + wide, south: b.south - margin, north: b.north + margin }, zoom)
  const tiles = tile.z >= zoom ? [own, ...around.filter((t) => tileKey(t) !== tileKey(own))] : around
  return (await Promise.all(tiles.map((t) => heightsOf(t, signal)))).filter((h): h is HeightTile => h !== null)
}

/** The ground a tile is built on: shaped for streets and water close up. */
function groundFor(tile: TileId, heights: HeightTile[], data: TileFeatures | null): Ground {
  return makeGround(heights, tile.z >= WATER_ZOOM ? data : null, { roads: tile.z >= SHAPE_ZOOM })
}

/**
 * The parent tile's surface, for a tile to slide into from afar: from zoom 15 on the parent's ground is the
 * same function as the tile's (the same heights and map data); nearer the top it's built from its own.
 */
async function parentSurface(tile: TileId, signal: AbortSignal): Promise<CoarseHeights | undefined> {
  if (tile.z === 0 || tile.z === 10 || tile.z === 4) return undefined
  const parent = { z: tile.z - 1, x: Math.floor(tile.x / 2), y: Math.floor(tile.y / 2) }
  if (parent.z >= ROAD_ZOOM) return 'same'
  const [data, heights] = await Promise.all([featuresOf(parent, signal), heightsFor(parent, signal)])
  const shaped = groundFor(parent, heights, data)
  return (lon, lat) => shaped.at(lon, lat)
}

async function ground(request: Extract<WorkerRequest, { type: 'ground' }>, signal: AbortSignal): Promise<WorkerResponse> {
  const [data, heights, coarse] = await Promise.all([
    featuresOf(request.tile, signal),
    heightsFor(request.tile, signal),
    parentSurface(request.tile, signal),
  ])
  const shaped = groundFor(request.tile, heights, data)
  const water = request.tile.z >= WATER_ZOOM ? waterMesh(request.tile, shaped) : null
  const mesh = groundMesh(request.tile, (lon, lat) => shaped.at(lon, lat), segmentsFor(request.tile, request.segments), coarse)
  const canvas = new OffscreenCanvas(request.size, request.size)
  const context = canvas.getContext('2d')!
  paintGround(context, request.size, request.tile, data, request.style)
  const image = canvas.transferToImageBitmap()
  return {
    id: request.id,
    ok: true,
    type: 'ground',
    result: {
      mesh: { positions: mesh.positions, normals: mesh.normals, indices: mesh.indices, uvs: mesh.uvs, ...(mesh.morph ? { morph: mesh.morph } : {}) },
      low: mesh.low,
      high: mesh.high,
      heights: mesh.heights,
      image,
      water,
    },
  }
}

async function buildings(request: Extract<WorkerRequest, { type: 'buildings' }>, signal: AbortSignal): Promise<WorkerResponse> {
  const [data, heights] = await Promise.all([featuresOf(request.tile, signal), heightsFor(request.tile, signal)])
  if (!data || (data.buildings.length === 0 && !data.roads.some((r) => r.bridge))) return { id: request.id, ok: true, type: 'buildings', result: null }
  const shaped = groundFor(request.tile, heights, data)
  const keep = request.mask ? masking(request.mask) : undefined
  const result = buildingMesh(request.tile, data.buildings, (lon, lat) => shaped.at(lon, lat), request.colours, { keep, roads: data.roads })
  return { id: request.id, ok: true, type: 'buildings', result }
}

/**
 * The water and green in a site's area, on a square canvas over its
 * bounding box (north up), for laying over the site's own terrain.
 */
async function area(request: Extract<WorkerRequest, { type: 'area' }>, signal: AbortSignal): Promise<WorkerResponse> {
  const { mask, size } = request
  const xs = mask.points.map((p) => p[0])
  const ys = mask.points.map((p) => p[1])
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
  const frame = enuFrame(mask.lon, mask.lat, 0)
  const sw = frameToLonLat(frame, x0, y0)
  const ne = frameToLonLat(frame, x1, y1)
  const tiles = tilesCovering({ west: sw.lon, south: sw.lat, east: ne.lon, north: ne.lat }, VECTOR_MAX_ZOOM)
  const data = (await Promise.all(tiles.map((t) => featuresOf(t, signal)))).filter((t): t is TileFeatures => t !== null)
  const canvas = new OffscreenCanvas(size, size)
  const context = canvas.getContext('2d')!
  // Site metres to pixels, north up.
  const px = (e: number) => ((e - x0) / (x1 - x0)) * size
  const py = (n: number) => ((y1 - n) / (y1 - y0)) * size
  paintAreas(
    context,
    data,
    (tile) => {
      // Each tile's units to pixels, through its corners in site metres (straight enough at a site's size).
      const n = 2 ** tile.z
      const at = (u: number, v: number) => {
        const lon = ((tile.x + u) / n) * 360 - 180
        const y = Math.PI * (1 - (2 * (tile.y + v)) / n)
        const lat = (Math.atan(Math.sinh(y)) * 180) / Math.PI
        const [e, north] = lonLatToFrame(frame, lon, lat, 0)
        return [px(e), py(north)] as const
      }
      const o = at(0, 0)
      const ex = at(1, 0)
      const ey = at(0, 1)
      return [ex[0] - o[0], ex[1] - o[1], ey[0] - o[0], ey[1] - o[1], o[0], o[1]]
    },
    request.style,
  )
  return { id: request.id, ok: true, type: 'area', result: canvas.transferToImageBitmap() }
}

/** The streets of a tile in 3D, on its ground's street beds. */
async function streets(request: Extract<WorkerRequest, { type: 'streets' }>, signal: AbortSignal): Promise<WorkerResponse> {
  const [data, heights] = await Promise.all([featuresOf(request.tile, signal), heightsFor(request.tile, signal)])
  const squares = data?.areas.filter((a) => a.kind === 'square').map((a) => a.shape) ?? []
  const GREEN = new Set(['park', 'grass', 'wood', 'sport', 'cemetery', 'wetland'])
  const greens = data?.areas.filter((a) => GREEN.has(a.kind)).map((a) => a.shape) ?? []
  if (!data || (data.roads.length === 0 && squares.length === 0)) return { id: request.id, ok: true, type: 'streets', result: { mesh: null, cover: null } }
  const shaped = groundFor(request.tile, heights, data)
  // A site's own streets stand in its area: the world's are left out there.
  const mask = request.mask
  const corners = mask
    ? mask.points.map(([e, n]) => {
        const p = frameToLonLat(enuFrame(mask.lon, mask.lat, 0), e, n)
        return { lon: p.lon, lat: p.lat }
      })
    : undefined
  const built = streetMesh(request.tile, data.roads, shaped, request.colours, corners, squares, greens)
  return { id: request.id, ok: true, type: 'streets', result: { mesh: built.mesh, cover: coverMask(request.tile, built.cover) } }
}

/**
 * The covered region as a picture over the tile (white where streets,
 * paving or fills stand), for the ground not to draw itself there. Its
 * border is pulled in a few metres (the picture is coarse: the ground
 * keeps a strip under the edges, hidden beneath them).
 */
function coverMask(tile: TileId, cover: readonly (readonly [number, number][][])[]): ImageBitmap | null {
  if (cover.length === 0) return null
  const SIZE = 1024
  const metres = tileWidth(tile)
  const scale = SIZE / metres
  const canvas = new OffscreenCanvas(SIZE, SIZE)
  const context = canvas.getContext('2d')!
  context.fillStyle = '#fff'
  context.strokeStyle = '#fff'
  const path = new Path2D()
  for (const polygon of cover) {
    for (const ring of polygon) {
      ring.forEach(([x, y], i) => {
        if (i === 0) path.moveTo(x * scale, -y * scale)
        else path.lineTo(x * scale, -y * scale)
      })
      path.closePath()
    }
  }
  // Nonzero: cover polygons may overlap (streets overlap their junctions a little), and holes wind the
  // other way round, so they still come out.
  context.fill(path)
  // Pull the border in: strokes take the edge away on both sides of every outline.
  context.globalCompositeOperation = 'destination-out'
  context.lineWidth = 2 * 4 * scale
  context.stroke(path)
  return canvas.transferToImageBitmap()
}

/** Keeps buildings outside the mask. */
function masking(mask: WorldMask): (lon: number, lat: number) => boolean {
  const frame = enuFrame(mask.lon, mask.lat, 0)
  const ring = Float64Array.from(mask.points.flat())
  return (lon, lat) => {
    const [e, n] = lonLatToFrame(frame, lon, lat, 0)
    return !insideRing(ring, e, n)
  }
}

function transfers(response: WorkerResponse): Transferable[] {
  if (!response.ok) return []
  if (response.type === 'area') return [response.result]
  const buffers = (mesh: { positions: Float32Array; normals: Float32Array; indices: Uint32Array; colors?: Float32Array; edges?: Float32Array } | null) =>
    mesh ? [mesh.positions.buffer, mesh.normals.buffer, mesh.indices.buffer, ...(mesh.colors ? [mesh.colors.buffer] : []), ...(mesh.edges ? [mesh.edges.buffer] : [])] : []
  if (response.type === 'ground') {
    const { mesh, image, water, heights } = response.result
    return [...buffers(mesh), mesh.uvs.buffer, ...(mesh.morph ? [mesh.morph.buffer] : []), heights.buffer, image, ...buffers(water)] as Transferable[]
  }
  if (response.type === 'streets') return [...buffers(response.result.mesh), ...(response.result.cover ? [response.result.cover] : [])] as Transferable[]
  return buffers(response.result) as Transferable[]
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data
  if (request.type === 'cancel') {
    jobs.get(request.id)?.abort()
    jobs.delete(request.id)
    return
  }
  const controller = new AbortController()
  jobs.set(request.id, controller)
  let response: WorkerResponse
  try {
    response =
      request.type === 'ground'
        ? await ground(request, controller.signal)
        : request.type === 'area'
          ? await area(request, controller.signal)
          : request.type === 'streets'
            ? await streets(request, controller.signal)
            : await buildings(request, controller.signal)
  } catch (error) {
    response = { id: request.id, ok: false, error: String(error), aborted: controller.signal.aborted }
  }
  jobs.delete(request.id)
  self.postMessage(response, transfers(response))
}
