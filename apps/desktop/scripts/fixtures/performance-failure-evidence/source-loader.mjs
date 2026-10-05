// Isolated source-script proof only. Does not replace compiled/installed qualification.
import { stripTypeScriptTypes } from 'node:module'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolve as pathResolve } from 'node:path'
const root = pathResolve(import.meta.dirname, '../../../../..')
export async function resolve(specifier, context, next) {
  if (specifier === '@agentmux/core/control' || specifier === '@agentmux/core/public-rpc-http') {
    return { url: pathToFileURL(pathResolve(root, 'packages/core/src', specifier.split('/').at(-1) + '.ts')).href, shortCircuit: true }
  }
  if (context.parentURL?.startsWith(pathToFileURL(root + '/').href) && specifier.startsWith('.') && specifier.endsWith('.js')) {
    const url = new URL(specifier.slice(0,-3) + '.ts', context.parentURL)
    if (existsSync(url)) return { url: url.href, shortCircuit: true }
  }
  return next(specifier, context)
}
export async function load(url, context, next) {
  if (url.startsWith(pathToFileURL(root + '/').href) && url.endsWith('.ts')) {
    return { format: 'module', source: stripTypeScriptTypes(await readFile(fileURLToPath(url), 'utf8'), { mode: 'transform', sourceUrl: url }), shortCircuit: true }
  }
  return next(url, context)
}
