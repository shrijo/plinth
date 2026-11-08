import {
  add,
  addLevel,
  addOpening,
  analyzeSite,
  buildingCentre,
  connectIntersection,
  createBuilding,
  deleteBuilding,
  deleteLevel,
  deleteOpenings,
  deleteStreetNodes,
  deleteStreets,
  deleteWalls,
  detachLevel,
  disconnectNode,
  dist,
  findStacks,
  finishNodeMove,
  insertStreet,
  insertWall,
  isCopy,
  moveNodes,
  normalize,
  parseLength,
  removeNode,
  rotateBuilding,
  scale,
  setFloorCount,
  setRoof,
  setRepeatCount,
  sortedLevels,
  sub,
  type Id,
  type Roof,
  type Intersection,
  type OpeningKind,
  type PlinthDocument,
  type Vec2,
} from '@plinth/core'
import { addSpotHeights, createParcel, deleteParcels, heightAt, terrainOf } from '@plinth/core'
import {
  EMPTY_SELECTION,
  isOutlineTool,
  SELECTION_KEY,
  type EditorStore,
  type OpeningPreview,
  type Pick,
  type Selection,
  type Tool,
} from './state.ts'

/** Editor commands shared by the toolbar, keyboard shortcuts and pointer tools. */

export interface ActionContext {
  doc: PlinthDocument
  store: EditorStore
}

const SAME_POINT = 1e-6

const DRAWING_RESET = {
  anchor: null,
  chainStart: null,
  lastDirection: null,
  lengthInput: null,
  cursor: null,
  openingPreview: null,
  draft: [],
} as const

export function setTool({ store }: ActionContext, tool: Tool): void {
  const state = store.getState()
  store.setState({
    ...DRAWING_RESET,
    tool,
    hover: null,
    selection: tool === 'select' ? state.selection : EMPTY_SELECTION,
    // Drawing happens on a floor, so drawing tools bring the last floor back into focus.
    ...(tool !== 'select' && state.mode === 'building' ? { wholeBuilding: false } : {}),
  })
}

/** True when the active level copies another and can't be drawn on. */
export function activeLevelIsCopy({ doc, store }: ActionContext): boolean {
  return isCopy(doc.getSnapshot().levels[store.getState().activeLevelId])
}

/** Ends the chain or shape being drawn, keeping what was placed. */
export function finishDrawing({ store }: ActionContext): void {
  store.setState({ anchor: null, chainStart: null, lengthInput: null, lastDirection: null, draft: [] })
}

/** Enter: like finishing, but a building outline with three or more corners is closed into a building. */
export function completeDrawing(ctx: ActionContext): void {
  const state = ctx.store.getState()
  if (isOutlineTool(state.tool) && state.draft.length >= 3) closeOutline(ctx, state.draft)
  else finishDrawing(ctx)
}

/**
 * Escape steps back one thing at a time. In a building: closes the length
 * box, ends the drawing in progress, clears the selection, shows the whole
 * building, then goes back out to the site. On the site: ends the drawing,
 * clears the selection, then returns to the Select tool.
 */
export function cancel(ctx: ActionContext): void {
  const state = ctx.store.getState()
  const selected = Object.values(state.selection).some((list) => list.length > 0)
  if (state.lengthInput !== null) ctx.store.setState({ lengthInput: null })
  else if (state.anchor || state.draft.length > 0) finishDrawing(ctx)
  else if (selected) ctx.store.setState({ selection: EMPTY_SELECTION })
  else if (state.mode === 'site') {
    if (state.tool !== 'select') setTool(ctx, 'select')
  } else if (!state.wholeBuilding) showWholeBuilding(ctx)
  else exitToSite(ctx)
}

