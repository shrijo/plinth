import { VectorTile, classifyRings } from '@mapbox/vector-tile'
import Pbf from 'pbf'
import type { TileId } from './tiles.ts'

/**
 * What a map tile holds, by what it means for a model of the place:
 * buildings with their heights, roads and railways, water, and areas of
 * land cover and use. Read from vector tiles in the OpenMapTiles scheme
 * (as OpenFreeMap serves them). Coordinates are in the tile's own units:
 * 0 to 1 across it, x eastwards and y southwards; tiles carry a little of
 * their neighbours beyond those bounds, for drawing across the seams.
 */

/** x and y interleaved. */
export type Line = Float64Array

/** A polygon: its outer ring and any holes (rings don't repeat their first point). */
export interface Shape {
  outer: Line
  holes: Line[]
}

export interface BuildingFeature {
  shape: Shape
  /** Height of the top above the ground, in metres. */
  height: number
  /** Height of the bottom above the ground (a part on top of another, or over a passage). */
  minHeight: number
}

export type RoadKind =
  | 'motorway'
  | 'trunk'
  | 'primary'
  | 'secondary'
  | 'tertiary'
  | 'minor'
  | 'service'
  | 'track'
  | 'path'
  | 'rail'
  | 'pier'

export interface RoadFeature {
  line: Line
  kind: RoadKind
  /** Width in metres, from its class (the tiles have none of their own). */
  width: number
  tunnel: boolean
  bridge: boolean
  /** Stacking order where roads cross: bridges higher, tunnels lower. */
  layer: number
  name: string
  /** Traffic one way only. */
  oneway: boolean
  /** For service roads: what kind (driveway, parking aisle, alley...), or ''. */
  service: string
}

export type AreaKind =
  | 'water'
  | 'park'
  | 'grass'
  | 'wood'
  | 'farmland'
  | 'residential'
  | 'commercial'
  | 'industrial'
  | 'sport'
  | 'cemetery'
  | 'ice'
  | 'sand'
  | 'rock'
  | 'wetland'
  | 'airport'
  | 'runway'

export interface AreaFeature {
  shape: Shape
  kind: AreaKind
}

export interface WaterwayFeature {
  line: Line
  width: number
}

export interface TileFeatures {
  tile: TileId
  buildings: BuildingFeature[]
  roads: RoadFeature[]
  areas: AreaFeature[]
  waterways: WaterwayFeature[]
}

/** Widths by road class, in metres: a whole road (both directions of a motorway together). */
export const ROAD_WIDTHS: Record<RoadKind, number> = {
  motorway: 24,
  trunk: 18,
  primary: 14,
  secondary: 12,
  tertiary: 10,
  minor: 8,
  service: 5,
  track: 3.5,
  path: 2,
  rail: 4,
  pier: 5,
}

const ROAD_CLASSES: Record<string, RoadKind> = {
  motorway: 'motorway',
  trunk: 'trunk',
  primary: 'primary',
  secondary: 'secondary',
  tertiary: 'tertiary',
  minor: 'minor',
  busway: 'minor',
  raceway: 'minor',
  service: 'service',
  track: 'track',
  path: 'path',
  rail: 'rail',
  transit: 'rail',
  pier: 'pier',
}

const LANDCOVER: Record<string, AreaKind> = {
  wood: 'wood',
  grass: 'grass',
  farmland: 'farmland',
  ice: 'ice',
  sand: 'sand',
  rock: 'rock',
  wetland: 'wetland',
}

const LANDUSE: Record<string, AreaKind> = {
  residential: 'residential',
  suburb: 'residential',
  neighbourhood: 'residential',
  quarter: 'residential',
  commercial: 'commercial',
  retail: 'commercial',
  school: 'commercial',
  university: 'commercial',
  college: 'commercial',
  hospital: 'commercial',
  library: 'commercial',
  kindergarten: 'commercial',
  industrial: 'industrial',
  garages: 'industrial',
  railway: 'industrial',
  dam: 'industrial',
  military: 'industrial',
  stadium: 'sport',
  pitch: 'sport',
  track: 'sport',
  playground: 'park',
  theme_park: 'park',
  zoo: 'park',
  cemetery: 'cemetery',
}

const WATERWAY_WIDTHS: Record<string, number> = { river: 18, canal: 12, stream: 3, drain: 2, ditch: 1.5 }

/** Buildings without a height of their own are about this tall (the tiles' default is 5 m). */
const DEFAULT_HEIGHT = 5

