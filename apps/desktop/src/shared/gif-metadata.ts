import type { GifMetadata } from './capture-sequence'
const identifier = 'AMUXGIF1001'
const text = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true })
const applicationId = text.encode(identifier)
type Block = { start: number; end: number }
/** Walk real GIF blocks; never search compressed image bytes for a metadata marker. */
export function inspectGif(bytes: Uint8Array): { width: number; height: number; delays: number[]; metadata: GifMetadata | null; metadataBlock: Block | null; trailer: number } {
  const fail = (): never => { throw new Error('This GIF is truncated or has invalid blocks.') }
  const word = (i: number) => bytes[i]! | bytes[i + 1]! << 8
  if (bytes.length < 14 || !['GIF87a', 'GIF89a'].includes(new TextDecoder().decode(bytes.subarray(0, 6)))) fail()
  const width = word(6), height = word(8)
  if (!width || !height) fail()
  let p = 13 + (bytes[10]! & 128 ? 3 * (1 << ((bytes[10]! & 7) + 1)) : 0), delay = 100
  const delays: number[] = []
  let metadataBlock: Block | null = null
  let metadata: GifMetadata | null = null
  const scanSubblocks = (collect?: Uint8Array[]) => {
    let size = 0
    for (;;) {
      if (p >= bytes.length) fail()
      const length = bytes[p++]!
      if (!length) return size
      if (p + length > bytes.length) fail()
      if (collect) collect.push(bytes.subarray(p, p + length))
      p += length
      size += length
    }
  }
  while (p < bytes.length) {
    const start = p, kind = bytes[p++]!
    if (kind === 0x3b) {
      if (!delays.length || p !== bytes.length) fail()
      if (metadata) validateGifMetadata(metadata, width, height, delays)
      return { width, height, delays, metadata, metadataBlock, trailer: start }
    }
    if (kind === 0x21) {
      if (p >= bytes.length) fail()
      const label = bytes[p++]!
      if (label === 0xf9) {
        if (bytes[p] !== 4) fail()
        delay = Math.max(10, word(p + 2) * 10)
      }
      if (label === 0xff && bytes[p] === applicationId.length && applicationId.every((byte, i) => byte === bytes[p + 1 + i])) {
        if (metadataBlock) throw new Error('This GIF has conflicting AgentMux metadata.')
        p += 1 + applicationId.length
        const chunks: Uint8Array[] = []
        const payload = new Uint8Array(scanSubblocks(chunks))
        let offset = 0
        for (const chunk of chunks) { payload.set(chunk, offset); offset += chunk.length }
        metadata = JSON.parse(decoder.decode(payload)) as GifMetadata
        metadataBlock = { start, end: p }
      } else {
        const size = scanSubblocks()
        if (label === 0xf9 && size !== 4) fail()
      }
      continue
    }
    if (kind !== 0x2c || p + 9 > bytes.length) fail()
    const packed = bytes[p + 8]!
    if (!word(p + 4) || !word(p + 6)) fail()
    p += 9 + (packed & 128 ? 3 * (1 << ((packed & 7) + 1)) : 0)
    if (p >= bytes.length) fail()
    p++ // LZW minimum code size
    scanSubblocks(); delays.push(delay); delay = 100
  }
  return fail()
}
export function validateGifMetadata(value: GifMetadata, width: number, height: number, delays: number[]): void {
  if (!value || value.schema !== 'agentmux.gif.v1' || value.width !== width || value.height !== height || !Array.isArray(value.delays) ||
    value.delays.length !== delays.length || value.delays.some((v, i) => v !== delays[i]) || !Array.isArray(value.keyframes)) throw new Error('GIF metadata does not match its actual frames.')
  const seen = new Set<number>()
  for (const frame of value.keyframes) {
    if (!frame || !Number.isInteger(frame.frameIndex) || frame.frameIndex < 0 || frame.frameIndex >= delays.length || typeof frame.note !== 'string' || seen.has(frame.frameIndex)) throw new Error('GIF keyframes need unique, valid frame indices and text notes.')
    seen.add(frame.frameIndex)
  }
}
export function writeGifMetadata(bytes: Uint8Array, metadata: GifMetadata): Uint8Array {
  const info = inspectGif(bytes)
  validateGifMetadata(metadata, info.width, info.height, info.delays)
  const payload = text.encode(JSON.stringify(metadata)), removed = info.metadataBlock
  const sourceEnd = info.trailer - (removed ? removed.end - removed.start : 0)
  // Header + application ID, one size byte per payload chunk, terminator and GIF trailer.
  const result = new Uint8Array(sourceEnd + 3 + applicationId.length + payload.length + Math.ceil(payload.length / 255) + 2)
  if (removed) {
    result.set(bytes.subarray(0, removed.start))
    result.set(bytes.subarray(removed.end, info.trailer), removed.start)
  } else {
    result.set(bytes.subarray(0, info.trailer))
  }
  result.set(text.encode('GIF89a'), 0)
  result.set([0x21, 0xff, applicationId.length], sourceEnd)
  result.set(applicationId, sourceEnd + 3)
  let offset = sourceEnd + 3 + applicationId.length
  for (let i = 0; i < payload.length; i += 255) {
    const part = payload.subarray(i, i + 255)
    result[offset++] = part.length
    result.set(part, offset)
    offset += part.length
  }
  result[offset + 1] = 0x3b
  return result
}
