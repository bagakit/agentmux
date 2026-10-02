import config from '../performance-toolkit/vitest.config.mts'
export default { ...config, test: { ...config.test, include: [
  'apps/desktop/test/toolkit-owner.test.ts', 'apps/desktop/test/toolkit-receipt-store.test.ts'
] } }
