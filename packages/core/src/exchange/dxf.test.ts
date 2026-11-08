import DxfParser from 'dxf-parser'
import { describe, expect, it } from 'vitest'
import { PlinthDocument } from '../document.ts'
import { buildExampleCity } from '../examples/exampleCity.ts'
import { exportDXF } from './dxf.ts'

describe('DXF export', () => {
  it('writes floor plans a DXF reader can open, a layer set per floor', () => {
    const doc = PlinthDocument.createEmpty()
    doc.build((tx) => buildExampleCity(tx))
    const text = exportDXF(doc.getSnapshot())
    expect(text.endsWith('EOF\n')).toBe(true)
    const parsed = new DxfParser().parseSync(text)!
    const layers = Object.keys(parsed.tables.layer.layers)
    for (const name of ['F00-WALLS', 'F00-WALLS-FILL', 'F00-OPENINGS', 'F00-ROOMS', 'F00-TEXT', 'F01-WALLS', 'SITE-BUILDINGS', 'SITE-STREETS']) {
      expect(layers).toContain(name)
    }
    const byType = (type: string) => parsed.entities.filter((e) => e.type === type)
    expect(byType('POLYLINE').length).toBeGreaterThan(1000)
    expect(byType('SOLID').length).toBeGreaterThan(1000)
    expect(byType('ARC').length).toBeGreaterThan(50)
    const labels = byType('TEXT').map((e) => (e as unknown as { text: string }).text)
    expect(labels.some((t) => /^Room \d+$/.test(t))).toBe(true)
    expect(labels.some((t) => /m2/.test(t))).toBe(true)
    // Everything in the plan's extent, in metres.
    const header = parsed.header as Record<string, { x: number; y: number }>
    expect(header.$EXTMAX!.x - header.$EXTMIN!.x).toBeGreaterThan(400)
    expect(header.$EXTMAX!.x - header.$EXTMIN!.x).toBeLessThan(2000)
  })
})
