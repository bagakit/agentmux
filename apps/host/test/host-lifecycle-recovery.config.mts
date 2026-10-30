import { defineConfig } from 'vitest/config'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { bundleIdentityRuntime } from '../../../packages/identity/scripts/runtime-bundle.mjs'
import { instrumentLifecycleRecovery, lifecycleSource } from './host-lifecycle-recovery-mutations.mjs'
const root = resolve(import.meta.dirname, '../../..')
const directory = process.env.HOST_LIFECYCLE_GENERATED ?? await mkdtemp(resolve(tmpdir(), 'hlr-source-'))
await mkdir(directory, { recursive: true })
const identity = await bundleIdentityRuntime(), identitySource = resolve(directory, 'identity-runtime-source.mjs')
await writeFile(identitySource, 'export const identityRuntimeSource = ' + JSON.stringify(identity.source) + ';\n')
process.env.HOST_LIFECYCLE_IDENTITY_SOURCE = identitySource
export default defineConfig({ root, define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, esbuild: { jsx: 'automatic' },
  plugins: [{ name: 'actual-host-lifecycle-source', enforce: 'pre', resolveId(id) { return lifecycleSource(root, id) },
    transform(source, id) { const changed = instrumentLifecycleRecovery(source, relative(root, id.split('?')[0]!), 'vitest-source'); return changed === source ? null : { code: changed, map: null } } }],
  test: { include: ['apps/host/test/host-lifecycle-recovery.test.ts'], passWithNoTests: false, fileParallelism: false, maxWorkers: 1, testTimeout: 35_000, hookTimeout: 20_000 } })
