import * as source from '../../../desktop/scripts/fixtures/performance-failure-evidence/source-loader.mjs'
import { readFileSync, appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
const root = fileURLToPath(new URL('../../../../', import.meta.url))
const exportsFor = name => JSON.parse(readFileSync(root + 'packages/' + name + '/package.json', 'utf8')).exports
const core = exportsFor('core'), host = JSON.parse(readFileSync(root + 'apps/host/package.json', 'utf8')).exports
export function resolve(specifier, context, next) {
  for (const [prefix, directory, exports] of [['@agentmux/core', 'packages/core', core], ['@agentmux/host', 'apps/host', host]]) {
    if (specifier !== prefix && !specifier.startsWith(prefix + '/')) continue
    const entry = exports[specifier === prefix ? '.' : '.' + specifier.slice(prefix.length)]?.import
    if (entry) return { url: pathToFileURL(root + directory + '/' + entry.replace('./dist/', 'src/').replace(/\.js$/, '.ts')).href, shortCircuit: true }
  }
  return source.resolve(specifier, context, next)
}
export async function load(url, context, next) {
  const result = await source.load(url, context, next)
  const path = fileURLToPath(url.startsWith('file:') ? url : pathToFileURL(root))
  if (['/continuous-progress-loop-manager.ts','/workbench-user-state.ts','/agentmux-cli-commands.ts','/agent-progress.ts','/continuous-progress-scheduler.ts'].some(suffix => path.endsWith(suffix)) && process.env.AGENTMUX_PROGRESS_SOURCE_LOADS)
    appendFileSync(process.env.AGENTMUX_PROGRESS_SOURCE_LOADS, JSON.stringify({ pid: process.pid, path: path.slice(root.length), sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }) + '\n')
  return result
}
