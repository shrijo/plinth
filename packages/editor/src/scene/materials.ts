import { Color, DoubleSide, MeshBasicMaterial, MeshStandardMaterial } from 'three'

/**
 * How the world looks: a monochrome model, in sunlight. Materials are
 * shared, and a style recolours them in place (see applyStyle); buildings
 * take their colours per vertex (see paint in geometry.ts), so each
 * building could differ and still be one mesh. There is one style for now.
 */

export type SceneStyle = 'mono'
export interface Palette {
  skyTop: string
  skyHorizon: string
  ground: string
  /** Speckle colour in the ground texture; the same as ground for none. */
  groundSpeckle: string
  sun: string
  sunIntensity: number
  skyLight: string
  groundLight: string
  ambientIntensity: number
  /** Building faces, picked per building. */
  facades: readonly string[]
  roofs: readonly string[]
  /** How far floor bands lean from the facade colour towards white. */
  band: number
  /** Inside faces of walls, in the building editor. */
  interior: string
  /** Floor surfaces inside, in the building editor. */
  floor: string
  ceiling: string
  glass: string
  glassOpacity: number
  frame: string
  door: string
  road: string
  bike: string
  parking: string
  sidewalk: string
  marking: string
  trunk: string
  crowns: readonly string[]
}

export const PALETTES: Record<SceneStyle, Palette> = {
  // Monochrome: off-white buildings, light grey streets, a neutral ground and a pale sky.
  mono: {
    skyTop: '#d6dce1',
    skyHorizon: '#f1f1ef',
    ground: '#e6e5e1',
    groundSpeckle: '#e6e5e1',
    sun: '#ffffff',
    sunIntensity: 2.3,
    skyLight: '#ffffff',
    groundLight: '#d8d5cf',
    ambientIntensity: 1.35,
    facades: ['#f3f2ef'],
    roofs: ['#e2e0db'],
    band: 0.5,
    interior: '#f7f6f3',
    floor: '#ebe8e2',
    ceiling: '#f5f4f1',
    // Windows and doors are the walls' colour: they read by their depth and shadows, like a white model.
    glass: '#f3f2ef',
    glassOpacity: 1,
    frame: '#f3f2ef',
    door: '#f3f2ef',
    road: '#d0cec9',
    bike: '#c5c3be',
    parking: '#d8d6d1',
    sidewalk: '#eeede8',
    marking: '#fdfdfc',
    trunk: '#d9d5ce',
    crowns: ['#f3f2ef'],
  },
}

let current: Palette = PALETTES.mono

/** The palette in use. */
export function palette(): Palette {
  return current
}

/** Lighter or darker: `amount` towards white (positive) or black (negative). */
export function shade(hex: string, amount: number): string {
  const c = new Color(hex)
  return `#${c.lerp(new Color(amount >= 0 ? '#ffffff' : '#000000'), Math.abs(amount)).getHexString()}`
}

function hash(text: string): number {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619)
  return h >>> 0
}

/** A building's facade, roof and floor-band colours: picked from the palette by its ID, so they stay put. */
export function buildingColours(buildingId: string, p: Palette = current): { facade: string; roof: string; band: string } {
  const h = hash(buildingId)
  const facade = p.facades[h % p.facades.length]!
  return { facade, roof: p.roofs[(h >>> 8) % p.roofs.length]!, band: shade(facade, p.band) }
}

/** The polygon offset keeps outline edges from flickering on faces. */
function surface({ color = '#ffffff', opacity = 1, vertexColors = false } = {}): MeshStandardMaterial {
  const transparent = opacity < 1
  return new MeshStandardMaterial({
    color,
    roughness: 0.92,
    metalness: 0,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
    transparent,
    opacity,
    depthWrite: !transparent,
    vertexColors,
  })
}

export type Look = 'normal' | 'hover' | 'selected' | 'faded'
/** How far faded floors and buildings show. */
const FADED_OPACITY = 0.22

/** Highlights darken the surface to a cool grey. */
const HOVER_TINT = '#e3e7eb'
const SELECTED_TINT = '#b7c0ca'

function looks(): Record<Look, MeshStandardMaterial> {
  return {
    normal: surface({ vertexColors: true }),
    hover: surface({ vertexColors: true, color: HOVER_TINT }),
    selected: surface({ vertexColors: true, color: SELECTED_TINT }),
    faded: surface({ vertexColors: true, opacity: FADED_OPACITY }),
  }
}

/** Walls, painted per vertex: facade outside, interior colour inside. */
export const wallMaterials = looks()
/** Floor slabs and roofs (and on the site whole building shells), painted per vertex. */
export const slabMaterials = looks()

