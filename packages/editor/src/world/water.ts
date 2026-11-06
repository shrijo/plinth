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
  WebGLRenderTarget,
  type Object3D,
  type WebGLRenderer,
} from 'three'

/**
 * Water: lakes, rivers and the sea, with the world mirrored in them. One
 * reflection is drawn per frame for all of it (the scene seen from below a
 * plane at the water's level, everything under the water clipped away)
 * and every water surface reads from it, rippled by waves made in the
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

  // Slope of the water from a few trains of waves, long and short, at different angles. A wave
  // shorter than a few pixels on the screen fades out, so far water doesn't shimmer into stripes.
  float pixel;
  vec2 wave(vec2 p, vec2 dir, float length, float height) {
    float k = 6.2831853 / length;
    float phase = dot(p, dir) * k + time * sqrt(9.81 * k);
    float seen = smoothstep(pixel * 3.0, pixel * 8.0, length);
    return dir * (height * k * cos(phase) * seen);
  }
  vec3 waterNormal(vec2 p) {
    vec2 slope = vec2(0.0);
    slope += wave(p, normalize(vec2(1.0, 0.3)), 23.0, 0.12);
    slope += wave(p, normalize(vec2(-0.6, 1.0)), 13.0, 0.07);
    slope += wave(p, normalize(vec2(0.2, -1.0)), 7.1, 0.04);
    slope += wave(p, normalize(vec2(-1.0, -0.4)), 3.7, 0.02);
    slope += wave(p, normalize(vec2(0.8, 0.9)), 1.9, 0.012);
    slope += wave(p, normalize(vec2(-0.3, 0.7)), 0.93, 0.006);
    return normalize(vec3(-slope.x, 1.0, -slope.y));
  }

  void main() {
    #include <logdepthbuf_fragment>
    vec2 p = vWorld.xz + offset;
    vec3 toEye = cameraPosition - vWorld;
    float distance = length(toEye);
    vec3 view = toEye / distance;
    // Metres across a pixel here (more along the view at a glancing angle).
    pixel = max(length(dFdx(vWorld.xz)), length(dFdy(vWorld.xz)));
    vec3 n = waterNormal(p);
    float facing = max(dot(n, view), 0.0);
    float fresnel = 0.02 + 0.98 * pow(1.0 - facing, 5.0);

    vec3 reflected = sky;
    if (mirrored > 0.5) {
      vec2 uv = vMirror.xy / vMirror.w;
      uv += n.xz * 0.035 / (1.0 + distance * 0.004);
      reflected = texture2D(reflection, clamp(uv, 0.001, 0.999)).rgb;
    }
    vec3 colour = mix(deep, reflected, clamp(fresnel * 0.85 + 0.25, 0.0, 1.0));
    // The sun's glint.
    vec3 halfway = normalize(sunDirection + view);
    float glint = pow(max(dot(n, halfway), 0.0), 260.0) * 3.0;
    colour += sunColor * glint;
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

export class WorldWater {
  readonly material: ShaderMaterial
  private readonly target = new WebGLRenderTarget(1, 1, { type: HalfFloatType })
  private readonly mirror = new PerspectiveCamera()
  private readonly clip = new Plane()
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
    // The size: half the screen's, plenty for a rippled reflection.
    const size = renderer.getDrawingBufferSize(screen)
    const w = Math.max(1, Math.floor(size.x / 2))
    const h = Math.max(1, Math.floor(size.y / 2))
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

    // Everything but the water itself, above the water only, without redrawing the shadows.
    this.clip.set(normal, -level + 0.05)
    const clipping = renderer.clippingPlanes
    const shadows = renderer.shadowMap.autoUpdate
    const before = renderer.getRenderTarget()
    this.material.visible = false
    renderer.clippingPlanes = [this.clip]
    renderer.shadowMap.autoUpdate = false
    renderer.setRenderTarget(this.target)
    renderer.clear()
    renderer.render(scene as Parameters<WebGLRenderer['render']>[0], mirror)
    renderer.setRenderTarget(before)
    renderer.shadowMap.autoUpdate = shadows
    renderer.clippingPlanes = clipping
    this.material.visible = true
    uniforms.mirrored!.value = 1
  }

  dispose(): void {
    this.target.dispose()
    this.material.dispose()
  }
}
