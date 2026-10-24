import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { include: ['apps/host/test/portable-host.test.ts'], environment: 'node', fileParallelism: false, passWithNoTests: false } })
