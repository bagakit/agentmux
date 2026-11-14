import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
export default defineConfig({ resolve: { alias: { '@agentmux/relay/gateway': resolve('packages/relay/src/gateway.ts') } }, test: {
  include: ['packages/core/test/mesh-network.test.ts', 'packages/core/test/public-rpc-relay-gateway.test.ts'],
  environment: 'node', maxWorkers: 1, passWithNoTests: false, testTimeout: 30000, hookTimeout: 30000,
} })
