import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { include: [
  'packages/relay/test/gateway.test.ts', 'packages/relay/test/routing-server.test.ts',
  'packages/relay/test/local-identifiers.test.ts', 'packages/relay/test/local-relay-role-limits.test.ts',
  'packages/relay/test/local-relay-backpressure.test.ts', 'packages/relay/test/encrypted-relay-socket.test.ts',
  'packages/relay/test/connection-offer.test.ts', 'packages/relay/test/large-reply-chain.test.ts',
], maxWorkers: 1, testTimeout: 30000, passWithNoTests: false } })
