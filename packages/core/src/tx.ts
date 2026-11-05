import type * as Y from 'yjs'
import {
  DEFAULT_META,
  type Building,
  type Id,
  type Level,
  type Meta,
  type Opening,
  type AreaStandard,
  type GeoOrigin,
  type Parcel,
  type RoomTag,
  type SpotHeight,
  type Street,
  type StreetNode,
  type Wall,
  type WallNode,
} from './model.ts'

export interface DocumentMaps {
  meta: Y.Map<unknown>
  buildings: Y.Map<Building>
  levels: Y.Map<Level>
  nodes: Y.Map<WallNode>
  walls: Y.Map<Wall>
  openings: Y.Map<Opening>
  streetNodes: Y.Map<StreetNode>
  streets: Y.Map<Street>
  roomTags: Y.Map<RoomTag>
  parcels: Y.Map<Parcel>
  spotHeights: Y.Map<SpotHeight>
}

/**
 * Typed read/write access to the document inside a transaction.
 * Reads see the transaction's own writes. Records are replaced whole,
 * never mutated.
 */
export class Tx {
  readonly maps: DocumentMaps

  constructor(maps: DocumentMaps) {
    this.maps = maps
  }

  // Meta

  get meta(): Meta {
    return readMeta(this.maps.meta)
  }

  setMeta(patch: Partial<Omit<Meta, 'schemaVersion'>>): void {
    for (const [key, value] of Object.entries(patch)) this.maps.meta.set(key, value)
  }

  // Buildings

  building(id: Id): Building | undefined {
    return this.maps.buildings.get(id)
  }

  buildings(): Building[] {
    return [...this.maps.buildings.values()]
  }

  putBuilding(building: Building): Building {
    this.maps.buildings.set(building.id, building)
    return building
  }

  deleteBuilding(id: Id): void {
    this.maps.buildings.delete(id)
  }

  // Levels

  level(id: Id): Level | undefined {
    return this.maps.levels.get(id)
  }

  /** All levels, or those of one building. */
  levels(buildingId?: Id): Level[] {
    const all = [...this.maps.levels.values()]
    return buildingId === undefined ? all : all.filter((l) => l.buildingId === buildingId)
  }

  putLevel(level: Level): Level {
    this.maps.levels.set(level.id, level)
    return level
  }

  deleteLevel(id: Id): void {
    this.maps.levels.delete(id)
  }

  // Nodes

  node(id: Id): WallNode | undefined {
    return this.maps.nodes.get(id)
  }

  requireNode(id: Id): WallNode {
    const node = this.maps.nodes.get(id)
    if (!node) throw new Error(`Node ${id} does not exist`)
    return node
  }

  nodes(levelId?: Id): WallNode[] {
    const all = [...this.maps.nodes.values()]
    return levelId === undefined ? all : all.filter((n) => n.levelId === levelId)
  }

  putNode(node: WallNode): WallNode {
    this.maps.nodes.set(node.id, node)
    return node
  }

  deleteNode(id: Id): void {
    this.maps.nodes.delete(id)
  }

  // Walls

  wall(id: Id): Wall | undefined {
    return this.maps.walls.get(id)
  }

  requireWall(id: Id): Wall {
    const wall = this.maps.walls.get(id)
    if (!wall) throw new Error(`Wall ${id} does not exist`)
    return wall
  }

  walls(levelId?: Id): Wall[] {
    const all = [...this.maps.walls.values()]
    return levelId === undefined ? all : all.filter((w) => w.levelId === levelId)
  }

  wallsAtNode(nodeId: Id): Wall[] {
    const result: Wall[] = []
    for (const wall of this.maps.walls.values()) {
      if (wall.a === nodeId || wall.b === nodeId) result.push(wall)
    }
    return result
  }

  putWall(wall: Wall): Wall {
    this.maps.walls.set(wall.id, wall)
    return wall
  }

  deleteWall(id: Id): void {
    this.maps.walls.delete(id)
  }

  // Openings

  opening(id: Id): Opening | undefined {
    return this.maps.openings.get(id)
  }

  openings(): Opening[] {
    return [...this.maps.openings.values()]
  }

  openingsOnWall(wallId: Id): Opening[] {
    const result: Opening[] = []
    for (const opening of this.maps.openings.values()) {
      if (opening.wallId === wallId) result.push(opening)
    }
    return result
  }

