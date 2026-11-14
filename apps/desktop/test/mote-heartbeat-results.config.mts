import { defineConfig } from 'vitest/config'
import { relative, resolve } from 'node:path'
import { instrument } from './mote-heartbeat-results-mutations.mjs'
import original from './mote-initialization.config.mts'
export default defineConfig({ ...original, resolve: { ...original.resolve, alias: [
  { find: /^@agentmux\/browser\/browser-operation-result$/, replacement: resolve(import.meta.dirname, '../../../packages/browser/src/browser-operation-result.ts') },
  ...original.resolve!.alias as import('vite').Alias[]
] }, plugins: [...(original.plugins ?? []), { name: 'heartbeat-surface-source', enforce: 'pre', transform(code, id) { return instrument(code, relative(process.cwd(), id.split('?')[0]!)) } }], test: { ...original.test, include: ['apps/desktop/test/mote-heartbeat-results.test.tsx'], maxWorkers: 1, fileParallelism: false, passWithNoTests: false, testTimeout: 20000 } })
