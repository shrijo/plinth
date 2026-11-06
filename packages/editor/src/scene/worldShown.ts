import { useEditor, useSnapshot } from '../context.ts'

/** Whether the real world is drawn round this site (the plain ground then gives way to it). */
export function useWorldShown(): boolean {
  const show = useEditor((s) => s.showWorld)
  const placed = useSnapshot().meta.origin?.kind === 'lonlat'
  return show && placed
}
