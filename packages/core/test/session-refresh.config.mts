import base from './hook-postcommit-observation.vitest.config.mts'

export default {
  ...base,
  test: { ...base.test, include: ['packages/core/test/session-refresh.test.ts'], testTimeout: 20_000, passWithNoTests: false }
}
