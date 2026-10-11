import base from './vitest.native-adoption.config.mts'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
const root = resolve(import.meta.dirname, '../../..')
const targetRestore = `    for (const { entry, backup } of restorations.reverse()) {
      if (backup) {
        await writeAtomically(entry.path, backup, entry.previousMode ?? 0o600)
      } else {
        await unlink(entry.path)
      }
    }
`
const ownershipRestore = `    for (const original of registrations) {
      if (original.raw === null) await unlink(original.path)
      else await writeAtomically(original.path, original.raw, 0o600)
    }
`
const mutations = {
  'retain-stale-owned': { path: 'packages/core/src/hook-config-merge.ts', from: 'for (const [event, definitions] of Object.entries(previous)) {', to: 'for (const [event, definitions] of Object.entries({})) {', count: 1 },
  'forget-pending-after': { path: 'packages/core/src/managed-hook-installer.ts', from: 'if (currentHash === state.nextHash)', to: 'if (state.committed && currentHash === state.nextHash)', count: 1 },
  'restore-ownership-first': { path: 'packages/core/src/managed-hook-installer.ts', from: targetRestore + ownershipRestore, to: ownershipRestore + targetRestore, count: 1 },
  'native-budget-for-receipts': { path: 'packages/core/src/managed-hook-installer.ts', from: 'MAX_HOOK_FILE_BYTES * 8', to: 'MAX_HOOK_FILE_BYTES', count: 2 },
  'native-budget-for-fragments': { path: 'packages/core/src/managed-hook-installer.ts', from: "(candidate.content === null || typeof candidate.content === 'string')", to: "(candidate.content === null || typeof candidate.content === 'string' && Buffer.byteLength(candidate.content) <= MAX_HOOK_FILE_BYTES)", count: 1 },
  'allow-concurrent-targets': { path: 'packages/core/src/managed-hook-installer.ts', from: 'if (!native.tryLock(lock.fd))', to: 'if (false)', count: 1 }
}
export default defineConfig({ ...base, cacheDir: resolve(root, '.cache/managed-hook-ownership'),
  plugins: [...base.plugins ?? [], { name: 'managed-hook-ownership-proof', enforce: 'pre', transform(source, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!['packages/core/src/managed-hook-installer.ts', 'packages/core/src/hook-config-merge.ts', 'packages/core/src/client.ts'].includes(path)) return
    let code = source
    const mutation = process.env.AGENTMUX_HOOK_OWNERSHIP_MUTATION as keyof typeof mutations | undefined
    if (mutation) {
      const edit = mutations[mutation]
      if (!edit) throw Error('Unknown ownership mutation')
      if (path === edit.path) {
        if (source.split(edit.from).length !== edit.count + 1) throw Error('Missing exact ownership mutation target')
        code = source.split(edit.from).join(edit.to)
      }
    }
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    if (process.env.AGENTMUX_HOOK_OWNERSHIP_LOADED) appendFileSync(process.env.AGENTMUX_HOOK_OWNERSHIP_LOADED,
      JSON.stringify({ path, originalSHA256: hash(source), sha256: hash(code), bytes: Buffer.byteLength(code), ...(code === source ? {} : { mutation }) }) + '\n')
    return code === source ? undefined : { code, map: null }
  } }],
  test: { ...base.test, include: ['packages/core/test/managed-hook-ownership.test.ts', 'packages/core/test/hook-config-merge.test.ts', 'packages/core/test/managed-hook-installer.test.ts'], exclude: [], passWithNoTests: false, fileParallelism: false, testTimeout: 20000 } })
