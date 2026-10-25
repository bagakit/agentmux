import { defineConfig } from 'vitest/config'
import { relative, resolve } from 'node:path'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import base from './vitest.input-mailbox.config.mts'

const root = resolve(import.meta.dirname, '../../..'), mutation = process.env.AGENTMUX_INPUT_RETRY_MUTATION
const edits: Record<string, { path: string; before: string; after: string }> = {
  'deny-recipient-retry': { path: 'packages/core/src/client.ts', before: "if ((prior || saved.control.state === 'dispatch-authorized') && !refused)", after: "if ((prior || saved.control.state === 'dispatch-authorized') && (!refused || recipientContinuation))" },
  'retry-unknown': { path: 'packages/core/src/client.ts', before: "const refused = prior && agentInputSubmissionStatus(saved.control, prior) === 'not-applied'", after: "const refused = prior && agentInputSubmissionStatus(saved.control, prior) !== 'waiting'" },
  'skip-predecessor-cas': { path: 'packages/core/src/agent-global-message-queue.ts', before: 'if (!await confirmNotApplied(previousKey, previousGateId))', after: 'if (false)' },
  'reuse-transport-identity': { path: 'packages/core/src/client.ts', before: 'operationId: agentPromptInputId(deliveryKey), expectedRun: deliveryKey.expectedRun', after: 'operationId: agentPromptInputId(key), expectedRun: deliveryKey.expectedRun' },
  'skip-authority': { path: 'packages/core/src/client.ts', before: "if (envelope.sender.kind === 'external') authority = await this.externalMessageAuthority(envelope, context, intent.admissionIntent)", after: "if (envelope.sender.kind === 'external') authority = { externalAuthor: envelope.sender, assertCurrent: async () => {} }" },
  'deny-external-resume': { path: 'packages/core/src/client.ts', before: 'Boolean(recipientContinuation || authority?.externalAuthor)', after: 'Boolean(recipientContinuation)' }
}
if (mutation && !edits[mutation]) throw new Error('Unknown controlled input retry mutation: ' + mutation)
export default defineConfig({ ...base, cacheDir: resolve(root, '.cache/controlled-input-retry', mutation ?? 'positive'),
  plugins: [...(base.plugins ?? []), { name: 'controlled-input-retry-source', enforce: 'pre', transform(source, id) {
    const path = relative(root, id.split('?')[0]!), edit = mutation ? edits[mutation] : undefined
    let code = source
    if (edit?.path === path) {
      if (source.split(edit.before).length !== 2) throw new Error('Retry mutation requires one exact source anchor: ' + path)
      code = source.replace(edit.before, edit.after)
    }
    if (process.env.AGENTMUX_INPUT_RETRY_LOADED && path.startsWith('packages/core/src/')) {
      const sha = (value: string) => createHash('sha256').update(value).digest('hex')
      appendFileSync(process.env.AGENTMUX_INPUT_RETRY_LOADED, JSON.stringify({ path, originalSHA256: sha(source), sha256: sha(code), ...(code !== source ? { mutation } : {}) }) + '\n')
    }
    if (code !== source) return { code, map: null }
  } }], test: { ...base.test, include: ['packages/core/test/controlled-input-retry.test.ts'], testTimeout: 20_000, hookTimeout: 20_000 } })
