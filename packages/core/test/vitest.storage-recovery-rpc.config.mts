import { defineConfig } from 'vitest/config'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
export default defineConfig({
  cacheDir: resolve(import.meta.dirname, '../../../.local/cache/storage-recovery-rpc-vite'),
  plugins: [{ name: 'storage-recovery-source-binding', enforce: 'pre', transform(source, id) {
    const path = id.split('?')[0]!, output = process.env.AGENTMUX_RECEIPT_SOURCE_LOADS
    const mutation = process.env.AGENTMUX_SOURCE_RESTORE_MUTATION
    const edits: Record<string, [string, string, string]> = {
      'source-user-guard': ['public-rpc-service.ts', "context.transport !== 'unix'", 'false'],
      'source-frozen-target': ['storage-recovery-rpc.ts', 'member.target !== before.target', 'false'],
      'source-prepare-dispatch': ['public-rpc-service.ts', "await exports.prepare(captureId, (input as StorageRecoveryParamsMap['storage.source.prepare']).members)", "({captureId, result: {state: 'prepared', members: (input as StorageRecoveryParamsMap['storage.source.prepare']).members}})"]
    }
    let code = source, mutationId = mutation
    const candidate = process.env.AGENTMUX_STORAGE_RPC_MUTANT ? JSON.parse(process.env.AGENTMUX_STORAGE_RPC_MUTANT) : undefined
    if (candidate && resolve(path) === candidate.path) {
      if (createHash('sha256').update(readFileSync(path)).digest('hex') !== candidate.diskSHA256) throw Error('The actual RPC owner changed under its mutation')
      code = readFileSync(candidate.file, 'utf8'); mutationId = candidate.id
    }
    if (mutation && edits[mutation] && path.endsWith('/' + edits[mutation][0])) {
      const [, before, after] = edits[mutation]
      if (!code.includes(before!)) throw Error('Missing exact source-restore mutation anchor')
      code = code.replace(before!, after!)
    }
    if (output && path.includes('/packages/core/src/') && path.endsWith('.ts')) appendFileSync(output,
      JSON.stringify({ path: resolve(path), sha256: createHash('sha256').update(readFileSync(path)).digest('hex'), compiledSourceSHA256: createHash('sha256').update(code).digest('hex'), mutation: code === source ? null : mutationId }) + '\n', { mode: 0o600 })
    return code === source ? undefined : { code, map: null }
  } }],
  test: { include: ['packages/core/test/storage-recovery-rpc.test.ts', 'packages/core/test/agentmux-cli-global-discovery.test.ts'],
    maxWorkers: 1, fileParallelism: false, passWithNoTests: false, testTimeout: 20_000 }
})
