import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

import { AGENTMUX_CONTROL_SCHEMA_VERSION, AgentMuxClient, AgentMuxControlServer, AgentMuxFileAgentSessionStore, DurableAgentMuxMessageQueue, hashAgentCapability, issueAgentCapability, requestAgentMuxControl, type AgentMuxControlRequest, type AgentMuxControlResult, type AgentMuxStoredAgentSession } from '@agentmux/core'
import type { AppConfig, SessionSnapshot } from '../src/shared/contracts.js'
import { api } from '../src/renderer/src/lib/api.js'
import { createWorkspaceLayout } from '@agentmux/layout'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs.js'
import { executorDetectionKey, useAppStore } from '../src/renderer/src/store.js'

const exec = promisify(execFile)
// packages/core/bin/agentmux — the real CLI entry the CLI attribution test also uses.
const cli = fileURLToPath(new URL('../../../packages/core/bin/agentmux', import.meta.url))

const initialState = useAppStore.getState()

const config: AppConfig = {
  version: 9,
  hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  executors: {
    codex: { label: 'Codex', providerId: 'codex', command: 'codex', args: [], env: {}, injectAgentMuxGuide: true }
  },
  workspaces: [{ id: 'workspace', name: 'Project', hostId: 'local', path: '/repo', kind: 'folder' }],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }
}

