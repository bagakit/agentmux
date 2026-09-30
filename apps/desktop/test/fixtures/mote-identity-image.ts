import { deflateSync } from 'node:zlib'
import type { NativeImage } from 'electron'
function crc(bytes: Buffer): number {
  let value = 0xffffffff
  for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0) }
  return (value ^ 0xffffffff) >>> 0
}
export function imagePng(width = 256, height = 256, color = [38, 147, 119]): Buffer {
  const chunk = (name: string, data: Buffer) => { const type = Buffer.from(name), length = Buffer.alloc(4), checksum = Buffer.alloc(4); length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc(Buffer.concat([type, data]))); return Buffer.concat([length, type, data, checksum]) }
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2
  const row = Buffer.alloc(width * 3 + 1); for (let pixel = 0; pixel < width; pixel++) for (let channel = 0; channel < 3; channel++) row[1 + pixel * 3 + channel] = color[channel]!
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))), chunk('IEND', Buffer.alloc(0))])
}
export const imageInput = (bytes = imagePng()) => ({ mimeType: 'image/png' as const, dataUrl: 'data:image/png;base64,' + bytes.toString('base64') })
/** Native decode is a controlled boundary in Node owning tests; actual Electron proof uses nativeImage. */
export function controlledNativeImage(bytes: Buffer): NativeImage {
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20)
  return { isEmpty: () => false, getSize: () => ({ width, height }), toPNG: () => bytes,
    resize: ({ width: w, height: h }: { width: number; height: number }) => controlledNativeImage(imagePng(w, h)) } as unknown as NativeImage
}
