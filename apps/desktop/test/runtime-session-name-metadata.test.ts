import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AgentMuxError,
  AgentMuxFileAgentSessionStore,
  AgentMuxMemoryAgentSessionStore,
  type AgentMuxAgentSessionStore,
  type AgentMuxRuntimeProjection,
  type AgentMuxStoredAgentSession
} from '@agentmux/core'
import type { DesktopRuntimeClient } from '../src/main/desktop-host.js'
import type { AppConfig, HostConfig } from '../src/shared/contracts.js'
import { RuntimeController } from '../src/main/runtime-controller.js'

// Execution hosts are inert here; all durable parsing and Main snapshot code are real.
vi.mock('../src/main/host-factory.js', () => ({
  createExecutionHost: (host: HostConfig) => ({ id: host.id, kind: host.kind, dispose: async () => {} })
}))
vi.mock('electron', () => ({ app: {}, nativeImage: {} }))

const config: AppConfig = {
  version: 9,
  hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  executors: { review: { label: 'Review', providerId: 'custom-provider', command: 'unused', args: [], env: {}, injectAgentMuxGuide: false } },
  workspaces: [{ id: 'repo', name: 'Saved project', hostId: 'local', path: _hygiene_fixturePath("work/repo"), kind: 'folder' }],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }
}

function storedSession(agentSessionId: string, hostId = 'local'): AgentMuxStoredAgentSession {
  return {
    kind: 'agent', agentSessionId, hostId,
    providerId: 'custom-provider', executorId: 'review', workspacePath: _hygiene_fixturePath("work/repo"),
    run: { runId: `old-${agentSessionId}` }, retiredRuns: [], createdAt: 1, updatedAt: 2,
    hookBindingId: `binding-${agentSessionId}`, hookToken: `secret-${agentSessionId}`,
    nativeHandle: { kind: 'provider', providerId: 'custom-provider', sessionId: `native-${agentSessionId}` }
  }
}

function runtimeClient(unavailable = true) {
  return {
    connect: vi.fn(async () => { if (unavailable) throw new AgentMuxError('Runtime is still starting', 'RUNTIME_UNAVAILABLE') }),
    onEvent: vi.fn(() => () => {}),
    dispose: vi.fn(async () => {}),
    runtimeProjection: vi.fn(async (): Promise<AgentMuxRuntimeProjection> => ({ hostId: 'local', subjects: [] })),
    runtimeIdentity: vi.fn(() => ({ ownership: 'verified' })),
    agentSessions: vi.fn(() => []),
    sessionTimeline: vi.fn(),
    providers: { get: vi.fn(), catalog: vi.fn() },
    startAgent: vi.fn(), resumeAgent: vi.fn(), reopenAgent: vi.fn(), writeAgent: vi.fn(), startTerminal: vi.fn()
  }
}

