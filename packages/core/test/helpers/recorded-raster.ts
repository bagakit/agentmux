import { crc32, deflateSync } from 'node:zlib'

/** Valid deterministic RGB raster whose original base64 crosses the native lazy-string boundary. */
export function recordedRaster(width = 800, height = width) {
  const stride = width * 3 + 1, pixels = Buffer.alloc(stride * height)
  let state = 0x51b03
  for (let y = 0; y < height; y++) for (let x = 1; x < stride; x++) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5
    pixels[y * stride + x] = state & 255
  }
  const chunk = (type: string, value: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), value]), length = Buffer.alloc(4), crc = Buffer.alloc(4)
    length.writeUInt32BE(value.length); crc.writeUInt32BE(crc32(body)); return Buffer.concat([length, body, crc])
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2
  const bytes = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))])
  return { bytes, width, height, reference: 'data:image/png;base64,' + bytes.toString('base64') }
}
