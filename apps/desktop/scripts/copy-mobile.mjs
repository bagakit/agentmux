import { cp, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
const output = resolve(import.meta.dirname, '../out/mobile')
await mkdir(output, { recursive: true })
await cp(resolve(import.meta.dirname, '../../mobile/dist'), output, { recursive: true })
