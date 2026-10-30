import { defineConfig } from 'vitest/config'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { bundleIdentityRuntime } from '../../../packages/identity/scripts/runtime-bundle.mjs'
import { bundlePrivateNodeSource } from '../../../packages/core/test/helpers/private-node-source-bundle.mjs'
import { instrumentLifecycleRecovery, lifecycleSource } from './host-lifecycle-recovery-mutations.mjs'
const root = resolve(import.meta.dirname, '../../..')
const directory = process.env.HOST_LIFECYCLE_GENERATED ?? await mkdtemp(resolve(tmpdir(), 'hlr-source-'))
await mkdir(directory, { recursive: true })
const identity = await bundleIdentityRuntime(), identitySource = resolve(directory, 'identity-runtime-source.mjs')
await writeFile(identitySource, 'export const identityRuntimeSource = ' + JSON.stringify(identity.source) + ';\n')
process.env.HOST_LIFECYCLE_IDENTITY_SOURCE = identitySource
const cliEntry = resolve(root, 'packages/core/src/agentmux.ts'), cliWrapper = resolve(directory, 'cli-entry.mjs')
await writeFile(cliWrapper, 'process.argv[1] = ' + JSON.stringify(cliEntry) + ';\nawait import(' + JSON.stringify(cliEntry) + ');\n')
const bundles = []
for (const [name, entry] of [
  ['owner', resolve(root, 'apps/host/test/fixtures/host-lifecycle-runtime.mjs')],
  ['listener', resolve(root, 'packages/core/src/control-endpoint-listener-worker.ts')],
  ['cli', cliWrapper]
] as const) {
  const bundled = await bundlePrivateNodeSource({ root, entry, file: resolve(directory, name + '.mjs'),
    sourceExport: (specifier: string) => lifecycleSource(root, specifier),
    instrument: (source: string, path: string) => instrumentLifecycleRecovery(source, path, 'node-process') })
  process.env['HOST_LIFECYCLE_' + name.toUpperCase() + '_ENTRY'] = bundled.file
  bundles.push({ name, file: bundled.file, provenance: bundled.provenance })
}
await writeFile(resolve(directory, 'node-bundles.json'), JSON.stringify(bundles, null, 2) + '\n')
export default defineConfig({ root, define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, esbuild: { jsx: 'automatic' },
  plugins: [{ name: 'actual-host-lifecycle-source', enforce: 'pre', resolveId(id) { return lifecycleSource(root, id) },
    transform(source, id) { const changed = instrumentLifecycleRecovery(source, relative(root, id.split('?')[0]!), 'vitest-source'); return changed === source ? null : { code: changed, map: null } } }],
  test: { include: ['apps/host/test/host-lifecycle-recovery.test.ts'], passWithNoTests: false, fileParallelism: false, maxWorkers: 1, testTimeout: 35_000, hookTimeout: 20_000 } })
