import { defineConfig } from 'vitest/config'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import original, { sourceAliases } from '../scripts/fixtures/launcher-launchpad/vitest.owning.config.mts'
const repository = resolve(import.meta.dirname, '../../..')
const hostRoot = resolve(repository, 'apps/host')
const exports = JSON.parse(readFileSync(resolve(hostRoot, 'package.json'), 'utf8')).exports
export const executionUiAliases = [...sourceAliases, { find: 'yaml', replacement: resolve(repository, 'apps/desktop/node_modules/yaml/browser/index.js') }, ...Object.entries(exports).map(([key, value]) => ({
  find: `@agentmux/host${key === '.' ? '' : key.slice(1)}`,
  replacement: resolve(hostRoot, (typeof value === 'string' ? value : (value as { import: string }).import).replace('./dist/', './src/').replace(/\.js$/u, '.ts'))
}))].sort((a, b) => b.find.length - a.find.length)
const mutant = process.env.TOOL_EXECUTION_UI_MUTANT
const mutations: Record<string, [string, string, string]> = {
  'tool-target': ['store.ts', 'toolWorkspace = agentWorkspaceId ? { id: resourceWorkspace.id, hostId: resourceWorkspace.hostId, path: resourceWorkspace.path }', 'toolWorkspace = agentWorkspaceId ? { id: workspace.id, hostId: workspace.hostId, path: workspace.path }'],
  'local-host-inventory': ['lib/executors.ts', "host.kind === 'local' && source !== 'host'", "host.kind === 'local'"],
  notices: ['components/AgentToolExecutionNotice.tsx', 'inspection?.notices ?? []', '[]'],
  'initial-order': ['main/execution-binding-readers.ts', ' && !watch.observed', ''],
  'reader-isolation': ['main/execution-binding-readers.ts', "try { watch.sender.send('sessions:executionBindingChanged', { watchId: watch.id, inspection }) }\n      catch { this.release(watch.sender, watch.id) }", "watch.sender.send('sessions:executionBindingChanged', { watchId: watch.id, inspection })"]
}
if (mutant && !mutations[mutant]) throw new Error('Unknown execution UI mutant')
export default defineConfig({ ...original,
  plugins: [...(original.plugins ?? []), { name: 'execution-ui-counterexample', enforce: 'pre', transform(source, id) {
    if (!mutant) return
    const [file, before, after] = mutations[mutant]!
    if (!id.endsWith('/' + file)) return
    if (source.split(before).length !== 2) throw new Error('Mutation must match one actual source location: ' + mutant)
    process.stderr.write('TOOL_EXECUTION_MUTANT_HIT ' + mutant + '\n')
    return { code: source.replace(before, after), map: null }
  } }], resolve: { alias: executionUiAliases },
  test: { ...original.test, include: ['apps/desktop/test/launcher-tool-execution.test.tsx', 'apps/desktop/test/tool-execution-notice.test.tsx', 'apps/desktop/test/execution-binding-readers.test.ts'], passWithNoTests: false },
  cacheDir: resolve(repository, '.tmp/tool-execution-ui/cache') })
