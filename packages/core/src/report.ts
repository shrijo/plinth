import { analyzeSite } from './geometry/analysis.ts'
import type { Snapshot } from './model.ts'
import { AREA_STANDARD_DEFINITIONS, areaFigures, categoryOf, ROOM_USE_NAMES, roomTagsOf, roomTitle } from './areas.ts'

/** Display name of a room, by its position in its level's room list. */
export function roomName(index: number): string {
  return `Room ${index + 1}`
}

/**
 * The site's areas as CSV: one row per room (with its name, use and the
 * category of the project's area standard it counts towards), totals per
 * level and building, then each building's and the site's figures by the
 * standard. Areas in m², lengths in m, volumes in m³.
 */
export function areaReportCSV(snapshot: Snapshot): string {
  const analysis = analyzeSite(snapshot)
  const standard = snapshot.meta.areaStandard
  const standardName = AREA_STANDARD_DEFINITIONS[standard].name
  const rows: (string | number)[][] = [
    [
      'Building',
      'Level',
      'Room',
      'Use',
      `${standardName} category`,
      'Net floor area (m²)',
      'Perimeter (m)',
      'Clear height (m)',
      'Volume (m³)',
      'Gross floor area (m²)',
    ],
  ]
  const round = (n: number) => Math.round(n * 100) / 100
  for (const level of analysis.levels) {
    const building = snapshot.buildings[level.level.buildingId]?.name ?? ''
    const clearHeight = Math.max(0, level.level.height - snapshot.meta.slabThickness)
    // A run of copies is reported once, its rooms per floor and its total for all its floors.
    const name = level.floors > 1 ? `${level.level.name} (${level.floors} floors)` : level.level.name
    const tags = roomTagsOf(snapshot, level)
    level.rooms.forEach((room, i) => {
      const use = tags[i]?.use
      rows.push([
        building,
        name,
        roomTitle(i, tags[i]),
        use ? ROOM_USE_NAMES[use] : 'Not set',
        categoryOf(standard, use),
        round(room.area),
        round(room.perimeter),
        round(clearHeight),
        round(room.area * clearHeight),
        '',
      ])
    })
    rows.push([building, name, 'Level total', '', '', round(level.netArea * level.floors), '', '', '', round(level.grossArea * level.floors)])
  }
  for (const building of analysis.buildings.values()) {
    const name = snapshot.buildings[building.buildingId]?.name ?? ''
    rows.push([name, '', 'Building total', '', '', round(building.netArea), '', '', '', round(building.grossArea)])
  }
  rows.push(['Site', '', 'Total', '', '', round(analysis.netArea), '', '', '', round(analysis.grossArea)])

  // The standard's figures, per building and for the site.
  rows.push([])
  rows.push(['Building', `${standardName}`, 'Figure', 'Value', 'Unit'])
  const figures = (name: string, buildingId?: string) => {
    for (const line of areaFigures(snapshot, buildingId, standard).lines) {
      rows.push([name, line.code, line.name, round(line.value), line.unit])
    }
  }
  for (const building of analysis.buildings.values()) figures(snapshot.buildings[building.buildingId]?.name ?? '', building.buildingId)
  figures('Site')
  return `${rows.map((row) => row.map(csvCell).join(',')).join('\n')}\n`
}

function csvCell(value: string | number): string {
  const text = String(value)
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}
