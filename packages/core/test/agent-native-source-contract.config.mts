import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../../..')
export default defineConfig({ root, test: { include: ['packages/core/test/agent-native-source-contract.test.ts'],
  environment: 'node', passWithNoTests: false, maxWorkers: 1, fileParallelism: false } })
