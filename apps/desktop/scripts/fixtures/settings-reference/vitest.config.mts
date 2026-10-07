import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync } from 'node:fs'
import { resolve, relative } from 'node:path'
import { defineConfig } from 'vitest/config'
import { aliases, installedDependency, root } from '../settings-resource-library/environment.mjs'
const evidence = process.env.AGENTMUX_SETTINGS_REFERENCE_EVIDENCE!
assert.ok(evidence)
mkdirSync(evidence, { recursive: true })
const mutant = process.env.AGENTMUX_SETTINGS_REFERENCE_MUTANT
const edits: Record<string, [string, string, string]> = {
  selection: ['AgentSettingsPane.tsx', 'function selectExecutor(id: string): void {\n    setSelectedId(id)', 'function selectExecutor(id: string): void {\n    setSelectedId(null)'],
  drafts: ['AgentSettingsPane.tsx', 'function closeProviders(): void {', 'function closeProviders(): void {\n    setDrafts(() => Object.fromEntries(Object.entries(config.executors).map(([id, value]) => [id, toDraft(value)])))'],
  creation: ['ProviderCatalogPane.tsx', 'onClick={() => onCreate(provider)}', 'onClick={() => onCreate(entries[0]!)}']
}
export default defineConfig({ root, cacheDir: resolve(evidence, 'cache'),
  define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, resolve: { alias: aliases },
  plugins: [{ name: 'actual-settings-reference-owner', enforce: 'pre', resolveId: installedDependency,
    transform(code, id) {
      if (id.includes('?') || !id.startsWith(root + '/apps/desktop/src/')) return
      if (mutant && id.endsWith('/' + edits[mutant]![0])) {
        const [, before, after] = edits[mutant]!
        assert.equal(code.split(before).length, 2, 'Unique nonempty actual owner mutation')
        code = code.replace(before, after)
        appendFileSync(resolve(evidence, 'mutation.jsonl'), JSON.stringify({ mutant, file: relative(root, id) }) + '\n')
      }
      return code
    } }],
  test: { include: ['apps/desktop/test/settings-reference.test.tsx', ...(mutant ? [] : ['apps/desktop/test/settings-executor-creation.test.tsx','apps/desktop/test/settings-resource-library.test.tsx'])],
    setupFiles: [resolve(root, 'vitest.setup.ts')], maxWorkers: 1, passWithNoTests: false, testTimeout: 15000 }
})
