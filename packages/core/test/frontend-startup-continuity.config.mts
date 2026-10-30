import base from './native-initial-input.config.mts'
export default { ...base, test: { ...base.test,
  include: ['packages/core/test/frontend-startup-continuity.integration.test.ts'], testTimeout: 90_000 } }
