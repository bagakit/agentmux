import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import { aliases, installedDependency, root } from './environment.mjs'

const evidence = process.env.AGENTMUX_CONNECTIONS_EVIDENCE
assert.ok(evidence, 'Explicit owned evidence directory')
const mutant = process.env.AGENTMUX_CONNECTIONS_MUTANT ?? 'baseline'
const base = 'apps/desktop/src/renderer/src/components/settings/'
const edits: Record<string, { file: string; before: string; after: string }> = {
  'network-target': { file: base + 'HostSettingsPane.tsx', before: '<HostNetworkPanel host={host}', after: '<HostNetworkPanel host={hosts[0]!}' },
  'network-late': { file: base + 'use-host-network-observation.ts', before: '      current.signal.throwIfAborted()', after: '      /* Causal mutation: admit a cancelled late observation. */' },
  'application-save-baseline': { file: base + 'HostApplicationAccessPanel.tsx', before: '{ ...current, revision: result.revision }', after: 'current' },
  'application-source': { file: base + 'HostApplicationAccessPanel.tsx', before: 'value={draft[side]} hosts={hosts}', after: "value={draft[side]} hosts={side === 'target' ? hosts.filter(item => item.id === host.id) : hosts}" },
  'application-target': { file: base + 'HostSettingsPane.tsx', before: '<HostApplicationAccessPanel host={draft}', after: '<HostApplicationAccessPanel host={hosts[0]!}' },
  'application-original': { file: base + 'HostApplicationAccessPanel.tsx', before: "'settings.applications.operation', { operationId: id }", after: "'settings.applications.operation', { operationId: id + '-another' }" },
  remote: { file: base + 'modules/hosts.tsx', before: "group: 'remote'", after: "group: 'connections'" },
  access: { file: base + 'HostSettingsPane.tsx', before: "data-host-access={id} hidden={selectedId !== id || panel !== 'agents'}", after: "data-host-access={id} hidden={selectedId !== id || panel !== 'connection'}" },
  route: { file: base + 'HostTopology.tsx', before: "host.user || 'SSH config'", after: "'borrowed-user'" },
  graph: { file: base + 'HostSettingsPane.tsx', before: 'onSelect={selectTopologyHost}', after: 'onSelect={() => {}}' },
  catalog: { file: base + 'modules/mobile.tsx', before: "group: 'remote'", after: "group: 'resources'" },
  single: { file: base + 'HostSettingsPane.tsx', before: 'hosts.filter((host) => host.id === selectedId).map', after: 'hosts.filter(() => true).map' },
  drafts: { file: base + 'HostSettingsPane.tsx', before: 'function selectHostPanel(id: string, panel: HostConnectionPanel): void {',
    after: 'function selectHostPanel(id: string, panel: HostConnectionPanel): void {\n    resource.setValue(() => Object.fromEntries(config.hosts.map((host) => [host.id, host])))' }
}
assert.ok(mutant === 'baseline' || edits[mutant], 'Known actual owning mutation')
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
mkdirSync(evidence, { recursive: true })
export default defineConfig({ root, cacheDir: resolve(evidence, 'cache'),
  define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, resolve: { alias: aliases },
  plugins: [{ name: 'bound-settings-connections-source', enforce: 'pre', resolveId: installedDependency,
    transform(input, id) {
      if (id.includes('?')) return
      const path = relative(root, id)
      if ((!path.startsWith('apps/desktop/src/') && !path.startsWith('packages/')) || !/\.[cm]?[jt]sx?$/u.test(path)) return
      const original = readFileSync(id, 'utf8'); assert.equal(input, original, 'Actual Source before transform')
      let code = input, applied = false
      const edit = edits[mutant]
      if (edit?.file === path) {
        assert.equal(code.split(edit.before).length, 2, 'One unique nonempty owning block')
        code = code.replace(edit.before, edit.after); applied = true
        const target = resolve(evidence, 'loaded-product', path)
        mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, code)
      }
      appendFileSync(resolve(evidence, 'loaded-source.jsonl'), JSON.stringify({ path, originalSHA256: sha(original), consumedSHA256: sha(code), mutant, applied }) + '\n')
      return code === input ? undefined : { code, map: null }
    } }],
  test: { include: ['apps/desktop/test/settings-connections.test.tsx', 'apps/desktop/test/host-settings-navigation.test.tsx', 'apps/desktop/test/remote-management.test.tsx', 'apps/desktop/test/remote-application-access.test.tsx', 'apps/desktop/test/host-network-settings-consumer.test.tsx', 'apps/desktop/test/host-runtime-observation-ipc.test.ts'], setupFiles: [resolve(root, 'vitest.setup.ts')],
    maxWorkers: 1, passWithNoTests: false, testTimeout: 15_000 }
})
