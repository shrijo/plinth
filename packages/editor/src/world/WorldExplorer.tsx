import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { EffectComposer, N8AO, ToneMapping } from '@react-three/postprocessing'
import { ToneMappingMode } from 'postprocessing'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { BackSide, Color, Fog, NeutralToneMapping, PerspectiveCamera, ShaderMaterial, SphereGeometry, Vector3, type Mesh } from 'three'
import {
  ATTRIBUTION,
  ecefFromLonLat,
  enuFrame,
  fetchLocalWeather,
  fetchWorldWeather,
  fromFrame,
  searchPlaces,
  weatherAt,
  WEATHER_ATTRIBUTION,
  type Place,
  type WeatherGrid,
} from '@plinth/world'
import { daylight, FIRST_HOUR, formatHour, LAST_HOUR } from '../scene/daylight.ts'
import { PALETTES } from '../scene/materials.ts'
import { Sun } from '../scene/sun.ts'
import { CLOUD_SKIES, readViewPreferences, writeViewPreferences, type CloudSky } from '../state.ts'
import { CloudsEffect, SKIES, windAt } from './clouds.ts'
import { ChevronIcon, SearchIcon, SlidersIcon } from '../ui/icons.tsx'
import { DEFAULT_VIEW, GlobeControls, poseOf, type GlobeView } from './globeControls.ts'
import { WorldTiles } from './WorldTiles.ts'
import { MAIN_VIEW_LAYER } from './water.ts'
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
  /** The start of the bar along the top, before the search: the host's logo and where you are, say. */
  barStart?: ReactNode
  initialView?: Partial<GlobeView>
  /** Told of the view now and then (for keeping it in the address). */
  onViewChange?: (view: GlobeView) => void
  /** Makes a site from an area; the explorer waits on it, showing how it's going (as `report` tells it). */
  onMakeSite: (area: WorldArea, report: (text: string) => void) => Promise<void>
}

/** How the world is shown: kept with the editor's view settings, so they carry over. */
interface Look {
  hour: number
  outlines: boolean
  occlusion: boolean
  clouds: CloudSky
  /** How much of the cloud is shown (0 to 1). */
  amount: number
}

function readLook(): Look {
  const p = readViewPreferences()
  return { hour: p.timeOfDay, outlines: p.showOutlines, occlusion: p.ambientOcclusion, clouds: p.clouds, amount: p.cloudAmount }
}

const SKY_NAMES: Record<CloudSky, string> = { off: 'None', live: 'Live weather', fair: 'Fair', mixed: 'Changeable', overcast: 'Overcast' }

/** The weather (for live clouds): the whole world's, and finer round the view as it moves. */
function useWeather(controlsRef: RefObject<GlobeControls | null>, on: boolean): { world: WeatherGrid | null; local: WeatherGrid | null; failed: boolean } {
  const [state, setState] = useState<{ world: WeatherGrid | null; local: WeatherGrid | null; failed: boolean }>({ world: null, local: null, failed: false })
  useEffect(() => {
    if (!on) return
    const stop = new AbortController()
    const live = () => !stop.signal.aborted
    const last = { centre: '' }
    fetchWorldWeather()
      .then((world) => live() && setState((s) => ({ ...s, world })))
      .catch(() => live() && setState((s) => ({ ...s, failed: true })))
    // Now and then: the finer grid round where the view is, when it has moved on (and is close enough to tell).
    const look = () => {
      const view = controlsRef.current?.view
      if (!view || view.range > 3e6) return
      const key = `${Math.round(view.lon)},${Math.round(view.lat)}`
      if (key === last.centre) return
      last.centre = key
      fetchLocalWeather(view.lon, view.lat)
        .then((local) => live() && setState((s) => ({ ...s, local })))
        .catch(() => undefined)
    }
    look()
    const timer = setInterval(look, 2000)
    return () => {
      stop.abort()
      clearInterval(timer)
    }
  }, [controlsRef, on])
  return state
}

const MIN_SIZE = 100
const MAX_SIZE = 1000
const DEFAULT_SIZE = 300

