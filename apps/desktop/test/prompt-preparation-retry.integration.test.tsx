// @vitest-environment happy-dom
import { act } from 'react'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore, type AgentSteerQueueEntry } from '../src/renderer/src/store'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client'
import { runCompiledObjectCli, objectCliEnvironment } from '../../../packages/core/test/helpers/object-cli-rpc'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const dom = composerDOM(), sid = 'agent-1', operationId = 'original-compact-message'
const condition = { expectedRun: { runId: 'run-agent-1' }, afterSubmissionId: null }
const original: AgentSteerQueueEntry = { operationId, text: 'Original body\nKeep every byte.', runId: 'run-agent-1',
  promptCondition: condition, execution: 'immediate', origin: 'manual', sourceChannel: 'message-tool', status: 'deferred', awaitingExplicitSend: true }
function refused(overrides: Record<string, unknown> = {}) {
  return Object.assign(new Error('The Agent is compacting its context; retry shortly.'), { code: 'AGENT_PROMPT_PREPARATION_FAILED',
    detail: JSON.stringify({ code: 'AGENT_INPUT_PREPARATION_UNCONFIRMED', detail: JSON.stringify({ preparationWait: {
      reason: 'context-compaction', retrySafe: true, agentSessionId: sid, runId: 'run-agent-1', operationId, inputByte: 20, nativeSourceId: 'native-source', ...overrides } }) }),
    controlFailure: { disposition: 'not_applied', confirmedInputBytes: 0 } })
}
const queue = () => useAppStore.getState().agentSteerQueues[sid] ?? []
let dispose: (() => void) | undefined
beforeAll(async () => { dispose = await useAppStore.getState().initialize() })
afterAll(() => dispose?.())
beforeEach(() => {
  const session = composerSession(); session.capabilities.promptExecution = { immediate: 'native-steer' }
  useAppStore.setState({ sessions: [session], agentSteerQueues: { [sid]: [structuredClone(original)] }, agentSteerInFlight: {}, agentSteerInFlightPhase: {},
    runtimeEndpointWarnings: [], timelines: { [sid]: { agentSessionId: sid, revision: 0, items: [] } } })
  vi.spyOn(api.sessions, 'refresh').mockResolvedValue(session)
  vi.spyOn(api.sessions, 'recordDeliveryFailure').mockImplementation(async record => ({ logId: record.logId, record,
    availability: 'found', persistence: 'confirmed', issue: null }))
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
})
afterEach(async () => { vi.unstubAllEnvs(); useAppStore.getState().cancelAgentSteerPreparation(sid, operationId); await vi.advanceTimersByTimeAsync(0); vi.useRealTimers() })
async function clock(ms = 0) { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }
const send = () => useAppStore.getState().sendQueuedAgentSteer(sid, operationId).then(() => null, error => error)

it('shows the compact wait in the actual Composer, then sends the original tuple once after 2 seconds', async () => {
  const submit = vi.spyOn(api.sessions, 'submitPrompt').mockRejectedValueOnce(refused()).mockResolvedValue(undefined)
  await dom.render(<AgentSessionComposer sessionId={sid} />)
  const pending = send(); await clock()
  expect(queue()[0]?.preparationWait).toMatchObject({ reason: 'context-compaction', state: 'waiting', attempt: 1, maxAttempts: 3 })
  expect(document.body.textContent).toContain('正在整理上下文'); expect(document.body.textContent).toContain('自动重试（1/3）')
  const store = useAppStore.getState(), messages = await store.executeControl({ schemaVersion: 5, requestId: 'read-progress', operation: 'message.pending.ls', agentSessionId: sid })
  expect(messages.operation).toBe('message.pending.ls')
  if (messages.operation === 'message.pending.ls') expect(messages.messages[0]?.preparationWait).toMatchObject({ attempt: 1, state: 'waiting' })
  await clock(1_999); expect(submit).toHaveBeenCalledTimes(1)
  await clock(1); expect(await pending).toBeNull()
  expect(submit).toHaveBeenCalledTimes(2)
  expect(submit.mock.calls[1]!.slice(0,4)).toEqual(submit.mock.calls[0]!.slice(0,4))
  expect(submit.mock.calls[1]![4]).toMatchObject({ execution: 'immediate', preparationRetry: { inputByte: 20, nativeSourceId: 'native-source' } })
  expect(queue()).toEqual([])
})

