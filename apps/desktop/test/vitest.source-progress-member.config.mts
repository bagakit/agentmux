import { defineConfig } from 'vitest/config'
import { relative } from 'node:path'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import source from './vitest.mote-context.config.mts'
const mutations: Record<string, [string, string, string]> = {
  'core-ack-authority': ['packages/core/src/space-member-runtime.ts', 'if (!isSpaceMemberNativeWrite(method)) await assertCurrent()', 'await assertCurrent()'],
  'surface-ack-cancel': ['apps/desktop/src/main/space-member-surface.ts', 'if (!spaceMountMemberCallHasReceipt(method)) requestSignal?.throwIfAborted()', 'requestSignal?.throwIfAborted()'],
  'main-ack-tail': ['apps/desktop/src/main/space-mount-ipc.ts', 'if (spaceMountMemberCallHasReceipt(original)) obtained = result', 'if (false) obtained = result'],
  'renderer-ack-tail': ['apps/desktop/src/renderer/src/lib/space-mount-api.ts', 'if (!spaceMountMemberCallHasReceipt(method)) requestSignal?.throwIfAborted()', 'requestSignal?.throwIfAborted()'],
  'carrier-ack-tail': ['apps/desktop/src/main/space-member-surface.ts', 'const rpc = isSpaceMemberNativeWrite(method) ? ports.retainedRpc ?? ports.rpc : ports.rpc', 'const rpc = ports.rpc'],
  'drop-original-progress': ['apps/desktop/src/renderer/src/components/AgentSessionComposer.tsx', 'originalProgress={!readOnly ? source?.originalProgress : undefined}', 'originalProgress={undefined}'],
  'drop-original-image': ['apps/desktop/src/renderer/src/components/AgentSessionComposer.tsx', 'retainImage: source.retainImage ?? originalImageRetentionUnavailable', 'retainImage: originalImageRetentionUnavailable'],
  'drop-original-image-scope': ['apps/desktop/src/renderer/src/components/AgentSessionComposer.tsx', '...(source ? [source.target] : [])', '...[]'],
  'drop-original-mail': ['apps/desktop/src/renderer/src/components/AgentSessionComposer.tsx', 'originalMail={source?.originalMail}', 'originalMail={undefined}'],
  'mail-window-identity': ['apps/desktop/src/renderer/src/lib/use-session-messages.ts', '...(reading ? [reading.identity] : [])', '...[]'],
  'mail-detail-identity': ['apps/desktop/src/renderer/src/components/MailboxA2A.tsx', '...(props.readingIdentity ? [props.readingIdentity] : [])', '...[]'],
  'mail-receipt-runtime': ['apps/desktop/src/renderer/src/components/SessionMailbox.tsx', "originalMail ? JSON.stringify([originalMail.runtimeId, originalMail.reference.agentSessionId]) : mailboxSessionId ?? ''", "mailboxSessionId ?? ''"],
  'collapse-same-sid-mail': ['apps/desktop/src/renderer/src/components/SessionMailbox.tsx', 'Boolean(item.envelope.senderRuntimeId && item.envelope.recipientRuntimeId && item.envelope.senderRuntimeId !== item.envelope.recipientRuntimeId)', 'false'],
  'mail-admission-identity': ['apps/desktop/src/renderer/src/lib/source-member-tools.ts', 'identity: JSON.stringify(member), runtimeId: member.target.runtimeId,', 'identity: JSON.stringify([member.target.runtimeId, member.target.agentSessionId]), runtimeId: member.target.runtimeId,'],
  'mail-dispatch-key': ['apps/desktop/src/renderer/src/components/SessionMailbox.tsx', '<MailboxCollaboration key={scope}', '<MailboxCollaboration key="unqualified-mail-collaboration"'],
}
const mutation = process.env.AGENTMUX_SOURCE_MEMBER_MUTATION
if (mutation) assert.ok(mutations[mutation], 'Known original member receipt mutation')
export default defineConfig({ ...source, plugins: [{ name: 'actual-original-member-receipt-mutation', enforce: 'pre', transform(original, id) {
  const path = relative(source.root!, id.split('?')[0]!)
  if (!Object.values(mutations).some(([target]) => target === path)) return
  let code = original
  if (mutation) { const [target, from, to] = mutations[mutation]!; if (path === target) { assert.equal(code.split(from).length - 1, 1, 'Unique actual production mutation anchor'); code = code.replace(from, to) } }
  if (process.env.AGENTMUX_SOURCE_MEMBER_LOADED) appendFileSync(process.env.AGENTMUX_SOURCE_MEMBER_LOADED, JSON.stringify({ path, originalSHA256: createHash('sha256').update(original).digest('hex'), loadedSHA256: createHash('sha256').update(code).digest('hex'), mutation: code !== original ? mutation : null }) + '\n')
  if (code !== original) return { code, map: null }
} }], test: { ...source.test, include: ['apps/desktop/test/source-progress-member.test.tsx', 'apps/desktop/test/source-native-tools-composer.test.tsx', 'apps/desktop/test/source-native-mail-composer.test.tsx'], setupFiles: [], globalSetup: [], passWithNoTests: false, maxWorkers: 1, fileParallelism: false, testTimeout: 30000 } })