/** Places a point with the active drawing tool. */
export function placePoint(ctx: ActionContext, point: Vec2): void {
  const { doc, store } = ctx
  const state = store.getState()
  const levelId = state.activeLevelId

  if (state.tool === 'street') {
    if (!state.anchor) {
      store.setState({ anchor: point, chainStart: point })
      return
    }
    if (dist(point, state.anchor) < SAME_POINT) {
      finishDrawing(ctx)
      return
    }
    const anchor = state.anchor
    doc.transact((tx) => insertStreet(tx, anchor, point, state.siteDefaults.street))
    store.setState({ anchor: point, lastDirection: normalize(sub(point, anchor)) })
    return
  }

  if (isOutlineTool(state.tool)) {
    const first = state.draft[0]
    // Back at the first point closes the outline and makes the building (or parcel).
    if (first && state.draft.length >= 3 && dist(point, first) < SAME_POINT) {
      closeOutline(ctx, state.draft)
      return
    }
    if (state.anchor && dist(point, state.anchor) < SAME_POINT) return
    store.setState({ draft: [...state.draft, point], anchor: point, chainStart: state.draft[0] ?? point })
    return
  }

  if (state.tool === 'terrain') {
    // A new spot height, at the ground's height there (the site's zero off the terrain).
    const terrain = terrainOf(doc.getSnapshot())
    const ground = doc.getSnapshot().meta.ground ?? 0
    const z = (terrain && heightAt(terrain, point)) ?? ground
    const [id] = doc.transact((tx) => addSpotHeights(tx, [{ x: point.x, y: point.y, z: Math.round(z * 100) / 100 }]))
    if (id) store.setState({ selection: { ...EMPTY_SELECTION, spotHeights: [id] } })
    return
  }

  if (activeLevelIsCopy(ctx)) return

  if (state.tool === 'wall') {
    if (!state.anchor) {
      store.setState({ anchor: point, chainStart: point })
      return
    }
    // Placing the same point twice (a double-click or double-tap) ends the chain.
    if (dist(point, state.anchor) < SAME_POINT) {
      finishDrawing(ctx)
      return
    }
    const anchor = state.anchor
    doc.transact((tx) => insertWall(tx, levelId, anchor, point))
    const closed = state.chainStart !== null && dist(point, state.chainStart) < SAME_POINT
    if (closed) finishDrawing(ctx)
    else {
      store.setState({ anchor: point, lengthInput: null, lastDirection: normalize(sub(point, anchor)) })
    }
    return
  }
}

/** A closed outline makes a building, or with the Parcel tool a parcel. */
function closeOutline(ctx: ActionContext, outline: readonly Vec2[]): void {
  if (ctx.store.getState().tool === 'parcel') createParcelFrom(ctx, outline)
  else createBuildingFrom(ctx, outline)
}

function createParcelFrom(ctx: ActionContext, outline: readonly Vec2[]): void {
  const parcel = ctx.doc.transact((tx) => createParcel(tx, outline))
  finishDrawing(ctx)
  // Stays in the Parcel tool, ready for the next one, with this one selected.
  if (parcel) ctx.store.setState({ selection: { ...EMPTY_SELECTION, parcels: [parcel.id] } })
}

function createBuildingFrom(ctx: ActionContext, outline: readonly Vec2[]): void {
  const { floors, floorHeight } = ctx.store.getState().siteDefaults
  const building = ctx.doc.transact((tx) => createBuilding(tx, outline, { floors, floorHeight }))
  finishDrawing(ctx)
  if (!building) return
  const { isolated } = ctx.store.getState()
  ctx.store.setState({
    tool: 'select',
    selection: { ...EMPTY_SELECTION, buildings: [building.id] },
    // A building drawn while others are hidden stays in view.
    isolated: isolated && [...isolated, building.id],
  })
}

/**
 * Places the next wall with an exact length, in the direction the cursor
 * points from the last point. Returns false if the text isn't a length.
 */
export function commitTypedLength(ctx: ActionContext, text: string): boolean {
  const state = ctx.store.getState()
  const length = parseLength(text)
  const chains = state.tool === 'wall' || state.tool === 'street' || isOutlineTool(state.tool)
  if (length === null || length <= 0 || !state.anchor || !chains) return false
  const towards = state.cursor?.point
  let dir = towards ? sub(towards, state.anchor) : { x: 0, y: 0 }
  if (Math.hypot(dir.x, dir.y) < SAME_POINT) dir = state.lastDirection ?? { x: 1, y: 0 }
  placePoint(ctx, add(state.anchor, scale(normalize(dir), length)))
  return true
}

