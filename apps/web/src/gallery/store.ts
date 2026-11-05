import {
  analyzeSite,
  buildExampleCity,
  buildMetropolis,
  EXAMPLE_CITY_NAME,
  METROPOLIS_NAME,
  PlinthDocument,
  snapshotToProject,
  type ProjectFile,
  type Snapshot,
} from '@plinth/core'
import { IndexeddbPersistence } from 'y-indexeddb'
import * as Y from 'yjs'

/**
 * The gallery: every city the user has, kept in the browser (or the desktop
 * app's web view). An index of projects lives in one database; each
 * project's content is a Yjs document in a database of its own, saved as
 * it changes.
 */

const INDEX_DB = 'plinth-gallery'
const STORE = 'projects'
const PROJECT_DB_PREFIX = 'plinth-project-'
/** The single project from before the gallery existed. */
const OLD_AUTOSAVE_DB = 'plinth-autosave'
const SETUP_KEY = 'plinth:gallery-setup'

export interface ProjectStats {
  buildings: number
  streets: number
  /** Gross floor area of all buildings, m². */
  floorArea: number
}

export interface ProjectRecord {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  thumbnail: Blob | null
  stats: ProjectStats | null
}

let database: Promise<IDBDatabase> | null = null

function openIndex(): Promise<IDBDatabase> {
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(INDEX_DB, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' })
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('The gallery database could not be opened.'))
  })
  return database
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openIndex()
  return new Promise((resolve, reject) => {
    const request = run(db.transaction(STORE, mode).objectStore(STORE))
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('The gallery database failed.'))
  })
}

export async function listProjects(): Promise<ProjectRecord[]> {
  const all = await withStore<ProjectRecord[]>('readonly', (store) => store.getAll())
  return all.sort((a, b) => b.updatedAt - a.updatedAt)
}

export function getProject(id: string): Promise<ProjectRecord | undefined> {
  return withStore<ProjectRecord | undefined>('readonly', (store) => store.get(id))
}

export async function updateProject(id: string, patch: Partial<Omit<ProjectRecord, 'id'>>): Promise<void> {
  const record = await getProject(id)
  if (record) await withStore('readwrite', (store) => store.put({ ...record, ...patch }))
}

export async function deleteProject(id: string): Promise<void> {
  const lingering = handedOver.get(id)
  if (lingering) {
    handedOver.delete(id)
    if (lingering.expires) clearTimeout(lingering.expires)
    lingering.project.close()
  }
  await withStore('readwrite', (store) => store.delete(id))
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(PROJECT_DB_PREFIX + id)
    request.onsuccess = request.onerror = request.onblocked = () => resolve()
  })
}

/** A project open for editing. Changes are saved to the browser as they happen. */
export interface OpenProject {
  id: string
  doc: PlinthDocument
  close(): void
}

async function load(dbName: string): Promise<{ doc: PlinthDocument; persistence: IndexeddbPersistence | null }> {
  const ydoc = new Y.Doc()
  let persistence: IndexeddbPersistence | null = null
  try {
    persistence = new IndexeddbPersistence(dbName, ydoc)
    // Don't wait forever if the browser blocks storage (private windows).
    await Promise.race([persistence.whenSynced, new Promise((resolve) => setTimeout(resolve, 4000))])
  } catch {
    persistence = null
  }
  return { doc: new PlinthDocument(ydoc), persistence }
}

/** Projects just made (or just let go) and still open, passed straight on instead of being loaded again. */
const handedOver = new Map<string, { project: OpenProject; expires: ReturnType<typeof setTimeout> | null }>()

/** How long a project let go of stays open for someone to take it up again, in milliseconds. */
const HAND_BACK_GRACE = 3000

/**
 * Keeps a project open for the next `openProject` of it: a big city takes
 * a while to load, and longer still to save the first time, so loading it
 * again straight after making it could find it only partly saved.
 */
