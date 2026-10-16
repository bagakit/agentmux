import { fixtureEpoch as _tailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner'
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

import { AgentMuxControlServer, AgentMuxFileAgentSessionStore, agentPromptCondition, DurableAgentMuxMessageQueue, connectAgentMuxRpc, type AgentMuxControlRequest, type AgentMuxControlResult, type AgentMuxStoredAgentSession } from '@agentmux/core'
import { renderAgentMuxMessageEnvelope } from '@agentmux/core/agent-message-render'
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

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  useAppStore.setState(initialState, true)
})

// The actual object CLI and service use one original Core owner; no Renderer input bridge.
it('CLI send preserves body, authenticated author, original ID and replay through its original Core', async () => {
  const f = await rpcOwnerFixture(['caller-cli', 'mailbox-recipient'])
  const endpoint = join(f.root, 'control.sock')
  const server = new AgentMuxControlServer({ socketPath: endpoint, coreClients: f.coreClients,
    execute: async request => {
      if (request.operation !== 'list.active-agents') throw new Error('Unexpected private observation: ' + request.operation)
      const session = f.client.agentSession('mailbox-recipient')
      return { operation: request.operation, agents: [{ agentSessionId: session.agentSessionId,
        promptCondition: agentPromptCondition(session), projectId: null, projectName: null,
        workspacePath: session.workspacePath, providerId: session.providerId, executorId: session.executorId,
        processState: 'running', status: 'active', updatedAt: session.updatedAt }] }
    } })
  const submit = vi.spyOn(f.client, 'submitAgentMessage')
  const writes = f.inner.kernel.input as ReturnType<typeof vi.fn>
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_')))
  const send = async (id: string, body: string, capability: string | null = f.capability) => {
    const result = await exec(cli, ['--endpoint', `unix:${endpoint}`, 'agent', 'send', '--to-session', 'mailbox-recipient',
      '--text', body, '--message-id', id, '--operation-id', 'operation-' + id], { timeout: 15000,
      env: { ...env, AGENTMUX_RUNTIME_DIRECTORY: f.root, AGENTMUX_STATE_DIRECTORY: join(f.root, 'state'),
        AGENTMUX_MESSAGE_QUEUE_PATH: f.client.agentMessageQueuePath(), AGENTMUX_AGENT_SESSION_STORE: f.store.path,
        ...(capability ? { AGENTMUX_AGENT_SESSION_ID: 'caller-cli', AGENTMUX_AGENT_CAPABILITY: capability } : {}) } })
    return JSON.parse(result.stdout)
  }
  await server.start()
  try {
    const normal = await send('original-message', 'integrated body bytes')
    expect(normal).toMatchObject({ ok: true, result: { messageId: 'original-message', delivery: { state: 'delivered' } } })
    const original = submit.mock.calls[0]![0]
    expect(original).toMatchObject({ agentSessionId: 'mailbox-recipient', sourceChannel: 'cli',
      envelope: { messageId: 'original-message', body: 'integrated body bytes', senderSessionId: 'caller-cli', recipientSessionId: 'mailbox-recipient' },
      caller: { agentSessionId: 'caller-cli', capability: f.capability } })
    expect(writes.mock.calls.map(call => call[1].data).join('')).toContain(renderAgentMuxMessageEnvelope(original.envelope))
    const applied = structuredClone(writes.mock.calls)
    await send('original-message', 'integrated body bytes')
    expect(writes.mock.calls).toEqual(applied)
    await expect(send('original-message', 'changed body')).rejects.toMatchObject({ stderr: expect.stringContaining('MESSAGE_ID_CONFLICT') })
    await expect(send('forged-capability', 'cannot forge source', 'wrong-capability')).rejects.toMatchObject({ stderr: expect.stringContaining('AGENT_CAPABILITY_INVALID') })
    expect(writes.mock.calls).toEqual(applied)
    const jsonBody = '{"messageId":"explicit-author-body","nested":{"text":"keep exactly"}}'
    await send('json-body', jsonBody)
    await send('local-message', 'local author body', null)
    const messages = await new DurableAgentMuxMessageQueue(f.client.agentMessageQueuePath()).listAfter()
    expect(messages.map(message => [message.envelope.messageId, message.envelope.body, message.envelope.senderSessionId])).toEqual([
      ['original-message', 'integrated body bytes', 'caller-cli'], ['json-body', jsonBody, 'caller-cli'], ['local-message', 'local author body', null]
    ])
    expect(messages.at(-1)?.envelope.sender).toEqual({ kind: 'human', principal: 'local-cli' })
    expect(submit).toHaveBeenCalledTimes(3)
    expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  } finally { await server.stop(); await f.close() }
})

it('generic Goal and application observations retain a Terminal identity absent from the Agent store', async () => {
  const runtime = await mkdtemp(_hygiene_fixturePath("tmp/amux-generic-session-"))
  const sessionStorePath = join(runtime, 'agent-sessions.json')
  const terminalId = 'terminal-session-only'
  const terminal: Extract<SessionSnapshot, { kind: 'terminal' }> = {
    id: terminalId, kind: 'terminal', providerId: null, hostId: 'local', workspacePath: _hygiene_fixturePath("repo"),
    label: 'Terminal', createdAt: _tailFixtureEpoch(0, 0, 1), updatedAt: _tailFixtureEpoch(0, 0, 1), processState: 'running', latestOutputBytes: 0,
    status: { state: 'running', source: 'run-process', observedAt: _tailFixtureEpoch(0, 0, 1) },
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
