import { PlinthDocument } from './document.ts'
import { createId } from './ids.ts'

/** A site with one empty building with one ground floor, not undoable. For tests. */
export function testSite() {
  const doc = PlinthDocument.createEmpty()
  const buildingId = createId()
  const levelId = createId()
  doc.transact((tx) => {
    tx.putBuilding({ id: buildingId, name: 'Test building' })
    tx.putLevel({ id: levelId, buildingId, name: 'Ground floor', elevation: 0, height: 3, masterId: null })
  })
  doc.undoManager.clear()
  return { doc, buildingId, levelId, groundId: levelId }
}
