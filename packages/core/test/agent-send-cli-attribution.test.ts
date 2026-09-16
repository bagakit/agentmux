import { execFile } from 'node:child_process'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { AgentMuxControlServer } from '../src/control-host.js'
import { DurableAgentMuxMessageQueue, renderAgentMuxMessageEnvelope } from '../src/agent-global-message-queue.js'
import type { AgentMuxControlRequest } from '../src/control.js'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import { hashAgentCapability, issueAgentCapability } from '../src/agent-capability.js'
import { AgentMuxError } from '../src/errors.js'
import type { AgentMuxStoredAgentSession } from '../src/types.js'

const exec = promisify(execFile)
const cli = fileURLToPath(new URL('../bin/agentmux', import.meta.url))

async function seedSessions(path: string, ids: readonly string[], capability?: string): Promise<void> {
  const store = new AgentMuxFileAgentSessionStore(path)
  for (const agentSessionId of ids) {
    const session: AgentMuxStoredAgentSession = {
      kind: 'agent', agentSessionId, providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath: '/repo',
      run: { runId: `run-${agentSessionId}` }, retiredRuns: [], hookBindingId: `hook-${agentSessionId}`, hookToken: `token-${agentSessionId}`,
      ...(capability && agentSessionId === 'sender' ? { capabilityHash: hashAgentCapability(capability) } : {}),
       createdAt: 1, updatedAt: 1
    }
    await store.compareAndSwap(null, session)
  }
}

