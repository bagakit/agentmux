import { connectLocalAgentMux, AgentMuxFileAgentSessionStore } from '@agentmux/core'

const [mode, workspacePath, storePath, fakeCli, retainedRunId] = process.argv.slice(2)
const client = await connectLocalAgentMux({ store: new AgentMuxFileAgentSessionStore(storePath) })
const wait = async (predicate) => {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('Timed out waiting for retained Agent completion')
}
try {
  const session = mode === 'create' ? await client.createAgent({
    agentSessionId: 'retained-agent', providerId: 'codex', executorId: 'codex', workspacePath,
    commandOverride: process.execPath, args: [fakeCli], prompt: 'initial task',
    env: { AGENTMUX_FAKE_READY_MODE: 'before-delayed', AGENTMUX_FAKE_PROMPT_RENDER_MODE: 'normal' }
  }) : client.agentSession('retained-agent')
  let continuity
  if (mode !== 'create') continuity = await client.ensureAgentContinuity({
    agentSessionId: session.agentSessionId, expectedRun: { runId: retainedRunId }, operationId: 'reattach-original'
  })
  const attachment = mode === 'create' ? undefined : await client.reattachAgent(session.agentSessionId, 0)
  if (mode === 'create') await wait(() => client.agentSession(session.agentSessionId).semanticStatus?.state === 'done')
  const before = await client.statusAgent(session.agentSessionId)
  // The second process retries precisely the same durable transaction.
  await client.submitAgentPrompt({ agentSessionId: session.agentSessionId,
    operationId: 'retained-message', prompt: 'retained message' })
  if (mode === 'create') await wait(() => client.agentSession(session.agentSessionId).semanticStatus?.state === 'done' &&
    client.agentSession(session.agentSessionId).semanticStatus.observedAt !== before.session.semanticStatus?.observedAt)
  const status = await client.statusAgent(session.agentSessionId)
  process.stdout.write(`${JSON.stringify({ clientPid: process.pid, daemonInstance: client.runtimeIdentity().instanceId,
    continuity: continuity?.kind, attachedRunId: attachment?.attachment.run.runId,
    session: status.session, run: status.run,
    acceptedBefore: before.run.acceptedInputBytes, acceptedAfter: status.run.acceptedInputBytes })}\n`)
} finally {
  await client.dispose()
}
