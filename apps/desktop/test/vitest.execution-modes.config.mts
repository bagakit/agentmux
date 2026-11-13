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
  // Each mutant breaks one promise of the start page's Agent device control.
  'project-device-keeps-binding': ['components/LauncherAgentDevice.tsx', "if (hostId === workspace.hostId) { onSelect({ resourceWorkspaceId: workspace.id, agentWorkspaceId: null }); return }", "if (hostId === workspace.hostId) { onSelect({ resourceWorkspaceId: workspace.id, agentWorkspaceId: workspace.id }); return }"],
  'navigation-cancels-preparation': ['components/LauncherAgentDevice.tsx', "useEffect(() => { cancel(); setFailure(null); return cancel }, [workspace?.id, workspace?.hostId, workspace?.path])", "useEffect(() => useAppStore.subscribe(() => cancel()), [])"],
  'failure-hidden': ['components/LauncherAgentDevice.tsx', "setFailure({ hostId, message: cause instanceof Error ? cause.message : 'The Agent device could not be prepared.' })", "setFailure(null)"],
  'single-device-offers-choice': ['components/LauncherAgentDevice.tsx', "if (projectHost?.kind !== 'local' || hosts.length < 2) return null", "if (projectHost?.kind !== 'local') return null"],
  'settings-arrangement-editable': ['components/LauncherAgentDevice.tsx', "(projectHost?.kind !== 'local' || agentWorkspace?.hostId === workspace.hostId)", "false"],
  'label-offers-home': ['components/LauncherEnvironment.tsx', ".filter(line => !line.startsWith('~ opens'))", ""]
}
if (mutant && !edits[mutant]) throw new Error('Unknown execution modes mutant')
export default defineConfig({ ...original, resolve: { alias: [...aliases, ...executionUiAliases] },
  plugins: [...(original.plugins ?? []), { name: 'execution-modes-consumer', enforce: 'pre', resolveId: installedDependency, transform(source, id) {
    if (!id.startsWith(root + '/') || id.includes('/node_modules/') || id.includes('?')) return
    if (evidence) appendFileSync(resolve(evidence, 'consumed.jsonl'), JSON.stringify({ path: relative(root, id), sha256: createHash('sha256').update(source).digest('hex') }) + '\n')
    if (!mutant) return
    const [suffix, before, after] = edits[mutant]!
    if (!id.endsWith('/' + suffix)) return
    const count = 1
    if (source.split(before).length !== count + 1) throw new Error('Mutant must match exactly its owning source: ' + mutant)
    if (evidence) appendFileSync(resolve(evidence, 'mutation.jsonl'), JSON.stringify({ mutant, path: relative(root, id), matches: count }) + '\n')
    process.stderr.write('EXECUTION_MODES_MUTANT_HIT ' + mutant + '\n')
    return { code: source.replaceAll(before, after), map: null }
  } }],
  test: { ...original.test, include: ['apps/desktop/test/launcher-tool-execution.test.tsx', 'apps/desktop/test/remote-execution-settings.test.tsx', 'apps/desktop/test/remote-execution-settings-navigation.test.tsx'],
    passWithNoTests: false, maxWorkers: 1, fileParallelism: false },
  cacheDir: resolve(root, '.tmp/remote-execution-experience/test-cache') })
