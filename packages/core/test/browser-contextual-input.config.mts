import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
export default defineConfig({ root: resolve(import.meta.dirname, '../../..'), test: { environment: 'node', globalSetup: [],
  include: ['packages/core/test/browser-input-context.test.ts', 'packages/core/test/agent-message-render.test.ts', 'packages/core/test/agent-outbound-message.test.ts'],
  exclude: ['**/node_modules/**', '**/dist/**'], passWithNoTests: false, fileParallelism: false } })
