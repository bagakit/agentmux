import { aliases, installedDependency } from '../scripts/fixtures/settings-resource-library/environment.mjs'
import { defineConfig } from 'vitest/config'
import { appendFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import original, { executionUiAliases } from './vitest.tool-execution-ui.config.mts'
const root = resolve(import.meta.dirname, '../../..')
const evidence = process.env.EXECUTION_MODES_EVIDENCE
if (evidence) mkdirSync(evidence, { recursive: true })
const mutant = process.env.EXECUTION_MODES_MUTANT
const edits: Record<string, [string, string, string]> = {
  'collapsed-raw-summary': ['components/NewTabSurface.tsx', "'text' in part ? part.text : part.reference.label", "'text' in part ? part.text : part.raw"],
  'unknown-empty-configured': ['components/NewTabSurface.tsx', 'const emptyHostInventoryUnconfirmed = executors.length === 0 && usesHostInventory &&', 'const emptyHostInventoryUnconfirmed = false &&'],
  'wrong-endpoint-environment': ['components/LauncherExecutionModes.tsx', 'const host = hosts.find(item => item.id === target.hostId)', 'const host = hosts.find(item => item.id === workspace?.hostId)'],
  'ime-cancels-setup': ['components/LauncherExecutionModes.tsx', ' && !isImeOwnedKeyboardEvent(event)', ''],
  'wrong-remote-agent-resource': ['components/LauncherExecutionModes.tsx', 'commit(setup.resourceWorkspaceId, id, setup.intent)', 'commit(id, id, setup.intent)'],
  'ordinary-keeps-binding': ['components/LauncherExecutionModes.tsx', "return commit(workspace.id, null, intent)", "return commit(workspace.id, workspace.id, intent)"],
  'mode-ignores-project-navigation': ['components/LauncherExecutionModes.tsx', "navigateProject: intent !== 'custom'", 'navigateProject: false'],
  'custom-premature-commit': ['components/LauncherExecutionModes.tsx', "setSetup({ ...setup, agentWorkspaceId: id, picking: null })", "commit(setup.resourceWorkspaceId!, id, setup.intent)"]
}
if (mutant && !edits[mutant]) throw new Error('Unknown execution modes mutant')
export default defineConfig({ ...original, resolve: { alias: [...aliases, ...executionUiAliases] },
  plugins: [...(original.plugins ?? []), { name: 'execution-modes-consumer', enforce: 'pre', resolveId: installedDependency, transform(source, id) {
    if (!id.startsWith(root + '/') || id.includes('/node_modules/') || id.includes('?')) return
    if (evidence) appendFileSync(resolve(evidence, 'consumed.jsonl'), JSON.stringify({ path: relative(root, id), sha256: createHash('sha256').update(source).digest('hex') }) + '\n')
    if (!mutant) return
    const [suffix, before, after] = edits[mutant]!
    if (!id.endsWith('/' + suffix)) return
    const count = mutant === 'ordinary-keeps-binding' ? 2 : 1
    if (source.split(before).length !== count + 1) throw new Error('Mutant must match exactly its owning source: ' + mutant)
    if (evidence) appendFileSync(resolve(evidence, 'mutation.jsonl'), JSON.stringify({ mutant, path: relative(root, id), matches: count }) + '\n')
    process.stderr.write('EXECUTION_MODES_MUTANT_HIT ' + mutant + '\n')
    return { code: source.replaceAll(before, after), map: null }
  } }],
  test: { ...original.test, include: ['apps/desktop/test/launcher-tool-execution.test.tsx', 'apps/desktop/test/remote-execution-settings.test.tsx', 'apps/desktop/test/remote-execution-settings-navigation.test.tsx'],
    passWithNoTests: false, maxWorkers: 1, fileParallelism: false },
  cacheDir: resolve(root, '.tmp/remote-execution-experience/test-cache') })
