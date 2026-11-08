import { CSM } from 'three/examples/jsm/csm/CSM.js'
import { MathUtils, PerspectiveCamera, type Color, type Material, type Object3D, type Vector3 } from 'three'

/**
 * Sunlight with cascaded shadows: the view is cut into bands by distance,
 * each with a shadow map of its own, so shadows are crisp up close and still
 * reach across a whole city in the distance. The maps are fitted to the
 * view every frame and snapped to their texels, so shadows hold still while
 * the view moves.
 */

const COARSE = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches
/** Bands, and the size of each band's shadow map. Phones get fewer, smaller ones. */
const CASCADES = COARSE ? 2 : 3
const MAP_SIZE = COARSE ? 1024 : 2048
/** How far out shadows reach is up to the caller, within these limits (metres). Beyond, the haze takes over. */
const MIN_REACH = 150
const MAX_REACH = 9000
/** Room behind each band towards the sun (metres), so towers outside the view still cast shadows into it. */
const MARGIN = 700
/** Softness of shadow edges, in texels of each band's map. */
const SOFTNESS = 2.5

/** Materials lit by lights: those that need the cascades' lighting. */
function isLit(material: Material): boolean {
  const m = material as Material & Record<string, unknown>
  return !!(
    m.isMeshStandardMaterial ||
    m.isMeshLambertMaterial ||
    m.isMeshPhongMaterial ||
    m.isMeshToonMaterial ||
    (m.isShaderMaterial && m.lights)
  )
}

export class Sun {
  private readonly csm: CSM
  private readonly camera: PerspectiveCamera
  /**
   * The camera as the bands see it: the same view, with a near plane close in.
   * CSM assumes one (its shader measures depth from the camera, not from the
   * near plane), while the camera itself may start drawing far out.
   */
  private readonly proxy = new PerspectiveCamera()
  /** How deep in the view the first thing there is to shade lies (see update). */
  private contentFrom = 0
  /** Materials set up for the cascades. */
  private ready = new WeakSet<Material>()
  /** The camera settings and reach the bands were last fitted to. */
  private fitted = ''

  constructor(camera: PerspectiveCamera, parent: Object3D) {
    this.camera = camera
    this.csm = new CSM({
      camera: this.proxy,
      parent,
      cascades: CASCADES,
      shadowMapSize: MAP_SIZE,
      maxFar: 1000,
      mode: 'custom',
      customSplitsCallback: (amount: number, near: number, far: number, target: number[]) =>
        splitBands(amount, near, far, this.contentFrom, target),
      lightMargin: MARGIN,
      lightNear: 0.5,
      lightFar: 5000,
      shadowBias: -0.00008,
    })
    // Bands blend into each other instead of meeting at a visible line.
    this.csm.fade = true
    for (const light of this.csm.lights) light.shadow.radius = SOFTNESS
  }

  /** Where the sun is (towards it), and its colour and strength. */
  setLight(towardsSun: Vector3, color: Color, intensity: number): void {
    this.csm.lightDirection.copy(towardsSun).negate().normalize()
    for (const light of this.csm.lights) {
      light.color.copy(color)
      light.intensity = intensity
    }
  }

  /**
   * Fits the bands to the view, out to `distance` from the camera, and sets
   * up any new materials in `scene` for them. `contentFrom` is how deep in
   * the view the nearest thing to shade can be (high above the city, the
   * tops of the tallest buildings): the bands are spent beyond it, not on
   * the empty air in front. Call every frame, before drawing.
   */
  update(distance: number, scene: Object3D, contentFrom = 0): void {
    const camera = this.camera
    const proxy = this.proxy
    proxy.matrixWorld.copy(camera.matrixWorld)
    proxy.matrixWorldInverse.copy(camera.matrixWorldInverse)
    const near = Math.min(camera.near, 4)
    // Steps of about 19%, so zooming doesn't refit the bands every frame; rounded up, never short of what's wanted.
    const wanted = Math.min(Math.max(distance, MIN_REACH, contentFrom * 1.2), Math.max(MAX_REACH, contentFrom * 1.5))
    const reach = 2 ** (Math.ceil(Math.log2(wanted) * 4) / 4)
    // Steps too, so the split moves only now and then.
    const from = contentFrom > 0 ? 2 ** (Math.floor(Math.log2(contentFrom) * 8) / 8) : 0
    const key = `${near}|${camera.far}|${camera.fov}|${camera.aspect}|${reach}|${from}`
    if (key !== this.fitted) {
      this.fitted = key
      this.contentFrom = from
      proxy.fov = camera.fov
      proxy.aspect = camera.aspect
      proxy.near = near
      proxy.far = camera.far
      proxy.updateProjectionMatrix()
      this.csm.maxFar = reach
      this.csm.updateFrustums()
      for (const light of this.csm.lights) {
        const shadow = light.shadow.camera
        const width = shadow.right - shadow.left
        // Depth just deep enough for the band and the room behind it: the more precise.
        shadow.near = 0.5
        shadow.far = MARGIN + width * 2 + 200
        shadow.updateProjectionMatrix()
        // Pushed out from the surface by about a texel, against shadow acne on walls the sun grazes.
        light.shadow.normalBias = (width / MAP_SIZE) * 1.5
      }
    }
    this.csm.update()
    this.prepare(scene)
  }

  /** Sets up lit materials not yet seen, before they are first drawn. */
  private prepare(scene: Object3D): void {
    scene.traverse((object) => {
      const material = (object as Object3D & { material?: Material | Material[] }).material
      if (!material) return
      for (const m of Array.isArray(material) ? material : [material]) {
        if (this.ready.has(m)) continue
        this.ready.add(m)
        if (!isLit(m)) continue
        // CSM sets its own onBeforeCompile; a material's own (the ground's geomorph and cut-outs, the fade-in,
        // the grass) must run too, before it: chained, not replaced.
        const own = m.onBeforeCompile
        this.csm.setupMaterial(m)
        const cascades = m.onBeforeCompile
        m.onBeforeCompile = function (shader, renderer) {
          own.call(this, shader, renderer)
          cascades.call(this, shader, renderer)
        }
        m.needsUpdate = true
      }
    })
  }

  dispose(): void {
    this.csm.remove()
    this.csm.dispose()
    for (const light of this.csm.lights) light.dispose()
  }
}

/**
 * Where the bands meet, as shares of `far` (the last is 1). Usually a blend
 * of even and ever-wider bands from the camera out (CSM's practical split).
 * When there's nothing to shade nearer than `from`, the first band ends
 * there and the others share what lies beyond.
 */
function splitBands(amount: number, near: number, far: number, from: number, target: number[]): void {
  const practical = (count: number, start: number) => {
    for (let i = 1; i < count; i++) {
      const even = start + ((far - start) * i) / count
      const widening = start * (far / start) ** (i / count)
      target.push(MathUtils.lerp(even, widening, 0.5) / far)
    }
  }
  if (amount > 1 && from > near * 4 && from < far * 0.9) {
    target.push(from / far)
    practical(amount - 1, from)
  } else practical(amount, near)
  target.push(1)
}
