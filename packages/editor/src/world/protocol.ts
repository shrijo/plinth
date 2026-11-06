import type { BuildingColours, GroundStyle, MeshBuffers, StreetColours, TileId } from '@plinth/world'

/** Messages between the tile renderer and its workers. */

/** Where the world gives way to a site's own model: a polygon in metres east and north of a point. */
export interface WorldMask {
  lon: number
  lat: number
  points: [number, number][]
}

export type WorkerRequest =
  | { id: number; type: 'ground'; tile: TileId; size: number; segments: number; style: GroundStyle }
  | { id: number; type: 'buildings'; tile: TileId; colours: BuildingColours; mask: WorldMask | null }
  | { id: number; type: 'streets'; tile: TileId; colours: StreetColours; mask: WorldMask | null }
  | { id: number; type: 'area'; mask: WorldMask; size: number; style: GroundStyle }
  | { id: number; type: 'cancel' }

export interface GroundResult {
  mesh: MeshBuffers & { uvs: Float32Array; morph?: Float32Array }
  low: number
  high: number
  /** The ground's heights on the tile's grid (see GroundMesh.heights), for answering questions without the GPU. */
  heights: Float32Array
  image: ImageBitmap
  /** Lakes, rivers and sea in the tile, at their surface; `level` is their average height. */
  water: (MeshBuffers & { level: number }) | null
}

export type WorkerResponse =
  | { id: number; ok: true; type: 'ground'; result: GroundResult }
  | { id: number; ok: true; type: 'buildings'; result: MeshBuffers | null }
  | { id: number; ok: true; type: 'streets'; result: MeshBuffers | null }
  | { id: number; ok: true; type: 'area'; result: ImageBitmap }
  | { id: number; ok: false; error: string; aborted: boolean }
