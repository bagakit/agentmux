import { defineConfig } from 'vitest/config'
import source from '../../../apps/desktop/scripts/fixtures/agent-schedules/vitest.config.mjs'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../../..')
export default defineConfig({ ...source, plugins: [...(source.plugins ?? []), { name: 'cursor-response-actual-source-mutation', enforce: 'pre',
  resolveId(specifier) { if (specifier === '@agentmux/providers/cursor/provider') return resolve(root, 'packages/providers/src/cursor/provider.ts') },
  transform(code, id) {
  const mutation = process.env.AGENTMUX_CURSOR_RESPONSE_MUTATION
  if (!mutation) return
  if (mutation !== 'response-reopens-turn') throw new Error('Unknown Cursor response mutation')
  if (relative(root, id.split('?')[0]!) !== 'packages/providers/src/cursor/provider.ts') return
  const before = "'beforeShellExecution', 'beforeMCPExecution'\n"
  if (code.split(before).length !== 2) throw new Error('Cursor response mutation needs exactly one production anchor')
  const changed = code.replace(before, "'beforeShellExecution', 'beforeMCPExecution', 'afterAgentResponse'\n")
  if (process.env.AGENTMUX_CURSOR_RESPONSE_LOADED) appendFileSync(process.env.AGENTMUX_CURSOR_RESPONSE_LOADED,
    JSON.stringify({ mutation, path: 'packages/providers/src/cursor/provider.ts', originalSHA256: createHash('sha256').update(code).digest('hex'),
      loadedSHA256: createHash('sha256').update(changed).digest('hex') }) + '\n')
  return { code: changed, map: null }
} }], test: { ...source.test, environment: 'node', fileParallelism: false, maxWorkers: 1, passWithNoTests: false, testTimeout: 20000,
  include: ['packages/core/test/cursor-response-lifecycle.test.ts', 'packages/core/test/providers/cursor.test.ts', 'packages/core/test/hook-turn-phase.test.ts'] } })
