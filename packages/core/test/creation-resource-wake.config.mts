import base from './agent-creation-pre-admission-recovery.config.mts'
export default { ...base, test: { ...base.test, include: ['packages/core/test/creation-resource-wake.test.ts',
  'packages/core/test/creation-resource-wake-helper.test.ts', 'packages/core/test/agent-creation-resource-retry.test.ts'], passWithNoTests: false, testTimeout: 60_000, hookTimeout: 60_000 } }
