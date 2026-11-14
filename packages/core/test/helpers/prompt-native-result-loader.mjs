import * as base from '../../../../apps/desktop/scripts/fixtures/performance-failure-evidence/source-loader.mjs'
import { stripTypeScriptTypes } from 'node:module'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve as pathResolve, relative } from 'node:path'
import { instrument, owners } from './prompt-native-result-mutations.mjs'
const root = pathResolve(import.meta.dirname, '../../../..')
export const resolve = base.resolve
export async function load(url, context, next) {
  if (url.startsWith('file:') && url.endsWith('.ts')) {
    const file = fileURLToPath(url), name = relative(root, file)
    if (owners.has(name)) return { format: 'module', source: stripTypeScriptTypes(instrument(await readFile(file, 'utf8'), name), { mode: 'transform', sourceUrl: url }), shortCircuit: true }
  }
  return base.load(url, context, next)
}
