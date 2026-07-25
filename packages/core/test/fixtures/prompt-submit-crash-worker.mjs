import {
  AgentMuxFileAgentSessionStore,
  connectLocalAgentMux
} from '@agentmux/core'

const fakeCodex = process.env.AGENTMUX_FAKE_CODEX
if (!fakeCodex) throw new Error('AGENTMUX_FAKE_CODEX is required')
const crashPoint = process.env.AGENTMUX_PROMPT_CRASH_POINT ?? 'after-store-ack'
if (
  crashPoint !== 'before-store-ack' &&
  crashPoint !== 'after-store-ack' &&
  crashPoint !== 'submit-before-store-ack'
) {
  throw new Error(`Unknown prompt crash point: ${crashPoint}`)
}
const beforePayloadStoreAck = crashPoint === 'before-store-ack'
const beforeSubmitStoreAck = crashPoint === 'submit-before-store-ack'
const agentSessionId = beforePayloadStoreAck
  ? 'codex-prompt-before-payload-ack-crash'
  : beforeSubmitStoreAck
    ? 'codex-prompt-before-submit-ack-crash'
    : 'codex-prompt-crash'
const submissionId = `packed-${agentSessionId}-operation`

const crash = async (next, submission, phase) => {
  const type = phase === 'submit'
    ? 'prompt-submit-applied-before-store-ack'
    : beforePayloadStoreAck
      ? 'prompt-payload-applied-before-store-ack'
      : 'prompt-payload-acknowledged-before-submit'
  const exitCode = phase === 'submit' ? 93 : beforePayloadStoreAck ? 92 : 91
  await new Promise(() => {
    process.stdout.write(`${JSON.stringify({
      type,
      agentSessionId: next.agentSessionId,
      runId: next.run.runId,
      operationId: submission.submissionId,
      payloadRange: submission.payload.inputByteRange,
      submitRange: submission.submit.inputByteRange
    })}\n`, () => process.exit(exitCode))
  })
}

const base = new AgentMuxFileAgentSessionStore()
let crashArmed = false
const store = {
  async load() { return await base.load() },
  async loadRetiredRuns() { return await base.loadRetiredRuns() },
  async loadRetiredAgentSessions() { return await base.loadRetiredAgentSessions() },
  async compareAndSwap(expected, next) {
    const submission = next?.terminalPromptSubmission
    const payloadAcknowledgement = (
      crashArmed &&
      submission?.submissionId === submissionId &&
      !expected?.terminalPromptSubmission?.payload.acknowledged &&
      submission.payload.acknowledged &&
      !submission.submit.acknowledged
    )
    const submitAcknowledgement = (
      crashArmed &&
      submission?.submissionId === submissionId &&
      !expected?.terminalPromptSubmission?.submit.acknowledged &&
      submission.submit.acknowledged
    )
    if (payloadAcknowledgement && beforePayloadStoreAck) {
      await crash(next, submission, 'payload')
    }
    if (submitAcknowledgement && beforeSubmitStoreAck) {
      await crash(next, submission, 'submit')
    }
    await base.compareAndSwap(expected, next)
    if (payloadAcknowledgement && !beforePayloadStoreAck && !beforeSubmitStoreAck) {
      await crash(next, submission, 'payload')
    }
  },
  async reserveLifecycle(value) { await base.reserveLifecycle(value) },
  async claimStaleLifecycles(value) { return await base.claimStaleLifecycles(value) },
  async releaseLifecycle(value, retiredRuns) { await base.releaseLifecycle(value, retiredRuns) },
  async retireRuns(runs) { await base.retireRuns(runs) },
  async commitLifecycle(value, next) { await base.commitLifecycle(value, next) },
  async loadTimeline(agentSessionId) { return await base.loadTimeline(agentSessionId) },
  async applyTimelineMutation(mutation, signal) {
    return await base.applyTimelineMutation(mutation, signal)
  }
}

const client = await connectLocalAgentMux({ store })
const session = await client.createAgent({
  agentSessionId,
  createOperationId: `packed-${agentSessionId}-create`,
  providerId: 'codex',
  executorId: 'codex',
  workspacePath: process.cwd(),
  commandOverride: fakeCodex,
  env: { AGENTMUX_FAKE_READY_MODE: 'stop-after-payload' }
})
for (let attempt = 0; attempt < 400; attempt += 1) {
  const replay = await client.readRunReplay(session.run, 0)
  if (replay.replay.some((event) => event.data.includes('codex-controlled-ready-pending'))) break
  if (attempt === 399) throw new Error('Timed out waiting for controlled initial composer')
  await new Promise((resolve) => setTimeout(resolve, 20))
}
await client.writeAgent(session.agentSessionId, '\u001d')
if (client.agentSession(session.agentSessionId).terminalPromptReadiness?.readyThroughByte === undefined) {
  await new Promise((resolve) => {
    const unsubscribe = client.onEvent((event) => {
      if (
        event.type === 'agent-session' &&
        event.session.agentSessionId === session.agentSessionId &&
        event.session.terminalPromptReadiness?.readyThroughByte !== undefined
      ) {
        unsubscribe()
        resolve()
      }
    })
    if (
      client.agentSession(session.agentSessionId)
        .terminalPromptReadiness?.readyThroughByte !== undefined
    ) {
      unsubscribe()
      resolve()
    }
  })
}
crashArmed = true
await client.submitAgentPrompt({
  agentSessionId: session.agentSessionId,
  operationId: submissionId,
  prompt: 'crash-between-phases'
})
throw new Error('Prompt submission unexpectedly survived the crash checkpoint')
