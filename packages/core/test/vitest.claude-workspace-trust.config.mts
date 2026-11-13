import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { environment: 'node', include: ['packages/core/test/providers/claude-workspace-trust.test.ts', 'packages/core/test/owned-workspace-trust-launch.test.ts'], passWithNoTests: false, testTimeout: 20000 } })