/** Adds a window or door of the tool's current type where the preview shows it. */
export function placeOpening(ctx: ActionContext, preview: OpeningPreview, kind: OpeningKind): void {
  const typeId = ctx.store.getState().openingTypes[kind]
  ctx.doc.transact((tx) => addOpening(tx, preview.wallId, { kind, typeId, offset: preview.offset }))
}

/**
 * What picking something selects: the thing itself, or in the
 * whole-building view the same wall or point on every floor where it lines up.
 */
export function stackOf({ doc, store }: ActionContext, pick: Pick): Id[] {
  const state = store.getState()
  const stacked = state.mode === 'building' && state.wholeBuilding
  if (!stacked) return [pick.id]
  const stacks = findStacks(doc.getSnapshot(), state.buildingId ?? undefined)
  if (pick.kind === 'wall') return stacks.walls.get(pick.id) ?? [pick.id]
  if (pick.kind === 'node') return stacks.nodes.get(pick.id) ?? [pick.id]
  return [pick.id]
}

export function select(ctx: ActionContext, pick: Pick | null, additive: boolean): void {
  const { store } = ctx
  if (!pick) {
    if (!additive) store.setState({ selection: EMPTY_SELECTION })
    return
  }
  const current = store.getState().selection
  const key = SELECTION_KEY[pick.kind]
  const ids = stackOf(ctx, pick)
  if (!additive) {
    store.setState({ selection: { ...EMPTY_SELECTION, [key]: ids } })
  } else {
    const list = current[key]
    const next = list.includes(pick.id) ? list.filter((id) => !ids.includes(id)) : [...list, ...ids.filter((id) => !list.includes(id))]
    store.setState({ selection: { ...current, [key]: next } })
  }
  // Picking a hidden building (from the list) moves the focus to it.
  const { isolated, selection } = store.getState()
  if (isolated && pick.kind === 'building' && selection.buildings.some((id) => !isolated.includes(id))) {
    store.setState({ isolated: additive ? [...isolated, ...selection.buildings.filter((id) => !isolated.includes(id))] : selection.buildings })
  }
}

/** Hides every building but these, to focus on them. */
export function isolateBuildings({ store }: ActionContext, buildingIds: readonly Id[]): void {
  if (buildingIds.length > 0) store.setState({ isolated: [...buildingIds] })
}

export function showAllBuildings({ store }: ActionContext): void {
  store.setState({ isolated: null })
}

/** Hides the other buildings (around the open or selected ones), or shows them again. */
export function toggleIsolation(ctx: ActionContext): void {
  const state = ctx.store.getState()
  if (state.isolated) showAllBuildings(ctx)
  else if (state.mode === 'building' && state.buildingId) isolateBuildings(ctx, [state.buildingId])
  else isolateBuildings(ctx, state.selection.buildings)
}

export function deleteSelection(ctx: ActionContext): void {
  const { walls, nodes, openings, buildings, streets, streetNodes, parcels, spotHeights } = ctx.store.getState().selection
  const site = ctx.store.getState().mode === 'site'
  // On the site, a selected shell point or wall is edited, not the building deleted.
  const removeBuildings = site && walls.length === 0 && nodes.length === 0 ? buildings : []
  const lists = [walls, nodes, openings, removeBuildings, streets, streetNodes, parcels, spotHeights]
  if (lists.every((list) => list.length === 0)) return
  ctx.doc.transact((tx) => {
    deleteParcels(tx, parcels)
    for (const id of spotHeights) tx.deleteSpotHeight(id)
    deleteOpenings(tx, openings)
    deleteWalls(tx, walls)
    // A removed point joins the walls on either side of it.
    for (const nodeId of nodes) removeNode(tx, nodeId)
    for (const id of removeBuildings) deleteBuilding(tx, id)
    deleteStreets(tx, streets)
    deleteStreetNodes(tx, streetNodes)
  })
  ctx.store.setState({ selection: EMPTY_SELECTION, hover: null })
}

