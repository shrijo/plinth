import {
  addSpotHeights,
  areaReportCSV,
  createParcel,
  parcelsFromGeoJSON,
  pointsFromXYZ,
  exportDXF,
  exportIFC,
  parseProject,
  PROJECT_FILE_EXTENSION,
  ProjectFileError,
  serializeProject,
  type Snapshot,
} from '@plinth/core'
import {
  exportModel as exportModelFile,
  PlinthEditor,
  WorldExplorer,
  type ExportedFile,
  type GlobeView,
  type ModelFormat,
  type PlinthEditorApi,
  type WorldArea,
} from '@plinth/editor'
import { buildSite, planSite } from '@plinth/world'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { fileSafe } from './files.ts'
import { Gallery } from './gallery/Gallery.tsx'
import { createProject, getProject, handOver, letGo, openProject, statsOf, updateProject, type OpenProject } from './gallery/store.ts'
import { loadPlatform, type Platform } from './platform/index.ts'
import { ProjectSync, type Peer, type SyncStatus } from '@plinth/sync'
import { useSession } from './cloud/session.ts'
import { cloudServices } from './cloud/supabase.ts'

/** Thumbnails in the gallery, in pixels. */
const THUMB_WIDTH = 640
const THUMB_HEIGHT = 400

/**
 * Where the app is, kept in the address so a reload stays there and Back
 * returns: the gallery (#/), a city (#/city/<id>), or the world
 * (#/world/<lat>,<lon>,<metres away>).
 */
type Route = { kind: 'gallery' } | { kind: 'city'; id: string } | { kind: 'world'; view: Partial<GlobeView> | null }

function readRoute(): Route {
  const city = /^#\/city\/([\w-]+)/.exec(window.location.hash)
  if (city) return { kind: 'city', id: city[1]! }
  const world = /^#\/world(?:\/(-?[\d.]+),(-?[\d.]+)(?:,([\d.]+))?)?/.exec(window.location.hash)
  if (world) {
    const [, lat, lon, range] = world
    return { kind: 'world', view: lat && lon ? { lat: Number(lat), lon: Number(lon), ...(range ? { range: Number(range) } : {}) } : null }
  }
  return { kind: 'gallery' }
}

