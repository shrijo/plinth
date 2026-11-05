import type { Object3D } from 'three'

/**
 * Marks objects that show the editor's state rather than the city
 * (highlights, handles), to be left out of a picture of the view. Put on
 * an object's `userData`; shared, so it's never copied.
 */
export const HIDE_IN_PICTURES = Object.freeze({ hideInPictures: true })

/** Runs `draw` with the marked objects hidden, then shows them again. */
export function withoutEditorMarks<T>(scene: Object3D, draw: () => T): T {
  const hidden: Object3D[] = []
  scene.traverse((object) => {
    if (object.visible && (object.userData as { hideInPictures?: boolean }).hideInPictures) {
      object.visible = false
      hidden.push(object)
    }
  })
  try {
    return draw()
  } finally {
    for (const object of hidden) object.visible = true
  }
}
