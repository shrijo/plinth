/**
 * Reads PNG images, for ground heights: a canvas would do it, but browsers
 * may manage colours or (against fingerprinting) jitter the pixels read
 * back, and heights must come out exactly as stored. 8-bit images,
 * greyscale, RGB, palette or with alpha; not interlaced.
 */

export interface Pixels {
  width: number
  height: number
  /** RGBA, four bytes per pixel. */
  data: Uint8Array
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]

export async function decodePng(bytes: Uint8Array): Promise<Pixels> {
  for (let i = 0; i < 8; i++) if (bytes[i] !== SIGNATURE[i]) throw new Error('Not a PNG image')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let at = 8
  let width = 0
  let height = 0
  let depth = 0
  let type = 0
  let interlace = 0
  let palette: Uint8Array | null = null
  let transparency: Uint8Array | null = null
  const chunks: Uint8Array[] = []
  while (at + 8 <= bytes.length) {
    const length = view.getUint32(at)
    const name = String.fromCharCode(bytes[at + 4]!, bytes[at + 5]!, bytes[at + 6]!, bytes[at + 7]!)
    const body = bytes.subarray(at + 8, at + 8 + length)
    at += 12 + length
    if (name === 'IHDR') {
      width = view.getUint32(body.byteOffset - bytes.byteOffset)
      height = view.getUint32(body.byteOffset - bytes.byteOffset + 4)
      depth = body[8]!
      type = body[9]!
      interlace = body[12]!
    } else if (name === 'PLTE') palette = body
    else if (name === 'tRNS') transparency = body
    else if (name === 'IDAT') chunks.push(body)
    else if (name === 'IEND') break
  }
  if (depth !== 8 || interlace !== 0) throw new Error('Only 8-bit, non-interlaced PNG images can be read')
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[type]
  if (!channels) throw new Error(`PNG colour type ${type} isn't supported`)
  const raw = await inflate(chunks)
  const stride = width * channels
  const pixels = new Uint8Array(stride * height)
  // Undo each row's filter (against the row above, already undone).
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const out = pixels.subarray(y * stride, (y + 1) * stride)
    const above = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? out[x - channels]! : 0
      const up = above ? above[x]! : 0
      const corner = above && x >= channels ? above[x - channels]! : 0
      let value = row[x]!
      if (filter === 1) value += left
      else if (filter === 2) value += up
      else if (filter === 3) value += (left + up) >> 1
      else if (filter === 4) value += paeth(left, up, corner)
      out[x] = value & 255
    }
  }
  const data = new Uint8Array(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    const p = i * channels
    if (type === 2 || type === 6) {
      data[i * 4] = pixels[p]!
      data[i * 4 + 1] = pixels[p + 1]!
      data[i * 4 + 2] = pixels[p + 2]!
      data[i * 4 + 3] = type === 6 ? pixels[p + 3]! : 255
    } else if (type === 3) {
      const index = pixels[p]!
      data[i * 4] = palette?.[index * 3] ?? 0
      data[i * 4 + 1] = palette?.[index * 3 + 1] ?? 0
      data[i * 4 + 2] = palette?.[index * 3 + 2] ?? 0
      data[i * 4 + 3] = transparency?.[index] ?? 255
    } else {
      data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = pixels[p]!
      data[i * 4 + 3] = type === 4 ? pixels[p + 1]! : 255
    }
  }
  return { width, height, data }
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/** zlib data (PNG's image data) inflated, with the platform's own decompressor. */
async function inflate(chunks: Uint8Array[]): Promise<Uint8Array> {
  const stream = new Blob(chunks as BlobPart[]).stream().pipeThrough(new DecompressionStream('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}
