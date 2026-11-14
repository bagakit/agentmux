import assert from 'node:assert/strict'
import { appendFile, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { relative, resolve as pathResolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as original from './a2a-resumed-inbox/source-loader.mjs'

const root = pathResolve(import.meta.dirname, '../../../..')
export const resolve = original.resolve
export async function load(url, context, next) {
  const result = await original.load(url, context, next)
  const path = url.startsWith('file:') ? relative(root, fileURLToPath(url)) : ''
  if (path !== 'apps/host/src/mote-dialogue.ts') return result
  const source = await readFile(fileURLToPath(url), 'utf8')
  const mutation = process.env.MOTE_RESTART_MUTATION
  if (mutation) assert.equal(mutation, 'drop-retained-work', 'Select the exact retained-source mutation')
  const anchor = 'const page = main.identity ? await options.store.read(main.identity, input, main) : { links: [], incarnation: null, throughSequence: 0, next: null }'
  if (mutation) assert.equal(source.split(anchor).length, 2, 'The mutation must bind one original Host read owner')
  const changed = mutation ? source.replace(anchor, 'const page = { links: [], incarnation: null, throughSequence: 0, next: null }') : source
  let loaded = result
  if (mutation) {
    const ts = await import('typescript')
    loaded = { ...result, source: ts.transpileModule(changed, { fileName: path,
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText }
  }
  if (process.env.MOTE_RESTART_SOURCE_TRACE) {
    const sha = value => createHash('sha256').update(value).digest('hex')
    await appendFile(process.env.MOTE_RESTART_SOURCE_TRACE,
      JSON.stringify({ path, originalSHA256: sha(source), selectedSHA256: sha(changed), loadedSHA256: sha(loaded.source), mutation: mutation ?? null }) + '\n')
  }
  return loaded
}
