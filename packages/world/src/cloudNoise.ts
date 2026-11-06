/**
 * Noise for volumetric clouds, as 3D textures that tile in every direction
 * (Schneider's recipe for Horizon Zero Dawn's clouds, "Nubis"): a shape
 * texture whose first channel is Perlin noise made billowy by Worley noise
 * and whose others are Worley noise at rising frequencies, and a smaller
 * detail texture of finer Worley noise to wear the edges away.
 */

export interface CloudNoise {
  shapeSize: number
  /** RGBA, shapeSize³ texels. */
  shape: Uint8Array
  detailSize: number
  /** RGBA, detailSize³ texels (alpha unused). */
  detail: Uint8Array
}

/** A small, fast, seeded random generator (mulberry32). */
function random(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Worley (cellular) noise that tiles: one random point per cell of an n³
 * grid over the unit cube, and at each texel the distance to the nearest
 * point (wrapping round), inverted so cells are bright. size³ values.
 */
function worley(size: number, n: number, seed: number): Float32Array {
  const next = random(seed)
  const points = new Float32Array(n * n * n * 3)
  for (let i = 0; i < points.length; i++) points[i] = next()
  const out = new Float32Array(size * size * size)
  for (let z = 0; z < size; z++) {
    const pz = ((z + 0.5) / size) * n
    const cz = Math.floor(pz)
    for (let y = 0; y < size; y++) {
      const py = ((y + 0.5) / size) * n
      const cy = Math.floor(py)
      for (let x = 0; x < size; x++) {
        const px = ((x + 0.5) / size) * n
        const cx = Math.floor(px)
        let best = 9
        for (let dz = -1; dz <= 1; dz++) {
          const kz = (cz + dz + n) % n
          for (let dy = -1; dy <= 1; dy++) {
            const ky = (cy + dy + n) % n
            for (let dx = -1; dx <= 1; dx++) {
              const kx = (cx + dx + n) % n
              const k = ((kz * n + ky) * n + kx) * 3
              const fx = cx + dx + points[k]! - px
              const fy = cy + dy + points[k + 1]! - py
              const fz = cz + dz + points[k + 2]! - pz
              const d = fx * fx + fy * fy + fz * fz
              if (d < best) best = d
            }
          }
        }
        out[(z * size + y) * size + x] = 1 - Math.min(Math.sqrt(best), 1)
      }
    }
  }
  return out
}

/** Gradient (Perlin) noise that tiles over a period of n lattice cells. */
function perlin(size: number, n: number, seed: number): Float32Array {
  const next = random(seed)
  const gradients = new Float32Array(n * n * n * 3)
  for (let i = 0; i < n * n * n; i++) {
    // Random unit vectors.
    const t = next() * Math.PI * 2
    const u = next() * 2 - 1
    const r = Math.sqrt(1 - u * u)
    gradients[i * 3] = r * Math.cos(t)
    gradients[i * 3 + 1] = r * Math.sin(t)
    gradients[i * 3 + 2] = u
  }
  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10)
  const out = new Float32Array(size * size * size)
  for (let z = 0; z < size; z++) {
    const pz = (z / size) * n
    const z0 = Math.floor(pz)
    const fz = pz - z0
    for (let y = 0; y < size; y++) {
      const py = (y / size) * n
      const y0 = Math.floor(py)
      const fy = py - y0
      for (let x = 0; x < size; x++) {
        const px = (x / size) * n
        const x0 = Math.floor(px)
        const fx = px - x0
        const corner = (ix: number, iy: number, iz: number) => {
          const k = ((((z0 + iz) % n) * n + ((y0 + iy) % n)) * n + ((x0 + ix) % n)) * 3
          return gradients[k]! * (fx - ix) + gradients[k + 1]! * (fy - iy) + gradients[k + 2]! * (fz - iz)
        }
        const u = fade(fx)
        const v = fade(fy)
        const w = fade(fz)
        const lerp = (a: number, b: number, t: number) => a + (b - a) * t
        const value = lerp(
          lerp(lerp(corner(0, 0, 0), corner(1, 0, 0), u), lerp(corner(0, 1, 0), corner(1, 1, 0), u), v),
          lerp(lerp(corner(0, 0, 1), corner(1, 0, 1), u), lerp(corner(0, 1, 1), corner(1, 1, 1), u), v),
          w,
        )
        out[(z * size + y) * size + x] = value
      }
    }
  }
  return out
}

const remap = (v: number, a: number, b: number, c: number, d: number) => c + ((v - a) / (b - a)) * (d - c)
const clamp01 = (v: number) => Math.min(Math.max(v, 0), 1)

export function makeCloudNoise(shapeSize = 64, detailSize = 32): CloudNoise {
  const s = shapeSize
  // Worley at rising frequencies, shared between the channels.
  const w: Record<number, Float32Array> = {}
  for (const f of [4, 8, 16, 32]) w[f] = worley(s, f, 17 + f)
  const fbm = (a: Float32Array, b: Float32Array, c: Float32Array, i: number) => a[i]! * 0.625 + b[i]! * 0.25 + c[i]! * 0.125
  const p1 = perlin(s, 4, 3)
  const p2 = perlin(s, 8, 5)
  const p3 = perlin(s, 16, 7)
  const shape = new Uint8Array(s * s * s * 4)
  for (let i = 0; i < s * s * s; i++) {
    const perlinFbm = clamp01((p1[i]! + p2[i]! * 0.5 + p3[i]! * 0.25) * 0.7 + 0.5)
    const worleyFbm = fbm(w[4]!, w[8]!, w[16]!, i)
    // Perlin-Worley: Perlin's soft shapes, pushed up by Worley's billows.
    const pw = clamp01(remap(perlinFbm, 0, 1, worleyFbm, 1))
    shape[i * 4] = Math.round(pw * 255)
    shape[i * 4 + 1] = Math.round(clamp01(worleyFbm) * 255)
    shape[i * 4 + 2] = Math.round(clamp01(fbm(w[8]!, w[16]!, w[32]!, i)) * 255)
    shape[i * 4 + 3] = Math.round(clamp01(w[16]![i]! * 0.75 + w[32]![i]! * 0.25) * 255)
  }
  const d = detailSize
  const d1 = worley(d, 2, 41)
  const d2 = worley(d, 4, 43)
  const d3 = worley(d, 8, 47)
  const d4 = worley(d, 16, 53)
  const detail = new Uint8Array(d * d * d * 4)
  for (let i = 0; i < d * d * d; i++) {
    detail[i * 4] = Math.round(clamp01(fbm(d1, d2, d3, i)) * 255)
    detail[i * 4 + 1] = Math.round(clamp01(fbm(d2, d3, d4, i)) * 255)
    detail[i * 4 + 2] = Math.round(clamp01(d3[i]! * 0.75 + d4[i]! * 0.25) * 255)
    detail[i * 4 + 3] = 255
  }
  return { shapeSize: s, shape, detailSize: d, detail }
}
