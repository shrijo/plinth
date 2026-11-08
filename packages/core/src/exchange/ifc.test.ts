import { describe, expect, it } from 'vitest'
import * as WebIFC from 'web-ifc'
import { PlinthDocument } from '../document.ts'
import { buildExampleCity } from '../examples/exampleCity.ts'
import { exportIFC } from './ifc.ts'
import { guid, real, str } from './step.ts'

describe('STEP', () => {
  it('writes reals with a point and no exponent', () => {
    expect([real(1), real(2.5), real(-0.125), real(1e-9), real(12345.6789)]).toEqual(['1.', '2.5', '-0.125', '0.', '12345.6789'])
  })
  it('escapes strings', () => {
    expect(str("it's")).toBe("'it''s'")
    expect(str('Zürich')).toBe("'Z\\X2\\00FC\\X0\\rich'")
  })
  it('makes 22-character GlobalIds, the same for the same key', () => {
    const id = guid('wall:1')
    expect(id).toMatch(/^'[0-3][0-9A-Za-z_$]{21}'$/)
    expect(guid('wall:1')).toBe(id)
    expect(guid('wall:2')).not.toBe(id)
  })
})

describe('IFC export', () => {
  it('writes a file IFC software can open, with every building, storey, wall, opening and room', async () => {
    const doc = PlinthDocument.createEmpty()
    doc.build((tx) => buildExampleCity(tx))
    const snapshot = doc.getSnapshot()
    const text = exportIFC(snapshot, { time: new Date('2026-11-05T12:00:00Z') })
    expect(text.startsWith('ISO-10303-21;')).toBe(true)

    const api = new WebIFC.IfcAPI()
    await api.Init()
    const model = api.OpenModel(new TextEncoder().encode(text))
    const count = (type: number) => api.GetLineIDsWithType(model, type).size()
    expect(count(WebIFC.IFCPROJECT)).toBe(1)
    expect(count(WebIFC.IFCBUILDING)).toBe(Object.keys(snapshot.buildings).length)
    expect(count(WebIFC.IFCBUILDINGSTOREY)).toBeGreaterThan(Object.keys(snapshot.buildings).length)
    expect(count(WebIFC.IFCWALL)).toBeGreaterThan(500)
    expect(count(WebIFC.IFCWINDOW)).toBeGreaterThan(500)
    expect(count(WebIFC.IFCDOOR)).toBeGreaterThan(100)
    expect(count(WebIFC.IFCOPENINGELEMENT)).toBe(count(WebIFC.IFCWINDOW) + count(WebIFC.IFCDOOR))
    expect(count(WebIFC.IFCSPACE)).toBeGreaterThan(10)
    expect(count(WebIFC.IFCROOF)).toBeGreaterThan(20)
    // Every element's geometry loads.
    let meshes = 0
    let triangles = 0
    api.StreamAllMeshes(model, (mesh) => {
      meshes++
      for (let i = 0; i < mesh.geometries.size(); i++) {
        const geometry = api.GetGeometry(model, mesh.geometries.get(i).geometryExpressID)
        triangles += geometry.GetIndexDataSize() / 3
      }
    })
    expect(meshes).toBeGreaterThan(1000)
    expect(triangles).toBeGreaterThan(10000)
    api.CloseModel(model)
  }, 60000)
})
