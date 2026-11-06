import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { BackSide, Color, Fog, PerspectiveCamera, ShaderMaterial, SphereGeometry, Vector3, type Mesh } from 'three'
import { ATTRIBUTION, ecefFromLonLat, enuFrame, fromFrame, searchPlaces, type Place } from '@plinth/world'
import { daylight, DEFAULT_HOUR } from '../scene/daylight.ts'
import { PALETTES } from '../scene/materials.ts'
import { Sun } from '../scene/sun.ts'
import { DEFAULT_VIEW, GlobeControls, type GlobeView } from './globeControls.ts'
import { WorldTiles } from './WorldTiles.ts'
import '../editor.css'
import './explorer.css'

/**
 * The world, to look round and to start sites from: the globe with every
 * street and building on it, made as the view needs them from open map
 * data. Search flies to a place; "Make a site here" marks out a square of
 * the ground to turn into a site of its own.
 */

/** The square of the world a site is made from. */
export interface WorldArea {
  lon: number
  lat: number
  /** Its side, in metres. */
  size: number
  /** What the place is called, if a search found it. */
  name: string | null
}

export interface WorldExplorerProps {
  initialView?: Partial<GlobeView>
  /** Told of the view now and then (for keeping it in the address). */
  onViewChange?: (view: GlobeView) => void
  /** Makes a site from an area; the explorer waits on it, showing how it's going (as `report` tells it). */
  onMakeSite: (area: WorldArea, report: (text: string) => void) => Promise<void>
}

const MIN_SIZE = 100
const MAX_SIZE = 1000
const DEFAULT_SIZE = 300

export function WorldExplorer({ initialView, onViewChange, onMakeSite }: WorldExplorerProps) {
  const controlsRef = useRef<GlobeControls | null>(null)
  const outline = useRef<SVGPolygonElement>(null)
  const [choosing, setChoosing] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<string | null>(null)
  const [name, setName] = useState<string | null>(null)
  const [close, setClose] = useState(false)
  const view = useMemo(() => ({ ...DEFAULT_VIEW, ...initialView }), [initialView])
  const keepControls = useCallback((controls: GlobeControls | null) => {
    controlsRef.current = controls
  }, [])

  const startChoosing = () => {
    const controls = controlsRef.current
    if (!controls) return
    setError(null)
    setChoosing(DEFAULT_SIZE)
    // Straight down, north up, with the square filling about half the view.
    controls.flyTo({ heading: 0, pitch: 0, range: controls.rangeToFit(DEFAULT_SIZE) }, 1)
  }

  const make = async () => {
    const controls = controlsRef.current
    if (!controls || choosing === null) return
    setBusy(true)
    setError(null)
    try {
      await onMakeSite({ lon: controls.view.lon, lat: controls.view.lat, size: choosing, name }, setProgress)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
      setProgress(null)
    }
  }

  return (
    <div className="plinth-editor pw-explorer">
      <Canvas
        className="pe-canvas"
        gl={{ logarithmicDepthBuffer: true, antialias: true }}
        camera={{ fov: 40, near: 1, far: 1e8, position: [0, 1e7, 0] }}
        shadows
        dpr={[1, 2]}
      >
        <ExplorerScene onControls={keepControls} initial={view} outline={outline} choosing={choosing} onView={onViewChange} onClose={setClose} />
      </Canvas>
      {choosing !== null && (
        <svg className="pw-overlay" aria-hidden="true">
          <polygon ref={outline} className="pw-square" />
        </svg>
      )}
      <Search
        onPlace={(place) => {
          setName(place.name)
          // Close enough to see the place whole, tilted a little once near the ground.
          const range = Math.min(Math.max(place.size * 2.2, 600), 2.2e7)
          controlsRef.current?.flyTo({ lon: place.lon, lat: place.lat, range, heading: 0, pitch: range < 20000 ? 0.75 : 0 })
        }}
      />
      <div className="pw-dock">
        {choosing === null ? (
          <button
            type="button"
            className="pw-primary"
            onClick={startChoosing}
            disabled={!close}
            title={close ? 'Mark out a square of the ground to make a site from' : 'Come closer to the ground first'}
          >
            Make a site here
          </button>
        ) : (
          <div className="pw-panel" role="group" aria-label="Site area">
            <label className="pw-size">
              <span>Square</span>
              <input
                type="range"
                min={MIN_SIZE}
                max={MAX_SIZE}
                step={50}
                value={choosing}
                disabled={busy}
                onChange={(e) => {
                  const size = Number(e.target.value)
                  setChoosing(size)
                  // Keep the whole square in sight.
                  const controls = controlsRef.current
                  if (controls && controls.view.range < controls.rangeToFit(size, 0.8)) controls.view.range = controls.rangeToFit(size, 0.8)
                }}
              />
              <output>{choosing} m</output>
            </label>
            <div className="pw-actions">
              <button type="button" className="pw-secondary" onClick={() => setChoosing(null)} disabled={busy}>
                Cancel
              </button>
              <button type="button" className="pw-primary" onClick={() => void make()} disabled={busy}>
                {busy ? 'Making the site…' : 'Make site'}
              </button>
            </div>
            <p className="pw-hint" role={busy ? 'status' : undefined} data-error={error ? true : undefined}>
              {error ??
                (busy ? progress : null) ??
                'Streets, buildings and the lie of the land in the square become a site you can edit. Move the map to place it.'}
            </p>
          </div>
        )}
      </div>
      <div className="pw-credit">{ATTRIBUTION}</div>
    </div>
  )
}

