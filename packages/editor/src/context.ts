import { analyzeSite, type PlinthDocument } from '@plinth/core'
import type { CameraControlsImpl } from '@react-three/drei'
import { createContext, useContext, useSyncExternalStore, type RefObject } from 'react'
import type { Object3D } from 'three'
import { useStore } from 'zustand'
import type { EditorState, EditorStore } from './state.ts'

export interface EditorContextValue {
  doc: PlinthDocument
  store: EditorStore
  /** The editor's root element; pointer input is captured here. */
  rootRef: RefObject<HTMLDivElement | null>
  /**
   * Objects that can be clicked, by a key of their own (wall meshes and
   * opening hit boxes). Each carries a `Pick` in `userData.pick`.
   */
  pickables: Map<string, Object3D>
  controlsRef: { current: CameraControlsImpl | null }
  /** Set by the scene: draws the view and returns it as an image of the given size. */
  captureRef: { current: ((width: number, height: number) => Promise<Blob | null>) | null }
  /** Set while effects draw the view (ambient occlusion): draws a frame through them. */
  renderRef: { current: (() => void) | null }
}

export const EditorContext = createContext<EditorContextValue | null>(null)

export function useEditorContext(): EditorContextValue {
  const value = useContext(EditorContext)
  if (!value) throw new Error('This component must be used inside <PlinthEditor>.')
  return value
}

/** The current building snapshot; re-renders on every document change. */
export function useSnapshot() {
  const { doc } = useEditorContext()
  return useSyncExternalStore(doc.subscribe, doc.getSnapshot)
}

/** Rooms, areas and slabs for the current snapshot (cached). */
export function useAnalysis() {
  return analyzeSite(useSnapshot())
}

export function useHistory() {
  const { doc } = useEditorContext()
  return useSyncExternalStore(doc.subscribe, doc.getHistory)
}

export function useEditor<T>(selector: (state: EditorState) => T): T {
  const { store } = useEditorContext()
  return useStore(store, selector)
}
