const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

import { AGENTMUX_CONTROL_SCHEMA_VERSION, AgentMuxClient, AgentMuxControlServer, AgentMuxFileAgentSessionStore, DurableAgentMuxMessageQueue, connectAgentMuxRpc, hashAgentCapability, issueAgentCapability, type AgentMuxControlRequest, type AgentMuxControlResult, type AgentMuxStoredAgentSession } from '@agentmux/core'
import type { AppConfig, SessionSnapshot } from '../src/shared/contracts.js'
import { api } from '../src/renderer/src/lib/api.js'
import { createWorkspaceLayout } from '@agentmux/layout'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs.js'
import { workspaceProjectId } from '../src/renderer/src/lib/workspace-projects.js'
import { executorDetectionKey, useAppStore } from '../src/renderer/src/store.js'

const exec = promisify(execFile)
// packages/core/bin/amux — the real CLI entry the CLI attribution test also uses.
const cli = fileURLToPath(new URL('../../../packages/core/bin/amux', import.meta.url))

async function assertNoPrivateRuntime(runtime: string): Promise<void> {
  const owned = async () => (await exec('/bin/ps', ['-axo', 'pid=,command='])).stdout.split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(.+)$/u.exec(line)
    return match && match[2]!.includes('/ctxmuxd ') &&
      match[2]!.includes('--socket ' + join(runtime, 'ctxmux.sock') + ' ') &&
      match[2]!.includes('--state-dir ' + join(runtime, 'state', 'ctxmux') + ' ') ? [Number(match[1])] : []
  })
  // The public service borrows the controlled original Core below. Merely exercising
  // the transport must not launch a default Runtime or any Agent process.
  expect(await owned()).toEqual([])
}

const initialState = useAppStore.getState()

const config: AppConfig = {
  version: 9,
  hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  executors: {
    codex: { label: 'Codex', providerId: 'codex', command: 'codex', args: [], env: {}, injectAgentMuxGuide: true }
  },
  workspaces: [{ id: 'workspace', name: 'Project', hostId: 'local', path: _hygiene_fixturePath("repo"), kind: 'folder' }],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }
}

function agent(id: string): Extract<SessionSnapshot, { kind: 'agent' }> {
  return {
    id,
    kind: 'agent', providerId: 'codex', executorId: 'codex',
    capabilities: { terminal: true, timeline: 'streaming', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
    hostId: 'local', workspacePath: _hygiene_fixturePath("repo"), label: id,
    createdAt: 1, updatedAt: 1, agentSessionUpdatedAt: 1, promptSubmissionPredecessor: null, processState: 'running',
    status: { state: 'running', source: 'run-process', observedAt: 1 },
    latestOutputBytes: 0,
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: `run-${id}` } }
  }
}

function seedStore(recipientId: string) {
  const caller = agent('caller-cli')
  const recipient = agent(recipientId)
  const tab = createWorkbenchTab('tab-recipient', {
    regionId: 'region-recipient', kind: 'agent', phase: 'attached', workspaceId: 'workspace', sessionId: recipient.id
  })
  useAppStore.setState({
    config,
    sessions: [caller, recipient],
    activeWorkspaceId: 'workspace',
    mainSurface: 'workbench',
    tabs: { [tab.id]: tab },
    layouts: { workspace: createWorkspaceLayout('group', [tab.id]) },
    pendingAgentLaunches: {},
    executorDetections: {
      [executorDetectionKey('local', 'codex')]: {
        state: 'ready',
        result: { input: { executorId: 'codex', providerId: 'codex', command: 'codex', host: config.hosts[0]! }, executable: 'codex', availability: 'available' }
      }
    },
    error: null
  })
  return { recipient, tab }
}

async function seedCoreSessionStore(path: string): Promise<{ readonly capability: string }> {
  const capability = issueAgentCapability()
  const now = Date.now()
  const make = (agentSessionId: string, runId: string, withCapability = false): AgentMuxStoredAgentSession => ({
    kind: 'agent', agentSessionId, providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath: _hygiene_fixturePath("repo"),
    run: { runId }, retiredRuns: [], hookBindingId: `hook-${agentSessionId}`, hookToken: `token-${agentSessionId}`,
    ...(withCapability ? { capabilityHash: hashAgentCapability(capability) } : {}),  createdAt: now, updatedAt: now
  })
  const store = new AgentMuxFileAgentSessionStore(path)
  await store.compareAndSwap(null, make('caller-cli', 'run-caller-cli', true))
  await store.compareAndSwap(null, make('mailbox-recipient', 'run-mailbox-recipient'))
  return { capability }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  useAppStore.setState(initialState, true)
})

