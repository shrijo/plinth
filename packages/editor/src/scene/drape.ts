import type { PaintedMesh } from './geometry.ts'

/**
 * Laying flat meshes (streets) over the terrain: triangles are split until
 * no edge is longer than `step` across the ground, then every point is
 * raised by the ground's height under it, and faces turned to their new
 * slope.
 */
export function drapeMesh<M extends PaintedMesh>(mesh: M, heightAt: (x: number, y: number) => number | null, step = 6): M {
  const { positions: p, indices } = mesh
  const c = mesh.colors
  const outP: number[] = []
  const outC: number[] = []
  const vertex = (k: number): number[] => [p[k * 3]!, p[k * 3 + 1]!, p[k * 3 + 2]!, ...(c ? [c[k * 3]!, c[k * 3 + 1]!, c[k * 3 + 2]!] : [])]
  const mid = (a: number[], b: number[]) => a.map((v, i) => (v + b[i]!) / 2)
  const across = (a: number[], b: number[]) => Math.hypot(a[0]! - b[0]!, a[2]! - b[2]!)
  const emit = (a: number[], b: number[], cc: number[], depth: number) => {
    const ab = across(a, b)
    const bc = across(b, cc)
    const ca = across(cc, a)
    const longest = Math.max(ab, bc, ca)
    if (longest > step && depth < 14) {
      // Split the longest edge in two.
      if (longest === ab) {
        const m = mid(a, b)
        emit(a, m, cc, depth + 1)
        emit(m, b, cc, depth + 1)
      } else if (longest === bc) {
        const m = mid(b, cc)
        emit(a, b, m, depth + 1)
        emit(a, m, cc, depth + 1)
      } else {
        const m = mid(cc, a)
        emit(a, b, m, depth + 1)
        emit(m, b, cc, depth + 1)
      }
      return
    }
    for (const v of [a, b, cc]) {
      outP.push(v[0]!, v[1]!, v[2]!)
      if (c) outC.push(v[3]!, v[4]!, v[5]!)
    }
  }
  for (let t = 0; t < indices.length; t += 3) emit(vertex(indices[t]!), vertex(indices[t + 1]!), vertex(indices[t + 2]!), 0)
  const count = outP.length / 3
  const positions = new Float32Array(outP)
  for (let k = 0; k < count; k++) {
    const h = heightAt(positions[k * 3]!, -positions[k * 3 + 2]!)
    if (h !== null) positions[k * 3 + 1] = positions[k * 3 + 1]! + h
  }
  const normals = new Float32Array(count * 3)
  for (let k = 0; k < count; k += 3) {
    const ax = positions[k * 3]!
    const ay = positions[k * 3 + 1]!
    const az = positions[k * 3 + 2]!
    const ux = positions[k * 3 + 3]! - ax
    const uy = positions[k * 3 + 4]! - ay
    const uz = positions[k * 3 + 5]! - az
    const vx = positions[k * 3 + 6]! - ax
    const vy = positions[k * 3 + 7]! - ay
    const vz = positions[k * 3 + 8]! - az
    let nx = uy * vz - uz * vy
    let ny = uz * vx - ux * vz
    let nz = ux * vy - uy * vx
    const l = Math.hypot(nx, ny, nz) || 1
    nx /= l
    ny /= l
    nz /= l
    for (let j = 0; j < 3; j++) normals.set([nx, ny, nz], (k + j) * 3)
  }
  const out: PaintedMesh = { positions, normals, indices: Uint32Array.from({ length: count }, (_, i) => i) }
  if (c) out.colors = new Float32Array(outC)
  return out as M
}