export function WorldExplorer({ barStart, initialView, onViewChange, onMakeSite }: WorldExplorerProps) {
  const controlsRef = useRef<GlobeControls | null>(null)
  const outline = useRef<SVGPolygonElement>(null)
  const [choosing, setChoosing] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<string | null>(null)
  const [name, setName] = useState<string | null>(null)
  const [close, setClose] = useState(false)
  const [look, setLook] = useState(readLook)
  const changeLook = (patch: Partial<Look>) => {
    const next = { ...look, ...patch }
    setLook(next)
    writeViewPreferences({
      timeOfDay: next.hour,
      showOutlines: next.outlines,
      ambientOcclusion: next.occlusion,
      clouds: next.clouds,
      cloudAmount: next.amount,
    })
  }
  // The clouds, and the weather they're made from.
  // One for the explorer; let go of when it closes (and made again if React mounts it twice while developing).
  const [clouds] = useState(() => new CloudsEffect())
  useEffect(() => {
    if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__plinthClouds = clouds
    return () => clouds.release()
  }, [clouds])
  const weather = useWeather(controlsRef, look.clouds === 'live')
  useEffect(() => {
    clouds.setSky(look.clouds === 'live' || look.clouds === 'off' ? 'live' : SKIES[look.clouds])
  }, [clouds, look.clouds])
  useEffect(() => {
    clouds.setWeather(weather.world, weather.local)
  }, [clouds, weather.world, weather.local])
  useEffect(() => {
    clouds.setAmount(look.amount)
  }, [clouds, look.amount])
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
      {/* The bar first, for reading and tabbing: the host's start, the search in the middle, View at the end. */}
      <header className="pe-navbar pw-navbar">
        <div className="pe-navbar-start">{barStart}</div>
        <Search
          onPlace={(place) => {
            setName(place.name)
            // Close enough to see the place whole, tilted a little once near the ground.
            const range = Math.min(Math.max(place.size * 2.2, 600), 2.2e7)
            controlsRef.current?.flyTo({ lon: place.lon, lat: place.lat, range, heading: 0, pitch: range < 20000 ? 0.75 : 0 })
          }}
        />
        <div className="pe-navbar-end">
          <ViewPanel look={look} onChange={changeLook} weather={look.clouds === 'live' ? weather : null} controlsRef={controlsRef} />
        </div>
      </header>
      <Canvas
        className="pe-canvas"
        // No antialiasing of the canvas's own: the effects draw the scene into their own (multisampled) buffers.
        gl={{ logarithmicDepthBuffer: true, antialias: false, toneMapping: NeutralToneMapping }}
        camera={{ fov: 40, near: 1, far: 1e8, position: [0, 1e7, 0] }}
        shadows
        // At most one and a half device pixels to a CSS pixel: a retina screen's full two would draw nearly
        // twice the pixels for a picture that hardly looks different, and halve the frame rate.
        dpr={[1, 1.5]}
        // R3F's performance signal (see the frame loop): dropped while the view moves, back after 300 ms still.
        performance={{ min: 0.5, max: 1, debounce: 300 }}
      >
        <ExplorerScene
          onControls={keepControls}
          initial={view}
          outline={outline}
          choosing={choosing}
          look={look}
          clouds={look.clouds === 'off' ? null : clouds}
          weather={look.clouds === 'live' ? weather.local ?? weather.world : null}
          onView={onViewChange}
          onClose={setClose}
        />
        {/* Always drawn through the effects (even with both off), so the scene's shaders never change with them. */}
        <Effects controlsRef={controlsRef} occlusion={look.occlusion} clouds={look.clouds === 'off' ? null : clouds} />
      </Canvas>
      {choosing !== null && (
        <svg className="pw-overlay" aria-hidden="true">
          <polygon ref={outline} className="pw-square" />
        </svg>
      )}
      {/* The bottom: the dock floating in the middle, the map's credit to its right (above it on a phone). */}
      <div className="pw-bottom">
        <div className="pw-dock" data-choosing={choosing !== null || undefined}>
          {choosing === null ? (
            <button
              type="button"
              className="pe-button pe-button-primary pe-button-large"
              onClick={startChoosing}
              disabled={!close}
              title={close ? 'Mark out a square of the ground to make a site from' : 'Come closer to the ground first'}
            >
              Make a site here
            </button>
          ) : (
            <div className="pw-panel" role="group" aria-label="Site area">
              <label className="pe-field pw-size">
                <span className="pe-field-label">Square</span>
                <span className="pe-option-value">
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
                </span>
              </label>
              <p className="pw-hint" role={busy ? 'status' : undefined} data-error={error ? true : undefined}>
                {error ??
                  (busy ? progress : null) ??
                  'Streets, buildings and the lie of the land in the square become a site you can edit. Move the map to place it.'}
              </p>
              <div className="pw-actions">
                <button type="button" className="pe-button pe-button-large" onClick={() => setChoosing(null)} disabled={busy}>
                  Cancel
                </button>
                <button type="button" className="pe-button pe-button-primary pe-button-large" onClick={() => void make()} disabled={busy}>
                  {busy ? 'Making the site…' : 'Make site'}
                </button>
              </div>
            </div>
          )}
        </div>
        <div className="pw-credit">
          {ATTRIBUTION}
          {look.clouds === 'live' && ` · ${WEATHER_ATTRIBUTION}`}
        </div>
      </div>
    </div>
  )
}