/** Sets a wall's length by moving its b end along the wall. */
export function setWallLength(ctx: ActionContext, wallId: Id, length: number): void {
  const snapshot = ctx.doc.getSnapshot()
  const wall = snapshot.walls[wallId]
  if (!wall || length <= 0) return
  const a = snapshot.nodes[wall.a]
  const b = snapshot.nodes[wall.b]
  if (!a || !b) return
  const end = add(a, scale(normalize(sub(b, a)), length))
  ctx.doc.transact((tx) => {
    moveNodes(tx, new Map([[b.id, end]]))
    finishNodeMove(tx, [b.id])
  })
}

export function setNodePosition(ctx: ActionContext, nodeId: Id, position: Vec2): void {
  ctx.doc.transact((tx) => {
    moveNodes(tx, new Map([[nodeId, position]]))
    finishNodeMove(tx, [nodeId])
  })
}

export function undo(ctx: ActionContext): void {
  ctx.doc.undo()
  dropMissingSelection(ctx)
}

export function redo(ctx: ActionContext): void {
  ctx.doc.redo()
  dropMissingSelection(ctx)
}

/** Removes selected items that no longer exist (after undo, or a remote edit). */
export function dropMissingSelection({ doc, store }: ActionContext): void {
  const snapshot = doc.getSnapshot()
  const state = store.getState()
  const selection = state.selection
  const roomIds = new Set(
    selection.rooms.length > 0 ? analyzeSite(snapshot).levels.flatMap((l) => l.rooms.map((r) => r.id)) : [],
  )
  const next: Selection = {
    walls: selection.walls.filter((id) => snapshot.walls[id]),
    nodes: selection.nodes.filter((id) => snapshot.nodes[id]),
    openings: selection.openings.filter((id) => snapshot.openings[id]),
    rooms: selection.rooms.filter((id) => roomIds.has(id)),
    buildings: selection.buildings.filter((id) => snapshot.buildings[id]),
    parcels: selection.parcels.filter((id) => snapshot.parcels[id]),
    spotHeights: selection.spotHeights.filter((id) => snapshot.spotHeights[id]),
    streets: selection.streets.filter((id) => snapshot.streets[id]),
    streetNodes: selection.streetNodes.filter((id) => snapshot.streetNodes[id]),
  }
  const changed = (Object.keys(next) as (keyof Selection)[]).some((k) => next[k].length !== selection[k].length)
  if (changed) store.setState({ selection: next })
  // Hidden-away buildings come back once the ones in focus are all gone.
  if (state.isolated && !state.isolated.some((id) => snapshot.buildings[id])) store.setState({ isolated: null })
  // The building being edited is gone (undo, or a collaborator): back to the site.
  if (state.mode === 'building' && (!state.buildingId || !snapshot.buildings[state.buildingId])) {
    store.setState({ ...DRAWING_RESET, mode: 'site', tool: 'select', selection: EMPTY_SELECTION })
  }
}

export function toggleView({ store }: ActionContext): void {
  store.setState({ view: store.getState().view === 'top' ? 'perspective' : 'top' })
}

export function toggleSnapping({ store }: ActionContext): void {
  const snap = store.getState().snap
  store.setState({ snap: { ...snap, enabled: !snap.enabled } })
}

// Site and building editors

/** Goes into a building: the building editor, on its ground floor. */
export function enterBuilding({ doc, store }: ActionContext, buildingId: Id): void {
  const ground = sortedLevels(doc.getSnapshot(), buildingId)[0]
  if (!ground) return
  store.setState({
    ...DRAWING_RESET,
    mode: 'building',
    buildingId,
    activeLevelId: ground.id,
    wholeBuilding: false,
    tool: 'select',
    selection: EMPTY_SELECTION,
    hover: null,
  })
}

/** Back out to the site, with the building just left selected. */
export function exitToSite({ store }: ActionContext): void {
  const buildingId = store.getState().buildingId
  store.setState({
    ...DRAWING_RESET,
    mode: 'site',
    tool: 'select',
    wholeBuilding: false,
    selection: buildingId ? { ...EMPTY_SELECTION, buildings: [buildingId] } : EMPTY_SELECTION,
    hover: null,
  })
}

export function setBuildingFloors(ctx: ActionContext, buildingId: Id, floors: number): void {
  ctx.doc.transact((tx) => setFloorCount(tx, buildingId, floors))
}

