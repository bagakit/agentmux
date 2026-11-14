import { defineConfig } from 'vitest/config'
import source from '../../../apps/desktop/scripts/fixtures/agent-schedules/vitest.config.mjs'
import { relative, resolve } from 'node:path'
import { instrument } from './helpers/grok-original-source-mutations.mjs'
const root = resolve(import.meta.dirname, '../../..')
export default defineConfig({ ...source, plugins: [...(source.plugins ?? []), { name: 'original-grok-source', enforce: 'pre',
  resolveId(specifier) {
    if (specifier === '@agentmux/providers/grok/native-history') return resolve(root, 'packages/providers/src/grok/native-history.ts')
    if (specifier === '@agentmux/providers/grok/session-status') return resolve(root, 'packages/providers/src/grok/session-status.ts')
  },
  transform(code, id) {
  const changed = instrument(code, relative(root, id.split('?')[0]!)); return changed === code ? undefined : { code: changed, map: null }
} }], test: { ...source.test,
  include: process.env.MOTE_GROK_ORIGINAL_MUTATION ? [process.env.MOTE_GROK_ORIGINAL_MUTATION === 'emit-before-cut-completes'
    ? 'packages/core/test/grok-heartbeat-status.test.ts' : 'packages/core/test/grok-original-native-source.test.ts']
    : ['packages/core/test/grok-original-native-source.test.ts', 'packages/core/test/grok-heartbeat-status.test.ts', 'packages/core/test/providers/grok-native-observation.test.ts'],
  testNamePattern: process.env.MOTE_GROK_ORIGINAL_MUTATION ? undefined : /^(?!two independent OS Core owners recover original native status|a newer original Hook).*$/u,
  fileParallelism: false, maxWorkers: 1, passWithNoTests: false, testTimeout: 30000, hookTimeout: 15000 } })
