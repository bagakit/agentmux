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
  AgentMuxMemorySemanticStore,
  type AgentMuxSemanticStore
} from '../src/semantic-store.js'
import type { AgentMuxClientEvent } from '../src/types.js'

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
        acp: false
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
        acp: true
      }
    },
    buildArgs: () => ['-e', 'setInterval(() => {}, 1000)'],
    hook: { rules: [] }
  })
}

function acpBinding(): AgentMuxAcpBinding {
  return {
    adapterId: 'fixture-adapter',
    sessionId: 'fixture-acp-session',
    onEvent: () => () => {},
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

describe('AgentMux semantic client', () => {
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

  async function connect(store: AgentMuxSemanticStore): Promise<AgentMuxClient> {
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
    const store = new AgentMuxMemorySemanticStore()
    const first = await connect(store)
    const firstEvents: AgentMuxClientEvent[] = []
    first.onEvent((event) => firstEvents.push(event))
    const created = await first.createAgent({
      semanticSessionId: 'semantic-main',
      daemonSessionId: 'daemon-main',
      createOperationId: 'create-main',
      agentId: 'fixture',
      workspacePath: process.cwd(),
      prompt: 'initial',
      commandOverride: process.execPath
    })
    await waitFor('the hook-bound native session', () => (
      first.semanticSession(created.semanticSessionId).nativeHandle?.kind === 'provider'
    ))
    await waitFor('terminal output evidence', () => firstEvents.some((event) => (
      event.type === 'terminal-output' && event.data.includes('hook-agent-ready:initial')
    )))
    expect(first.semanticSession('semantic-main')).toMatchObject({
      nativeHandle: { sessionId: 'native-semantic-main' },
      hookReceipt: { eventName: 'SessionStart' }
    })
    expect(firstEvents).not.toContainEqual(expect.objectContaining({
      type: 'semantic-status',
      detail: 'PermissionRequest'
    }))
    expect(firstEvents).toContainEqual(expect.objectContaining({
      type: 'semantic-status',
      semanticSessionId: 'semantic-main',
      state: 'working',
      evidence: expect.objectContaining({ source: 'native-hook' })
    }))
    const persistedText = JSON.stringify(await store.load())
    expect(persistedText).not.toContain('hook-agent-ready')
    expect(persistedText).not.toContain('terminalSnapshot')

    const originalRun = first.semanticSession('semantic-main').daemonSession
    first.disconnect()
    const second = await connect(store)
    const secondEvents: AgentMuxClientEvent[] = []
    second.onEvent((event) => secondEvents.push(event))
    const reattached = await second.reattachAgent('semantic-main')
    expect(reattached.session.daemonSession).toEqual(originalRun)
    expect(reattached.run.session.incarnationId).toBe(originalRun.incarnationId)
    expect(reattached.run.replay.map((event) => event.data).join('')).toContain('hook-agent-ready:initial')
    await expect(second.resumeAgent({
      semanticSessionId: 'semantic-main',
      daemonSessionId: 'daemon-duplicate',
      createOperationId: 'create-duplicate',
      commandOverride: process.execPath
    })).rejects.toMatchObject({ code: 'SEMANTIC_SESSION_STILL_RUNNING' })

    await second.signalAgent('semantic-main', 'SIGTERM')
    await waitFor('the original daemon run to exit', () => secondEvents.some((event) => (
      event.type === 'process-state' &&
      event.state === 'exited' &&
      event.daemonSession.incarnationId === originalRun.incarnationId
    )))
    const resumed = await second.resumeAgent({
      semanticSessionId: 'semantic-main',
      daemonSessionId: 'daemon-resumed',
      createOperationId: 'create-resumed',
      commandOverride: process.execPath
    })
    expect(resumed.semanticSessionId).toBe('semantic-main')
    expect(resumed.daemonSession).not.toEqual(originalRun)
    expect(resumed.nativeHandle).toMatchObject({
      kind: 'provider',
      providerId: 'fixture',
      sessionId: 'native-semantic-main'
    })

    const respawned = await second.respawnAgent({
      previousSemanticSessionId: 'semantic-main',
      semanticSessionId: 'semantic-fresh',
      daemonSessionId: 'daemon-fresh',
      createOperationId: 'create-fresh',
      prompt: 'fresh-context',
      commandOverride: process.execPath
    })
    expect(respawned.semanticSessionId).toBe('semantic-fresh')
    expect(respawned.daemonSession).not.toEqual(resumed.daemonSession)
    await expect(second.respawnAgent({
      previousSemanticSessionId: 'semantic-main',
      semanticSessionId: 'semantic-main',
      daemonSessionId: 'daemon-invalid',
      createOperationId: 'create-invalid'
    })).rejects.toMatchObject({ code: 'SEMANTIC_ID_REUSE' })

    await second.stopAgent('semantic-main')
    await second.stopAgent('semantic-fresh')
  })

  it('rolls the daemon run back when semantic persistence fails', async () => {
    const store: AgentMuxSemanticStore = {
      async load() { return [] },
      async put() { throw new Error('store unavailable') },
      async delete() {}
    }
    const client = await connect(store)
    await expect(client.createAgent({
      semanticSessionId: 'semantic-rollback',
      daemonSessionId: 'daemon-rollback',
      createOperationId: 'create-rollback',
      agentId: 'fixture',
      workspacePath: process.cwd(),
      prompt: 'rollback',
      commandOverride: process.execPath
    })).rejects.toThrow('store unavailable')
    expect(await client.listRuns()).toEqual([])
    expect(client.semanticSessions()).toEqual([])
  })

  it('reserves a semantic identity before asynchronous capability probing', async () => {
    const client = await connect(new AgentMuxMemorySemanticStore())
    const results = await Promise.allSettled([
      client.createAgent({
        semanticSessionId: 'semantic-concurrent',
        daemonSessionId: 'daemon-concurrent-a',
        createOperationId: 'create-concurrent-a',
        agentId: 'fixture',
        workspacePath: process.cwd(),
        commandOverride: process.execPath
      }),
      client.createAgent({
        semanticSessionId: 'semantic-concurrent',
        daemonSessionId: 'daemon-concurrent-b',
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

  it('holds the semantic lifecycle reservation until an ACP binding is persisted', async () => {
    const memory = new AgentMuxMemorySemanticStore()
    let enteredAcpWrite!: () => void
    let releaseAcpWrite!: () => void
    const acpWriteEntered = new Promise<void>((resolve) => { enteredAcpWrite = resolve })
    const acpWriteRelease = new Promise<void>((resolve) => { releaseAcpWrite = resolve })
    const store: AgentMuxSemanticStore = {
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
      semanticSessionId: 'semantic-acp',
      daemonSessionId: 'daemon-acp',
      createOperationId: 'create-acp',
      agentId: 'fixture-acp',
      workspacePath: process.cwd(),
      commandOverride: process.execPath
    })

    const binding = client.bindAcp('semantic-acp', acpBinding())
    await acpWriteEntered
    await expect(client.stopAgent('semantic-acp')).rejects.toMatchObject({
      code: 'SEMANTIC_SESSION_BUSY'
    })
    releaseAcpWrite()
    await binding
    expect(client.semanticSession('semantic-acp').nativeHandle).toEqual({
      kind: 'acp',
      adapterId: 'fixture-adapter',
      sessionId: 'fixture-acp-session'
    })
    await client.stopAgent('semantic-acp')
  })
})
