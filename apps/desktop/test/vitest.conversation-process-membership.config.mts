import base from './vitest.conversation-unified-consumers.config.mts'
import { defineConfig } from 'vitest/config'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { candidateResolve } from '../scripts/candidate-package-resolve.mjs'
const root = resolve(import.meta.dirname, '../../..'), mutation = process.env.AGENTMUX_PROCESS_MEMBER_MUTATION
const edits: Record<string, [string, string, string]> = {
  'native-only-members': ['packages/client-ui/src/components/ConversationRecordSequence.tsx', 'return records.map(record => {', "return records.filter(record => record.original.kind === 'native').map(record => {"],
  'skip-captured-reveal': ['apps/desktop/src/renderer/src/components/ActivityView.tsx', '    setSelectedRecordId(record.id)\n    const target = record.target', "    setSelectedRecordId(record.id)\n    if (record.target.kind === 'observed') return\n    const target = record.target"],
  'drop-process-anchor': ['packages/client-ui/src/lib/conversation-reading-anchor.ts', "if (id && headRect && headRect.height > 0", "if (false && id && headRect && headRect.height > 0"],
  'ignore-original-host': ['apps/desktop/src/renderer/src/lib/conversation-consumer-observation.ts', 'record.hostId !== sourceHostId', 'false']
}
if (mutation && !edits[mutation]) throw Error('Unknown process membership mutation')
export default defineConfig({ ...base, cacheDir: '.cache/conversation-process-membership', plugins: [...base.plugins ?? [], {
  name: 'process-membership-source-proof', enforce: 'pre', transform(source, id) {
    const file = id.split('?')[0]!, path = relative(root, file)
    if (!path.startsWith('packages/') && !path.startsWith('apps/desktop/')) return
    if (!file.startsWith(root + '/') || /\.(?:d\.ts|css)$/.test(file)) return
    const edit = mutation && edits[mutation]![0] === path ? edits[mutation] : undefined
    if (edit && source.split(edit[1]).length !== 2) throw Error('Process membership mutation must match exactly once')
    const code = edit ? source.replace(edit[1], edit[2]) : source
    const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
    if (process.env.AGENTMUX_PROCESS_MEMBER_LOADED) appendFileSync(process.env.AGENTMUX_PROCESS_MEMBER_LOADED,
      JSON.stringify({ path, kind: !id.includes('?') && /\.[cm]?[jt]sx?$/.test(file) ? 'module' : 'resource', fileSHA256: hash(readFileSync(file)), originalSHA256: hash(source), sha256: hash(code), mutation: code === source ? null : mutation }) + '\n')
    return edit ? { code, map: null } : undefined
  }, resolveId(source) { if (source.startsWith('@agentmux/')) return candidateResolve(root, source, { source: true, browser: true }) }
}], test: { ...base.test, include: ['apps/desktop/test/conversation-process-membership.test.tsx'], passWithNoTests: false, fileParallelism: false, maxWorkers: 1 } })
