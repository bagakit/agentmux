import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defineAgentProvider, type AgentProvider } from '../src/agent-provider.js'
import { AgentMuxClient } from '../src/client.js'
import type { AgentMuxAcpBinding } from '../src/acp-adapter.js'
import { AgentMuxDaemonServer } from '../src/daemon-server.js'
import {
  AgentMuxMemoryAgentSessionStore,
  type AgentMuxAgentSessionStore
} from '../src/agent-session-store.js'
import type { AgentMuxAcpEvent, AgentMuxClientEvent } from '../src/types.js'

const fixturePath = fileURLToPath(new URL('./fixtures/fake-hook-agent.mjs', import.meta.url))

function fixtureProvider(): AgentProvider {
  return defineAgentProvider({
    catalog: {
      id: 'fixture',
      label: 'Fixture',
      executable: process.execPath,
      expectedProcess: 'node',
      promptDelivery: 'positional-argv',
      readySignal: { kind: 'foreground-process', expectedProcess: 'node' },
      hookStrategy: { kind: 'native', installation: 'explicit-managed' },
      resumeStrategy: { kind: 'provider-native', locator: 'session-id' },
      acpStrategy: { kind: 'none' },
      capabilities: {
        terminal: true,
        hookEvents: true,
        permission: 'observe',
        providerResume: true,
        acp: false,
        replyCorrelation: 'none'
      }
    },
    buildArgs: (prompt) => [fixturePath, prompt],
    buildResumeArgs: (sessionId) => [fixturePath, `resumed-${sessionId}`],
    hook: {
      rules: [{ events: ['SessionStart'], state: 'working' }],
      nativeHandle: { sessionIdKeys: ['session_id'] }
    }
  })
}

function acpProvider(): AgentProvider {
  return defineAgentProvider({
    catalog: {
      id: 'fixture-acp',
      label: 'Fixture ACP',
      executable: process.execPath,
      expectedProcess: 'node',
      promptDelivery: 'positional-argv',
      readySignal: { kind: 'foreground-process', expectedProcess: 'node' },
      hookStrategy: { kind: 'none' },
      resumeStrategy: { kind: 'none' },
      acpStrategy: { kind: 'adapter' },
      capabilities: {
        terminal: true,
        hookEvents: false,
        permission: 'respond',
        providerResume: false,
        acp: true,
        replyCorrelation: 'none'
      }
    },
    buildArgs: () => ['-e', 'setInterval(() => {}, 1000)'],
    hook: { rules: [] }
  })
}

function acpBinding(capture?: (listener: (event: AgentMuxAcpEvent) => void) => void): AgentMuxAcpBinding {
  return {
    adapterId: 'fixture-adapter',
    sessionId: 'fixture-acp-session',
    onEvent(listener) {
      capture?.(listener)
      return () => {}
    },
    async respondPermission() {},
    async close() {}
  }
}

