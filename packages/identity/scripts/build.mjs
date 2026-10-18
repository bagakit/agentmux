import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { bundleIdentityRuntime } from './runtime-bundle.mjs'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
execFileSync('pnpm', ['exec', 'tsc', '-p', 'tsconfig.json'], { cwd: packageRoot, stdio: 'inherit' })
const { module, source } = await bundleIdentityRuntime()
const dist = new URL('../dist/', import.meta.url)
await mkdir(dist, { recursive: true })
await Promise.all([
  writeFile(new URL('runtime.js', dist), module),
  writeFile(new URL('runtime-source.js', dist), `export const identityRuntimeSource = ${JSON.stringify(source)};\n`),
  writeFile(new URL('runtime-source.d.ts', dist), 'export declare const identityRuntimeSource: string;\n'),
])
