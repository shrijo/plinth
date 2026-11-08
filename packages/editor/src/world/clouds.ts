import { BlendFunction, Effect, EffectAttribute } from 'postprocessing'
import {
  Color,
  Data3DTexture,
  DataTexture,
  FloatType,
  HalfFloatType,
  LinearFilter,
  Matrix3,
  Matrix4,
  PerspectiveCamera,
  RepeatWrapping,
  ClampToEdgeWrapping,
  RGBAFormat,
  ShaderMaterial,
  Texture,
  Uniform,
  UnsignedByteType,
  Vector2,
  Vector3,
  Vector4,
  WebGLRenderTarget,
  type WebGLRenderer,
} from 'three'
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js'
import { EARTH_RADIUS_A, enuFrame, weatherAt, type CloudNoise, type Vec3, type WeatherGrid } from '@plinth/world'
import type { WorldTiles } from './WorldTiles.ts'

/**
 * Volumetric clouds over the globe: a shell of cloud round the Earth from
 * about a kilometre up to eight and a half, marched through per pixel (at
 * half the screen's resolution) and laid over the scene. How much cloud
 * there is, and how high, comes from the weather (low, middle and high
 * cloud cover; see weather.ts) or from a chosen sky; its shapes from
 * tiling 3D noise (see cloudNoise.ts), drifting with the wind. Lit by the
 * sun through itself (darker bases, a silver lining against the light) and
 * by the sky, hidden behind hills and buildings (by the depth of what's
 * drawn), and fading into the haze far off. Flying down from space goes
 * through them.
 *
 * The maths runs in a frame where the Earth is a sphere (its polar axis
 * stretched to the equator's radius) and round the camera, so heights
 * stay exact to centimetres with 32-bit numbers at the Earth's size.
 */

const POLAR_RADIUS = 6356752.314245
const STRETCH = EARTH_RADIUS_A / POLAR_RADIUS
/** Metres across one repeat of the shape noise, and of the detail noise (a sixth of it, so the wind wraps cleanly). */
const SHAPE = 9000
const DETAIL = SHAPE / 6

