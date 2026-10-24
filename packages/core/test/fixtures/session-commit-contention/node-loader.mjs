import { stripTypeScriptTypes } from 'node:module'
import { readFile } from 'node:fs/promises'
import { relative, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { load as originalLoad } from '../../../../../apps/desktop/scripts/fixtures/performance-failure-evidence/source-loader.mjs'
import { instrumentCommitContentionSource } from './mutations.mjs'
export { resolve } from '../../../../../apps/desktop/scripts/fixtures/performance-failure-evidence/source-loader.mjs'
const root = resolvePath(import.meta.dirname, '../../../../..')

export async function load(url, context, next) {
  if (url.startsWith('file:')) {
    const path = relative(root, fileURLToPath(url))
    if (path.startsWith('packages/core/src/') && path.endsWith('.ts')) {
      const source = instrumentCommitContentionSource(await readFile(fileURLToPath(url), 'utf8'), path)
      return { format: 'module', source: stripTypeScriptTypes(source, { mode: 'transform', sourceUrl: url }), shortCircuit: true }
    }
  }
  return await originalLoad(url, context, next)
}
