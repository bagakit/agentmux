import base from './hook-postcommit-observation.vitest.config.mts'
import { resolve } from 'node:path'
export default { ...base, resolve: { alias: [
  { find: '@agentmux/identity/runtime-source', replacement: resolve(import.meta.dirname, '../../identity/dist/runtime-source.js') },
  ...base.resolve.alias
] }, test: { ...base.test, include: ['packages/core/test/durable-local-creation.test.ts',
  'packages/core/test/agent-creation-delivery-fact.test.ts', 'packages/core/test/agent-creation-operation-identity.test.ts', 'packages/core/test/agent-start-failure-recovery.test.ts'],
  passWithNoTests: false, testTimeout: 20_000, hookTimeout: 20_000 } }
