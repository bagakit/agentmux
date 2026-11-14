import * as source from './a2a-resumed-inbox/source-loader.mjs'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { relative, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { instrumentHeartbeatReport } from './mote-heartbeat-report-mutations.mjs'
const root = resolvePath(import.meta.dirname, '../../../..')
export const resolve = source.resolve
export async function load(url, context, next) {
  if (url.startsWith('file:') && url.endsWith('.ts')) {
    const path = fileURLToPath(url), original = await readFile(path, 'utf8'), loaded = instrumentHeartbeatReport(original, relative(root, path))
    if (loaded !== original) return { format: 'module', source: stripTypeScriptTypes(loaded, { mode: 'transform', sourceUrl: url }), shortCircuit: true }
  }
  return source.load(url, context, next)
}
