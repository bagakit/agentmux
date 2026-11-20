import assert from 'node:assert/strict'
import { join } from 'node:path'

function toolResult(model, id, matches) {
  return model.modelRequests.some(({ body }) => body.messages?.some(message => Array.isArray(message.content) &&
    message.content.some(value => value.type === 'tool_result' && value.tool_use_id === id && matches(value))))
}

async function frontendFrames(agent, runId) {
  const replay = await agent.client.readRunReplay({ runId }, 0, 'raw')
  assert.equal(replay.gap, null); assert.equal(replay.run.runId, runId)
  const text = Buffer.concat(replay.replay.map(chunk => Buffer.from(chunk.dataBytes))).toString()
  const frames = text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(line => JSON.parse(line))
  return { run: replay.run, frames }
}

/** One real provider-side proof. The private harness controls fault injection;
 * Core and the native client own every business action and observed result. */
export async function verifyClaudeProjectRecovery({ agent, resource, model, helpers, workspace, agentSessionId, bindingId,
  readResource, restartProject, wait }) {
  const effects = join(workspace, 'effect-count.txt')
  await wait(async () => await readResource(effects).catch(() => null) === 'once\n',
    'The old tool committed a physical effect before its original response')
  const beforeAgent = await agent.client.statusAgent(agentSessionId)
  const before = await frontendFrames(agent, helpers.frontend.runId)
  assert.equal(beforeAgent.run.state, 'running')
  const oldProject = resource.client.runtimeIdentity(), durableProject = resource.client.runtimeOwnerIdentity().runtimeId
  const oldHelper = await resource.client.runtimeSubject({ kind: 'terminal-run', runId: helpers.executor.runId })
  assert.equal(oldHelper.run.workspacePath, workspace)
  assert.equal(oldHelper.run.state, 'running')
  assert(Number.isInteger(oldHelper.run.pid) && oldHelper.run.pid > 1)
  const effect = before.frames.filter(frame => frame.payload?.params?.arguments?.command === model.steps[0].input.command)
  assert.equal(effect.length, 1)
  const key = { bindingId, streamGeneration: effect[0].generation, nativeRequestId: effect[0].payload.id }
  const oldOperation = await resource.client.inspectAgentExecutionOperation(key)
  assert.equal(oldOperation?.phase, 'dispatched')
  assert.equal(oldOperation?.outcome, 'unknown')
  const replacement = await restartProject(oldHelper.run)
  assert.notEqual(replacement.previousNativePid, replacement.currentNativePid)
  assert.notEqual(resource.client.runtimeIdentity().instanceId, oldProject.instanceId)
  assert.equal(resource.client.runtimeOwnerIdentity().runtimeId, durableProject)
  let successor
  await wait(async () => {
    successor = (await resource.rpc.call('agent.execution.binding', { bindingId }))?.helperStarts
    return successor?.executor.outcome === 'confirmed' && successor.executor.runId !== helpers.executor.runId
  }, 'Automatic original project helper replacement')
  const current = await agent.client.statusAgent(agentSessionId)
  assert.equal(current.run.pid, beforeAgent.run.pid); assert.equal(current.run.runId, beforeAgent.run.runId)
  const frontend = await frontendFrames(agent, helpers.frontend.runId)
  assert.equal(frontend.run.pid, before.run.pid); assert.equal(successor.frontend.runId, helpers.frontend.runId)
  assert.deepEqual(await resource.client.inspectAgentExecutionOperation(key), oldOperation)
  await wait(() => toolResult(model, model.steps[0].id, value =>
    value.is_error === true && JSON.stringify(value.content).includes('previous tool outcome is unconfirmed')),
  'Original Claude left the old tool wait with an explicit unknown outcome')
  model.releaseFirstAnswer()
  await wait(() => toolResult(model, model.steps[1].id, value => value.is_error !== true && JSON.stringify(value.content).includes('once')),
    'Same Claude client consumed the recovered real file read')
  await wait(async () => (await resource.rpc.call('agent.execution.binding', { bindingId })).state === 'connected', 'Confirmed recovered native result')
  const after = await frontendFrames(agent, helpers.frontend.runId)
  const read = after.frames.filter(frame => frame.payload?.method === 'tools/call' && frame.payload?.params?.arguments?.file_path === effects)
  assert.equal(read.length, 1); assert.equal(read[0].generation, effect[0].generation)
  assert.equal(after.frames.filter(frame => frame.payload?.method === 'initialize').length, 1, 'The same CLI socket never reinitialized')
  assert.equal(await readResource(effects), 'once\n')
  return { originalAgentRunId: beforeAgent.run.runId, originalAgentPid: beforeAgent.run.pid, originalFrontendPid: before.run.pid,
    originalGeneration: effect[0].generation, resourceInstanceChanged: true, originalEffectCount: 1, oldOutcomeUnknown: true, oldOperation,
    originalWaitSettled: true, freshNativeFileRead: true }
}
