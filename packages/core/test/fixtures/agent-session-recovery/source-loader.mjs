// Private source qualification only: preserve import.meta paths and never rebuild shared dist.
import { stripTypeScriptTypes } from 'node:module'
import { existsSync, appendFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve as pathResolve, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = pathResolve(import.meta.dirname, '../../../../..')
const rootUrl = pathToFileURL(root + '/').href
export async function resolve(specifier, context, next) {
  const match = specifier.match(/^@agentmux\/([^/]+)(.*)$/u)
  if (match) {
    const manifest = pathResolve(root, 'packages', match[1], 'package.json')
    if (existsSync(manifest)) {
      const entry = JSON.parse(await readFile(manifest, 'utf8')).exports?.[match[2] ? '.' + match[2] : '.']
      const target = typeof entry === 'string' ? entry : entry?.import
      if (target?.startsWith('./dist/')) {
        const path = pathResolve(root, 'packages', match[1], target.replace(/^\.\/dist\/(?:src\/)?/u, './src/').replace(/\.js$/u, '.ts'))
        if (existsSync(path)) return { url: pathToFileURL(path).href, shortCircuit: true }
      }
    }
  }
  const candidate = specifier.startsWith('file:') ? new URL(specifier)
    : specifier.startsWith('/') ? pathToFileURL(specifier)
      : specifier.startsWith('.') && context.parentURL ? new URL(specifier, context.parentURL) : undefined
  if (candidate?.href.startsWith(rootUrl) && candidate.pathname.endsWith('.js')) {
    const source = new URL(candidate.href.slice(0, -3) + '.ts')
    if (existsSync(source)) return { url: source.href, shortCircuit: true }
  }
  return next(specifier, context)
}
export async function load(url, context, next) {
  if (url.startsWith(rootUrl) && /\.(?:ts|mjs|js)$/u.test(url)) {
    const source = await readFile(fileURLToPath(url), 'utf8')
    if (process.env.AGENTMUX_STATE_DIRECTORY) appendFileSync(pathResolve(process.env.AGENTMUX_STATE_DIRECTORY, 'recovery-loaded-source.ndjson'),
      JSON.stringify({ path: relative(root, fileURLToPath(url)), pid: process.pid, sha256: createHash('sha256').update(source).digest('hex') }) + '\n')
    if (url.endsWith('.ts')) return { format: 'module', source: stripTypeScriptTypes(source, { mode: 'transform', sourceUrl: url }), shortCircuit: true }
  }
  return next(url, context)
}
