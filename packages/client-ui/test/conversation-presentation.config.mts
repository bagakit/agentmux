import base from '../../../apps/desktop/test/vitest.conversation-unified-consumers.config.mts'
import { defineConfig } from 'vitest/config'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../../..')
const mutation = process.env.AGENTMUX_PRESENTATION_MUTATION
const file = 'packages/client-ui/src/lib/use-conversation-record-layout.ts'
const owner = mutation === 'ignore-cold-selected-candidates' ? 'packages/client-ui/src/lib/conversation-body-work.ts'
  : mutation === 'ignore-precommit-selection' ? 'packages/client-ui/src/lib/use-conversation-reading-selection.ts'
  : mutation === 'ignore-commit-anchor' || mutation === 'restore-without-capture' ? 'packages/client-ui/src/components/ConversationReadingCommit.tsx' : file
const edits: Record<string, [string, string]> = {
  'scan-unprotected-records': ['if (range || focused && focused !== document?.body && root?.contains(focused))', 'if (true)'],
  'ignore-parent-change': ['prior.parent === next.parent', 'true'],
  'ignore-role-revision': ['prior.version === next.version', 'true'],
  'split-frame': ['return { ...accepted.frame, sequence:', 'return { ...accepted.frame, coverage: (frame as any).coverage, sequence:'],
  'rehash-originals': ['record.event?.revision ?? conversationRevision(record.original.item)', 'conversationRevision(record.original.item)'],
  'ignore-anchor': ["if (anchor && !incoming.has(anchor.key)) return 'anchor'", "if (false) return 'anchor'"],
  'ignore-precommit-selection': ['const getSnapshot = useCallback(() => readSnapshot(), [readSnapshot, candidate])', 'const getSnapshot = useCallback(() => emptySelection, [candidate])'],
  'ignore-commit-anchor': ['return this.props.work.capture(true)', 'return false'],
  'restore-without-capture': ['return this.props.work.capture(true)', 'this.props.work.capture(true); return true'],
  'ignore-cold-selected-candidates': ['}, () => candidates)', '}, () => this.near)']
}
if (mutation && !edits[mutation]) throw new Error('Unknown presentation mutation')
export default defineConfig({ ...base, cacheDir: '.cache/conversation-presentation-' + (mutation ?? 'base'), plugins: [...base.plugins ?? [], {
  name: 'presentation-transaction-source-proof', enforce: 'pre', transform(source, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!/^(packages|apps|test)\//u.test(path) || path.includes('/node_modules/')) return
    let code = source
    if (mutation && path === owner) {
      const [from, to] = edits[mutation]!
      if (source.split(from).length !== 2) throw new Error('Missing unique presentation mutation: ' + mutation)
      code = source.replace(from, to)
    }
    const digest = (text: string) => createHash('sha256').update(text).digest('hex')
    if (process.env.AGENTMUX_PRESENTATION_LOADED) appendFileSync(process.env.AGENTMUX_PRESENTATION_LOADED,
      JSON.stringify({ path, originalSHA256: digest(source), fileSHA256: createHash('sha256').update(readFileSync(id.split('?')[0]!)).digest('hex'), sha256: digest(code), mutation: code === source ? null : mutation }) + '\n')
    return code === source ? undefined : { code, map: null }
  }
}], test: { ...base.test, include: ['packages/client-ui/test/conversation-presentation.test.tsx', ...(process.env.AGENTMUX_PRESENTATION_CONSUMERS ? ['apps/desktop/test/conversation-source-roles.test.tsx', 'apps/desktop/test/native-process-reading.test.tsx', 'apps/desktop/test/conversation-chronological-reading.test.tsx', 'apps/desktop/test/conversation-submission-reading.test.tsx', 'apps/desktop/test/conversation-reading-transaction.test.tsx', 'apps/desktop/test/conversation-owner-document-release.test.tsx', 'apps/desktop/test/conversation-selected-head-reading.test.tsx', 'apps/desktop/test/conversation-admission-intent.test.tsx', 'packages/client-ui/test/conversation-metrics.test.tsx'] : [])], passWithNoTests: false, fileParallelism: false } })
