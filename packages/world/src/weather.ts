import { fetchWithRetry } from './sources.ts'

/**
 * The weather, as clouds need it: how much of the sky low, middle and high
 * cloud covers, and the wind, from Open-Meteo (free and open, from the
 * national weather services' models: ICON, GFS, ECMWF and others), on a
 * grid of points: the whole world coarsely, and finer round where the view
 * is. Values are 0 (clear) to 1 (overcast).
 */

export const WEATHER_ATTRIBUTION = 'Weather: Open-Meteo'

export interface WeatherGrid {
  /** The grid's corners (degrees) and its points across and down (west to east, south to north). */
  west: number
  south: number
  east: number
  north: number
  columns: number
  rows: number
  /** Low, middle and high cloud cover at each point, row by row from the south-west: three numbers each. */
  cover: Float32Array
  /** Wind at each point (metres a second towards the east and the north). */
  wind: Float32Array
  /** When the values are for (ISO time, UTC). */
  time: string
}

const API = 'https://api.open-meteo.com/v1/forecast'
const FIELDS = 'cloud_cover_low,cloud_cover_mid,cloud_cover_high,wind_speed_10m,wind_direction_10m'

interface Answer {
  current?: {
    time: string
    cloud_cover_low?: number
    cloud_cover_mid?: number
    cloud_cover_high?: number
    wind_speed_10m?: number
    wind_direction_10m?: number
  }
}

/**
 * Answers are kept for a quarter of an hour (the models' step): the free
 * service counts every point asked for, and allows a few hundred a minute.
 */
const KEEP = 15 * 60 * 1000
const kept = new Map<string, { at: number; grid: Promise<WeatherGrid> }>()

function remembered(key: string, fetchGrid: () => Promise<WeatherGrid>): Promise<WeatherGrid> {
  const now = Date.now()
  const hit = kept.get(key)
  if (hit && now - hit.at < KEEP) return hit.grid
  try {
    const stored = JSON.parse(sessionStorage.getItem(`plinth:weather:${key}`) ?? 'null') as
      | (Omit<WeatherGrid, 'cover' | 'wind'> & { at: number; cover: number[]; wind: number[] })
      | null
    if (stored && now - stored.at < KEEP) {
      const grid = Promise.resolve({ ...stored, cover: Float32Array.from(stored.cover), wind: Float32Array.from(stored.wind) })
      kept.set(key, { at: stored.at, grid })
      return grid
    }
  } catch {
    // No storage: just this page's memory.
  }
  const grid = fetchGrid()
  kept.set(key, { at: now, grid })
  grid.then(
    (g) => {
      try {
        sessionStorage.setItem(`plinth:weather:${key}`, JSON.stringify({ ...g, at: now, cover: Array.from(g.cover), wind: Array.from(g.wind) }))
      } catch {
        // As above.
      }
    },
    () => kept.delete(key),
  )
  return grid
}

/** The weather now on a grid of points (at most a few hundred a request). */
export async function fetchWeatherGrid(
  bounds: { west: number; south: number; east: number; north: number },
  columns: number,
  rows: number,
  signal?: AbortSignal,
): Promise<WeatherGrid> {
  const lats: number[] = []
  const lons: number[] = []
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < columns; i++) {
      lats.push(+(bounds.south + ((bounds.north - bounds.south) * j) / Math.max(rows - 1, 1)).toFixed(3))
      lons.push(+wrapLon(bounds.west + ((bounds.east - bounds.west) * i) / Math.max(columns - 1, 1)).toFixed(3))
    }
  }
  const cover = new Float32Array(lats.length * 3)
  const wind = new Float32Array(lats.length * 2)
  let time = ''
  // In batches, so no address gets too long.
  const batch = 320
  for (let start = 0; start < lats.length; start += batch) {
    const url = `${API}?latitude=${lats.slice(start, start + batch).join(',')}&longitude=${lons.slice(start, start + batch).join(',')}&current=${FIELDS}&wind_speed_unit=ms`
    const response = await fetchWithRetry(url, signal, 2)
    const json = (await response.json()) as Answer | Answer[]
    const answers = Array.isArray(json) ? json : [json]
    answers.forEach((answer, k) => {
      const at = start + k
      const now = answer.current
      if (!now) return
      time = now.time
      cover[at * 3] = (now.cloud_cover_low ?? 0) / 100
      cover[at * 3 + 1] = (now.cloud_cover_mid ?? 0) / 100
      cover[at * 3 + 2] = (now.cloud_cover_high ?? 0) / 100
      // The direction is where the wind comes from, clockwise from north.
      const speed = now.wind_speed_10m ?? 0
      const from = ((now.wind_direction_10m ?? 0) * Math.PI) / 180
      wind[at * 2] = -Math.sin(from) * speed
      wind[at * 2 + 1] = -Math.cos(from) * speed
    })
  }
  return { ...bounds, columns, rows, cover, wind, time }
}

/** The whole world, every 20 degrees (the last rows stand for the poles). */
export function fetchWorldWeather(signal?: AbortSignal): Promise<WeatherGrid> {
  return remembered('world', () => fetchWeatherGrid({ west: -180, east: 160, south: -80, north: 80 }, 18, 9, signal))
}

/** Round a point, every degree, three degrees each way (snapped to whole degrees, so nearby views share it). */
export function fetchLocalWeather(lon: number, lat: number, signal?: AbortSignal): Promise<WeatherGrid> {
  const lon0 = Math.round(lon)
  const lat0 = Math.max(-80, Math.min(80, Math.round(lat)))
  return remembered(`${lon0},${lat0}`, () => fetchWeatherGrid({ west: lon0 - 3, east: lon0 + 3, south: lat0 - 3, north: lat0 + 3 }, 7, 7, signal))
}

/** Cloud cover and wind at a point inside a grid (bilinear). */
export function weatherAt(grid: WeatherGrid, lon: number, lat: number): { low: number; mid: number; high: number; east: number; north: number } {
  const fx = Math.min(Math.max(((lon - grid.west) / (grid.east - grid.west)) * (grid.columns - 1), 0), grid.columns - 1)
  const fy = Math.min(Math.max(((lat - grid.south) / (grid.north - grid.south)) * (grid.rows - 1), 0), grid.rows - 1)
  const i = Math.min(Math.floor(fx), grid.columns - 2)
  const j = Math.min(Math.floor(fy), grid.rows - 2)
  const tx = fx - i
  const ty = fy - j
  const at = (values: Float32Array, stride: number, k: number) => {
    const v = (a: number, b: number) => values[(b * grid.columns + a) * stride + k]!
    return (v(i, j) * (1 - tx) + v(i + 1, j) * tx) * (1 - ty) + (v(i, j + 1) * (1 - tx) + v(i + 1, j + 1) * tx) * ty
  }
  return { low: at(grid.cover, 3, 0), mid: at(grid.cover, 3, 1), high: at(grid.cover, 3, 2), east: at(grid.wind, 2, 0), north: at(grid.wind, 2, 1) }
}

function wrapLon(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180
}
