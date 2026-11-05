import { analyzeSite } from './geometry/analysis.ts'
import type { Snapshot } from './model.ts'

/** Display name of a room, by its position in its level's room list. */
export function roomName(index: number): string {
  return `Room ${index + 1}`
}

/**
 * The building's areas as CSV: one row per room, then totals per level and
 * for the building. Areas in m², lengths in m, volumes in m³.
 */
export function areaReportCSV(snapshot: Snapshot): string {
  const analysis = analyzeSite(snapshot)
  const rows: (string | number)[][] = [
    ['Building', 'Level', 'Room', 'Net floor area (m²)', 'Perimeter (m)', 'Clear height (m)', 'Volume (m³)', 'Gross floor area (m²)'],
  ]
  const round = (n: number) => Math.round(n * 100) / 100
  for (const level of analysis.levels) {
    const building = snapshot.buildings[level.level.buildingId]?.name ?? ''
    const clearHeight = Math.max(0, level.level.height - snapshot.meta.slabThickness)
    // A run of copies is reported once, its rooms per floor and its total for all its floors.
    const name = level.floors > 1 ? `${level.level.name} (${level.floors} floors)` : level.level.name
    level.rooms.forEach((room, i) => {
      rows.push([
        building,
        name,
        roomName(i),
        round(room.area),
        round(room.perimeter),
        round(clearHeight),
        round(room.area * clearHeight),
        '',
      ])
    })
    rows.push([building, name, 'Level total', round(level.netArea * level.floors), '', '', '', round(level.grossArea * level.floors)])
  }
  for (const building of analysis.buildings.values()) {
    const name = snapshot.buildings[building.buildingId]?.name ?? ''
    rows.push([name, '', 'Building total', round(building.netArea), '', '', '', round(building.grossArea)])
  }
  rows.push(['Site', '', 'Total', round(analysis.netArea), '', '', '', round(analysis.grossArea)])
  return `${rows.map((row) => row.map(csvCell).join(',')).join('\n')}\n`
}

function csvCell(value: string | number): string {
  const text = String(value)
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}
