import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { PlinthDocument } from '../document.ts'
import { analyzeSite } from '../geometry/analysis.ts'
import { streetGeometry } from '../geometry/streets.ts'
import { rowReach } from '../model.ts'
import { moveBuilding } from '../ops/buildings.ts'
import { buildMetropolis } from './metropolis.ts'

/** Node's process and gc, without Node's types (this package runs in browsers). */
const node = globalThis as unknown as {
  process?: { env: Record<string, string | undefined>; memoryUsage(): { heapUsed: number } }
  gc?: () => void
}
const heap = () => {
  node.gc?.()
  return node.process?.memoryUsage().heapUsed ?? 0
}

describe('Metropolis', () => {
  it('lays out a grid of streets and blocks of buildings', () => {
    const doc = PlinthDocument.createEmpty()
    let count = 0
    doc.build((tx) => (count = buildMetropolis(tx, { rows: 12, avenues: 5 })))
    const s = doc.getSnapshot()
    expect(Object.keys(s.buildings)).toHaveLength(count)
    expect(count).toBeGreaterThan(100)
    const analysis = analyzeSite(s)
    for (const b of analysis.buildings.values()) expect(b.grossArea).toBeGreaterThan(0)
    expect(streetGeometry(s).pieces.length).toBeGreaterThan(50)
  })

  it('gives every building a door on the street and rows of windows on every floor', () => {
    const doc = PlinthDocument.createEmpty()
    doc.build((tx) => void buildMetropolis(tx, { rows: 12, avenues: 5 }))
    const s = doc.getSnapshot()
    const analysis = analyzeSite(s)
    const openings = Object.values(s.openings)
    for (const building of analysis.buildings.values()) {
      const [ground, first] = building.levels
      const on = (level: typeof ground) => openings.filter((o) => level?.levelWalls.some((w) => w.id === o.wallId))
      expect(on(ground).filter((o) => o.kind === 'door')).toHaveLength(1)
      expect(on(first).filter((o) => o.kind === 'window').length).toBeGreaterThanOrEqual(2)
      // Upper floors copy the first floor's windows, not the ground floor's door.
      expect(building.levels.slice(1).every((l) => l.contentLevelId === first?.level.id)).toBe(true)
    }
    // Rows keep the record count down: far fewer records than windows.
    const windows = openings.reduce((sum, o) => sum + (o.count ?? 1), 0)
    expect(windows).toBeGreaterThan(openings.length * 3)
    // Every row fits on its wall.
    for (const o of openings) {
      const wall = s.walls[o.wallId]!
      const length = Math.hypot(s.nodes[wall.b]!.x - s.nodes[wall.a]!.x, s.nodes[wall.b]!.y - s.nodes[wall.a]!.y)
      expect(o.offset - rowReach(o)).toBeGreaterThan(0)
      expect(o.offset + rowReach(o)).toBeLessThan(length)
    }
  })

  // The full size, timed: BENCH=1 npx vitest run src/examples/metropolis.test.ts --silent=false
  it.skipIf(!node.process?.env.BENCH)('builds, analyses and edits the full city in reasonable time', () => {
    const heap0 = heap()
    const doc = PlinthDocument.createEmpty()
    let count = 0
    let t = performance.now()
    doc.build((tx) => (count = buildMetropolis(tx)))
    const build = performance.now() - t
    const s = doc.getSnapshot()
    const heap1 = heap()
    t = performance.now()
    const analysis = analyzeSite(s)
    const analyse = performance.now() - t
    const heapAnalysis = heap()
    t = performance.now()
    const streets = streetGeometry(s)
    void analysis
    const streetMs = performance.now() - t
    const heap2 = heap()
    const some = Object.keys(s.buildings)[0]!
    doc.transact((tx) => moveBuilding(tx, some, { x: 1, y: 0 }))
    t = performance.now()
    analyzeSite(doc.getSnapshot())
    const edit = performance.now() - t
    const records = Object.keys(s.buildings).length + Object.keys(s.levels).length + Object.keys(s.nodes).length + Object.keys(s.walls).length
    const openings = Object.values(s.openings)
    const windows = openings.reduce((sum, o) => sum + (o.count ?? 1), 0)
    console.info(
      `Metropolis: ${count} buildings, ${analysis.levels.length} floors, ${records} building records, ` +
        `${windows} windows and doors in ${openings.length} records, ` +
        `${Object.keys(s.streets).length} streets, ${streets.pieces.length} street pieces. ` +
        `Build ${build.toFixed(0)} ms, analyse ${analyse.toFixed(0)} ms, streets ${streetMs.toFixed(0)} ms, ` +
        `re-analyse after an edit ${edit.toFixed(0)} ms. Heap +${((heap1 - heap0) / 1e6).toFixed(0)} MB document, ` +
        `+${((heapAnalysis - heap1) / 1e6).toFixed(0)} MB analysis, +${((heap2 - heapAnalysis) / 1e6).toFixed(0)} MB streets. File ${(Y.encodeStateAsUpdate(doc.ydoc).length / 1e6).toFixed(1)} MB.`,
    )
  }, 600000)
})
