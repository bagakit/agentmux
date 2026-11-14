import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const root = resolve(import.meta.dirname, '../../..'), selected = process.env.AGENTMUX_PORTABILITY_MUTANT
const mutations = {
  'wrong-phase-hash': ['return promptDigest(JSON.stringify([', 'return "changed-" + promptDigest(JSON.stringify(['],
  'utf16-payload-length': ['utf8ByteLength(plan.payload)', 'plan.payload.length']
} as const
if (selected && !Object.hasOwn(mutations, selected)) throw Error('Unknown prompt receipt portability inverse')
let applied = false
export default defineConfig({ root, cacheDir: resolve(root, '.tmp/prompt-receipt-portability-cache'),
  plugins: [{ name: 'actual-prompt-receipt-portability-source', enforce: 'pre', transform(original, id) {
    const file = relative(root, id.split('?')[0]!)
    if (file !== 'packages/core/src/prompt-submission-record.ts') return
    let code = original
    if (selected) {
      const [before, after] = mutations[selected as keyof typeof mutations]
      if (code.split(before).length !== 2) throw Error('One exact prompt receipt inverse anchor required')
      code = code.replace(before, after); applied = true; process.stderr.write(`MUTATION_APPLIED=${selected}\n`)
    }
    const hash = (text: string) => createHash('sha256').update(text).digest('hex')
    if (process.env.AGENTMUX_PORTABILITY_LOADED) appendFileSync(process.env.AGENTMUX_PORTABILITY_LOADED, JSON.stringify({ file, original_sha256: hash(original), loaded_sha256: hash(code), mutant: selected ?? null }) + '\n')
    return code === original ? undefined : { code, map: null }
  }, buildEnd() { if (selected && !applied) throw Error('The inverse did not reach the original record decoder') } }],
  test: { environment: 'node', setupFiles: [], globalSetup: [], maxWorkers: 1, fileParallelism: false, passWithNoTests: false,
    testTimeout: 30000, hookTimeout: 20000, include: ['packages/core/test/prompt-receipt-portability.test.ts', 'packages/core/test/prompt-input-byte-limit.test.ts', 'packages/core/test/prompt-receipt-preservation.test.ts'] }
})