export const fillMaterials = {
  normal: {
    frame: surface({ color: current.frame }),
    leaf: surface({ color: current.door }),
    glass: surface({ color: current.glass, opacity: current.glassOpacity }),
  },
  faded: {
    frame: surface({ color: current.frame, opacity: FADED_OPACITY }),
    leaf: surface({ color: current.door, opacity: FADED_OPACITY }),
    glass: surface({ color: current.glass, opacity: FADED_OPACITY }),
  },
}

/** Shown over a hovered or selected opening. */
export const openingHighlight = {
  hover: new MeshBasicMaterial({ color: '#1f2328', transparent: true, opacity: 0.12, depthWrite: false }),
  selected: new MeshBasicMaterial({ color: '#1f2328', transparent: true, opacity: 0.22, depthWrite: false }),
}

export const roomHighlight = {
  hover: new MeshBasicMaterial({ color: '#1f2328', transparent: true, opacity: 0.14, depthWrite: false }),
  selected: new MeshBasicMaterial({ color: '#1f2328', transparent: true, opacity: 0.28, depthWrite: false }),
}

export const previewMaterial = new MeshStandardMaterial({
  color: '#1f2328',
  transparent: true,
  opacity: 0.22,
  depthWrite: false,
})

/** Street surfaces. Lanes and paint sit on the road and are drawn in front of it rather than raised. */
function flat(color: string, layer = 0): MeshStandardMaterial {
  return new MeshStandardMaterial({
    color,
    roughness: 0.95,
    metalness: 0,
    polygonOffset: layer > 0,
    polygonOffsetFactor: -layer,
    polygonOffsetUnits: -layer * 2,
  })
}
export const streetMaterials = {
  road: flat(current.road),
  bike: flat(current.bike, 1),
  parking: flat(current.parking, 1),
  sidewalk: surface({ color: current.sidewalk }),
  marking: flat(current.marking, 2),
}

/** Glass in the copied floors of the building editor: the walls' surface, seen from both sides. */
export const paneMaterial = surface({ color: current.glass })
paneMaterial.side = DoubleSide
export const paneMaterialFaded = surface({ color: current.glass, opacity: FADED_OPACITY })
paneMaterialFaded.side = DoubleSide

/**
 * Window surrounds on the site's buildings. They draw nothing themselves,
 * only cast shadows (from both sides): a window shows the way a recessed one
 * does on a white model, by the shadow of its head and jambs on the wall.
 */
export const surroundMaterial = new MeshBasicMaterial({ colorWrite: false, depthWrite: false, side: DoubleSide })

/** Shown over a hovered or selected street. */
export const streetHighlight = {
  hover: new MeshBasicMaterial({ color: '#1f2328', transparent: true, opacity: 0.16, depthWrite: false }),
  selected: new MeshBasicMaterial({ color: '#1f2328', transparent: true, opacity: 0.3, depthWrite: false }),
}

/** The translucent sheet that marks the floor being drawn on. */
export const workPlaneMaterial = new MeshBasicMaterial({
  color: '#ffffff',
  transparent: true,
  opacity: 0.55,
  depthWrite: false,
})

/** Recolours the shared materials for a style. */
export function applyStyle(style: SceneStyle): void {
  current = PALETTES[style]
  const p = current
  for (const set of [fillMaterials.normal, fillMaterials.faded]) {
    set.frame.color.set(p.frame)
    set.leaf.color.set(p.door)
    set.glass.color.set(p.glass)
  }
  fillMaterials.normal.glass.opacity = p.glassOpacity
  streetMaterials.road.color.set(p.road)
  streetMaterials.bike.color.set(p.bike)
  streetMaterials.parking.color.set(p.parking)
  streetMaterials.sidewalk.color.set(p.sidewalk)
  streetMaterials.marking.color.set(p.marking)
  paneMaterial.color.set(p.glass)
  paneMaterialFaded.color.set(p.glass)
}

export const COLORS = {
  /** Interaction feedback: ink, in keeping with the monochrome world. */
  accent: '#1f2328',
  /** Outline colours, when outlines are on. */
  edge: '#3a3d41',
  edgeFaded: '#c9c9c6',
  edgeSelected: '#1f2328',
  node: '#ffffff',
  nodeRing: '#1f2328',
  guideX: '#e5484d',
  guideY: '#2f9e5b',
  guideOther: '#c2338e',
  snapNode: '#2f9e5b',
  snapMidpoint: '#0e8fa8',
  snapWall: '#c2338e',
  snapFree: '#3a3631',
  gridCell: '#d2d1cc',
  gridSection: '#bdbcb6',
  /** The grid on the white sheet of an upper floor. */
  gridOnSheet: '#c3ccd6',
  gridSectionOnSheet: '#9ba7b4',
  workPlaneEdge: '#1f2328',
} as const
