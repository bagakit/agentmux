import { defineConfig } from 'vitest/config'
import { relative } from 'node:path'
import { instrument } from './mote-heartbeat-results-mutations.mjs'
import original from './mote-initialization.config.mts'
export default defineConfig({ ...original, plugins: [...(original.plugins ?? []), { name: 'heartbeat-surface-source', enforce: 'pre', transform(code, id) { return instrument(code, relative(process.cwd(), id.split('?')[0]!)) } }], test: { ...original.test, include: ['apps/desktop/test/mote-heartbeat-results.test.tsx'], maxWorkers: 1, fileParallelism: false, passWithNoTests: false, testTimeout: 20000 } })
