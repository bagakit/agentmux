import { rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const distDirectory = fileURLToPath(new URL('../dist/', import.meta.url))
const buildInfo = fileURLToPath(new URL('../tsconfig.build.tsbuildinfo', import.meta.url))

await Promise.all([
  rm(distDirectory, { recursive: true, force: true }),
  rm(buildInfo, { force: true })
])
