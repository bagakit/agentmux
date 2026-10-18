import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
execFileSync('pnpm', ['exec', 'tsc', '-p', 'tsconfig.json'], { cwd: packageRoot, stdio: 'inherit' })
const options = {
  absWorkingDir: packageRoot,
  entryPoints: ['src/runtime-entry.ts'],
  bundle: true,
  platform: 'neutral',
  target: 'es2022',
  minify: true,
  legalComments: 'none',
  write: false,
}
const [module, script] = await Promise.all([
  build({ ...options, format: 'esm' }),
  build({ ...options, format: 'iife', globalName: 'AgentMuxIdentity' }),
])
const source = `(()=>{${script.outputFiles[0].text};return AgentMuxIdentity;})()`
const dist = new URL('../dist/', import.meta.url)
await mkdir(dist, { recursive: true })
await Promise.all([
  writeFile(new URL('runtime.js', dist), module.outputFiles[0].text),
  writeFile(new URL('runtime-source.js', dist), `export const identityRuntimeSource = ${JSON.stringify(source)};\n`),
  writeFile(new URL('runtime-source.d.ts', dist), 'export declare const identityRuntimeSource: string;\n'),
])
