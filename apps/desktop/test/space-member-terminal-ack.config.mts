import base from './vitest.mote-context.config.mts'

export default { ...base, cacheDir: '.tmp/space-member-terminal-ack', test: { ...base.test,
  environment: 'node', globalSetup: [], include: ['apps/desktop/test/space-member-terminal-ack.test.ts'],
  passWithNoTests: false, maxWorkers: 1, fileParallelism: false, testTimeout: 30000, hookTimeout: 30000
} }
