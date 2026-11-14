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
  // The shared editor owns prospective selection, cancellation and preparation feedback.
  'project-device-keeps-binding': ['components/AgentWorkModeSetup.tsx', 'agentWorkspaceId: prepared?.id ?? null', 'agentWorkspaceId: prepared?.id ?? currentProject.id'],
  'unrelated-update-cancels-preparation': ['components/AgentWorkModeSetup.tsx', 'if (fileNavigationSelection(current) !== navigation) controller.abort()', 'controller.abort()'],
  'navigation-allows-late-apply': ['components/AgentWorkModeSetup.tsx', 'if (fileNavigationSelection(current) !== navigation) controller.abort()', 'if (false) controller.abort()'],
  'failure-hidden': ['components/AgentWorkModeSetup.tsx', "setError(cause instanceof Error ? cause.message : 'This arrangement could not be prepared. Retry the same selection.')", 'setError(null)'],
  'label-offers-home': ['components/LauncherEnvironment.tsx', ".filter(line => !line.startsWith('~ opens'))", ""]
}
if (mutant && !edits[mutant]) throw new Error('Unknown execution modes mutant')
export default defineConfig({ ...original, resolve: { alias: [...aliases, ...executionUiAliases] },
  plugins: [...(original.plugins ?? []), { name: 'execution-modes-consumer', enforce: 'pre', resolveId: installedDependency, transform(source, id) {
    if (!id.startsWith(root + '/') || id.includes('/node_modules/') || id.includes('?')) return
    const sha = (input: string) => createHash('sha256').update(input).digest('hex')
    const record = (input: string) => { if (evidence) appendFileSync(resolve(evidence, 'consumed.jsonl'), JSON.stringify({ path: relative(root, id), sha256: sha(input) }) + '\n') }
    if (!mutant) { record(source); return }
    const [suffix, before, after] = edits[mutant]!
    if (!id.endsWith('/' + suffix)) { record(source); return }
    const count = 1
    if (source.split(before).length !== count + 1) throw new Error('Mutant must match exactly its owning source: ' + mutant)
    const consumed = source.replace(before, after)
    record(consumed)
    if (evidence) appendFileSync(resolve(evidence, 'mutation.jsonl'), JSON.stringify({ mutant, path: relative(root, id), matches: count, original: sha(source), consumed: sha(consumed) }) + '\n')
    process.stderr.write('EXECUTION_MODES_MUTANT_HIT ' + mutant + '\n')
    return { code: consumed, map: null }
  } }],
  test: { ...original.test, include: ['apps/desktop/test/launcher-tool-execution.test.tsx', 'apps/desktop/test/remote-execution-settings.test.tsx', 'apps/desktop/test/remote-execution-settings-navigation.test.tsx'],
    passWithNoTests: false, maxWorkers: 1, fileParallelism: false },
  cacheDir: resolve(root, '.tmp/remote-execution-experience/test-cache') })
