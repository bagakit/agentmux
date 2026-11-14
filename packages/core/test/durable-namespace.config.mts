export default { test: { include: ['test/durable-namespace.test.ts', 'test/agent-creation-authority.test.ts', 'test/message-read-without-signing.test.ts'],
  environment: 'node', maxWorkers: 1, minWorkers: 1, testTimeout: 20000 } }
