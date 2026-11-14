import { defineConfig } from 'vitest/config'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import base from './vitest.mote-context.config.mts'
const root = resolve(import.meta.dirname, '../../..'), mutation = process.env.AGENTMUX_DESKTOP_RESTORE_MUTATION
const edits: Record<string, [string, string, string]> = {
  'queue-auto-replay': ['apps/desktop/src/main/workbench-recovery-restore.ts', 'awaitingExplicitSend: true', 'awaitingExplicitSend: false'],
  'replace-live-draft': ['apps/desktop/src/main/workbench-user-state.ts', "if (member.id === 'document' ? this.rootOpened : this.openedAuxiliary.has(member.id))", 'if (false)'],
  'close-auto-apply': ['apps/desktop/src/main/workbench-close-owner.ts', "outcome: 'unknown', diskDurability: 'unconfirmed'", "outcome: 'prepared', diskDurability: 'unconfirmed'"],
  'source-wrong-target': ['apps/desktop/src/main/workbench-recovery-restore.ts', 'member.target !== target', 'false']
}
if (mutation && !edits[mutation]) throw Error('Unknown Desktop restore mutation')
export default defineConfig({ ...base, cacheDir: resolve(root, '.tmp/workbench-recovery-restore'),
  plugins: [...base.plugins ?? [], { name: 'original-main-restoration-source', enforce: 'pre', transform(source, id) {
    const path = relative(root, id.split('?')[0]!), edit = mutation && edits[mutation]
    let code = source
    if (edit && path === edit[0]) {
      if (!code.includes(edit[1])) throw Error('Missing original Main restore mutation anchor')
      code = code.replaceAll(edit[1], edit[2])
    }
    const output = process.env.AGENTMUX_SOURCE_EXPORT_LOADED
    if (output && /^(?:apps\/(?:desktop|host)\/src|packages\/core\/src)\//u.test(path)) appendFileSync(output,
      JSON.stringify({ path, absolutePath: id.split('?')[0], diskSHA256: createHash('sha256').update(readFileSync(id.split('?')[0]!)).digest('hex'),
        sha256: createHash('sha256').update(code).digest('hex'), mutation: source === code ? null : mutation }) + '\n', { mode: 0o600 })
    return code === source ? undefined : { code, map: null }
  } }], test: { ...base.test, include: ['apps/desktop/test/workbench-recovery-restore.test.ts'],
    maxWorkers: 1, fileParallelism: false, passWithNoTests: false, testTimeout: 40_000 }
})