// Real object CLI → public JSON-RPC → production store executor → submitPrompt.
// Machine identities remain in the submit/receipt channel; the prompt is a readable source
// followed by the original body. Replacing the store projection with request.text is red.
it('CLI send reaches production submitPrompt with readable source, unchanged body and separate durable receipt', async () => {
  const runtime = await mkdtemp(_hygiene_fixturePath("tmp/amux-a2a-integrated-"))
  const queuePath = join(runtime, 'state', 'global-messages.ndjson')
  const sessionStorePath = join(runtime, 'state', 'agent-sessions.json')
  const sock = join(runtime, 'control.sock')

  const { recipient } = seedStore('mailbox-recipient')
  const { capability } = await seedCoreSessionStore(sessionStorePath)
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', queuePath)
  vi.stubEnv('AGENTMUX_AGENT_SESSION_STORE', sessionStorePath)
  const submit = vi.spyOn(api.sessions, 'submitMessage')
  vi.spyOn(api.sessions, 'refresh').mockImplementation(async control => {
    if (control.kind !== 'agent') throw new Error('Private fixture refresh requires an Agent Session')
    const session = useAppStore.getState().sessions.find(item => item.id === control.agentSessionId)
    if (!session) throw new Error('Private Session is missing')
    return session
  })

  const core = new AgentMuxClient({ store: new AgentMuxFileAgentSessionStore(sessionStorePath) })
  const inner = core as unknown as { connected: boolean; registry: { load(host: string): Promise<void> }; kernel: Record<string, unknown>; promptSubmission: { submitInputPlan: unknown } }
  await inner.registry.load('local'); inner.connected = true; inner.kernel.isConnected = () => true
  inner.kernel.status = async (runId: string) => ({ runId, state: { type: 'running' }, workspacePath: _hygiene_fixturePath("repo"), pid: 123, acceptedInputBytes: 0, latestOutputBytes: 0 })
  const physicalInput = vi.fn(async (..._args: unknown[]) => {})
  inner.promptSubmission.submitInputPlan = physicalInput
  submit.mockImplementation(async (control, input) => await core.submitAgentMessage({ ...input, agentSessionId: control.agentSessionId }))

  // The real service borrows the same original Core that owns admission and input.
  // It must not silently open another default Runtime while authenticating this fixture.
  const server = new AgentMuxControlServer({
    coreClients: () => [{ hostId: 'local', client: core }],
    execute: async (request: AgentMuxControlRequest): Promise<AgentMuxControlResult> => {
      return await useAppStore.getState().executeControl(request)
    }
  }, sock)
  await server.start()
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: sock },
    credentials: { agentSessionId: 'caller-cli', capability } })

  try {
    // 真 CLI 走 agent send 到这个私有 endpoint；身份由同一 Core 核验 SID + capability。
    //    timeout=15000 而非 5000：CLI 子进程 + fs + sock 握手 + queue append + store executeControl 一整套，
    //    在忙碌 CI 机上 5s 会 flake。见 MINOR-4 (review prior observation)。
    const stdout = await exec(cli, ['--endpoint', `unix:${sock}`, 'agent', 'send', '--to-session', recipient.id, '--text', 'integrated body bytes'], {
      timeout: 15000,
      env: {
        ...process.env,
        AGENTMUX_RUNTIME_DIRECTORY: runtime, AGENTMUX_STATE_DIRECTORY: join(runtime, 'state'),
        AGENTMUX_MESSAGE_QUEUE_PATH: queuePath,
        AGENTMUX_AGENT_SESSION_STORE: sessionStorePath,
        AGENTMUX_AGENT_SESSION_ID: 'caller-cli',
        AGENTMUX_AGENT_CAPABILITY: capability
      }
    }).then((r) => JSON.parse(r.stdout) as Record<string, unknown>)

    const cliMessageId = (stdout.result as Record<string, unknown>).messageId as string
    expect(cliMessageId, 'CLI 必须回 messageId').toEqual(expect.any(String))

    expect(submit).toHaveBeenCalledTimes(1)
    const [, submittedMessage] = submit.mock.calls[0]!
    const submittedPrompt = physicalInput.mock.calls[0]![3]
    const submittedMessageId = submittedMessage.envelope.messageId
    expect(submittedMessageId).toBe(cliMessageId)
    expect(submittedPrompt).toBe('[Message from Agent caller-cli]\nintegrated body bytes')

    // 3) 双向 verify：queue 落盘的 envelope 与 CLI stdout messageId 一致，说明 sock 与 durable
    //    队列同源、没有编造。**恰好** 1 条 message record——多写一次就红，钉住 append 只走了一次。
    const queue = new DurableAgentMuxMessageQueue(queuePath)
    const records = await queue.listAfter(0)
    const messages = records.filter((r) => r.envelope.messageId === cliMessageId)
    expect(messages, 'CLI 只 append 一次，queue 里恰好一条同 messageId 的记录').toHaveLength(1)

    // Recipient identity remains bound to the current Run outside the readable prompt.
    const cliMessage = messages[0]!.envelope
    // Public RPC rejects caller-supplied envelopes. The original Core also rejects
    // a sender label that differs from the authorized sender before physical input.
    const forged = {
      target: { kind: 'agent-session' as const, agentSessionId: recipient.id }, text: cliMessage.body,
      operationId: 'forged-public-source-label',
      message: { ...cliMessage, messageId: 'forged-public-source-label-message', sender: { kind: 'agent-session', agentSessionId: 'different-agent' } }
    }
    await expect(rpc.call('agent.send', forged)).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
    await expect(core.submitAgentMessage({ ...submittedMessage, agentSessionId: recipient.id,
      envelope: { ...cliMessage, messageId: 'forged-source-label-message', sender: { kind: 'agent-session', agentSessionId: 'different-agent' } }
    })).rejects.toMatchObject({ code: 'MESSAGE_SENDER_MISMATCH' })
    expect(submit).toHaveBeenCalledTimes(1)
    const badRunId = 'run-not-the-recipient'
    await expect(useAppStore.getState().executeControl({
      schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId: 'control-run-mismatch',
      operation: 'send',
      target: { kind: 'agent-session', agentSessionId: recipient.id },
      text: cliMessage.body,
      promptCondition: { expectedRun: recipient.control.run, afterSubmissionId: null },
      caller: { agentSessionId: 'caller-cli', capability },
      message: { ...cliMessage, messageId: 'test-run-mismatch', recipientRunId: badRunId }
    })).rejects.toMatchObject({ code: 'MESSAGE_RECIPIENT_MISMATCH' })
    const jsonBody = '{"messageId":"explicit-author-body","nested":{"text":"keep exactly"}}'
    const send = async (body: string, managed: boolean, suppliedCapability = capability) => await exec(cli, ['--endpoint', `unix:${sock}`, 'agent', 'send', '--to-session', recipient.id, '--text', body], {
      timeout: 15000,
      env: { ...process.env, AGENTMUX_RUNTIME_DIRECTORY: runtime, AGENTMUX_STATE_DIRECTORY: join(runtime, 'state'), AGENTMUX_MESSAGE_QUEUE_PATH: queuePath,
        AGENTMUX_AGENT_SESSION_STORE: sessionStorePath,
        AGENTMUX_AGENT_SESSION_ID: managed ? 'caller-cli' : undefined, AGENTMUX_AGENT_CAPABILITY: managed ? suppliedCapability : undefined }
    })
    await send(jsonBody, true)
    expect(physicalInput.mock.calls[1]![3]).toBe('[Message from Agent caller-cli]\n' + jsonBody)
    await send('local author body', false)
    expect(physicalInput.mock.calls[2]![3]).toBe('[Message from unverified local process]\nlocal author body')
    expect(submit).toHaveBeenCalledTimes(3)
    await expect(send('cannot forge source', true, 'wrong-capability')).rejects.toMatchObject({ stderr: expect.stringContaining('AGENT_CAPABILITY_INVALID') })
    expect(submit).toHaveBeenCalledTimes(3)
    expect(await queue.listAfter(0)).toHaveLength(3)
  } finally {
    await rpc.dispose()
    await server.stop()
    await core.dispose()
    await assertNoPrivateRuntime(runtime)
    await rm(runtime, { recursive: true, force: true })
  }
})

