import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
export default defineConfig({ resolve: { alias: { '@agentmux/relay/gateway': resolve('packages/relay/src/gateway.ts') } },
  test: { environment: 'node', include: ['packages/core/test/public-rpc-relay-gateway.test.ts'], passWithNoTests: false, maxWorkers: 1, testTimeout: 15000, hookTimeout: 30000 } })
