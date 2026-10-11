import base from './hook-postcommit-observation.vitest.config.mts'

export default {
  ...base,
  test: { ...base.test, include: ['packages/core/test/agent-post-start-availability.test.ts', 'packages/core/test/agent-start-failure-recovery.test.ts'], testTimeout: 20_000 }
}
