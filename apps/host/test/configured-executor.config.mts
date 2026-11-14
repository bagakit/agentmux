import base from '../../../packages/core/test/hook-postcommit-observation.vitest.config.mts'
import { relative, resolve } from 'node:path'
import { instrument } from './configured-executor-mutations.mjs'
import { sourceAliases } from './goal-cross-host-source.mjs'
const root = resolve(import.meta.dirname, '../../..')
export default { ...base, resolve: { ...base.resolve, alias: sourceAliases.map(({ find, replacement }) => ({
  find: new RegExp('^' + find.replace(/[.+?^${}()|[\]\\]/gu, '\\$&').replace('*', '(.*)') + '$', 'u'), replacement: replacement.replace('*', '$1')
})) }, plugins: [{ name: 'original-configured-executor', enforce: 'pre' as const, transform(source: string, id: string) {
  const changed = instrument(source, relative(root, id.split('?')[0]!), 'vitest')
  return changed === source ? null : { code: changed, map: null }
} }], test: { ...base.test, include: ['apps/host/test/configured-executor-discovery.test.ts', 'apps/host/test/mote-initialization.test.ts'], maxWorkers: 1, fileParallelism: false, testTimeout: 60_000, hookTimeout: 30_000, passWithNoTests: false } }