it('real CLI send retains managed authors for every target without inventing an author for human CLI use', async () => {
  const runtime = await mkdtemp('/tmp/amux-mail-cli-')
  const sessionStorePath = join(runtime, 'sessions.json')
  await seedSessions(sessionStorePath, ['other', 'recipient'])
  const requests: AgentMuxControlRequest[] = []
  const delivered: string[] = []
  const server = new AgentMuxControlServer({ execute: async (request) => {
    requests.push(request)
    if (request.operation === 'inspect.region') return { operation: 'inspect.region', region: {
      kind: 'agent', regionId: 'region', tabId: 'tab', workspaceId: 'workspace', agentSessionId: 'recipient', providerId: 'codex', executorId: 'codex', bounds: { x: 0, y: 0, width: 1, height: 1 }, neighbors: { left: { kind: 'none' }, right: { kind: 'none' }, up: { kind: 'none' }, down: { kind: 'none' } }
    } }
    if (request.operation === 'inspect.tab') return { operation: 'inspect.tab', tab: { tabId: 'tab', workspaceId: 'workspace', regions: [{ kind: 'agent', regionId: 'region', tabId: 'tab', workspaceId: 'workspace', agentSessionId: 'recipient', providerId: 'codex', executorId: 'codex', bounds: { x: 0, y: 0, width: 1, height: 1 }, neighbors: { left: { kind: 'none' }, right: { kind: 'none' }, up: { kind: 'none' }, down: { kind: 'none' } } }] } }
    if (request.operation === 'open.agent') return { operation: 'open.agent', region: {
      kind: 'agent', regionId: 'new-region', tabId: 'tab', workspaceId: 'workspace',
      agentSessionId: 'recipient', providerId: 'codex', executorId: 'codex'
    } }
    if (request.operation === 'send') delivered.push(request.message ? renderAgentMuxMessageEnvelope(request.message) : request.text)
    return { operation: 'send', agentSessionId: 'recipient' }
  } }, join(runtime, 'control.sock'))
  await server.start()
  try {
    const outputs: Array<Record<string, any>> = []
    for (const [flag, id] of [['--to-session', 'other'], ['--to-region', 'region'], ['--to-tab', 'tab']]) {
      const result = await exec(cli, ['send', flag!, id!, '--text', 'actual mail'], { timeout: 5000, env: {
        ...process.env, AGENTMUX_RUNTIME_DIRECTORY: runtime, AGENTMUX_AGENT_SESSION_STORE: sessionStorePath, AGENTMUX_MESSAGE_QUEUE_PATH: join(runtime, 'state', 'global-messages.ndjson'), AGENTMUX_ENV: '', AGENTMUX_AGENT_SESSION_ID: 'not-managed'
      } })
      outputs.push(JSON.parse(result.stdout) as Record<string, any>)
    }
    expect(requests.filter((request) => request.operation === 'send').map((request) => [request.target, request.caller, request.text])).toEqual([
      [{ kind: 'agent-session', agentSessionId: 'other' }, undefined, 'actual mail'],
      [{ kind: 'region', regionId: 'region' }, undefined, 'actual mail'],
      [{ kind: 'tab', tabId: 'tab' }, undefined, 'actual mail']
    ])
    const humanEnv = { ...process.env, AGENTMUX_RUNTIME_DIRECTORY: runtime, AGENTMUX_AGENT_SESSION_STORE: sessionStorePath, AGENTMUX_MESSAGE_QUEUE_PATH: join(runtime, 'state', 'global-messages.ndjson'), AGENTMUX_ENV: '', AGENTMUX_AGENT_SESSION_ID: 'not-managed' }
    await exec(cli, ['send', '--to-session', 'other', '--text', 'human mail'], { timeout: 5000, env: humanEnv })
    expect(requests.at(-1)).toMatchObject({ operation: 'send', text: 'human mail' })
    expect(requests.at(-1)).not.toHaveProperty('caller')
    const queue = new DurableAgentMuxMessageQueue(join(runtime, 'state', 'global-messages.ndjson'))
    const records = await queue.listAfter(0)
    expect(records).toHaveLength(4)
    expect(outputs[0]).toMatchObject({ operation: 'send', result: { queueId: expect.any(String), receiptId: expect.any(String), messageId: expect.any(String), delivery: { state: 'delivered' } } })
    expect((outputs[0]!.result as Record<string, unknown>).messageId).not.toBe(outputs[0]!.requestId)
    expect(records[0]!.envelope.sender).toEqual({ kind: 'human', principal: 'local-cli' })
    expect(records[0]!.envelope.recipient).toEqual({ kind: 'agent-session', agentSessionId: 'other' })
    expect(records[0]!.envelope.body).toBe('actual mail')
    expect(requests.filter((request) => request.operation === 'send')[0]).toMatchObject({ operation: 'send', message: { sender: { kind: 'human', principal: 'local-cli' }, recipient: { kind: 'agent-session', agentSessionId: 'other' } } })
    expect(delivered[0]).toBe('[Message from unverified local process]\nactual mail')
    await expect(exec(cli, ['send', '--to-session', 'self', '--text', 'not allowed'], { timeout: 5000, env: humanEnv }))
      .rejects.toMatchObject({ stderr: expect.stringContaining('MANAGED_AGENT_CONTEXT_REQUIRED') })
    expect(requests.filter((request) => request.operation === 'send')).toHaveLength(4)
    const open = ['open', 'agent', '--agent', 'codex', '--right-of', 'region', '--prompt', 'first mail']
    await exec(cli, open, { timeout: 5000, env: { ...humanEnv, AGENTMUX_ENV: '1', AGENTMUX_AGENT_SESSION_ID: 'sender' } })
    expect(requests.filter((request) => request.operation === 'open.agent')[0]).toMatchObject({ operation: 'open.agent', caller: { agentSessionId: 'sender' },
      content: { kind: 'new-agent', prompt: 'first mail' } })
    await exec(cli, open, { timeout: 5000, env: humanEnv })
    expect(requests.filter((request) => request.operation === 'open.agent')[1]).toMatchObject({ operation: 'open.agent', content: { kind: 'new-agent', prompt: 'first mail' } })
    expect(requests.filter((request) => request.operation === 'open.agent')[1]).not.toHaveProperty('caller')
    expect(requests.filter((request) => request.operation === 'open.agent')).toHaveLength(2)
  } finally {
    await server.stop()
    await rm(runtime, { recursive: true, force: true })
  }
})

it('real CLI retries the same messageId across new processes with the original durable receipt', async () => {
  const runtime = await mkdtemp('/tmp/amux-mail-cli-retry-')
  const queuePath = join(runtime, 'state', 'global-messages.ndjson')
  const sessionStorePath = join(runtime, 'sessions.json')
  await seedSessions(sessionStorePath, ['recipient'])
  const server = new AgentMuxControlServer({ execute: async (request) => {
    if (request.operation === 'send') return { operation: 'send', agentSessionId: 'recipient' }
    return { operation: 'send', agentSessionId: 'recipient' }
  } }, join(runtime, 'control.sock'))
  await server.start()
  try {
    const env = { ...process.env, AGENTMUX_RUNTIME_DIRECTORY: runtime, AGENTMUX_AGENT_SESSION_STORE: sessionStorePath, AGENTMUX_MESSAGE_QUEUE_PATH: queuePath, AGENTMUX_ENV: '', AGENTMUX_AGENT_SESSION_ID: '' }
    const first = await exec(cli, ['send', '--to-session', 'recipient', '--message-id', 'stable-id', '--text', 'retry body'], { timeout: 5000, env })
    const second = await exec(cli, ['send', '--to-session', 'recipient', '--message-id', 'stable-id', '--text', 'retry body'], { timeout: 5000, env })
    const firstPayload = JSON.parse(first.stdout) as { result: { receiptId: string; messageId: string } }
    const secondPayload = JSON.parse(second.stdout) as { result: { receiptId: string; messageId: string } }
    expect(secondPayload.result).toMatchObject({ receiptId: firstPayload.result.receiptId, messageId: 'stable-id' })
    expect(await new DurableAgentMuxMessageQueue(queuePath).listAfter(0)).toHaveLength(1)
  } finally {
    await server.stop()
    await rm(runtime, { recursive: true, force: true })
  }
})

