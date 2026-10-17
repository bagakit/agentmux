import { stripTypeScriptTypes } from 'node:module'
import { readFile, appendFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolve as pathResolve, relative } from 'node:path'
import { desktopMapMutations } from '../../../test/helpers/desktop-map-source-mutations.mjs'
import * as original from '../performance-failure-evidence/source-loader.mjs'
const root = pathResolve(import.meta.dirname, '../../../../..')
export const resolve = original.resolve
const sha = value => createHash('sha256').update(value).digest('hex')
export async function load(url, context, next) {
  if (!url.startsWith(pathToFileURL(root + '/').href) || !url.endsWith('.ts')) return original.load(url, context, next)
  const file = fileURLToPath(url), path = relative(root, file), source = await readFile(file, 'utf8')
  const selected = process.env.AGENTMUX_DESKTOP_MAP_MUTATION, mutation = desktopMapMutations.find(item => item.name === selected)
  if (selected && !mutation) throw Error('Unknown map source mutation')
  let effective = source
  if (mutation?.file === path) {
    if (source.split(mutation.before).length !== 2) throw Error('Unique map CLI mutation anchor required')
    effective = source.replace(mutation.before, mutation.after)
  }
  const log = process.env.AGENTMUX_DESKTOP_MAP_LOADED
  if (log) await appendFile(log, JSON.stringify({ path, originalSHA256: sha(source), effectiveSHA256: sha(effective), process: 'source-cli' }) + '\n')
  return { format: 'module', source: stripTypeScriptTypes(effective, { mode: 'transform', sourceUrl: url }), shortCircuit: true }
}
