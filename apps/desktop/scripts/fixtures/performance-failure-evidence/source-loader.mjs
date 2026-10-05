// Isolated source-script proof only. Does not replace compiled/installed qualification.
import { stripTypeScriptTypes } from 'node:module'
import { readFile } from 'node:fs/promises'
import { existsSync, appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolve as pathResolve } from 'node:path'
const root = pathResolve(import.meta.dirname, '../../../../..')
export async function resolve(specifier, context, next) {
  if (specifier === '@agentmux/core/control' || specifier === '@agentmux/core/public-rpc-http' || specifier === '@agentmux/core/toolkit-result-channel' || specifier === '@agentmux/core/toolkit-performance-failure' || specifier === '@agentmux/core/toolkit-result-document') {
    return { url: pathToFileURL(pathResolve(root, 'packages/core/src', specifier.split('/').at(-1) + '.ts')).href, shortCircuit: true }
  }
  if (context.parentURL?.startsWith(pathToFileURL(root + '/').href) && specifier.startsWith('.') && specifier.endsWith('.js')) {
    const url = new URL(specifier.slice(0,-3) + '.ts', context.parentURL)
    if (existsSync(url)) return { url: url.href, shortCircuit: true }
  }
  return next(specifier, context)
}
export async function load(url, context, next) {
  if (process.env.AGENTMUX_PERFORMANCE_FAILURE_EVIDENCE && url === pathToFileURL(pathResolve(root, 'apps/desktop/resources/toolkit/performance.mjs')).href) {
    const source = await readFile(fileURLToPath(url), 'utf8')
    appendFileSync(pathResolve(process.env.AGENTMUX_PERFORMANCE_FAILURE_EVIDENCE, 'loaded-source.jsonl'), JSON.stringify({ path: 'apps/desktop/resources/toolkit/performance.mjs', sourceSHA256: createHash('sha256').update(source).digest('hex') }) + '\n')
  }
  if (url.startsWith(pathToFileURL(root + '/').href) && url.endsWith('.ts')) {
    return { format: 'module', source: stripTypeScriptTypes(await readFile(fileURLToPath(url), 'utf8'), { mode: 'transform', sourceUrl: url }), shortCircuit: true }
  }
  return next(url, context)
}
