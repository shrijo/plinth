/** Lengths are metres internally; these helpers convert to and from text. */

const LENGTH_PATTERN = /^(-?(?:\d+(?:\.\d*)?|\.\d+))\s*(mm|cm|m)?$/

/**
 * Parses a typed length: "3.5", "3,5", "3.5m", "350cm" or "3500mm".
 * Returns metres, or null if the text isn't a length.
 */
export function parseLength(text: string): number | null {
  const match = LENGTH_PATTERN.exec(text.trim().toLowerCase().replace(',', '.'))
  if (!match) return null
  const value = Number(match[1])
  if (!Number.isFinite(value)) return null
  switch (match[2]) {
    case 'mm':
      return value / 1000
    case 'cm':
      return value / 100
    default:
      return value
  }
}

export function formatLength(metres: number, decimals = 2): string {
  return `${metres.toFixed(decimals)} m`
}

export function formatArea(squareMetres: number, decimals = 2): string {
  return `${squareMetres.toFixed(decimals)} m²`
}

export function formatAngle(radians: number, decimals = 1): string {
  let degrees = (radians * 180) / Math.PI
  if (degrees < 0) degrees += 360
  return `${degrees.toFixed(decimals)}°`
}
