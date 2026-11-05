import * as Y from 'yjs'
import { DEFAULT_META, type Id, type Snapshot } from './model.ts'
import { readMeta, Tx, type DocumentMaps } from './tx.ts'
import type { ProjectFile } from './file.ts'

/** Transactions with this origin are local edits and can be undone. */
const LOCAL_ORIGIN = 'plinth:local'
/** Local edits that must not be undoable (loading a file, setting up defaults). */
const SYSTEM_ORIGIN = 'plinth:system'

/** The record collections, each a Y.Map of plain records by ID. */
const COLLECTIONS = [
  'buildings',
  'levels',
  'nodes',
  'walls',
  'openings',
  'streetNodes',
  'streets',
  'roomTags',
  'parcels',
  'spotHeights',
] as const
type Collection = (typeof COLLECTIONS)[number]

export interface TransactOptions {
  /**
   * Merge this change into the previous undo step. Use it for every step of a
   * gesture (a drag) after the first, so the whole gesture undoes at once.
   */
  merge?: boolean
}

export interface HistoryState {
  canUndo: boolean
  canRedo: boolean
}

/**
 * A Plinth project backed by a Yjs document.
 *
 * All changes go through `transact`, which makes them undoable and ready to
 * sync. Readers use `getSnapshot`, an immutable view that is replaced after
 * every change; unchanged records keep their identity so they memoise well.
 */
export class PlinthDocument {
  readonly ydoc: Y.Doc
  readonly undoManager: Y.UndoManager
  private readonly maps: DocumentMaps
  private snapshot: Snapshot
  private history: HistoryState = { canUndo: false, canRedo: false }
  private readonly listeners = new Set<() => void>()

  constructor(ydoc: Y.Doc = new Y.Doc()) {
    this.ydoc = ydoc
    this.maps = {
      meta: ydoc.getMap('meta'),
      buildings: ydoc.getMap('buildings'),
      levels: ydoc.getMap('levels'),
      nodes: ydoc.getMap('nodes'),
      walls: ydoc.getMap('walls'),
      openings: ydoc.getMap('openings'),
      streetNodes: ydoc.getMap('streetNodes'),
      streets: ydoc.getMap('streets'),
      roomTags: ydoc.getMap('roomTags'),
      parcels: ydoc.getMap('parcels'),
      spotHeights: ydoc.getMap('spotHeights'),
    }
    this.undoManager = new Y.UndoManager([this.maps.meta, ...COLLECTIONS.map((c) => this.maps[c])], {
      trackedOrigins: new Set([LOCAL_ORIGIN]),
      // Steps are split explicitly in `transact`, never by timing.
      captureTimeout: Number.MAX_SAFE_INTEGER,
    })
    this.snapshot = this.readSnapshot()
    ydoc.on('afterTransaction', this.handleAfterTransaction)
    this.undoManager.on('stack-item-added', this.handleHistoryChange)
    this.undoManager.on('stack-item-popped', this.handleHistoryChange)
    this.undoManager.on('stack-cleared', this.handleHistoryChange)
  }

  /** A new, empty site. */
  static createEmpty(name = DEFAULT_META.name): PlinthDocument {
    const doc = new PlinthDocument()
    doc.ensureDefaults(name)
    return doc
  }

  /**
   * Sets up the project defaults. A document from before sites existed (with
   * levels that belong to no building) is cleared: that format isn't carried over.
   */
  ensureDefaults(name = DEFAULT_META.name): void {
    const outdated = [...this.maps.levels.values()].some((level) => !level.buildingId)
    if (this.maps.meta.has('name') && !outdated) return
    this.ydoc.transact(() => {
      if (outdated) for (const collection of [this.maps.meta, ...COLLECTIONS.map((c) => this.maps[c])]) collection.clear()
      new Tx(this.maps).setMeta({
        name,
        wallThickness: DEFAULT_META.wallThickness,
        slabThickness: DEFAULT_META.slabThickness,
      })
    }, SYSTEM_ORIGIN)
    this.undoManager.clear()
  }

  getSnapshot = (): Snapshot => this.snapshot