function useRoute(): [Route, (id: string | null) => void, () => void] {
  const [route, setRoute] = useState(readRoute)
  useEffect(() => {
    const onChange = () => setRoute(readRoute())
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  const navigate = useCallback((id: string | null) => {
    window.location.hash = id ? `#/city/${id}` : '#/'
  }, [])
  const explore = useCallback(() => {
    window.location.hash = '#/world'
  }, [])
  return [route, navigate, explore]
}

export function App() {
  const [platform, setPlatform] = useState<Platform | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [route, navigate, explore] = useRoute()

  useEffect(() => {
    loadPlatform()
      .then(setPlatform)
      .catch((e: unknown) => setError(errorText(e)))
  }, [])

  if (error) return <div className="app-message">Plinth could not start: {error}</div>
  if (!platform) return <div className="app-message">Loading…</div>
  if (route.kind === 'city') return <City key={route.id} id={route.id} platform={platform} navigate={navigate} />
  if (route.kind === 'world') return <World initial={route.view} navigate={navigate} />
  return <Gallery platform={platform} onOpen={navigate} onExplore={explore} />
}

/** The world: look round, and make a site from a square of it. */
function World({ initial, navigate }: { initial: Partial<GlobeView> | null; navigate: (id: string | null) => void }) {
  // Read once: the address follows the view from here on, and mustn't move it.
  const [start] = useState(initial)
  const keepView = useCallback((view: GlobeView) => {
    const hash = `#/world/${view.lat.toFixed(5)},${view.lon.toFixed(5)},${Math.round(view.range)}`
    if (window.location.hash !== hash) window.history.replaceState(null, '', hash)
  }, [])
  const makeSite = useCallback(
    async (area: WorldArea, report: (text: string) => void) => {
      const plan = await planSite(area, { onProgress: report })
      report(`Building ${plan.buildings.length} buildings and the streets…`)
      // A moment for the message to show before the work.
      await new Promise((resolve) => setTimeout(resolve, 30))
      const project = await createProject(plan.name, (doc) => doc.build((tx) => buildSite(tx, plan)))
      handOver(project)
      navigate(project.id)
    },
    [navigate],
  )
  // The bar comes first, for reading and tabbing; it floats over the world on the margin.
  return (
    <div className="app">
      <header className="app-header app-header-floating">
        <div className="app-pill">
          <button type="button" className="app-back" onClick={() => navigate(null)} title="All cities">
            <img className="app-logo" src="/favicon.svg" alt="" width={24} height={24} />
            <span>Cities</span>
          </button>
          <span className="app-divider" aria-hidden="true">
            /
          </span>
          <span className="app-place">World</span>
        </div>
      </header>
      <main className="app-main">
        <WorldExplorer initialView={start ?? undefined} onViewChange={keepView} onMakeSite={makeSite} />
      </main>
    </div>
  )
}

/** Opens a city from the gallery and shows it in the editor. */
function City({ id, platform, navigate }: { id: string; platform: Platform; navigate: (id: string | null) => void }) {
  const [project, setProject] = useState<OpenProject | null>(null)
  const [cloudId, setCloudId] = useState<string | null>(null)
  const [missing, setMissing] = useState(false)

  useEffect(() => {
    let cancelled = false
    const opening = getProject(id).then((record) => {
      if (record && !cancelled) setCloudId(record.cloudId ?? null)
      return record ? openProject(id) : null
    })
    void opening.then((opened) => {
      if (cancelled) return
      if (opened) setProject(opened)
      else setMissing(true)
    })
    return () => {
      cancelled = true
      void opening.then((opened) => opened && letGo(opened))
    }
  }, [id])

  if (missing) {
    return (
      <div className="app-message">
        <p>
          This city isn't in the gallery any more.{' '}
          <button type="button" className="app-button" onClick={() => navigate(null)}>
            Back to the gallery
          </button>
        </p>
      </div>
    )
  }
  if (!project) return <div className="app-message">Opening…</div>
  return <Workspace project={project} cloudId={cloudId} platform={platform} navigate={navigate} />
}

/**
 * Keeps an open city in step with its shared project in the cloud, while
 * signed in: its changes go up, everyone else's come in. Says how it's
 * going and who else has it open.
 */
function useCloudSync(doc: OpenProject['doc'], cloudId: string | null): { status: SyncStatus; peers: Peer[] } | null {
  const session = useSession()
  const [state, setState] = useState<{ status: SyncStatus; peers: Peer[] }>({ status: 'connecting', peers: [] })
  const user = session?.user
  useEffect(() => {
    if (!cloudId || !cloudServices || !user) return
    const sync = new ProjectSync(doc.ydoc, cloudId, {
      ...cloudServices,
      me: { id: user.id, name: user.email ?? 'Someone' },
      onStatus: (status) => setState((s) => ({ ...s, status })),
      onPeers: (peers) => setState((s) => ({ ...s, peers })),
    })
    sync.start().catch(() => undefined)
    // Back online: send what's waiting.
    const online = () => void sync.flush()
    window.addEventListener('online', online)
    return () => {
      window.removeEventListener('online', online)
      sync.stop()
    }
  }, [doc, cloudId, user])
  return cloudId && cloudServices && user ? state : null
}

const SYNC_WORDS: Record<SyncStatus, string> = { connecting: 'Connecting…', synced: 'Synced', offline: 'Offline', error: 'Not synced' }

function Workspace({
  project,
  cloudId,
  platform,
  navigate,
}: {
  project: OpenProject
  cloudId: string | null
  platform: Platform
  navigate: (id: string | null) => void
}) {
  const { doc, id } = project
  const cloud = useCloudSync(doc, cloudId)
  const snapshot = useSyncExternalStore(doc.subscribe, doc.getSnapshot)
  const [toast, setToast] = useState<{ text: string; error: boolean } | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const [editorApi] = useState<{ current: PlinthEditorApi | null }>(() => ({ current: null }))
  const projectName = snapshot.meta.name

  useEffect(() => {
    document.title = `${projectName} — Plinth`
  }, [projectName])

  const flash = useCallback((text: string, error = false) => {
    clearTimeout(toastTimer.current)
    setToast({ text, error })
    toastTimer.current = setTimeout(() => setToast(null), error ? 6000 : 2500)
  }, [])

  const saveThumbnail = useCallback(async () => {
    const thumbnail = await editorApi.current?.captureImage(THUMB_WIDTH, THUMB_HEIGHT)
    if (thumbnail) await updateProject(id, { thumbnail })
  }, [editorApi, id])

  // A fresh picture once the view has drawn, so the gallery shows the city as it looks now.
  // (Tried again a few times: the first frames of a big city can take a moment.)
  useEffect(() => {
    let tries = 0
    let timer: ReturnType<typeof setTimeout>
    const attempt = () => {
      timer = setTimeout(() => {
        void editorApi.current?.captureImage(THUMB_WIDTH, THUMB_HEIGHT).then((thumbnail) => {
          if (thumbnail) void updateProject(id, { thumbnail })
          else if (++tries < 4) attempt()
        })
      }, 2500)
    }
    attempt()
    return () => clearTimeout(timer)
  }, [editorApi, id])

  // Keep the gallery's entry up to date after each change: name, numbers, time and picture.
  const [opened] = useState(() => doc.getSnapshot())
  useEffect(() => {
    if (snapshot === opened) return
    const timer = setTimeout(() => {
      void updateProject(id, { name: snapshot.meta.name, updatedAt: Date.now(), stats: statsOf(snapshot) })
      void saveThumbnail()
    }, 1200)
    return () => clearTimeout(timer)
  }, [snapshot, opened, id, saveThumbnail])

  const backToGallery = useCallback(async () => {
    await saveThumbnail().catch(() => undefined)
    navigate(null)
  }, [saveThumbnail, navigate])

  const saveFile = useCallback(async () => {
    const current = doc.getSnapshot()
    try {
      const result = await platform.saveFile(
        serializeProject(current),
        `${fileSafe(current.meta.name)}.${PROJECT_FILE_EXTENSION}`,
        null,
      )
      if (result) flash(`Saved ${result.name}`)
    } catch (e) {
      flash(`Could not save: ${errorText(e)}`, true)
    }
  }, [doc, platform, flash])

  /** Opens a project file as a new city in the gallery. */
  const openFile = useCallback(async () => {
    try {
      const opened = await platform.openFile()
      if (!opened) return
      const file = parseProject(opened.contents)
      const created = await createProject(file.meta.name, file)
      created.close()
      await saveThumbnail().catch(() => undefined)
      navigate(created.id)
    } catch (e) {
      flash(e instanceof ProjectFileError ? e.message : `Could not open the file: ${errorText(e)}`, true)
    }
  }, [platform, navigate, flash, saveThumbnail])

  const newCity = useCallback(async () => {
    const created = await createProject('Untitled city')
    created.close()
    await saveThumbnail().catch(() => undefined)
    navigate(created.id)
  }, [navigate, saveThumbnail])

  /** Makes a file from the city and lets the user save it. */
  const exportAs = useCallback(
    async (what: string, make: (snapshot: Snapshot) => Promise<ExportedFile> | ExportedFile, suffix = '') => {
      try {
        const snapshot = doc.getSnapshot()
        flash(`Exporting ${what}…`)
        // Let the message show before the work blocks the page.
        await new Promise((resolve) => setTimeout(resolve, 50))
        const file = await make(snapshot)
        const name = await platform.exportFile(file.data, `${fileSafe(snapshot.meta.name)}${suffix}.${file.extension}`, file)
        if (name) flash(`Exported ${name}`)
      } catch (e) {
        flash(`Could not export ${what}: ${errorText(e)}`, true)
      }
    },
    [doc, platform, flash],
  )
  const exportModel = useCallback((format: ModelFormat) => void exportAs('the model', (s) => exportModelFile(s, format)), [exportAs])
  const exportIfc = useCallback(
    () =>
      void exportAs('the BIM model', (s) => ({
        data: exportIFC(s),
        extension: 'ifc',
        mime: 'application/x-step',
        description: 'BIM model (IFC 4)',
      })),
    [exportAs],
  )
  const exportPlans = useCallback(
    () =>
      void exportAs(
        'the floor plans',
        (s) => ({ data: exportDXF(s), extension: 'dxf', mime: 'image/vnd.dxf', description: 'Floor plans (DXF)' }),
        ' plans',
      ),
    [exportAs],
  )

  /** Parcels from a GeoJSON file, placed by the project's origin (the file's middle, for the first import). */
  const importParcels = useCallback(async () => {
    try {
      const opened = await platform.openFile({ description: 'Parcels (GeoJSON)', extensions: ['geojson', 'json'] })
      if (!opened) return
      const { parcels, origin } = parcelsFromGeoJSON(opened.contents, doc.getSnapshot().meta.origin)
      doc.transact((tx) => {
        tx.setMeta({ origin })
        for (const parcel of parcels) createParcel(tx, parcel.points, parcel.name)
      })
      editorApi.current?.frameSite()
      flash(`Imported ${parcels.length} parcel${parcels.length === 1 ? '' : 's'} from ${opened.name}`)
    } catch (e) {
      flash(`Could not import the parcels: ${errorText(e)}`, true)
    }
  }, [doc, platform, flash, editorApi])

  /** Terrain points from an XYZ or CSV file, placed like parcels. */
  const importTerrain = useCallback(async () => {
    try {
      const opened = await platform.openFile({ description: 'Terrain points (XYZ, CSV)', extensions: ['xyz', 'csv', 'txt'] })
      if (!opened) return
      const snapshot = doc.getSnapshot()
      const { points, origin } = pointsFromXYZ(opened.contents, snapshot.meta.origin)
      // The first terrain sets what the site's zero stands for: its lowest ground, so buildings start on it.
      const first = snapshot.meta.ground === undefined && Object.keys(snapshot.spotHeights).length === 0
      const ground = Math.floor(Math.min(...points.map((p) => p.z)))
      doc.transact((tx) => {
        tx.setMeta(first ? { origin, ground } : { origin })
        addSpotHeights(tx, points)
      })
      editorApi.current?.frameSite()
      flash(`Imported ${points.length} terrain point${points.length === 1 ? '' : 's'} from ${opened.name}`)
    } catch (e) {
      flash(`Could not import the terrain: ${errorText(e)}`, true)
    }
  }, [doc, platform, flash, editorApi])

  const exportAreas = useCallback(async () => {
    try {
      const snapshot = doc.getSnapshot()
      const name = await platform.exportFile(areaReportCSV(snapshot), `${fileSafe(snapshot.meta.name)} areas.csv`, {
        description: 'Area table (CSV)',
        extension: 'csv',
        mime: 'text/csv',
      })
      if (name) flash(`Exported ${name}`)
    } catch (e) {
      flash(`Could not export the areas: ${errorText(e)}`, true)
    }
  }, [doc, platform, flash])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      const key = e.key.toLowerCase()
      if (key === 's') {
        e.preventDefault()
        void saveFile()
      } else if (key === 'o') {
        e.preventDefault()
        void openFile()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [saveFile, openFile])

  // The bar first, for reading and tabbing: where you are on the left, the File menu on the right.
  return (
    <div className="app">
      <header className="app-header app-header-floating">
        <div className="app-pill">
          <button type="button" className="app-back" onClick={() => void backToGallery()} title="All cities">
            <img className="app-logo" src="/favicon.svg" alt="" width={24} height={24} />
            <span>Cities</span>
          </button>
          <span className="app-divider" aria-hidden="true">
            /
          </span>
          <ProjectName name={projectName} onRename={(name) => doc.transact((tx) => tx.setMeta({ name }))} />
          {cloud && (
            <span className="app-sync" data-status={cloud.status} title={cloud.peers.map((p) => p.name).join(', ')}>
              {SYNC_WORDS[cloud.status]}
              {cloud.peers.length > 0 && ` · ${cloud.peers.length} other${cloud.peers.length === 1 ? '' : 's'} here`}
            </span>
          )}
        </div>
        <div className="app-actions">
          <FileMenu
            items={[
              { label: 'New city', action: () => void newCity() },
              { label: 'Open file…', shortcut: '⌘O', action: () => void openFile() },
              { label: 'Save as file…', shortcut: '⌘S', action: () => void saveFile() },
              { label: 'Import parcels (GeoJSON)…', action: () => void importParcels(), divider: true },
              { label: 'Import terrain points (XYZ, CSV)…', action: () => void importTerrain() },
              { label: 'Export 3D model (.glb)…', action: () => exportModel('glb'), divider: true },
              { label: 'Export 3D model (.obj)…', action: () => exportModel('obj') },
              { label: 'Export for 3D printing (.stl)…', action: () => exportModel('stl') },
              { label: 'Export for AR (.usdz)…', action: () => exportModel('usdz') },
              { label: 'Export BIM model (.ifc)…', action: () => exportIfc(), divider: true },
              { label: 'Export floor plans (.dxf)…', action: () => exportPlans() },
              { label: 'Export areas (.csv)…', action: () => void exportAreas(), divider: true },
            ]}
          />
        </div>
      </header>
      <main className="app-main">
        <PlinthEditor document={doc} apiRef={editorApi} />
      </main>
      {toast && (
        <div className="app-toast" role="status" data-error={toast.error || undefined}>
          {toast.text}
        </div>
      )}
    </div>
  )
}

function ProjectName({ name, onRename }: { name: string; onRename: (name: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  const commit = () => {
    const next = draft?.trim()
    if (next && next !== name) onRename(next)
    setDraft(null)
  }
  return (
    <input
      className="app-name"
      aria-label="Project name"
      value={draft ?? name}
      onFocus={() => setDraft(name)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') {
          setDraft(name)
          e.currentTarget.blur()
        }
      }}
    />
  )
}

interface MenuItem {
  label: string
  shortcut?: string
  action: () => void
  /** Draw a line above this item. */
  divider?: boolean
}

function FileMenu({ items }: { items: MenuItem[] }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])


  return (
    <div className="app-menu" ref={ref}>
      <button
        type="button"
        className="app-button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        File
      </button>
      {open && (
        <div className="app-menu-list" role="menu">
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className="app-menu-item"
              data-divider={item.divider || undefined}
              onClick={() => {
                setOpen(false)
                item.action()
              }}
            >
              <span>{item.label}</span>
              {item.shortcut && <kbd>{item.shortcut}</kbd>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
