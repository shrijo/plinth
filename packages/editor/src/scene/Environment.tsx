import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import { BackSide, Color, Fog, PerspectiveCamera, ShaderMaterial, SphereGeometry, Vector3, type Mesh } from 'three'
import { useAnalysis, useEditor, useEditorContext } from '../context.ts'
import { daylight } from './daylight.ts'
import { PALETTES } from './materials.ts'
import { Sun } from './sun.ts'

/** Room left above the tallest building before the near plane (metres). */
const CLEARANCE = 60
/** Shadows reach this many times as far as the view does (see reach). */
const SHADOW_REACH = 6

// Shared by every editor on the page: the sky and the haze.
const fog = new Fog('#ffffff', 100, 1000)
const dome = new SphereGeometry(1, 32, 16)
const target = new Vector3()
const skyMaterial = new ShaderMaterial({
  side: BackSide,
  depthWrite: false,
  depthTest: false,
  uniforms: { top: { value: new Color() }, horizon: { value: new Color() } },
  vertexShader: /* glsl */ `
    varying vec3 vDirection;
    void main() {
      vDirection = normalize(position);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform vec3 top;
    uniform vec3 horizon;
    varying vec3 vDirection;
    void main() {
      float h = clamp(vDirection.y, 0.0, 1.0);
      gl_FragColor = vec4(mix(horizon, top, pow(smoothstep(0.0, 0.75, h), 0.8)), 1.0);
      #include <colorspace_fragment>
    }`,
})

/**
 * Sky, sun and air. A gradient sky dome, sunlight with soft cascaded
 * shadows out to the haze (see sun.ts), a fill light from the sky, and
 * haze towards the horizon. The camera's depth range and the haze
 * follow the zoom, so close-ups are crisp and the whole city still fades
 * nicely into the distance.
 */
export function Environment() {
  const style = useEditor((s) => s.style)
  const hour = useEditor((s) => s.timeOfDay)
  const top = useEditor((s) => s.view === 'top')
  const buildings = useAnalysis().buildings
  const defaults = useEditor((s) => s.siteDefaults)
  // The highest anything on the site reaches: nothing above it needs drawing, so a camera high
  // above it can start drawing further out, and keep depth precise for streets and curbs.
  const tallest = useMemo(() => {
    let highest = 0
    for (const building of buildings.values()) {
      for (const level of building.levels) highest = Math.max(highest, level.level.elevation + level.level.height * level.floors)
    }
    // A building being drawn, shown at its height before it exists.
    return Math.max(highest, defaults.floors * defaults.floorHeight)
  }, [buildings, defaults])
  const palette = PALETTES[style]
  const light = useMemo(() => daylight(hour, palette), [hour, palette])
  const { controlsRef } = useEditorContext()
  const getThree = useThree((s) => s.get)
  const sun = useRef<Sun | null>(null)
  const sky = useRef<Mesh>(null)
  const lightRef = useRef(light)

  useEffect(() => {
    const { scene, camera } = getThree()
    scene.fog = fog
    if (!(camera instanceof PerspectiveCamera)) return
    const made = new Sun(camera, scene)
    const { direction, sun: colour, sunIntensity } = lightRef.current
    made.setLight(direction, colour, sunIntensity)
    sun.current = made
    return () => {
      scene.fog = null
      made.dispose()
      sun.current = null
    }
  }, [getThree])

  useEffect(() => {
    lightRef.current = light
    sun.current?.setLight(light.direction, light.sun, light.sunIntensity)
    fog.color.copy(light.skyHorizon)
    skyMaterial.uniforms.top!.value.copy(light.skyTop)
    skyMaterial.uniforms.horizon!.value.copy(light.skyHorizon)
  }, [light])

  useFrame(({ camera, scene }) => {
    const controls = controlsRef.current
    if (controls) controls.getTarget(target)
    const distance = camera.position.distanceTo(target)
    // How far the view reaches. The orbit centre can be right in front of the camera (it follows
    // what was zoomed to) while the view still looks out over the city, so height counts too.
    const reach = Math.max(distance, camera.position.y * 1.5, 60)

    // How deep in the view the nearest thing can be: high above the tallest building (the top
    // view), well out. 0.7: a point that far below is at least that deep in view, even in a
    // corner of a 24 mm view.
    const clear = Math.max(0, (camera.position.y - tallest - CLEARANCE) * 0.7)
    // Depth range: close-ups need a near plane close in; a whole city a far one further out,
    // and high above it, a near plane well out too, so streets and curbs keep their depth.
    if (camera instanceof PerspectiveCamera) {
      const near = Math.max(Math.min(Math.max(distance * 0.003, 0.05), 4), clear)
      const far = Math.max(8000, reach * 12)
      if (Math.abs(camera.near - near) > near * 0.25 || camera.far !== far) {
        camera.near = near
        camera.far = far
        camera.updateProjectionMatrix()
      }
      sky.current?.scale.setScalar(far * 0.9)
    }
    sky.current?.position.copy(camera.position)

    // Haze far off, never close by.
    fog.near = reach * 2 + 250
    fog.far = reach * 8 + 2500

    // The sun's shadow bands follow the view: out to the haze, or looking straight down, to just past the ground.
    const shadowReach = top ? camera.position.y * 1.05 + 60 : reach * SHADOW_REACH
    sun.current?.update(shadowReach, scene, clear)
  })

  return (
    <>
      <hemisphereLight args={[palette.skyLight, palette.groundLight]} intensity={light.ambientIntensity} />
      <mesh ref={sky} geometry={dome} material={skyMaterial} frustumCulled={false} renderOrder={-10} raycast={() => null} />
    </>
  )
}
