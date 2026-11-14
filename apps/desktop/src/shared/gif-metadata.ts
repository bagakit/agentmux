import type { GifMetadata } from './capture-sequence'
const identifier = 'AMUXGIF1001'
const text = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true })
type Block = { start: number; end: number; application?: string; data?: Uint8Array }
/** Walk real GIF blocks; never search compressed image bytes for a metadata marker. */
export function inspectGif(bytes: Uint8Array): { width: number; height: number; delays: number[]; metadata: GifMetadata | null; blocks: Block[]; trailer: number } {
  const fail = (): never => { throw new Error('This GIF is truncated or has invalid blocks.') }
  const word = (i: number) => bytes[i]! | bytes[i + 1]! << 8
  if (bytes.length < 14 || !['GIF87a', 'GIF89a'].includes(new TextDecoder().decode(bytes.subarray(0, 6)))) fail()
  const width = word(6), height = word(8)
  if (!width || !height) fail()
  let p = 13 + (bytes[10]! & 128 ? 3 * (1 << ((bytes[10]! & 7) + 1)) : 0), delay = 100
  const blocks: Block[] = [], delays: number[] = []
  let metadata: GifMetadata | null = null
  const subblocks = () => {
    const chunks: Uint8Array[] = []; let size = 0
    for (;;) {
      if (p >= bytes.length) fail()
      const length = bytes[p++]!
      if (!length) break
      if (p + length > bytes.length) fail()
      chunks.push(bytes.subarray(p, p + length)); size += length; p += length
    }
    const data = new Uint8Array(size); let offset = 0
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length }
    return data
  }
  while (p < bytes.length) {
    const start = p, kind = bytes[p++]!
    if (kind === 0x3b) {
      if (!delays.length || p !== bytes.length) fail()
      if (metadata) validateGifMetadata(metadata, width, height, delays)
      return { width, height, delays, metadata, blocks, trailer: start }
    }
    if (kind === 0x21) {
      if (p >= bytes.length) fail()
      const label = bytes[p++]!, data = subblocks()
      if (label === 0xf9) { if (data.length !== 4) fail(); delay = Math.max(10, (data[1]! | data[2]! << 8) * 10) }
      const application = label === 0xff ? new TextDecoder().decode(data.subarray(0, 11)) : undefined
      if (application === identifier) {
        if (metadata) throw new Error('This GIF has conflicting AgentMux metadata.')
        metadata = JSON.parse(decoder.decode(data.subarray(11))) as GifMetadata
      }
      blocks.push({ start, end: p, ...(application ? { application } : {}), data }); continue
    }
    if (kind !== 0x2c || p + 9 > bytes.length) fail()
    const packed = bytes[p + 8]!
    if (!word(p + 4) || !word(p + 6)) fail()
    p += 9 + (packed & 128 ? 3 * (1 << ((packed & 7) + 1)) : 0)
    if (p >= bytes.length) fail()
    p++ // LZW minimum code size
    subblocks(); delays.push(delay); delay = 100; blocks.push({ start, end: p })
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
  const payload = text.encode(JSON.stringify(metadata)), extension: number[] = [0x21, 0xff, 11, ...text.encode(identifier)]
  for (let i = 0; i < payload.length; i += 255) { const part = payload.subarray(i, i + 255); extension.push(part.length, ...part) }
  extension.push(0)
  const removed = info.blocks.find(block => block.application === identifier)
  const source = new Uint8Array(info.trailer - (removed ? removed.end - removed.start : 0))
  if (removed) { source.set(bytes.subarray(0, removed.start)); source.set(bytes.subarray(removed.end, info.trailer), removed.start) }
  else source.set(bytes.subarray(0, info.trailer))
  const result = new Uint8Array(source.length + extension.length + 1)
  result.set(source); result.set(text.encode('GIF89a'), 0); result.set(extension, source.length); result[result.length - 1] = 0x3b
  return result
}
