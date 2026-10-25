import config from './vitest.config.mts'
export default { ...config, test: { ...config.test, include: ['packages/core/test/provider-contribution-contract.test.ts'] } }
