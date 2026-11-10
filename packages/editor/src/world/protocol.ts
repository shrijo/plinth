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
  | {
      id: number
      ok: true
      type: 'buildings'
      /** The buildings (and bridges other than street bridges), and the street bridges as they stand in from afar. */
      result: { mesh: MeshBuffers | null; bridges: MeshBuffers | null } | null
    }
  | {
      id: number
      ok: true
      type: 'streets'
      result: {
        mesh: MeshBuffers | null
        /**
         * What lies over the tile's ground, two bytes a pixel (GRASS_MASK square, rows from the north): how
         * much our own surfaces cover it (streets, paving and block fills: the ground leaves itself out
         * there), and 255 where grass grows (the ground and the green fills turn green under the blades).
         */
        cover: Uint8Array | null
        /** Where grass grows, a byte per pixel over the tile (GRASS_MASK square): 0 none, 1 on the ground, 2 on a raised green fill. */
        grass: Uint8Array | null
      }
    }
  | { id: number; ok: true; type: 'area'; result: ImageBitmap }
  | { id: number; ok: false; error: string; aborted: boolean }

/** The size of the masks over a zoom-14 tile (grass and cover: pixels a side, about 1.6 m each). */
export const GRASS_MASK = 1024
