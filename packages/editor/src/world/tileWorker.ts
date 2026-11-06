/// <reference lib="webworker" />
import {
  ancestorAt,
  buildingMesh,
  enuFrame,
  fetchFeatures,
  fetchHeights,
  groundMesh,
  heightSampler,
  insideRing,
  lonLatToFrame,
  Lru,
  paintAreas,
  paintGround,
  tilesCovering,
  frameToLonLat,
  tileKey,
  TERRAIN_MAX_ZOOM,
  VECTOR_MAX_ZOOM,
  type HeightTile,
  type TileFeatures,
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

/** Ground squares per tile side: more on tiles near the ground, where hills show. */
const segmentsFor = (tile: TileId, wanted: number) => (tile.z < 4 ? 48 : tile.z < 10 ? 24 : wanted)

async function ground(request: Extract<WorkerRequest, { type: 'ground' }>, signal: AbortSignal): Promise<WorkerResponse> {
  const [data, height] = await Promise.all([
    featuresOf(request.tile, signal),
    heightsOf(request.tile, signal),
  ])
  const mesh = groundMesh(request.tile, heightSampler(height), segmentsFor(request.tile, request.segments))
  const canvas = new OffscreenCanvas(request.size, request.size)
  const context = canvas.getContext('2d')!
  paintGround(context, request.size, request.tile, data, request.style)
  const image = canvas.transferToImageBitmap()
  return {
    id: request.id,
    ok: true,
    type: 'ground',
    result: { mesh: { positions: mesh.positions, normals: mesh.normals, indices: mesh.indices, uvs: mesh.uvs }, low: mesh.low, high: mesh.high, image },
  }
}

async function buildings(request: Extract<WorkerRequest, { type: 'buildings' }>, signal: AbortSignal): Promise<WorkerResponse> {
  const [data, height] = await Promise.all([featuresOf(request.tile, signal), heightsOf(ancestorAt(request.tile, 14), signal)])
  if (!data || data.buildings.length === 0) return { id: request.id, ok: true, type: 'buildings', result: null }
  const keep = request.mask ? masking(request.mask) : undefined
  const result = buildingMesh(request.tile, data.buildings, heightSampler(height), request.colours, { keep })
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
  if (response.type === 'ground') {
    const { mesh, image } = response.result
    return [mesh.positions.buffer, mesh.normals.buffer, mesh.indices.buffer, mesh.uvs.buffer, image] as Transferable[]
  }
  const mesh = response.result
  if (!mesh) return []
  return [mesh.positions.buffer, mesh.normals.buffer, mesh.indices.buffer, ...(mesh.colors ? [mesh.colors.buffer] : [])] as Transferable[]
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
          : await buildings(request, controller.signal)
  } catch (error) {
    response = { id: request.id, ok: false, error: String(error), aborted: controller.signal.aborted }
  }
  jobs.delete(request.id)
  self.postMessage(response, transfers(response))
}