it('restarted CLI processes resolve durable compact and existing long IDs, and refuse later prefix collisions before send', async () => {
  const runtime = await mkdtemp('/tmp/amux-mail-id-')
  const sessionStorePath = join(runtime, 'sessions.json')
  const queuePath = join(runtime, 'messages.ndjson')
  const coreUrl = new URL('../dist/index.js', import.meta.url).href
  const longId = '765ae7ef-b886-4681-b9b5-0bbc561e8f1a'
  // The first child mints and persists; it exits before any of the recipient CLI processes start.
  const create = await exec(process.execPath, ['--input-type=module', '-e', `
    import { mintAgentSessionId, AgentMuxFileAgentSessionStore } from ${JSON.stringify(coreUrl)};
    const id = mintAgentSessionId();
    const store = new AgentMuxFileAgentSessionStore(process.argv[1]);
    for (const agentSessionId of [id, process.argv[2]]) await store.compareAndSwap(null, {
      kind: 'agent', agentSessionId, providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath: '/repo',
      run: {runId: 'run-' + agentSessionId}, retiredRuns: [], hookBindingId: 'hook-' + agentSessionId,
      hookToken: 'token-' + agentSessionId, outputCursorBytes: 0, createdAt: 1, updatedAt: 1
    });
    process.stdout.write(id);
  `, sessionStorePath, longId])
  const compactId = create.stdout
  expect(compactId).toMatch(/^[A-Za-z0-9_-]{16}$/u)
  const requests: AgentMuxControlRequest[] = []
  const server = new AgentMuxControlServer({ execute: async (request) => {
    requests.push(request)
    if (request.operation === 'send') return { operation: 'send', agentSessionId: compactId }
    throw new AgentMuxError('Captured resolved command.', 'CONTROL_FAILED')
  } }, join(runtime, 'control.sock'))
  await server.start()
  const env = { ...process.env, AGENTMUX_RUNTIME_DIRECTORY: runtime, AGENTMUX_AGENT_SESSION_STORE: sessionStorePath,
    AGENTMUX_MESSAGE_QUEUE_PATH: queuePath, AGENTMUX_ENV: '', AGENTMUX_AGENT_SESSION_ID: undefined, AGENTMUX_AGENT_CAPABILITY: '' }
  try {
    for (const selector of [compactId.slice(0, 8), compactId, longId.slice(0, 8)]) {
      await exec(cli, ['send', '--to-session', selector, '--text', 'restarted identity'], { env, timeout: 15000 })
    }
    expect(requests.map((request) => request.operation === 'send' ? request.target : null)).toEqual([
      { kind: 'agent-session', agentSessionId: compactId }, { kind: 'agent-session', agentSessionId: compactId },
      { kind: 'agent-session', agentSessionId: longId }
    ])
    const prefix = compactId.slice(0, 8)
    const routedCommands = [
      ['interrupt', '--session', prefix], ['resume', '--session', prefix, '--text', 'continue'], ['stop', '--session', prefix],
      ['open', 'agent', '--session', prefix, '--right-of', 'region'],
      ['demand', 'start', '--demand', 'demand', '--session', prefix],
    ]
    for (const args of routedCommands) {
      await expect(exec(cli, args, { env, timeout: 15000 })).rejects.toMatchObject({ stderr: expect.stringContaining('CONTROL_FAILED') })
    }
    expect(requests.slice(3)).toMatchObject([
      { operation: 'interrupt', target: { agentSessionId: compactId } },
      { operation: 'resume', target: { agentSessionId: compactId } },
      { operation: 'stop', target: { agentSessionId: compactId } },
      { operation: 'open.agent', content: { agentSessionId: compactId } },
      { operation: 'demand.start', sessionId: compactId },
    ])
    // A new durable identity shares the previously usable prefix. Subsequent processes must refuse.
    const collisionId = compactId.slice(0, 15) + (compactId.endsWith('A') ? 'B' : 'A')
    await seedSessions(sessionStorePath, [collisionId])
    const before = requests.length
    const refusing = [
      ...routedCommands, ['send', '--to-session', prefix, '--text', 'must not append'],
      ['output', '--session', prefix], ['inspect', '--session', prefix],
      ['pmo', 'agents', '--session', prefix], ['pmo', 'sessions', '--session', prefix], ['pmo', 'agents', '--agent', prefix]
    ]
    for (const args of refusing) {
      await expect(exec(cli, args, { env, timeout: 15000 })).rejects.toMatchObject({ stderr: expect.stringContaining('AMBIGUOUS_AGENT_SESSION') })
    }
    await expect(exec(cli, ['send', '--to-session', 'unknown-prefix', '--text', 'must not append'], { env, timeout: 15000 }))
      .rejects.toMatchObject({ stderr: expect.stringContaining('UNKNOWN_AGENT_SESSION') })
    expect(requests).toHaveLength(before)
    expect(await new DurableAgentMuxMessageQueue(queuePath).listAfter(0)).toHaveLength(3)
    // Exact canonical identity still wins despite a colliding prefix.
    await exec(cli, ['send', '--to-session', compactId, '--text', 'full identity'], { env, timeout: 15000 })
    expect(requests.at(-1)).toMatchObject({ operation: 'send', target: { agentSessionId: compactId } })
    const restored = await new AgentMuxFileAgentSessionStore(sessionStorePath).load()
    expect(restored.map((session) => (session as AgentMuxStoredAgentSession).agentSessionId)).toEqual([compactId, longId, collisionId])
    const store = new AgentMuxFileAgentSessionStore(sessionStorePath)
    const retiredSession = restored.find((session) => (session as AgentMuxStoredAgentSession).agentSessionId === longId) as AgentMuxStoredAgentSession
    const stop = {
      reservationId: 'retire-old-long-id', ownerId: 'retire-owner', ownerPid: process.pid, kind: 'stop' as const,
      agentSessionId: longId, operationId: 'retire-operation', expiresAt: Date.now() + 60000,
      expectedRun: retiredSession.run,
      stopOperation: { daemonInstance: 'daemon-instance', operationKey: 'retire-operation', runId: retiredSession.run.runId }
    }
    await store.reserveLifecycle(stop)
    await store.commitLifecycle(stop, null)
    const replacement = longId.slice(0, -1) + 'b'
    await seedSessions(sessionStorePath, [replacement])
    const beforeRetiredPrefix = requests.length
    await expect(exec(cli, ['send', '--to-session', longId.slice(0, 8), '--text', 'must not rebound'], { env, timeout: 15000 }))
      .rejects.toMatchObject({ stderr: expect.stringContaining('AMBIGUOUS_AGENT_SESSION') })
    await expect(exec(cli, ['send', '--to-session', longId, '--text', 'retired identity'], { env, timeout: 15000 }))
      .rejects.toMatchObject({ stderr: expect.stringContaining('UNKNOWN_AGENT_SESSION') })
    expect(requests).toHaveLength(beforeRetiredPrefix)
    await expect(stat(join(runtime, 'ctxmux.sock'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    await server.stop()
    await rm(runtime, { recursive: true, force: true })
  }
}, 60000)

it('capability proof alone supplies the managed author; missing, forged and superseded credentials never append', async () => {
  const runtime = await mkdtemp('/tmp/amux-mail-proof-')
  const sessionStorePath = join(runtime, 'sessions.json')
  const queuePath = join(runtime, 'messages.ndjson')
  const capability = issueAgentCapability()
  await seedSessions(sessionStorePath, ['sender', 'recipient'], capability)
  const requests: AgentMuxControlRequest[] = []
  const server = new AgentMuxControlServer({ execute: async (request) => {
    requests.push(request)
    return { operation: 'send', agentSessionId: 'recipient' }
  } }, join(runtime, 'control.sock'))
  await server.start()
  const baseEnv = { ...process.env, AGENTMUX_RUNTIME_DIRECTORY: runtime, AGENTMUX_AGENT_SESSION_STORE: sessionStorePath,
    AGENTMUX_MESSAGE_QUEUE_PATH: queuePath, AGENTMUX_ENV: '1', AGENTMUX_AGENT_SESSION_ID: 'sender' }
  const send = async (proof: string, selector = 'reci') => await exec(cli, ['send', '--to-session', selector, '--text', 'verified body'], {
    env: { ...baseEnv, AGENTMUX_AGENT_CAPABILITY: proof }, timeout: 15000
  })
  try {
    await send(capability)
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ operation: 'send', caller: { agentSessionId: 'sender', capability },
      message: { sender: { kind: 'agent-session', agentSessionId: 'sender' }, senderSessionId: 'sender', senderRunId: 'run-sender',
        recipient: { kind: 'agent-session', agentSessionId: 'recipient' }, recipientRunId: 'run-recipient', body: 'verified body' } })
    await expect(send('')).rejects.toMatchObject({ stderr: expect.stringContaining('MANAGED_AGENT_CONTEXT_REQUIRED') })
    await expect(send('forged-capability')).rejects.toMatchObject({ stderr: expect.stringContaining('AGENT_CAPABILITY_INVALID') })
    const handoff = await exec(cli, ['handoff', '--to-session', 'reci', '--task', 'task-proof'], {
      env: { ...baseEnv, AGENTMUX_AGENT_CAPABILITY: capability }, timeout: 15000
    })
    expect(JSON.parse(handoff.stdout)).toMatchObject({ operation: 'handoff', result: { ownerAgentSessionId: 'recipient' } })
    await seedSessions(sessionStorePath, ['recipient-other'])
    await expect(exec(cli, ['handoff', '--to-session', 'reci', '--task', 'task-ambiguous'], {
      env: { ...baseEnv, AGENTMUX_AGENT_CAPABILITY: capability }, timeout: 15000
    })).rejects.toMatchObject({ stderr: expect.stringContaining('AMBIGUOUS_AGENT_SESSION') })
    const store = new AgentMuxFileAgentSessionStore(sessionStorePath)
    const sender = (await store.load()).find((value) => (value as AgentMuxStoredAgentSession).agentSessionId === 'sender') as AgentMuxStoredAgentSession
    await store.compareAndSwap(sender, { ...sender, run: { runId: 'replacement-run' }, retiredRuns: [sender.run], capabilityHash: hashAgentCapability(issueAgentCapability()) })
    await expect(send(capability, 'recipient')).rejects.toMatchObject({ stderr: expect.stringContaining('AGENT_CAPABILITY_INVALID') })
    expect(requests).toHaveLength(1)
    expect(await new DurableAgentMuxMessageQueue(queuePath).listAfter(0)).toHaveLength(1)
  } finally {
    await server.stop()
    await rm(runtime, { recursive: true, force: true })
  }
}, 60000)

it('real CLI consumes a --leading canonical Session ID verbatim and still rejects absent selector values', async () => {
  const runtime = await mkdtemp('/tmp/amux-leading-id-')
  const sessionStorePath = join(runtime, 'sessions.json')
  const queuePath = join(runtime, 'messages.ndjson')
  const canonical = '--AbCdEfGhIjKlMn'
  expect(canonical).toMatch(/^[A-Za-z0-9_-]{16}$/u)
  await seedSessions(sessionStorePath, [canonical])
  const requests: AgentMuxControlRequest[] = []
  const server = new AgentMuxControlServer({ execute: async (request) => {
    requests.push(request)
    if (request.operation === 'interrupt') return { operation: 'interrupt', agentSessionId: canonical }
    return { operation: 'send', agentSessionId: canonical }
  } }, join(runtime, 'control.sock'))
  await server.start()
  const env = { ...process.env, AGENTMUX_RUNTIME_DIRECTORY: runtime, AGENTMUX_AGENT_SESSION_STORE: sessionStorePath,
    AGENTMUX_MESSAGE_QUEUE_PATH: queuePath, AGENTMUX_ENV: '', AGENTMUX_AGENT_SESSION_ID: undefined }
  try {
    await exec(cli, ['send', '--to-session', canonical, '--text', 'canonical body'], { env, timeout: 15000 })
    await exec(cli, ['interrupt', '--session', canonical.slice(0, 8)], { env, timeout: 15000 })
    expect(requests).toMatchObject([
      { operation: 'send', target: { kind: 'agent-session', agentSessionId: canonical } },
      { operation: 'interrupt', target: { kind: 'agent-session', agentSessionId: canonical } }
    ])
    for (const args of [['send', '--text', 'body', '--to-session'], ['interrupt', '--session'], ['send', '--to-session', '--text', 'body']]) {
      await expect(exec(cli, args, { env, timeout: 15000 })).rejects.toMatchObject({ stderr: expect.stringContaining('INVALID_CLI_ARGUMENT') })
    }
    expect(requests).toHaveLength(2)
    expect(await new DurableAgentMuxMessageQueue(queuePath).listAfter(0)).toHaveLength(1)
  } finally {
    await server.stop()
    await rm(runtime, { recursive: true, force: true })
  }
})
