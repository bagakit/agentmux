import { defineConfig } from 'vitest/config'
import { resolve, relative } from 'node:path'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { mutations } from './mutations.mjs'
const root = resolve(import.meta.dirname, '../../../../..')
export default defineConfig({ root, cacheDir: resolve(root, '.local/cache/provider-contract'),
  plugins: [{ name: 'provider-contract-actual-source', enforce: 'pre', transform(source, id) {
    const name = process.env.AMX_PROVIDER_MUTATION
    const mutation = name ? mutations[name as keyof typeof mutations] : undefined
    if (name && !mutation) throw new Error('Unknown Provider mutation')
    const path = relative(root, id.split('?')[0]!)
    if (!mutation || mutation.path !== path) return
    if (source.split(mutation.from).length !== 2) throw new Error('Provider mutation must match one actual owner site')
    const changed = source.replace(mutation.from, mutation.to)
    const receipt = process.env.AMX_PROVIDER_MUTATION_RECEIPT
    if (!receipt) throw new Error('Provider mutation receipt required')
    const hash = (text: string) => createHash('sha256').update(text).digest('hex')
    appendFileSync(receipt, JSON.stringify({ path, name, source: hash(source), loaded: hash(changed) }) + '\n')
    return { code: changed, map: null }
  } }],
  test: { include: ['packages/core/test/provider-contribution-contract.test.ts', 'packages/core/test/provider-contract.test.ts', 'packages/core/test/provider-hook-outcome.test.ts', 'packages/core/test/native-read-error.test.ts', 'packages/core/test/provider-hook-activation.test.ts', 'packages/core/test/agent-usage-transcript.test.ts', 'packages/core/test/executor-yolo.test.ts', 'packages/core/test/agent-hook-command.test.ts'],
    passWithNoTests: false, fileParallelism: false, maxWorkers: 1, testTimeout: 10000 } })
