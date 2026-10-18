import base from '../../../apps/desktop/test/vitest.conversation-unified-consumers.config.mts'
import { defineConfig } from 'vitest/config'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { candidateResolve } from '../../../apps/desktop/scripts/candidate-package-resolve.mjs'

const root = resolve(import.meta.dirname, '../../..'), owner = 'packages/client-ui/src/components/CapturedProcessRecord.tsx'
const mutation = process.env.AGENTMUX_FIELD_MUTATION
const edits: Record<string, [string, string]> = {
  'repeat-content': ['    <div id={bodyId}', '    {item.kind !== \'tool_call\' && item.content ? <p className="log-row__prose">{item.content}</p> : null}\n    <div id={bodyId}'],
  'empty-payload': ['if (text === undefined || text.length === 0) return null', 'if (text === undefined) return null'],
  'snapshot-identity': ['const sourceIdentity = useMemo(() => ({}), [record.sourceHostId, sourceKey])', 'const sourceIdentity = item']
}
if (mutation && mutation !== 'contribution-snapshot-identity' && !edits[mutation]) throw Error('Unknown captured field mutation')
export default defineConfig({ ...base, cacheDir: '.cache/captured-process-fields', plugins: [...base.plugins ?? [], {
  name: 'captured-field-source-proof', enforce: 'pre', transform(source, id) {
    const file = id.split('?')[0]!, path = relative(root, file)
    if (!path.startsWith('packages/') && !path.startsWith('apps/desktop/')) return
    if (!file.startsWith(root + '/') || /\.(?:d\.ts|css)$/.test(file)) return
    const edit = mutation === 'contribution-snapshot-identity'
      ? path === 'packages/client-ui/src/components/ConversationView.tsx' ? ['const sourceIdentity = useMemo(() => ({}), [record.sourceHostId, sourceKey])', 'const sourceIdentity = record.original.item'] as [string, string] : undefined
      : mutation && path === owner ? edits[mutation] : undefined
    if (edit && source.split(edit[0]).length !== 2) throw Error('Captured field mutation must match exactly once')
    const code = edit ? source.replace(...edit) : source
    const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
    if (process.env.AGENTMUX_FIELD_LOADED) appendFileSync(process.env.AGENTMUX_FIELD_LOADED,
      JSON.stringify({ path, kind: !id.includes('?') && /\.[cm]?[jt]sx?$/.test(file) ? 'module' : 'resource', fileSHA256: hash(readFileSync(file)), originalSHA256: hash(source), sha256: hash(code), mutation: code === source ? null : mutation }) + '\n')
    return edit ? { code, map: null } : undefined
  }, resolveId(source) { if (source.startsWith('@agentmux/')) return candidateResolve(root, source, { source: true, browser: true }) }
}], test: { ...base.test, include: ['packages/client-ui/test/captured-process-fields.test.tsx'], passWithNoTests: false, fileParallelism: false, maxWorkers: 1 } })
