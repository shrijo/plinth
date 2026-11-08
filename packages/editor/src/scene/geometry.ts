import { toWorld, type MeshData, type Vec2 } from '@plinth/core'
import { useEffect, useMemo } from 'react'
import { BufferAttribute, BufferGeometry, Color } from 'three'

/** Mesh data with an optional colour per vertex. */
export type PaintedMesh = MeshData & { colors?: Float32Array }

/** A plan point at a height, as a three.js position tuple. */
export function worldPoint(p: Vec2, height: number): [number, number, number] {
  return toWorld(p, height)
}

/** A BufferGeometry for core mesh data, disposed when the data changes or on unmount. */
export function useBufferGeometry(data: PaintedMesh): BufferGeometry {
  const geometry = useMemo(() => toBufferGeometry(data), [data])
  useEffect(() => () => geometry.dispose(), [geometry])
  return geometry
}

export function toBufferGeometry(data: PaintedMesh): BufferGeometry {
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(data.positions, 3))
  geometry.setAttribute('normal', new BufferAttribute(data.normals, 3))
  if (data.colors) geometry.setAttribute('color', new BufferAttribute(data.colors, 3))
  geometry.setIndex(new BufferAttribute(data.indices, 1))
  geometry.computeBoundingSphere()
  geometry.computeBoundingBox()
  return geometry
}

const scratch = new Color()

/**
 * Colours every vertex by its face's normal (meshes are flat-shaded, so a
 * vertex's normal is its face's): `colourOf` gets the world normal and
 * returns a CSS colour.
 */
export function paint(data: MeshData, colourOf: (nx: number, ny: number, nz: number) => string): PaintedMesh {
  const colors = new Float32Array(data.normals.length)
  const cache = new Map<string, [number, number, number]>()
  for (let i = 0; i < data.normals.length; i += 3) {
    const css = colourOf(data.normals[i]!, data.normals[i + 1]!, data.normals[i + 2]!)
    let rgb = cache.get(css)
    if (!rgb) {
      scratch.set(css)
      rgb = [scratch.r, scratch.g, scratch.b]
      cache.set(css, rgb)
    }
    colors[i] = rgb[0]
    colors[i + 1] = rgb[1]
    colors[i + 2] = rgb[2]
  }
  return { ...data, colors }
}
