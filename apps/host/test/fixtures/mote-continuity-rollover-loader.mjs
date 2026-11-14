import * as original from '../../../../packages/core/test/fixtures/a2a-resumed-inbox/source-loader.mjs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { relative, resolve as resolvePath } from 'node:path'
import { stripTypeScriptTypes } from 'node:module'
import { instrumentPolicy } from './mote-continuity-rollover-mutations.mjs'
const root = resolvePath(import.meta.dirname, '../../../..')
export const resolve = original.resolve
export async function load(url, context, next) {
  if (url.startsWith('file:') && url.endsWith('.ts')) {
    const file = fileURLToPath(url), source = await readFile(file, 'utf8'), loaded = instrumentPolicy(source, relative(root, file))
    if (loaded !== source) return { format: 'module', source: stripTypeScriptTypes(loaded, { mode: 'transform', sourceUrl: url }), shortCircuit: true }
  }
  return original.load(url, context, next)
}