it('uses 2/4/8-second bounded waits, stops after three retries, and keeps manual Send available', async () => {
  const submit = vi.spyOn(api.sessions, 'submitPrompt').mockRejectedValue(refused())
  await dom.render(<AgentSessionComposer sessionId={sid} />)
  const pending = send(); await clock()
  for (const [delay, count] of [[2_000, 2], [4_000, 3], [8_000, 4]]) {
    await clock(delay! - 1); expect(submit).toHaveBeenCalledTimes(count! - 1)
    await clock(1); expect(submit).toHaveBeenCalledTimes(count!)
  }
  expect(await pending).toMatchObject({ code: 'AGENT_PROMPT_PREPARATION_FAILED' })
  expect(queue()[0]).toMatchObject({ ...original, preparationInputNotApplied: true, preparationWait: { state: 'exhausted', attempt: 3, maxAttempts: 3 } })
  expect(document.body.textContent).toContain('已完成 3 次退避重试')
  expect(useAppStore.getState().agentSteerInFlight[sid]).toBeUndefined()
  await clock(60_000); expect(submit).toHaveBeenCalledTimes(4)
})

it('stops the visible original wait with one click while preserving the original message', async () => {
  const submit = vi.spyOn(api.sessions, 'submitPrompt').mockRejectedValue(refused())
  await dom.render(<AgentSessionComposer sessionId={sid} />)
  const pending = send(); await clock()
  const stop = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '停止等待')
  expect(stop).toBeDefined(); await act(async () => stop!.click()); await clock()
  expect(await pending).toBeInstanceOf(Error)
  expect(queue()[0]).toMatchObject({ ...original, preparationWait: { state: 'stopped' } })
  await clock(60_000); expect(submit).toHaveBeenCalledTimes(1)
  expect(document.body.textContent).toContain('自动等待已停止')
})

it.each(['run', 'condition', 'body', 'interaction'] as const)('does not cross a changed %s while waiting', async changed => {
  const submit = vi.spyOn(api.sessions, 'submitPrompt').mockRejectedValue(refused()), pending = send(); await clock()
  const current = useAppStore.getState(), session = composerSession()
  if (changed === 'run') session.control.run.runId = 'replacement-run'
  if (changed === 'interaction') session.pendingInteraction = {} as typeof session.pendingInteraction
  useAppStore.setState({ sessions: [session], agentSteerQueues: { [sid]: queue().map(entry => ({ ...entry,
    ...(changed === 'condition' ? { promptCondition: { ...condition, afterSubmissionId: 'later-admission' } } : {}),
    ...(changed === 'body' ? { text: 'Different body' } : {}) })) } })
  await clock(2_000); expect(await pending).toBeInstanceOf(Error); expect(submit).toHaveBeenCalledTimes(1)
})

it('does not replay a logical operation with older input even if this invocation reports zero bytes', async () => {
  const submit = vi.spyOn(api.sessions, 'submitPrompt').mockRejectedValue(refused({ retrySafe: false }))
  const pending = send(); await clock(60_000); expect(await pending).toBeInstanceOf(Error)
  expect(submit).toHaveBeenCalledTimes(1); expect(queue()[0]?.preparationWait).toBeUndefined()
})

it('stops immediately when a later attempt reports unknown application and removes obsolete retry progress', async () => {
  const unknown = Object.assign(refused(), { controlFailure: { disposition: 'unknown', confirmedInputBytes: 3 } })
  const submit = vi.spyOn(api.sessions, 'submitPrompt').mockRejectedValueOnce(refused()).mockRejectedValue(unknown)
  const pending = send(); await clock(); await clock(2_000); expect(await pending).toBeInstanceOf(Error)
  expect(queue()[0]?.preparationWait).toBeUndefined(); expect(queue()[0]?.preparationInputNotApplied).toBeUndefined()
  await clock(60_000); expect(submit).toHaveBeenCalledTimes(2)
})