  putOpening(opening: Opening): Opening {
    this.maps.openings.set(opening.id, opening)
    return opening
  }

  deleteOpening(id: Id): void {
    this.maps.openings.delete(id)
  }

  // Streets

  streetNode(id: Id): StreetNode | undefined {
    return this.maps.streetNodes.get(id)
  }

  requireStreetNode(id: Id): StreetNode {
    const node = this.maps.streetNodes.get(id)
    if (!node) throw new Error(`Street node ${id} does not exist`)
    return node
  }

  streetNodes(): StreetNode[] {
    return [...this.maps.streetNodes.values()]
  }

  putStreetNode(node: StreetNode): StreetNode {
    this.maps.streetNodes.set(node.id, node)
    return node
  }

  deleteStreetNode(id: Id): void {
    this.maps.streetNodes.delete(id)
  }

  street(id: Id): Street | undefined {
    return this.maps.streets.get(id)
  }

  requireStreet(id: Id): Street {
    const street = this.maps.streets.get(id)
    if (!street) throw new Error(`Street ${id} does not exist`)
    return street
  }

  streets(): Street[] {
    return [...this.maps.streets.values()]
  }

  streetsAtNode(nodeId: Id): Street[] {
    const result: Street[] = []
    for (const street of this.maps.streets.values()) {
      if (street.a === nodeId || street.b === nodeId) result.push(street)
    }
    return result
  }

  putStreet(street: Street): Street {
    this.maps.streets.set(street.id, street)
    return street
  }

  deleteStreet(id: Id): void {
    this.maps.streets.delete(id)
  }

  // Room tags

  roomTag(id: Id): RoomTag | undefined {
    return this.maps.roomTags.get(id)
  }

  roomTags(levelId?: Id): RoomTag[] {
    const all = [...this.maps.roomTags.values()]
    return levelId === undefined ? all : all.filter((t) => t.levelId === levelId)
  }

  putRoomTag(tag: RoomTag): RoomTag {
    this.maps.roomTags.set(tag.id, tag)
    return tag
  }

  deleteRoomTag(id: Id): void {
    this.maps.roomTags.delete(id)
  }

  // Parcels

  parcel(id: Id): Parcel | undefined {
    return this.maps.parcels.get(id)
  }

  parcels(): Parcel[] {
    return [...this.maps.parcels.values()]
  }

  putParcel(parcel: Parcel): Parcel {
    this.maps.parcels.set(parcel.id, parcel)
    return parcel
  }

  deleteParcel(id: Id): void {
    this.maps.parcels.delete(id)
  }

  // Spot heights

  spotHeight(id: Id): SpotHeight | undefined {
    return this.maps.spotHeights.get(id)
  }

  spotHeights(): SpotHeight[] {
    return [...this.maps.spotHeights.values()]
  }

  putSpotHeight(spot: SpotHeight): SpotHeight {
    this.maps.spotHeights.set(spot.id, spot)
    return spot
  }

  deleteSpotHeight(id: Id): void {
    this.maps.spotHeights.delete(id)
  }
}

export function isGeoOrigin(v: unknown): v is GeoOrigin {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  const finite = (n: unknown) => typeof n === 'number' && Number.isFinite(n)
  return (o.kind === 'lonlat' && finite(o.lon) && finite(o.lat)) || (o.kind === 'projected' && finite(o.x) && finite(o.y))
}

export function readMeta(map: Y.Map<unknown>): Meta {
  const name = map.get('name')
  const positive = (key: 'wallThickness' | 'slabThickness'): number => {
    const value = map.get(key)
    return typeof value === 'number' && value > 0 ? value : DEFAULT_META[key]
  }
  const standard = map.get('areaStandard')
  const origin = map.get('origin')
  const ground = map.get('ground')
  return {
    schemaVersion: 3,
    name: typeof name === 'string' ? name : DEFAULT_META.name,
    wallThickness: positive('wallThickness'),
    slabThickness: positive('slabThickness'),
    areaStandard: standard === 'sia416' || standard === 'din277' ? (standard as AreaStandard) : DEFAULT_META.areaStandard,
    ...(isGeoOrigin(origin) ? { origin } : {}),
    ...(typeof ground === 'number' && Number.isFinite(ground) ? { ground } : {}),
  }
}
