import { useEffect } from 'react'
import {
  cancel,
  completeDrawing,
  deleteSelection,
  enterBuilding,
  redo,
  setTool,
  showWholeBuilding,
  stepLevel,
  toggleIsolation,
  toggleSnapping,
  toggleView,
  undo,
  type ActionContext,
} from './actions.ts'
import { isOutlineTool, type Tool } from './state.ts'

/** Tool keys, per editor. */
const SITE_KEYS: Record<string, Tool> = { v: 'select', l: 'street', b: 'outline', p: 'parcel', g: 'terrain' }
const BUILDING_KEYS: Record<string, Tool> = { v: 'select', w: 'wall', o: 'window', d: 'door' }

/**
 * Editor shortcuts. Shortcuts with ⌘/Ctrl other than undo and redo are left
 * to the host app (save, open).
 */
export function useKeyboardShortcuts(ctx: ActionContext): void {
  useEffect(() => {
    const { store } = ctx
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Alt') {
        store.setState({ snapSuspended: true })
        return
      }
      if (isTyping(e.target)) return
      const state = store.getState()
      const key = e.key.toLowerCase()
      const mod = e.metaKey || e.ctrlKey

      if (mod) {
        if (key === 'z') {
          e.preventDefault()
          if (e.shiftKey) redo(ctx)
          else undo(ctx)
        } else if (key === 'y') {
          e.preventDefault()
          redo(ctx)
        }
        return
      }

      // Typing a number while drawing opens the exact-length box.
      const chain = state.tool === 'wall' || state.tool === 'street' || isOutlineTool(state.tool)
      if (chain && state.anchor && /^[0-9.,]$/.test(e.key)) {
        e.preventDefault()
        store.setState({ lengthInput: e.key })
        return
      }

      const site = state.mode === 'site'
      const tool = (site ? SITE_KEYS : BUILDING_KEYS)[key]
      if (tool) {
        setTool(ctx, tool)
        return
      }

      switch (key) {
        case 'escape':
          cancel(ctx)
          break
        case 'enter': {
          // Enter on a selected building opens it; otherwise it finishes the drawing.
          const building = state.selection.buildings[0]
          if (site && state.tool === 'select' && building && state.selection.buildings.length === 1) {
            enterBuilding(ctx, building)
          } else completeDrawing(ctx)
          break
        }
        case 'delete':
        case 'backspace':
          e.preventDefault()
          deleteSelection(ctx)
          break
        case 'pageup':
          e.preventDefault()
          stepLevel(ctx, 1)
          break
        case 'pagedown':
          e.preventDefault()
          stepLevel(ctx, -1)
          break
        case 't':
          toggleView(ctx)
          break
        case 'b':
          if (site) break
          if (state.wholeBuilding) stepLevel(ctx, 1)
          else showWholeBuilding(ctx)
          break
        case 's':
          toggleSnapping(ctx)
          break
        case 'h':
          toggleIsolation(ctx)
          break
      }
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Alt') store.setState({ snapSuspended: false })
    }
    const onBlur = () => store.setState({ snapSuspended: false })

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [ctx])
}

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}
