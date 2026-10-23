import { register } from 'node:module'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

// Production plans name emitted .js entrypoints. In this source-only process,
// keep Node's actual entry identity consistent with the corresponding .ts file.
const packageRoot = resolve(import.meta.dirname, '../../..')
const entry = process.argv[1]
if (entry?.startsWith(packageRoot + '/') && entry.endsWith('.js') && !existsSync(entry)) {
  const source = entry.slice(0, -3) + '.ts'
  if (existsSync(source)) process.argv[1] = source
}
register(new URL('./source-loader.mjs', import.meta.url))