/** Sets a building's roof; null gives it the plain flat roof. */
export function setBuildingRoof(ctx: ActionContext, buildingId: Id, roof: Roof | null): void {
  ctx.doc.transact((tx) => setRoof(tx, buildingId, roof))
}

/** Turns a building about its middle by `degrees` (counter-clockwise on the plan). */
export function rotateBuildingBy(ctx: ActionContext, buildingId: Id, degrees: number): void {
  ctx.doc.transact((tx) => rotateBuilding(tx, buildingId, (degrees * Math.PI) / 180, buildingCentre(tx, buildingId)))
}

export function removeBuilding(ctx: ActionContext, buildingId: Id): void {
  ctx.doc.transact((tx) => deleteBuilding(tx, buildingId))
  ctx.store.setState({ selection: EMPTY_SELECTION })
}

// Levels

export function setActiveLevel({ store }: ActionContext, levelId: Id): void {
  const state = store.getState()
  if (state.activeLevelId === levelId && !state.wholeBuilding) return
  store.setState({
    ...DRAWING_RESET,
    activeLevelId: levelId,
    wholeBuilding: false,
    selection: EMPTY_SELECTION,
    hover: null,
  })
}

/** Takes the focus off the floor, showing every floor of the building in full. */
export function showWholeBuilding({ store }: ActionContext): void {
  store.setState({
    ...DRAWING_RESET,
    wholeBuilding: true,
    tool: 'select',
    selection: EMPTY_SELECTION,
    hover: null,
  })
}

/** Clicking the floor in focus again shows the whole building; clicking any other focuses it. */
export function toggleLevelFocus(ctx: ActionContext, levelId: Id): void {
  const state = ctx.store.getState()
  if (state.activeLevelId === levelId && !state.wholeBuilding) showWholeBuilding(ctx)
  else setActiveLevel(ctx, levelId)
}

function currentLevels({ doc, store }: ActionContext) {
  const buildingId = store.getState().buildingId
  return buildingId ? sortedLevels(doc.getSnapshot(), buildingId) : []
}

/** Moves to the level above or below the active one. */
export function stepLevel(ctx: ActionContext, direction: 1 | -1): void {
  const state = ctx.store.getState()
  if (state.mode !== 'building') return
  const levels = currentLevels(ctx)
  const index = levels.findIndex((l) => l.id === state.activeLevelId)
  // From the whole building, the first step comes back to the last floor.
  const next = state.wholeBuilding ? levels[index] : levels[index + direction]
  if (next) setActiveLevel(ctx, next.id)
}

/** Adds an empty level above the active one and switches to it. */
export function addLevelAbove(ctx: ActionContext): void {
  const { buildingId, activeLevelId } = ctx.store.getState()
  if (!buildingId) return
  const level = ctx.doc.transact((tx) => addLevel(tx, buildingId, activeLevelId))
  setActiveLevel(ctx, level.id)
}

export function removeLevel(ctx: ActionContext, levelId: Id): void {
  const levels = currentLevels(ctx)
  const index = levels.findIndex((l) => l.id === levelId)
  const fallback = levels[index - 1] ?? levels[index + 1]
  const deleted = ctx.doc.transact((tx) => deleteLevel(tx, levelId))
  if (deleted && fallback && ctx.store.getState().activeLevelId === levelId) setActiveLevel(ctx, fallback.id)
}

export function setRepeat(ctx: ActionContext, masterId: Id, count: number): void {
  ctx.doc.transact((tx) => setRepeatCount(tx, masterId, count))
  const active = ctx.store.getState().activeLevelId
  if (!ctx.doc.getSnapshot().levels[active]) setActiveLevel(ctx, masterId)
}

export function detach(ctx: ActionContext, levelId: Id): void {
  ctx.doc.transact((tx) => detachLevel(tx, levelId))
}

// Intersections

/** Joins walls that cross or touch, or separates walls joined at a node. */
export function toggleIntersection(ctx: ActionContext, intersection: Intersection): void {
  ctx.doc.transact((tx) => {
    if (intersection.kind === 'junction' && intersection.nodeId) disconnectNode(tx, intersection.nodeId)
    else connectIntersection(tx, intersection)
  })
  ctx.store.setState({ hover: null })
  dropMissingSelection(ctx)
}
