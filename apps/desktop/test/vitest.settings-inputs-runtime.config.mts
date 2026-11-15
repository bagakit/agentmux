import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import { aliases, installedDependency, root } from '../scripts/fixtures/settings-resource-library/environment.mjs'

const evidence = process.env.AGENTMUX_SETTINGS_RUNTIME_TEST_RECEIPT
const mutant = process.env.AGENTMUX_SETTINGS_RUNTIME_MUTANT
const runtimeEdits = {
  'host-search': {
    file: 'HostProjectsPane.tsx',
    before: 'clearLabel="Clear project filter"',
    after: 'clearLabel="Clear query"'
  },
  'mesh-invalid': {
    file: 'MeshPeerPairing.tsx',
    before: 'aria-invalid={Boolean(error && !candidate) || undefined}',
    after: 'aria-invalid={undefined}'
  },
  'hook-selected-scope': {
    file: 'ProviderHooksPane.tsx',
    before: 'scopeId: scope.scopeId, scopeRevision: scope.scopeRevision',
    after: 'scopeId: scopes[0]!.scopeId, scopeRevision: scopes[0]!.scopeRevision!'
  }
}
const edit = mutant ? runtimeEdits[mutant as keyof typeof runtimeEdits] : undefined
if (mutant && !edit) throw Error('Unknown Runtime Settings input mutation')
const owners = new Set([
  'AgentSettingsPane.tsx', 'HostExecutorSettings.tsx', 'ProviderComparisonPane.tsx', 'ProviderHooksPane.tsx', 'HostSettingsPane.tsx',
  'HostProjectsPane.tsx', 'HostTailcatListenerFields.tsx', 'MeshNetworkSettings.tsx', 'MeshPeerPairing.tsx',
  'NetworkNodeSettingsPane.tsx', 'RemoteRoutesPane.tsx'
])
const ownerPrefix = 'apps/desktop/src/renderer/src/components/settings/'
const hash = (source: string) => createHash('sha256').update(source).digest('hex')

export default defineConfig({
  root,
  define: { __AGENTMUX_WEB_PREVIEW__: 'true' },
  resolve: { alias: aliases },
  plugins: [{
    name: 'settings-inputs-runtime-product-source',
    enforce: 'pre',
    resolveId: installedDependency,
    transform(source, id) {
      const file = relative(root, id)
      if (!file.startsWith(ownerPrefix)) return
      const name = file.slice(ownerPrefix.length)
      if (!owners.has(name)) return
      let consumed = source
      if (edit && name === edit.file) {
        if (source.split(edit.before).length !== 2) throw Error('Runtime Settings input mutation must bind exactly once')
        consumed = source.replace(edit.before, edit.after)
      }
      if (evidence) appendFileSync(evidence, JSON.stringify({ file, original: hash(source), consumed: hash(consumed) }) + '\n')
      if (consumed !== source) return { code: consumed, map: null }
    }
  }],
  test: {
    setupFiles: [resolve(root, 'vitest.setup.ts')],
    include: [
      'settings-product-polish', 'settings-executor-creation', 'settings-host-registration-drafts', 'provider-comparison-pane', 'executor-hook-maintenance',
      'host-tailcat-settings', 'tailcat-connection-draft', 'mesh-settings', 'network-node-settings', 'remote-routes'
    ].map(test => 'apps/desktop/test/' + test + '.test.tsx'),
    maxWorkers: 1,
    passWithNoTests: false
  }
})
