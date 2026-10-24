import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import native from './vitest.mote-host.config.mts'
const root = native.root!
const mutant = process.env.T031_MUTANT
if (mutant && mutant !== 'drop-waiting') throw new Error('Unknown private input diagnosis mutant')
const failureMutant = process.env.T032_MUTANT
if (failureMutant && !['drop-failure-code', 'hide-exited-runtime'].includes(failureMutant)) throw new Error('Unknown private input failure-code mutant')
export default defineConfig({ ...native, plugins: [{ name: 'original-waiting-executed', enforce: 'pre', transform(code, id) {
  const path = relative(root, id.split('?')[0]!)
  if (!/^(?:packages\/(?:core|connectors)|apps\/host)\/(?:src|test)\/.*\.(?:ts|mts)$/u.test(path)) return
  const original = code
  if (mutant && path === 'packages/connectors/src/mote-chat-diagnosis.ts') {
    const from = 'waiting: waiting ? { phase: waiting.phase, reason: waiting.reason, wake: waiting.wake } : null,'
    if (code.split(from).length !== 2) throw new Error('Expected unique original wait projection anchor')
    code = code.replace(from, 'waiting: null,')
  }
  if (failureMutant === 'drop-failure-code' && path === 'packages/connectors/src/mote-chat-diagnosis.ts') {
    const from = 'failureCode: receipt ? moteChatInputFailureCode(receipt) : null'
    if (code.split(from).length !== 2) throw new Error('Expected unique original failure-code projection anchor')
    code = code.replace(from, 'failureCode: null')
  }
  if (failureMutant === 'hide-exited-runtime' && path === 'packages/connectors/src/mote-chat-diagnosis.ts') {
    const from = 'input.runtime = await pending'
    if (code.split(from).length !== 2) throw new Error('Expected unique original Runtime projection anchor')
    code = code.replace(from, "input.runtime = { ...(await pending)!, state: 'running', exitCode: null }")
  }
  const sha = (value: string) => createHash('sha256').update(value).digest('hex')
  const facts = { path, originalSha256: sha(original), loadedSha256: sha(code), ...(code === original ? {} : { mutation: failureMutant ?? mutant }) }
  const trace = process.env.T032_LOADED ?? process.env.T031_LOADED
  return trace ? { code: `import { appendFileSync as __t031Trace } from 'node:fs'; __t031Trace(${JSON.stringify(trace)}, ${JSON.stringify(JSON.stringify(facts) + '\n')});\n` + code, map: null }
    : code === original ? undefined : { code, map: null }
} }, ...native.plugins!], test: { ...native.test,
  include: ['packages/connectors/test/mote-chat-waiting.integration.test.ts', 'packages/core/test/mote-chat-diagnosis.test.ts', 'apps/host/test/mote-default-join-consumer.test.ts'],
  passWithNoTests: false, fileParallelism: false, maxWorkers: 1,
  setupFiles: [resolve(root, 'vitest.setup.ts')] } })
