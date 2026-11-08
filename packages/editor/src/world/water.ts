import {
  Color,
  HalfFloatType,
  Matrix4,
  PerspectiveCamera,
  Plane,
  ShaderMaterial,
  UniformsLib,
  UniformsUtils,
  Vector2,
  Vector3,
  Vector4,
  WebGLRenderTarget,
  type Object3D,
  type WebGLRenderer,
} from 'three'

/**
 * Water: lakes, rivers and the sea, with the world mirrored in them. One
 * reflection is drawn per frame for all of it (the scene seen from below a
 * plane at the water's level, everything under the water cut away by the
 * mirror camera's near plane, so no material needs a clipping variant of
 * its shader) and every water surface reads from it, rippled by waves made in the
 * shader (no textures), brighter at glancing angles (Fresnel) and glinting
 * where the sun catches it. The colours stay in the model's pale greys,
 * with a hint of blue.
 */

const vertexShader = /* glsl */ `
  #include <common>
  #include <fog_pars_vertex>
  #include <logdepthbuf_pars_vertex>
  uniform mat4 mirror;
  varying vec4 vMirror;
  varying vec3 vWorld;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    vMirror = mirror * world;
    vec4 mvPosition = viewMatrix * world;
    gl_Position = projectionMatrix * mvPosition;
    #include <logdepthbuf_vertex>
    #include <fog_vertex>
  }
`

const fragmentShader = /* glsl */ `
  #include <common>
  #include <fog_pars_fragment>
  #include <logdepthbuf_pars_fragment>
  uniform sampler2D reflection;
  uniform float mirrored;
  uniform float time;
  uniform vec3 sunDirection;
  uniform vec3 sunColor;
  uniform vec3 deep;
  uniform vec3 sky;
  uniform vec2 offset;
  varying vec4 vMirror;
  varying vec3 vWorld;

  // Hash without sine (Dave Hoskins): steady on every GPU, for the coordinates of a few kilometres used here.
  vec2 hash(vec2 p) {
    vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
    q += dot(q, q.yzx + 33.33);
    return fract((q.xx + q.yz) * q.zy) * 2.0 - 1.0;
  }

  // Gradient noise with its slope (value, d/dx, d/dy): smooth, without a pattern to repeat.
  vec3 noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    vec2 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
    vec2 ga = hash(i);
    vec2 gb = hash(i + vec2(1.0, 0.0));
    vec2 gc = hash(i + vec2(0.0, 1.0));
    vec2 gd = hash(i + vec2(1.0, 1.0));
    float va = dot(ga, f);
    float vb = dot(gb, f - vec2(1.0, 0.0));
    float vc = dot(gc, f - vec2(0.0, 1.0));
    float vd = dot(gd, f - vec2(1.0, 1.0));
    float k = va - vb - vc + vd;
    return vec3(
      va + u.x * (vb - va) + u.y * (vc - va) + u.x * u.y * k,
      ga + u.x * (gb - ga) + u.y * (gc - ga) + u.x * u.y * (ga - gb - gc + gd) + du * (u.yx * k + vec2(vb, vc) - va)
    );
  }

  float pixel;

  // One layer of the surface: noise at a scale (metres), turned and drifting with the wind; its slope, faded
  // out where it would be finer than a few pixels on the screen.
  vec2 layer(vec2 p, float size, float angle, float height, float speed) {
    float c = cos(angle);
    float s = sin(angle);
    vec2 q = mat2(c, -s, s, c) * p / size + vec2(time * speed / size, time * speed * 0.37 / size);
    vec2 slope = noise(q).yz;
    slope = mat2(c, s, -s, c) * slope;
    return slope * (height / size) * smoothstep(pixel * 2.0, pixel * 7.0, size);
  }

  void main() {
    #include <logdepthbuf_fragment>
    vec2 p = vWorld.xz + offset;
    vec3 toEye = cameraPosition - vWorld;
    float distance = length(toEye);
    vec3 view = toEye / distance;
    pixel = max(length(dFdx(vWorld.xz)), length(dFdy(vWorld.xz)));

    // Wind comes and goes: broad patches of calm, nearly a mirror, and patches ruffled a little.
    float wind = smoothstep(-0.35, 0.45, noise(p / 230.0 + vec2(time * 0.004, 0.0)).x + 0.5 * noise(p / 97.0).x);
    float rough = mix(0.12, 1.0, wind);
    vec2 slope = vec2(0.0);
    slope += layer(p, 37.0, 0.3, 0.35, 0.55);
    slope += layer(p, 13.7, 1.9, 0.16, 0.42);
    slope += layer(p, 5.3, 4.1, 0.07, 0.30);
    slope += layer(p, 2.1, 2.7, 0.03, 0.22);
    slope += layer(p, 0.83, 5.3, 0.012, 0.15);
    slope *= rough;
    vec3 n = normalize(vec3(-slope.x, 1.0, -slope.y));

    float facing = max(dot(n, view), 0.0);
    float fresnel = 0.02 + 0.98 * pow(1.0 - facing, 5.0);

    vec3 reflected = sky;
    if (mirrored > 0.5) {
      vec2 uv = vMirror.xy / vMirror.w;
      uv += n.xz * 0.012 / (1.0 + distance * 0.003);
      // Reflections on water smear up and down, more where it's rough and far.
      float smear = (0.0015 + 0.006 * rough) * (1.0 + min(distance / 1500.0, 2.0));
      reflected = vec3(0.0);
      reflected += texture2D(reflection, clamp(uv, 0.001, 0.999)).rgb * 0.36;
      reflected += texture2D(reflection, clamp(uv + vec2(0.0, smear), 0.001, 0.999)).rgb * 0.22;
      reflected += texture2D(reflection, clamp(uv - vec2(0.0, smear), 0.001, 0.999)).rgb * 0.22;
      reflected += texture2D(reflection, clamp(uv + vec2(0.0, smear * 2.2), 0.001, 0.999)).rgb * 0.1;
      reflected += texture2D(reflection, clamp(uv - vec2(0.0, smear * 2.2), 0.001, 0.999)).rgb * 0.1;
    }
    vec3 colour = mix(deep, reflected, clamp(fresnel * 0.8 + 0.18, 0.0, 1.0));
    // The sun: a soft sheen, and a glint where the water's ruffled.
    vec3 halfway = normalize(sunDirection + view);
    float h = max(dot(n, halfway), 0.0);
    colour += sunColor * (pow(h, 900.0) * 1.2 * rough + pow(h, 60.0) * 0.04);
    gl_FragColor = vec4(colour, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`

