import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, relative } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../../../vitest.config'
const root = resolve(import.meta.dirname, '../../../../..')
const product = 'apps/desktop/src/renderer/src/components/FileExplorer.tsx'
export default defineConfig({ ...original, root, resolve: { conditions: ['browser', 'import', 'default'] },
 ssr: { noExternal: ['@agentmux/client-ui'], resolve: { conditions: ['browser', 'import', 'default'] } },
 cacheDir: resolve(root, '.tmp/workface-explorer-scope-cache'), plugins: [{ name: 'actual-loaded-workface-explorer-scope', enforce: 'pre', transform(source, id) {
   const path = id.split('?')[0]!
   if (!path.startsWith(resolve(root, 'apps/desktop/src') + '/')) return
   let code = source
   const mutation = process.env.AGENTMUX_WORKFACE_EXPLORER_MUTATION
   if (path === resolve(root, product) && mutation) {
     const rules: Record<string, readonly [string, string]> = {
       'active-resource': ['requestedWorkspaceId ?? state.activeWorkspaceId', 'state.activeWorkspaceId'],
       'whole-root': ["rootPath = '', rootLabel", "rootPath: _ignoredRoot = '', rootLabel"] }
     assert.ok(mutation in rules); const rule = rules[mutation]!
     assert.equal(source.split(rule[0]).length - 1, 1, 'Actual production scope anchor')
     code = source.replace(rule[0], rule[1])
     if (mutation === 'whole-root') code = code.replace('  const workspaceId = useAppStore', "  const rootPath = ''\n  const workspaceId = useAppStore")
   }
   const hash = (value: string) => createHash('sha256').update(value).digest('hex')
   if (process.env.AGENTMUX_WORKFACE_EXPLORER_LOADED) appendFileSync(process.env.AGENTMUX_WORKFACE_EXPLORER_LOADED,
     JSON.stringify({ path: relative(root, path), sourceSHA256: hash(source), loadedSHA256: hash(code), mutated: code !== source, mutation }) + '\n')
   if (code !== source) return { code, map: null }
 } }], test: { ...original.test, include: ['apps/desktop/test/workface-explorer-scope.test.tsx'],
 passWithNoTests: false, fileParallelism: false, maxWorkers: 1, testTimeout: 15000 } })