const controllers: RuntimeController[] = []
const directories: string[] = []
afterEach(async () => {
  await Promise.all(controllers.splice(0).map(controller => controller.dispose()))
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function controllerWith(store: AgentMuxAgentSessionStore, client: ReturnType<typeof runtimeClient>, appConfig = config) {
  const controller = new RuntimeController(store, async () => client as unknown as DesktopRuntimeClient)
  controllers.push(controller)
  controller.commit(await controller.prepare(appConfig))
  return controller
}

describe('Runtime snapshot saved Session names', () => {
  it('reads durable active, stale, and retired names without inventing a Session or starting an Agent', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentmux-session-names-'))
    directories.push(directory)
    const path = join(directory, 'agent-sessions.json')
    const active = storedSession('active')
    const stale = storedSession('stale-binding')
    const retired = storedSession('retired')
    const document = JSON.stringify({
      version: 5, sessions: [active, stale, storedSession('remote', 'ssh-host')], reservations: [],
      retiredRuns: [retired.run, { runId: 'old-without-history' }],
      retiredAgentSessions: [
        { agentSessionId: retired.agentSessionId, hostId: retired.hostId, run: retired.run, source: 'user', observedAt: 4,
          history: { providerId: retired.providerId, executorId: retired.executorId, workspacePath: retired.workspacePath,
            nativeHandle: retired.nativeHandle, createdAt: retired.createdAt } },
        { agentSessionId: 'retired-without-history', hostId: 'local', run: { runId: 'old-without-history' }, source: 'user', observedAt: 5 }
      ]
    }, null, 2)
    await writeFile(path, document, { mode: 0o600 })
    const store = new AgentMuxFileAgentSessionStore(path)
    const load = vi.spyOn(store, 'load')
    const retiredRead = vi.spyOn(store, 'loadRetiredAgentSessions')
    const correlations = vi.spyOn(store, 'loadReopenCorrelations')
    const timeline = vi.spyOn(store, 'loadTimeline')
    const writes = [vi.spyOn(store, 'compareAndSwap'), vi.spyOn(store, 'reserveLifecycle'), vi.spyOn(store, 'commitLifecycle')]
    const client = runtimeClient()
    const controller = await controllerWith(store, client)

    const snapshot = await controller.snapshot(config)
    expect(snapshot.sessionNameMetadata).toEqual([
      { agentSessionId: 'active', hostId: 'local', providerId: 'custom-provider', executorId: 'review', workspacePath: _hygiene_fixturePath("work/repo"), label: 'Review · Saved project', state: 'active' },
      { agentSessionId: 'stale-binding', hostId: 'local', providerId: 'custom-provider', executorId: 'review', workspacePath: _hygiene_fixturePath("work/repo"), label: 'Review · Saved project', state: 'active' },
      { agentSessionId: 'retired', hostId: 'local', providerId: 'custom-provider', executorId: 'review', workspacePath: _hygiene_fixturePath("work/repo"), label: 'Review · Saved project', state: 'retired' }
    ])
    expect(snapshot.sessions).toEqual([])
    expect(snapshot.recoveryCandidates).toEqual([])
    expect(snapshot.timelines).toEqual({})
    expect(snapshot.sessionNameMetadataWarning).toBeUndefined()
    expect(snapshot.runtimeEndpointWarnings).toEqual([expect.objectContaining({ hostId: 'local', code: 'RUNTIME_UNAVAILABLE' })])
    expect(load).toHaveBeenCalledTimes(1)
    expect(retiredRead).toHaveBeenCalledTimes(1)
    expect(correlations).toHaveBeenCalledTimes(1)
    expect(timeline).not.toHaveBeenCalled()
    for (const write of writes) expect(write).not.toHaveBeenCalled()
    for (const operation of [client.startAgent, client.resumeAgent, client.reopenAgent, client.writeAgent, client.startTerminal,
      client.providers.get, client.sessionTimeline, client.runtimeProjection]) expect(operation).not.toHaveBeenCalled()
    expect(await readFile(path, 'utf8')).toBe(document)

    // A later full snapshot sees the original source again; no separate label cache is authoritative.
    await writeFile(path, document.replaceAll(_hygiene_fixturePath("work/repo"), _hygiene_fixturePath("work/renamed")), { mode: 0o600 })
    const refreshed = await controller.snapshot(config)
    expect(refreshed.sessionNameMetadata?.[0]?.label).toBe('Review · renamed')
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('matches exact configured local Host identities and never lends local metadata to SSH', async () => {
    const store = new AgentMuxMemoryAgentSessionStore()
    await store.compareAndSwap(null, storedSession('local-record'))
    await store.compareAndSwap(null, storedSession('other-record', 'another-local'))
    const load = vi.spyOn(store, 'load')
    const multiHostConfig: AppConfig = { ...config, hosts: [...config.hosts, { id: 'ssh-host', kind: 'ssh', label: 'Remote', hostname: 'unused.invalid' }] }
    const controller = await controllerWith(store, runtimeClient(), multiHostConfig)
    expect((await controller.snapshot(multiHostConfig)).sessionNameMetadata?.map(entry => [entry.hostId, entry.agentSessionId]))
      .toEqual([['local', 'local-record']])
    expect(load).toHaveBeenCalledTimes(1)

    load.mockClear()
    const sshOnly: AppConfig = { ...config, hosts: [{ id: 'local', kind: 'ssh', label: 'Same string, remote source', hostname: 'unused.invalid' }] }
    const sshController = await controllerWith(store, runtimeClient(), sshOnly)
    expect((await sshController.snapshot(sshOnly)).sessionNameMetadata).toBeUndefined()
    expect(load).not.toHaveBeenCalled()
  })

  it('keeps healthy Runtime facts and abilities when the independent name read fails', async () => {
    const store = new AgentMuxMemoryAgentSessionStore()
    const read = vi.spyOn(store, 'load').mockRejectedValue(new AgentMuxError('Saved names cannot be read', 'NAME_STORE_READ_FAILED'))
    const client = runtimeClient(false)
    client.runtimeProjection.mockResolvedValue({ hostId: 'local', subjects: [{
      subjectId: 'healthy-terminal', hostId: 'local', kind: 'terminal', workspacePath: _hygiene_fixturePath("work/repo"),
      run: { runId: 'healthy-terminal', kind: 'terminal', providerId: null, executorId: null, agentSessionId: null,
        workspacePath: _hygiene_fixturePath("work/repo"), pid: 123, state: 'running', cols: 80, rows: 24, observedAt: 1, latestOutputBytes: 20, acceptedInputBytes: 3, nativeService: null }
    }] })
    const controller = await controllerWith(store, client)
    const snapshot = await controller.snapshot(config)
    expect(snapshot.sessions).toEqual([expect.objectContaining({ kind: 'terminal', processState: 'running', control: expect.objectContaining({ runId: 'healthy-terminal' }) })])
    expect(snapshot.runtimeEndpointWarnings).toEqual([])
    expect(snapshot.runtimeOwnershipWarnings).toBeUndefined()
    expect(snapshot.sessionNameMetadata).toBeUndefined()
    expect(snapshot.sessionNameMetadataWarning).toEqual({
      code: 'NAME_STORE_READ_FAILED', message: 'Saved Session names could not be read: Saved names cannot be read',
      recovery: expect.stringContaining('Existing Agents remain available')
    })
    read.mockResolvedValue([])
    const refreshed = await controller.snapshot(config)
    expect(refreshed.sessionNameMetadataWarning).toBeUndefined()
    expect(refreshed.sessions).toHaveLength(1)
  })
})