function agent(id: string): Extract<SessionSnapshot, { kind: 'agent' }> {
  return {
    id,
    kind: 'agent', providerId: 'codex', executorId: 'codex',
    capabilities: { terminal: true, timeline: 'streaming', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
    hostId: 'local', workspacePath: '/repo', label: id,
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
        result: { executorId: 'codex', providerId: 'codex', hostId: 'local', availability: 'available' }
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
    kind: 'agent', agentSessionId, providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath: '/repo',
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
  useAppStore.setState(initialState, true)
})

// Real CLI → Control socket → production store executor → submitPrompt.
// Machine identities remain in the submit/receipt channel; the prompt is a readable source
// followed by the original body. Replacing the store projection with request.text is red.
it('CLI send reaches production submitPrompt with readable source, unchanged body and separate durable receipt', async () => {
  const runtime = await mkdtemp('/tmp/amux-a2a-integrated-')
  const queuePath = join(runtime, 'state', 'global-messages.ndjson')
  const sessionStorePath = join(runtime, 'state', 'agent-sessions.json')
  const sock = join(runtime, 'control.sock')

  const { recipient } = seedStore('mailbox-recipient')
  const { capability } = await seedCoreSessionStore(sessionStorePath)
  const submit = vi.spyOn(api.sessions, 'submitPrompt').mockResolvedValue()
  vi.spyOn(api.sessions, 'refresh').mockImplementation(async control => {
    const session = useAppStore.getState().sessions.find(item => item.id === control.agentSessionId)
    if (!session) throw new Error('Private Session is missing')
    return session
  })

  // Exercise the same Core capability and Session/Run binding used by main IPC before handing the
  // request to the renderer Control executor. The CLI child reads this durable store through the
  // injected path; no caller/session title or mock identity is accepted.
  const core = new AgentMuxClient({ store: new AgentMuxFileAgentSessionStore(sessionStorePath) })
  await (core as unknown as { registry: { load(hostId: string): Promise<void> } }).registry.load('local')

  // 起真 AgentMuxControlServer。execute 转发到 store.executeControl —— 就是生产 ipc.ts:781 那条路。
  const server = new AgentMuxControlServer({
    execute: async (request: AgentMuxControlRequest): Promise<AgentMuxControlResult> => {
      if (request.operation === 'send' && request.message?.sender.kind === 'agent-session') {
        if (!request.caller?.capability) throw new Error('managed capability missing')
        core.authorizeAgentMessage({
          capability: request.caller.capability,
          callerAgentSessionId: request.caller.agentSessionId,
          senderAgentSessionId: request.message.sender.agentSessionId,
          senderSessionId: request.message.senderSessionId,
          senderRunId: request.message.senderRunId,
          recipientSessionId: request.message.recipientSessionId,
          recipientRunId: request.message.recipientRunId
        })
      }
      return await useAppStore.getState().executeControl(request)
    }
  }, sock)
  await server.start()

  try {
    // 1) 真 CLI 走 send 到 sock。AGENTMUX_ENV=1 + AGENTMUX_AGENT_SESSION_ID 让 CLI 认作 managed sender。
    //    timeout=15000 而非 5000：CLI 子进程 + fs + sock 握手 + queue append + store executeControl 一整套，
    //    在忙碌 CI 机上 5s 会 flake。见 MINOR-4 (review 2026-09-29)。
    const stdout = await exec(cli, ['send', '--to-session', recipient.id, '--text', 'integrated body bytes'], {
      timeout: 15000,
      env: {
        ...process.env,
        AGENTMUX_RUNTIME_DIRECTORY: runtime, AGENTMUX_STATE_DIRECTORY: join(runtime, 'state'),
        AGENTMUX_MESSAGE_QUEUE_PATH: queuePath,
        AGENTMUX_AGENT_SESSION_STORE: sessionStorePath,
        AGENTMUX_ENV: '1',
        AGENTMUX_AGENT_SESSION_ID: 'caller-cli',
        AGENTMUX_AGENT_CAPABILITY: capability
      }
    }).then((r) => JSON.parse(r.stdout) as Record<string, unknown>)

    const cliMessageId = (stdout.result as Record<string, unknown>).messageId as string
    expect(cliMessageId, 'CLI 必须回 messageId').toEqual(expect.any(String))

    expect(submit).toHaveBeenCalledTimes(1)
    const [, submittedPrompt, submittedMessageId] = submit.mock.calls[0]!
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
    // The duplicate sender label must agree with the capability-authorized sender before
    // crossing the same Control socket to the production prompt caller.
    await expect(requestAgentMuxControl({
      schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'forged-source-label', operation: 'send',
      target: { kind: 'agent-session', agentSessionId: recipient.id }, text: cliMessage.body,
      promptCondition: { expectedRun: recipient.control.run, afterSubmissionId: null },
      caller: { agentSessionId: 'caller-cli', capability },
      message: { ...cliMessage, messageId: 'forged-source-label-message', sender: { kind: 'agent-session', agentSessionId: 'different-agent' } }
    }, sock)).rejects.toMatchObject({ code: 'MESSAGE_SENDER_MISMATCH' })
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
    const send = async (body: string, managed: boolean, suppliedCapability = capability) => await exec(cli, ['send', '--to-session', 'mailbox-rec', '--text', body], {
      timeout: 15000,
      env: { ...process.env, AGENTMUX_RUNTIME_DIRECTORY: runtime, AGENTMUX_STATE_DIRECTORY: join(runtime, 'state'), AGENTMUX_MESSAGE_QUEUE_PATH: queuePath,
        AGENTMUX_AGENT_SESSION_STORE: sessionStorePath, AGENTMUX_ENV: managed ? '1' : '',
        AGENTMUX_AGENT_SESSION_ID: 'caller-cli', AGENTMUX_AGENT_CAPABILITY: suppliedCapability }
    })
    await send(jsonBody, true)
    expect(submit.mock.calls[1]![1]).toBe('[Message from Agent caller-cli]\n' + jsonBody)
    await send('local author body', false)
    expect(submit.mock.calls[2]![1]).toBe('[Message from unverified local process]\nlocal author body')
    expect(submit).toHaveBeenCalledTimes(3)
    await expect(send('cannot forge source', true, 'wrong-capability')).rejects.toMatchObject({ stderr: expect.stringContaining('AGENT_CAPABILITY_INVALID') })
    expect(submit).toHaveBeenCalledTimes(3)
    expect(await queue.listAfter(0)).toHaveLength(3)
  } finally {
    await server.stop()
    await core.dispose()
    await rm(runtime, { recursive: true, force: true })
  }
})

it('generic Demand and mixed PMO Session routes retain a Terminal identity absent from the Agent store', async () => {
  const runtime = await mkdtemp('/tmp/amux-generic-session-')
  const sessionStorePath = join(runtime, 'agent-sessions.json')
  const terminalId = 'terminal-session-only'
  const terminal: Extract<SessionSnapshot, { kind: 'terminal' }> = {
    id: terminalId, kind: 'terminal', providerId: null, hostId: 'local', workspacePath: '/repo',
    label: 'Terminal', createdAt: 1, updatedAt: 1, agentSessionUpdatedAt: 1, promptSubmissionPredecessor: null, processState: 'running', latestOutputBytes: 0,
    status: { state: 'running', source: 'run-process', observedAt: 1 },
    control: { kind: 'terminal', hostId: 'local', runId: 'terminal-run', run: { runId: 'terminal-run' } }
  }
  useAppStore.setState({ config, sessions: [terminal], demands: {} })
  const store = new AgentMuxFileAgentSessionStore(sessionStorePath)
  expect(await store.load()).toEqual([])
  const requests: AgentMuxControlRequest[] = []
  const server = new AgentMuxControlServer({ execute: async (request) => {
    requests.push(request)
    return await useAppStore.getState().executeControl(request)
  } }, join(runtime, 'control.sock'))
  await server.start()
  const env = { ...process.env, AGENTMUX_RUNTIME_DIRECTORY: runtime, AGENTMUX_STATE_DIRECTORY: join(runtime, 'state'), AGENTMUX_AGENT_SESSION_STORE: sessionStorePath,
    AGENTMUX_ENV: '', AGENTMUX_AGENT_SESSION_ID: undefined, AGENTMUX_AGENT_CAPABILITY: '' }
  const run = async (args: string[]) => JSON.parse((await exec(cli, args, { env, timeout: 15000 })).stdout)
  try {
    const created = await run(['demand', 'create', '--title', 'Terminal work', '--project', 'workspace',
      '--risk', 'low', '--confirm', 'user', '--session', terminalId])
    const demandId = created.result.demand.id as string
    expect(created.result.demand.sessionIds).toEqual([terminalId])
    await run(['demand', 'update', '--demand', demandId, '--session', terminalId])
    await run(['demand', 'handoff', '--demand', demandId, '--session', terminalId])
    await run(['demand', 'link-session', '--demand', demandId, '--session', terminalId])
    const listed = await run(['demand', 'list', '--session', terminalId])
    expect(listed.result.demands.map((demand: { id: string }) => demand.id)).toEqual([demandId])
    const pmo = await run(['pmo', 'demands', '--session', terminalId])
    expect(pmo.result.demands.map((demand: { id: string }) => demand.id)).toEqual([demandId])
    const snapshot = await run(['pmo', 'snapshot', '--session', terminalId])
    expect(snapshot.result.demands.map((demand: { id: string }) => demand.id)).toEqual([demandId])
    expect(useAppStore.getState().demands[demandId]?.sessionIds).toEqual([terminalId])
    expect(requests.filter((request) => request.operation === 'demand.link-session')).toEqual([
      expect.objectContaining({ sessionId: terminalId })
    ])
    // Execution remains an Agent-only domain, unlike linking or observing a Terminal.
    const before = requests.length
    await expect(run(['demand', 'start', '--demand', demandId, '--session', terminalId]))
      .rejects.toMatchObject({ stderr: expect.stringContaining('UNKNOWN_AGENT_SESSION') })
    expect(requests).toHaveLength(before)
    expect(await store.load()).toEqual([])
  } finally {
    await server.stop()
    // PMO's existing Core observation starts an isolated daemon. Reap only that test endpoint;
    // its random socket and state directory together prove ownership of the process being stopped.
    const processes = (await exec('ps', ['-axo', 'pid=,command='])).stdout
    for (const line of processes.split('\n')) {
      const match = /^\s*(\d+)\s+(.+)$/u.exec(line)
      if (!match || !match[2]!.includes('/ctxmuxd ') ||
        !match[2]!.includes(`--socket ${join(runtime, 'ctxmux.sock')}`) ||
        !match[2]!.includes(`--state-dir ${join(runtime, 'state', 'ctxmux')}`)) continue
      try { process.kill(Number(match[1]), 'SIGTERM') }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error }
    }
    await rm(runtime, { recursive: true, force: true })
  }
}, 45000)
