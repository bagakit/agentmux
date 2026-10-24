import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import native from './vitest.mote-host.config.mts'
const root = native.root!
const mutant = process.env.T031_MUTANT
if (mutant && mutant !== 'drop-waiting') throw new Error('Unknown private input diagnosis mutant')
export default defineConfig({ ...native, plugins: [{ name: 'original-waiting-executed', enforce: 'pre', transform(code, id) {
  const path = relative(root, id.split('?')[0]!)
  if (!/^(?:packages\/(?:core|connectors)|apps\/host)\/(?:src|test)\/.*\.(?:ts|mts)$/u.test(path)) return
  const original = code
  if (mutant && path === 'packages/connectors/src/mote-chat-diagnosis.ts') {
    const from = 'waiting: waiting ? { phase: waiting.phase, reason: waiting.reason, wake: waiting.wake } : null,'
    if (code.split(from).length !== 2) throw new Error('Expected unique original wait projection anchor')
    code = code.replace(from, 'waiting: null,')
  }
  const sha = (value: string) => createHash('sha256').update(value).digest('hex')
  const facts = { path, originalSha256: sha(original), loadedSha256: sha(code), ...(code === original ? {} : { mutation: mutant }) }
  return process.env.T031_LOADED ? { code: `import { appendFileSync as __t031Trace } from 'node:fs'; __t031Trace(${JSON.stringify(process.env.T031_LOADED)}, ${JSON.stringify(JSON.stringify(facts) + '\n')});\n` + code, map: null }
    : code === original ? undefined : { code, map: null }
} }, ...native.plugins!], test: { ...native.test,
  include: ['packages/connectors/test/mote-chat-waiting.integration.test.ts', 'packages/core/test/mote-chat-diagnosis.test.ts'],
  passWithNoTests: false, fileParallelism: false, maxWorkers: 1,
  setupFiles: [resolve(root, 'vitest.setup.ts')] } })
