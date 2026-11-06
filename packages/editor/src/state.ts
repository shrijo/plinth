import type { SceneStyle } from './scene/materials.ts'
import { DEFAULT_HOUR, FIRST_HOUR, LAST_HOUR } from './scene/daylight.ts'
import {
  DEFAULT_OPENING_TYPE,
  DEFAULT_SNAP_SETTINGS,
  DEFAULT_STREET,
  type Id,
  type StreetProps,
  type OpeningKind,
  type SnapResult,
  type SnapSettings,
  type Vec2,
} from '@plinth/core'
import { createStore, type StoreApi } from 'zustand/vanilla'

/**
 * The two editors: the site (streets and building shells) and one building
 * (walls, rooms, windows and doors).
 */
export type EditorMode = 'site' | 'building'

/** Tools of the site editor: streets, and new buildings drawn as an outline or a rectangle. */
export type SiteTool = 'select' | 'street' | 'outline' | 'parcel' | 'terrain'
/** Tools of the building editor. */
export type BuildingTool = 'select' | 'wall' | 'window' | 'door'
export type Tool = SiteTool | BuildingTool
export type ViewMode = 'perspective' | 'top'
export type PointerKind = 'mouse' | 'touch' | 'pen'
export type PickKind =
  | 'wall'
  | 'node'
  | 'opening'
  | 'room'
  | 'building'
  | 'street'
  | 'streetNode'
  /** The handle that bends a street. */
  | 'streetCurve'
  | 'parcel'
  /** A corner of a parcel: its id is the parcel's, a '#' and the corner's index. */
  | 'parcelCorner'
  | 'spotHeight'
  /** The middle of a shell wall, dragged to move the wall. */

export interface Pick {
  kind: PickKind
  id: Id
}

export interface Selection {
  walls: readonly Id[]
  nodes: readonly Id[]
  openings: readonly Id[]
  rooms: readonly Id[]
  buildings: readonly Id[]
  streets: readonly Id[]
  streetNodes: readonly Id[]
  parcels: readonly Id[]
  spotHeights: readonly Id[]
}

export const EMPTY_SELECTION: Selection = {
  walls: [],
  nodes: [],
  openings: [],
  rooms: [],
  buildings: [],
  streets: [],
  streetNodes: [],
  parcels: [],
  spotHeights: [],
}

export const SELECTION_KEY: Record<PickKind, keyof Selection> = {
  wall: 'walls',
  node: 'nodes',
  opening: 'openings',
  room: 'rooms',
  building: 'buildings',
  street: 'streets',
  streetNode: 'streetNodes',
  streetCurve: 'streets',
  parcel: 'parcels',
  parcelCorner: 'parcels',
  spotHeight: 'spotHeights',
}

/** What new streets and buildings start with in the site editor. */
export interface SiteDefaults {
  street: StreetProps
  floors: number
  floorHeight: number
}

/** Where a window or door would go while the opening tools aim at a wall. */
export interface OpeningPreview {
  wallId: Id
  offset: number
}

/** UI state of one editor instance. The building itself lives in the PlinthDocument. */
export interface EditorState {
  mode: EditorMode
  /** The building open in the building editor (or last opened). */
  buildingId: Id | null
  siteDefaults: SiteDefaults
  tool: Tool
  /** The floor being worked on (kept while the whole building is shown, to return to). */
  activeLevelId: Id
  /** No floor in focus: every floor shown in full, nothing faded. */
  wholeBuilding: boolean
  selection: Selection
  hover: Pick | null
  /** The snapped cursor while drawing or dragging. */
  cursor: SnapResult | null
  /** The last placed point of the wall chain or rectangle being drawn. */
  anchor: Vec2 | null
  /** Where the current wall chain started; returning here closes it. */
  chainStart: Vec2 | null
  /** The corners placed so far of a building outline being drawn on the site. */
  draft: readonly Vec2[]
  /** Direction of the last wall placed, used for a typed length when the cursor gives none. */
  lastDirection: Vec2 | null
  /** Text typed for an exact length, or null when the length box is closed. */
  lengthInput: string | null
  /** The type the window and door tools place. */
  openingTypes: Record<OpeningKind, string>
  openingPreview: OpeningPreview | null
  view: ViewMode
  /** Focal length of the 3D view's lens, in millimetres (full-frame equivalent). */
  lens: number
  /** How the world looks: colourful, or plain white like a model. */
  style: SceneStyle
  /** The time of day the sun is set to, in hours (local solar time). */
  timeOfDay: number
  /** Shading from the sky blocked in corners, at the foot of walls and down streets (costs some speed). */
  ambientOcclusion: boolean
  /** The real world drawn round a site placed on the map (one with a longitude and latitude). */
  showWorld: boolean
  /** The only buildings drawn while the others are hidden, to focus on them; null draws them all. */
  isolated: readonly Id[] | null
  /** Whether levels above the active one are drawn. */
  showLevelsAbove: boolean
  /** Dark outlines on every element's edges. */
  showOutlines: boolean
  /** Other floors drawn see-through, so the active floor stands out. */
  fadeOtherLevels: boolean
  snap: SnapSettings
  /** True while the user holds the key that turns snapping off. */
  snapSuspended: boolean
  pointerKind: PointerKind
  /** True while something is being dragged. */
  dragging: boolean
}

