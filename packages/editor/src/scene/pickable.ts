import { useEffect, useRef } from 'react'
import type { Mesh } from 'three'
import { useEditorContext } from '../context.ts'

/** Registers a mesh for picking under `key` while it is mounted and `enabled`. */
export function usePickable(key: string, enabled: boolean) {
  const { pickables } = useEditorContext()
  const ref = useRef<Mesh>(null)
  useEffect(() => {
    const object = ref.current
    if (!enabled || !object) return
    pickables.set(key, object)
    return () => {
      if (pickables.get(key) === object) pickables.delete(key)
    }
  }, [key, enabled, pickables])
  return ref
}
