import { fileURLToPath } from 'node:url'
import base from './hook-postcommit-observation.vitest.config.mts'
export default { ...base, resolve: { ...base.resolve, alias: [{ find: '@agentmux/identity/runtime-source',
  replacement: fileURLToPath(new URL('../../identity/dist/runtime-source.js', import.meta.url)) }, ...base.resolve!.alias as any[]] }, test: { ...base.test, include: ['packages/core/test/durable-direct-resume.test.ts',
  'packages/core/test/agent-start-failure-recovery.test.ts'], passWithNoTests: false, testTimeout: 20_000, hookTimeout: 20_000 } }
