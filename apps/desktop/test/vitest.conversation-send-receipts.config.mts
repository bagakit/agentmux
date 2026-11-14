import base from './vitest.conversation-unified-consumers.config.mts'
import { defineConfig } from 'vitest/config'
import { relative, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
const root = resolve(import.meta.dirname, '../../..')
const policy = 'packages/client-ui/src/lib/conversation-send-receipts.ts'
const component = 'packages/client-ui/src/components/ConversationSubmissionMetadata.tsx'
const changes: Record<string, [string, string]> = {
  'guess-native-received': ["const confirmed = status === 'admitted' || nativeAccepted", 'const confirmed = true'],
  'lose-compact': ["const compact = !options.original && (!show || deliveredUnconfirmed || state.confirmed && confirmedMode !== 'keep')", 'const compact = false'],
  'off-keeps-full-card': ["const compact = !options.original && (!show || deliveredUnconfirmed || state.confirmed && confirmedMode !== 'keep')", "const compact = !options.original && state.confirmed && (confirmedMode !== 'keep' || !show)"],
  'lose-unique-original': ['const hidden = !state.attention && options.nativeReadable === true &&', 'const hidden = !state.attention &&'],
  'keep-motion-after-admission': ["const pending = !confirmed && item?.status !== 'failed' && status === 'waiting' && item?.inputSubmission?.observation === 'owned'", "const pending = item?.status !== 'failed'"],
  'ignore-document-visibility': ["animation={visible ? 'spin' : 'none'}", 'animation="spin"']
}
const mutation = process.env.AGENTMUX_SEND_RECEIPT_MUTATION
if (mutation && !changes[mutation]) throw new Error('Unknown send receipt mutation: ' + mutation)
export default defineConfig({ ...base, cacheDir: '.cache/conversation-send-receipts', plugins: [...base.plugins ?? [], {
  name: 'send-receipt-effective-source', enforce: 'pre', transform(source, id) {
    const path = relative(root, id.split('?')[0]!)
    if (path !== policy && path !== component) return
    const target = mutation === 'ignore-document-visibility' ? component : policy
    const replacement = mutation && path === target ? changes[mutation]! : undefined
    if (replacement && source.split(replacement[0]).length !== 2) throw new Error('Send receipt mutation anchor is not unique: ' + mutation)
    const code = replacement ? source.replace(...replacement) : source
    if (process.env.AGENTMUX_SEND_RECEIPT_LOADED) appendFileSync(process.env.AGENTMUX_SEND_RECEIPT_LOADED, JSON.stringify({ path, mutation: mutation ?? null,
      originalSHA256: createHash('sha256').update(source).digest('hex'), sha256: createHash('sha256').update(code).digest('hex') }) + '\n')
    return replacement ? { code, map: null } : undefined
  }
}], test: { ...base.test, include: ['apps/desktop/test/conversation-send-receipts.test.tsx',
  'apps/desktop/test/conversation-submission-presentation.test.tsx', 'apps/desktop/test/conversation-submission-reader.test.tsx'], passWithNoTests: false } })