export type EditorStore = StoreApi<EditorState>

/** View settings each viewer keeps between sessions. */
export const VIEW_PREFERENCES = [
  'showOutlines',
  'fadeOtherLevels',
  'showLevelsAbove',
  'lens',
  'style',
  'timeOfDay',
  'ambientOcclusion',
  'showWorld',
] as const
export type ViewPreferences = { [K in (typeof VIEW_PREFERENCES)[number]]: EditorState[K] }

/** The lenses offered for the 3D view, in millimetres. 35 mm is a natural view; 24 and 28 mm are wide, 50 mm is narrower. */
export const LENSES = [24, 28, 35, 50] as const
export const DEFAULT_LENS = 35

export const SCENE_STYLES: readonly SceneStyle[] = ['mono']

const DEFAULT_VIEW: ViewPreferences = {
  showOutlines: false,
  fadeOtherLevels: true,
  showLevelsAbove: false,
  lens: DEFAULT_LENS,
  style: 'mono',
  timeOfDay: DEFAULT_HOUR,
  // On by default, except on phones and tablets, where it costs too much battery.
  ambientOcclusion: !(typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches),
  showWorld: true,
}
const PREFERENCES_KEY = 'plinth:view:2'

function loadPreferences(): Partial<ViewPreferences> {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFERENCES_KEY) ?? '{}') as Record<string, unknown>
    const valid = (k: (typeof VIEW_PREFERENCES)[number]) =>
      typeof saved[k] === typeof DEFAULT_VIEW[k] &&
      (k !== 'lens' || (LENSES as readonly unknown[]).includes(saved[k])) &&
      (k !== 'style' || (SCENE_STYLES as readonly unknown[]).includes(saved[k])) &&
      (k !== 'timeOfDay' || (Number(saved[k]) >= FIRST_HOUR && Number(saved[k]) <= LAST_HOUR))
    return Object.fromEntries(VIEW_PREFERENCES.filter(valid).map((k) => [k, saved[k]]))
  } catch {
    return {}
  }
}

export function savePreferences(state: EditorState): void {
  try {
    localStorage.setItem(PREFERENCES_KEY, JSON.stringify(Object.fromEntries(VIEW_PREFERENCES.map((k) => [k, state[k]]))))
  } catch {
    // Storage can be unavailable; preferences then last for the session only.
  }
}

/** The saved view settings with defaults filled in, for views outside the editor (the world). */
export function readViewPreferences(): ViewPreferences {
  return { ...DEFAULT_VIEW, ...loadPreferences() }
}

/** Saves some view settings, keeping the rest as they were. */
export function writeViewPreferences(patch: Partial<ViewPreferences>): void {
  try {
    localStorage.setItem(PREFERENCES_KEY, JSON.stringify({ ...readViewPreferences(), ...patch }))
  } catch {
    // As savePreferences.
  }
}

export function createEditorStore(activeLevelId: Id): EditorStore {
  return createStore<EditorState>(() => ({
    mode: 'site',
    buildingId: null,
    siteDefaults: { street: DEFAULT_STREET, floors: 3, floorHeight: 3 },
    tool: 'select',
    activeLevelId,
    wholeBuilding: false,
    selection: EMPTY_SELECTION,
    hover: null,
    cursor: null,
    anchor: null,
    chainStart: null,
    draft: [],
    lastDirection: null,
    lengthInput: null,
    openingTypes: { ...DEFAULT_OPENING_TYPE },
    openingPreview: null,
    view: 'perspective',
    ...DEFAULT_VIEW,
    ...loadPreferences(),
    isolated: null,
    snap: DEFAULT_SNAP_SETTINGS,
    snapSuspended: false,
    pointerKind: 'mouse',
    dragging: false,
  }))
}

export function isSelected(selection: Selection, pick: Pick): boolean {
  return selection[SELECTION_KEY[pick.kind]].includes(pick.id)
}

export function selectionSize(selection: Selection): number {
  return Object.values(selection).reduce((sum, list) => sum + list.length, 0)
}

export const SITE_TOOLS: readonly SiteTool[] = ['select', 'street', 'outline', 'parcel', 'terrain']

/** Tools that draw a closed outline corner by corner: a building's, or a parcel's. */
export const isOutlineTool = (tool: Tool): tool is 'outline' | 'parcel' => tool === 'outline' || tool === 'parcel'

/** A parcel corner's pick id, and back. */
export const parcelCornerId = (parcelId: Id, index: number) => `${parcelId}#${index}`
export function parseParcelCorner(id: string): { parcelId: Id; index: number } {
  const at = id.lastIndexOf('#')
  return { parcelId: id.slice(0, at), index: Number(id.slice(at + 1)) }
}
export const BUILDING_TOOLS: readonly BuildingTool[] = ['select', 'wall', 'window', 'door']

export function samePick(a: Pick | null, b: Pick | null): boolean {
  return a?.kind === b?.kind && a?.id === b?.id
}
