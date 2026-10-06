import { defineConfig, mergeConfig } from 'vitest/config'
import base from '../../../vitest.config.js'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const config = mergeConfig(base, defineConfig({ plugins: [{ name: 'permission-hook-source-receipt', enforce: 'pre', transform(code, id) {
  if (process.env.T005_LOAD_LOG && id.startsWith(import.meta.dirname.replace('/test', '/src') + '/')) appendFileSync(process.env.T005_LOAD_LOG, JSON.stringify({ id, rawFileSHA: createHash('sha256').update(readFileSync(id)).digest('hex'), viteInputSHA: createHash('sha256').update(code).digest('hex') }) + '\n')
  return null
} }], test: { maxWorkers: 1, testTimeout: 15_000 } }))
config.test!.include = ['packages/core/test/permission-hook-callback.test.ts', 'packages/core/test/permission-hook-core.test.ts', 'packages/core/test/client-interaction-lifecycle.test.ts', 'packages/core/test/continuous-progress.test.ts', 'packages/core/test/agent-hook-command.test.ts', 'apps/desktop/test/runtime-controller.test.ts']
export default config
