import { defineConfig } from 'vitest/config'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import base from './vitest.mote-context.config.mts'
const root = resolve(import.meta.dirname, '../../..'), mutation = process.env.AGENTMUX_SOURCE_EXPORT_MUTATION
const edits: Record<string, [string, string, string]> = {
  'copy-in-writer': ['apps/desktop/src/main/workbench-user-state.ts', 'const root = await captureWorkbenchRecoveryFiles(id, directory, files)', 'const root = await this.queue(() => captureWorkbenchRecoveryFiles(id, directory, files))'],
  'leave-export': ['apps/desktop/src/main/storage-recovery-exports.ts', 'if (entry.directory) await rm(entry.directory,', 'if (false && entry.directory) await rm(entry.directory,'],
  'repeated-copy': ['apps/host/src/desktop-storage-recovery.ts', 'lastError !== undefined || revision !== current.revision', 'true'],
  'disconnect-main-source': ['apps/desktop/src/main/ipc.ts', '    storageRecoveryExports,', ''],
  'child-gap-unscoped': ['apps/host/src/desktop-storage-recovery.ts', "captured.gaps.map(gap => ({ sourceId: id, memberId: gap.sourceId + '/' + (gap.memberId ?? ''), code: gap.code }))", 'captured.gaps']
}
if (mutation && !edits[mutation]) throw Error('Unknown Main source-export mutation')
export default defineConfig({ ...base, cacheDir: resolve(root, '.tmp/storage-recovery-exports'),
  plugins: [...base.plugins ?? [], { name: 'storage-recovery-export-source-proof', enforce: 'pre', transform(source, id) {
    const path = relative(root, id.split('?')[0]!), edit = mutation && edits[mutation]
    let code = source
    if (edit && path === edit[0]) {
      if (!code.includes(edit[1])) throw Error('Missing source-export mutation anchor')
      code = code.replace(edit[1], edit[2])
    }
    const output = process.env.AGENTMUX_SOURCE_EXPORT_LOADED
    if (output && /^(?:apps\/(?:desktop|host)\/src|packages\/core\/src)\//u.test(path)) appendFileSync(output,
      JSON.stringify({ path, absolutePath: id.split('?')[0], diskSHA256: createHash('sha256').update(readFileSync(id.split('?')[0]!)).digest('hex'),
        sha256: createHash('sha256').update(code).digest('hex'), mutation: source === code ? null : mutation }) + '\n', { mode: 0o600 })
    return code === source ? undefined : { code, map: null }
  } }],
  test: { ...base.test, include: process.env.AGENTMUX_SOURCE_EXPORT_MODE === 'native'
    ? ['apps/desktop/test/first-execution-ipc.test.ts'] : ['apps/desktop/test/storage-recovery-exports.test.ts'],
    ...(process.env.AGENTMUX_SOURCE_EXPORT_MODE === 'native' ? { testNamePattern: /registered Main source export/ } : {}),
    maxWorkers: 1, fileParallelism: false, passWithNoTests: false, testTimeout: 40_000 }
})
