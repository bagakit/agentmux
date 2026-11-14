import { defineConfig } from 'vitest/config'
import { relative, resolve } from 'node:path'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import base from './vitest.storage-recovery-exports.config.mts'
const root = resolve(import.meta.dirname, '../../..'), mutation = process.env.AGENTMUX_RECOVERY_NOTICE_MUTATION
const edits: Record<string, [string, string, string]> = {
  'disconnect-notice': ['apps/desktop/src/renderer/src/components/GlobalSystemNotices.tsx', 'if (recoveryNotice) storage.push(recoveryNotice)', 'void recoveryNotice'],
  'retry-new-target': ['apps/desktop/src/main/runtime-controller.ts', "'storage.backup.create', {}, context, owner", "'storage.backup.create', {}, context, undefined"],
  'lost-point': ['apps/desktop/src/renderer/src/lib/storage-recovery-notice.ts', 'status?.lastGeneration ?? point', 'status?.lastGeneration'],
  'late-read': ['apps/desktop/src/renderer/src/lib/use-storage-recovery-notice.ts', 'generation !== observation.current', 'false']
}
if (mutation && !edits[mutation]) throw Error('Unknown recovery-notice mutation')
export default defineConfig({ ...base,
  plugins: [...base.plugins ?? [], { name: 'shipping-storage-notice-consumer', enforce: 'pre', transform(source, id) {
    const path = relative(root, id.split('?')[0]!), edit = mutation && edits[mutation]
    let code = path === 'apps/desktop/src/renderer/src/lib/use-storage-recovery-notice.ts' ? source.replaceAll('__AGENTMUX_WEB_PREVIEW__', 'false') : source
    if (edit && path === edit[0]) {
      if (!code.includes(edit[1])) throw Error('Missing recovery-notice mutation anchor')
      code = code.replace(edit[1], edit[2])
    }
    const output = process.env.AGENTMUX_RECOVERY_NOTICE_LOADED
    if (output && path.startsWith('apps/desktop/src/')) appendFileSync(output, JSON.stringify({ path, absolutePath: id.split('?')[0],
      diskSHA256: createHash('sha256').update(readFileSync(id.split('?')[0]!)).digest('hex'), sha256: createHash('sha256').update(code).digest('hex'),
      mutation: edit && path === edit[0] ? mutation : null }) + '\n', { mode: 0o600 })
    return code === source ? undefined : { code, map: null }
  } }],
  test: { ...base.test, include: ['apps/desktop/test/storage-recovery-notice.test.ts', 'apps/desktop/test/storage-recovery-notice-consumer.test.tsx'],
    testNamePattern: undefined, testTimeout: 40_000, passWithNoTests: false }
})