const COARSE = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`

const fragmentShader = /* glsl */ `
  precision highp float;
  precision highp sampler3D;
  uniform sampler2D depthTexture;
  uniform sampler3D shapeNoise;
  uniform sampler3D detailNoise;
  uniform sampler2D worldCover;
  uniform sampler2D localCover;
  uniform vec4 localBounds;
  uniform float hasLocal;
  uniform vec4 coverOverride;
  uniform float amount;
  uniform float ready;

  uniform mat4 projectionInverse;
  uniform mat4 cameraWorld;
  uniform vec3 cameraForward;
  uniform float logFar;
  uniform mat3 toEarth;
  uniform vec3 cameraEarth;
  uniform vec3 cameraUp;
  uniform float cameraHeight;
  uniform float radius;
  uniform vec3 sunEarth;
  uniform vec3 sunColor;
  uniform vec3 skyColor;
  uniform vec3 hazeColor;
  uniform float hazeNear;
  uniform float hazeFar;
  uniform vec3 wind;
  uniform float pixelAngle;
  // The threshold on the noise that leaves a given share of the sky clouded (measured from the noise itself).
  uniform float coverCurve[33];
  varying vec2 vUv;

  const float PI = 3.14159265;
  const float BOTTOM = 1000.0;
  const float TOP = 8700.0;
  const float SHAPE = ${SHAPE.toFixed(1)};
  const float DETAIL = ${DETAIL.toFixed(1)};
  const float EXTINCTION = 0.045;
  const float FURTHEST = 90000.0;

  float remap(float v, float a, float b, float c, float d) {
    return c + (v - a) / (b - a) * (d - c);
  }

  float threshold(float c) {
    float x = clamp(c, 0.0, 1.0) * 32.0;
    int i = int(min(floor(x), 31.0));
    return mix(coverCurve[i], coverCurve[i + 1], x - float(i));
  }

  // Where a ray from the camera (direction scaled into the sphere's frame) meets the sphere of a height:
  // near and far distances, or (-1, -1). Written so it stays exact at the Earth's size.
  vec2 sphere(float height, float A, float B) {
    float C = (cameraHeight - height) * (2.0 * radius + cameraHeight + height);
    float disc = B * B - A * C;
    if (disc < 0.0) return vec2(-1.0);
    float q = -(B + (B >= 0.0 ? 1.0 : -1.0) * sqrt(disc));
    float t1 = q / A;
    float t2 = C / q;
    return vec2(min(t1, t2), max(t1, t2));
  }

  // Height above the sphere at a distance along the ray.
  float heightAt(float t, float A, float B) {
    float s = cameraHeight * (2.0 * radius + cameraHeight) + 2.0 * B * t + A * t * t;
    return s / (sqrt(radius * radius + s) + radius);
  }

  vec3 coverAt(vec3 p) {
    if (coverOverride.w > 0.5) return coverOverride.xyz * amount;
    float lon = degrees(atan(p.y, p.x));
    float lat = degrees(asin(clamp(p.z / length(p), -1.0, 1.0)));
    // The world's grid: every 20 degrees from 180 W and 80 S.
    vec2 uv = vec2((lon + 180.0) / 360.0 + 0.5 / 18.0, (lat + 80.0) / 160.0 * (8.0 / 9.0) + 0.5 / 9.0);
    vec3 cover = texture2D(worldCover, uv).rgb;
    if (hasLocal > 0.5) {
      vec2 f = vec2((lon - localBounds.x) / (localBounds.z - localBounds.x), (lat - localBounds.y) / (localBounds.w - localBounds.y));
      if (f.x > 0.0 && f.x < 1.0 && f.y > 0.0 && f.y < 1.0) {
        float w = smoothstep(0.0, 0.2, min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y)));
        vec3 near = texture2D(localCover, f * (6.0 / 7.0) + 0.5 / 7.0).rgb;
        cover = mix(cover, near, w);
      }
    }
    return cover * amount;
  }

  // How much of a layer's cloud there is at a height in it: flat-bottomed, thinning towards the top
  // (cumulus build up from a level base and narrow as they rise).
  float layer(float h, float bottom, float top) {
    float f = (h - bottom) / (top - bottom);
    return smoothstep(0.0, 0.06, f) * (1.0 - smoothstep(0.3, 1.0, f));
  }

  // How dense the cloud is at a point. \`footprint\` is how many metres a pixel spans there: finer than the
  // noise shows, the noise would only flicker, so it gives way to the cloud's average (as a texture's mipmaps do).
  float density(vec3 p, float h, vec3 cover, float footprint) {
    // Low cumulus (dense), a middle layer (less so) and high cloud (thin, wispy cirrus), each as thick as its own.
    float low = cover.r * layer(h, 1100.0, 3200.0);
    float mid = cover.g * layer(h, 3400.0, 5800.0);
    float high = cover.b * layer(h, 7800.0, 8600.0);
    float c = max(low, max(mid, high));
    if (c < 0.01) return 0.0;
    float thickness = low >= mid && low >= high ? 1.0 : mid >= high ? 0.5 : 0.006;
    // From afar the cloud shows as much of the ground as its cover leaves: through 1.8 km of it, a share 1 - c gets through.
    float average = -log(1.0 - min(c, 0.98) * 0.95) / (EXTINCTION * 1800.0) * min(thickness * 2.0, 1.0);
    float blend = smoothstep(SHAPE / 40.0, SHAPE / 4.0, footprint);
    if (blend > 0.99) return average;
    vec3 q = p + wind;
    vec4 n = texture(shapeNoise, q / SHAPE);
    float fbm = n.g * 0.625 + n.b * 0.25 + n.a * 0.125;
    float base = remap(n.r, fbm - 1.0, 1.0, 0.0, 1.0);
    // A full deck still has a lumpy top: the cover thins where the billows are low.
    float lumpy = c * mix(1.0, 0.55 + 0.6 * n.g, smoothstep(0.85, 1.0, c));
    float d = clamp(remap(base, threshold(lumpy), 1.0, 0.0, 1.0), 0.0, 1.0) * sqrt(c) * thickness;
    float fine = 1.0 - smoothstep(DETAIL / 24.0, DETAIL / 6.0, footprint);
    if (fine > 0.0 && d > 0.0) {
      vec3 e = texture(detailNoise, q / DETAIL).rgb;
      float wisps = e.r * 0.625 + e.g * 0.25 + e.b * 0.125;
      d = mix(d, clamp(remap(d, wisps * 0.3, 1.0, 0.0, 1.0), 0.0, 1.0), fine);
    }
    return mix(d, average, blend);

  }

  float hg(float c, float g) {
    float g2 = g * g;
    return (1.0 - g2) / pow(1.0 + g2 - 2.0 * g * c, 1.5);
  }

  void main() {
    if (ready < 0.5) {
      gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
      return;
    }
    // The pixel's ray, and how far it goes before it meets something drawn.
    vec4 view = projectionInverse * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
    vec3 dir = normalize((cameraWorld * vec4(view.xyz / view.w, 0.0)).xyz);
    float depth = texture2D(depthTexture, vUv).r;
    float drawn = depth >= 0.9999999 ? 1e12 : (exp2(depth * logFar) - 1.0) / max(dot(dir, cameraForward), 1e-4);

    vec3 ds = toEarth * dir;
    float A = dot(ds, ds);
    float B = (radius + cameraHeight) * dot(cameraUp, ds);
    vec2 inner = sphere(BOTTOM, A, B);
    vec2 outer = sphere(TOP, A, B);
    vec2 ground = sphere(0.0, A, B);
    float start;
    float end;
    if (cameraHeight < BOTTOM) {
      start = inner.y;
      end = outer.y;
      if (ground.x > 0.0 && ground.x < start) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
    } else if (cameraHeight < TOP) {
      start = 0.0;
      end = inner.x > 0.0 ? inner.x : outer.y;
    } else {
      if (outer.x < 0.0) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
      start = outer.x;
      end = inner.x > 0.0 ? inner.x : outer.y;
    }
    end = min(min(end, drawn), start + FURTHEST);
    if (end <= start) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }

    // March, in steps that lengthen with distance (far cloud is smooth; see density), starting each pixel a
    // little differently (against banding).
    float span = end - start;
    float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    float cosine = dot(normalize(ds), sunEarth);
    // Light scattered forward (a silver lining against the sun), some back, and plenty every way: inside a
    // cloud light bounces many times, which is what makes cloud white from every side.
    float phase = mix(hg(cosine, 0.65), hg(cosine, -0.2), 0.35) * 0.6 + 0.55;
    vec3 light = vec3(0.0);
    float transmittance = 1.0;
    float weight = 0.0;
    float far = 0.0;
    float t = start + clamp(max(start * 0.025, span / 140.0), 35.0, 2500.0) * jitter;
    vec3 cover = coverAt(cameraEarth + ds * (start + span * 0.5));
    for (int i = 0; i < 180; i++) {
      if (t > end || transmittance < 0.02) break;
      float stepLength = clamp(max(t * 0.025, span / 140.0), 35.0, 2500.0);
      vec3 p = cameraEarth + ds * t;
      float h = heightAt(t, A, B);
      if (i % 8 == 0) cover = coverAt(p);
      float footprint = t * pixelAngle;
      float d = density(p, h, cover, footprint);
      if (d > 0.002) {
        // Towards the sun: how much cloud the light comes through.
        float above = 0.0;
        float reach = 60.0 + footprint * 0.5;
        float walked = 0.0;
        for (int k = 0; k < 5; k++) {
          walked += reach;
          vec3 q = p + sunEarth * walked;
          float hq = h + walked * dot(normalize(p), sunEarth);
          above += density(q, hq, cover, footprint + walked * 0.1) * reach;
          reach *= 2.0;
        }
        float od = above * EXTINCTION;
        // Straight through, and light that has bounced on its way (it comes through more cloud, softened).
        float sun = exp(-od) * phase + exp(-od * 0.3) * 0.4 + exp(-od * 0.08) * 0.1;
        float powder = 1.0 - exp(-d * 6.0);
        float rise = clamp((h - BOTTOM) / 2500.0, 0.0, 1.0);
        vec3 luminance = sunColor * sun * mix(0.7, 1.0, powder) + skyColor * mix(0.55, 0.95, rise);
        float through = exp(-d * EXTINCTION * stepLength);
        float taken = transmittance * (1.0 - through);
        light += taken * luminance;
        weight += taken;
        far += taken * t;
        transmittance *= through;
      }
      t += stepLength;
    }
    // Far cloud fades into the haze.
    if (weight > 0.0) {
      float haze = smoothstep(hazeNear, hazeFar, far / weight);
      light = mix(light, hazeColor * (1.0 - transmittance), haze);
    }
    gl_FragColor = vec4(light, transmittance);
  }