  getHistory = (): HistoryState => this.history

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Runs `fn` as one undoable change and returns its result. */
  transact<T>(fn: (tx: Tx) => T, options: TransactOptions = {}): T {
    if (!options.merge) this.undoManager.stopCapturing()
    let result!: T
    this.ydoc.transact(() => {
      result = fn(new Tx(this.maps))
    }, LOCAL_ORIGIN)
    return result
  }

  undo(): void {
    this.undoManager.undo()
  }

  redo(): void {
    this.undoManager.redo()
  }

  /**
   * Fills the document in one change that can't be undone, such as building
   * an example. Clears undo.
   */
  build(fn: (tx: Tx) => void): void {
    this.ydoc.transact(() => fn(new Tx(this.maps)), SYSTEM_ORIGIN)
    this.undoManager.clear()
  }

  /** Replaces the whole document, for example with an opened file. Clears undo. */
  replaceContents(file: ProjectFile): void {
    this.ydoc.transact(() => {
      this.maps.meta.clear()
      for (const collection of COLLECTIONS) this.maps[collection].clear()
      const tx = new Tx(this.maps)
      tx.setMeta({
        name: file.meta.name,
        wallThickness: file.meta.wallThickness,
        slabThickness: file.meta.slabThickness,
        areaStandard: file.meta.areaStandard,
      })
      for (const building of file.buildings) tx.putBuilding(building)
      for (const level of file.levels) tx.putLevel(level)
      for (const node of file.nodes) tx.putNode(node)
      for (const wall of file.walls) tx.putWall(wall)
      for (const opening of file.openings) tx.putOpening(opening)
      for (const node of file.streetNodes) tx.putStreetNode(node)
      for (const street of file.streets) tx.putStreet(street)
      for (const tag of file.roomTags) tx.putRoomTag(tag)
      for (const parcel of file.parcels) tx.putParcel(parcel)
      for (const spot of file.spotHeights) tx.putSpotHeight(spot)
    }, SYSTEM_ORIGIN)
    this.undoManager.clear()
  }

  destroy(): void {
    this.ydoc.off('afterTransaction', this.handleAfterTransaction)
    this.undoManager.destroy()
    this.listeners.clear()
  }

  private readSnapshot(): Snapshot {
    const records = Object.fromEntries(
      COLLECTIONS.map((c) => [c, Object.fromEntries((this.maps[c] as Y.Map<unknown>).entries())]),
    ) as Pick<Snapshot, Collection>
    return { meta: readMeta(this.maps.meta), ...records }
  }

  private handleAfterTransaction = (tr: Y.Transaction): void => {
    const metaChanged = changedKeys(tr, this.maps.meta) !== undefined
    const changed = COLLECTIONS.map((c) => [c, changedKeys(tr, this.maps[c] as Y.Map<unknown>)] as const)
    if (!metaChanged && changed.every(([, keys]) => !keys)) return

    const prev = this.snapshot
    const next: Record<string, unknown> = { meta: metaChanged ? readMeta(this.maps.meta) : prev.meta }
    for (const [collection, keys] of changed) {
      next[collection] = keys
        ? patchRecords(prev[collection] as Record<Id, unknown>, this.maps[collection] as Y.Map<unknown>, keys)
        : prev[collection]
    }
    this.snapshot = next as unknown as Snapshot
    this.emit()
  }

  private handleHistoryChange = (): void => {
    const canUndo = this.undoManager.canUndo()
    const canRedo = this.undoManager.canRedo()
    if (canUndo === this.history.canUndo && canRedo === this.history.canRedo) return
    this.history = { canUndo, canRedo }
    this.emit()
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}

/** The keys a transaction changed on a map, or undefined if it didn't touch it. */
function changedKeys<T>(tr: Y.Transaction, map: Y.Map<T>): Set<string | null> | undefined {
  // Yjs types `changed` by its base event type, which its map types don't match.
  type ChangedKey = Parameters<typeof tr.changed.get>[0]
  return tr.changed.get(map as unknown as ChangedKey)
}

function patchRecords<T>(
  prev: Readonly<Record<Id, T>>,
  map: Y.Map<T>,
  keys: Set<string | null>,
): Record<Id, T> {
  const next: Record<Id, T> = { ...prev }
  for (const key of keys) {
    if (key === null) continue
    const value = map.get(key)
    if (value === undefined) delete next[key]
    else next[key] = value
  }
  return next
}
