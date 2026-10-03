import { cp, mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
const output = resolve(import.meta.dirname, '../out/mobile')
await rm(output, { recursive: true, force: true })
await mkdir(output, { recursive: true })
await cp(resolve(import.meta.dirname, '../../mobile/dist'), output, { recursive: true })
