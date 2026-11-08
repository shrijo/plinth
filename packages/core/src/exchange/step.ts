/**
 * Writing STEP physical files (ISO 10303-21), the text format IFC uses:
 * numbered entity instances, one per line, referring to each other by
 * number.
 */

/** A value already written in STEP syntax. */
export type StepValue = string & { readonly __step?: true }

export class StepWriter {
  private lines: string[] = []
  private next = 1

  /** Adds an entity instance and returns a reference to it. */
  add(type: string, ...attributes: StepValue[]): StepValue {
    const id = this.next++
    this.lines.push(`#${id}=${type}(${attributes.join(',')});`)
    return `#${id}` as StepValue
  }

  get count(): number {
    return this.next - 1
  }

  /** The whole file. */
  file(header: { description: string; name: string; time: string; system: string; schema: string }): string {
    return [
      'ISO-10303-21;',
      'HEADER;',
      `FILE_DESCRIPTION((${str(header.description)}),'2;1');`,
      `FILE_NAME(${str(header.name)},${str(header.time)},(''),(''),${str(header.system)},${str(header.system)},'');`,
      `FILE_SCHEMA((${str(header.schema)}));`,
      'ENDSEC;',
      'DATA;',
      ...this.lines,
      'ENDSEC;',
      'END-ISO-10303-21;',
      '',
    ].join('\n')
  }
}

/** No value. */
export const NONE = '$' as StepValue
/** A value derived from others (left out). */
export const DERIVED = '*' as StepValue

/** A string, with quotes doubled, backslashes escaped and anything outside ASCII as \X2\ hex. */
export function str(text: string): StepValue {
  let out = ''
  let wide = ''
  const flush = () => {
    if (wide) out += `\\X2\\${wide}\\X0\\`
    wide = ''
  }
  for (const char of text) {
    const code = char.codePointAt(0)!
    if (code >= 32 && code < 127) {
      flush()
      out += char === "'" ? "''" : char === '\\' ? '\\\\' : char
    } else if (code < 32) {
      flush()
      out += ' '
    } else {
      // UTF-16 code units, four hex digits each.
      for (const unit of String.fromCodePoint(code).split('')) wide += unit.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')
    }
  }
  flush()
  return `'${out}'` as StepValue
}

/** A real number: always with a decimal point, never in JavaScript's exponent form. */
export function real(value: number): StepValue {
  if (!Number.isFinite(value)) return '0.' as StepValue
  const rounded = Math.round(value * 1e6) / 1e6
  if (rounded === 0) return '0.' as StepValue
  // toFixed keeps the point; trailing zeros go ("2.500000" is "2.5", "3.000000" is "3.").
  return rounded.toFixed(6).replace(/0+$/, '') as StepValue
}

export const int = (value: number): StepValue => String(Math.round(value)) as StepValue
export const enumeration = (name: string): StepValue => `.${name}.` as StepValue
export const bool = (value: boolean): StepValue => (value ? '.T.' : '.F.') as StepValue
export const list = (items: readonly StepValue[]): StepValue => `(${items.join(',')})` as StepValue
export const typed = (type: string, value: StepValue): StepValue => `${type}(${value})` as StepValue

const GUID_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$'

/**
 * An IFC GlobalId (a 128-bit GUID in IFC's 22-character base-64) made from
 * a key, so exporting the same model twice gives each element the same id.
 */
export function guid(key: string): StepValue {
  const bytes: number[] = []
  for (let seed = 0; seed < 4; seed++) {
    let h = (0x811c9dc5 ^ (seed * 0x9e3779b9)) >>> 0
    for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193) >>> 0
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0
    h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0
    h = (h ^ (h >>> 15)) >>> 0
    bytes.push((h >>> 24) & 255, (h >>> 16) & 255, (h >>> 8) & 255, h & 255)
  }
  // A version 4 (random-style) UUID.
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const b64 = (value: number, digits: number) => {
    let out = ''
    for (let i = 0; i < digits; i++) {
      out = GUID_CHARS[value % 64]! + out
      value = Math.floor(value / 64)
    }
    return out
  }
  let out = b64(bytes[0]!, 2)
  for (let i = 1; i < 16; i += 3) out += b64((bytes[i]! << 16) + (bytes[i + 1]! << 8) + bytes[i + 2]!, 4)
  return str(out)
}
