// Private current-source worker/CLI proof. No compiled or installed launcher claim.
import { readFile } from 'node:fs/promises'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { stripTypeScriptTypes } from 'node:module'
import { relative, resolve as pathResolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as original from '../hook-delivery/source-loader.mjs'
const root = pathResolve(import.meta.dirname, '../../../../..')
const hash = source => createHash('sha256').update(source).digest('hex')
export const resolve = original.resolve
export async function load(url, context, next) {
  const file = url.startsWith('file:') ? relative(root, fileURLToPath(url)) : ''
  if (process.env.CAPTURED_G_MUTATION && file.startsWith('packages/') && !file.includes('/node_modules/')) {
    const mutation = JSON.parse(await readFile(process.env.CAPTURED_G_MUTATION, 'utf8'))
    if (mutation.file === file) {
      const source = await readFile(fileURLToPath(url), 'utf8')
      if (source.split(mutation.before).length !== 2) throw Error('Worker inverse must identify exactly one owner: ' + mutation.name)
      const loaded = source.replace(mutation.before, mutation.after)
      if (process.env.CAPTURED_G_CHILD_LOADED) appendFileSync(process.env.CAPTURED_G_CHILD_LOADED,
        JSON.stringify({ path: file, originalSHA256: hash(source), loadedSHA256: hash(loaded), mutation: mutation.name }) + '\n')
      return { format: 'module', source: stripTypeScriptTypes(loaded, { mode: 'transform', sourceUrl: url }), shortCircuit: true }
    }
  }
  return original.load(url, context, next)
}
