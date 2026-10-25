import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const root = resolve(import.meta.dirname, '../../..')
const evidence = process.env.AGENTMUX_SESSION_ADMISSION_PROOF_DIR
const inverse = process.env.AGENTMUX_SESSION_ADMISSION_INVERSE === '1'
const owners = ['agent-session-store', 'agent-session-registry', 'agent-session-database'].map(name => resolve(root, 'packages/core/src', name + '.ts'))
const loaded = new Map<string, { path: string; originalSha256: string; servedSha256: string }>()
const hash = (value: string) => createHash('sha256').update(value).digest('hex')

export default defineConfig({
  cacheDir: resolve(root, '.local/cache/session-admission-write-cost', inverse ? 'inverse' : 'source'),
  plugins: [{ name: 'session-admission-source-proof', enforce: 'pre', transform(code, id) {
    if (!owners.includes(id)) return
    let served = code
    if (inverse && id === owners[0]) {
      const gate = '    if (isDeepStrictEqual(original, value)) return\n'
      if (code.split(gate).length !== 2) throw new Error('Admission source inverse must remove exactly one equality gate')
      served = code.replace(gate, '')
    }
    if (evidence) {
      mkdirSync(evidence, { recursive: true })
      loaded.set(id, { path: id, originalSha256: hash(code), servedSha256: hash(served) })
      writeFileSync(resolve(evidence, 'loaded.json'), JSON.stringify([...loaded.values()], null, 2) + '\n')
      writeFileSync(resolve(evidence, id.slice(id.lastIndexOf('/') + 1)), served)
    }
    return served === code ? undefined : { code: served, map: null }
  } }],
  test: {
    include: [process.env.AGENTMUX_SESSION_ADMISSION_REGRESSION === '1'
      ? 'packages/core/test/agent-session-durability.test.ts' : 'packages/core/test/session-admission-write-cost.test.ts'],
    passWithNoTests: false, maxWorkers: 1, fileParallelism: false, testTimeout: 10000,
  },
})
