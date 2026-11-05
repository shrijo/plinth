import { sortedLevels, type Id, type PlinthDocument, type Snapshot } from '@plinth/core'
import { Canvas } from '@react-three/fiber'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react'
import { NeutralToneMapping, type Object3D } from 'three'
import { useStore } from 'zustand'
import { dropMissingSelection } from './actions.ts'
import { EditorContext, type EditorContextValue } from './context.ts'
import { applyStyle } from './scene/materials.ts'
import { Scene } from './scene/Scene.tsx'
import { siteSphere } from './scene/siteSphere.ts'
import { createEditorStore, EMPTY_SELECTION, savePreferences, VIEW_PREFERENCES } from './state.ts'
import { Labels } from './ui/Labels.tsx'
import { LevelBar } from './ui/LevelBar.tsx'
import { PropertiesPanel } from './ui/PropertiesPanel.tsx'
import { StatusBar } from './ui/StatusBar.tsx'
import { Toolbar } from './ui/Toolbar.tsx'
import { useKeyboardShortcuts } from './useKeyboardShortcuts.ts'
import './editor.css'

export interface PlinthEditorApi {
  /**
   * The 3D view as a JPEG of the given size (cropped to fill it), for a
   * thumbnail. Null while a building is open: thumbnails show the site.
   */
  captureImage(width: number, height: number): Promise<Blob | null>
  /** Moves the view to show everything on the site (after an import, say). */
  frameSite(): void
}

export interface PlinthEditorProps {
  /** The project to edit. The editor reads and writes it directly. */
  document: PlinthDocument
  className?: string
  style?: CSSProperties
  /** Filled with the editor's API while it is mounted. */
  apiRef?: { current: PlinthEditorApi | null }
}

/**
 * The Plinth editor: a site editor for streets and building shells, and a
 * building editor for one building in detail (double-click a building to
 * open it). A 3D view with drawing tools, a toolbar and a properties panel;
 * it fills its container.
 */
export function PlinthEditor({ document: doc, className, style, apiRef }: PlinthEditorProps) {
  const [store] = useState(() => createEditorStore(firstLevelId(doc.getSnapshot())))
  const rootRef = useRef<HTMLDivElement>(null)
  const ctx = useMemo<EditorContextValue>(
    () => ({
      doc,
      store,
      rootRef,
      pickables: new Map<string, Object3D>(),
      controlsRef: { current: null },
      captureRef: { current: null },
      renderRef: { current: null },
    }),
    [doc, store],
  )

  useEffect(() => {
    if (!apiRef) return
    apiRef.current = {
      captureImage: (width, height) => ctx.captureRef.current?.(width, height) ?? Promise.resolve(null),
      frameSite: () => {
        const sphere = siteSphere(ctx.doc.getSnapshot())
        if (sphere) void ctx.controlsRef.current?.fitToSphere(sphere, true)
      },
    }
    return () => {
      apiRef.current = null
    }
  }, [apiRef, ctx])
  useKeyboardShortcuts(ctx)
  const mode = useStore(store, (s) => s.mode)
  const sceneStyle = useStore(store, (s) => s.style)
  // Recolour the shared materials before the scene draws with them.
  useLayoutEffect(() => applyStyle(sceneStyle), [sceneStyle])

  // Remember view settings for next time.
  useEffect(
    () =>
      store.subscribe((state, prev) => {
        if (VIEW_PREFERENCES.some((key) => state[key] !== prev[key])) savePreferences(state)
      }),
    [store],
  )

  // Keep the active level and the selection valid when the document changes
  // underneath the editor (a file opened, an undo, a collaborator's edit).
  const snapshot = useSyncExternalStore(doc.subscribe, doc.getSnapshot)
  useEffect(() => {
    const { activeLevelId, buildingId, mode } = store.getState()
    const level = snapshot.levels[activeLevelId]
    // Only the building editor works on a level.
    if (mode === 'building' && (!level || level.buildingId !== buildingId)) {
      store.setState({
        activeLevelId: firstLevelId(snapshot, buildingId),
        selection: EMPTY_SELECTION,
        anchor: null,
        chainStart: null,
        lastDirection: null,
        openingPreview: null,
      })
    }
    dropMissingSelection(ctx)
  }, [snapshot, store, ctx])

  return (
    <EditorContext.Provider value={ctx}>
      <div
        ref={rootRef}
        className={['plinth-editor', className].filter(Boolean).join(' ')}
        style={style}
        data-mode={mode}
      >
        <Canvas
          className="pe-canvas"
          camera={{ position: [14, 12, 14], fov: 36, near: 0.05, far: 8000 }}
          dpr={[1, 2]}
          shadows="percentage"
          gl={{ antialias: true, toneMapping: NeutralToneMapping }}
          // Reading shader logs after every compile stalls until the GPU is done: skipped, as three.js advises for production.
          onCreated={({ gl }) => {
            gl.debug.checkShaderErrors = false
          }}
        >
          <Scene />
        </Canvas>
        <Labels />
        <Toolbar />
        <LevelBar />
        <PropertiesPanel />
        <StatusBar />
      </div>
    </EditorContext.Provider>
  )
}

function firstLevelId(snapshot: Snapshot, buildingId: Id | null = null): Id {
  return sortedLevels(snapshot, buildingId ?? undefined)[0]?.id ?? ''
}
