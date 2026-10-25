import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
import goals from './vitest.goals-domain.config.mjs'
export default defineConfig({ ...goals,
  resolve: { ...goals.resolve, alias: [{ find: /^@agentmux\/demand$/u, replacement: resolve(import.meta.dirname, '../../../packages/demand/src/index.ts') },
    { find: /^@agentmux\/demand\/(.+)$/u, replacement: resolve(import.meta.dirname, '../../../packages/demand/src/$1.ts') }, ...(goals.resolve!.alias as any[])] },
  test: { include: ['apps/host/test/goal-owner-recovery.test.ts'], maxWorkers: 1, fileParallelism: false } })