/** The view's settings, behind a button at the end of the bar: the time of day, soft shading, outlines, clouds. */
function ViewPanel({
  look,
  onChange,
  weather,
  controlsRef,
}: {
  look: Look
  onChange: (patch: Partial<Look>) => void
  weather: { world: WeatherGrid | null; local: WeatherGrid | null; failed: boolean } | null
  controlsRef: RefObject<GlobeControls | null>
}) {
  const [open, setOpen] = useState(false)
  return (
    <section className="pw-view" aria-label="View">
      <button
        type="button"
        className="pe-button pe-button-large pw-view-toggle"
        aria-expanded={open}
        title={open ? 'Hide view options' : 'View options'}
        onClick={() => setOpen(!open)}
      >
        <SlidersIcon />
        <span>View</span>
        <ChevronIcon open={open} />
      </button>
      {open && (
        <div className="pe-popover">
          <div className="pe-view-options">
            <label className="pe-field">
              <span className="pe-field-label">Sun</span>
              <span className="pe-option-value">
                <input
                  type="range"
                  min={FIRST_HOUR}
                  max={LAST_HOUR}
                  step={0.25}
                  value={look.hour}
                  aria-valuetext={formatHour(look.hour)}
                  onChange={(e) => onChange({ hour: Number(e.target.value) })}
                />
                <output>{formatHour(look.hour)}</output>
              </span>
            </label>
            <label className="pe-check" title="Soft shading in corners, at the foot of walls and down streets">
              <input type="checkbox" checked={look.occlusion} onChange={(e) => onChange({ occlusion: e.target.checked })} />
              Soft shading
            </label>
            <label className="pe-check">
              <input type="checkbox" checked={look.outlines} onChange={(e) => onChange({ outlines: e.target.checked })} />
              Outlines
            </label>
            <label className="pe-field">
              <span className="pe-field-label">Clouds</span>
              <span className="pe-select">
                <select className="pe-input" value={look.clouds} onChange={(e) => onChange({ clouds: e.target.value as CloudSky })}>
                  {CLOUD_SKIES.map((sky) => (
                    <option key={sky} value={sky}>
                      {SKY_NAMES[sky]}
                    </option>
                  ))}
                </select>
              </span>
            </label>
            {look.clouds !== 'off' && (
              <label className="pe-field" title="How much of the cloud is shown">
                <span className="pe-field-label">Amount</span>
                <span className="pe-option-value">
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    // Squared, so the low amounts (where most of the difference is) get most of the slider.
                    value={Math.sqrt(look.amount)}
                    aria-valuetext={`${Math.round(look.amount * 100)}%`}
                    onChange={(e) => onChange({ amount: Number(e.target.value) ** 2 })}
                  />
                  <output>{look.amount < 0.1 ? (look.amount * 100).toFixed(1) : Math.round(look.amount * 100)}%</output>
                </span>
              </label>
            )}
            {weather && <WeatherNote weather={weather} controlsRef={controlsRef} />}
          </div>
        </div>
      )}
    </section>
  )
}

/** What the live weather says here, and where it's from. */
function WeatherNote({
  weather,
  controlsRef,
}: {
  weather: { world: WeatherGrid | null; local: WeatherGrid | null; failed: boolean }
  controlsRef: RefObject<GlobeControls | null>
}) {
  const grid = weather.local ?? weather.world
  // Where the view is, looked up now and then (the panel needn't follow every frame).
  const [place, setPlace] = useState<{ lon: number; lat: number } | null>(null)
  useEffect(() => {
    const look = () => {
      const view = controlsRef.current?.view
      if (view) setPlace((p) => (p && Math.abs(p.lon - view.lon) < 0.01 && Math.abs(p.lat - view.lat) < 0.01 ? p : { lon: view.lon, lat: view.lat }))
    }
    look()
    const timer = setInterval(look, 1000)
    return () => clearInterval(timer)
  }, [controlsRef])
  if (weather.failed && !grid) return <p className="pw-note">The weather service isn't answering; the clouds wait for it.</p>
  if (!grid || !place) return <p className="pw-note">Fetching the weather…</p>
  const here = weatherAt(grid, place.lon, place.lat)
  const percent = (v: number) => `${Math.round(v * 100)}%`
  const time = grid.time ? `${grid.time.slice(11, 16)} UTC` : ''
  return (
    <p className="pw-note">
      Here: low {percent(here.low)}, middle {percent(here.mid)}, high {percent(here.high)} cloud. {WEATHER_ATTRIBUTION}
      {time && `, ${time}`}.
    </p>
  )
}

