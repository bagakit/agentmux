import { deflateSync } from 'node:zlib'
import { open } from 'node:fs/promises'
const table = Uint32Array.from({length:256},(_,value)=>{for(let i=0;i<8;i++)value=(value>>>1)^((value&1)?0xedb88320:0);return value>>>0})
const crc32 = (bytes: Uint8Array) => {let crc=0xffffffff;for(const byte of bytes)crc=(crc>>>8)^table[(crc^byte)&255]!;return (crc^0xffffffff)>>>0}
const u16 = (value:number) => {const b=Buffer.alloc(2);b.writeUInt16LE(value);return b}
const u32 = (value:number) => {const b=Buffer.alloc(4);b.writeUInt32LE(value);return b}
const header = (type:number,flags:number,payload:Buffer) => {const bytes=Buffer.concat([Buffer.from([type]),u16(flags),u16(payload.length+7),payload]);return Buffer.concat([u16(crc32(bytes)&0xffff),bytes])}
const chunk = (name:string,bytes:Buffer) => {const type=Buffer.from(name),size=Buffer.alloc(4),crc=Buffer.alloc(4);size.writeUInt32BE(bytes.length);crc.writeUInt32BE(crc32(Buffer.concat([type,bytes])));return Buffer.concat([size,type,bytes,crc])}
/** Original 128-page, ~32 MiB RAR4-store sample. The generator streams the archive to disk. */
export async function largeCbr(path:string):Promise<void> {
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(256);ihdr.writeUInt32BE(256,4);ihdr[8]=8;ihdr[9]=6
  const pixels=Buffer.alloc(256*(256*4+1));let seed=104729
  for(let y=0;y<256;y++)for(let x=1;x<=256*4;x++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;pixels[y*(256*4+1)+x]=seed>>>24}
  const image=Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]),file=await open(path,'w')
  try {
    await file.write(Buffer.concat([Buffer.from('526172211a0700','hex'),header(0x73,0,Buffer.alloc(6))]))
    for(let index=0;index<128;index++){
      const name=Buffer.from(`page-${String(index).padStart(3,'0')}.png`),metadata=Buffer.concat([u32(image.length),u32(image.length),Buffer.from([3]),u32(crc32(image)),u32(0),Buffer.from([20,0x30]),u16(name.length),u32(0o100644),name])
      await file.write(header(0x74,0x8000,metadata));await file.write(image)
    }
    await file.write(header(0x7b,0,Buffer.alloc(0)))
  }finally{await file.close()}
}
