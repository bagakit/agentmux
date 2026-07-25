import {
  AgentMuxFileAgentSessionStore,
  connectLocalAgentMux
} from '@agentmux/core'

const fakeCodex = process.env.AGENTMUX_FAKE_CODEX
if (!fakeCodex) throw new Error('AGENTMUX_FAKE_CODEX is required')

const base = new AgentMuxFileAgentSessionStore()
let client
let crashArmed = false
const store = {
  async load() { return await base.load() },
  async loadRetiredRuns() { return await base.loadRetiredRuns() },
  async loadRetiredAgentSessions() { return await base.loadRetiredAgentSessions() },
  async compareAndSwap(expected, next) {
    const before = expected?.pendingInteraction?.response
    const after = next?.pendingInteraction?.response
    const acknowledgement = (
      crashArmed &&
      before?.acknowledged === false &&
      after?.acknowledged === true
    )
    if (acknowledgement) {
      for (let attempt = 0; attempt < 400; attempt += 1) {
        const status = await client.statusAgent(next.agentSessionId)
        if (status.run.state !== 'running') {
          await new Promise(() => {
            process.stdout.write(`${JSON.stringify({
              type: 'interaction-input-applied-before-store-ack',
              agentSessionId: next.agentSessionId,
              runId: next.run.runId,
              inputByteRange: after.inputByteRange
            })}\n`, () => process.exit(94))
          })
        }
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      throw new Error('Timed out waiting for the Agent Run to exit after its interaction response')
    }
    await base.compareAndSwap(expected, next)
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

client = await connectLocalAgentMux({ store })
const session = await client.createAgent({
  agentSessionId: 'codex-interaction-response-crash',
  createOperationId: 'packed-interaction-response-crash-create',
  providerId: 'codex',
  executorId: 'codex',
  workspacePath: process.cwd(),
  commandOverride: fakeCodex,
  env: {
    AGENTMUX_FAKE_PERMISSION_REQUEST: '1',
    AGENTMUX_FAKE_EXIT_AFTER_PERMISSION: '1'
  }
})

let request
for (let attempt = 0; attempt < 400; attempt += 1) {
  request = client.agentSession(session.agentSessionId).pendingInteraction?.request
  if (request) break
  await new Promise((resolve) => setTimeout(resolve, 10))
}
if (!request || request.kind !== 'permission') {
  throw new Error('Timed out waiting for the typed permission request')
}

crashArmed = true
await client.respondAgentInteraction({
  agentSessionId: session.agentSessionId,
  expectedRun: session.run,
  response: {
    kind: 'permission',
    requestId: request.id,
    decision: { outcome: 'selected', optionId: 'allow-once' }
  }
})
throw new Error('Interaction response unexpectedly survived the crash checkpoint')