/** Phones and tablets keep their battery: the water shows the sky, not the world. */
const COARSE = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches

const bias = new Matrix4().set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1)
const eye = new Vector3()
const look = new Vector3()
const up = new Vector3()
const normal = new Vector3(0, 1, 0)
const point = new Vector3()
const rotation = new Matrix4()
const screen = new Vector2()
const q = new Vector4()
const clip = new Vector4()

/**
 * Only the main view draws what's on this layer (as well as layer 0): the grass, say, which a rippled
 * reflection at a fraction of the screen's resolution can't show anyway.
 */
export const MAIN_VIEW_LAYER = 1

export class WorldWater {
  readonly material: ShaderMaterial
  private readonly target = new WebGLRenderTarget(1, 1, { type: HalfFloatType })
  private readonly mirror = new PerspectiveCamera()
  private readonly plane = new Plane()
  private start = performance.now()

  constructor(deep = '#b9c6cf', sky = '#e8ecee') {
    this.material = new ShaderMaterial({
      uniforms: UniformsUtils.merge([
        UniformsLib.fog,
        {
          reflection: { value: null },
          mirrored: { value: 0 },
          mirror: { value: new Matrix4() },
          time: { value: 0 },
          sunDirection: { value: new Vector3(0.3, 0.8, 0.5).normalize() },
          sunColor: { value: new Color('#fffaf0') },
          deep: { value: new Color(deep) },
          sky: { value: new Color(sky) },
          offset: { value: [0, 0] },
        },
      ]),
      vertexShader,
      fragmentShader,
      fog: true,
    })
    this.material.uniforms.reflection!.value = this.target.texture
    this.material.userData.shared = true
  }

