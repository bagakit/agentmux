import { defineConfig } from 'vitest/config'
import source from '../../../apps/desktop/scripts/fixtures/agent-schedules/vitest.config.mjs'
import { relative, resolve } from 'node:path'
import { instrumentGrokStatus } from './helpers/grok-status-mutations.mjs'
const root = resolve(import.meta.dirname, '../../..')
export default defineConfig({ ...source, plugins: [...(source.plugins ?? []), { name: 'actual-grok-native-status', enforce: 'pre',
  resolveId(specifier) {
    if (specifier === '@agentmux/providers/grok/session-status') return resolve(root, 'packages/providers/src/grok/session-status.ts')
  }, transform(code, id) {
  const loaded = instrumentGrokStatus(code, relative(root, id.split('?')[0]!))
  return loaded === code ? undefined : { code: loaded, map: null }
} }], test: { ...source.test, include: process.env.MOTE_GROK_STATUS_MUTATION === 'disconnect-failure-notice' ? ['packages/core/test/native-completion-authority.test.ts'] :
  process.env.MOTE_GROK_STATUS_MUTATION ? ['packages/core/test/grok-heartbeat-status.test.ts'] : [
  'packages/core/test/grok-heartbeat-status.test.ts',
  'packages/core/test/native-completion-authority.test.ts',
  'packages/core/test/agent-hook-command.test.ts',
  'packages/core/test/native-turn-activity.test.ts',
  'packages/core/test/a2a-initial-idle.test.ts',
  'packages/core/test/platform-initialization-input.test.ts',
  'packages/core/test/providers/grok-native-observation.test.ts'
],
  testNamePattern: process.env.MOTE_GROK_STATUS_MUTATION ? undefined : /^(?!source CLI sends a retained reference at).*$/u,
  fileParallelism: false, maxWorkers: 1, passWithNoTests: false, testTimeout: 120000, hookTimeout: 30000 } })
