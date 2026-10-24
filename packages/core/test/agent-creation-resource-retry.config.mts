import base from './durable-local-creation.config.mts'
export default { ...base, test: { ...base.test, include: ['packages/core/test/agent-creation-resource-retry.test.ts'] } }