export function handOver(project: OpenProject): void {
  const before = handedOver.get(project.id)
  if (before && before.project !== project) {
    if (before.expires) clearTimeout(before.expires)
    before.project.close()
  }
  handedOver.set(project.id, { project, expires: null })
}

/**
 * Lets go of an open project: it stays open a moment in case it's opened
 * again straight away (React runs effects twice in development, and a
 * quick back-and-forth does the same), and is closed after that.
 */
export function letGo(project: OpenProject): void {
  handOver(project)
  const entry = handedOver.get(project.id)!
  entry.expires = setTimeout(() => {
    if (handedOver.get(project.id) !== entry) return
    handedOver.delete(project.id)
    project.close()
  }, HAND_BACK_GRACE)
}

export async function openProject(id: string): Promise<OpenProject> {
  const ready = handedOver.get(id)
  if (ready) {
    handedOver.delete(id)
    if (ready.expires) clearTimeout(ready.expires)
    return ready.project
  }
  const { doc, persistence } = await load(PROJECT_DB_PREFIX + id)
  doc.ensureDefaults()
  return {
    id,
    doc,
    close: () => {
      void persistence?.destroy()
      doc.destroy()
    },
  }
}

function newId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 16)
}

/** Makes a new project, filled from `contents` if given, and opens it. */
export async function createProject(name: string, contents?: ProjectFile | ((doc: PlinthDocument) => void)): Promise<OpenProject> {
  const id = newId()
  const now = Date.now()
  const project = await openProject(id)
  if (typeof contents === 'function') contents(project.doc)
  else if (contents) project.doc.replaceContents(contents)
  else project.doc.build((tx) => tx.setMeta({ name }))
  const snapshot = project.doc.getSnapshot()
  await withStore('readwrite', (store) =>
    store.put({ id, name: snapshot.meta.name, createdAt: now, updatedAt: now, thumbnail: null, stats: statsOf(snapshot) } satisfies ProjectRecord),
  )
  return project
}

export async function duplicateProject(id: string): Promise<string> {
  const source = await openProject(id)
  try {
    const record = await getProject(id)
    const file = snapshotToProject(source.doc.getSnapshot())
    const name = `${file.meta.name} copy`
    const copy = await createProject(name, { ...file, meta: { ...file.meta, name } })
    if (record?.thumbnail) await updateProject(copy.id, { thumbnail: record.thumbnail })
    copy.close()
    return copy.id
  } finally {
    source.close()
  }
}

export type ExampleKind = 'harbour' | 'metropolis'

/** An example city as a new project. */
export function createExampleProject(kind: ExampleKind = 'harbour'): Promise<OpenProject> {
  return kind === 'metropolis'
    ? createProject(METROPOLIS_NAME, (doc) => doc.build((tx) => void buildMetropolis(tx)))
    : createProject(EXAMPLE_CITY_NAME, (doc) => doc.build((tx) => buildExampleCity(tx)))
}

export function statsOf(snapshot: Snapshot): ProjectStats {
  return {
    buildings: Object.keys(snapshot.buildings).length,
    streets: Object.keys(snapshot.streets).length,
    floorArea: analyzeSite(snapshot).grossArea,
  }
}

/**
 * First run of the gallery: brings over the project from before the gallery
 * (if it has anything in it) and adds the example city, once.
 */
export async function setUpGallery(): Promise<void> {
  try {
    if (localStorage.getItem(SETUP_KEY)) return
    localStorage.setItem(SETUP_KEY, '1')
  } catch {
    return
  }
  const old = await load(OLD_AUTOSAVE_DB)
  try {
    old.doc.ensureDefaults()
    const snapshot = old.doc.getSnapshot()
    if (Object.keys(snapshot.buildings).length > 0 || Object.keys(snapshot.streets).length > 0) {
      ;(await createProject(snapshot.meta.name, snapshotToProject(snapshot))).close()
    }
  } finally {
    void old.persistence?.destroy()
    old.doc.destroy()
  }
  ;(await createExampleProject()).close()
}
