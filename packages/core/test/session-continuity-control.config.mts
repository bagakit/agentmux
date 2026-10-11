import base from './hook-postcommit-observation.vitest.config.mts'
export default { ...base, test: { ...base.test, include: ['packages/core/test/session-continuity-control.test.ts'], passWithNoTests: false, testTimeout: 20_000, hookTimeout: 20_000 } }