it('generic Goal and application observations retain a Terminal identity absent from the Agent store', async () => {
  const runtime = await mkdtemp(_hygiene_fixturePath("tmp/amux-generic-session-"))
  const sessionStorePath = join(runtime, 'agent-sessions.json')
  const terminalId = 'terminal-session-only'
  const terminal: Extract<SessionSnapshot, { kind: 'terminal' }> = {
    id: terminalId, kind: 'terminal', providerId: null, hostId: 'local', workspacePath: _hygiene_fixturePath("repo"),
    label: 'Terminal', createdAt: 1, updatedAt: 1, processState: 'running', latestOutputBytes: 0,
    status: { state: 'running', source: 'run-process', observedAt: 1 },
    control: { kind: 'terminal', hostId: 'local', runId: 'terminal-run', run: { runId: 'terminal-run' } }
  }
  useAppStore.setState({ config, sessions: [terminal], demands: {} })
  const store = new AgentMuxFileAgentSessionStore(sessionStorePath)
  expect(await store.load()).toEqual([])
  const requests: AgentMuxControlRequest[] = []
  const server = new AgentMuxControlServer({ coreClients: () => [], execute: async (request) => {
    requests.push(request)
    return await useAppStore.getState().executeControl(request)
  } }, join(runtime, 'control.sock'))
  await server.start()
  const env = { ...process.env, AGENTMUX_RUNTIME_DIRECTORY: runtime, AGENTMUX_STATE_DIRECTORY: join(runtime, 'state'), AGENTMUX_AGENT_SESSION_STORE: sessionStorePath,
    AGENTMUX_ENV: '', AGENTMUX_AGENT_SESSION_ID: undefined, AGENTMUX_AGENT_CAPABILITY: undefined }
  const run = async (args: string[]) => JSON.parse((await exec(cli, ['--endpoint', `unix:${server.path}`, ...args], { env, timeout: 15000 })).stdout)
  try {
    const created = await run(['goal', 'create', '--title', 'Terminal work', '--project', workspaceProjectId(config.workspaces[0]!),
      '--risk', 'low', '--confirm', 'user', '--session', terminalId])
    const demandId = created.result.goal.id as string
    expect(created.result.goal.sessionIds).toEqual([terminalId])
    await run(['goal', 'update', '--goal', demandId, '--session', terminalId])
    for (const action of ['handoff', 'link-session']) {
      const observed = await run(['goal', action, '--goal', demandId, '--session', terminalId])
        .then(result => ({ result }), error => ({ error }))
      expect(observed).toMatchObject({ result: {
        ok: true, operation: `goal.${action}`, result: { goal: { id: demandId, sessionIds: [terminalId] }, receipt: { sessionId: terminalId } }
      } })
    }
    const listed = await run(['goal', 'ls', '--session', terminalId])
    expect(listed.result.goals.map((goal: { id: string }) => goal.id)).toEqual([demandId])
    const inspected = await run(['goal', 'inspect', '--goal', demandId])
    expect(inspected.result.goal.sessionIds).toEqual([terminalId])
    const snapshot = await run(['app', 'snapshot', '--include', 'goals', '--session', terminalId])
    expect(snapshot.result.goals.map((goal: { id: string }) => goal.id)).toEqual([demandId])
    expect(useAppStore.getState().demands[demandId]?.sessionIds).toEqual([terminalId])
    expect(requests.filter(request => request.operation === 'demand.handoff')).toEqual([
      expect.objectContaining({ sessionId: terminalId })
    ])
    expect(requests.filter((request) => request.operation === 'demand.link-session')).toEqual([
      expect.objectContaining({ sessionId: terminalId })
    ])
    // The original mixed Session owner still rejects an unknown link without changing the Goal.
    const beforeUnknownLink = requests.length
    await expect(run(['goal', 'link-session', '--goal', demandId, '--session', 'unknown-terminal']))
      .rejects.toMatchObject({ stderr: expect.stringContaining('UNKNOWN_AGENT_SESSION') })
    expect(requests).toHaveLength(beforeUnknownLink + 1)
    expect(requests.at(-1)).toMatchObject({ operation: 'demand.link-session', sessionId: 'unknown-terminal' })
    expect(useAppStore.getState().demands[demandId]?.sessionIds).toEqual([terminalId])
    // Execution remains an Agent-only domain, unlike linking or observing a Terminal.
    const before = requests.length
    await expect(run(['goal', 'start', '--goal', demandId, '--session', terminalId]))
      .rejects.toMatchObject({ stderr: expect.stringContaining('UNKNOWN_AGENT_SESSION') })
    expect(requests).toHaveLength(before)
    expect(await store.load()).toEqual([])
  } finally {
    await server.stop()
    // The mixed Session owner remains the actual Store; no Terminal is invented
    // in Core and no default Runtime is needed for a Goal observation.
    await assertNoPrivateRuntime(runtime)
    await rm(runtime, { recursive: true, force: true })
  }
}, 45000)