async function waitFor(
  description: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for ${description}`)
}

describe('AgentMux Agent client', () => {
  let directory: string
  let socketPath: string
  let server: AgentMuxDaemonServer
  const clients: AgentMuxClient[] = []

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'agentmux-semantic-'))
    socketPath = join(directory, 'agentmuxd.sock')
    server = new AgentMuxDaemonServer({ socketPath, hostId: 'semantic-host' })
    await server.start()
  })

  afterEach(async () => {
    await Promise.allSettled(clients.splice(0).map(async (client) => await client.dispose()))
    await server.stop()
    await rm(directory, { recursive: true, force: true })
  })

  async function connect(store: AgentMuxAgentSessionStore): Promise<AgentMuxClient> {
    const client = new AgentMuxClient({
      socketPath,
      expectedHostId: 'semantic-host',
      providers: [fixtureProvider()],
      store
    })
    clients.push(client)
    await client.connect()
    return client
  }

  it('keeps reattach, provider resume, and respawn as three different identity operations', async () => {
    const store = new AgentMuxMemoryAgentSessionStore()
    const first = await connect(store)
    const firstEvents: AgentMuxClientEvent[] = []
    first.onEvent((event) => firstEvents.push(event))
    const created = await first.createAgent({
      agentSessionId: 'semantic-main',
      runId: 'daemon-main',
      createOperationId: 'create-main',
      agentId: 'fixture',
      workspacePath: process.cwd(),
      prompt: 'initial',
      commandOverride: process.execPath
    })
    await waitFor('the hook-bound native session', () => (
      first.agentSession(created.agentSessionId).nativeHandle?.kind === 'provider'
    ))
    await waitFor('terminal output evidence', () => firstEvents.some((event) => (
      event.type === 'terminal-output' && event.data.includes('hook-agent-ready:initial')
    )))
    expect(first.agentSession('semantic-main')).toMatchObject({
      nativeHandle: { sessionId: 'native-semantic-main' },
      hookReceipt: { eventName: 'SessionStart' }
    })
    expect(firstEvents).not.toContainEqual(expect.objectContaining({
      type: 'agent-status',
      detail: 'PermissionRequest'
    }))
    expect(firstEvents).toContainEqual(expect.objectContaining({
      type: 'agent-status',
      agentSessionId: 'semantic-main',
      state: 'working',
      evidence: expect.objectContaining({ source: 'native-hook' })
    }))
    await first.submitAgentPrompt('semantic-main', 'follow-up prompt')
    expect(firstEvents).toContainEqual(expect.objectContaining({
      type: 'agent-activity',
      agentSessionId: 'semantic-main',
      activity: expect.objectContaining({ kind: 'prompt', content: 'follow-up prompt' }),
      evidence: expect.objectContaining({ source: 'user' })
    }))
    const persistedText = JSON.stringify(await store.load())
    expect(persistedText).not.toContain('hook-agent-ready')
    expect(persistedText).not.toContain('terminalSnapshot')

    const originalRun = first.agentSession('semantic-main').run
    first.disconnect()
    const second = await connect(store)
    const secondEvents: AgentMuxClientEvent[] = []
    second.onEvent((event) => secondEvents.push(event))
    const reattached = await second.reattachAgent('semantic-main')
    expect(reattached.session.run).toEqual(originalRun)
    expect(reattached.attachment.run.incarnationId).toBe(originalRun.incarnationId)
    expect(reattached.attachment.replay.map((event) => event.data).join('')).toContain('hook-agent-ready:initial')
    await second.releaseAgentAttachment('semantic-main')
    expect(second.agentSession('semantic-main').run).toEqual(originalRun)
    await second.submitAgentPrompt('semantic-main', 'after attachment release')
    await waitFor('Run output after releasing the Attachment', async () => (
      (await second.listRuns()).some((run) => (
        run.runId === originalRun.runId &&
        run.latestOutputBytes > reattached.attachment.run.latestOutputBytes
      ))
    ))
    const reopenedAttachment = await second.reattachAgent('semantic-main', 0)
    expect(reopenedAttachment.session.run).toEqual(originalRun)
    expect(reopenedAttachment.attachment.replay.map((event) => event.data).join(''))
      .toContain('hook-agent-input:after attachment release')
    await expect(second.resumeAgent({
      agentSessionId: 'semantic-main',
      runId: 'daemon-duplicate',
      createOperationId: 'create-duplicate',
      commandOverride: process.execPath
    })).rejects.toMatchObject({ code: 'AGENT_SESSION_STILL_RUNNING' })

    await second.signalAgent('semantic-main', 'SIGTERM')
    await waitFor('the original daemon run to exit', () => secondEvents.some((event) => (
      event.type === 'process-state' &&
      event.state === 'exited' &&
      event.run.incarnationId === originalRun.incarnationId
    )))
    const resumed = await second.resumeAgent({
      agentSessionId: 'semantic-main',
      runId: 'daemon-resumed',
      createOperationId: 'create-resumed',
      commandOverride: process.execPath
    })
    expect(resumed.agentSessionId).toBe('semantic-main')
    expect(resumed.run).not.toEqual(originalRun)
    expect(resumed.nativeHandle).toMatchObject({
      kind: 'provider',
      providerId: 'fixture',
      sessionId: 'native-semantic-main'
    })

    const respawned = await second.respawnAgent({
      previousAgentSessionId: 'semantic-main',
      agentSessionId: 'semantic-fresh',
      runId: 'daemon-fresh',
      createOperationId: 'create-fresh',
      prompt: 'fresh-context',
      commandOverride: process.execPath
    })
    expect(respawned.agentSessionId).toBe('semantic-fresh')
    expect(respawned.run).not.toEqual(resumed.run)
    await expect(second.respawnAgent({
      previousAgentSessionId: 'semantic-main',
      agentSessionId: 'semantic-main',
      runId: 'daemon-invalid',
      createOperationId: 'create-invalid'
    })).rejects.toMatchObject({ code: 'AGENT_SESSION_ID_REUSE' })

    await second.stopAgent('semantic-main')
    await second.stopAgent('semantic-fresh')
  })

  it('rolls the daemon run back when semantic persistence fails', async () => {
    const store: AgentMuxAgentSessionStore = {
      async load() { return [] },
      async put() { throw new Error('store unavailable') },
      async delete() {}
    }
    const client = await connect(store)
    await expect(client.createAgent({
      agentSessionId: 'semantic-rollback',
      runId: 'daemon-rollback',
      createOperationId: 'create-rollback',
      agentId: 'fixture',
      workspacePath: process.cwd(),
      prompt: 'rollback',
      commandOverride: process.execPath
    })).rejects.toThrow('store unavailable')
    expect(await client.listRuns()).toEqual([])
    expect(client.agentSessions()).toEqual([])
  })

  it('reserves a semantic identity before asynchronous capability probing', async () => {
    const client = await connect(new AgentMuxMemoryAgentSessionStore())
    const results = await Promise.allSettled([
      client.createAgent({
        agentSessionId: 'semantic-concurrent',
        runId: 'daemon-concurrent-a',
        createOperationId: 'create-concurrent-a',
        agentId: 'fixture',
        workspacePath: process.cwd(),
        commandOverride: process.execPath
      }),
      client.createAgent({
        agentSessionId: 'semantic-concurrent',
        runId: 'daemon-concurrent-b',
        createOperationId: 'create-concurrent-b',
        agentId: 'fixture',
        workspacePath: process.cwd(),
        commandOverride: process.execPath
      })
    ])
    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(await client.listRuns()).toHaveLength(1)
    await client.stopAgent('semantic-concurrent')
  })

  it('isolates a throwing Consumer listener from other listeners and Run control', async () => {
    const client = await connect(new AgentMuxMemoryAgentSessionStore())
    const observed: AgentMuxClientEvent[] = []
    client.onEvent(() => {
      throw new Error('consumer listener failed')
    })
    client.onEvent(async () => {
      throw new Error('async consumer listener failed')
    })
    client.onEvent((event) => observed.push(event))

    const session = await client.createAgent({
      agentSessionId: 'listener-isolation',
      runId: 'listener-isolation-run',
      createOperationId: 'listener-isolation-create',
      agentId: 'fixture',
      workspacePath: process.cwd(),
      commandOverride: process.execPath
    })

    expect(observed).toContainEqual(expect.objectContaining({
      type: 'agent-session',
      session: expect.objectContaining({ agentSessionId: session.agentSessionId })
    }))
    await expect(client.listRuns()).resolves.toHaveLength(1)
    await expect(client.stopAgent(session.agentSessionId)).resolves.toBeUndefined()
  })

  it('bounds Consumer event subscriptions instead of retaining an unlimited listener set', async () => {
    const client = await connect(new AgentMuxMemoryAgentSessionStore())
    for (let index = 0; index < 64; index += 1) client.onEvent(() => {})
    expect(() => client.onEvent(() => {})).toThrow('listener limit')
    await expect(client.listRuns()).resolves.toEqual([])
  })

  it('holds the semantic lifecycle reservation until an ACP binding is persisted', async () => {
    const memory = new AgentMuxMemoryAgentSessionStore()
    let enteredAcpWrite!: () => void
    let releaseAcpWrite!: () => void
    const acpWriteEntered = new Promise<void>((resolve) => { enteredAcpWrite = resolve })
    const acpWriteRelease = new Promise<void>((resolve) => { releaseAcpWrite = resolve })
    const store: AgentMuxAgentSessionStore = {
      async load() { return await memory.load() },
      async put(session) {
        if (session.nativeHandle?.kind === 'acp') {
          enteredAcpWrite()
          await acpWriteRelease
        }
        await memory.put(session)
      },
      async delete(id) { await memory.delete(id) }
    }
    const client = new AgentMuxClient({
      socketPath,
      expectedHostId: 'semantic-host',
      providers: [acpProvider()],
      store
    })
    clients.push(client)
    await client.connect()
    await client.createAgent({
      agentSessionId: 'semantic-acp',
      runId: 'daemon-acp',
      createOperationId: 'create-acp',
      agentId: 'fixture-acp',
      workspacePath: process.cwd(),
      commandOverride: process.execPath
    })

    const binding = client.bindAcp('semantic-acp', acpBinding())
    await acpWriteEntered
    await expect(client.stopAgent('semantic-acp')).rejects.toMatchObject({
      code: 'AGENT_SESSION_BUSY'
    })
    releaseAcpWrite()
    await binding
    expect(client.agentSession('semantic-acp').nativeHandle).toEqual({
      kind: 'acp',
      adapterId: 'fixture-adapter',
      sessionId: 'fixture-acp-session'
    })
    await client.stopAgent('semantic-acp')
  })

  it('projects ACP evidence onto the current Agent Session Run without giving ACP Run ownership', async () => {
    const client = new AgentMuxClient({
      socketPath,
      expectedHostId: 'semantic-host',
      providers: [acpProvider()],
      store: new AgentMuxMemoryAgentSessionStore()
    })
    clients.push(client)
    await client.connect()
    const session = await client.createAgent({
      agentSessionId: 'acp-evidence',
      runId: 'acp-evidence-run',
      createOperationId: 'acp-evidence-create',
      agentId: 'fixture-acp',
      workspacePath: process.cwd(),
      commandOverride: process.execPath
    })
    let emit!: (event: AgentMuxAcpEvent) => void
    const events: AgentMuxClientEvent[] = []
    client.onEvent((event) => events.push(event))
    await client.bindAcp(session.agentSessionId, acpBinding((listener) => { emit = listener }))

    await expect(client.resumeAgent({
      agentSessionId: session.agentSessionId,
      runId: 'acp-resume-run',
      createOperationId: 'acp-resume-create',
      commandOverride: process.execPath
    })).rejects.toMatchObject({ code: 'AGENT_RESUME_UNAVAILABLE' })

    emit({ type: 'status', state: 'working', detail: 'adapter-working' })
    await waitFor('ACP status with Run evidence', () => events.some((event) => (
      event.type === 'agent-status' && event.detail === 'adapter-working'
    )))
    expect(events).toContainEqual(expect.objectContaining({
      type: 'agent-status',
      agentSessionId: session.agentSessionId,
      evidence: expect.objectContaining({
        source: 'acp',
        acpSessionId: 'fixture-acp-session',
        run: session.run
      })
    }))
    await client.stopAgent(session.agentSessionId)
  })

  it('reconstructs an explicit daemon Agent identity for a fresh external client', async () => {
    const first = await connect(new AgentMuxMemoryAgentSessionStore())
    await first.createAgent({
      agentSessionId: 'semantic-external',
      runId: 'daemon-external',
      createOperationId: 'create-external',
      agentId: 'fixture',
      workspacePath: process.cwd(),
      prompt: 'external-client',
      commandOverride: process.execPath
    })
    await waitFor('the first client Hook receipt', () => (
      first.agentSession('semantic-external').nativeHandle?.kind === 'provider'
    ))
    first.disconnect()

    const second = await connect(new AgentMuxMemoryAgentSessionStore())
    const workspaceView = await second.workspaceView()
    expect(workspaceView).toMatchObject({
      hostId: 'semantic-host',
      views: [{
        viewId: 'agent-view:semantic-host:semantic-external',
        kind: 'agent',
        agentSession: {
          agentSessionId: 'semantic-external'
        },
        run: { runId: 'daemon-external', state: 'running' }
      }]
    })
    const reconstructed = workspaceView.views[0]
    expect(reconstructed?.kind).toBe('agent')
    if (!reconstructed || reconstructed.kind !== 'agent') throw new Error('Expected an Agent session')
    expect(reconstructed.agentSession).not.toHaveProperty('nativeHandle')
    await expect(second.reattachAgent('semantic-external', 0)).resolves.toMatchObject({
      session: { agentSessionId: 'semantic-external' },
      attachment: { run: { runId: 'daemon-external' } }
    })
    const events: AgentMuxClientEvent[] = []
    second.onEvent((event) => events.push(event))
    await second.stopAgent('semantic-external')
    expect(events).toContainEqual(expect.objectContaining({
      type: 'run-removed',
      agentSessionId: 'semantic-external',
      evidence: expect.objectContaining({ source: 'user' })
    }))
  })
})
