import { Color, ShaderMaterial } from 'three'

const cache = new Map<string, ShaderMaterial>()

/**
 * Round handles for points, drawn on top of everything: a filled dot with
 * a darker ring, so they read on light and dark surfaces alike. `size` is
 * in pixels.
 */
export function handleMaterial(fill: string, ring: string, size: number): ShaderMaterial {
  const key = `${fill}|${ring}|${size}`
  let material = cache.get(key)
  if (!material) {
    material = new ShaderMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        fill: { value: new Color(fill) },
        ring: { value: new Color(ring) },
        size: { value: size * Math.min(window.devicePixelRatio || 1, 2) },
      },
      vertexShader: /* glsl */ `
        uniform float size;
        void main() {
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 fill;
        uniform vec3 ring;
        void main() {
          float d = length(gl_PointCoord - 0.5) * 2.0;
          if (d > 1.0) discard;
          vec3 colour = d < 0.62 ? fill : ring;
          float alpha = 1.0 - smoothstep(0.86, 1.0, d);
          gl_FragColor = vec4(colour, alpha);
          #include <colorspace_fragment>
        }`,
    })
    cache.set(key, material)
  }
  return material
}
