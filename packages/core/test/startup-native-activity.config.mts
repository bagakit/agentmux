import base from './hook-postcommit-observation.vitest.config.mts'
import { resolve } from 'node:path'
export default { ...base, resolve: { alias: [
  { find: '@agentmux/identity/runtime-source', replacement: resolve(import.meta.dirname, '../../identity/dist/runtime-source.js') }, ...base.resolve.alias
] }, plugins: [{ name: 'loaded-startup-activity-mutation', enforce: 'pre' as const, transform(code: string, id: string) {
  if (process.env.AGENTMUX_TEST_STARTUP_ACTIVITY_MUTANT !== 'projection-admission' || !id.endsWith('/agent-session-recovery/continuity-attempt.ts')) return
  const from = 'admission = agentContinuityAdmission({ session: current, trigger: receipt.trigger, policy,'
  if (code.split(from).length !== 2) throw new Error('Expected one owning startup admission mutation target')
  return code.replace(from, 'admission = agentContinuityAdmission({ session: ports.events.projectSession(current), trigger: receipt.trigger, policy,')
} }], test: { ...base.test, include: ['packages/core/test/startup-native-activity.test.ts'], passWithNoTests: false,
  testTimeout: 30_000, hookTimeout: 20_000 } }
