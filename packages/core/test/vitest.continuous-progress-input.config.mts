import { defineConfig } from 'vitest/config'
import { relative } from 'node:path'
import { instrument } from './helpers/continuous-progress-input-mutations.mjs'
export default defineConfig({ plugins: [{ name: 'exact-continuous-progress-input-source', enforce: 'pre', transform(code, id) {
  return { code: instrument(code, relative(process.cwd(), id.split('?')[0]!)), map: null }
} }], test: { include: ['packages/core/test/continuous-progress-input.test.ts'], passWithNoTests: false, maxWorkers: 1, fileParallelism: false } })
