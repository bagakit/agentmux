import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import source from './vitest.mote-context.config.mts'
const root = resolve(import.meta.dirname, '../../..'), loaded: Record<string, { sourceSHA256: string; loadedSHA256: string; mutant?: string }> = {}
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const mutant = process.env.AGENTMUX_DESKTOP_CREATION_WAKE_MUTANT
const changes: Record<string, [string, string, string]> = {
  'wrong-request': ['components/SessionPane.tsx', 'createOperationId: request.createOperationId, agentSessionId: sessionId', "createOperationId: 'replacement-operation', agentSessionId: sessionId"],
  'uncorrelated-receipt': ['main/runtime-controller.ts', 'return parseCreationContinueResult({ ...receipt, hostId: request.hostId }, request)', 'return { ...receipt, hostId: request.hostId }']
}
if (mutant) assert(changes[mutant], 'Known creation wake mutant')
export default defineConfig({ ...source, plugins: [{ name: 'creation-resource-wake-loaded-source', enforce: 'pre', transform(code, id) {
  const file = id.split('?')[0]!, change = mutant ? changes[mutant] : undefined
  let transformed = code, applied = false
  if (change && file.endsWith(change[0])) {
    assert.equal(code.split(change[1]).length - 1, 1, 'Exact current source mutation')
    transformed = code.replace(change[1], change[2]); applied = true
    process.stderr.write(`MUTATION_APPLIED=${mutant}\n`)
  }
  if (file.startsWith(root + '/apps/desktop/') && !file.includes('/node_modules/')) {
    loaded[relative(root, file)] = { sourceSHA256: hash(readFileSync(file)), loadedSHA256: hash(transformed), ...(applied ? { mutant } : {}) }
    if (process.env.AGENTMUX_DESKTOP_CREATION_WAKE_LOADED) writeFileSync(process.env.AGENTMUX_DESKTOP_CREATION_WAKE_LOADED, JSON.stringify(loaded))
  }
  if (applied) return { code: transformed, map: null }
} }], test: { ...source.test, setupFiles: [], globalSetup: [],
  include: mutant === 'wrong-request' ? ['apps/desktop/test/disk-start-recovery-surface.test.tsx']
    : mutant === 'uncorrelated-receipt' ? ['apps/desktop/test/creation-resource-wake-ipc.test.ts']
      : ['apps/desktop/test/disk-start-recovery-surface.test.tsx', 'apps/desktop/test/creation-resource-wake-ipc.test.ts'],
  passWithNoTests: false, maxWorkers: 1, fileParallelism: false } })