`

const composite = /* glsl */ `
  uniform sampler2D clouds;
  uniform vec2 cloudTexel;
  void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
    // A soft five-tap blur over the clouds' own pixels smooths the march's dither away.
    vec4 c = texture2D(clouds, uv) * 0.36;
    c += texture2D(clouds, uv + cloudTexel * vec2(0.9, 0.5)) * 0.16;
    c += texture2D(clouds, uv + cloudTexel * vec2(-0.5, 0.9)) * 0.16;
    c += texture2D(clouds, uv + cloudTexel * vec2(-0.9, -0.5)) * 0.16;
    c += texture2D(clouds, uv + cloudTexel * vec2(0.5, -0.9)) * 0.16;
    outputColor = vec4(inputColor.rgb * c.a + c.rgb, inputColor.a);
  }
`

/** A chosen sky: how much low, middle and high cloud (0 to 1). */
export type Sky = [low: number, mid: number, high: number]

export const SKIES: Record<'fair' | 'mixed' | 'overcast', Sky> = {
  fair: [0.38, 0.05, 0.2],
  mixed: [0.55, 0.45, 0.35],
  overcast: [0.97, 0.75, 0.3],
}

const eye = new Vector3()
const forward = new Vector3()
const axis = new Vector3()

export class CloudsEffect extends Effect {
  private readonly material: ShaderMaterial
  private readonly quad: FullScreenQuad
  private target: WebGLRenderTarget
  private readonly scale = COARSE ? 0.34 : 0.5
  private noise: { shape: Data3DTexture; detail: Data3DTexture } | null = null
  private worldTexture: DataTexture | null = null
  private localTexture: DataTexture | null = null
  private wind: Vec3 = [0, 0, 0]
  private windOffset: Vec3 = [0, 0, 0]
  private worker: Worker | null = null
  /** Let go of, and to be made again if it's used once more (React may mount a view twice while developing). */
  private released = false

  constructor() {
    super('CloudsEffect', composite, {
      attributes: EffectAttribute.DEPTH,
      blendFunction: BlendFunction.SRC,
      uniforms: new Map<string, Uniform>([
        ['clouds', new Uniform(null)],
        ['cloudTexel', new Uniform(new Vector2(1, 1))],
      ]),
    })
    this.target = new WebGLRenderTarget(1, 1, { type: HalfFloatType, depthBuffer: false })
    this.uniforms.get('clouds')!.value = this.target.texture
    this.material = new ShaderMaterial({
      vertexShader,
      fragmentShader,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        depthTexture: { value: null },
        shapeNoise: { value: null },
        detailNoise: { value: null },
        worldCover: { value: null },
        localCover: { value: null },
        localBounds: { value: new Vector4() },
        hasLocal: { value: 0 },
        coverOverride: { value: new Vector4(...SKIES.fair, 1) },
        amount: { value: 0.03 },
        ready: { value: 0 },
        projectionInverse: { value: new Matrix4() },
        cameraWorld: { value: new Matrix4() },
        cameraForward: { value: new Vector3() },
        logFar: { value: 1 },
        toEarth: { value: new Matrix3() },
        cameraEarth: { value: new Vector3() },
        cameraUp: { value: new Vector3() },
        cameraHeight: { value: 0 },
        radius: { value: EARTH_RADIUS_A },
        sunEarth: { value: new Vector3(0, 0, 1) },
        sunColor: { value: new Color() },
        skyColor: { value: new Color() },
        hazeColor: { value: new Color() },
        hazeNear: { value: 1e9 },
        hazeFar: { value: 2e9 },
        wind: { value: new Vector3() },
        pixelAngle: { value: 0.001 },
        coverCurve: { value: Array.from({ length: 33 }, (_, k) => 1 - k / 32) },
      },
    })
    this.quad = new FullScreenQuad(this.material)
    this.makeNoise()
  }

  /** Has the noise made in a worker. */
  private makeNoise(): void {
    this.worker = new Worker(new URL('./cloudNoise.worker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = (event: MessageEvent<CloudNoise>) => this.setNoise(event.data)
    this.worker.postMessage(null)
  }

  private setNoise(noise: CloudNoise): void {
    const texture = (data: Uint8Array, size: number) => {
      const t = new Data3DTexture(data, size, size, size)
      t.format = RGBAFormat
      t.type = UnsignedByteType
      t.minFilter = t.magFilter = LinearFilter
      t.wrapS = t.wrapT = t.wrapR = RepeatWrapping
      t.unpackAlignment = 1
      t.needsUpdate = true
      return t
    }
    this.noise = { shape: texture(noise.shape, noise.shapeSize), detail: texture(noise.detail, noise.detailSize) }
    this.material.uniforms.coverCurve!.value = coverCurve(noise)
    this.material.uniforms.shapeNoise!.value = this.noise.shape
    this.material.uniforms.detailNoise!.value = this.noise.detail
    this.material.uniforms.ready!.value = this.worldTexture || this.material.uniforms.coverOverride!.value.w > 0.5 ? 1 : 0
    this.worker?.terminate()
    this.worker = null
  }

  override setDepthTexture(depthTexture: Texture): void {
    this.material.uniforms.depthTexture!.value = depthTexture
  }

  override setSize(width: number, height: number): void {
    const w = Math.max(1, Math.ceil(width * this.scale))
    const h = Math.max(1, Math.ceil(height * this.scale))
    this.target.setSize(w, h)
    ;(this.uniforms.get('cloudTexel')!.value as Vector2).set(1 / w, 1 / h)
  }

  override update(renderer: WebGLRenderer): void {
    if (this.released) {
      // Used again after being let go of: made again.
      this.released = false
      const { width, height } = this.target
      this.target = new WebGLRenderTarget(width, height, { type: HalfFloatType, depthBuffer: false })
      this.uniforms.get('clouds')!.value = this.target.texture
      this.material.uniforms.ready!.value = 0
      this.noise = null
      this.makeNoise()
    }
    renderer.setRenderTarget(this.target)
    this.quad.render(renderer)
  }

  /** The sky to show: the weather's (live), or a chosen one. */
  setSky(sky: Sky | 'live'): void {
    const override = this.material.uniforms.coverOverride!.value as Vector4
    if (sky === 'live') override.w = 0
    else override.set(sky[0], sky[1], sky[2], 1)
    this.material.uniforms.ready!.value = this.noise && (this.worldTexture || override.w > 0.5) ? 1 : 0
  }

  /** How much of the cloud to show: its cover scaled by this (0 to 1). */
  setAmount(amount: number): void {
    this.material.uniforms.amount!.value = Math.min(Math.max(amount, 0), 1)
  }

  /** The weather's grids: the whole world's, and the finer one round the view. */
  setWeather(world: WeatherGrid | null, local: WeatherGrid | null): void {
    const texture = (grid: WeatherGrid, wrap: boolean) => {
      const data = new Float32Array(grid.columns * grid.rows * 4)
      for (let i = 0; i < grid.columns * grid.rows; i++) {
        data[i * 4] = grid.cover[i * 3]!
        data[i * 4 + 1] = grid.cover[i * 3 + 1]!
        data[i * 4 + 2] = grid.cover[i * 3 + 2]!
        data[i * 4 + 3] = 1
      }
      const t = new DataTexture(data, grid.columns, grid.rows, RGBAFormat, FloatType)
      t.minFilter = t.magFilter = LinearFilter
      t.wrapS = wrap ? RepeatWrapping : ClampToEdgeWrapping
      t.wrapT = ClampToEdgeWrapping
      t.needsUpdate = true
      return t
    }
    const uniforms = this.material.uniforms
    if (world) {
      this.worldTexture?.dispose()
      this.worldTexture = texture(world, true)
      uniforms.worldCover!.value = this.worldTexture
    }
    this.localTexture?.dispose()
    this.localTexture = local ? texture(local, false) : null
    uniforms.localCover!.value = this.localTexture
    uniforms.hasLocal!.value = local ? 1 : 0
    if (local) (uniforms.localBounds!.value as Vector4).set(local.west, local.south, local.east, local.north)
    uniforms.ready!.value = this.noise && (this.worldTexture || (uniforms.coverOverride!.value as Vector4).w > 0.5) ? 1 : 0
  }

  /** The wind where the view is (metres a second east and north), for the clouds' drift. */
  setWind(lon: number, lat: number, east: number, north: number): void {
    const frame = enuFrame(lon, lat, 0)
    this.wind = [0, 1, 2].map((k) => frame.east[k]! * east + frame.north[k]! * north) as Vec3
  }

  /**
   * Fits the clouds to the view: the camera, where the Earth is, the sun and
   * sky, the haze. Call every frame before the scene is drawn.
   */
  setView(
    camera: PerspectiveCamera,
    world: WorldTiles,
    light: { direction: Vector3; sun: Color; sunIntensity: number; skyTop: Color; skyHorizon: Color },
    haze: { color: Color; near: number; far: number },
    seconds: number,
  ): void {
    const u = this.material.uniforms
    camera.updateMatrixWorld()
    ;(u.projectionInverse!.value as Matrix4).copy(camera.projectionMatrixInverse)
    ;(u.cameraWorld!.value as Matrix4).copy(camera.matrixWorld)
    ;(u.cameraForward!.value as Vector3).copy(camera.getWorldDirection(forward))
    u.logFar!.value = Math.log2(camera.far + 1)
    // How wide a pixel of the clouds is, as an angle (they're drawn at a fraction of the screen's size).
    u.pixelAngle!.value = (2 * Math.tan((camera.fov * Math.PI) / 360)) / Math.max(this.target.height, 1)
    // Scene directions into the stretched Earth frame (the polar axis scaled up to make it a sphere).
    const column = (x: number, y: number, z: number) => {
      const d = world.directionToEcef(axis.set(x, y, z))
      return [d[0], d[1], d[2] * STRETCH] as const
    }
    const [cx, cy, cz] = [column(1, 0, 0), column(0, 1, 0), column(0, 0, 1)]
    ;(u.toEarth!.value as Matrix3).set(cx[0], cy[0], cz[0], cx[1], cy[1], cz[1], cx[2], cy[2], cz[2])
    const ecef = world.toEcef(camera.getWorldPosition(eye))
    const stretched: Vec3 = [ecef[0], ecef[1], ecef[2] * STRETCH]
    const distance = Math.hypot(...stretched)
    ;(u.cameraEarth!.value as Vector3).set(...stretched)
    ;(u.cameraUp!.value as Vector3).set(stretched[0] / distance, stretched[1] / distance, stretched[2] / distance)
    u.cameraHeight!.value = distance - EARTH_RADIUS_A
    const sun = column(light.direction.x, light.direction.y, light.direction.z)
    const sunLength = Math.hypot(...sun)
    ;(u.sunEarth!.value as Vector3).set(sun[0] / sunLength, sun[1] / sunLength, sun[2] / sunLength)
    ;(u.sunColor!.value as Color).copy(light.sun).multiplyScalar(light.sunIntensity * 0.55)
    ;(u.skyColor!.value as Color).copy(light.skyTop).lerp(light.skyHorizon, 0.4).multiplyScalar(0.85)
    ;(u.hazeColor!.value as Color).copy(haze.color)
    u.hazeNear!.value = haze.near
    u.hazeFar!.value = haze.far
    // Drift with the wind, folded so the numbers stay small (the noise repeats every SHAPE metres).
    for (let k = 0; k < 3; k++) this.windOffset[k] = (this.windOffset[k]! - this.wind[k]! * seconds) % SHAPE
    ;(u.wind!.value as Vector3).set(...this.windOffset)
  }

  /** Lets go of the GPU's resources and the worker (made again if it's used once more). */
  release(): void {
    if (this.released) return
    this.released = true
    this.worker?.terminate()
    this.worker = null
    this.target.dispose()
    this.noise?.shape.dispose()
    this.noise?.detail.dispose()
    this.worldTexture?.dispose()
    this.localTexture?.dispose()
  }
}

/**
 * For each share of sky covered (0, 1/32, ... 1), the threshold on the
 * clouds' base noise above which that share of it lies, so a cover of 68%
 * leaves 32% clear (the noise's values aren't spread evenly).
 */
function coverCurve(noise: CloudNoise): number[] {
  const { shape } = noise
  const count = shape.length / 4
  const values = new Float32Array(Math.ceil(count / 3))
  for (let i = 0, k = 0; i < count; i += 3, k++) {
    const r = shape[i * 4]! / 255
    const fbm = (shape[i * 4 + 1]! * 0.625 + shape[i * 4 + 2]! * 0.25 + shape[i * 4 + 3]! * 0.125) / 255
    values[k] = (r - (fbm - 1)) / (1 - (fbm - 1))
  }
  values.sort()
  return Array.from({ length: 33 }, (_, k) => {
    if (k === 0) return values[values.length - 1]! + 1e-3
    if (k === 32) return values[0]! - 1e-3
    return values[Math.min(values.length - 1, Math.floor((1 - k / 32) * values.length))]!
  })
}

/** The wind at a point from the weather, if there's any. */
export function windAt(grid: WeatherGrid | null, lon: number, lat: number): { east: number; north: number } | null {
  if (!grid) return null
  const w = weatherAt(grid, lon, lat)
  return { east: w.east, north: w.north }
}