it('the actual compiled CLI and typed RPC expose the same visible backoff from the real queue owner', async () => {
  const submit = vi.spyOn(api.sessions, 'submitPrompt').mockRejectedValue(refused()), pending = send(); await clock()
  const root = await mkdtemp(join(tmpdir(), 'amx-preparation-progress-'))
  const server = new AgentMuxControlServer({ socketPath: join(root, 'control.sock'), execute: request => useAppStore.getState().executeControl(request) })
  let rpc: Awaited<ReturnType<typeof connectAgentMuxRpc>> | undefined
  try {
    await server.start(); rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
    const read = await rpc.call('message.pending.ls', { agentSessionId: sid })
    vi.stubEnv('AGENTMUX_TEST_OBJECT_CLI', resolve('packages/core/bin/agentmux'))
    const cli = await runCompiledObjectCli(['--endpoint', 'unix://' + server.path, 'message', 'pending', 'ls', '--session', sid], objectCliEnvironment(root))
    expect(cli.code, cli.stderr).toBe(0)
    const result = JSON.parse(cli.stdout).result
    expect(result.messages).toEqual(read.messages)
    expect(result.messages[0].preparationWait).toMatchObject({ reason: 'context-compaction', attempt: 1, maxAttempts: 3, state: 'waiting', nextAttemptAt: expect.any(Number) })
    expect(submit).toHaveBeenCalledTimes(1)
    if (process.env.AGENTMUX_T002_EVIDENCE) await writeFile(join(process.env.AGENTMUX_T002_EVIDENCE, 'retry-progress-public-consumer.json'), JSON.stringify({ read, cli }))
  } finally {
    useAppStore.getState().cancelAgentSteerPreparation(sid, operationId); await clock(); await pending
    await rpc?.dispose(); await server.stop(); await rm(root, { recursive: true, force: true })
  }
}, 20_000)

it.each(['rpc', 'cli'] as const)('the actual public %s stops only the selected live backoff and retains its original intent', async consumer => {
  const submit = vi.spyOn(api.sessions, 'submitPrompt').mockRejectedValue(refused()), pending = send(); await clock()
  const root = await mkdtemp(join(tmpdir(), 'amx-stop-backoff-'))
  const server = new AgentMuxControlServer({ socketPath: join(root, 'control.sock'), execute: request => useAppStore.getState().executeControl(request) })
  let rpc: Awaited<ReturnType<typeof connectAgentMuxRpc>> | undefined
  try {
    await server.start(); rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
    await expect(rpc.call('message.pending.stop', { agentSessionId: sid, pendingId: 'different-message' })).rejects.toBeInstanceOf(Error)
    await expect(rpc.call('message.pending.stop', { agentSessionId: 'different-session', pendingId: operationId })).rejects.toBeInstanceOf(Error)
    expect(queue()[0]?.preparationWait?.state).toBe('waiting'); expect(submit).toHaveBeenCalledTimes(1)
    vi.stubEnv('AGENTMUX_TEST_OBJECT_CLI', resolve('packages/core/bin/agentmux'))
    const cli = consumer === 'cli' ? await runCompiledObjectCli(['--endpoint', 'unix://' + server.path, 'message', 'pending', 'stop', '--session', sid, '--pending-id', operationId], objectCliEnvironment(root)) : null
    if (cli) expect(cli.code, cli.stderr).toBe(0)
    const stopped = cli ? JSON.parse(cli.stdout).result : await rpc.call('message.pending.stop', { agentSessionId: sid, pendingId: operationId })
    expect(stopped).toMatchObject({ agentSessionId: sid, changed: true, message: { pendingId: operationId, text: original.text, runId: original.runId, preparationWait: { state: 'stopped', nextAttemptAt: null } } })
    await clock(); expect(await pending).toBeInstanceOf(Error)
    const read = await rpc.call('message.pending.ls', { agentSessionId: sid })
    expect(read.messages[0]).toMatchObject({ pendingId: operationId, text: original.text, preparationWait: { state: 'stopped' } })
    expect(await rpc.call('message.pending.stop', { agentSessionId: sid, pendingId: operationId })).toMatchObject({ changed: false })
    await clock(60_000); expect(submit).toHaveBeenCalledTimes(1)
    expect(queue()[0]?.promptCondition).toEqual(condition)
    if (consumer === 'cli') {
      const help = await runCompiledObjectCli(['--help', 'message', 'pending', 'stop'], objectCliEnvironment(root))
      const skill = await runCompiledObjectCli(['--skill'], objectCliEnvironment(root))
      expect(help.code).toBe(0); expect(help.stdout).toContain('message pending stop'); expect(help.stdout).toContain('--pending-id')
      expect(skill.code).toBe(0); expect(skill.stdout).toContain('message pending stop')
      if (process.env.AGENTMUX_T004_EVIDENCE) await writeFile(join(process.env.AGENTMUX_T004_EVIDENCE, 'public-stop-consumer-T004.json'), JSON.stringify({ stopped, read, cli, help, skill }))
    }
  } finally {
    useAppStore.getState().cancelAgentSteerPreparation(sid, operationId); await clock(); await pending
    await rpc?.dispose(); await server.stop(); await rm(root, { recursive: true, force: true })
  }
}, 20_000)