/** Reads a vector tile. */
export function readTile(tile: TileId, bytes: Uint8Array | ArrayBuffer): TileFeatures {
  const data = new VectorTile(new Pbf(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)))
  const features: TileFeatures = { tile, buildings: [], roads: [], areas: [], waterways: [] }

  forEach(data, 'water', (feature, extent) => {
    if (feature.type !== 3) return
    for (const shape of shapesOf(feature.loadGeometry(), extent)) features.areas.push({ shape, kind: 'water' })
  })
  forEach(data, 'landcover', (feature, extent) => {
    const kind = LANDCOVER[String(feature.properties.class)]
    if (feature.type !== 3 || !kind) return
    for (const shape of shapesOf(feature.loadGeometry(), extent)) features.areas.push({ shape, kind })
  })
  forEach(data, 'landuse', (feature, extent) => {
    const kind = LANDUSE[String(feature.properties.class)]
    if (feature.type !== 3 || !kind) return
    for (const shape of shapesOf(feature.loadGeometry(), extent)) features.areas.push({ shape, kind })
  })
  forEach(data, 'park', (feature, extent) => {
    if (feature.type !== 3) return
    for (const shape of shapesOf(feature.loadGeometry(), extent)) features.areas.push({ shape, kind: 'park' })
  })
  forEach(data, 'aeroway', (feature, extent) => {
    const cls = String(feature.properties.class)
    if (feature.type === 3) {
      const kind: AreaKind = cls === 'aerodrome' ? 'airport' : 'runway'
      for (const shape of shapesOf(feature.loadGeometry(), extent)) features.areas.push({ shape, kind })
    } else if (feature.type === 2 && (cls === 'runway' || cls === 'taxiway')) {
      for (const line of linesOf(feature.loadGeometry(), extent)) {
        features.roads.push({ line, kind: 'motorway', width: cls === 'runway' ? 45 : 18, tunnel: false, bridge: false, layer: -1, name: '', oneway: false, service: 'runway' })
      }
    }
  })
  forEach(data, 'waterway', (feature, extent) => {
    if (feature.type !== 2 || feature.properties.brunnel === 'tunnel') return
    const width = WATERWAY_WIDTHS[String(feature.properties.class)] ?? 2
    for (const line of linesOf(feature.loadGeometry(), extent)) features.waterways.push({ line, width })
  })
  forEach(data, 'transportation', (feature, extent) => {
    const p = feature.properties
    const kind = ROAD_CLASSES[String(p.class)]
    if (!kind) return
    if (feature.type === 3) {
      // Squares and piers mapped as areas.
      for (const shape of shapesOf(feature.loadGeometry(), extent)) features.areas.push({ shape, kind: 'commercial' })
      return
    }
    if (feature.type !== 2) return
    const brunnel = String(p.brunnel ?? '')
    const layer = Number(p.layer ?? 0) || 0
    const name = typeof p.name === 'string' ? p.name : ''
    for (const line of linesOf(feature.loadGeometry(), extent)) {
      features.roads.push({
        line,
        kind,
        width: ROAD_WIDTHS[kind] * (p.ramp === 1 ? 0.6 : 1),
        tunnel: brunnel === 'tunnel',
        bridge: brunnel === 'bridge',
        layer: brunnel === 'bridge' ? Math.max(layer, 1) : brunnel === 'tunnel' ? Math.min(layer, -1) : layer,
        name,
        oneway: p.oneway === 1 || p.oneway === -1,
        service: typeof p.service === 'string' ? p.service : '',
      })
    }
  })
  forEach(data, 'transportation_name', () => {})
  forEach(data, 'building', (feature, extent) => {
    const p = feature.properties
    if (feature.type !== 3 || p.hide_3d === true) return
    const height = Number(p.render_height ?? DEFAULT_HEIGHT) || DEFAULT_HEIGHT
    const minHeight = Number(p.render_min_height ?? 0) || 0
    if (height <= minHeight) return
    for (const shape of shapesOf(feature.loadGeometry(), extent)) features.buildings.push({ shape, height, minHeight })
  })
  return features
}

type Feature = ReturnType<VectorTile['layers'][string]['feature']>

function forEach(data: VectorTile, name: string, fn: (feature: Feature, extent: number) => void): void {
  const layer = data.layers[name]
  if (!layer) return
  for (let i = 0; i < layer.length; i++) fn(layer.feature(i), layer.extent)
}

type Points = { x: number; y: number }[]

function toLine(points: Points, extent: number, closed: boolean): Line | null {
  let n = points.length
  // Rings repeat their first point at the end.
  if (closed && n > 1 && points[0]!.x === points[n - 1]!.x && points[0]!.y === points[n - 1]!.y) n--
  if (n < (closed ? 3 : 2)) return null
  const line = new Float64Array(n * 2)
  for (let i = 0; i < n; i++) {
    line[i * 2] = points[i]!.x / extent
    line[i * 2 + 1] = points[i]!.y / extent
  }
  return line
}

function shapesOf(rings: ReturnType<Feature['loadGeometry']>, extent: number): Shape[] {
  const shapes: Shape[] = []
  for (const polygon of classifyRings(rings)) {
    const [outer, ...holes] = polygon
    const outerLine = outer && toLine(outer, extent, true)
    if (!outerLine) continue
    shapes.push({ outer: outerLine, holes: holes.map((h) => toLine(h, extent, true)).filter((h): h is Line => !!h) })
  }
  return shapes
}

function linesOf(lines: Points[], extent: number): Line[] {
  return lines.map((l) => toLine(l, extent, false)).filter((l): l is Line => !!l)
}

/** Signed area of a ring in tile units (positive: clockwise on the map, as y runs south). */
export function ringArea(ring: Line): number {
  let sum = 0
  const n = ring.length / 2
  for (let i = 0, j = n - 1; i < n; j = i++) sum += ring[j * 2]! * ring[i * 2 + 1]! - ring[i * 2]! * ring[j * 2 + 1]!
  return sum / 2
}
