/**
 * Heights carried by lines: each line (a street's middle, node to node)
 * knows its height along itself, and a point of the plan takes the height
 * of the lines that reach it, level across each and blended where several
 * meet, the way the ground blends its street beds (see makeGround). So a
 * road is flat from kerb to kerb however wide it was built, and a crossing
 * has no step.
 */
export interface FieldLine {
  ax: number
  ay: number
  bx: number
  by: number
  /** The line counts fully to this far either side of it (metres), and fades out over the field's reach beyond. */
  half: number
  /** Its height a distance along it (metres from a). */
  height: (along: number) => number
  /** Counts only this far along from a (the rest of it isn't there for this field); its whole length by default. */
  to?: number
  from?: number
}

const CELL = 24

export class LineField {
  private readonly lines: (FieldLine & { length: number })[] = []
  private readonly cells = new Map<number, number[]>()
  private readonly reach: number

  private readonly hold: boolean

  /**
   * `reach`: how far beyond a line's half width it still counts, fading (metres). With `hold`, a point any
   * line reaches takes the lines' height whole (a deck is level out to its edge, however wide); otherwise
   * it fades into the fallback's with their reach.
   */
  constructor(reach: number, hold = false) {
    this.reach = reach
    this.hold = hold
  }

  get size(): number {
    return this.lines.length
  }

  add(line: FieldLine): void {
    const length = Math.hypot(line.bx - line.ax, line.by - line.ay)
    if (length < 1e-6) return
    const index = this.lines.push({ ...line, length }) - 1
    const pad = line.half + this.reach
    const x0 = Math.floor((Math.min(line.ax, line.bx) - pad) / CELL)
    const x1 = Math.floor((Math.max(line.ax, line.bx) + pad) / CELL)
    const y0 = Math.floor((Math.min(line.ay, line.by) - pad) / CELL)
    const y1 = Math.floor((Math.max(line.ay, line.by) + pad) / CELL)
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const key = (y + 4096) * 8192 + x + 4096
        const list = this.cells.get(key)
        if (list) list.push(index)
        else this.cells.set(key, [index])
      }
    }
  }

  /** How strongly the lines reach the point last asked of `at` (0: none does, 1: it's on one). */
  reached = 0

  /** The height at a point, or `fallback`'s where no line reaches (blended towards it at the edge of their reach). */
  at(x: number, y: number, fallback: (x: number, y: number) => number): number {
    this.reached = 0
    const list = this.cells.get((Math.floor(y / CELL) + 4096) * 8192 + Math.floor(x / CELL) + 4096)
    if (!list) return fallback(x, y)
    let weights = 0
    let sum = 0
    for (const index of list) {
      const s = this.lines[index]!
      const dx = s.bx - s.ax
      const dy = s.by - s.ay
      let t = ((x - s.ax) * dx + (y - s.ay) * dy) / s.length
      const from = s.from ?? 0
      const to = s.to ?? s.length
      t = t < from ? from : t > to ? to : t
      const d = Math.hypot(x - s.ax - (dx * t) / s.length, y - s.ay - (dy * t) / s.length)
      if (d > s.half + this.reach) continue
      let w = 1
      if (d > s.half) {
        const f = 1 - (d - s.half) / this.reach
        w = f * f * (3 - 2 * f)
      }
      if (w < 0.004) continue
      weights += w
      sum += w * s.height(t)
    }
    if (weights === 0) return fallback(x, y)
    this.reached = Math.min(weights, 1)
    const blend = sum / weights
    if (weights >= 1 || this.hold) return blend
    const beyond = fallback(x, y)
    return beyond + (blend - beyond) * weights
  }
}
