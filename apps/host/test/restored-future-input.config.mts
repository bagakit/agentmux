import { defineConfig } from 'vitest/config'
import { readFileSync, appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, relative } from 'node:path'
import source from '../../desktop/scripts/fixtures/agent-schedules/vitest.config.mjs'
const replacements: Record<string, string> = process.env.RESTORED_FUTURE_SOURCE_MAP ? JSON.parse(readFileSync(process.env.RESTORED_FUTURE_SOURCE_MAP, 'utf8')) : {}
export default defineConfig({ ...source, plugins: [{ name: 'exact-restored-future-source', enforce: 'pre', load(id) {
  const owner = relative(process.cwd(), id.split('?')[0]!)
  const replacement = replacements[owner]
  if (!replacement) return
  const body = readFileSync(resolve(replacement), 'utf8')
  if (process.env.RESTORED_FUTURE_LOADED) appendFileSync(process.env.RESTORED_FUTURE_LOADED, JSON.stringify({ owner, sha256: createHash('sha256').update(body).digest('hex') }) + '\n')
  return body
} }, ...(source.plugins ?? [])], test: { ...source.test, include: ['apps/host/test/restored-future-input.test.ts'], passWithNoTests: false, fileParallelism: false, maxWorkers: 1, testTimeout: 20000 } })