function Search({ onPlace }: { onPlace: (place: Place) => void }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Place[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [failed, setFailed] = useState(false)
  const abort = useRef<AbortController | null>(null)

  const search = async () => {
    abort.current?.abort()
    const controller = new AbortController()
    abort.current = controller
    setSearching(true)
    setFailed(false)
    try {
      const places = await searchPlaces(query, controller.signal)
      if (controller.signal.aborted) return
      if (places.length === 1) {
        onPlace(places[0]!)
        setResults(null)
      } else setResults(places)
    } catch {
      if (!controller.signal.aborted) setFailed(true)
    } finally {
      if (!controller.signal.aborted) setSearching(false)
    }
  }

  return (
    <div className="pw-search">
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void search()
        }}
      >
        <input
          type="search"
          placeholder="Search for a place or address"
          aria-label="Search for a place"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setResults(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setResults(null)
          }}
        />
        {searching && <span className="pw-spinner" aria-label="Searching" />}
      </form>
      {(results || failed) && (
        <ul className="pw-results" role="listbox">
          {failed && <li className="pw-empty">Search isn't answering. Check the connection and try again.</li>}
          {results?.length === 0 && <li className="pw-empty">Nothing found by that name.</li>}
          {results?.map((place, i) => (
            <li key={`${place.lon},${place.lat},${i}`}>
              <button
                type="button"
                role="option"
                aria-selected={false}
                onClick={() => {
                  onPlace(place)
                  setResults(null)
                }}
              >
                <strong>{place.name}</strong>
                {place.detail && <span>{place.detail}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// The scene

const dome = new SphereGeometry(1, 32, 16)
const skyMaterial = new ShaderMaterial({
  side: BackSide,
  depthWrite: false,
  depthTest: false,
  uniforms: { top: { value: new Color() }, horizon: { value: new Color() }, space: { value: 1 } },
  vertexShader: /* glsl */ `
    varying vec3 vDirection;
    void main() {
      vDirection = normalize(position);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform vec3 top;
    uniform vec3 horizon;
    uniform float space;
    varying vec3 vDirection;
    void main() {
      // From high up the sky gives way to plain paper behind the globe.
      float h = clamp(vDirection.y, 0.0, 1.0);
      gl_FragColor = vec4(mix(mix(horizon, top, pow(smoothstep(0.0, 0.75, h), 0.8)), horizon, space), 1.0);
      #include <colorspace_fragment>
    }`,
})

const EARTH = 6371000
const corner = new Vector3()

function ExplorerScene({
  onControls,
  initial,
  outline,
  choosing,
  onView,
  onClose,
}: {
  onControls: (controls: GlobeControls | null) => void
  initial: GlobeView
  outline: RefObject<SVGPolygonElement | null>
  choosing: number | null
  onView?: (view: GlobeView) => void
  onClose: (close: boolean) => void
}) {
  const get = useThree((s) => s.get)
  const palette = PALETTES.mono
  const light = useMemo(() => daylight(DEFAULT_HOUR, palette), [palette])
  const sky = useRef<Mesh>(null)
  const parts = useRef<{ world: WorldTiles; controls: GlobeControls; sun: Sun | null; fog: Fog } | null>(null)
  const reported = useRef({ at: 0, close: false })

  useEffect(() => {
    const { scene, camera, gl } = get()
    if (!(camera instanceof PerspectiveCamera)) return
    const world = new WorldTiles({ anchor: { lon: initial.lon, lat: initial.lat, height: initial.height } })
    scene.add(world.group)
    const controls = new GlobeControls(gl.domElement, world, () => camera, initial)
    const detach = controls.attach()
    const fog = new Fog(light.skyHorizon.clone(), 1e9, 2e9)
    scene.fog = fog
    scene.background = light.skyHorizon.clone()
    const sun = new Sun(camera, scene)
    sun.setLight(light.direction, light.sun, light.sunIntensity)
    skyMaterial.uniforms.top!.value.copy(light.skyTop)
    skyMaterial.uniforms.horizon!.value.copy(light.skyHorizon)
    parts.current = { world, controls, sun, fog }
    onControls(controls)
    // For looking into it from the console while developing.
    if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__plinthWorld = { world, controls, camera, scene }
    return () => {
      detach()
      onControls(null)
      scene.remove(world.group)
      world.dispose()
      sun.dispose()
      scene.fog = null
      scene.background = null
      parts.current = null
    }
  }, [get, initial, light, onControls])

  useFrame(({ camera, size }) => {
    const p = parts.current
    if (!p || !(camera instanceof PerspectiveCamera)) return
    const { world, controls, sun, fog } = p
    controls.update(performance.now())
    const altitude = controls.altitude()
    const view = controls.view

    // Depth: from close in to past the horizon (and the mountains beyond it).
    const fromCentre = Math.hypot(...ecefFromLonLat(view.lon, view.lat, view.height)) + altitude
    const horizon = Math.sqrt(Math.max(fromCentre * fromCentre - EARTH * EARTH, 0))
    const near = Math.min(Math.max(altitude * 0.02, 0.3), 2e5)
    const far = Math.min(horizon + 300e3, 6e7)
    if (Math.abs(camera.near - near) > near * 0.2 || Math.abs(camera.far - far) > far * 0.05) {
      camera.near = near
      camera.far = far
      camera.updateProjectionMatrix()
    }

    // Haze over the distance near the ground; none from space.
    fog.near = 2000 + altitude * 6
    fog.far = fog.near + 15000 + altitude * 40
    const high = Math.min(Math.max((altitude - 20e3) / 200e3, 0), 1)
    skyMaterial.uniforms.space!.value = high
    if (sky.current) {
      sky.current.position.copy(camera.position)
      sky.current.scale.setScalar(Math.min(far * 0.5, fog.near * 0.9))
      sky.current.visible = high < 1
    }

    world.update(camera, size.height)
    sun?.update(Math.min(Math.max(view.range * 2.5, 150), 9000), get().scene, Math.max(0, (altitude - 400) * 0.7))

    // The square being marked out, on the screen.
    if (choosing !== null && outline.current) {
      const frame = enuFrame(view.lon, view.lat, view.height)
      const half = choosing / 2
      const points = [
        [-half, -half],
        [half, -half],
        [half, half],
        [-half, half],
      ].map(([e, n]) => {
        world.toScene(fromFrame(frame, [e!, n!, 0]), corner).project(camera)
        return `${((corner.x + 1) / 2) * size.width},${((1 - corner.y) / 2) * size.height}`
      })
      outline.current.setAttribute('points', points.join(' '))
    }

    const now = performance.now()
    const close = view.range < 12000
    if (close !== reported.current.close) {
      reported.current.close = close
      onClose(close)
    }
    if (now - reported.current.at > 600) {
      reported.current.at = now
      onView?.({ ...view })
    }
  })

  return (
    <>
      <hemisphereLight args={[palette.skyLight, palette.groundLight]} intensity={light.ambientIntensity} />
      <mesh ref={sky} geometry={dome} material={skyMaterial} frustumCulled={false} renderOrder={-10} raycast={() => null} />
    </>
  )
}
