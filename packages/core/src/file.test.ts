import { describe, expect, it } from 'vitest'
import { PlinthDocument } from './document.ts'
import { testSite } from './test-helpers.ts'
import { parseProject, ProjectFileError, serializeProject } from './file.ts'
import { insertRectangle } from './ops/walls.ts'
import { parseLength } from './units.ts'

describe('project files', () => {
  it('round-trips a document through a file', () => {
    const { doc, levelId } = testSite()
    doc.transact((tx) => tx.setMeta({ name: 'House' }))
    doc.transact((tx) => insertRectangle(tx, levelId, { x: 0, y: 0 }, { x: 6, y: 4 }, { thickness: 0.3 }))
    const text = serializeProject(doc.getSnapshot())

    const loaded = PlinthDocument.createEmpty()
    loaded.replaceContents(parseProject(text))
    const s = loaded.getSnapshot()
    expect(s.meta.name).toBe('House')
    expect(Object.keys(s.walls)).toHaveLength(4)
    expect(Object.values(s.walls).every((w) => w.thickness === 0.3)).toBe(true)
    expect(loaded.getHistory().canUndo).toBe(false)
  })

  it('rejects files that are not Plinth projects', () => {
    expect(() => parseProject('not json')).toThrow(ProjectFileError)
    expect(() => parseProject('{"format":"other"}')).toThrow(ProjectFileError)
    expect(() => parseProject('{"format":"plinth","version":99}')).toThrow(/version 99/)
  })

  it('drops walls that point at missing nodes', () => {
    const file = parseProject(
      JSON.stringify({
        format: 'plinth',
        version: 3,
        meta: { name: 'x', wallThickness: 0.2 },
        buildings: [{ id: 'B', name: 'B' }],
        levels: [{ id: 'L', buildingId: 'B', name: 'G', elevation: 0, height: 3 }],
        nodes: [{ id: 'a', levelId: 'L', x: 0, y: 0 }],
        walls: [{ id: 'w', levelId: 'L', a: 'a', b: 'missing', thickness: null, height: null, heightEnd: null }],
      }),
    )
    expect(file.walls).toEqual([])
  })
})

describe('parseLength', () => {
  it.each([
    ['3.5', 3.5],
    ['3,5', 3.5],
    ['3.5m', 3.5],
    ['350 cm', 3.5],
    ['3500mm', 3.5],
    ['.5', 0.5],
  ])('reads %s as %d m', (text, metres) => {
    expect(parseLength(text)).toBeCloseTo(metres)
  })

  it('rejects text that is not a length', () => {
    expect(parseLength('abc')).toBeNull()
    expect(parseLength('')).toBeNull()
    expect(parseLength('3 ft')).toBeNull()
  })
})

describe('older files', () => {
  it('refuses a file from before sites existed', () => {
    const old = JSON.stringify({ format: 'plinth', version: 2, meta: {}, levels: [], nodes: [], walls: [], openings: [] })
    expect(() => parseProject(old)).toThrow(/before sites/)
  })
})
