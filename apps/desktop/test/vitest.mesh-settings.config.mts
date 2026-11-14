import { defineConfig } from 'vitest/config'
import { aliases, installedDependency, root } from '../scripts/fixtures/settings-resource-library/environment.mjs'
import { appendFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, relative } from 'node:path'
const evidence = process.env.AGENTMUX_MESH_UI_EVIDENCE ?? resolve(root, '.local/state/mesh-network-access/ui-tests')
mkdirSync(evidence, { recursive: true })
const mutant = process.env.AGENTMUX_MESH_UI_MUTANT
const edits: Record<string, [string, string, string]> = {
  'lost-fence': ['main/mesh-network-ipc.ts', '...(original ? { runtimeFence: original } : {})', ''],
  'lost-draft': ['renderer/src/components/settings/MeshNetworkSettings.tsx', 'form: later ? value.form : meshForm(result.settings.configuration, result.settings.identity?.peerId)', 'form: meshForm(result.settings.configuration, result.settings.identity?.peerId)'],
  'lost-unknown': ['renderer/src/components/settings/MeshNetworkSettings.tsx', "if (!notApplied) return { ...value, pending: { ...value.pending, phase: 'unknown' } }", 'if (false) return value'],
  'wrong-method': ['renderer/src/lib/mesh-network-client.ts', 'preload.call(method, params,', "preload.call('mesh.inspect' as typeof method, params,"],
}
if (mutant && !edits[mutant]) throw Error('Unknown Mesh UI mutant')
export default defineConfig({ root, define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, resolve: { alias: aliases }, plugins: [{ name: 'mesh-ui-consumed', enforce: 'pre', resolveId: installedDependency,
  transform(input, id) {
    if (!id.startsWith(root + '/') || id.includes('/node_modules/') || id.includes('?') || !/\.[cm]?[jt]sx?$/u.test(id)) return
    const path = relative(root, id), sha = (text: string) => createHash('sha256').update(text).digest('hex')
    appendFileSync(resolve(evidence, 'consumed.jsonl'), JSON.stringify({ path, sha256: sha(input) }) + '\n')
    if (!mutant || !id.endsWith('/src/' + edits[mutant]![0])) return
    const [, from, to] = edits[mutant]!
    if (input.split(from).length !== 2) throw Error('Mutation must bind once in actual loaded product source')
    const output = input.replace(from, to)
    appendFileSync(resolve(evidence, 'mutation.jsonl'), JSON.stringify({ mutant, path, before: sha(input), after: sha(output) }) + '\n')
    return { code: output, map: null }
  } }], test: { include: ['apps/desktop/test/mesh-settings.test.tsx', 'apps/desktop/test/mesh-network-ipc.test.ts', 'apps/desktop/test/host-settings-navigation.test.tsx', 'apps/desktop/test/settings-host-disclosure.test.tsx', 'apps/desktop/test/settings-section-routing.test.tsx'], environment: 'node', pool: 'forks', maxWorkers: 1, fileParallelism: false, testTimeout: 90000, hookTimeout: 90000 } })
