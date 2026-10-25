import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import { aliases, installedDependency, root } from '../scripts/fixtures/settings-resource-library/environment.mjs'

const evidence = process.env.AGENTMUX_LAUNCHER_SELECTION_EVIDENCE
assert(evidence, 'Set an explicit evidence directory for this source-bound Store check')
mkdirSync(evidence, { recursive: true })
const mutant = process.env.AGENTMUX_LAUNCHER_SELECTION_MUTANT
const mutations: Record<string, [string, string]> = {
  'project-owner': ['const projectChanged = originalProject !== selection.resourceWorkspaceId', 'const projectChanged = false'],
  'project-navigation': ['options?.navigateProject === false ? source.displayWorkspaceId : selection.resourceWorkspaceId', 'source.displayWorkspaceId'],
  'configuration-source': ['wasSplit && sameSource && agentExecutor?.hostId === runtime.hostId ? { agentExecutor } : {}', 'agentExecutor ? { agentExecutor } : {}'],
  'initial-execution': ['if (initialExecution) created = updateWorkbenchRegion', 'if (false) created = updateWorkbenchRegion'],
  'projection-reveal': ['const reveal = options?.reveal !== false', 'const reveal = true']
}
assert(!mutant || mutations[mutant], 'Unknown source mutant')
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const hostExports = JSON.parse(readFileSync(resolve(root, 'apps/host/package.json'), 'utf8')).exports
const hostAliases = Object.entries(hostExports).map(([key, value]) => ({
  find: new RegExp('^@agentmux/host' + (key === '.' ? '' : key.slice(1)) + '$'),
  replacement: resolve(root, 'apps/host', (typeof value === 'string' ? value : (value as { import: string }).import)
    .replace('./dist/', './src/').replace(/\.js$/u, '.ts'))
}))
export default defineConfig({ root, cacheDir: resolve(evidence, 'cache'),
  define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, resolve: { alias: [...hostAliases, ...aliases] },
  plugins: [{ name: 'launcher-selection-source-consumer', enforce: 'pre', resolveId: installedDependency,
    transform(input, id) {
      if (!id.startsWith(root + '/') || id.includes('/node_modules/') || id.includes('?') || !/\.[cm]?[jt]sx?$/u.test(id)) return
      appendFileSync(resolve(evidence, 'consumed.jsonl'), JSON.stringify({ path: relative(root, id), sha256: hash(readFileSync(id, 'utf8')), consumed: hash(input) }) + '\n')
      if (!mutant || id !== resolve(root, 'apps/desktop/src/renderer/src/store.ts')) return
      const [before, after] = mutations[mutant]!
      assert.equal(input.split(before).length - 1, 1, 'Mutant must match its exact original source anchor')
      const output = input.replace(before, after)
      appendFileSync(resolve(evidence, 'mutation.jsonl'), JSON.stringify({ mutant, path: relative(root, id), original: hash(input), consumed: hash(output) }) + '\n')
      return { code: output, map: null }
    } }],
  test: { include: ['apps/desktop/test/launcher-execution-selection.test.ts'], setupFiles: [resolve(root, 'vitest.setup.ts')],
    maxWorkers: 1, passWithNoTests: false, testTimeout: 20000 }
})