/**
 * What's laid over the drawn scene: ambient occlusion as in the editor (see
 * scene/Effects; its reach follows how much of the ground is in view), the
 * clouds, then the tone mapping.
 */
function Effects({
  controlsRef,
  occlusion,
  clouds,
}: {
  controlsRef: RefObject<GlobeControls | null>
  occlusion: boolean
  clouds: CloudsEffect | null
}) {
  const ao = useRef<{ configuration: { aoRadius: number; transparencyAware: boolean } } | null>(null)
  const composer = useRef<unknown>(null)
  // Four samples a pixel on a plain screen; two at higher densities, where pixels are small already and the
  // multisampled buffers cost the most (four of them at 1.5x took about as long as the rest of the frame).
  const dpr = useThree((s) => s.viewport.dpr)
  useEffect(() => {
    // Nothing see-through to shade for: no walk through the scene every frame looking for it.
    if (ao.current) ao.current.configuration.transparencyAware = false
    if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__plinthEffects = { composer, ao }
  }, [occlusion])
  useFrame(({ camera }) => {
    const pass = ao.current
    const controls = controlsRef.current
    if (!pass || !controls || !(camera instanceof PerspectiveCamera)) return
    const seen = 2 * Math.min(controls.view.range, controls.altitude() * 3) * Math.tan((camera.fov * Math.PI) / 360)
    const radius = Math.min(Math.max(seen * 0.03, 0.8), 60)
    // Eased a little every frame: a step change repaints the whole shading at once and reads as a flicker,
    // felt most near the ground, where the view's distance shifts fastest.
    const current = pass.configuration.aoRadius
    if (Math.abs(radius - current) > current * 0.002) pass.configuration.aoRadius = current + (radius - current) * 0.15
  })
  return (
    <EffectComposer ref={composer as never} multisampling={dpr > 1 ? 2 : 4} renderPriority={1}>
      <>{occlusion && <N8AO ref={ao} halfRes aoSamples={8} denoiseSamples={4} denoiseRadius={12} aoRadius={4} distanceFalloff={1} intensity={3} color="black" />}</>
      <>{clouds && <primitive object={clouds} dispose={null} />}</>
      <ToneMapping mode={ToneMappingMode.NEUTRAL} />
    </EffectComposer>
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
        role="search"
        onSubmit={(e) => {
          e.preventDefault()
          void search()
        }}
      >
        <SearchIcon />
        <input
          type="search"
          className="pe-input"
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

const corner = new Vector3()

function ExplorerScene({
  onControls,
  initial,
  outline,
  choosing,
  look,
  clouds,
  weather,
  onView,
  onClose,
}: {
  onControls: (controls: GlobeControls | null) => void
  initial: GlobeView
  outline: RefObject<SVGPolygonElement | null>
  choosing: number | null
  look: Look
  clouds: CloudsEffect | null
  weather: WeatherGrid | null
  onView?: (view: GlobeView) => void
  onClose: (close: boolean) => void
}) {
  const get = useThree((s) => s.get)
  const palette = PALETTES.mono
  const light = useMemo(() => daylight(look.hour, palette), [look.hour, palette])
  const lightRef = useRef(light)
  const sky = useRef<Mesh>(null)
  const parts = useRef<{ world: WorldTiles; controls: GlobeControls; sun: Sun | null; fog: Fog } | null>(null)
  const reported = useRef({ at: 0, close: false, frame: 0, wind: 0, grass: 0 })

  useEffect(() => {
    const { scene, camera, gl } = get()
    if (!(camera instanceof PerspectiveCamera)) return
    const light = lightRef.current
    const world = new WorldTiles({ anchor: { lon: initial.lon, lat: initial.lat, height: initial.height }, outlines: readLook().outlines })
    scene.add(world.group)
    const controls = new GlobeControls(gl.domElement, world, () => camera, initial)
    const detach = controls.attach()
    const fog = new Fog(light.skyHorizon.clone(), 1e9, 2e9)
    scene.fog = fog
    scene.background = light.skyHorizon.clone()
    // The world sets up its own materials for the sun as it makes them: the scene is only looked through now and then.
    const sun = new Sun(camera, scene, 20)
    world.useMaterials({ setup: (m) => sun.setup(m), release: (m) => sun.release(m) })
    // The main view draws what reflections and captures leave out (the grass).
    camera.layers.enable(MAIN_VIEW_LAYER)
    sun.setLight(light.direction, light.sun, light.sunIntensity)
    world.water.setSun(light.direction, light.sun)
    world.water.setSky(light.skyHorizon)
    skyMaterial.uniforms.top!.value.copy(light.skyTop)
    skyMaterial.uniforms.horizon!.value.copy(light.skyHorizon)
    parts.current = { world, controls, sun, fog }
    onControls(controls)
    // For looking into it from the console while developing.
    if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__plinthWorld = { world, controls, camera, scene, gl }
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
  }, [get, initial, onControls])

  // The time of day: the sun, the sky, the haze and the water's glint.
  useEffect(() => {
    lightRef.current = light
    const p = parts.current
    const { scene } = get()
    p?.sun?.setLight(light.direction, light.sun, light.sunIntensity)
    p?.fog.color.copy(light.skyHorizon)
    if (scene.background instanceof Color) scene.background.copy(light.skyHorizon)
    skyMaterial.uniforms.top!.value.copy(light.skyTop)
    skyMaterial.uniforms.horizon!.value.copy(light.skyHorizon)
    p?.world.water.setSun(light.direction, light.sun)
    p?.world.water.setSky(light.skyHorizon)
  }, [light, get])

  useEffect(() => {
    parts.current?.world.setOutlines(look.outlines)
  }, [look.outlines])

  const lastView = useRef('')
  useFrame((state) => {
    const { camera, size } = state
    const p = parts.current
    if (!p || !(camera instanceof PerspectiveCamera)) return
    const { world, controls, sun, fog } = p
    controls.update(performance.now())
    const altitude = controls.altitude()
    const view = controls.view
    // Moving: R3F's performance regresses, and comes back once the view has been still a moment. The world
    // streams by it: arrivals take less of each frame while moving (smooth first), more once still.
    const seen = `${view.lon.toFixed(7)},${view.lat.toFixed(7)},${view.range.toFixed(2)},${view.heading.toFixed(4)},${view.pitch.toFixed(4)}`
    if (seen !== lastView.current) {
      lastView.current = seen
      state.performance.regress()
    }

    // Depth: from close in to past the horizon (and the mountains beyond it).
    const surface = Math.hypot(...ecefFromLonLat(view.lon, view.lat, 0))
    const fromCentre = surface + view.height + altitude
    const horizon = Math.sqrt(Math.max(fromCentre * fromCentre - surface * surface, 0))
    const near = Math.min(Math.max(altitude * 0.02, 0.3), 2e5)
    const far = Math.min(horizon + 300e3, 6e7)
    // Kept continuously: stepping the planes shifts every depth for a frame, a flicker while descending.
    if (Math.abs(camera.near - near) > near * 0.005 || Math.abs(camera.far - far) > far * 0.005) {
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

    const to = controls.destination
    const pose = to ? poseOf(to) : null
    // Past the haze's far edge the ground is the sky's colour: not drawn, nor loaded. (The haze goes by depth
    // along the view, which reaches furthest out in the corners.)
    const cornerAngle = Math.atan(Math.tan((camera.fov * Math.PI) / 360) * Math.hypot(1, camera.aspect))
    world.update(camera, size.height, {
      still: state.performance.current >= 1,
      destination: to && pose ? { position: pose.position, up: pose.up, target: ecefFromLonLat(to.lon, to.lat, to.height) } : null,
      maxDistance: (fog.far / Math.cos(cornerAngle)) * 1.05,
    })
    // The sun's bands fitted (and any new materials set up for them) before anything is drawn this frame:
    // the reflection too, or new materials would be built once without the shadows first.
    sun?.update(Math.min(Math.max(view.range * 2.5, 150), 9000), get().scene, Math.max(0, (altitude - 400) * 0.7))
    world.reflect(get().gl, get().scene, camera)
    // The grass leans with the wind here (from the weather, or a breeze from the west), a few times a second.
    if (performance.now() - reported.current.grass > 500) {
      reported.current.grass = performance.now()
      const w = weather ? windAt(weather, view.lon, view.lat) : null
      world.grass.setWind(w?.east ?? 4, w?.north ?? 1)
    }
    if (clouds) {
      const now = performance.now()
      const seconds = reported.current.frame ? Math.min((now - reported.current.frame) / 1000, 0.1) : 0
      reported.current.frame = now
      // The wind here, from the weather (or a breeze from the west), a few times a second.
      if (now - reported.current.wind > 500) {
        reported.current.wind = now
        const w = weather ? windAt(weather, view.lon, view.lat) : null
        clouds.setWind(view.lon, view.lat, w?.east ?? 6, w?.north ?? 1)
      }
      clouds.setView(camera, world, lightRef.current, { color: fog.color, near: fog.near, far: fog.far }, seconds)
    }

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
