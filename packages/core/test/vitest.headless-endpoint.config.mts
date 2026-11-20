import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
export default defineConfig({ resolve: { alias: { '@agentmux/relay/gateway': resolve('packages/relay/src/gateway.ts') } }, test: {
  include: ['packages/core/test/headless-mesh-endpoint.integration.test.ts', 'packages/core/test/host-route-relay.integration.test.ts'],
  environment: 'node', maxWorkers: 1, passWithNoTests: false, testTimeout: 120000, hookTimeout: 30000,
} })