  /** The sun, as the rest of the scene has it (towards the sun). */
  setSun(direction: Vector3, colour: Color): void {
    ;(this.material.uniforms.sunDirection!.value as Vector3).copy(direction).normalize()
    ;(this.material.uniforms.sunColor!.value as Color).copy(colour)
  }

  setSky(colour: Color): void {
    ;(this.material.uniforms.sky!.value as Color).copy(colour)
  }

  /**
   * Draws the reflection for a water level (y in the scene), or switches it
   * off (null: no water near, or the camera under it). `offset` keeps the
   * waves in place on the ground when the scene's origin moves.
   */
  reflect(renderer: WebGLRenderer, scene: Object3D, camera: PerspectiveCamera, level: number | null, offset: [number, number]): void {
    const uniforms = this.material.uniforms
    uniforms.time!.value = (performance.now() - this.start) / 1000
    uniforms.offset!.value = offset
    camera.getWorldPosition(eye)
    if (level === null || eye.y < level + 0.5 || COARSE) {
      uniforms.mirrored!.value = 0
      return
    }
    // The size: half the screen's, in CSS pixels (not the device's, of which a retina screen has four times as
    // many): plenty for a rippled reflection.
    const size = renderer.getDrawingBufferSize(screen)
    const scale = 0.5 / Math.max(1, renderer.getPixelRatio())
    const w = Math.max(1, Math.floor(size.x * scale))
    const h = Math.max(1, Math.floor(size.y * scale))
    if (this.target.width !== w || this.target.height !== h) this.target.setSize(w, h)

    // The camera mirrored in the plane y = level.
    const mirror = this.mirror
    point.set(0, level, 0)
    mirror.position.copy(eye).setY(2 * level - eye.y)
    rotation.extractRotation(camera.matrixWorld)
    look.set(0, 0, -1).applyMatrix4(rotation).add(eye)
    look.y = 2 * level - look.y
    up.set(0, 1, 0).applyMatrix4(rotation).reflect(normal)
    mirror.up.copy(up)
    mirror.lookAt(look)
    mirror.fov = camera.fov
    mirror.aspect = camera.aspect
    mirror.near = camera.near
    mirror.far = camera.far
    mirror.updateProjectionMatrix()
    mirror.updateMatrixWorld()
    ;(uniforms.mirror!.value as Matrix4).copy(bias).multiply(mirror.projectionMatrix).multiply(mirror.matrixWorldInverse)

    // Above the water only: its plane becomes the mirror camera's near plane (an oblique projection, after
    // Lengyel, as three's Reflector does). Only the depth row changes, so where things land in the picture
    // (and the logarithmic depth, taken from w) stays as it was.
    this.plane.setFromNormalAndCoplanarPoint(normal, point.set(0, level + 0.05, 0)).applyMatrix4(mirror.matrixWorldInverse)
    clip.set(this.plane.normal.x, this.plane.normal.y, this.plane.normal.z, this.plane.constant)
    const m = mirror.projectionMatrix.elements
    q.set((Math.sign(clip.x) + m[8]!) / m[0]!, (Math.sign(clip.y) + m[9]!) / m[5]!, -1, (1 + m[10]!) / m[14]!)
    clip.multiplyScalar(2 / clip.dot(q))
    m[2] = clip.x
    m[6] = clip.y
    m[10] = clip.z + 1
    m[14] = clip.w
    mirror.projectionMatrixInverse.copy(mirror.projectionMatrix).invert()

    // Everything but the water itself (and what only the main view draws), without redrawing the shadows.
    const shadows = renderer.shadowMap.autoUpdate
    const before = renderer.getRenderTarget()
    this.material.visible = false
    renderer.shadowMap.autoUpdate = false
    renderer.setRenderTarget(this.target)
    renderer.clear()
    renderer.render(scene as Parameters<WebGLRenderer['render']>[0], mirror)
    renderer.setRenderTarget(before)
    renderer.shadowMap.autoUpdate = shadows
    this.material.visible = true
    uniforms.mirrored!.value = 1
  }

  dispose(): void {
    this.target.dispose()
    this.material.dispose()
  }
}
