import {
  AgentMuxFileAgentSessionStore,
  connectLocalAgentMux
} from '@agentmux/core'

const fakeCodex = process.env.AGENTMUX_FAKE_CODEX
if (!fakeCodex) throw new Error('AGENTMUX_FAKE_CODEX is required')

const base = new AgentMuxFileAgentSessionStore()
let crashArmed = false
const store = {
  async load() { return await base.load() },
  async loadRetiredRuns() { return await base.loadRetiredRuns() },
  async compareAndSwap(expected, next) {
    await base.compareAndSwap(expected, next)
    const submission = next?.terminalPromptSubmission
    if (
      crashArmed &&
      submission?.submissionId === 'packed-prompt-crash-operation' &&
      submission.payload.acknowledged &&
      !submission.submit.acknowledged
    ) {
      await new Promise(() => {
        process.stdout.write(`${JSON.stringify({
          type: 'prompt-payload-acknowledged-before-submit',
          agentSessionId: next.agentSessionId,
          runId: next.run.runId,
          payloadRange: submission.payload.inputByteRange,
          submitRange: submission.submit.inputByteRange
        })}\n`, () => process.exit(91))
      })
    }
  },
  async reserveLifecycle(value) { await base.reserveLifecycle(value) },
  async claimStaleLifecycles(value) { return await base.claimStaleLifecycles(value) },
  async releaseLifecycle(value, retiredRuns) { await base.releaseLifecycle(value, retiredRuns) },
  async retireRuns(runs) { await base.retireRuns(runs) },
  async commitLifecycle(value, next) { await base.commitLifecycle(value, next) }
}

const client = await connectLocalAgentMux({ store })
const session = await client.createAgent({
  agentSessionId: 'codex-prompt-crash',
  createOperationId: 'packed-prompt-crash-create',
  agentId: 'codex',
  workspacePath: process.cwd(),
  commandOverride: fakeCodex
})
if (client.agentSession(session.agentSessionId).terminalStopReceipt?.readyThroughByte === undefined) {
  await new Promise((resolve) => {
    const unsubscribe = client.onEvent((event) => {
      if (
        event.type === 'agent-session' &&
        event.session.agentSessionId === session.agentSessionId &&
        event.session.terminalStopReceipt?.readyThroughByte !== undefined
      ) {
        unsubscribe()
        resolve()
      }
    })
  })
}
crashArmed = true
await client.submitAgentPrompt({
  agentSessionId: session.agentSessionId,
  operationId: 'packed-prompt-crash-operation',
  prompt: 'crash-between-phases'
})
throw new Error('Prompt submission unexpectedly survived the crash checkpoint')
