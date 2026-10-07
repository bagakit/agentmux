import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import { aliases, installedDependency, root } from '../settings-resource-library/environment.mjs'
const evidence = process.env.AGENTMUX_SETTINGS_COLLECTION_EVIDENCE!
assert.ok(evidence, 'A task-owned evidence directory is required')
mkdirSync(evidence, { recursive: true })
const mutant = process.env.AGENTMUX_SETTINGS_COLLECTION_MUTANT ?? 'baseline'
const edits: Record<string, [string, string, string]> = {
  unrelated: ['AgentSettingsPane.tsx', 'if (source[key] === selected[key]) continue', 'if (false) continue'],
  'fast-path': ['AgentSettingsPane.tsx', 'if (source === state.executorDetections) return selected', 'if (false) return selected'],
  frozen: ['AgentSettingsPane.tsx', 'if (source === state.executorDetections) return selected', 'if (true) return selected'],
  search: ['AgentSettingsPane.tsx', 'filter.snapshot.has(id)', 'Array.from(filter.snapshot).some(candidate => candidate === id)'],
  keywords: ['ShortcutSettingsPane.tsx', 'keywordCounts.get(keyword)! > 1', 'drafts.some(other => other.id !== candidate.id && other.keyword.trim() === keyword)'],
  invalid: ['ShortcutSettingsPane.tsx', 'problemsById.has(candidate.id)', 'problems.some(problem => problem.id === candidate.id)']
}
assert.ok(mutant === 'baseline' || mutant === 'restored' || edits[mutant])
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
function one(code: string, before: string, after: string) { assert.equal(code.split(before).length, 2, 'Unique actual source observation/mutation anchor: ' + before); return code.replace(before, after) }
export default defineConfig({ root, esbuild: { jsx: 'automatic' }, cacheDir: resolve(evidence, 'cache'), define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, resolve: { alias: aliases },
  plugins: [{ name: 'actual-settings-collection-operations', enforce: 'pre', resolveId: installedDependency, transform(input, id) {
    if (id.includes('?') || !id.startsWith(root + '/apps/desktop/src/')) return
    const file = basename(id)
    if (!['AgentSettingsPane.tsx', 'ShortcutSettingsPane.tsx'].includes(file)) return
    assert.equal(input, readFileSync(id, 'utf8'), 'Actual owner before observation')
    let code = input, applied = false
    if (edits[mutant]?.[0] === file) { code = one(code, edits[mutant][1], edits[mutant][2]); applied = true }
    if (file === 'AgentSettingsPane.tsx') {
      code = one(code, '  const providerCatalog = useAppStore((state) => state.providerCatalog)', "  globalThis.__settingsCollectionCost?.('agentRender')\n  const providerCatalog = useAppStore((state) => state.providerCatalog)")
      code = one(code, 'for (const key of relevantDetectionKeys) {', "for (const key of relevantDetectionKeys) { globalThis.__settingsCollectionCost?.('detectionKeyVisit')")
      code = mutant === 'search'
        ? one(code, edits.search[2], "(globalThis.__settingsCollectionCost?.('executorMembershipLookup'), Array.from(filter.snapshot).some(candidate => { globalThis.__settingsCollectionCost?.('executorMembershipPredicate'); return candidate === id }))")
        : one(code, 'filter.snapshot.has(id)', "(globalThis.__settingsCollectionCost?.('executorMembershipLookup'), filter.snapshot.has(id))")
    } else {
      code = one(code, '    keywordCounts.set(keyword,', "    globalThis.__settingsCollectionCost?.('keywordIndexVisit')\n    keywordCounts.set(keyword,")
      code = mutant === 'keywords'
        ? one(code, edits.keywords[2], "(globalThis.__settingsCollectionCost?.('keywordValidationLookup'), drafts.some(other => { globalThis.__settingsCollectionCost?.('duplicateKeywordPredicate'); return other.id !== candidate.id && other.keyword.trim() === keyword }))")
        : one(code, 'keywordCounts.get(keyword)! > 1', "(globalThis.__settingsCollectionCost?.('keywordValidationLookup'), keywordCounts.get(keyword)! > 1)")
      code = mutant === 'invalid'
        ? one(code, edits.invalid[2], "(globalThis.__settingsCollectionCost?.('promptStatusLookup'), problems.some(problem => { globalThis.__settingsCollectionCost?.('promptProblemPredicate'); return problem.id === candidate.id }))")
        : one(code, 'problemsById.has(candidate.id)', "(globalThis.__settingsCollectionCost?.('promptStatusLookup'), problemsById.has(candidate.id))")
    }
    appendFileSync(resolve(evidence, 'loaded-source.jsonl'), JSON.stringify({ file: relative(root, id), originalSHA256: sha(input), consumedSHA256: sha(code), mutant, applied }) + '\n')
    writeFileSync(resolve(evidence, file), code)
    return { code, map: null }
  } }],
  test: { include: [
    'apps/desktop/test/settings-collection-cost.probe.tsx',
    ...(mutant === 'baseline' || mutant === 'restored' ? ['apps/desktop/test/settings-reference.test.tsx','apps/desktop/test/settings-prompt-workbench.test.tsx','apps/desktop/test/settings-prompts-save.test.tsx','apps/desktop/test/settings-prompts-library.test.tsx','apps/desktop/test/settings-prompts-liquid.test.tsx'] : [])
  ], setupFiles: [resolve(root, 'vitest.setup.ts')], maxWorkers: 1, passWithNoTests: false, testTimeout: 20000 }
})
