import { relative, resolve } from 'node:path'
import base from '../../../packages/core/test/hook-postcommit-observation.vitest.config.mts'
import { instrumentLaunchSmoke } from './launch-smoke-connection-mutations.mjs'
const root = resolve(import.meta.dirname, '../../..')
export default { ...base, resolve: { ...base.resolve, alias: [
  { find: /^@agentmux\/identity\/runtime-source$/u, replacement: resolve(root, 'packages/identity/dist/runtime-source.js') },
  { find: /^@agentmux\/host\/macos-service$/u, replacement: resolve(root, 'apps/host/src/macos-service.ts') },
  ...(base.resolve?.alias as Array<{ find: string | RegExp; replacement: string }> ?? [])
] }, plugins: [{ name: 'original-launch-smoke-connection', enforce: 'pre' as const,
  transform(source: string, id: string) {
    const changed = instrumentLaunchSmoke(source, relative(root, id.split('?')[0]!))
    return changed === source ? null : changed
  } }], test: { ...base.test, root, include: ['apps/desktop/test/launch-smoke-connection.test.ts'],
    maxWorkers: 1, fileParallelism: false, passWithNoTests: false, testTimeout: 30_000, hookTimeout: 30_000 } }
