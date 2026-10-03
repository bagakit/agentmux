import { build } from 'esbuild'
import { resolve } from 'node:path'
await build({ entryPoints: [resolve(import.meta.dirname, '../src/index.ts')],
  outfile: resolve(import.meta.dirname, '../dist/index.js'), bundle: true,
  packages: 'external', platform: 'node', format: 'esm', target: 'node24' })
