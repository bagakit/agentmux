// Original deterministic PNG/RAR4-store fixtures. No external archiver or copyrighted artwork.
import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
function crc32(bytes) {
  let value = 0xffffffff
  for (const byte of bytes) { value ^= byte; for (let i = 0; i < 8; ++i) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0) }
  return (value ^ 0xffffffff) >>> 0
}
const u16 = value => { const b = Buffer.alloc(2); b.writeUInt16LE(value); return b }
const u32 = value => { const b = Buffer.alloc(4); b.writeUInt32LE(value); return b }
const header = (type, flags, payload) => { const bytes = Buffer.concat([Buffer.from([type]), u16(flags), u16(payload.length + 7), payload]); return Buffer.concat([u16(crc32(bytes) & 0xffff), bytes]) }
const chunk = (name, bytes) => { const type = Buffer.from(name), size = Buffer.alloc(4); size.writeUInt32BE(bytes.length); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([type, bytes]))); return Buffer.concat([size, type, bytes, crc]) }
function png(color) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(16); ihdr.writeUInt32BE(16, 4); ihdr[8] = 8; ihdr[9] = 6
  const pixels = Buffer.concat(Array.from({ length: 16 }, () => Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: 16 }, () => color).flat())])))
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))])
}
const pages = [['page 001.png', png([220, 40, 40, 255])], ['dir/page\n[002]*?\\.png', png([30, 150, 70, 255])], ['page010.png', png([30, 70, 220, 255])]]
const entries = pages.map(([path, bytes]) => {
  const name = Buffer.from(path)
  // HOST_UNIX + regular file 0644, RAR method 0x30 (store).
  const metadata = Buffer.concat([u32(bytes.length), u32(bytes.length), Buffer.from([3]), u32(crc32(bytes)), u32(0), Buffer.from([20, 0x30]), u16(name.length), u32(0o100644), name])
  return Buffer.concat([header(0x74, 0x8000, metadata), bytes])
})
const archive = Buffer.concat([Buffer.from('526172211a0700', 'hex'), header(0x73, 0, Buffer.alloc(6)), ...entries, header(0x7b, 0, Buffer.alloc(0))])
writeFileSync(fileURLToPath(new URL('./original-pages.cbr', import.meta.url)), archive)
for (let i = 0; i < pages.length; i++) writeFileSync(fileURLToPath(new URL(`./page-${i + 1}.png`, import.meta.url)), pages[i][1])
