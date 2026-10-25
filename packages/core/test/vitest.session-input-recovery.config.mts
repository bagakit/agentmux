import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import base from './a2a-resumed-inbox.config.mts'
import mailbox from './vitest.input-mailbox.config.mts'

const root = resolve(import.meta.dirname, '../../..')
const mutation = process.env.AGENTMUX_SESSION_INPUT_MUTATION
const edits: Record<string, Array<{ path: string; before: string; after: string }>> = {
  'original-run': [{ path: 'packages/core/src/client.ts',
    before: 'const deliveryKey = { ...agentInputDeliveryKey(saved.control), expectedRun: { ...selected.run } } as AgentPromptInputKey',
    after: 'const deliveryKey = { ...agentInputDeliveryKey(saved.control), expectedRun: { ...key.expectedRun } } as AgentPromptInputKey' }],
  'unverified-target': [{ path: 'packages/core/src/client.ts',
    before: 'matchesProviderNativeSessionTarget(expected.nativeHandle, session.nativeHandle) &&\n      sessionSemanticResumeSourceRuns(session).includes(intent.key.expectedRun.runId)',
    after: 'true' }],
  'cold-authority': [
    { path: 'packages/core/src/client.ts',
      before: "if (!this.isRetainedHumanInput(saved.intent) || saved.intent.source.kind !== 'prompt' || saved.intent.source.recoveryAuthorization !== 'local-human') continue",
      after: 'if (!this.isRetainedHumanInput(saved.intent)) continue' },
    { path: 'packages/core/src/agent-global-message-queue.ts',
      before: "intent.source.authorHuman === true && intent.source.recoveryAuthorization === 'local-human' &&",
      after: 'intent.source.authorHuman === true &&' }
  ],
  'missing-delivery-binding': [{ path: 'packages/core/src/agent-global-message-queue.ts',
    before: "control: { ref, state: 'dispatch-authorized', gateId, ...(deliveryKey ? { deliveryKey } : {}), ...(current.control.retry ? { retry: current.control.retry } : {}), at: Date.now() }",
    after: "control: { ref, state: 'dispatch-authorized', gateId, ...(current.control.retry ? { retry: current.control.retry } : {}), at: Date.now() }" }],
  'late-target-release': [{ path: 'packages/core/src/client.ts',
    before: 'targetChanged ||= !sameRun(current.run, attemptRun)', after: 'targetChanged ||= false' }]
}
if (mutation && !edits[mutation]) throw new Error('Unknown Session input recovery source mutation: ' + mutation)
export default defineConfig({ ...base, plugins: [...(base.plugins ?? []), ...(mailbox.plugins ?? []), {
  name: 'session-input-recovery-source', enforce: 'pre', transform(source, id) {
    const path = relative(root, id.split('?')[0]!)
    let code = source
    for (const edit of mutation ? edits[mutation]! : []) {
      if (edit.path !== path) continue
      if (code.split(edit.before).length !== 2) throw new Error('Session input recovery mutation needs one exact source anchor: ' + path)
      code = code.replace(edit.before, edit.after)
    }
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    if (process.env.AGENTMUX_SESSION_INPUT_LOADED && path.startsWith('packages/') && !path.includes('/node_modules/'))
      appendFileSync(process.env.AGENTMUX_SESSION_INPUT_LOADED, JSON.stringify({ path,
        originalSHA256: hash(source), sha256: hash(code), ...(code === source ? {} : { mutation }) }) + '\n')
    if (code !== source) return { code, map: null }
  }
}], test: { ...base.test, include: ['packages/core/test/session-input-recovery.test.ts',
  ...(process.env.AGENTMUX_SESSION_INPUT_REGRESSION === '1' ? ['packages/core/test/current-terminal-input.test.ts',
    'packages/core/test/agent-input-mailbox.test.ts', 'packages/core/test/a2a-resumed-inbox.test.ts'] : [])], testTimeout: 10_000 } })
