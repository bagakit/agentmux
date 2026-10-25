import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../vitest.config.ts'

const root = resolve(import.meta.dirname, '../../..')
const corePackage = JSON.parse(readFileSync(resolve(root, 'packages/core/package.json'), 'utf8'))
const aliases = Object.entries(corePackage.exports).flatMap(([key, value]) => {
  const target = (value as { import?: string }).import
  const name = key === '.' ? '@agentmux/core' : '@agentmux/core/' + key.slice(2)
  return target ? [{ find: new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&') + '$', 'u'),
    replacement: resolve(root, 'packages/core', target.replace('./dist/', './src/').replace(/\.js$/u, '.ts')) }] : []
})
const mutations: Record<string, [string, string, string]> = {
  revalidate: ['packages/connectors/src/publication-store.ts', 'parseConversationUnitsForPage(options.units, page)',
    'options.units.map(unit => parseConversationUnit(unit, { hostId: page.sourceHostId, agentSessionId: boundary.agentSessionId }, page.scope))'],
  'trust-copy': ['packages/core/src/conversation-changes.ts', 'ownedItems.has(unit) ? unit : parseConversationUnit(unit, ref, page.scope)', 'true ? unit : parseConversationUnit(unit, ref, page.scope)']
}
export default defineConfig({ ...original, root, cacheDir: resolve(root, '.cache/publication-unit-owner'),
  resolve: { alias: aliases },
  plugins: [{ name: 'publication-unit-original-owner', enforce: 'pre', resolveId(source, importer) {
    if (!importer || !source.startsWith('.')) return
    const target = resolve(dirname(importer), source), sourcePath = target.replace('/packages/core/dist/', '/packages/core/src/').replace(/\.js$/u, '.ts')
    if (target.includes('/packages/core/dist/') && existsSync(sourcePath)) return sourcePath
  }, transform(source, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!/^packages\/(core|connectors)\/src\//u.test(path)) return
    const mutation = process.env.AGENTMUX_UNIT_OWNER_MUTATION, selected = mutation ? mutations[mutation] : undefined
    if (mutation && !selected) throw Error('Unknown unit owner mutation')
    let code = source
    if (selected && path === selected[0]) {
      if (source.split(selected[1]).length !== 2) throw Error('Missing unique unit owner mutation: ' + mutation)
      code = source.replace(selected[1], selected[2])
    }
    if (process.env.AGENTMUX_UNIT_OWNER_LOADED) {
      const sha = (text: string) => createHash('sha256').update(text).digest('hex')
      appendFileSync(process.env.AGENTMUX_UNIT_OWNER_LOADED, JSON.stringify({ path, originalSHA256: sha(source), loadedSHA256: sha(code), mutation: code === source ? null : mutation }) + '\n')
    }
    return code === source ? undefined : { code, map: null }
  } }],
  test: { ...original.test, globalSetup: [], include: [
    'packages/core/test/conversation-unit-owner.test.ts', 'packages/core/test/conversation-page-owner.test.ts',
    'packages/connectors/test/publication-unit-owner.test.ts'
  ], fileParallelism: false, passWithNoTests: false }
})
