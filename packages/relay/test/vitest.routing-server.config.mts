import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { include: ['packages/relay/test/routing-server.test.ts', 'packages/relay/test/gateway.test.ts', 'packages/relay/test/local-identifiers.test.ts'], maxWorkers: 1, testTimeout: 15000, passWithNoTests: false } })
